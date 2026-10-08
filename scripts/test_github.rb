# frozen_string_literal: true
# Run with ruby scripts/test_github.rb. Stdlib only; a stand-in `gh` records every call, so nothing
# reaches GitHub.
require 'json'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/dcr/github'
require_relative '../lib/dcr/live_api'

def assert(condition, message)
  raise message unless condition
end

KEY = 'dynamic-review:abc123:feature:1'
HEAD = 'b' * 40

FAKE_GH = <<~'RUBY'
  require 'json'
  args = ARGV.dup
  args.shift # api
  method = args[args.index('--method') + 1]
  path = args.find { |arg| arg.start_with?('repos/', 'user') }
  input = args.include?('--input') ? JSON.parse($stdin.read) : nil
  File.open(ENV.fetch('GH_LOG'), 'a') { |log| log.puts(JSON.generate('method' => method, 'path' => path, 'input' => input)) }
  fail_with = ->(code, message) { puts JSON.generate('message' => message); warn "gh: #{message} (HTTP #{code})"; exit 1 }
  fail_with.(401, 'Bad credentials') if ENV['GH_SIGNED_OUT']
  case [method, path]
  when %w[GET user] then puts JSON.generate('login' => 'reviewer')
  when ['GET', 'repos/acme/web/pulls/7'] then puts JSON.generate('user' => {'login' => 'author'}, 'state' => 'open', 'merged_at' => nil)
  when ['POST', 'repos/acme/web/pulls/7/comments']
    fail_with.(422, 'Validation Failed') if input['line'] == 12 && !input['subject_type'] # GitHub's diff is narrower
    puts JSON.generate('html_url' => "https://github.com/acme/web/pull/7#discussion_r#{input['line'] || 'file'}")
  when ['POST', 'repos/acme/web/issues/7/comments'] then puts JSON.generate('html_url' => 'https://github.com/acme/web/pull/7#issuecomment-1')
  when ['POST', 'repos/acme/web/pulls/7/reviews'] then puts JSON.generate('id' => 5, 'html_url' => 'https://github.com/acme/web/pull/7#pullrequestreview-5')
  when ['GET', 'repos/acme/web/pulls/7/reviews/5/comments?per_page=100']
    review = File.readlines(ENV.fetch('GH_LOG')).map { |line| JSON.parse(line) }.reverse.find { |call| call['path'].end_with?('/reviews') }
    puts JSON.generate(review['input']['comments'].each_with_index.map { |c, i| c.merge('html_url' => "https://github.com/acme/web/pull/7#discussion_r9#{i}") })
  else fail_with.(404, 'Not Found')
  end
RUBY

