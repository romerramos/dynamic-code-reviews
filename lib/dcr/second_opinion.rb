# frozen_string_literal: true

require_relative 'agent_catalog'
require_relative 'agents'
require_relative 'settings'
require_relative 'state'

module DCR
  # The reviewer's adversaries (Settings#adversaries) at work. On a comment the review's agent posted,
  # the first checks it and answers in the comment's conversation, the others give a short opinion
  # beside it; each gets the same compact question: what the change is for, the code, the comment.
  # On a question the reviewer asks with adversaries ticked, every one answers it beside the
  # review's agent.
  module SecondOpinion
    module_function

    CONTEXT_LINES = 4 # unchanged lines shown around the commented range
    VERDICT = /\A\W*(agree|partly agree|partially agree|mostly agree|disagree)\b\W*/i

    def prompt(asked:, author:, context:, code:, comment:, adversary:)
      role = adversary ? 'You are the second reviewer. Check whether this comment is right, and say what it gets wrong or misses. Be fair: agree when it is right.' : 'Give a quick second opinion on this comment.'
      <<~TEXT
        #{role}

        #{Agents.name(author)} left this comment while reviewing a code change. You are #{Agents.name(asked)}.

        How to answer:
        - Start with one word on its own line: Agree, Partly agree or Disagree.
        - Then 2 to 4 short sentences in plain, simple words. No jargon you do not need, no long words.
        - Talk about this code only. Name the file and line when it helps.
        - If you would change the comment, say how in one sentence.
        - You may read files in this repository to check. Do not change anything.

        What the change is about:
        #{context.to_s.strip.empty? ? '(not given)' : context.strip}

        The code (#{code[:where]}):
        ```#{code[:language]}
        #{code[:lines]}
        ```

        #{Agents.name(author)}'s comment (#{comment['label']}, #{comment['decoration']}):
        #{comment['subject']}
        #{comment['discussion'].to_s.strip}
      TEXT
    end

    # The commented lines with a few around them, numbered on the comment's side.
    def code(snapshot, comment)
      file = snapshot.fetch('files').find { |entry| entry['hunks'].any? { |hunk| hunk['id'] == comment['hunk'] } }
      raise ArgumentError, "No captured code for comment #{comment['id']}" unless file
      hunk = file['hunks'].find { |entry| entry['id'] == comment['hunk'] }
      side = comment['side']
      first, last = comment.values_at('start', 'end')
      rows = (hunk['rows'] || DynamicReviews.diff_rows(hunk))['unified'].select { |row| row[side] }
      shown = rows.select { |row| row[side].between?(first - CONTEXT_LINES, last + CONTEXT_LINES) }
      width = shown.map { |row| row[side].to_s.length }.max.to_i
      marks = {'add' => '+', 'del' => '-', 'context' => ' '}
      lines = shown.map { |row| "#{row[side].to_s.rjust(width)} #{marks[row['kind']]}#{row[side].between?(first, last) ? '>' : ' '} #{row['text']}" }.join("\n")
      range = first == last ? "line #{first}" : "lines #{first}-#{last}"
      {where: "#{file['path']}, #{side == 'new' ? 'after' : 'before'} the change, #{range}; > marks the commented lines", language: language(file['path']), lines: lines}
    end

    def language(path) = {'.rb' => 'ruby', '.erb' => 'erb', '.js' => 'javascript', '.ts' => 'typescript', '.py' => 'python', '.go' => 'go', '.css' => 'css', '.sql' => 'sql', '.yml' => 'yaml', '.yaml' => 'yaml'}.fetch(File.extname(path.to_s), '')

    # A verdict that ends a sentence of narration ("I'll check the cache.Agree") or stands on its own line.
    LATE_VERDICT = /(?:[.!?:]|\n)[ \t*_]*(agree|partly agree|partially agree|mostly agree|disagree)[.!*_]*[ \t]*(?:\n|\z)/i

    # [verdict, body without the verdict line]. verdict is agree, partly or disagree, or nil.
    # Anything an agent narrated before its verdict ("I'll check how...") is dropped with it.
    def verdict(answer)
      text = tidy(answer)
      match = text.match(VERDICT) || text.match(LATE_VERDICT) or return [nil, text]
      word = match[1].downcase
      rest = text[match.end(0)..].to_s.strip
      [word == 'disagree' ? 'disagree' : (word == 'agree' ? 'agree' : 'partly'), rest.empty? ? text : rest]
    end

    # Local links (a file on this computer) read as code; the page links only to the web.
    def tidy(answer) = answer.to_s.gsub(/\[([^\]\n]+)\]\((?!https?:)[^)\s]+\)/) { "`#{Regexp.last_match(1).delete('`')}`" }.strip

    # Asks the panel about each comment and posts every answer as it arrives. Returns what happened,
    # per comment and agent, for the terminal.
    def run(series_dir:, comment_ids:, author:, context: nil, repo: nil, ask: Agents.method(:ask), adversaries: Settings.new.adversaries)
      require_relative '../../scripts/series'
      panel = Agents.panel(author, adversaries)
      return {} if panel.empty?
      history = ReviewSeries.manifest(series_dir)
      payload = ReviewSeries.latest(series_dir, history)
      entry = history['revisions'].last
      key = State.review_key(entry['fingerprint'], history['name'], entry['number'])
      state = State.new(series_dir)
      posted = (state.read.dig('comments', key) || []) + Array(payload.dig('review', 'comments'))
      context ||= [payload.dig('review', 'title'), payload.dig('review', 'summary')].compact.join('. ')[0, 600]
      repo ||= history['repo']
      comment_ids.to_h do |id|
        comment = posted.find { |candidate| candidate['id'] == id } or raise ArgumentError, "No comment #{id} in this review"
        excerpt = code(payload['snapshot'], comment)
        state.await_opinions(key, id, panel.first['agent'], panel.drop(1).map { |adversary| adversary['agent'] })
        results = consult(state, key, id, panel, repo, ask) do |agent, adversarial|
          prompt(asked: agent, author: author, context: context, code: excerpt, comment: comment, adversary: adversarial)
        end
        [id, results]
      end
    end

    # A question the reviewer asked with adversaries ticked: each answers it on its own, beside the
    # review's agent (author), which answers in the conversation as usual. text: what the review's
    # agent was sent, so they know as much as it does.
    def question(state:, key:, id:, text:, author:, repo:, ask: Agents.method(:ask), adversaries: Settings.new.adversaries)
      panel = Agents.panel(author, adversaries)
      return {} if panel.empty?
      state.await_opinions(key, id, nil, panel.map { |adversary| adversary['agent'] })
      consult(state, key, id, panel, repo, ask, on_comment: false) { |agent, _| question_prompt(asked: agent, author: author, text: text) }
    end

    def question_prompt(asked:, author:, text:)
      <<~TEXT
        You are #{Agents.name(asked)}. A reviewer is going through a code change with #{author ? Agents.name(author) : 'their agent'}, the agent running the review, and asked what follows. Give your own, independent answer; the reviewer reads it beside theirs.

        How to answer:
        - The answer first, in a sentence or two. Then only what supports it.
        - Plain, simple words. Short paragraphs or a short list; Markdown is fine.
        - Name the file and line when it helps.
        - You may read files in this repository to check. Do not change anything.

        ---

        #{text.to_s.strip}
      TEXT
    end

    # What adversaries need to answer a follow-up: what the review's agent was first sent about the
    # thread, the conversation since, and the new message (already the thread's last).
    def follow_up(state_data, key, id)
      first = state_data['outbox'].find { |entry| entry['kind'] == 'send' && entry['key'] == key && entry['thread_ids'] == [id] && !entry['text'].start_with?('Follow-up in thread') }
      *earlier, latest = state_data.dig('threads', key, id, 'messages') || []
      said = earlier.reject { |message| message['role'] }.map { |message| "#{message['author'] == 'user' ? 'Reviewer' : Agents.name(message['agent'] || 'agent')}: #{message['body']}" }
      [first&.fetch('text'), said.empty? ? nil : "The conversation so far:\n\n#{said.join("\n\n")}", "The reviewer now asks:\n\n#{latest&.fetch('body')}"].compact.join("\n\n")
    end

    # Asks every adversary at once and posts each answer as it arrives. On a comment the first
    # answers in the conversation and each says what it thinks of the comment; on a question
    # (on_comment false) they all answer beside it. Returns {agent => verdict or what failed}.
    def consult(state, key, id, panel, repo, ask, on_comment: true)
      panel.each_with_index.map do |adversary, index|
        agent, model, effort = adversary.values_at('agent', 'model', 'effort')
        adversarial = on_comment && index.zero?
        Thread.new do
          answer = ask.call(agent, yield(agent, adversarial), dir: repo, model: model, effort: effort)
          word, body = on_comment ? verdict(answer) : [nil, tidy(answer)]
          state.add_opinion(key, id, agent, body, verdict: word, adversary: adversarial, model: model, effort: effort)
          AgentCatalog::Results.record(agent)
          [agent, word || 'answered']
        rescue ArgumentError, SystemCallError => error
          state.opinion_failed(key, id, agent, error.message, adversary: adversarial)
          AgentCatalog::Results.record(agent, error.message)
          [agent, "failed: #{error.message}"]
        end
      end.map(&:value).to_h
    end
  end
end
