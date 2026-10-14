# frozen_string_literal: true
# Run with ruby scripts/test_github.rb. Stdlib only; a stand-in `gh` records every call, so nothing
# reaches GitHub.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings, adversaries or notes
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
  when %w[GET user] then puts JSON.generate('login' => 'reviewer', 'name' => 'Rae Viewer', 'avatar_url' => 'https://avatars.githubusercontent.com/u/1?v=4')
  when ['GET', 'repos/acme/web/pulls/7'] then puts JSON.generate('user' => {'login' => 'author'}, 'state' => 'open', 'merged_at' => nil)
  when ['POST', 'repos/acme/web/pulls/7/comments']
    fail_with.(422, 'Validation Failed') if input['line'] == 12 && !input['subject_type'] # GitHub's diff is narrower
    puts JSON.generate('html_url' => "https://github.com/acme/web/pull/7#discussion_r#{input['line'] || 'file'}")
  when ['DELETE', 'repos/acme/web/pulls/comments/13'] then puts '{}'
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
  assert(status == {'ready' => true, 'login' => 'reviewer', 'repo' => 'acme/web', 'number' => 7, 'url' => 'https://github.com/acme/web/pull/7', 'author' => 'author', 'state' => 'open', 'unpushed' => []}, "Status is wrong: #{status}")
  github.status(KEY)
  assert(calls.().length == 2, 'Status must be cached, not asked again at once')
  puts 'PASS status says who posts where, read from the saved revision and cached'

  asked = []
  faces = DCR::GitHub.new(File.join(directory, 'no-review'), gh: gh, avatar: ->(url) { asked << url; ['image/png', 'PNG'] })
  assert(faces.me == {'login' => 'reviewer', 'avatar' => 'data:image/png;base64,UE5H'} && faces.me && asked.length == 1, "The reader's avatar is wrong or asked twice: #{faces.me}")
  ENV['GH_SIGNED_OUT'] = '1'
  signed_out = DCR::GitHub.new(series, gh: gh, avatar: ->(_) { raise 'not asked' }).me
  ENV.delete('GH_SIGNED_OUT')
  assert(signed_out == {}, 'Signed out, there is no avatar to show')
  puts "PASS the reader's avatar needs no pull request, is asked once, and is nothing when signed out"

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

  # Taking a posted comment back: deleted on GitHub first, and one already gone there counts.
  ENV['GH_SIGNED_OUT'] = '1'
  code, kept = api.call('POST', '/api/github/delete', body.({'key' => KEY, 'id' => 'mine-9'}))
  ENV.delete('GH_SIGNED_OUT')
  assert(code == 502 && kept['error'].include?('gh auth login') && api.call('GET', "/api/state?key=#{KEY}", nil)[1].dig('github', 'posted').key?('mine-9'), 'A comment GitHub would not delete must stay posted here')
  code, gone = api.call('POST', '/api/github/delete', body.({'key' => KEY, 'id' => 'mine-9'}))
  assert(code == 200 && gone['deleted'] && !gone.key?('gone') && !gone['posted'].key?('mine-9'), 'A deleted comment is still held as posted')
  assert(calls.().last.values_at('method', 'path') == ['DELETE', 'repos/acme/web/pulls/comments/13'], 'The comment was not deleted on GitHub by its own id')
  api.call('POST', '/api/github/comment', body.({'key' => KEY, 'item' => item.merge('id' => 'mine-12', 'line' => 14)}))
  code, already = api.call('POST', '/api/github/delete', body.({'key' => KEY, 'id' => 'mine-12'}))
  assert(code == 200 && already['gone'] == true && !already['posted'].key?('mine-12'), 'A comment already gone from GitHub must count as deleted')
  code, inside = api.call('POST', '/api/github/delete', body.({'key' => KEY, 'id' => 'mine-10'}))
  assert(code == 502 && inside['error'].include?('inside the text of your review'), 'A comment in a review\'s text has nothing of its own to delete')
  assert(api.call('POST', '/api/github/delete', body.({'key' => KEY, 'id' => 'never'}))[0] == 400, 'A comment that was never posted was deleted')
  puts 'PASS a posted comment is taken back from GitHub, and one already gone there counts as taken back'
end

