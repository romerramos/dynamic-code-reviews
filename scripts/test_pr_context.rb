# frozen_string_literal: true
# Run with ruby scripts/test_pr_context.rb. Stdlib only; a stand-in `gh` answers the GraphQL
# queries and records them, so nothing reaches GitHub.
require 'json'
require 'open3'
require 'rbconfig'
require 'tmpdir'

def assert(condition, message)
  raise message unless condition
end

DCR_BIN = File.expand_path('../bin/dcr', __dir__)

# Answers the pull request query, the query for what is around it, and the branch lookup.
FAKE_GH = <<~'RUBY'
  require 'json'
  body = JSON.parse($stdin.read)
  query = body['query']
  File.open(ENV.fetch('GH_LOG'), 'a') { |log| log.puts(JSON.generate('args' => ARGV, 'query' => query)) }
  if ENV['GH_SIGNED_OUT']
    puts JSON.generate('message' => 'Bad credentials'); warn 'gh: Bad credentials (HTTP 401)'; exit 1
  end
  person = ->(login, type = 'User') { {'login' => login, '__typename' => type} }
  if query.include?('headRefName: $branch')
    nodes = body.dig('variables', 'branch') == 'feat/acme-42-keep-value' ? [{'number' => 7}] : []
    puts JSON.generate('data' => {'repository' => {'pullRequests' => {'nodes' => nodes}}})
  elsif query.include?('pullRequest(number:')
    puts JSON.generate('data' => {'repository' => {'pullRequest' => {
      'number' => 7, 'title' => 'feat(ACME-42): keep the value', 'url' => 'https://github.com/acme/web/pull/7',
      'state' => 'OPEN', 'isDraft' => false, 'baseRefName' => 'feat/acme-42-store', 'headRefName' => 'feat/acme-42-keep-value',
      'author' => person.('ada-author'),
      'body' => "<!-- template: hidden -->\nKeeps the value.\n\nStacked on #6. See [ACME-42](https://linear.app/acme/issue/ACME-42).\n\n" \
                "Asked in [a session](https://claude.ai/code/session_0123abcd). CI log: https://ci.example.com/run/5?token=tok3n-value-9",
      'closingIssuesReferences' => {'nodes' => [{'number' => 3, 'title' => 'Value is lost', 'state' => 'OPEN', 'url' => 'https://github.com/acme/web/issues/3', 'repository' => {'nameWithOwner' => 'acme/web'}}]},
      'comments' => {'totalCount' => 3, 'nodes' => [
        {'author' => person.('ci-helper', 'Bot'), 'body' => 'Coverage dropped, see #900. Linked https://linear.app/acme/issue/ACME-50/related'},
        {'author' => person.('rae-reviewer'), 'body' => "<!-- dynamic-code-reviews:report -->\nReview report"},
        {'author' => person.('ada-author'), 'body' => 'Backfill has run.'}
      ]},
      'reviews' => {'totalCount' => 2, 'nodes' => [
        {'author' => person.('rae-reviewer'), 'state' => 'CHANGES_REQUESTED', 'body' => 'One question, see acme/api#12.'},
        {'author' => person.('rae-reviewer'), 'state' => 'COMMENTED', 'body' => ''}
      ]},
      'reviewThreads' => {'totalCount' => 150, 'nodes' => [
        {'isResolved' => true, 'isOutdated' => false, 'path' => 'app/notifier.rb', 'line' => 64, 'originalLine' => 60, 'comments' => {'totalCount' => 2, 'nodes' => [
          {'author' => person.('rae-reviewer'), 'body' => '**question (blocking):** Should the flag wait until the email is sent?'},
          {'author' => person.('ada-author'), 'body' => 'That follows in https://github.com/acme/web/pull/8'}
        ]}},
        {'isResolved' => false, 'isOutdated' => true, 'path' => 'app/job.rb', 'line' => nil, 'originalLine' => 12, 'comments' => {'totalCount' => 1, 'nodes' => [
          {'author' => person.('rae-reviewer'), 'body' => 'Is #999 still a problem here?'}
        ]}},
        {'isResolved' => false, 'isOutdated' => false, 'path' => 'app/bot.rb', 'line' => 3, 'originalLine' => 3, 'comments' => {'totalCount' => 1, 'nodes' => [
          {'author' => person.('lint-helper', 'Bot'), 'body' => 'Style offence'}
        ]}}
      ]}
    }}})
  else
    data = {
      'below' => {'pullRequests' => {'nodes' => [{'number' => 6, 'title' => 'feat(ACME-42): store the value', 'state' => 'MERGED', 'url' => 'https://github.com/acme/web/pull/6', 'baseRefName' => 'main', 'headRefName' => 'feat/acme-42-store'}]}},
      'above' => {'pullRequests' => {'nodes' => [{'number' => 8, 'title' => 'feat(ACME-42): send it later', 'state' => 'OPEN', 'url' => 'https://github.com/acme/web/pull/8', 'baseRefName' => 'feat/acme-42-keep-value', 'headRefName' => 'feat/acme-42-later'}]}}
    }
    found = {'6' => {'__typename' => 'PullRequest', 'title' => 'feat(ACME-42): store the value', 'state' => 'MERGED', 'baseRefName' => 'main', 'headRefName' => 'feat/acme-42-store'},
             '8' => {'__typename' => 'PullRequest', 'title' => 'feat(ACME-42): send it later', 'state' => 'OPEN', 'baseRefName' => 'feat/acme-42-keep-value', 'headRefName' => 'feat/acme-42-later'},
             '12' => {'__typename' => 'Issue', 'title' => 'API keeps old values', 'state' => 'CLOSED'}}
    errors = []
    query.scan(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issueOrPullRequest\(number: (\d+)\)/).each do |name, _owner, _repo, number|
      data[name] = {'issueOrPullRequest' => found[number]}
      errors << {'type' => 'NOT_FOUND', 'message' => "Could not resolve #{number}"} unless found[number]
    end
    puts JSON.generate({'data' => data}.merge(errors.any? ? {'errors' => errors} : {}))
    if errors.any?
      warn "gh: #{errors.first['message']}"
      exit 1 # GitHub's partial answer: gh prints the data and fails
    end
  end
