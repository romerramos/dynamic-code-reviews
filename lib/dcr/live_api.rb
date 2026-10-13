# frozen_string_literal: true

require 'json'
require 'uri'
require_relative 'agent_catalog'
require_relative 'github'
require_relative 'jevmypr'
require_relative 'page'
require_relative 'progress_archive'
require_relative 'second_opinion'
require_relative 'settings'
require_relative 'state'

module DCR
  # The JSON routes the served review uses. The HTTP server owns sockets, Host/Origin
  # and token checks; this class only maps a request to a state change and a response.
  class LiveAPI
    POLL_SECONDS = 10 # below the server's per-connection timeout
    BODY_LIMIT = 4 * 1024 * 1024

    # evidence: callable taking the request hash, for attaching a recording to the series.
    # catalog: callable(fresh) listing the agent CLIs here. ask_adversaries: callable(key, id, text)
    # that has the reviewer's adversaries answer a question in the background. jevmypr: the client
    # for the outside verdict, asked only for a repository whose reviewer turned it on.
    def initialize(directory, settings: Settings.new, evidence: nil, github: GitHub.new(directory), catalog: nil, ask_adversaries: nil, jevmypr: JevMyPR.new)
      @jevmypr = jevmypr
      @state = State.new(directory)
      @settings = settings
      @evidence = evidence
      @github = github
      @catalog = catalog || ->(fresh) { AgentCatalog.list(fresh: fresh) }
      @ask_adversaries = ask_adversaries || method(:question_in_background)
    end

    attr_reader :state

    # Saved browser progress and display settings by storage key, for the served page to seed
    # before the review script runs, so the server's copy wins over a stale browser one.
    def progress
      carry_forward
      blobs = @state.read['blobs'].dup
      saved = @settings.read
      blobs[Settings::KEY] = saved unless saved.empty?
      blobs
    end

    # Returns [status, body_hash]. body is a callable returning the raw request body.
    def call(method, path, body)
      uri = URI(path)
      query = URI.decode_www_form(uri.query.to_s).to_h
      key = query['key']
      case [method, uri.path]
      when ['GET', '/api/state'] then [200, snapshot(key)]
      when ['GET', '/api/poll'] then [200, poll(key, Integer(query.fetch('since', '-1')))]
      when ['POST', '/api/state']
        input = json(body)
        @state.save_blob(input['key'], input['blob'])
        archive&.save(input['key'], input['blob'])
        [200, {'ok' => true}]
      when ['GET', '/api/settings'] then [200, @settings.read]
      when ['POST', '/api/settings'] then [200, @settings.write(json(body))]
      when ['POST', '/api/evidence']
        raise ArgumentError, 'Attaching recordings is not available here' unless @evidence
        [200, @evidence.call(json(body))]
      when ['GET', '/api/preview'] then [200, preview_html(key, query['path'])]
      when ['POST', '/api/preview'] then (input = json(body); [200, {'entry' => @state.request_preview(input['key'], input['path'])}])
      when ['POST', '/api/send'] then send_items(json(body))
      when ['POST', '/api/message'] then message(json(body))
      when ['GET', '/api/screenshot'] then [200, screenshot(key, query['id'])]
      when ['GET', '/api/sync'] then [200, stale]
      when ['POST', '/api/sync'] then [200, sync]
      when ['POST', '/api/risk-ranking'] then (@state.request_risk_ranking(json(body)['key']); [200, {'requested' => true}])
      when ['GET', '/api/adversaries'] then [200, adversaries]
      when ['GET', '/api/agents'] then [200, adversaries.merge('agents' => @catalog.call(query['fresh'] == '1'))]
      when ['POST', '/api/agents'] then (@settings.save_adversaries(json(body)['adversaries']); [200, adversaries])
      when ['POST', '/api/verdict'] then [200, verdict(json(body))]
      when ['POST', '/api/finish'] then [200, {'entry' => @state.finish(json(body)['key'])}]
      when ['GET', '/api/github'] then [200, @github.status(key)]
      when ['POST', '/api/github/comment'] then github_comment(json(body))
      when ['POST', '/api/github/pending'] then (input = json(body); [200, @state.github_pending(input['key'], input['id'], input['pending'] == true)])
      when ['POST', '/api/github/review'] then github_review(json(body))
      else [404, {'error' => 'Not found'}]
      end
    rescue ArgumentError, KeyError, JSON::ParserError, TypeError => error
      [400, {'error' => error.message}]
    rescue GitHub::Error => error
      [502, {'error' => error.message}]
    end

    private

    # The reviewer's adversaries, and the agent running this review, which checks itself only on a model they named.
    # decided: false until the reviewer has chosen them or chosen none; the page introduces them until then.
    def adversaries = {'adversaries' => @settings.adversaries, 'author' => @state.listener, 'decided' => @settings.adversaries_decided?}

    # With adversaries ticked, they answer what the review's agent was sent, beside it.
    def send_items(input)
      queued = @state.send_items(input['key'], input['items'])
      input['items'].each { |item| @ask_adversaries.call(input['key'], item['id'].to_s, item['text'].to_s) } if input['adversaries'] == true
      [200, {'queued' => queued.length}]
    end

    def message(input)
      message = @state.user_message(input['key'], input['id'], input['body'])
      @ask_adversaries.call(input['key'], input['id'].to_s, SecondOpinion.follow_up(@state.read, input['key'], input['id'].to_s)) if input['adversaries'] == true
      [200, {'message' => message}]
    end

    ASKING_SECONDS = 180 # a request still out after this was lost (the server stopped mid-call)
    RETRY_SECONDS = 120  # JevMyPR takes one call every two minutes

    # The page's one call about JevMyPR: {key}, with enabled: true/false when the reviewer answers
    # the offer, and again: true for Try again. Only when the reviewer turned it on for this
    # repository is a diff with no verdict yet sent, once, in the background; the answer reaches
    # every open page through the poll. Returns where it stands.
    def verdict(input)
      key = input['key']
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      fingerprint = key.split(':')[1].to_s
      repo = manifest['repo'] || Dir.pwd
      @settings.save_jevmypr(repo, input['enabled']) if input.key?('enabled')
      enabled = @settings.jevmypr(repo)
      saved = @state.read['verdicts'][fingerprint]
      saved = ask_jevmypr(key, fingerprint) if enabled == true && due?(saved, input['again'] == true)
      {'enabled' => enabled, 'host' => @jevmypr.host, 'verdict' => saved}
    end

    def ask_jevmypr(key, fingerprint)
      files = revision_files(key)
      return @state.save_verdict(fingerprint, {'status' => 'error', 'code' => 'no_diff', 'message' => 'This revision has no saved diff to send.', 'at' => Time.now.utc.iso8601}) if files.empty?
      request = JevMyPR.request(files, title: revision(key)&.fetch('title', nil))
      asking = @state.save_verdict(fingerprint, {'status' => 'asking', 'at' => Time.now.utc.iso8601})
      Thread.new do
        @state.save_verdict(fingerprint, @jevmypr.ask(request))
      rescue StandardError => error
        @state.save_verdict(fingerprint, {'status' => 'error', 'code' => 'failed', 'message' => "The verdict could not be asked for: #{error.message[0, 200]}", 'at' => Time.now.utc.iso8601})
      end
      asking
    end

    # Ask when there is nothing yet, when a request was lost, or when an error may be tried again:
    # at once if the reviewer asks and JevMyPR named no later time, else after its wait.
    def due?(saved, again)
      return true unless saved
      age = Time.now - Time.parse(saved['at'].to_s)
      return age > ASKING_SECONDS if saved['status'] == 'asking'
      return false unless saved['status'] == 'error'
      saved['retry_at'] ? Time.now >= Time.parse(saved['retry_at']) : again || age > RETRY_SECONDS
    rescue ArgumentError
      true
    end

    def revision(key) = Array(manifest['revisions']).find { |entry| entry['number'].to_s == key.split(':').last }

    # The changed files of the revision the key names, from the snapshot its page embeds.
    def revision_files(key)
      page = File.join(File.dirname(@state.path), 'revisions', format('%03d.html', Integer(key.split(':').last, 10)))
      File.file?(page) ? Array(Page.payload(File.read(page)).dig('snapshot', 'files')) : []
    rescue StandardError
      []
    end

    def question_in_background(key, id, text)
      Thread.new do
        SecondOpinion.question(state: @state, key: key, id: id, text: text, author: @state.listener, repo: manifest['repo'] || Dir.pwd)
      rescue StandardError => error
        warn "Adversaries could not be asked about #{id}: #{error.message}"
      end
    end

    # Posting the same comment twice (a double click, a second device) returns the first post.
    def github_comment(input)
      key, item = input['key'], input['item']
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      raise ArgumentError, 'Expected a comment' unless item.is_a?(Hash)
      done = @state.read.dig('github', key, 'posted', item['id'].to_s)
      return [200, {'posted' => {item['id'] => done}}] if done
      entry = @state.github_posted(key, {item['id'] => @github.comment(key, item)})
      [200, {'posted' => {item['id'] => entry['posted'][item['id']]}}]
    end

    def github_review(input)
      key = input['key']
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      posted = @state.read.dig('github', key, 'posted') || {}
      items = Array(input['items']).reject { |item| item.is_a?(Hash) && posted.key?(item['id'].to_s) }
      result = @github.review(key, input['event'].to_s, input['body'], items)
      entry = @state.github_posted(key, result['comments'], review: {'url' => result['url'], 'event' => result['event']})
      [200, {'posted' => entry['posted'].slice(*result['comments'].keys), 'review' => result['url']}]
    end

    # Whether the code moved on since the review's latest revision. A series that cannot be
    # updated from the page (a pull request's, another branch) says why instead.
    def stale
      require_relative '../../scripts/series'
      ReviewSeries.stale(repo: manifest.fetch('repo'), name: manifest.fetch('name'))
    rescue ArgumentError, KeyError => error
      {'unavailable' => error.message}
    end

    # The reader's Update: the next revision shows the code as it is, and the listening agent is
    # handed what changed so it can comment on it.
    def sync
      require_relative '../../scripts/series'
      result = ReviewSeries.sync(repo: manifest.fetch('repo'), name: manifest.fetch('name'))
      @state.code_updated(result['key'], ReviewSeries.sync_brief(result)) if result['status'] == 'updated' && result['unreviewed'].any?
      result.slice('status', 'revision', 'summary')
    end

    def manifest
      path = File.join(File.dirname(@state.path), 'manifest.json')
      File.file?(path) ? JSON.parse(File.read(path)) : {}
    rescue JSON::ParserError
      {}
    end

    # Progress the served page starts from, for every revision that has none yet: a same-code
    # revision takes its predecessor's; then what the archive kept (the series folder may have
    # been made again); then a revision of changed code keeps the viewed files whose diff is the same.
    def carry_forward
      data = manifest
      return unless data['name'] && data['revisions']
      @state.carry_forward(data['name'], data['revisions'])
      revisions = data['revisions'].sort_by { |revision| revision['number'] }
      key = ->(revision) { State.review_key(revision['fingerprint'], data['name'], revision['number']) }
      blobs = @state.read['blobs']
      revisions.each { |revision| @state.seed_blob(key.call(revision), archive.find(key.call(revision))) unless blobs[key.call(revision)] } if archive
      revisions.each_cons(2) do |old, new|
        blobs = @state.read['blobs']
        next if blobs[key.call(new)] || old['fingerprint'] == new['fingerprint'] || Array(blobs.dig(key.call(old), 'viewedFiles')).empty?
        kept = unchanged_files(old['number'], new['number']) & blobs.dig(key.call(old), 'viewedFiles')
        @state.seed_blob(key.call(new), {'viewedFiles' => kept}) # even none: checked once, not on every load
      end
    end

    # Paths whose diff is the same in both revisions, from the snapshots their pages embed.
    def unchanged_files(old_number, new_number)
      diffs = [old_number, new_number].map do |number|
        page = File.join(File.dirname(@state.path), 'revisions', format('%03d.html', number))
        return [] unless File.file?(page)
        Array(Page.payload(File.read(page)).dig('snapshot', 'files')).to_h { |file| [file['path'], Array(file['hunks']).map { |hunk| hunk['patch'] }] }
      end
      diffs[0].select { |path, patches| diffs[1][path] == patches }.keys
    rescue StandardError
      []
    end

    # The reviewer's progress for this series, kept outside the worktree too.
    def archive
      return @archive if defined?(@archive)
      data = manifest
      @archive = data['repo'] && data['name'] ? ProgressArchive.new(data['repo'], data['name']) : nil
    end

    # Statuses only: the markup of a ready preview is fetched once, on its own.
    def preview_status(previews)
      (previews || {}).transform_values { |preview| preview.reject { |name, _| name == 'html' } }
    end

    def preview_html(key, path)
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      preview = @state.read.dig('previews', key, path.to_s)
      raise ArgumentError, 'No ready preview for that template' unless preview && preview['status'] == 'ready'
      {'html' => preview['html'], 'ready_at' => preview['ready_at']}
    end

    # A posted screenshot's image, fetched once on its own like a preview's markup.
    def screenshot(key, id)
      require_relative '../../scripts/screenshots'
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      record = Array(@state.read.dig('screenshots', key)).find { |shot| shot['id'] == id.to_s }
      uri = record && ReviewScreenshots.data_uri(File.dirname(@state.path), record)
      raise ArgumentError, 'No such screenshot' unless uri
      {'data_uri' => uri}
    end

    def json(body)
      value = JSON.parse(body.call)
      raise ArgumentError, 'Expected a JSON object' unless value.is_a?(Hash)
      value
    end

    def snapshot(key)
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(State::KEY)
      state = @state.read
      {'rev' => state['rev'], 'threads' => state['threads'][key] || {}, 'github' => state['github'][key] || {}, 'comments' => state['comments'][key] || [], 'screenshots' => Array(state['screenshots'][key]).map { |shot| shot.except('file') }, 'risk_ranking' => state['risk_rankings'][key], 'verdict' => state['verdicts'][key.split(':')[1].to_s],'previews' => preview_status(state['previews'][key]), 'latest_revision' => latest_revision, 'listening' => @state.listening?, 'agent' => @state.listener, 'agent_model' => @state.listener_model,
       'pending' => state['outbox'].count { |entry| entry['seq'] > state['acked'] && entry['key'] == key }}
    end

    # The newest saved revision number, so an open page can offer it after the agent publishes one.
    def latest_revision = manifest['revisions']&.map { |revision| revision['number'] }&.max

    # Long poll: answers as soon as anything changes, or with the unchanged state after a
    # window so a hidden tab's throttled timers do not matter.
    def poll(key, since)
      deadline = Time.now + POLL_SECONDS
      last_latest = latest_revision
      last_listening = [@state.listening?, @state.listener, @state.listener_model]
      loop do
        current = snapshot(key)
        return current if current['rev'] != since || current['latest_revision'] != last_latest || current.values_at('listening', 'agent', 'agent_model') != last_listening || Time.now >= deadline
        sleep 0.4
      end
    end
  end
end
