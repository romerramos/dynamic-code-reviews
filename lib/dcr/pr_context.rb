# frozen_string_literal: true

require 'open3'
require 'optparse'
require_relative 'github'
require_relative 'review_report'

module DCR
  # What has already been said around a pull request, for the reviewing agent to read before it
  # writes a comment: the description, the conversation, every review thread with whether it is
  # resolved, the pull requests stacked below and above it, and the issues and pull requests that
  # text mentions, with their titles. Read-only, two GraphQL calls through the signed-in `gh`, and
  # printed short: it shapes the agent's comments and is never posted or saved in the review.
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

    PEOPLE = 'author { login __typename }'
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
              nodes { isResolved isOutdated path line originalLine comments(first: 30) { totalCount nodes { #{PEOPLE} body } } }
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
          marks = [thread['isResolved'] ? 'resolved' : 'unresolved', ('outdated' if thread['isOutdated'])].compact.join(', ')
          out << "- #{thread['path']}:#{thread['line'] || thread['originalLine']} (#{marks})"
          Array(thread.dig('comments', 'nodes')).select { |c| said(c) }.each { |c| out << "  - @#{c.dig('author', 'login')}:" << quote(c['body'], COMMENT).gsub(/^/, '  ') }
        end
      end

      if context['references'].any?
        out << '' << '## Mentioned'
        context['references'].each do |ref|
          item = ref['item']
          name = ref['repo'] == context['repo'] ? "##{ref['number']}" : "#{ref['repo']}##{ref['number']}"
          title = if item.nil? then '(not found, or this account cannot see it)'
                  elsif item['__typename'] == 'PullRequest' then "pull request: #{item['title']} (#{state(item)}; #{item['headRefName']} → #{item['baseRefName']})"
                  else "issue: #{item['title']} (#{state(item)})"
                  end
          out << "- #{name} #{title}, first mentioned in #{ref['where']}"
        end
      end
      out.join("\n")
    end

    # `dcr context --repo ROOT [--pr NUMBER|URL]`. Prints the context, or one line saying why there
    # is none; it exits 0 either way, so a review without a pull request goes on as before.
    def cli(argv, gh: ENV.fetch('DCR_GH', 'gh'), out: $stdout)
      options = {}
      parser = OptionParser.new do |p|
        p.banner = 'Usage: dcr context --repo ROOT [--pr NUMBER|URL]   (what was already said on the pull request and around it, ' \
                   "to read before reviewing; read-only, printed and never saved. Without --pr, the current branch's open pull request)"
        p.on('--repo PATH') { |v| options[:repo] = v }
        p.on('--pr REF') { |v| options[:pr] = v }
      end
      parser.parse!(argv)
      abort parser.banner unless options[:repo] || options[:pr].to_s.match?(GitHub::PR_URL)
      github = GitHub.new(nil, gh: gh)
      repo, number = target(github, options)
      out.puts(number ? text(gather(github, repo, number)) : "No GitHub context: #{repo}")
    rescue GitHub::Error => e
      out.puts "No GitHub context: #{e.message}"
    rescue ArgumentError
      abort parser.banner # a --pr that is no number or pull request link
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