RUBY

Dir.mktmpdir('dcr-pr-context-test') do |directory|
  log = File.join(directory, 'gh.log')
  gh = File.join(directory, 'gh')
  File.write(gh, "#!#{RbConfig.ruby}\n#{FAKE_GH}")
  File.chmod(0o755, gh)
  env = {'DCR_GH' => gh, 'GH_LOG' => log}
  calls = -> { File.file?(log) ? File.readlines(log).map { |line| JSON.parse(line) } : [] }
  dcr = ->(*args, extra: {}) { Open3.capture3(env.merge(extra), RbConfig.ruby, DCR_BIN, 'context', *args) }
  git = ->(repo, *args) { system('git', '-C', repo, *args, out: File::NULL, err: File::NULL) or raise "git #{args.join(' ')} failed" }

  out, err, status = dcr.('--pr', 'https://github.com/acme/web/pull/7')
  assert(status.success? && err.empty?, "context failed: #{err}")
  expected = {
    'the pull request, its branches and author' => "# acme/web#7: feat(ACME-42): keep the value\nopen, by @ada-author; feat/acme-42-keep-value → feat/acme-42-store.",
    'the description without its HTML comments' => "## Description\nKeeps the value.",
    'the issue it closes' => '- closes acme/web#3 Value is lost (open)',
    "the tracker id from its branch and title" => "- issue tracker, this pull request's: ACME-42 (from its branch and title)",
    'a tracker link elsewhere, a bot\'s included' => '- issue tracker, linked: ACME-50',
    'the pull request it is stacked on' => '- on top of #6 feat(ACME-42): store the value (merged; feat/acme-42-store → main)',
    'the pull request stacked on it' => '- stacked on this: #8 feat(ACME-42): send it later (open; feat/acme-42-later → feat/acme-42-keep-value)',
    'a review with a body' => "- @rae-reviewer reviewed (changes requested):\n    One question, see acme/api#12.",
    'a person in the conversation' => "- @ada-author:\n    Backfill has run.",
    'a resolved thread with the answer' => "- app/notifier.rb:64 (resolved)\n  - @rae-reviewer:\n      **question (blocking):** Should the flag wait until the email is sent?\n  - @ada-author:\n      That follows in https://github.com/acme/web/pull/8",
    'an outdated thread on its original line' => '- app/job.rb:12 (unresolved, outdated)',
    'that not every thread is shown' => '## Review threads (3 of 150 shown)',
    'a mention resolved to its title and where it was said' => '- #8 pull request: feat(ACME-42): send it later (open; feat/acme-42-later → feat/acme-42-keep-value), first mentioned in @ada-author on app/notifier.rb',
    'a mention in another repository' => '- acme/api#12 issue: API keeps old values (closed), first mentioned in @rae-reviewer\'s review',
    'a mention GitHub cannot resolve, with the rest still shown' => '- #999 (not found, or this account cannot see it), first mentioned in @rae-reviewer on app/job.rb'
  }
  expected.each { |what, text| assert(out.include?(text), "The context must show #{what}:\n#{text}\n--- got ---\n#{out}") }
  left_out = {'a bot\'s comment' => 'Coverage dropped', 'a bot\'s mention' => '#900', 'a bot\'s thread' => 'app/bot.rb',
              'the review\'s own report' => 'Review report', 'an HTML comment' => 'template: hidden', 'an empty review' => 'reviewed (commented)',
              'the pull request itself as a mention' => '- #7 '}
  left_out.each { |what, text| assert(!out.include?(text), "The context must leave out #{what} (#{text}):\n#{out}") }
  assert(out.include?('CI log: [link with a token removed]') && !out.include?('tok3n-value-9'), "A token in a link never reaches even the review's own agent:\n#{out}")
  assert(out.include?('[a session](https://claude.ai/code/session_0123abcd)'), "The review's own agent still sees the author's session link:\n#{out}")
  assert(calls.().length == 2 && calls.().all? { |call| call['args'].first(4) == %w[api --method POST graphql] && !call['query'].match?(/\bmutation\b/) },
         "It must make two read-only GraphQL queries: #{calls.()}")
  puts 'PASS a pull request\'s context: threads with their state, the stack, issues and mentions; bots and the report left out'

  repo = File.join(directory, 'repo')
  git.(directory, 'init', '-q', '-b', 'feat/acme-42-keep-value', repo)
  git.(repo, 'commit', '-q', '--allow-empty', '-m', 'start')
  File.delete(log)
  out, _, status = dcr.('--repo', repo)
  assert(status.success? && out.strip == 'No GitHub context: this checkout has no GitHub remote.' && calls.().empty?, "A checkout with no GitHub remote must say so and ask nothing: #{out}")

  git.(repo, 'remote', 'add', 'origin', 'git@github.com:acme/web.git')
  out, _, status = dcr.('--repo', repo)
  assert(status.success? && out.start_with?('# acme/web#7: '), "Without --pr it must find the branch's open pull request: #{out}")
  out, _, status = dcr.('--repo', repo, '--pr', '#7')
  assert(status.success? && out.start_with?('# acme/web#7: '), "--pr must take a number in the checkout's repository: #{out}")
  git.(repo, 'checkout', '-q', '-b', 'feat/no-pull')
  out, _, status = dcr.('--repo', repo)
  assert(status.success? && out.strip == 'No GitHub context: feat/no-pull has no open pull request.', "A branch with no pull request must say so: #{out}")
  out, _, status = dcr.('--repo', repo, extra: {'GH_SIGNED_OUT' => '1'})
  assert(status.success? && out.strip.start_with?('No GitHub context: GitHub CLI is not signed in.'), "A signed-out gh must say so in one line: #{out}")
  out, _, status = dcr.('--repo', repo, extra: {'DCR_GH' => File.join(directory, 'missing-gh')})
  assert(status.success? && out.strip.start_with?('No GitHub context: GitHub CLI (`gh`) is not installed.'), "A missing gh must say so in one line: #{out}")
  puts 'PASS with no pull request, no GitHub remote or no gh it says so in one line and succeeds'
