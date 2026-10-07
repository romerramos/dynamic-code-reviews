# frozen_string_literal: true

require 'json'
require 'optparse'
require 'shellwords'
require_relative 'export'
require_relative 'previews'
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
      Write every answer in Markdown; the review page renders it and plain text looks like a wall. Use proper syntax:
      - lead with the answer in one or two sentences, then short paragraphs separated by blank lines;
      - wrap every identifier, method, constant, path and snippet in backticks, for example `to_params` or `app/presenters/list_filters.rb`;
      - put multi-line code in a fenced block with a language, for example ```ruby ... ```;
      - use a bulleted or numbered list for options and steps, and **bold** for the one thing to remember;
      - label evidence apart from opinion ("**Observed:** ..." then "**Inference:** ...").
      Do not send one long paragraph.
    TEXT
    # Printed when the reviewer asks for a preview: a task that produces HTML, not a conversation.
    PREVIEW_RULE = <<~TEXT.strip
      PREVIEW REQUEST. Build the HTML described below and submit it with `dcr preview submit`.
      You may read files, search and run read-only commands, and write one temporary file outside the project. Do not edit, create or delete anything in the project, run the app or console, or run formatters, generators, migrations, installs or git commands that change anything.
    TEXT

    QA_RULE = <<~TEXT.strip
      QA REQUEST. Record visual evidence in the review tab the reviewer shared, then attach it.
      You may operate the running app in that tab, run `dcr record` and `dcr evidence attach`, read files and run read-only commands. Do not edit, create or delete anything in the project, and do not run formatters, generators, migrations, installs or git commands that change anything. Use only development data; never record credentials or unrelated screens.
    TEXT

    USAGE = {
      'wait' => 'dcr wait (--repo ROOT --name SERIES | --dir DIR) [--timeout SECONDS] [--json]',
      'comments' => 'dcr comments (--repo ROOT --name SERIES | --dir DIR) [--json]',
      'preview' => 'dcr preview submit (--repo ROOT --name SERIES | --dir DIR) --path <template path> [--file FILE] [--title TITLE] | dcr preview fail ... --path <template path> --reason TEXT',
      'export' => 'dcr export (--repo ROOT --name SERIES | --dir DIR) [--out FILE]',
      'reply' => 'dcr reply (--repo ROOT --name SERIES | --dir DIR) [--key KEY] [--json] <thread-id> <text>',
      'evidence' => 'dcr evidence attach (--repo ROOT --name SERIES | --dir DIR) --file ITEMS.json [--replace previous-qa|all]   (ITEMS: [{"path", "title", "result": "passed|failed", "observed", "comment_id"?, "page"?}]; previous-qa, the default, replaces the last QA review; all replaces every recording, only when the reviewer asks to start over)'
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
        p.on('--path PATH') { |v| options[:path] = v }
        p.on('--file FILE') { |v| options[:file] = v }
        p.on('--title TITLE') { |v| options[:title] = v }
        p.on('--reason TEXT') { |v| options[:reason] = v }
        p.on('--timeout SECONDS', Integer) { |v| options[:timeout] = v }
        p.on('--json') { options[:json] = true }
        p.on('--replace MODE', %w[previous-qa all]) { |v| options[:replace] = v.tr('-', '_').to_sym }
      end
      parser.parse!(argv)
      state = State.new(directory(options, parser))
      case command
      when 'wait' then wait(state, options)
      when 'comments' then comments(state, options)
      when 'reply' then reply(state, options, argv, parser)
      when 'export' then export(options, directory(options, parser))
      when 'preview' then preview(state, options, argv, parser)
      when 'evidence' then evidence(options, directory(options, parser), argv, parser)
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
      sends = entries.select { |entry| entry['kind'] == 'send' }
      previews = entries.select { |entry| entry['kind'] == 'preview' }
      qas = entries.select { |entry| entry['kind'] == 'qa' }
      ids = sends.flat_map { |entry| entry['thread_ids'] }.uniq
      conversation = sends.any? || finish || (previews.empty? && qas.empty?) # a pure task request is not a conversation
      out = []
      out << REPLY_ONLY if conversation
      out << PREVIEW_RULE if previews.any?
      out << QA_RULE if qas.any?
      out << (finish ? 'The reviewer finished this round.' : 'The reviewer sent you the following from the review.') if conversation
      sends.each { |entry| out << "---\nThread: #{entry['thread_ids'].join(', ')}\n\n#{entry['text']}" }
      previews.each { |entry| out << "---\n#{preview_request(entry, flags)}" }
      qas.each { |entry| out << "---\nThread: #{entry['thread_ids'].join(', ')}\n\n#{entry['text']}" }
      out << '---'
      out << "Answer each thread with: dcr reply #{flags} <thread-id> '<your answer: what you found, and what you would change if anything>'" unless ids.empty?
      out << 'Do not resolve threads; the reviewer resolves them.' unless ids.empty? || finish
      out << 'Then run `dcr wait` again for the next round.' unless finish
      out << 'Finish received: send any outstanding replies, then stop waiting unless the reviewer asks for another round.' if finish
      out << if conversation then 'Reminder: reply only. No file changes, no commits, no pushes.'
             elsif qas.any? then 'Reminder: record and attach only. No changes to the project, no commits, no pushes.'
             else 'Reminder: submit HTML only, change nothing in the project.'
             end
      out.join("\n\n")
    end

    def preview_request(entry, flags)
      <<~TEXT.strip
        PREVIEW REQUEST: #{entry['path']}
        Build an approximate HTML preview of this template, so the reviewer can see roughly what it renders.
        1. Read the template. For a ViewComponent also read its Ruby class and sibling template. Find what it renders: partials, other components, helpers. For each nested piece that adds visible markup, read it and include a simplified version in place. Leave out what does not help: tracking snippets, hidden fields, empty wrappers, anything out of context.
        2. Use realistic example data from tests, fixtures or seeds when you can find it, otherwise plausible values. One state is enough unless the change is about different states.
        3. It only has to look roughly right. Do not run the app, a console, a renderer or anything that writes data. Do not edit the project: write your HTML to a temporary file outside it.
        4. Icons: `<i data-icon="name"></i>` with one of these Lucide names: #{Previews.icons.join(', ')}. Any other name becomes a neutral placeholder. Images: `<img src="x" width="120" height="80">`; they become placeholders, so never link to external images, fonts or scripts. No scripts. An inline `<style>` block is welcome: approximate the layout and colours you can find in the app's stylesheets.
        5. Submit ONLY HTML: the first and last characters of your output must be tags. No headings, explanations, comments about your work or Markdown fences. The page shows your output directly.
        Submit with: dcr preview submit #{flags} --path #{entry['path']} --file <your-temp-file> --title "<a short title>"
        If nothing useful can be built: dcr preview fail #{flags} --path #{entry['path']} --reason "<one sentence>"
      TEXT
    end

    # The agent's way to attach what it recorded for a QA request: every clip or still in one file,
    # saved as one revision with each one on its review comment. Files must come from one recorder
    # folder (the one `dcr record --out` used), which the same checks as the reviewer's attach guard.
    def evidence(options, directory, argv, parser)
      raise ArgumentError, parser.to_s unless argv.shift == 'attach' && options[:file]
      items = JSON.parse(File.read(options[:file]))
      raise ArgumentError, 'The file must hold a JSON array of recordings' unless items.is_a?(Array) && items.all?(Hash)
      folders = items.map { |item| File.dirname(File.expand_path(item['path'].to_s)) }.uniq
      raise ArgumentError, 'All recordings must come from one recorder folder (the --out of dcr record)' unless folders.length == 1
      raise ArgumentError, "#{folders.first} is not a recorder folder" unless File.file?(File.join(folders.first, '.qa-session.json'))
      require_relative 'evidence'
      result = Evidence.attach_all(series_dir: directory, capture_dir: folders.first, inputs: items, source: 'agent', replace: options[:replace])
      replaced = result['replaced'].to_i.positive? ? ", replacing #{result['replaced']} #{options[:replace] == :all ? 'earlier recording(s)' : 'from the previous QA review'}" : ''
      puts "Attached #{result['attached']} recording(s)#{replaced} as revision #{result['revision']}: #{result['path']}"
      puts 'The open review offers the new revision; reply to the QA thread with what you recorded and what you skipped.'
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

    # `dcr preview submit` takes the agent's HTML from --file or stdin and shows it in the review.
    def preview(state, options, argv, parser)
      sub = argv.shift
      raise ArgumentError, parser.to_s unless %w[submit fail].include?(sub) && Previews.valid_path?(options[:path])
      if sub == 'fail'
        raise ArgumentError, 'Say why with --reason' if options[:reason].to_s.strip.empty?
        state.fail_preview(options[:path], options[:reason], key: options[:key])
        return puts("Marked the preview of #{options[:path]} as not possible.")
      end
      raw = options[:file] ? File.read(File.expand_path(options[:file]), Previews::LIMIT + 1) : ($stdin.tty? ? raise(ArgumentError, 'Give the HTML with --file or on stdin') : $stdin.read(Previews::LIMIT + 1))
      state.submit_preview(options[:path], Previews.build(raw, title: options[:title]), key: options[:key])
      puts "The preview of #{options[:path]} is ready in the review."
    end

    def reply(state, options, argv, parser)
      id, *words = argv
      raise ArgumentError, parser.to_s unless id && !words.empty?
      message = state.agent_reply(id, words.join(' '), key: options[:key])
      puts options[:json] ? JSON.generate(message) : "Replied to #{id}."
    end
  end
end
