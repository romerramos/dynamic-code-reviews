# frozen_string_literal: true

require 'json'
require 'optparse'
require 'shellwords'
require 'uri'
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
      PREVIEW REQUEST. Draw the HTML described below from the code and submit it with `dcr preview submit`.
      You may read files, search and run read-only commands, and write temporary files outside the project (your HTML, and stand-in photos you download). Do not edit, create or delete anything in the project, run the app or console, or run formatters, generators, migrations, installs or git commands that change anything.
    TEXT

    QA_RULE = <<~TEXT.strip
      QA REQUEST. Record visual evidence in the review tab the reviewer shared, then attach it.
      You may operate the running app in that tab, run `dcr record` and `dcr evidence attach`, read files and run read-only commands. Do not edit, create or delete anything in the project, and do not run formatters, generators, migrations, installs or git commands that change anything. Use only development data; never record credentials or unrelated screens.
    TEXT

    USAGE = {
      'wait' => 'dcr wait (--repo ROOT --name SERIES | --dir DIR) [--timeout SECONDS] [--json]',
      'comments' => 'dcr comments (--repo ROOT --name SERIES | --dir DIR) [--json]',
      'preview' => 'dcr preview submit (--repo ROOT --name SERIES | --dir DIR) --path <template path> [--file FILE] [--title TITLE] [--css STYLESHEET]... [--page-class CLASSES] [--image-map JSON] | dcr preview fail ... --path <template path> --reason TEXT',
      'export' => 'dcr export (--repo ROOT --name SERIES | --dir DIR) [--out FILE]',
      'comment' => 'dcr comment (--repo ROOT --name SERIES | --dir DIR) [--file COMMENTS.json]   (one review comment or an array, as in the review JSON: id, label, decoration, subject, discussion, hunk, side, start, end; stdin when --file is omitted)',
      'focus' => 'dcr focus (--repo ROOT --name SERIES | --dir DIR)   (brings the browser tab showing the served review to the front)',
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
        p.on('--image-map JSON') { |v| options[:image_map] = v }
        p.on('--css FILE') { |v| (options[:css] ||= []) << v }
        p.on('--page-class CLASSES') { |v| options[:page_class] = v }
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
      when 'comment' then comment(state, options, directory(options, parser))
      when 'focus' then focus(directory(options, parser))
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

    COMMENT_FIELDS = %w[id label decoration subject discussion hunk side start end].freeze

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
        ids << entry['id']
        entry
      end
      entry = history['revisions'].last
      state.post_comments(State.review_key(entry['fingerprint'], history['name'], entry['number']), comments)
      puts "Posted #{comments.length == 1 ? "comment #{comments.first['id']}" : "#{comments.length} comments"} to the open review."
    end

    # Once the review is open in the agent's browser tab: show it to the reviewer, wherever they are.
    def focus(directory)
      require_relative 'focus'
      endpoint = File.join(directory, '.serve.json')
      raise ArgumentError, 'The review is not being served. Run `dcr serve` first.' unless File.file?(endpoint)
      port = Integer(JSON.parse(File.read(endpoint)).fetch('port'))
      browser = Focus.front("http://127.0.0.1:#{port}/")
      puts "Brought the review to the front in #{browser}."
    end

    def reply(state, options, argv, parser)
      id, *words = argv
      raise ArgumentError, parser.to_s unless id && !words.empty?
      message = state.agent_reply(id, words.join(' '), key: options[:key])
      puts options[:json] ? JSON.generate(message) : "Replied to #{id}."
    end
  end
end