# A comment is rewritten in the reviewer's voice before it goes anywhere, and the text they approve is kept.
Dir.mktmpdir('dcr-github-draft-') do |root|
  series = File.join(root, 'series')
  FileUtils.mkdir_p(series)
  body = ->(value) { -> { JSON.generate(value) } }
  settings = DCR::Settings.new(File.join(root, 'config'))
  asked = []
  writer = lambda do |**given|
    asked << given
    given[:voice].include?('fail') ? raise(ArgumentError, 'Claude took longer than 2 minutes') : ['I think this may subtract the discount twice, what do you think? 🙂', 'claude']
  end
  api = DCR::LiveAPI.new(series, settings: settings, github: DCR::GitHub.new(series, gh: 'none'), draft: writer)
  state = DCR::State.new(series)
  state.update { |data| (data['threads'][KEY] = {})['c1'] = {'delivery' => 'draft', 'live' => false, 'messages' => [], 'opinions' => {'codex' => {'body' => 'It only runs once per render.'}}} }
  assert(api.call('GET', '/api/github/voice', nil)[1] == {'voice' => DCR::GitHubDraft::DEFAULT_VOICE, 'custom' => false, 'emojis' => DCR::GitHubDraft::DEFAULT_EMOJIS}, 'The default voice is not offered')
  code, started = api.call('POST', '/api/github/draft', body.({'key' => KEY, 'id' => 'c1', 'context' => 'issue (blocking): the discount is taken off twice'}))
  assert(code == 200 && started['status'] == 'writing', 'A draft must start as being written')
  sleep 0.05 until state.read.dig('github', KEY, 'drafts', 'c1', 'status') != 'writing'
  draft = api.call('GET', "/api/state?key=#{KEY}", nil)[1].dig('github', 'drafts', 'c1')
  assert(draft.values_at('status', 'agent') == %w[ready claude] && draft['body'].include?('what do you think?'), 'The page was not given the rewrite')
  assert(asked.first[:opinions] == [{'agent' => 'codex', 'body' => 'It only runs once per render.'}] && asked.first[:voice] == DCR::GitHubDraft::DEFAULT_VOICE, 'The writer was not given the voice and the other opinions')
  made = DCR::GitHubDraft.prompt(voice: 'Short and kind.', context: 'the comment', opinions: asked.first[:opinions])
  assert(made.include?('Short and kind.') && made.include?('Codex: It only runs once per render.') && made.include?('Never mention AI') && made.include?('Say nothing about how the point was found or checked'), 'The prompt lost the voice, the opinions or its rules')
  tried = []
  answer = ->(agent, _prompt, **) { tried << agent; agent == 'codex' ? raise(ArgumentError, 'Codex did not answer') : 'Written.' }
  wrote = DCR::GitHubDraft.write(context: 'c', opinions: [], voice: 'v', author: 'codex', adversaries: [{'agent' => 'codex', 'model' => 'x'}, {'agent' => 'claude'}], repo: root, ask: answer, installed: ->(_) { true })
  assert(wrote == ['Written.', 'claude'] && tried == %w[codex claude], 'An agent that cannot answer did not hand over to the next')
  assert(DCR::GitHubDraft.tidy("```\n\"Hello there\"\n```") == 'Hello there' && DCR::GitHubDraft.tidy('He said "no" twice') == 'He said "no" twice', 'A wrapped answer was not unwrapped')
  assert(api.call('POST', '/api/github/voice', body.({'voice' => 'Make it fail.', 'emojis' => ' 😅 🙏 '}))[1] == {'voice' => 'Make it fail.', 'custom' => true, 'emojis' => '😅 🙏'} && settings.github_voice == 'Make it fail.', 'The voice was not saved')
  assert(DCR::GitHubDraft.prompt(voice: 'v', context: 'c', emojis: '😅 🙏').include?('only these, which are the ones I use: 😅 🙏') && DCR::GitHubDraft.prompt(voice: 'v', context: 'c', emojis: '').include?('- No emojis at all.'), 'The prompt does not keep to the reviewer\'s emojis')
  api.call('POST', '/api/github/draft', body.({'key' => KEY, 'id' => 'c1', 'context' => 'again'}))
  sleep 0.05 until state.read.dig('github', KEY, 'drafts', 'c1', 'status') != 'writing'
  assert(state.read.dig('github', KEY, 'drafts', 'c1').values_at('status', 'error') == ['failed', 'Claude took longer than 2 minutes'], 'A failed rewrite must say why')
  assert(api.call('POST', '/api/github/voice', body.({'voice' => ' ', 'emojis' => ''}))[1].values_at('custom', 'emojis') == [false, ''], 'A blank voice must go back to the default, and no emojis must stay none')
  # Saving the dialog without changing its text is not a voice of one's own: it follows the default
  # as it changes. And a rewrite says which instructions it was written under.
  api.call('POST', '/api/github/voice', body.({'voice' => DCR::GitHubDraft::FORMER_VOICES.first, 'emojis' => '🤔'}))
  assert(settings.github_voice.nil? && api.call('GET', '/api/github/voice', nil)[1].values_at('voice', 'custom', 'emojis') == [DCR::GitHubDraft::DEFAULT_VOICE, false, '🤔'], 'A saved copy of an earlier default was kept as a voice')
  File.write(settings.path, JSON.generate('githubVoice' => DCR::GitHubDraft::FORMER_VOICES.first))
  assert(api.call('GET', '/api/github/voice', nil)[1]['voice'] == DCR::GitHubDraft::DEFAULT_VOICE, 'An earlier default already in the settings still decides the voice')
  under = api.call('GET', "/api/state?key=#{KEY}", nil)[1].dig('github', 'voice')
  api.call('POST', '/api/github/draft', body.({'key' => KEY, 'id' => 'c2', 'context' => 'a comment'}))
  sleep 0.05 until state.read.dig('github', KEY, 'drafts', 'c2', 'status') != 'writing'
  assert(state.read.dig('github', KEY, 'drafts', 'c2', 'voice') == under && under.match?(/\A\h{12}\z/), 'A rewrite does not say which voice it was written under')
  api.call('POST', '/api/github/voice', body.({'voice' => 'Only questions.', 'emojis' => ''}))
  assert(api.call('GET', "/api/state?key=#{KEY}", nil)[1].dig('github', 'voice') != under, 'A changed voice must make earlier rewrites stale')

  # What the reviewer approved waits with the pending comment, and goes when it is taken off.
  kept = api.call('POST', '/api/github/pending', body.({'key' => KEY, 'id' => 'c1', 'pending' => true, 'body' => 'My own words'}))[1]
  assert(kept['bodies'] == {'c1' => 'My own words'} && kept['pending'].key?('c1'), 'The approved text was not kept with the pending comment')
  assert(api.call('POST', '/api/github/pending', body.({'key' => KEY, 'id' => 'c1', 'pending' => false}))[1]['bodies'].empty?, 'The approved text outlived its pending comment')
  puts 'PASS a comment is rewritten in the reviewer\'s voice in the background, and the text they approve is kept'
end
