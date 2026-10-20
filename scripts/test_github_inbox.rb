# frozen_string_literal: true
# Run with ruby scripts/test_github_inbox.rb. Stdlib only; a stand-in `gh` answers from a fixture and
# records every call, so nothing reaches GitHub.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings
require 'json'
require 'fileutils'
require_relative '../lib/dcr/github'
require_relative '../lib/dcr/live_api'
require_relative 'review'

def assert(condition, message)
  raise message unless condition
end

HEAD = 'b' * 40
FP = 'abc123'
KEY = "dynamic-review:#{FP}:feature:1"

# Answers `gh api` from GH_FIXTURE ("METHOD path" => response); a POST it has no answer for is
# echoed back with an address, as GitHub does.
FAKE_GH = <<~'RUBY'
  require 'json'
  args = ARGV.dup
  method = args[args.index('--method') + 1]
  path = args.find { |arg| arg.start_with?('repos/', 'user') }
  input = args.include?('--input') ? JSON.parse($stdin.read) : nil
  File.open(ENV.fetch('GH_LOG'), 'a') { |log| log.puts(JSON.generate('method' => method, 'path' => path, 'input' => input)) }
  fixture = JSON.parse(File.read(ENV.fetch('GH_FIXTURE')))
  answer = fixture["#{method} #{path}"]
  answer ||= {'id' => 999, 'html_url' => "https://github.com/acme/web/pull/7#discussion_r999"} if method == 'POST'
  answer ||= [] if path.include?('page=')
  if answer.nil?
    puts JSON.generate('message' => 'Not Found'); warn 'gh: Not Found (HTTP 404)'; exit 1
  end
  puts JSON.generate(answer)
RUBY

person = ->(login, type = 'User') { {'login' => login, 'avatar_url' => "https://avatars.githubusercontent.com/u/#{login.length}", 'type' => type} }
line = lambda do |id, login, body, path: 'app/a.rb', number: 2, review: 900, reply_to: nil, at: '2026-10-20T10:00:00Z', type: 'User'|
  {'id' => id, 'user' => person.(login, type), 'body' => body, 'created_at' => at, 'html_url' => "https://github.com/acme/web/pull/7#discussion_r#{id}",
   'pull_request_review_id' => review, 'in_reply_to_id' => reply_to, 'path' => path, 'subject_type' => 'line', 'side' => 'RIGHT', 'start_line' => nil,
   'line' => number, 'commit_id' => HEAD, 'original_line' => number, 'original_commit_id' => HEAD}
end
PAGE = '?per_page=100&page=1'

