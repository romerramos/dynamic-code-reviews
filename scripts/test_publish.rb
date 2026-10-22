# frozen_string_literal: true
# Run with ruby scripts/test_publish.rb. Stdlib only; a stand-in `gh` records every call, so nothing
# reaches GitHub.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings
require 'json'
require 'fileutils'
require_relative '../lib/dcr/github'
require_relative '../lib/dcr/live_api'
require_relative '../lib/dcr/review_report'

def assert(condition, message)
  raise message unless condition
end

HEAD = 'b' * 40
FP = 'abc123'
KEY = "dynamic-review:#{FP}:feature:1"

FAKE_GH = <<~'RUBY'
  require 'json'
  args = ARGV.dup
  args.shift # api
  method = args[args.index('--method') + 1]
  path = args.find { |arg| arg.start_with?('repos/', 'user') }
  input = args.include?('--input') ? JSON.parse($stdin.read) : nil
  File.open(ENV.fetch('GH_LOG'), 'a') { |log| log.puts(JSON.generate('method' => method, 'path' => path, 'input' => input)) }
  fail_with = ->(code, message) { puts JSON.generate('message' => message); warn "gh: #{message} (HTTP #{code})"; exit 1 }
  case [method, path]
  when %w[GET user] then puts JSON.generate('login' => 'reviewer')
  when ['GET', 'repos/acme/web/pulls/7'] then puts JSON.generate('head' => {'sha' => ENV.fetch('GH_HEAD')}, 'user' => {'login' => 'author'}, 'state' => 'open')
  when ['POST', 'repos/acme/web/issues/7/comments'] then puts JSON.generate('id' => 11, 'html_url' => 'https://github.com/acme/web/pull/7#issuecomment-11')
  when ['PATCH', 'repos/acme/web/issues/comments/11'] then puts JSON.generate('id' => 11, 'html_url' => 'https://github.com/acme/web/pull/7#issuecomment-11')
  when ['POST', "repos/acme/web/statuses/#{'b' * 40}"]
    fail_with.(403, 'Resource not accessible by integration') if ENV['GH_NO_STATUS']
    puts '{}'
  else fail_with.(404, 'Not Found')
  end
RUBY