end

require_relative '../lib/dcr/pr_context'
private_text = {
  'https://claude.ai/code/session_01AbC' => '[private link removed]',
  'https://chatgpt.com/share/6f1e-77aa' => '[private link removed]',
  'https://gemini.google.com/share/abc123' => '[private link removed]',
  'https://ci-bot:hunter22@ci.example.com/job/4' => '[link with a password removed]',
  'https://files.example.com/a.png?X-Amz-Signature=deadbeef01&x=1' => '[link with a token removed]',
  "ghp_#{'a1' * 18}" => '[secret removed]',
  "sk-ant-api03-#{'Z9' * 12}" => '[secret removed]',
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----" => '[private key removed]'
}
private_text.each do |text, placeholder|
  scrubbed = DCR::PRContext.scrub("before #{text} after", sessions: true)
  assert(scrubbed == "before #{placeholder} after", "#{text.lines.first.strip} must become #{placeholder}: #{scrubbed}")
end
kept = 'See https://github.com/acme/web/pull/8, https://claude.com/claude-code and https://example.com/list?page=2.'
assert(DCR::PRContext.scrub(kept, sessions: true) == kept, 'Public links stay as they are')
assert(DCR::PRContext.scrub('https://claude.ai/code/session_01AbC') == 'https://claude.ai/code/session_01AbC', "Without sessions: the review's own agent keeps session links")
puts 'PASS session links, credentials in links and keys become short placeholders; public links stay'
