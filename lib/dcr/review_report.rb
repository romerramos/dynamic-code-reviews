# frozen_string_literal: true

require 'json'
require_relative 'agents'
require_relative 'page'
require_relative 'state'

module DCR
  # What a finished review says on its pull request: counts and outcomes only, read from the saved
  # review and its state, with no browser. Nothing anyone wrote in a conversation is in it: a
  # question asked to understand the code shows up as one more conversation, never as its text.
  module ReviewReport
    module_function

    HOME = 'https://github.com/romerramos/dynamic-code-reviews'
    JEVMYPR = 'https://github.com/romerramos/jevmypr'
    MARK = '<!-- dynamic-code-reviews:report -->' # finds the comment again, to update it in place
    QUIET = %w[praise note].freeze                 # comments that ask nothing of anyone
    AGAINST = %w[disagree partly].freeze

    # The latest revision's key, snapshot and review, and the state saved for it.
    def latest(series_dir)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      revision = manifest.fetch('revisions').max_by { |entry| entry['number'] }
      key = State.review_key(revision['fingerprint'], manifest.fetch('name'), revision['number'])
      page = File.join(series_dir, 'revisions', format('%03d.html', revision['number']))
      payload = Page.payload(File.read(page, encoding: 'UTF-8'))
      [key, payload['snapshot'], payload['review'], State.new(series_dir).read]
    end

    # {files, verdict, agents, comments, conversations, revisions, left, open}: left, the files that still need
    # the reader; open, the comments nobody settled yet. Both are empty when the review is done.
    def facts(snapshot, review, state, key)
      progress = state.dig('blobs', key) || {}
      threads = state.dig('threads', key) || {}
      viewed = Array(progress['viewedFiles'])
      resolved = Array(progress['resolvedComments'])
      verdict = state.dig('verdicts', key.split(':')[1].to_s)
      verdict = nil unless verdict&.dig('status') == 'ready'

      paths = Array(snapshot['files']).map { |file| file['path'] }
      yours = verdict ? paths.select { |path| verdict.dig('files', path) == 'human' } : paths
      comments = all_comments(review, state, key, progress)
      # Counted are the agents' comments; a teammate's from GitHub must be settled too, but is not the review's.
      reviews = comments.reject { |comment| comment['mine'] || comment['author'] }
      actionable = reviews.reject { |comment| QUIET.include?(comment['label']) }
      # Open is what the Overview's All clear waits on: the review's own comments on the code as it is.
      # The reader's questions to the agent are not something to resolve.
      waiting = comments.reject { |comment| comment['mine'] || comment['outdated'] || resolved.include?(comment['id']) || threads.dig(comment['id'], 'closed') }
      settled = actionable - waiting
      fixed = settled.count { |comment| fixed?(threads[comment['id']]) }
      agents = (comments.map { |comment| comment['agent'] } + threads.values.flat_map { |thread| voices(thread) }).compact.uniq
      {
        'head' => snapshot['head'],
        'files' => {'total' => paths.length, 'yours' => yours.length, 'read' => (yours & viewed).length, 'viewed' => (paths & viewed).length},
        'verdict' => verdict && verdict['verdict'],
        'agents' => agents.map { |slug| Agents.name(slug) },
        # quiet: notes and praise, by label. They ask nothing, but an adversary can still challenge one.
        'comments' => {'total' => actionable.length, 'fixed' => fixed, 'kept' => settled.length - fixed, 'open' => (actionable & waiting).length,
                       'quiet' => (reviews - actionable).map { |comment| comment['label'] }.tally,
                       'challenged' => reviews.count { |comment| challenged?(threads[comment['id']]) }},
        'conversations' => comments.count { |comment| talked?(threads[comment['id']], mine: comment['mine']) },
        'revisions' => key.split(':').last.to_i,
        'left' => yours - viewed,
        'open' => waiting.map { |comment| comment['id'] }
      }
    end

    # The comment on the pull request: a handful of lines, each there only when it happened.
    # login: who published it, the person who read the files.
    def markdown(facts, login: nil)
      files, comments = facts['files'], facts['comments']
      who = login ? " by @#{login}" : ''
      read = if facts['verdict']
               jev = "[JevMyPR](#{JEVMYPR})"
               files['yours'].zero? ? "#{jev}: none needed a person" : "#{jev}: #{count(files['yours'], 'needed a person', 'needed a person')}, #{files['read'] == files['yours'] ? (files['yours'] == 1 ? 'read' : 'all read') : "#{files['read']} read"}#{who}"
             else
               "#{files['read'] == files['total'] ? (files['total'] == 1 ? 'read' : 'all read') : "#{files['read']} read"}#{who}"
             end
      agents = facts['agents']
      revisions = facts['revisions'].to_i > 1 ? " · #{count(facts['revisions'], 'revision')}" : ''
      lines = ["- **#{count(files['total'], 'file')}**#{revisions} · #{read}"]
      quiet = comments['quiet'] || {}
      if agents.any? || comments['total'].positive? || quiet.any?
        notes = quiet.map { |label, number| label == 'note' ? count(number, 'note') : "#{number} #{label}" }
        said = [agents.any? ? "**#{count(agents.length, 'agent')}** (#{agents.join(', ')})" : nil,
                comments['total'].positive? || notes.empty? ? count(comments['total'], 'comment') : nil, *notes,
                comments['challenged'].positive? ? "#{comments['challenged']} challenged by an adversary" : nil].compact
        lines << "- #{said.join(' · ')}"
      end
      lines << "- **#{comments['fixed']} fixed** · #{comments['kept']} resolved as they were · #{comments['open']} open" if comments['total'].positive?
      lines << "- **#{count(facts['conversations'], 'conversation')}** with a person in the loop" if facts['conversations'].positive?
      head = facts['head'].to_s[0, 7]
      "#{MARK}\n✅ **Reviewed with [Dynamic Code Reviews](#{HOME})**#{head.empty? ? '' : " at `#{head}`"}\n\n#{lines.join("\n")}\n"
    end

    # The commit status's line under the pull request's checks: at most 140 characters.
    def description(facts)
      parts = ["#{count(facts['files']['total'], 'file')} reviewed"]
      parts << "#{count(facts['comments']['total'], 'comment')} settled" if facts['comments']['total'].positive?
      parts << count(facts['agents'].length, 'agent') if facts['agents'].length > 1
      parts.join(' · ')[0, 140]
    end

    def count(number, one, many = "#{one}s") = "#{number} #{number == 1 ? one : many}"

    # The agent's comments (in the saved review and posted since) and the reader's own sent to it.
    def all_comments(review, state, key, progress)
      posted = Array(state.dig('comments', key))
      agents = (Array(review['comments']) + posted).uniq { |comment| comment['id'] }
      threads = state.dig('threads', key) || {}
      mine = Array(progress['personalComments']).select { |comment| comment['audience'] != 'pr' && threads[comment['id']] }
      agents + mine.map { |comment| comment.merge('mine' => true) }
    end

    def fixed?(thread) = thread&.dig('fix', 'state') == 'done' || thread&.dig('outcome', 'verdict') == 'addressed'

    # An adversary disagreed with the comment, wholly or in part.
    def challenged?(thread)
      return false unless thread
      Array(thread['messages']).any? { |message| message['role'] == 'adversary' && AGAINST.include?(message['verdict']) } ||
        (thread['opinions'] || {}).values.any? { |opinion| AGAINST.include?(opinion['verdict']) }
    end

    # A person wrote in it and an agent answered. mine: the reader's own comment, which is what they
    # wrote, so an answer to it is enough.
    def talked?(thread, mine: false)
      messages = Array(thread&.dig('messages'))
      (mine || messages.any? { |message| message['author'] == 'user' }) &&
        (messages.any? { |message| message['author'] == 'agent' } || (thread['opinions'] || {}).values.any? { |opinion| opinion['body'] })
    end

    def voices(thread)
      Array(thread['messages']).filter_map { |message| message['agent'] if message['author'] == 'agent' } +
        (thread['opinions'] || {}).select { |_, opinion| opinion['body'] }.keys
    end
  end
end
