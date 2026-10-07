# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'securerandom'
require 'time'

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

    def self.empty = {'version' => 1, 'rev' => 0, 'blobs' => {}, 'threads' => {}, 'outbox' => [], 'acked' => 0, 'seq' => 0}

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

    def heartbeat
      FileUtils.mkdir_p(@directory)
      File.write(File.join(@directory, LISTENING), Time.now.to_f.to_s, perm: 0o600)
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
      key = ->(revision) { "dynamic-review:#{revision['fingerprint']}:#{series}:#{revision['number']}" }
      update do |state|
        pairs.each do |old, new|
          from, to = key.call(old), key.call(new)
          state['blobs'][to] ||= Marshal.load(Marshal.dump(state['blobs'][from])) if state['blobs'][from]
          state['threads'][to] ||= Marshal.load(Marshal.dump(state['threads'][from])) if state['threads'][from]
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

    def add_message(state, key, id, author, body)
      raise ArgumentError, 'Invalid author' unless AUTHORS.include?(author)
      body = body.to_s.strip
      raise ArgumentError, 'A message cannot be empty' if body.empty?
      raise ArgumentError, 'A message is limited to 20,000 characters' if body.length > 20_000
      thread = thread(state, key, id)
      message = {'id' => SecureRandom.hex(6), 'author' => author, 'body' => body, 'at' => Time.now.utc.iso8601}
      thread['messages'] << message
      thread['delivery'] = 'answered' if author == 'agent'
      message
    end

    # Queues the browser-built text for the agent and makes the thread live, so later user
    # messages in it reach the agent without another click.
    def send_items(key, items)
      raise ArgumentError, 'Nothing to send' if !items.is_a?(Array) || items.empty? || items.length > 200
      update do |state|
        items.map do |item|
          id = item['id'].to_s
          thread(state, key, id).merge!('delivery' => 'sent', 'live' => true)
          enqueue(state, 'send', key, [id], item['text'].to_s)
        end
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

    def agent_reply(id, body, key: nil)
      update do |state|
        # A thread carried across revisions exists under several keys; the reviewer reads the newest.
        key ||= state['threads'].select { |_, threads| threads.key?(id) }.keys.max_by { |name| name.split(':').last.to_i }
        raise ArgumentError, "No thread #{id}. Reply to an id printed by `dcr wait`." unless key
        add_message(state, key, id, 'agent', body)
      end
    end

    def finish(key)
      update { |state| enqueue(state, 'finish', key, [], 'The reviewer finished this review round.') }
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
        state['acked'] = [state['acked'], through].max
      end
    end

    private

    def enqueue(state, kind, key, thread_ids, text)
      state['seq'] += 1
      entry = {'seq' => state['seq'], 'kind' => kind, 'key' => key, 'thread_ids' => thread_ids, 'text' => text, 'at' => Time.now.utc.iso8601}
      state['outbox'] << entry
      state['outbox'] = state['outbox'].last(500)
      entry
    end

    def check_key(key)
      raise ArgumentError, 'Invalid review key' unless key.to_s.match?(KEY)
    end
  end
end
