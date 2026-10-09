# frozen_string_literal: true

require 'json'
require 'open3'
require 'optparse'
require 'rbconfig'
require 'shellwords'
require 'uri'
require_relative 'export'
require_relative 'agents'
require_relative 'previews'
require_relative 'state'

module DCR
  # `dcr wait`, `dcr comments` and `dcr reply`: the agent's side of a served review.
  # They read and write the series' state file directly, so none of them needs the
  # server to be running; only the reviewer's clicks do.
  module LiveCLI
    module_function

    SLUG = /\A[a-z0-9]+(?:-[a-z0-9]+)*\z/
    DCR_BIN = File.expand_path('../../bin/dcr', __dir__)

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
      PREVIEW REQUEST. Draw the HTML described below from the code and submit it with `dcr preview submit`.
      You may read files, search and run read-only commands, and write temporary files outside the project (your HTML, and stand-in photos you download). Do not edit, create or delete anything in the project, run the app or console, or run formatters, generators, migrations, installs or git commands that change anything.
    TEXT

    QA_RULE = <<~TEXT.strip
      QA REQUEST. Record visual evidence in the review tab the reviewer shared, then attach it.
      You may operate the running app in that tab, run `dcr record` and `dcr evidence attach`, read files and run read-only commands. Do not edit, create or delete anything in the project, and do not run formatters, generators, migrations, installs or git commands that change anything. Use only development data; never record credentials or unrelated screens.
    TEXT

    USAGE = {
      'wait' => 'dcr wait (--repo ROOT --name SERIES | --dir DIR) [--agent NAME] [--timeout SECONDS] [--json]',
      'comments' => 'dcr comments (--repo ROOT --name SERIES | --dir DIR) [--thread ID] [--json]   (--thread prints that one conversation in full: the comment as sent, then every message)',
      'preview' => 'dcr preview submit (--repo ROOT --name SERIES | --dir DIR) --path <template path> [--file FILE] [--title TITLE] [--css STYLESHEET]... [--page-class CLASSES] [--image-map JSON] | dcr preview fail ... --path <template path> --reason TEXT',
      'export' => 'dcr export (--repo ROOT --name SERIES | --dir DIR) [--out FILE]',
      'comment' => 'dcr comment (--repo ROOT --name SERIES | --dir DIR) [--agent NAME] [--no-second-opinion] [--file COMMENTS.json]   (one review comment or an array, as in the review JSON: id, label, decoration, subject, discussion, hunk, side, start, end, plus an optional context: one or two plain sentences on what the change tries to do, for the second opinion; stdin when --file is omitted)',
      'stop' => 'dcr stop (--repo ROOT --name SERIES | --dir DIR | --all)   (stops the served review and its `dcr wait`; --all stops every review served on this computer)',
      'link' => 'dcr link (--repo ROOT --name SERIES | --dir DIR)   (the served review\'s addresses: on this computer, and on your tailnet when shared)',
      'focus' => 'dcr focus (--repo ROOT --name SERIES | --dir DIR)   (brings the browser tab showing the served review to the front)',
      'reply' => 'dcr reply (--repo ROOT --name SERIES | --dir DIR) [--agent NAME] [--key KEY] [--json] <thread-id> <text>',
      'second-opinion' => 'dcr second-opinion (--repo ROOT --name SERIES | --dir DIR) --comment ID [--comment ID]... [--agent AUTHOR] [--context TEXT]   (asks the reviewer\'s adversaries to check a posted comment; `dcr comment` does this by itself)',
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
        p.on('--thread ID') { |v| options[:thread] = v }
        p.on('--out FILE') { |v| options[:out] = v }
        p.on('--path PATH') { |v| options[:path] = v }
        p.on('--file FILE') { |v| options[:file] = v }
        p.on('--title TITLE') { |v| options[:title] = v }
        p.on('--reason TEXT') { |v| options[:reason] = v }
        p.on('--image-map JSON') { |v| options[:image_map] = v }
        p.on('--css FILE') { |v| (options[:css] ||= []) << v }
        p.on('--page-class CLASSES') { |v| options[:page_class] = v }
        p.on('--timeout SECONDS', Integer) { |v| options[:timeout] = v }
        p.on('--json') { options[:json] = true }
        p.on('--all') { options[:all] = true }
        p.on('--replace MODE', %w[previous-qa all]) { |v| options[:replace] = v.tr('-', '_').to_sym }
        p.on('--agent NAME', 'Who you are: claude, codex, gemini, grok... (detected when omitted)') { |v| options[:agent] = Agents.check(v) }
        p.on('--comment ID') { |v| (options[:comments] ||= []) << v }
        p.on('--context TEXT') { |v| options[:context] = v }
        p.on('--no-second-opinion') { options[:second_opinion] = false }
      end
      parser.parse!(argv)
      return stop(options, parser) if command == 'stop'
      state = State.new(directory(options, parser))
      case command
      when 'wait' then wait(state, options)
      when 'comments' then comments(state, options)
      when 'reply' then reply(state, options, argv, parser)
      when 'comment' then comment(state, options, directory(options, parser))
      when 'focus' then focus(directory(options, parser))
      when 'link' then link(directory(options, parser))
      when 'export' then export(options, directory(options, parser))
      when 'preview' then preview(state, options, argv, parser)
      when 'evidence' then evidence(options, directory(options, parser), argv, parser)
      when 'second-opinion' then second_opinion(options, directory(options, parser), parser)
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
        state.heartbeat(agent(options)) # tells the open page that something, and who, is listening
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
        Draw this template as HTML, from its code, so the reviewer sees what it renders. Follow the code rather than guessing:
        1. Read the template. For a ViewComponent also read its Ruby class and sibling template; one preview covers both. Follow everything it renders (partials, other components, helpers) and copy each piece's markup in place with its real tags, class names and icon elements. Replace Ruby with what it would output. Leave out what does not help: tracking snippets, hidden fields, empty wrappers.
        2. Fill it with realistic example data from tests, fixtures or seeds when you can find it, otherwise plausible values. Choose the state this change is about; one state is enough unless the change is about different states.
        3. Style it with the app's real CSS: find the compiled stylesheet the layout loads (for example `app/assets/builds/application.css` or `tailwind.css`, or the files under `app/assets/stylesheets`) and pass it with `--css <file>` (repeatable). When the CSS is compiled while the app runs (Sass, Vite, Tailwind) and no built file exists, download the stylesheet the layout links from the running development server to a temporary file (a plain GET, for example `curl -sk https://<app>/vite-dev/entrypoints/application.scss -o /tmp/app.css`) and pass that. Only the rules your markup uses are kept, so keep the class names exactly. Add `--page-class '<classes>'` when rules depend on classes on the page around it (a theme or layout class on `<body>`). Write your own `<style>` only for what the stylesheets cannot give.
        4. Icons: the preview cannot load the app's icon font, so replace every icon element (`<i class="fa-regular fa-bars-filter inbox__icon"></i>`) with the closest Lucide icon you know: `<i class="inbox__icon" data-icon="list-filter"></i>`, keeping its layout classes and dropping the icon-font ones. Any Lucide name works (https://lucide.dev/icons); choose by meaning, not by spelling.
        5. Images: never link to remote images, and never draw or generate one yourself. For each `<img>`, find a real free image that fits what it shows, different each time: a person's face for an avatar (randomuser.me, or a generated avatar from DiceBear or RoboHash), a matching photo for anything else (Unsplash, Pexels, Picsum). Download a small version (under 500 KB) to a temporary file and map it: `--image-map '{"<the img src>": {"path": "<file>", "credit": "<site or author>"}}'`. An image you do not map becomes a neutral placeholder. Give each `<img>` its real width and height.
        6. Size: the reviewer chooses whether the parent wraps the content (Content) or fits it to the height (Fit). If the template fills its parent in the app (a pane, a page shell, a full-height panel), make its root a column that grows (`display: flex; flex-direction: column`, the growing part `flex: 1` with `overflow: auto`, the footer or composer last) and give it no fixed height. A template that only wraps its content needs nothing.
        7. Anything the app sizes or places with JavaScript (dropdowns, popovers, menus, tooltips, floating panels) has no script here. Draw it closed unless the change is about it; when it must be open, give it the position and width it has in the app (read its CSS for `min-width`, `width` and placement) and place it under its trigger yourself, so nothing collapses or wraps mid-word.
        8. Write the HTML to a temporary file outside the project. Submit ONLY HTML: the first and last characters must be tags; no headings, explanations, comments about your work or Markdown fences. No scripts.
        Submit with: dcr preview submit #{flags} --path #{entry['path']} --file <your-temp-file> --css <stylesheet> --title "<a short title>" [--image-map ...]
        It tells you which icons and images were left as placeholders; map them and submit again. Then look at the result at the link it prints, in a tab of your own, and fix what looks broken before you stop.
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
      return thread(state, options) if options[:thread]
      data = state.read
      threads = data['threads'].transform_values { |by_id| by_id.reject { |_, thread| thread['messages'].empty? && thread['delivery'] == 'draft' } }
      if options[:json]
        puts JSON.pretty_generate('threads' => threads, 'pending' => state.pending.length)
      else
        threads.each do |key, by_id|
          by_id.each do |id, thread|
            puts "#{id} [#{thread['delivery']}#{thread['live'] ? ', live' : ''}] #{key}"
            thread['messages'].each { |message| puts "  #{speaker(message)}: #{message['body'].lines.first.to_s.strip}" }
            (thread['opinions'] || {}).each { |agent, opinion| puts "  #{Agents.name(agent)} (opinion#{opinion['verdict'] ? ", #{opinion['verdict']}" : ''}): #{(opinion['body'] || opinion['error']).to_s.lines.first.to_s.strip}" }
          end
        end
        puts "#{state.pending.length} message(s) waiting for the agent."
      end
    end

    # One conversation in full, as a pasted "Copy for LLMs" points to it: the comment and code as
    # first sent, then every message, newest revision first when a thread was carried forward.
    def thread(state, options)
      id = options[:thread]
      data = state.read
      key = options[:key] || data['threads'].select { |_, threads| threads.key?(id) }.keys.max_by { |name| name.split(':').last.to_i }
      found = key && data.dig('threads', key, id)
      raise ArgumentError, "No thread #{id}. `dcr comments` lists the threads of this review." unless found
      sent = data['outbox'].reverse.find { |entry| entry['kind'] == 'send' && entry['thread_ids'].include?(id) && !entry['text'].start_with?("Follow-up in thread #{id}:") }
      return puts(JSON.pretty_generate({'id' => id, 'key' => key, 'comment' => sent&.fetch('text')}.merge(found))) if options[:json]
      out = ["Thread: #{id} [#{found['delivery']}#{found['live'] ? ', live' : ''}]"]
      out << "The comment as sent:\n\n#{sent['text']}" if sent
      found['messages'].each { |message| out << "#{speaker(message)} · #{message['at']}\n#{message['body']}" }
      out << 'No messages yet.' if found['messages'].empty?
      opinions = (found['opinions'] || {}).select { |_, opinion| opinion['body'] }
      out << "Other opinions:\n\n#{opinions.map { |agent, opinion| "#{Agents.name(agent)}#{opinion['verdict'] ? " (#{opinion['verdict']})" : ''}: #{opinion['body']}" }.join("\n\n")}" unless opinions.empty?
      out << "Answer with: dcr reply #{flags(options)} #{id} '<your answer>'" if found['live']
      puts out.join("\n\n---\n\n")
    end

    # Who wrote a message, as the page names them.
    def speaker(message)
      return 'Reviewer' unless message['author'] == 'agent'
      name = message['agent'] ? Agents.name(message['agent']) : 'Agent'
      message['role'] == 'adversary' ? "#{name} (second reviewer#{message['verdict'] ? ", #{message['verdict']}" : ''})" : name
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
      raw = raw.to_s.dup.force_encoding(Encoding::UTF_8).scrub # a length-limited read is binary; the HTML is text
      css = Array(options[:css]).map { |path| File.binread(File.expand_path(path)) }.join("\n")
      image_map, base_dir = json_option(options[:image_map], '--image-map')
      built = Previews.build(raw, title: options[:title], css: css, page_class: options[:page_class], image_map: image_map, base_dir: base_dir)
      state.submit_preview(options[:path], built, key: options[:key])
      puts "The preview of #{options[:path]} is ready in the review."
      endpoint = File.join(File.dirname(state.path), '.serve.json')
      if File.file?(endpoint)
        port = JSON.parse(File.read(endpoint))['port']
        puts "Look at it before you finish: open http://127.0.0.1:#{port}/preview?#{URI.encode_www_form(path: options[:path])} in a new tab of your browser tool (not the reviewer's tab), at about 1280 and 390 px wide. Fix anything squeezed, wrapped mid-word, overlapping or cut off, submit again, then close that tab."
      end
      mocks = built['mocks'] || {}
      puts "Icon-font icons left as placeholders: #{mocks['unmatched'].join(', ')}. Replace each with <i data-icon=\"<lucide name>\"></i>, choosing the closest Lucide icon, and submit again." if mocks['unmatched']&.any?
      puts "Lucide has no icon named: #{mocks['unknown_icons'].join(', ')}. Choose other Lucide names and submit again." if mocks['unknown_icons']&.any?
      puts "Images left as placeholders: #{mocks['unmatched_images'].join('; ')}. Save a fitting free photo for each (a person for an avatar) and submit again with --image-map '{\"<src>\": {\"path\": \"<file>\", \"credit\": \"<source>\"}}'." if mocks['unmatched_images']&.any?
    end

    # A JSON object given inline or as a file; [value, the directory relative paths in it resolve against].
    def json_option(value, flag)
      return [{}, Dir.pwd] if value.to_s.strip.empty?
      inline = value.strip.start_with?('{')
      parsed = JSON.parse(inline ? value : File.read(File.expand_path(value)))
      raise ArgumentError, "#{flag} must be a JSON object" unless parsed.is_a?(Hash)
      [parsed, inline ? Dir.pwd : File.dirname(File.expand_path(value))]
    end

    COMMENT_FIELDS = %w[id label decoration subject discussion hunk side start end context].freeze

    # While a review is in progress the agent posts each comment as soon as it is sure of it; the
    # open page shows it beside the code and announces it. `dcr series finish` keeps them.
    def comment(state, options, directory)
      require_relative '../../scripts/series'
      raw = options[:file] ? File.read(File.expand_path(options[:file])) : ($stdin.tty? ? raise(ArgumentError, 'Give the comment JSON with --file or on stdin') : $stdin.read)
      input = JSON.parse(raw)
      comments = input.is_a?(Array) ? input : [input]
      raise ArgumentError, 'Give one comment object or an array of them' if comments.empty? || !comments.all?(Hash)
      history = ReviewSeries.manifest(directory)
      payload = ReviewSeries.latest(directory, history)
      snapshot, review = payload.values_at('snapshot', 'review')
      raise ArgumentError, 'This review is finished. Comments are posted only while a review is in progress (`dcr series start --in-progress`).' unless review['status'] == 'in_progress'
      hunks = DynamicReviews.hunk_index(snapshot)
      ids = Array(review['comments']).map { |existing| existing['id'] }
      comments = comments.map do |entry|
        unknown = entry.keys - COMMENT_FIELDS
        raise ArgumentError, "Unknown comment field(s): #{unknown.join(', ')}" unless unknown.empty?
        raise ArgumentError, 'A comment discussion must be text' if entry.key?('discussion') && !entry['discussion'].is_a?(String)
        DynamicReviews.validate_comment(entry, hunks)
        raise ArgumentError, "Comment id #{entry['id']} is used twice" if ids.include?(entry['id'])
        raise ArgumentError, 'A comment context must be short text' if entry.key?('context') && !(entry['context'].is_a?(String) && entry['context'].length <= 1000)
        ids << entry['id']
        entry
      end
      author = agent(options, state)
      contexts = comments.to_h { |entry| [entry['id'], entry['context']] }
      comments = comments.map { |entry| entry.except('context').merge(author ? {'agent' => author} : {}) }
      entry = history['revisions'].last
      state.post_comments(State.review_key(entry['fingerprint'], history['name'], entry['number']), comments)
      puts "Posted #{comments.length == 1 ? "comment #{comments.first['id']}" : "#{comments.length} comments"} to the open review."
      ask_others(directory, comments, author, contexts) unless options[:second_opinion] == false
    end

    # Each comment is checked by the reviewer's adversaries in the background; the answers appear in
    # the open page as they arrive. The log next to the review says what went wrong, if anything.
    def ask_others(directory, comments, author, contexts)
      require_relative 'settings'
      panel = Agents.panel(author, Settings.new.adversaries).map { |adversary| Agents.name(adversary['agent']) }
      return puts(NO_ADVERSARIES) if panel.empty?
      log = File.open(File.join(directory, '.second-opinions.log'), 'a', 0o600)
      comments.each do |comment|
        command = [RbConfig.ruby, DCR_BIN, 'second-opinion', '--dir', directory, '--comment', comment['id']]
        command += ['--agent', author] if author
        command += ['--context', contexts[comment['id']]] if contexts[comment['id']]
        Process.detach(Process.spawn(*command, in: File::NULL, out: log, err: log, pgroup: true))
      end
      log.close
      puts "Asked #{panel.first} to check #{comments.length == 1 ? 'it' : 'them'}#{panel.length > 1 ? " (#{panel.drop(1).join(' and ')} weigh in on the side)" : ''}; their answers appear in the page."
    end

    NO_ADVERSARIES = 'No adversaries are set up, so nobody else checks it. The reviewer chooses them in the review page (the agent card).'

    def second_opinion(options, directory, parser)
      raise ArgumentError, parser.to_s unless options[:comments]
      require_relative 'second_opinion'
      results = SecondOpinion.run(series_dir: directory, comment_ids: options[:comments], author: agent(options) || 'agent', context: options[:context])
      return puts(NO_ADVERSARIES) if results.empty?
      results.each { |id, answers| puts "#{id}: #{answers.map { |slug, outcome| "#{Agents.name(slug)} #{outcome}" }.join(', ')}" }
    end

    # Who is running this command: --agent, what its CLI left in the environment, or the listener.
    def agent(options, state = nil) = options[:agent] || Agents.detect || state&.listener

    # Served reviews keep running in the background until stopped. This stops the review server of one
    # series (or every one with --all) and the `dcr wait` listening for it. A server removes its tailnet
    # share as it exits; a stopped review stays readable as its saved HTML.
    def stop(options, parser)
      found = review_processes
      unless options[:all]
        directory = directory(options, parser)
        name = File.basename(directory)
        found = found.select { |_, command| command.include?(directory) || command.match?(/--name #{Regexp.escape(name)}(?:\s|\z)/) }
      end
      return puts(options[:all] ? 'No review is being served on this computer.' : "No server or wait is running for #{File.basename(directory)}.") if found.empty?
      found.each_key { |pid| Process.kill('TERM', pid) rescue nil }
      deadline = Time.now + 5
      sleep 0.2 while Time.now < deadline && found.keys.any? { |pid| (Process.kill(0, pid) rescue false) }
      servers = found.count { |_, command| serving?(command) }
      puts "Stopped #{servers} review server(s) and #{found.length - servers} wait(s)#{options[:all] ? ' on this computer' : " for #{File.basename(directory)}"}."
    end

    # [pid => command] of review servers (`dcr serve`) and `dcr wait` listeners, from any installed copy.
    def review_processes
      out, = Open3.capture2('ps', '-eo', 'pid=,command=')
      out.lines.filter_map do |line|
        pid, command = line.strip.split(' ', 2)
        next unless command && pid.to_i != Process.pid
        [pid.to_i, command] if serving?(command) || command.match?(%r{bin/dcr\s+wait\b})
      end.to_h
    end

    # `dcr serve`, including one started by an older copy, which ran it as qa_capture.rb.
    def serving?(command) = command.match?(%r{bin/dcr\s+serve\b}) || command.include?('scripts/qa_capture.rb') && !command.match?(/qa_capture\.rb\s+control\b/)

    # What the agent quotes to the reviewer, who may be on another device: the addresses of the served review.
    def link(directory)
      endpoint = File.join(directory, '.serve.json')
      raise ArgumentError, 'The review is not being served. Run `dcr serve` first.' unless File.file?(endpoint)
      served = JSON.parse(File.read(endpoint))
      puts "On this computer: http://127.0.0.1:#{served.fetch('port')}/#overview"
      puts served['shared'] ? "On your tailnet: #{served['shared']}/#overview" : 'Not shared on your tailnet (serve with --share to open it from your other devices).'
    end

    # Once the review is open in the agent's browser tab: show it to the reviewer, wherever they are.
    def focus(directory)
      require_relative 'focus'
      browser = Focus.served(directory)
      puts "Brought the review to the front in #{browser}."
    end

    def reply(state, options, argv, parser)
      id, *words = argv
      raise ArgumentError, parser.to_s unless id && !words.empty?
      message = state.agent_reply(id, words.join(' '), key: options[:key], agent: agent(options, state))
      puts options[:json] ? JSON.generate(message) : "Replied to #{id}."
    end
  end
end