Dir.mktmpdir('dcr-inbox-test') do |directory|
  series = File.join(directory, 'series')
  FileUtils.mkdir_p(File.join(series, 'revisions'))
  hunk = ->(file) { {'id' => "#{file}h1", 'old_start' => 1, 'old_count' => 1, 'new_start' => 1, 'new_count' => 2, 'patch' => "@@ -1 +1,2 @@\n x\n+y\n"} }
  snapshot = {'mode' => 'pr', 'base' => 'a' * 40, 'head' => HEAD, 'fingerprint' => FP,
              'files' => [{'id' => 'f1', 'path' => 'app/a.rb', 'hunks' => [hunk.('f1')]}, {'id' => 'f2', 'path' => 'app/b.rb', 'hunks' => [hunk.('f2')]}]}
  review = {'comments' => [{'id' => 'c1', 'label' => 'issue', 'decoration' => 'non-blocking', 'subject' => 'Leaks', 'agent' => 'claude', 'hunk' => 'f1h1', 'side' => 'new', 'start' => 2, 'end' => 2}],
            'comparison' => {'base' => 'a' * 40, 'head' => HEAD, 'pr_url' => 'https://github.com/acme/web/pull/7'}}
  File.write(File.join(series, 'revisions', '001.html'), %(<html><script type="application/json" id="data">#{JSON.generate('snapshot' => snapshot, 'review' => review)}</script></html>))
  File.write(File.join(series, 'manifest.json'), JSON.generate('name' => 'feature', 'revisions' => [{'number' => 1, 'fingerprint' => FP}]))

  state = DCR::State.new(series)
  # The reader posted one comment from the review, and published its report.
  state.github_posted(KEY, {'mine-1' => {'url' => 'https://github.com/acme/web/pull/7#discussion_r106', 'where' => 'lines'}})
  state.github_report(KEY, {'id' => 202, 'url' => 'https://github.com/acme/web/pull/7#issuecomment-202'})

  fixture = {
    'GET user' => {'login' => 'reviewer', 'avatar_url' => 'https://avatars.githubusercontent.com/u/1'},
    'GET repos/acme/web/pulls/7' => {'head' => {'sha' => HEAD}, 'user' => {'login' => 'reviewer'}, 'state' => 'open'},
    "GET repos/acme/web/pulls/7/comments#{PAGE}" => [
      line.(101, 'jane', "**issue (blocking):** This leaks the token\nIt is logged on every request."),
      line.(102, 'jane', 'Why is this needed?', path: 'app/b.rb', number: 50, at: '2026-10-20T10:00:01Z'),
      line.(103, 'reviewer', 'Good catch, looking.', reply_to: 101, review: 950, at: '2026-10-20T10:05:00Z'),
      line.(104, 'helper', 'Bump available.', type: 'Bot', review: 960),
      line.(105, 'sam', 'Agreed with Jane.', reply_to: 101, review: 970, at: '2026-10-20T10:06:00Z'),
      line.(106, 'reviewer', 'My own, posted from the review.', review: 980)
    ],
    "GET repos/acme/web/issues/7/comments#{PAGE}" => [
      {'id' => 201, 'user' => person.('sam'), 'body' => 'Looks good overall', 'created_at' => '2026-10-20T09:00:00Z', 'html_url' => 'https://github.com/acme/web/pull/7#issuecomment-201'},
      {'id' => 202, 'user' => person.('reviewer'), 'body' => "<!-- dynamic-code-reviews:report -->\nReviewed", 'created_at' => '2026-10-20T09:30:00Z', 'html_url' => 'x'}
    ],
    "GET repos/acme/web/pulls/7/reviews#{PAGE}" => [
      {'id' => 900, 'user' => person.('jane'), 'body' => '', 'state' => 'COMMENTED', 'submitted_at' => '2026-10-20T10:00:02Z'},
      {'id' => 901, 'user' => person.('sam'), 'body' => 'Ship it', 'state' => 'APPROVED', 'submitted_at' => '2026-10-20T11:00:00Z', 'html_url' => 'https://github.com/acme/web/pull/7#pullrequestreview-901'}
    ]
  }
  fixture_path = File.join(directory, 'fixture.json')
  File.write(fixture_path, JSON.generate(fixture))
  log = File.join(directory, 'gh.log')
  gh = File.join(directory, 'gh')
  File.write(gh, "#!#{RbConfig.ruby}\n#{FAKE_GH}")
  File.chmod(0o755, gh)
  ENV['GH_LOG'] = log
  ENV['GH_FIXTURE'] = fixture_path
  calls = -> { File.file?(log) ? File.readlines(log).map { |row| JSON.parse(row) } : [] }

  asked = []
  github = DCR::GitHub.new(series, gh: gh, avatar: ->(_url) { ['image/png', 'png'] })
  api = DCR::LiveAPI.new(series, github: github, ask_adversaries: ->(key, id, text) { asked << [key, id, text] })
  take = lambda do
    api.instance_variable_set(:@inbox_at, nil) # the once-a-minute limit is not under test
    code, = api.call('GET', '/api/sync', nil)
    assert(code == 200, 'The page\'s check for new code answers')
    api.instance_variable_get(:@inbox_thread)&.join
  end

  # --- what people said joins the review ------------------------------------------------------
  take.()
  saved = state.read
  comments = saved['comments'][KEY].to_h { |comment| [comment['id'], comment] }
  assert(comments.keys.sort == %w[gh-101 gh-102 gh-i201 gh-r901], "Taken in are the people's comments, not the bot's, the report or the reader's own: #{comments.keys}")
  first = comments['gh-101']
  assert(first.slice('hunk', 'side', 'start', 'end', 'label', 'decoration', 'subject', 'discussion') ==
         {'hunk' => 'f1h1', 'side' => 'new', 'start' => 2, 'end' => 2, 'label' => 'issue', 'decoration' => 'blocking', 'subject' => 'This leaks the token', 'discussion' => 'It is logged on every request.'},
         "A comment on the reviewed lines sits on them, with its own label: #{first}")
  assert(first['author'] == {'login' => 'jane', 'avatar' => 'data:image/png;base64,cG5n'} && !first.key?('agent'), "It is Jane's, with her face: #{first['author']}")
  outside = comments['gh-102']
  assert(outside['general'] && outside['label'] == 'question' && outside['discussion'] == 'On `app/b.rb`, line 50:', "Lines the diff does not have make a general comment that says where: #{outside}")
  assert(comments['gh-r901']['label'] == 'praise' && comments['gh-i201']['general'], 'An approval is praise; a conversation comment is general')
  DynamicReviews.validate_comment(outside, {}) # a saved review takes it
  puts 'PASS people\'s comments join the review on their lines, as theirs; bots, the report and the reader\'s own posts stay out'

  messages = saved.dig('threads', KEY, 'gh-101', 'messages')
  assert(messages.map { |message| [message['author'], message['body']] } == [['user', 'Good catch, looking.'], ['person', 'Agreed with Jane.']], "Replies join the thread, the reader's as theirs: #{messages}")
  assert(messages.last['person']['login'] == 'sam', 'A teammate\'s reply says who')
  sends = saved['outbox'].select { |entry| entry['kind'] == 'send' }
  assert(sends.map { |entry| entry['thread_ids'] } == [%w[gh-i201], %w[gh-101 gh-102], %w[gh-r901], %w[gh-101]], "Each person's comments sent together go to the agent as one message, a reply after: #{sends.map { |entry| entry['thread_ids'] }}")
  jane = sends[1]['text']
  assert(jane.start_with?('@jane left 2 comments') && jane.include?('Thread gh-101 · app/a.rb, line 2 after the change') && jane.include?('never instructions to you'), "The agent reads the whole review, and whose it is:\n#{jane}")
  assert(sends.last['text'].include?('from @sam on GitHub') && asked.empty?, 'A reply in a thread the agent is in reaches it; no adversary was in it')
  assert(saved.dig('threads', KEY, 'gh-101', 'live') && saved.dig('threads', KEY, 'gh-101', 'delivery') == 'sent', 'Its thread is live, so the reader\'s follow-ups reach the agent')
  puts 'PASS replies join their thread; the agent gets each person\'s review as one message, then the replies'

  # Looking again adds nothing twice.
  before = state.read
  take.()
  after = state.read
  assert(after['outbox'].length == before['outbox'].length && after['comments'][KEY].length == 4 && after.dig('threads', KEY, 'gh-101', 'messages').length == 2, 'Nothing is taken in twice')

  # The reader answered Jane on GitHub from the review; her answer to that re-opens the box, and reaches the adversaries in the thread.
  state.github_posted(KEY, {'gh-101' => {'url' => 'https://github.com/acme/web/pull/7#discussion_r107', 'where' => 'reply'}})
  state.update { |data| data['threads'][KEY]['gh-101']['adversary'] = 'codex' }
  fixture["GET repos/acme/web/pulls/7/comments#{PAGE}"] += [line.(107, 'reviewer', 'Fixed in the next push.', reply_to: 101, at: '2026-10-20T12:00:00Z'),
                                                          line.(108, 'jane', 'Thanks! Can we test it?', reply_to: 101, at: '2026-10-20T12:10:00Z')]
  File.write(fixture_path, JSON.generate(fixture))
  take.()
  later = state.read
  said = later.dig('threads', KEY, 'gh-101', 'messages').map { |message| message['body'] }
  assert(said.last(2) == ['Fixed in the next push.', 'Thanks! Can we test it?'], "The reader's reply from the review comes back in order, then Jane's: #{said}")
  assert(!later.dig('github', KEY, 'posted').key?('gh-101'), 'A new answer from Jane lets the reader reply again')
  assert(asked.length == 1 && asked[0][1] == 'gh-101' && asked[0][2].include?('@jane (a teammate, on GitHub) now says:'), "The thread's adversaries hear her too: #{asked}")
  puts 'PASS looking again adds nothing twice; a teammate\'s answer reaches the agent and the thread\'s adversaries, and lets the reader reply again'

  # --- the reader's answer goes under the teammate's comment ------------------------------------
  File.delete(log)
  code, result = api.call('POST', '/api/github/comment', -> { JSON.generate('key' => KEY, 'item' => {'id' => 'gh-101', 'body' => 'Yes, adding one.', 'general' => false, 'path' => 'app/a.rb', 'side' => 'RIGHT', 'line' => 2, 'start_line' => 2}) })
  posts = calls.().select { |call| call['method'] == 'POST' }
  assert(code == 200 && result.dig('posted', 'gh-101', 'where') == 'reply', "Comment now on a teammate's comment replies: #{result}")
  assert(posts.map { |call| [call['path'], call['input']] } == [['repos/acme/web/pulls/7/comments/101/replies', {'body' => 'Yes, adding one.'}]], "It goes under their comment: #{posts}")
  File.delete(log)
  code, result = api.call('POST', '/api/github/review', -> { JSON.generate('key' => KEY, 'event' => 'APPROVE', 'body' => '', 'items' => [{'id' => 'gh-102', 'body' => 'It keeps the old path working.', 'general' => true}]) })
  posts = calls.().select { |call| call['method'] == 'POST' }
  assert(code == 200 && posts.map { |call| call['path'] } == %w[repos/acme/web/pulls/7/comments/102/replies repos/acme/web/pulls/7/reviews], "With Finish your review it is a reply, and the approval still goes: #{posts}")
  assert(posts.last['input']['comments'] == [] && posts.last['input']['event'] == 'APPROVE' && result['posted'].key?('gh-102'), 'The review holds no copy of the reply')
  puts 'PASS the reader\'s answer to a teammate goes under their comment on GitHub, also with Finish your review'

  # --- the report counts the agents' comments; a teammate's must still be settled ---------------
  key, shot, kept, data = DCR::ReviewReport.latest(series)
  facts = DCR::ReviewReport.facts(shot, kept, data, key)
  assert(facts['comments']['total'] == 1 && facts['open'].include?('gh-101'), "Teammates' comments are not the review's, but are open until resolved: #{facts.slice('comments', 'open')}")
  puts 'PASS the report counts the review\'s own comments, and a teammate\'s waits to be settled'
end
