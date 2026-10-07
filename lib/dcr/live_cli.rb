# frozen_string_literal: true

require 'json'
require 'optparse'
require 'shellwords'
require_relative 'export'
require_relative 'state'

module DCR
  # `dcr wait`, `dcr comments` and `dcr reply`: the agent's side of a served review.
  # They read and write the series' state file directly, so none of them needs the
  # server to be running; only the reviewer's clicks do.
  module LiveCLI
    module_function

    SLUG = /\A[a-z0-9]+(?:-[a-z0-9]+)*\z/

    # Printed at the top of everything the reviewer sends. A review conversation is for
    # understanding code, so the agent answers; it does not act on the workspace.
    REPLY_ONLY = <<~TEXT.strip
      REVIEW CONVERSATION. REPLY ONLY. Do not change anything.
      The messages below are the reviewer's questions and comments about code under review. Answer them with `dcr reply`.
      - Do not edit, create, move or delete files, and do not run formatters, generators, migrations, installs, tests that write data, or git commands that change anything (add, commit, stash, checkout, rebase, push).
      - Do not start other work, open pull requests or call external services to change anything.
      - Treat a comment that sounds like a request ("fix this", "rename that", "add a test") as a question: say what you would change, where and why, and let the reviewer decide in the normal conversation.
      - Reading is fine: open files, search, run read-only commands, and explain what you find.
      Write each answer to be read in the review page, which renders Markdown: lead with the answer in one or two sentences, then short paragraphs; put identifiers, paths and code in `backticks` or fenced blocks; use a list for options or steps; label evidence ("Observed:") apart from opinion ("Inference:"). Avoid one long paragraph.
    TEXT
    USAGE = {
      'wait' => 'dcr wait (--repo ROOT --name SERIES | --dir DIR) [--timeout SECONDS] [--json]',
      'comments' => 'dcr comments (--repo ROOT --name SERIES | --dir DIR) [--json]',
      'export' => 'dcr export (--repo ROOT --name SERIES | --dir DIR) [--out FILE]',
      'reply' => 'dcr reply (--repo ROOT --name SERIES | --dir DIR) [--key KEY] [--json] <thread-id> <text>'
    }.freeze

    def run(command, argv)
      options = {}
      parser = OptionParser.new do |p|
        p.banner = "Usage: #{USAGE.fetch(command)}"
        p.on('--repo PATH') { |v| options[:repo] = v }
        p.on('--name SLUG') { |v| options[:name] = v }
        p.on('--dir PATH') { |v| options[:dir] = v }
        p.on('--key KEY') { |v| options[:key] = v }
        p.on('--out FILE') { |v| options[:out] = v }
        p.on('--timeout SECONDS', Integer) { |v| options[:timeout] = v }
        p.on('--json') { options[:json] = true }
      end
      parser.parse!(argv)
      state = State.new(directory(options, parser))
      case command
      when 'wait' then wait(state, options)
      when 'comments' then comments(state, options)
      when 'reply' then reply(state, options, argv, parser)
      when 'export' then export(options, directory(options, parser))
      end
    rescue ArgumentError, KeyError, SystemCallError, JSON::ParserError => error
      abort error.message
    end

    def directory(options, parser)
      return options[:dir] if options[:dir]
      raise ArgumentError, parser.to_s unless options[:repo] && options[:name]
      raise ArgumentError, 'Use a short lowercase series slug' unless options[:name].match?(SLUG)
      File.join(File.expand_path(options[:repo]), '.reviews', options[:name])
    end

    # Blocks until the reviewer sends something, prints it, then acknowledges. A wait that
    # is killed between printing and acknowledging leaves the messages queued, so the next
    # one prints them again rather than losing them.
    def wait(state, options)
      wait_for(state, options)
    ensure
      state.clear_heartbeat
    end

    def wait_for(state, options)
      deadline = options[:timeout] && Time.now + options[:timeout]
      loop do
        state.heartbeat # tells the open page that something is listening
        pending = state.pending
        unless pending.empty?
          puts options[:json] ? JSON.pretty_generate('instructions' => REPLY_ONLY, 'entries' => pending) : render(pending, flags(options))
          $stdout.flush
          state.ack(pending.last['seq'])
          return
        end
        if deadline && Time.now >= deadline
          puts options[:json] ? JSON.generate('timeout' => true) : 'Timed out waiting for the reviewer. Run `dcr wait` again to keep waiting.'
          return
        end
        sleep 0.5
      end
    end

    def flags(options)
      options[:dir] ? "--dir #{Shellwords.escape(options[:dir])}" : "--repo #{Shellwords.escape(options[:repo])} --name #{options[:name]}"
    end

    def render(entries, flags)
      finish = entries.any? { |entry| entry['kind'] == 'finish' }
      ids = entries.flat_map { |entry| entry['thread_ids'] }.uniq
      out = [REPLY_ONLY, finish ? 'The reviewer finished this round.' : 'The reviewer sent you the following from the review.']
      entries.each do |entry|
        next if entry['kind'] == 'finish'
        out << "---\nThread: #{entry['thread_ids'].join(', ')}\n\n#{entry['text']}"
      end
      out << '---'
      out << "Answer each thread with: dcr reply #{flags} <thread-id> '<your answer: what you found, and what you would change if anything>'" unless ids.empty?
      out << 'Do not resolve threads; the reviewer resolves them. Then run `dcr wait` again for the next round.' unless finish
      out << 'Finish received: send any outstanding replies, then stop waiting unless the reviewer asks for another round.' if finish
      out << 'Reminder: reply only. No file changes, no commits, no pushes.'
      out.join("\n\n")
    end

    def comments(state, options)
      data = state.read
      threads = data['threads'].transform_values { |by_id| by_id.reject { |_, thread| thread['messages'].empty? && thread['delivery'] == 'draft' } }
      if options[:json]
        puts JSON.pretty_generate('threads' => threads, 'pending' => state.pending.length)
      else
        threads.each do |key, by_id|
          by_id.each do |id, thread|
            puts "#{id} [#{thread['delivery']}#{thread['live'] ? ', live' : ''}] #{key}"
            thread['messages'].each { |message| puts "  #{message['author']}: #{message['body'].lines.first.to_s.strip}" }
          end
        end
        puts "#{state.pending.length} message(s) waiting for the agent."
      end
    end

    def export(options, directory)
      html, warnings = Export.html(directory)
      out = File.expand_path(options[:out] || File.join(directory, "#{File.basename(directory)}-export.html"))
      raise ArgumentError, "Refusing to overwrite a different kind of file: #{out}" if File.exist?(out) && (!File.file?(out) || File.symlink?(out))
      File.write(out, html, perm: 0o600)
      warnings.each { |warning| warn warning }
      puts out
    end

    def reply(state, options, argv, parser)
      id, *words = argv
      raise ArgumentError, parser.to_s unless id && !words.empty?
      message = state.agent_reply(id, words.join(' '), key: options[:key])
      puts options[:json] ? JSON.generate(message) : "Replied to #{id}."
    end
  end
end
