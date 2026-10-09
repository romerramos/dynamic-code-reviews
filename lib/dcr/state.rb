# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'securerandom'
require 'time'
require_relative 'agents'
require_relative 'previews'

module DCR
  # Review state shared by the live server and the terminal commands: the browser's
  # saved progress per snapshot, conversation threads and the queue of messages waiting
  # for the agent. One JSON file next to the saved report, changed only under a file lock,
  # so `dcr reply` works even when the server is stopped.
  class State
    FILE = 'state.json'
    MAX_BYTES = 8 * 1024 * 1024
    ID = /\A[A-Za-z0-9_.:-]{1,120}\z/
    KEY = /\A[A-Za-z0-9_.:-]{1,300}\z/
    AUTHORS = %w[user agent].freeze

    def self.empty = {'version' => 1, 'rev' => 0, 'blobs' => {}, 'threads' => {}, 'previews' => {}, 'comments' => {}, 'github' => {}, 'outbox' => [], 'acked' => 0, 'seq' => 0}

    # The key the page saves a revision's progress under (see LiveTools.progressKey).
    def self.review_key(fingerprint, series, number) = "dynamic-review:#{fingerprint}:#{series}:#{number}"

    attr_reader :path

    def initialize(directory)
      @directory = File.expand_path(directory)
      raise ArgumentError, 'The review directory must not be a symlink' if File.symlink?(@directory)
      @path = File.join(@directory, FILE)
    end

    def read
      return self.class.empty unless File.file?(@path)
      self.class.empty.merge(JSON.parse(File.read(@path)))
    end

    # Cheap change detector for pollers, independent of the lock.
    def stamp = File.file?(@path) ? [File.mtime(@path).to_f, File.size(@path)] : nil

    # Yields the state, saves it atomically when the block changes it, and returns the
    # block's value. The revision counter moves on every change so pollers can wait on it.
    def update
      FileUtils.mkdir_p(@directory)
      File.open(File.join(@directory, "#{FILE}.lock"), File::RDWR | File::CREAT, 0o600) do |lock|
        lock.flock(File::LOCK_EX)
        state = read
        before = JSON.generate(state)
        result = yield state
        unless JSON.generate(state) == before
          state['rev'] = state['rev'].to_i + 1
          write(state)
        end
        result
      end
    end

    def write(state)
      text = JSON.generate(state)
      raise ArgumentError, 'Review state is too large' if text.bytesize > MAX_BYTES
      temporary = "#{@path}.#{Process.pid}.tmp"
      File.write(temporary, text, perm: 0o600)
      File.rename(temporary, @path)
    ensure
      File.unlink(temporary) if temporary && File.file?(temporary)
    end

    # --- is an agent listening --------------------------------------------------------

    # `dcr wait` touches this while it blocks and removes it when it returns, so the page can say
    # whether anything is ready to answer. Not part of the saved state: it changes every second.
    LISTENING = '.listening'
    LISTENING_SECONDS = 4

    # agent: who is listening (claude, codex, ...), so the page can say so by name.
    def heartbeat(agent = nil)
      FileUtils.mkdir_p(@directory)
      File.write(File.join(@directory, LISTENING), "#{Time.now.to_f} #{agent}".strip, perm: 0o600)
    end

    def clear_heartbeat
      File.unlink(File.join(@directory, LISTENING))
    rescue Errno::ENOENT
      nil
    end

    def listening?
      path = File.join(@directory, LISTENING)
      File.file?(path) && Time.now - File.mtime(path) < LISTENING_SECONDS
    end

    # The agent listening right now, when it said who it is.
    def listener
      return nil unless listening?
      File.read(File.join(@directory, LISTENING)).split[1]
    rescue Errno::ENOENT
      nil
    end

    # --- browser progress -------------------------------------------------------------

    def save_blob(key, blob)
      check_key(key)
      raise ArgumentError, 'Saved progress must be an object' unless blob.is_a?(Hash)
      update { |state| state['blobs'][key] = blob }
    end

    # A new revision of the same captured code (evidence or analysis added, nothing moved)
    # keeps the reviewer's progress and conversations. A different snapshot does not: its
    # comments are anchored to other ranges, so it starts fresh as it always has.
    def carry_forward(series, revisions)
      pairs = revisions.sort_by { |revision| revision['number'] }.each_cons(2).select { |old, new| old['fingerprint'] == new['fingerprint'] }
      return if pairs.empty?
      key = ->(revision) { self.class.review_key(revision['fingerprint'], series, revision['number']) }
      update do |state|
        pairs.each do |old, new|
          from, to = key.call(old), key.call(new)
          state['blobs'][to] ||= Marshal.load(Marshal.dump(state['blobs'][from])) if state['blobs'][from]
          state['threads'][to] ||= Marshal.load(Marshal.dump(state['threads'][from])) if state['threads'][from]
          state['previews'][to] ||= Marshal.load(Marshal.dump(state['previews'][from])) if state['previews'][from]
        end
      end
    end

    # --- threads ----------------------------------------------------------------------

    def thread(state, key, id)
      check_key(key)
      raise ArgumentError, 'Invalid thread id' unless id.to_s.match?(ID)
      state['threads'][key] ||= {}
      state['threads'][key][id] ||= {'delivery' => 'draft', 'live' => false, 'messages' => []}
    end

    # agent: which agent wrote an agent message (claude, codex, ...). role 'adversary' marks the
    # second opinion that challenges a comment; it is not an answer to the reviewer.
    def add_message(state, key, id, author, body, agent: nil, role: nil, verdict: nil)
      raise ArgumentError, 'Invalid author' unless AUTHORS.include?(author)
      body = text(body)
      thread = thread(state, key, id)
      message = {'id' => SecureRandom.hex(6), 'author' => author, 'body' => body, 'at' => Time.now.utc.iso8601}
      message['agent'] = Agents.check(agent) if agent && author == 'agent'
      message['role'] = role if role
      message['verdict'] = verdict if verdict
      thread['messages'] << message
      thread['delivery'] = 'answered' if author == 'agent' && role.nil?
      message
    end

    def text(body)
      body = body.to_s.strip
      raise ArgumentError, 'A message cannot be empty' if body.empty?
      raise ArgumentError, 'A message is limited to 20,000 characters' if body.length > 20_000
      body
    end

    # Queues the browser-built text for the agent and makes the thread live, so later user
    # messages in it reach the agent without another click.
    # A comment made on the running app has no code card to live on: its first message is the
    # comment itself, and its anchor (element, page, element text, still) is kept on the thread.
    def send_items(key, items)
      raise ArgumentError, 'Nothing to send' if !items.is_a?(Array) || items.empty? || items.length > 200
      update do |state|
        items.map do |item|
          id = item['id'].to_s
          anchor = app_anchor(item['anchor']) if item.key?('anchor')
          add_message(state, key, id, 'user', item['message']) if item.key?('message')
          thread(state, key, id).merge!('delivery' => 'sent', 'live' => true)
          thread(state, key, id)['anchor'] = anchor if anchor
          enqueue(state, 'send', key, [id], item['text'].to_s)
        end
      end
    end

    APP_ANCHOR = {'selector' => 500, 'path' => 2000, 'text' => 300, 'tag' => 40, 'kind' => 10, 'still' => 1000}.freeze

    def app_anchor(value)
      raise ArgumentError, 'An app anchor must be an object' unless value.is_a?(Hash)
      raise ArgumentError, 'An app anchor needs a selector and a page' unless value['selector'].is_a?(String) && value['path'].is_a?(String)
      raise ArgumentError, 'An app anchor kind is element, clip, still or request' if value.key?('kind') && !%w[element clip still request].include?(value['kind'])
      value.slice(*APP_ANCHOR.keys).each_with_object({}) do |(name, text), out|
        raise ArgumentError, "Invalid app anchor #{name}" unless text.is_a?(String) && text.length <= APP_ANCHOR[name]
        out[name] = text
      end
    end

    # A user message in a thread. Live threads queue it for the agent immediately.
    def user_message(key, id, body)
      update do |state|
        message = add_message(state, key, id, 'user', body)
        thread = thread(state, key, id)
        if thread['live']
          thread['delivery'] = 'sent'
          enqueue(state, 'send', key, [id], "Follow-up in thread #{id}:\n\n#{message['body']}")
        end
        message
      end
    end

    def agent_reply(id, body, key: nil, agent: nil)
      update do |state|
        # A thread carried across revisions exists under several keys; the reviewer reads the newest.
        key ||= state['threads'].select { |_, threads| threads.key?(id) }.keys.max_by { |name| name.split(':').last.to_i }
        raise ArgumentError, "No thread #{id}. Reply to an id printed by `dcr wait`." unless key
        add_message(state, key, id, 'agent', body, agent: agent)
      end
    end

    # --- second opinions on a comment -----------------------------------------------------
    # Other agents weigh in on a comment the review's agent left. The adversary's answer joins the
    # conversation; the rest are kept beside it as opinions, so the conversation stays short.

    # adversary: the agent that answers in the conversation; others: those that weigh in beside it.
    def await_opinions(key, id, adversary, others = [])
      update do |state|
        thread = thread(state, key, id)
        thread['adversary'] = Agents.check(adversary)
        thread['waiting_on'] = Array(thread['waiting_on']) | ([adversary] + others).map { |agent| Agents.check(agent) }
        # The page shows a wait that outlives the agents' timeout as lost, not as still typing.
        thread['asked_at'] = Time.now.utc.iso8601
      end
    end

    # verdict: agree, partly or disagree, when the answer said so.
    def add_opinion(key, id, agent, body, verdict: nil, adversary: false)
      agent = Agents.check(agent)
      update do |state|
        awaiting(state, key, id, agent).each do |copy|
          thread = thread(state, copy, id)
          thread['waiting_on'] = Array(thread['waiting_on']) - [agent]
          # Asked again, an agent's newer answer replaces its earlier one.
          thread['opinions']&.delete(agent)
          if adversary
            thread['messages'].reject! { |message| message['role'] == 'adversary' && message['agent'] == agent }
            add_message(state, copy, id, 'agent', body, agent: agent, role: 'adversary', verdict: verdict)
          else (thread['opinions'] ||= {})[agent] = {'id' => SecureRandom.hex(6), 'body' => text(body), 'verdict' => verdict, 'at' => Time.now.utc.iso8601}.compact
          end
        end
      end
    end

    def opinion_failed(key, id, agent, reason, adversary: false)
      agent = Agents.check(agent)
      update do |state|
        awaiting(state, key, id, agent).each do |copy|
          thread = thread(state, copy, id)
          thread['waiting_on'] = Array(thread['waiting_on']) - [agent]
          # A failed retry keeps the earlier answer; only a first failure is shown.
          next if thread['messages'].any? { |message| message['role'] == 'adversary' && message['agent'] == agent } || thread.dig('opinions', agent, 'body')
          (thread['opinions'] ||= {})[agent] = {'error' => reason.to_s.strip[0, 300], 'role' => (adversary ? 'adversary' : nil), 'at' => Time.now.utc.iso8601}.compact
        end
      end
    end

    # The key the agent was asked under, plus the same-code revisions that carried the thread
    # forward while the answer was on its way: each copy still waits on the agent.
    def awaiting(state, key, id, agent)
      series = key.sub(/:\d+\z/, ':')
      [key] | state['threads'].select { |name, threads| name.start_with?(series) && Array(threads.dig(id, 'waiting_on')).include?(agent) }.keys
    end

    def finish(key)
      update { |state| enqueue(state, 'finish', key, [], 'The reviewer finished this review round.') }
    end

    # --- comments on GitHub ----------------------------------------------------------------
    # Which comments wait in the reviewer's pending GitHub review, and which were posted (with
    # their link). Kept here, not in the browser, so every device shows the same.

    def github_pending(key, id, pending)
      check_key(key)
      raise ArgumentError, 'Invalid comment id' unless id.to_s.match?(ID)
      update do |state|
        entry = github_entry(state, key)
        raise ArgumentError, 'That comment is already on GitHub' if entry['posted'].key?(id)
        if pending then entry['pending'][id] = Time.now.utc.iso8601
        else entry['pending'].delete(id)
        end
        entry
      end
    end

    def github_posted(key, results, review: nil)
      check_key(key)
      update do |state|
        entry = github_entry(state, key)
        results.each do |id, posted|
          entry['pending'].delete(id)
          entry['posted'][id] = posted.merge('at' => Time.now.utc.iso8601)
        end
        (entry['reviews'] << review.merge('at' => Time.now.utc.iso8601)) if review
        entry
      end
    end

    def github_entry(state, key)
      state['github'][key] ||= {}
      state['github'][key]['pending'] ||= {}
      state['github'][key]['posted'] ||= {}
      state['github'][key]['reviews'] ||= []
      state['github'][key]
    end

    # --- comments posted while the review is in progress --------------------------------

    # The agent's review comments, shown on the open page as it writes them. They belong to this
    # revision only: `series finish` saves them into the full review, which embeds them.
    def post_comments(key, comments)
      check_key(key)
      update do |state|
        posted = (state['comments'][key] ||= [])
        taken = posted.map { |comment| comment['id'] }
        comments.each { |comment| raise ArgumentError, "Comment #{comment['id']} was already posted; use a new id" if taken.include?(comment['id']) }
        raise ArgumentError, 'At most 200 comments can be posted to one review' if posted.length + comments.length > 200
        stamp = Time.now.utc.iso8601
        posted.concat(comments.map { |comment| comment.merge('posted_at' => stamp) })
        comments
      end
    end

    # --- a QA pass recorded by the agent ------------------------------------------------

    # The reviewer asks the agent to record evidence for the review in the shared tab. It is a
    # thread like a comment on the app (so the agent's report shows up there), delivered as its own
    # kind because, unlike a conversation, it asks the agent to record and attach.
    def request_qa(key, id, text)
      raise ArgumentError, 'A QA request needs instructions' if text.to_s.strip.empty?
      update do |state|
        add_message(state, key, id, 'user', 'Record visual evidence for this review in this tab.')
        thread(state, key, id).merge!('delivery' => 'sent', 'live' => true, 'anchor' => {'selector' => '', 'path' => '/', 'kind' => 'request'})
        enqueue(state, 'qa', key, [id], text.to_s)
      end
    end

    # --- template previews built by the agent -----------------------------------------

    # Asking for a preview queues a request for the agent. The preview moves requested, working (the
    # agent has it), ready or failed. It is kept per review key like a thread, so it follows a
    # same-code revision.
    def request_preview(key, path)
      check_key(key)
      raise ArgumentError, 'Invalid template path' unless Previews.valid_path?(path)
      update do |state|
        preview = (state['previews'][key] ||= {})[path] ||= {}
        raise ArgumentError, 'A preview of this template is already being built' if %w[requested working].include?(preview['status'])
        state['previews'][key][path] = {'status' => 'requested', 'requested_at' => Time.now.utc.iso8601}
        enqueue(state, 'preview', key, [], "Preview of #{path}", 'path' => path)
      end
    end

    def submit_preview(path, built, key: nil)
      update do |state|
        key = preview_key(state, path, key)
        state['previews'][key][path] = {'status' => 'ready', 'html' => built.fetch('html'), 'title' => built['title'], 'mocks' => built['mocks'],
                                        'ready_at' => Time.now.utc.iso8601}
      end
    end

    def fail_preview(path, reason, key: nil)
      update do |state|
        key = preview_key(state, path, key)
        state['previews'][key][path] = {'status' => 'failed', 'error' => reason.to_s.strip[0, 400], 'ready_at' => Time.now.utc.iso8601}
      end
    end

    # --- outbox -----------------------------------------------------------------------

    # Entries stay until acknowledged, so a `dcr wait` killed after taking them but before
    # printing them hands the same messages to the next one.
    def pending(state = read) = state['outbox'].select { |entry| entry['seq'] > state['acked'] }

    def ack(through)
      through = Integer(through)
      update do |state|
        state['outbox'].select { |entry| entry['seq'] > state['acked'] && entry['seq'] <= through }.each do |entry|
          entry['thread_ids'].each do |id|
            thread = state.dig('threads', entry['key'], id)
            next unless thread && thread['delivery'] == 'sent'
            thread['delivery'] = 'delivered'
            thread['delivered_at'] = Time.now.utc.iso8601
          end
        end
        state['outbox'].select { |entry| entry['kind'] == 'preview' && entry['seq'] > state['acked'] && entry['seq'] <= through }.each do |entry|
          preview = state.dig('previews', entry['key'], entry['path'])
          next unless preview && preview['status'] == 'requested'
          preview.merge!('status' => 'working', 'delivered_at' => Time.now.utc.iso8601)
        end
        state['acked'] = [state['acked'], through].max
      end
    end

    private

    def enqueue(state, kind, key, thread_ids, text, extra = {})
      state['seq'] += 1
      entry = {'seq' => state['seq'], 'kind' => kind, 'key' => key, 'thread_ids' => thread_ids, 'text' => text, 'at' => Time.now.utc.iso8601}.merge(extra)
      state['outbox'] << entry
      state['outbox'] = state['outbox'].last(500)
      entry
    end

    # The newest review key that asked for this template (or the one given).
    def preview_key(state, path, given)
      return check_key(given) || given if given
      candidates = state['previews'].select { |_, previews| %w[requested working].include?(previews.dig(path, 'status')) }.keys
      key = candidates.max_by { |name| name.split(':').last.to_i }
      raise ArgumentError, "No preview of #{path} was requested. Use the template path printed by `dcr wait`." unless key
      key
    end

    def check_key(key)
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(KEY)
    end
  end
end
