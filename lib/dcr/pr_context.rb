# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'open3'
require 'optparse'
require 'time'
require_relative 'github'
require_relative 'review_report'

module DCR
  # What has already been said around a pull request, for the reviewing agent to read before it
  # writes a comment: the description, the conversation, every review thread with whether it is
  # resolved, the pull requests stacked below and above it, and the issues and pull requests that
  # text mentions, with their titles. Read-only, two GraphQL calls through the signed-in `gh`, and
  # printed short: it shapes the agent's comments and is never posted or saved in the review.
  # With a series (--name), the last read is kept beside the review's own files (context.json,
  # private: never posted, and only its description is on the page, as the pull request shows it),
  # for the adversaries checking comments and for --since-last, which says what changed on the pull
  # request since that read.
  # With no pull request, no GitHub remote or no `gh`, it says so in one line and that is all.
  module PRContext
    module_function

    BODY = 3000    # characters of the description
    COMMENT = 800  # characters of each comment
    REFERENCES = 15
    TRACKER_ID = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/
    TRACKER_URL = %r{https://linear\.app/[\w-]+/issue/([A-Za-z][A-Za-z0-9]{1,9}-\d+)}
    GITHUB_URL = %r{https://github\.com/([\w.-]+)/([\w.-]+)/(?:pull|issues)/(\d+)}
    SHORT_REF = %r{(?<![\w/&#])(?:([\w.-]+)/([\w.-]+))?#(\d+)\b}

    # What must never leave this computer in someone else's words: a URL's credentials, a token in
    # a URL and keys. A PR's description is printed as written, and may carry them.
    URL_END = %q{[^\s)\]>"'`]}
    SECRETS = [
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)/m, '[private key removed]'],
      [%r{\bhttps?://[^\s/@)\]>"'`]+:[^\s/@)\]>"'`]+@#{URL_END}*}i, '[link with a password removed]'],
      [%r{\bhttps?://#{URL_END}*?[?&](?:access_token|token|api_?key|key|secret|password|sig|signature|x-amz-signature|x-amz-credential|x-goog-signature)=#{URL_END}+}i, '[link with a token removed]'],
      [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[0-9A-Za-z]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[0-9A-Za-z-]{10,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,})/, '[secret removed]']
    ].freeze
    # An agent's session or a shared chat: fine for the review's own agent, private to another company's.
    SESSION = %r{\bhttps?://(?:[\w-]+\.)*(?:claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|g\.co/gemini|aistudio\.google\.com|grok\.com|perplexity\.ai|poe\.com|copilot\.microsoft\.com|chat\.deepseek\.com|chat\.mistral\.ai)(?:/#{URL_END}*)?}i

    PEOPLE = 'id author { login __typename }'
    QUERY = <<~GRAPHQL
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            number title url state isDraft body baseRefName headRefName #{PEOPLE}
            closingIssuesReferences(first: 10) { nodes { number title state url repository { nameWithOwner } } }
            comments(first: 100) { totalCount nodes { #{PEOPLE} body } }
            reviews(first: 100) { totalCount nodes { #{PEOPLE} state body } }
            reviewThreads(first: 100) {
              totalCount
              nodes { id isResolved isOutdated path line originalLine comments(first: 30) { totalCount nodes { #{PEOPLE} body } } }
            }
          }
        }
      }
    GRAPHQL
    BRANCH_QUERY = <<~GRAPHQL
      query($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, states: OPEN, first: 1) { nodes { number } } }
      }
    GRAPHQL
    STACK = 'number title state url baseRefName headRefName'

    # The pull request's context as a Hash, or raises GitHub::Error.
    def gather(github, repo, number)
      owner, name = repo.split('/', 2)
      pull = github.graphql(QUERY, 'owner' => owner, 'name' => name, 'number' => number).dig('repository', 'pullRequest') or
        raise GitHub::Error, "GitHub has no pull request #{repo}##{number}, or this account cannot see it."
      references = references(pull, repo)
      around = github.graphql(around_query(owner, name, pull, references), {})
      pull.merge('repo' => repo, 'below' => nodes(around['below']), 'above' => nodes(around['above']),
                 'references' => references.each_with_index.map { |ref, index| ref.merge('item' => around.dig("r#{index}", 'issueOrPullRequest')) },
                 'tracker' => tracker_ids(pull))
    end

    # The pull request this one is stacked on, those stacked on it, and what its text mentions.
    def around_query(owner, name, pull, references)
      repo = ->(o, n) { "repository(owner: #{JSON.generate(o)}, name: #{JSON.generate(n)})" }
      mentioned = references.each_with_index.map do |ref, index|
        o, n = ref['repo'].split('/', 2)
        "r#{index}: #{repo.(o, n)} { issueOrPullRequest(number: #{Integer(ref['number'])}) { __typename " \
          "... on Issue { title state url } ... on PullRequest { #{STACK} } } }"
      end
      <<~GRAPHQL
        query {
          below: #{repo.(owner, name)} { pullRequests(headRefName: #{JSON.generate(pull['baseRefName'])}, first: 3, states: [OPEN, MERGED]) { nodes { #{STACK} } } }
          above: #{repo.(owner, name)} { pullRequests(baseRefName: #{JSON.generate(pull['headRefName'])}, first: 10, states: [OPEN, MERGED]) { nodes { #{STACK} } } }
          #{mentioned.join("\n  ")}
        }
      GRAPHQL
    end

    def nodes(connection) = Array(connection&.dig('pullRequests', 'nodes'))

    # Who wrote it, unless a bot or the review's own report did.
    def said(node) = node['author'] && node.dig('author', '__typename') != 'Bot' && !node['body'].to_s.include?(ReviewReport::MARK)

    # Every pull request and issue people mention, once, with where it was first mentioned.
    def references(pull, repo)
      texts = [['the description', pull['body']]]
      Array(pull.dig('comments', 'nodes')).select { |c| said(c) }.each { |c| texts << ["@#{c.dig('author', 'login')} in the conversation", c['body']] }
      Array(pull.dig('reviews', 'nodes')).select { |r| said(r) }.each { |r| texts << ["@#{r.dig('author', 'login')}'s review", r['body']] }
      Array(pull.dig('reviewThreads', 'nodes')).each do |thread|
        Array(thread.dig('comments', 'nodes')).select { |c| said(c) }.each { |c| texts << ["@#{c.dig('author', 'login')} on #{thread['path']}", c['body']] }
      end
      found = {}
      texts.each do |where, text|
        text = clean(text)
        hits = text.scan(GITHUB_URL).map { |o, n, number| ["#{o}/#{n}", number.to_i] }
        hits += text.gsub(GITHUB_URL, '').scan(SHORT_REF).map { |o, n, number| [o ? "#{o}/#{n}" : repo, number.to_i] }
        hits.each { |key| found[key] ||= {'repo' => key[0], 'number' => key[1], 'where' => where} }
      end
      found.delete([repo, pull['number']])
      found.values.first(REFERENCES)
    end

    # Issue-tracker ids (COR-1852): {'own' => from the branch and title, 'linked' => from tracker
    # links in the text, a tracker's link-back comment included}.
    def tracker_ids(pull)
      own = (pull['headRefName'].to_s.upcase.scan(TRACKER_ID).flatten + pull['title'].to_s.scan(TRACKER_ID).flatten).uniq
      texts = [pull['body'], *Array(pull.dig('comments', 'nodes')).map { |c| c['body'] }]
      linked = texts.flat_map { |text| text.to_s.scan(TRACKER_URL).flatten.map(&:upcase) }.uniq - own
      {'own' => own, 'linked' => linked}
    end

    FILE = 'context.json'
    DIFF_LINES = 20 # of an edited description

    # The last read kept beside a review: {'read_at', 'revision', 'context'}, or nil.
    def stored(series_dir)
      path = File.join(series_dir.to_s, FILE)
      File.file?(path) && !File.symlink?(path) ? JSON.parse(File.read(path)) : nil
    rescue JSON::ParserError, SystemCallError
      nil
    end

    # The pull request's description from the kept read, for the review's Overview: {'url', 'body'}
    # with its HTML comments and secrets removed, or nil without a read.
    def description(series_dir)
      kept = stored(series_dir)&.dig('context') or return
      {'url' => kept['url'], 'title' => kept['title'], 'body' => clean(kept['body'])} if kept['url'].is_a?(String)
    end

    # Keeps this read beside the review, with the revision it was read at.
    def store(series_dir, context)
      manifest = File.join(series_dir, 'manifest.json')
      revision = File.file?(manifest) ? JSON.parse(File.read(manifest)).fetch('revisions', []).last&.fetch('number', nil) : nil
      path = File.join(series_dir, FILE)
      raise ArgumentError, "Refusing symlink: #{path}" if File.symlink?(path)
      File.write("#{path}.tmp", JSON.generate('read_at' => Time.now.utc.iso8601, 'revision' => revision, 'context' => context), perm: 0o600)
      File.rename("#{path}.tmp", path)
    end

    # What changed on the pull request between two reads, as short plain text.
    def since(before, context)
      was = before['context']
      at = [("revision #{before['revision']}" if before['revision']), Time.parse(before['read_at']).utc.strftime('%Y-%m-%d %H:%M UTC')].compact.join(', ')
      out = []
      out << "- The title changed, from: #{was['title']}" if was['title'] != context['title']
      out << "- It is #{state(context)} now (was #{state(was)})." if state(was) != state(context)
      if clean(was['body']) != clean(context['body'])
        old, new = clean(was['body']).lines.map(&:rstrip), clean(context['body']).lines.map(&:rstrip)
        lines = (old - new).reject(&:empty?).map { |line| "    - #{line}" } + (new - old).reject(&:empty?).map { |line| "    + #{line}" }
        out << '- The description was edited:' << lines.first(DIFF_LINES).join("\n")
        out << "    (#{lines.length - DIFF_LINES} more changed lines: read `dcr context` in full)" if lines.length > DIFF_LINES
      end
      { 'below' => 'Now on top of', 'above' => 'Newly stacked on this:' }.each do |side, words|
        known = Array(was[side]).to_h { |node| [node['number'], node] }
        context[side].each do |node|
          if !known[node['number']] then out << "- #{words} #{pull_line(node)}"
          elsif known[node['number']]['state'] != node['state'] then out << "- ##{node['number']} is #{state(node)} now (was #{state(known[node['number']])})."
          end
        end
        (known.keys - context[side].map { |node| node['number'] }).each { |number| out << "- ##{number} is no longer #{side == 'below' ? 'under' : 'stacked on'} this one." }
      end
      closes = Array(was.dig('closingIssuesReferences', 'nodes')).map { |issue| issue['url'] }
      Array(context.dig('closingIssuesReferences', 'nodes')).reject { |issue| closes.include?(issue['url']) }.each { |issue| out << "- Now closes #{issue.dig('repository', 'nameWithOwner')}##{issue['number']} #{issue['title']} (#{issue['state'].downcase})" }
      key = ->(node) { node['id'] || node['body'] }
      said_before = Array(was.dig('comments', 'nodes')).to_h { |node| [key.(node), node] }
      Array(context.dig('comments', 'nodes')).select { |c| said(c) }.each do |comment|
        earlier = said_before[key.(comment)]
        next if earlier && clean(earlier['body']) == clean(comment['body'])
        out << "- @#{comment.dig('author', 'login')} #{earlier ? 'edited a comment' : 'in the conversation'}:" << quote(comment['body'], COMMENT)
      end
      reviewed = Array(was.dig('reviews', 'nodes')).map { |node| key.(node) }
      Array(context.dig('reviews', 'nodes')).select { |r| said(r) && !reviewed.include?(key.(r)) && !clean(r['body']).empty? }.each do |review|
        out << "- @#{review.dig('author', 'login')} reviewed (#{review['state'].downcase.tr('_', ' ')}):" << quote(review['body'], COMMENT)
      end
      threads = Array(was.dig('reviewThreads', 'nodes')).to_h { |thread| [thread['id'] || [thread['path'], thread['originalLine']], thread] }
      Array(context.dig('reviewThreads', 'nodes')).each do |thread|
        earlier = threads[thread['id'] || [thread['path'], thread['originalLine']]]
        heard = Array(earlier&.dig('comments', 'nodes')).map { |comment| key.(comment) }
        fresh = Array(thread.dig('comments', 'nodes')).select { |comment| said(comment) && !heard.include?(key.(comment)) }
        where = "#{thread['path']}:#{thread['line'] || thread['originalLine']}"
        if earlier.nil? && fresh.any? then out << "- New thread on #{where} (#{thread_marks(thread)}):"
        elsif fresh.any? then out << "- New replies on #{where} (#{thread_marks(thread)}):"
        elsif earlier && earlier['isResolved'] != thread['isResolved'] then out << "- #{thread['isResolved'] ? 'Resolved' : 'Reopened'} since: #{where}"
        end
        fresh.each { |comment| out << "  - @#{comment.dig('author', 'login')}:" << quote(comment['body'], COMMENT).gsub(/^/, '  ') }
        out << "  (resolved since)" if earlier && fresh.any? && thread['isResolved'] && !earlier['isResolved']
      end
      mentioned = Array(was['references']).map { |ref| [ref['repo'], ref['number']] }
      context['references'].reject { |ref| mentioned.include?([ref['repo'], ref['number']]) }.each { |ref| out << "- Newly mentioned: #{reference_line(context, ref)}" }
      ids = was['tracker'] ? was['tracker'].values.flatten : []
      fresh_ids = context['tracker'].values.flatten - ids
      out << "- Newly linked issue-tracker ids: #{fresh_ids.join(', ')}" if fresh_ids.any?
      head = "# #{context['repo']}##{context['number']}: #{context['title']}\n## Since the last read (#{at})"
      [head, out.empty? ? 'Nothing changed on the pull request or around it.' : out.join("\n")].join("\n")
    end

    BRIEF = 1200 # characters of what was already said, in an adversary's question
    SAID = 240   # characters of each thing said, there
    PLANNED = /\b(?:defer\w*|follow(?:s|ing|[- ]?ups?)?|later|next|stacked|separate(?:ly)?|out of scope|not in this|step \d+|todo|will be)\b|#\d+/i

    # What was already said on the pull request that bears on a comment, for an adversary checking it:
    # the threads on its file, nearest first, the stack, what the description says is planned or
    # deferred, and the author's own words in the conversation. Short, one line each, cut at BRIEF,
    # with agent session links and secrets removed: it goes to another company's agent. kept: a
    # stored read; path and lines: the comment's (nil for none). nil when there is nothing to say.
    def brief(kept, path: nil, lines: nil)
      context = kept&.dig('context') or return
      repo_url = %r{https://github\.com/#{Regexp.escape(context['repo'].to_s)}/(?:pull|issues)/(\d+)\S*}
      say = lambda do |text|
        text = scrub(text, sessions: true).gsub(/\[([^\]\n]+)\]\([^)\s]+\)/, '\\1').gsub(repo_url, '#\\1')
        short(text, SAID).gsub(/\s*\n\s*/, ' ')
      end
      items = []
      near = ->(thread) { !(line = thread['line'] || thread['originalLine']) || !lines || lines.cover?(line) ? 0 : [(lines.first - line).abs, (line - lines.last).abs].min }
      threads = Array(context.dig('reviewThreads', 'nodes')).select { |thread| path && thread['path'] == path && Array(thread.dig('comments', 'nodes')).any? { |c| said(c) } }
      threads.sort_by(&near).first(3).each do |thread|
        words = Array(thread.dig('comments', 'nodes')).select { |c| said(c) }.first(4).map { |c| "  @#{c.dig('author', 'login')}: #{say.(c['body'])}" }
        items << ["- A thread on line #{thread['line'] || thread['originalLine']} (#{thread_marks(thread)}):", *words].join("\n")
      end
      context['above'].each { |node| items << "- Stacked on this: ##{node['number']} #{node['title']} (#{state(node)})" }
      context['below'].each { |node| items << "- This is stacked on: ##{node['number']} #{node['title']} (#{state(node)})" }
      planned = clean(context['body']).lines.reject { |line| line.match?(/\A\s*(?:#|```|\|)/) }.flat_map { |line| line.split(/(?<=[.!?])\s+/) }.grep(PLANNED).first(3)
      items << "- The description says: #{planned.map { |sentence| say.(sentence) }.join(' … ')}" if planned.any?
      author = context.dig('author', 'login')
      Array(context.dig('comments', 'nodes')).select { |c| said(c) && c.dig('author', 'login') == author }.last(2).each { |c| items << "- @#{author} in the conversation: #{say.(c['body'])}" }
      return if items.empty?
      shown = []
      items.each { |item| shown.sum(&:length) + item.length <= BRIEF ? shown << item : break }
      read = kept['revision'] ? "read at revision #{kept['revision']}" : 'read before the review'
      "What was already said on the pull request (#{context['repo']}##{context['number']} by @#{author}, #{read}; " \
        "#{path ? "threads on #{path} only" : 'no file'}):\n#{shown.join("\n")}"
    end

    def thread_marks(thread) = [thread['isResolved'] ? 'resolved' : 'unresolved', ('outdated' if thread['isOutdated'])].compact.join(', ')

    def reference_line(context, ref)
      item = ref['item']
      name = ref['repo'] == context['repo'] ? "##{ref['number']}" : "#{ref['repo']}##{ref['number']}"
      title = if item.nil? then '(not found, or this account cannot see it)'
              elsif item['__typename'] == 'PullRequest' then "pull request: #{item['title']} (#{state(item)}; #{item['headRefName']} → #{item['baseRefName']})"
              else "issue: #{item['title']} (#{state(item)})"
              end
      "#{name} #{title}, first mentioned in #{ref['where']}"
    end

    # Text without HTML comments, trailing space, runs of blank lines and secrets.
    def clean(text) = scrub(text.to_s.gsub(/<!--.*?-->/m, '').gsub(/[ \t]+$/, '').gsub(/\n{3,}/, "\n\n").strip)

    # Text with every secret replaced by a short placeholder; sessions: agent session and shared-chat
    # links too, for text another company's agent reads.
    def scrub(text, sessions: false)
      text = SECRETS.reduce(text.to_s) { |done, (pattern, placeholder)| done.gsub(pattern, placeholder) }
      sessions ? text.gsub(SESSION, '[private link removed]') : text
    end

    def short(text, limit)
      text = clean(text)
      text.length > limit ? "#{text[0, limit].rstrip} […]" : text
    end

    def quote(text, limit) = short(text, limit).lines.map { |line| "    #{line.rstrip}" }.join("\n")

    def state(node) = [node['state']&.downcase, ('draft' if node['isDraft'])].compact.join(', ')

    def pull_line(node) = "##{node['number']} #{node['title']} (#{state(node)}; #{node['headRefName']} → #{node['baseRefName']}) #{node['url']}"

    def more(connection, shown) = connection && connection['totalCount'].to_i > shown ? " (#{shown} of #{connection['totalCount']} shown)" : ''

    # The context as short plain text, in the order the agent should read it.
    def text(context)
      out = ["# #{context['repo']}##{context['number']}: #{context['title']}",
             "#{state(context)}, by @#{context.dig('author', 'login')}; #{context['headRefName']} → #{context['baseRefName']}. #{context['url']}"]
      out << '' << '## Description' << (short(context['body'], BODY).then { |body| body.empty? ? '(none)' : body })

      issues = Array(context.dig('closingIssuesReferences', 'nodes'))
      tracker = context['tracker']
      if issues.any? || tracker.values.any?(&:any?)
        out << '' << '## Issues'
        issues.each { |issue| out << "- closes #{issue.dig('repository', 'nameWithOwner')}##{issue['number']} #{issue['title']} (#{issue['state'].downcase})" }
        out << "- issue tracker, this pull request's: #{tracker['own'].join(', ')} (from its branch and title)" if tracker['own'].any?
        out << "- issue tracker, linked: #{tracker['linked'].join(', ')}" if tracker['linked'].any?
      end

      if context['below'].any? || context['above'].any?
        out << '' << '## Stack'
        context['below'].each { |node| out << "- on top of #{pull_line(node)}" }
        context['above'].each { |node| out << "- stacked on this: #{pull_line(node)}" }
      end

      people = Array(context.dig('comments', 'nodes')).select { |c| said(c) }
      reviews = Array(context.dig('reviews', 'nodes')).select { |r| said(r) && !clean(r['body']).empty? }
      if people.any? || reviews.any?
        out << '' << "## Conversation#{more(context['comments'], Array(context.dig('comments', 'nodes')).length)}"
        reviews.each { |r| out << "- @#{r.dig('author', 'login')} reviewed (#{r['state'].downcase.tr('_', ' ')}):" << quote(r['body'], COMMENT) }
        people.each { |c| out << "- @#{c.dig('author', 'login')}:" << quote(c['body'], COMMENT) }
      end

      threads = Array(context.dig('reviewThreads', 'nodes')).select { |t| Array(t.dig('comments', 'nodes')).any? { |c| said(c) } }
      if threads.any?
        out << '' << "## Review threads#{more(context['reviewThreads'], Array(context.dig('reviewThreads', 'nodes')).length)}"
        threads.each do |thread|
          out << "- #{thread['path']}:#{thread['line'] || thread['originalLine']} (#{thread_marks(thread)})"
          Array(thread.dig('comments', 'nodes')).select { |c| said(c) }.each { |c| out << "  - @#{c.dig('author', 'login')}:" << quote(c['body'], COMMENT).gsub(/^/, '  ') }
        end
      end

      if context['references'].any?
        out << '' << '## Mentioned'
        context['references'].each { |ref| out << "- #{reference_line(context, ref)}" }
      end
      out.join("\n")
    end

    # `dcr context --repo ROOT [--pr NUMBER|URL] [--name SERIES [--since-last]]`. Prints the context,
    # or one line saying why there is none; it exits 0 either way, so a review without a pull request
    # goes on as before. With a series it keeps the read beside the review; --since-last prints only
    # what changed since the kept one (all of it when there is none). A failed read keeps the last.
    def cli(argv, gh: ENV.fetch('DCR_GH', 'gh'), out: $stdout)
      options = {}
      parser = OptionParser.new do |p|
        p.banner = 'Usage: dcr context (--repo ROOT [--name SERIES] | --dir SERIES_DIR) [--pr NUMBER|URL] [--since-last]   ' \
                   '(what was already said on the pull request and around it, to read before reviewing; read-only on GitHub, ' \
                   "never posted. Without --pr, the series' pull request or the current branch's open one. With a series, the read is " \
                   'kept beside the review, privately, for the adversaries; --since-last prints only what changed since the kept read)'
        p.on('--repo PATH') { |v| options[:repo] = v }
        p.on('--name SERIES') { |v| options[:name] = v }
        p.on('--dir PATH') { |v| options[:dir] = v }
        p.on('--pr REF') { |v| options[:pr] = v }
        p.on('--since-last') { options[:since_last] = true }
      end
      parser.parse!(argv)
      series = series_dir(options)
      abort parser.banner unless options[:repo] || options[:pr].to_s.match?(GitHub::PR_URL)
      abort '--since-last needs the series: --name SERIES or --dir SERIES_DIR' if options[:since_last] && !series
      before = series && stored(series)
      options[:pr] ||= before&.dig('context', 'url')
      github = GitHub.new(nil, gh: gh)
      repo, number = target(github, options)
      return out.puts("No GitHub context: #{repo}") unless number

      context = gather(github, repo, number)
      store(series, context) if series
      out.puts(options[:since_last] && before && before.dig('context', 'url') == context['url'] ? since(before, context) : text(context))
    rescue GitHub::Error => e
      out.puts "No GitHub context: #{e.message}"
    rescue ArgumentError
      abort parser.banner # a --pr that is no number or pull request link
    end

    # The series' directory (made when the review does not exist yet), or nil without one.
    def series_dir(options)
      if options[:dir]
        dir = File.expand_path(options[:dir])
        options[:repo] ||= JSON.parse(File.read(File.join(dir, 'manifest.json'))).fetch('repo')
        return dir
      end
      return unless options[:name] && options[:repo]
      require_relative '../../scripts/series'
      ReviewSeries.directory(options[:repo], options[:name], create: true)
    rescue Errno::ENOENT, JSON::ParserError, KeyError
      abort "No review series in #{options[:dir]}"
    rescue ArgumentError => e
      abort e.message
    end

    # [owner/name, number], or [why there is none, nil].
    def target(github, options)
      if (match = options[:pr].to_s.match(GitHub::PR_URL))
        return ["#{match[1]}/#{match[2]}", match[3].to_i]
      end

      root = options[:repo]
      remotes, = Open3.capture2('git', '-C', root, 'remote', '-v')
      urls = remotes.lines.map(&:split).sort_by { |name, _| name == 'origin' ? 0 : 1 }.map { |_, url| url }
      match = urls.lazy.filter_map { |url| url.to_s.match(GitHub::GITHUB_REMOTE) }.first or return ['this checkout has no GitHub remote.', nil]
      repo = "#{match[1]}/#{match[2]}"
      return [repo, Integer(options[:pr].to_s.delete_prefix('#'))] if options[:pr]

      branch, = Open3.capture2('git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD')
      branch = branch.strip
      return ['no branch is checked out.', nil] if branch.empty? || branch == 'HEAD'
      found = github.graphql(BRANCH_QUERY, 'owner' => match[1], 'name' => match[2], 'branch' => branch).dig('repository', 'pullRequests', 'nodes', 0, 'number')
      found ? [repo, found] : ["#{branch} has no open pull request.", nil]
    end
  end
end