Dir.mktmpdir('dcr-publish-test') do |directory|
  series = File.join(directory, 'series')
  FileUtils.mkdir_p(File.join(series, 'revisions'))
  snapshot = {'mode' => 'pr', 'base' => 'a' * 40, 'head' => HEAD, 'fingerprint' => FP,
              'files' => %w[app/a.rb app/b.rb README.md].map { |path| {'path' => path, 'hunks' => [{'old_start' => 1, 'old_count' => 1, 'new_start' => 1, 'new_count' => 2, 'patch' => "@@ -1 +1,2 @@\n x\n+y\n"}]} }}
  comments = [{'id' => 'c1', 'label' => 'issue', 'subject' => 'Leaks the token', 'agent' => 'claude', 'hunk' => 'f1h1'},
              {'id' => 'c2', 'label' => 'suggestion', 'subject' => 'Rename it', 'agent' => 'claude', 'hunk' => 'f2h1'},
              {'id' => 'c3', 'label' => 'praise', 'subject' => 'Nice test', 'agent' => 'claude', 'hunk' => 'f3h1'}]
  review = {'comments' => comments, 'comparison' => {'base' => 'a' * 40, 'head' => HEAD, 'pr_url' => 'https://github.com/acme/web/pull/7'}}
  File.write(File.join(series, 'revisions', '001.html'), %(<html><script type="application/json" id="data">#{JSON.generate('snapshot' => snapshot, 'review' => review)}</script></html>))
  File.write(File.join(series, 'manifest.json'), JSON.generate('name' => 'feature', 'revisions' => [{'number' => 1, 'fingerprint' => FP}]))

  question = 'Why does this need the token at all? I never understood that part.'
  state = DCR::State.new(series)
  state.update do |saved|
    saved['blobs'][KEY] = {'viewedFiles' => %w[app/a.rb app/b.rb README.md], 'resolvedComments' => %w[c1 c2 c3]}
    saved['verdicts'][FP] = {'status' => 'ready', 'verdict' => 'human', 'files' => {'app/a.rb' => 'human', 'app/b.rb' => 'llm', 'README.md' => 'none'}}
    saved['threads'][KEY] = {'c1' => {'messages' => [
      {'author' => 'agent', 'agent' => 'codex', 'role' => 'adversary', 'verdict' => 'disagree', 'body' => 'Not a leak.'},
      {'author' => 'user', 'body' => question},
      {'author' => 'agent', 'agent' => 'claude', 'body' => 'It signs the request.'}
    ], 'fix' => {'state' => 'done'}}}
  end

  # --- what the report says --------------------------------------------------------------------
  key, shot, said, saved = DCR::ReviewReport.latest(series)
  facts = DCR::ReviewReport.facts(shot, said, saved, key)
  assert(key == KEY, "The latest revision's key is wrong: #{key}")
  assert(facts['files'] == {'total' => 3, 'yours' => 1, 'read' => 1, 'viewed' => 3}, "Files are counted wrong: #{facts['files']}")
  assert(facts['agents'] == %w[Claude Codex], "Agents are wrong: #{facts['agents']}")
  assert(facts['comments'] == {'total' => 2, 'fixed' => 1, 'kept' => 1, 'open' => 0, 'quiet' => {'praise' => 1}, 'challenged' => 1}, "Comments are counted wrong: #{facts['comments']}")
  assert(facts['conversations'] == 1 && facts['left'].empty? && facts['open'].empty?, "Done is not done: #{facts}")
  text = DCR::ReviewReport.markdown(facts, login: 'reviewer')
  assert(text.start_with?(DCR::ReviewReport::MARK) && text.include?("[Dynamic Code Reviews](#{DCR::ReviewReport::HOME})") && text.include?("[JevMyPR](#{DCR::ReviewReport::JEVMYPR})"), "The report lacks its mark or links:\n#{text}")
  assert(text.include?('1 needed a person, read by @reviewer') && text.include?('**2 agents** (Claude, Codex)') && text.include?('1 challenged by an adversary') && text.include?('**1 fixed** · 1 resolved as they were · 0 open') && text.include?('**1 conversation** with a person in the loop'), "The report says the wrong thing:\n#{text}")
  assert(!text.include?(question) && !text.include?('Leaks the token') && !text.include?('Not a leak'), "Nothing anyone wrote may reach the report:\n#{text}")
  assert(text.include?('- **3 files** · ') && !text.include?('revision'), "A review of one revision counted it:\n#{text}")
  assert(text.lines.length <= 8, "The report must stay short:\n#{text}")
  assert(DCR::ReviewReport.markdown(facts.merge('revisions' => 4)).include?('- **3 files** · 4 revisions · '), 'The report does not say how many revisions the review took')
  assert(DCR::ReviewReport.description(facts) == '3 files reviewed · 2 comments settled · 2 agents', "The status line is wrong: #{DCR::ReviewReport.description(facts)}")
  puts 'PASS the report counts files, agents, comments and conversations, and keeps what was said out'

  # Without JevMyPR every file needs the reader; any unresolved comment of the review is open, as the Overview's All clear has it.
  saved['verdicts'] = {}
  saved['blobs'][KEY] = {'viewedFiles' => %w[app/a.rb], 'resolvedComments' => %w[c1]}
  open = DCR::ReviewReport.facts(shot, said, saved, key)
  assert(open['left'] == %w[app/b.rb README.md] && open['open'] == %w[c2 c3], "What is left is wrong: #{open.slice('left', 'open')}")
  assert(DCR::ReviewReport.markdown(open).include?('- **3 files** · 1 read') && !DCR::ReviewReport.markdown(open).include?('JevMyPR'), 'Without a verdict the report says how many files were read, and no JevMyPR')
  # The reader's own questions to the agent are conversations, never something left to resolve.
  saved['blobs'][KEY]['resolvedComments'] = %w[c1 c2 c3]
  saved['blobs'][KEY]['personalComments'] = [{'id' => 'mine-1', 'audience' => 'agent', 'label' => 'question', 'subject' => question}]
  # The comment is what the reader wrote; its thread holds only the answer.
  saved['threads'][KEY]['mine-1'] = {'messages' => [{'author' => 'agent', 'agent' => 'claude', 'body' => 'Because.'}]}
  asked = DCR::ReviewReport.facts(shot, said, saved, key)
  assert(asked['open'].empty? && asked['comments']['total'] == 2 && asked['conversations'] == 2, "A question of the reader's is open, or counted as a comment: #{asked.slice('open', 'comments', 'conversations')}")
  puts 'PASS without a verdict every file needs the reader; unresolved comments are open, the reader\'s own questions never'

  # A review whose only comment is a note: it asks nothing, but the adversaries who disagreed with it in part still count.
  noted = {'comments' => [{'id' => 'n1', 'label' => 'note', 'subject' => 'Safe for every caller', 'agent' => 'claude', 'hunk' => 'f1h1'}]}
  saved['threads'][KEY] = {'n1' => {'messages' => [{'author' => 'agent', 'agent' => 'codex', 'role' => 'adversary', 'verdict' => 'partly', 'body' => 'Mostly.'}],
                                    'opinions' => {'grok' => {'verdict' => 'partly', 'body' => 'Mostly.'}}}}
  note = DCR::ReviewReport.facts(shot, noted, saved, key)
  line = DCR::ReviewReport.markdown(note).lines.find { |entry| entry.include?('agents') }
  assert(note['comments']['challenged'] == 1 && line.include?('**3 agents** (Claude, Codex, Grok) · 1 note · 1 challenged by an adversary') && !line.include?('0 comments'), "A challenged note is missing from the report: #{line}")
  puts 'PASS a note asks nothing, but an adversary challenging it is in the report'

  # --- publishing ------------------------------------------------------------------------------
  log = File.join(directory, 'gh.log')
  gh = File.join(directory, 'gh')
  File.write(gh, "#!#{RbConfig.ruby}\n#{FAKE_GH}")
  File.chmod(0o755, gh)
  ENV['GH_LOG'] = log
  ENV['GH_HEAD'] = HEAD
  calls = -> { File.file?(log) ? File.readlines(log).map { |line| JSON.parse(line) } : [] }
  github = DCR::GitHub.new(series, gh: gh)

  first = github.publish(KEY, text, 'three files', nil)
  posted = calls.().select { |call| call['method'] != 'GET' }
  assert(first == {'id' => 11, 'url' => 'https://github.com/acme/web/pull/7#issuecomment-11', 'head' => HEAD}, "The first publish is wrong: #{first}")
  assert(posted.map { |call| [call['method'], call['path']] } == [['POST', 'repos/acme/web/issues/7/comments'], ['POST', "repos/acme/web/statuses/#{HEAD}"]], "A first publish posts a comment and marks the reviewed commit: #{posted}")
  assert(posted.last['input'] == {'state' => 'success', 'context' => 'dynamic-code-reviews', 'description' => 'three files', 'target_url' => first['url']}, "The status is wrong: #{posted.last}")
  File.delete(log)
  github.publish(KEY, text, 'three files', first)
  assert(calls.().select { |call| call['method'] != 'GET' }.map { |call| call['method'] } == %w[PATCH POST], 'Publishing again updates the same comment')
  File.delete(log)
  github.publish(KEY, text, 'three files', {'id' => 99})
  assert(calls.().map { |call| call['method'] } == %w[GET PATCH POST POST], 'A comment deleted on GitHub is posted again')
  ENV['GH_NO_STATUS'] = '1'
  partly = github.publish(KEY, text, 'three files', first)
  assert(partly['url'] && partly['status_error'].include?('denied'), "A refused status keeps the comment and says why: #{partly}")
  ENV.delete('GH_NO_STATUS')
  ENV['GH_HEAD'] = 'c' * 40
  File.delete(log)
  begin
    github.publish(KEY, text, 'three files', first)
    raise 'A pull request pushed since the review was published'
  rescue DCR::GitHub::Error => error
    assert(error.message.include?('newer push') && calls.().none? { |call| call['method'] != 'GET' }, 'A newer push stops the publish before anything is posted')
  end
  ENV['GH_HEAD'] = HEAD
  puts 'PASS publish posts one comment, updates it in place, marks the reviewed commit, and refuses a newer push'

  # The server publishes only a review that is ready, and says what is left.
  api = DCR::LiveAPI.new(series, github: github)
  code, check = api.call('GET', "/api/publish?key=#{KEY}", nil)
  assert(code == 200 && !check['ready'] && check['steps'].map { |step| step['done'] } == [true, true, false], "The check is wrong: #{check['steps']}")
  File.delete(log) if File.file?(log)
  code, refused = api.call('POST', '/api/publish', -> { JSON.generate('key' => KEY) })
  assert(code == 400 && refused['error'].start_with?('Not ready to publish.') && calls.().none? { |call| call['method'] != 'GET' }, "A review that is not ready is not published: #{refused}")
  code, earlier = api.call('GET', '/api/publish?key=dynamic-review:old:feature:0', nil)
  assert(code == 400 && earlier['error'].include?('earlier revision'), 'Only the latest revision is published')
  puts 'PASS the server refuses a review that is not ready, and says what is left'

  kept = state.github_report(KEY, first.merge('body' => text))
  assert(state.read.dig('github', KEY, 'report') == kept && kept['at'], 'The last publish is kept, to update it next time')
  puts 'PASS the last publish is kept with the review'
end