def revision(series, snapshot, review)
  FileUtils.mkdir_p(File.join(series, 'revisions'))
  data = JSON.generate('snapshot' => snapshot, 'review' => review)
  File.write(File.join(series, 'revisions', '001.html'), %(<html><script type="application/json" id="data">#{data}</script></html>))
end

Dir.mktmpdir('dcr-github-test') do |directory|
  series = File.join(directory, 'series')
  log = File.join(directory, 'gh.log')
  gh = File.join(directory, 'gh')
  File.write(gh, "#!#{RbConfig.ruby}\n#{FAKE_GH}")
  File.chmod(0o755, gh)
  ENV['GH_LOG'] = log
  calls = -> { File.file?(log) ? File.readlines(log).map { |line| JSON.parse(line) } : [] }

  snapshot = {'mode' => 'pr', 'base' => 'a' * 40, 'head' => HEAD,
              'files' => [{'path' => 'app/a.rb', 'hunks' => [{'old_start' => 10, 'old_count' => 4, 'new_start' => 10, 'new_count' => 6}]}]}
  review = {'comparison' => {'base' => 'a' * 40, 'head' => HEAD, 'pr_url' => 'https://github.com/acme/web/pull/7'}}
  revision(series, snapshot, review)
  github = DCR::GitHub.new(series, gh: gh)

  status = github.status(KEY)
  assert(status == {'ready' => true, 'login' => 'reviewer', 'repo' => 'acme/web', 'number' => 7, 'url' => 'https://github.com/acme/web/pull/7', 'author' => 'author', 'state' => 'open'}, "Status is wrong: #{status}")
  github.status(KEY)
  assert(calls.().length == 2, 'Status must be cached, not asked again at once')
  puts 'PASS status says who posts where, read from the saved revision and cached'

  posted = github.comment(KEY, {'id' => 'mine-1', 'body' => 'note: x', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 14, 'start_line' => 11})
  call = calls.().last
  assert(posted == {'url' => 'https://github.com/acme/web/pull/7#discussion_r14', 'where' => 'lines'}, "Line comment result is wrong: #{posted}")
  assert(call['input'] == {'body' => 'note: x', 'commit_id' => HEAD, 'path' => 'app/a.rb', 'line' => 14, 'side' => 'RIGHT', 'start_line' => 11, 'start_side' => 'RIGHT'}, "Line comment payload is wrong: #{call['input']}")
  puts 'PASS a single comment lands on its lines, pinned to the reviewed commit'

  before = calls.().length
  outside = github.comment(KEY, {'id' => 'mine-2', 'body' => 'about the header', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 40})
  assert(outside['where'] == 'file' && calls.().length == before + 1, 'Lines outside the diff must post once, as a file comment')
  assert(calls.().last['input'].values_at('subject_type', 'body') == ['file', "**app/a.rb**, line 40 (after the change)\n\nabout the header"], 'A file comment must name its lines')
  rejected = github.comment(KEY, {'id' => 'mine-3', 'body' => 'narrow', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 12})
  assert(rejected['where'] == 'file' && calls.().last(2).map { |c| c['input']['subject_type'] } == [nil, 'file'], 'A line GitHub refuses must fall back to a file comment')
  general = github.comment(KEY, {'id' => 'mine-4', 'body' => 'overall fine', 'general' => true})
  assert(general['where'] == 'conversation' && calls.().last['path'] == 'repos/acme/web/issues/7/comments', 'A general comment goes to the conversation')
  puts 'PASS lines outside the diff, lines GitHub refuses and general comments still post, and say where'

  result = github.review(KEY, 'COMMENT', 'Looks good', [
    {'id' => 'a', 'body' => 'on lines', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 11},
    {'id' => 'b', 'body' => 'elsewhere', 'path' => 'app/a.rb', 'side' => 'LEFT', 'line' => 90},
    {'id' => 'c', 'body' => 'general', 'general' => true}
  ])
  sent = calls.().reverse.find { |c| c['path'].end_with?('/reviews') }['input']
  assert(sent['event'] == 'COMMENT' && sent['commit_id'] == HEAD && sent['comments'] == [{'line' => 11, 'side' => 'RIGHT', 'path' => 'app/a.rb', 'body' => 'on lines'}], "Review payload is wrong: #{sent}")
  assert(sent['body'] == "Looks good\n\n---\n\n**app/a.rb**, line 90 (before the change)\n\nelsewhere\n\n---\n\ngeneral", "Loose comments must go into the review text: #{sent['body']}")
  assert(result['comments']['a'] == {'url' => 'https://github.com/acme/web/pull/7#discussion_r90', 'where' => 'lines'} && result['comments']['b']['where'] == 'review', "Review results are wrong: #{result}")
  puts 'PASS a review posts its line comments together and keeps the rest in its text'

  # Nothing the page sends can choose another pull request, file or commit.
  [
    [{'id' => 'x', 'body' => 'x', 'path' => '../etc/passwd', 'side' => 'RIGHT', 'line' => 1}, 'not part of this review'],
    [{'id' => 'x', 'body' => ' ', 'general' => true}, 'cannot be empty'],
    [{'id' => 'x', 'body' => 'x', 'path' => 'app/a.rb', 'side' => 'UP', 'line' => 1}, 'LEFT or RIGHT'],
    [{'id' => 'x', 'body' => 'x', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 3, 'start_line' => 5}, 'Invalid line range']
  ].each do |item, message|
    error = begin; github.comment(KEY, item); nil; rescue ArgumentError => e; e; end
    assert(error&.message&.include?(message), "Expected #{message} for #{item}, got #{error.inspect}")
  end
  assert((github.review(KEY, 'MERGE', '', [{'id' => 'a', 'body' => 'b', 'general' => true}]) rescue $!).message.include?('Choose'), 'Unknown review events must be refused')
  unverified = File.join(directory, 'unverified')
  revision(unverified, snapshot, {'comparison' => review['comparison'].merge('head' => 'c' * 40)})
  assert(DCR::GitHub.new(unverified, gh: gh).status(KEY) == {'ready' => false, 'reason' => 'This review has no verified GitHub pull request.'}, 'A comparison that does not match the snapshot must not post')
  puts 'PASS the page cannot pick other files, sides, events or an unverified pull request'

  ENV['GH_SIGNED_OUT'] = '1'
  out = DCR::GitHub.new(series, gh: gh)
  assert(out.status(KEY)['reason'].include?('gh auth login'), 'Signed out must say how to sign in')
  ENV.delete('GH_SIGNED_OUT')
  assert(DCR::GitHub.new(series, gh: File.join(directory, 'missing')).status(KEY)['reason'].include?('not installed'), 'A missing gh must say so')
  puts 'PASS a signed-out or missing GitHub CLI explains what to do'

  # Through the API: posted comments are remembered, and posting again returns the first post.
  api = DCR::LiveAPI.new(series, github: DCR::GitHub.new(series, gh: gh))
  body = ->(value) { -> { JSON.generate(value) } }
  item = {'id' => 'mine-9', 'body' => 'once', 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 13}
  code, first = api.call('POST', '/api/github/comment', body.({'key' => KEY, 'item' => item}))
  count = calls.().length
  code2, again = api.call('POST', '/api/github/comment', body.({'key' => KEY, 'item' => item}))
  assert(code == 200 && code2 == 200 && first == again && calls.().length == count, 'A second post of the same comment must not reach GitHub')
  _, entry = api.call('POST', '/api/github/pending', body.({'key' => KEY, 'id' => 'mine-10', 'pending' => true}))
  assert(entry['pending'].key?('mine-10'), 'Pending was not kept')
  code, refused = api.call('POST', '/api/github/pending', body.({'key' => KEY, 'id' => 'mine-9', 'pending' => true}))
  assert(code == 400 && refused['error'].include?('already on GitHub'), 'A posted comment cannot go back to pending')
  _, state = api.call('GET', "/api/state?key=#{KEY}", nil)
  assert(state.dig('github', 'posted', 'mine-9', 'url') && state.dig('github', 'pending').key?('mine-10'), 'The page must see pending and posted comments')
  code, sub = api.call('POST', '/api/github/review', body.({'key' => KEY, 'event' => 'APPROVE', 'body' => '', 'items' => [{'id' => 'mine-10', 'body' => 'r', 'general' => true}]}))
  _, state = api.call('GET', "/api/state?key=#{KEY}", nil)
  assert(code == 200 && sub['review'].end_with?('pullrequestreview-5') && state.dig('github', 'pending').empty? && state.dig('github', 'reviews').last['event'] == 'APPROVE', 'Submitting must post, clear pending and record the review')
  ENV['GH_SIGNED_OUT'] = '1'
  code, failed = DCR::LiveAPI.new(series, github: DCR::GitHub.new(series, gh: gh)).call('POST', '/api/github/comment', body.({'key' => KEY, 'item' => item.merge('id' => 'mine-11')}))
  ENV.delete('GH_SIGNED_OUT')
  assert(code == 502 && failed['error'].include?('gh auth login'), 'A GitHub failure must reach the page as a sentence')
  puts 'PASS the API remembers what was posted, never posts twice and reports failures as sentences'
end
