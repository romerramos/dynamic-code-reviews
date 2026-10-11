# frozen_string_literal: true
# Run with ruby scripts/test_jevmypr.rb. Stdlib only; JevMyPR is a stand-in, nothing leaves this computer.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings
require 'json'
require_relative '../lib/dcr/live_api'

def assert(condition, message)
  raise message unless condition
end

def wait_for(message)
  60.times { return if yield; sleep 0.05 }
  raise message
end

FP = 'abc123'
KEY = "dynamic-review:#{FP}:feature:1"
FILES = [
  {'id' => 'f1', 'path' => 'README.md', 'patch' => "diff --git a/README.md b/README.md\nindex 1..2 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-teh\n+the\n@@ -9 +9 @@\n-a\n+b\n",
   'hunks' => [{'patch' => "@@ -1 +1 @@\n-teh\n+the\n"}, {'patch' => "@@ -9 +9 @@\n-a\n+b\n"}]},
  {'id' => 'f2', 'path' => 'app/new.rb', 'patch' => "diff --git a/app/new.rb b/app/new.rb\nnew file mode 100644\n--- /dev/null\n+++ b/app/new.rb\n@@ -0,0 +1 @@\n+x = 1\n", 'hunks' => [{'patch' => "@@ -0,0 +1 @@\n+x = 1\n"}]},
  {'id' => 'f3', 'path' => 'lib/b.rb', 'patch' => "diff --git a/lib/a.rb b/lib/b.rb\nsimilarity index 100%\nrename from lib/a.rb\nrename to lib/b.rb\n", 'hunks' => []},
  {'id' => 'f4', 'path' => 'logo.png', 'patch' => "diff --git a/logo.png b/logo.png\ndeleted file mode 100644\nBinary files a/logo.png and /dev/null differ\n", 'hunks' => []}
].freeze

# What is sent: GitHub's shape, hunks only, nothing but the title and the files.
request = DCR::JevMyPR.request(FILES, title: 'Fix typo')
assert(request.keys == %w[title files], "Only the title and the files are sent, got #{request.keys}")
assert(request['files'][0] == {'filename' => 'README.md', 'status' => 'modified', 'patch' => "@@ -1 +1 @@\n-teh\n+the\n@@ -9 +9 @@\n-a\n+b"}, "A patch is the file's hunks without its diff header: #{request['files'][0]}")
assert(request['files'][1].values_at('status', 'patch') == ['added', "@@ -0,0 +1 @@\n+x = 1"], 'A new file is added')
assert(request['files'][2] == {'filename' => 'lib/b.rb', 'status' => 'renamed', 'previous_filename' => 'lib/a.rb'}, "A rename names where it came from: #{request['files'][2]}")
assert(request['files'][3] == {'filename' => 'logo.png', 'status' => 'removed'}, 'A binary file goes without a patch')
big = [{'path' => 'a', 'patch' => '', 'hunks' => [{'patch' => "@@\n#{'+' * 700_000}"}]}, {'path' => 'b', 'patch' => '', 'hunks' => [{'patch' => "@@\n#{'+' * 700_000}"}]}, {'path' => 'c', 'patch' => '', 'hunks' => [{'patch' => "@@\n+1"}]}]
assert(DCR::JevMyPR.request(big)['files'].map { |file| file.key?('patch') } == [true, false, true], 'Patches past the 1 MB JevMyPR takes are left out, later small ones still go')
puts 'request: the title and each file with its hunks, as JevMyPR expects'

# Success, an error response, and no network.
calls = []
answer = {'verdict' => 'human', 'confidence' => 0.8, 'diff_truncated' => false, 'url' => 'https://jevmypr.romerramos.me/verdicts/tok',
          'files' => [{'filename' => 'README.md', 'verdict' => 'none'}, {'filename' => 'app/new.rb', 'verdict' => 'human'}, {'filename' => 'logo.png', 'verdict' => nil, 'skipped' => 'no_patch'}]}
reply = [200, {}, JSON.generate(answer)]
jev = DCR::JevMyPR.new(post: ->(uri, json) { calls << [uri.to_s, JSON.parse(json)]; reply })
ready = jev.ask(request)
assert(calls == [[DCR::JevMyPR::URL, request]], 'One POST to the verdicts endpoint with the request')
assert(ready.values_at('status', 'verdict', 'confidence', 'truncated', 'url') == ['ready', 'human', 0.8, false, answer['url']], "The verdict comes back as the page shows it: #{ready}")
assert(ready['files'] == {'README.md' => 'none', 'app/new.rb' => 'human', 'logo.png' => nil} && ready['skipped'] == {'logo.png' => 'no_patch'}, 'Each file has its verdict, or why it has none')
reply = [200, {}, JSON.generate(answer.merge('url' => 'https://elsewhere.example/x'))]
assert(jev.ask(request)['url'].nil?, 'Only a link to JevMyPR itself is kept')
reply = [200, {}, JSON.generate(answer.merge('url' => nil))]
assert(jev.ask(request).values_at('status', 'url') == ['ready', nil], 'No verdict page yet is fine')

reply = [429, {'Retry-After' => '120'}, JSON.generate('error' => 'rate_limited', 'message' => 'Wait 2 minutes before asking again.')]
limited = jev.ask(request)
assert(limited.values_at('status', 'code', 'message') == ['error', 'rate_limited', 'Wait 2 minutes before asking again.'], "JevMyPR's own message is kept: #{limited}")
assert((Time.parse(limited['retry_at']) - Time.now).between?(100, 125), 'Retry-After says when to ask again')
reply = [502, {}, '<html>Bad gateway</html>']
assert(jev.ask(request).values_at('status', 'code', 'message') == ['error', 'http_502', 'JevMyPR answered 502.'], 'An answer that is not JSON is still an error the page can show')
reply = [200, {}, JSON.generate('verdict' => 'maybe')]
assert(jev.ask(request)['status'] == 'error', 'An unknown verdict is not a verdict')
[SocketError.new('getaddrinfo'), Errno::ECONNREFUSED.new, Net::ReadTimeout.new, OpenSSL::SSL::SSLError.new('x')].each do |failure|
  down = DCR::JevMyPR.new(post: ->(*) { raise failure }).ask(request)
  assert(down.values_at('status', 'code') == %w[error unreachable] && down['message'].start_with?('JevMyPR could not be reached'), "No network must be an error to show, not a crash: #{failure.class}")
end
puts 'ask: a verdict, JevMyPR saying no, and no network all come back as something to show'

# The server: nothing is sent until the reviewer turns it on, for this repository only.
Dir.mktmpdir('dcr-jev-test') do |directory|
  series = File.join(directory, 'repo', '.reviews', 'feature')
  FileUtils.mkdir_p(File.join(series, 'revisions'))
  repo = File.join(directory, 'repo')
  File.write(File.join(series, 'manifest.json'), JSON.generate('name' => 'feature', 'repo' => repo, 'revisions' => [{'number' => 1, 'fingerprint' => FP, 'title' => 'Fix typo'}]))
  File.write(File.join(series, 'revisions', '001.html'), %(<html><body><script type="application/json" id="data">#{JSON.generate('snapshot' => {'files' => FILES}, 'review' => {})}</script></body></html>))
  settings = DCR::Settings.new(File.join(directory, 'config'))
  sent = []
  reply = [200, {}, JSON.generate(answer)]
  api = DCR::LiveAPI.new(series, settings: settings, jevmypr: DCR::JevMyPR.new(post: ->(_uri, json) { sent << JSON.parse(json); reply }))
  post = ->(input) { api.call('POST', '/api/verdict', -> { JSON.generate(input) }) }
  verdict = -> { api.call('GET', "/api/state?key=#{KEY}", nil)[1]['verdict'] }

  code, opened = post.({'key' => KEY})
  assert(code == 200 && opened == {'enabled' => nil, 'host' => 'jevmypr.romerramos.me', 'verdict' => nil}, "Opening a review before answering asks nothing: #{opened}")
  post.({'key' => KEY, 'again' => true})
  sleep 0.1
  assert(sent.empty? && verdict.call.nil?, 'Nothing may be sent before the reviewer turned it on')
  assert(post.({'key' => KEY, 'enabled' => false})[1]['enabled'] == false && post.({'key' => KEY})[1]['verdict'].nil?, 'No is remembered')
  sleep 0.1
  assert(sent.empty?, 'Nothing may be sent after a no')

  _, on = post.({'key' => KEY, 'enabled' => true})
  assert(on['enabled'] == true && on['verdict']['status'] == 'asking', "Turning it on asks at once: #{on}")
  wait_for('The verdict never arrived') { verdict.call&.fetch('status') == 'ready' }
  assert(sent == [request], "The revision's diff and title are what is sent: #{sent}")
  assert(verdict.call.values_at('verdict', 'confidence') == ['human', 0.8], 'Every open page gets the verdict with the state')
  post.({'key' => KEY})
  post.({'key' => "dynamic-review:#{FP}:feature:2"})
  sleep 0.1
  assert(sent.length == 1, 'A diff that has its verdict is not sent again, in any revision of the same code')
  assert(DCR::Settings.new(File.join(directory, 'config')).jevmypr(repo) == true, 'The choice survives a restart')
  assert(settings.jevmypr(File.join(directory, 'other')).nil?, 'Yes for one repository is not yes for another')
  settings.write('theme' => 'aida'); settings.save_adversaries([])
  assert(settings.jevmypr(repo) == true, 'Other settings keep the choice')

  # JevMyPR says no: the page gets its message, and the wait is respected.
  other = "dynamic-review:def456:feature:1"
  File.write(File.join(series, 'manifest.json'), JSON.generate('name' => 'feature', 'repo' => repo, 'revisions' => [{'number' => 1, 'fingerprint' => 'def456', 'title' => 'Other'}]))
  reply = [429, {'retry-after' => '120'}, JSON.generate('error' => 'rate_limited', 'message' => 'Wait 2 minutes.')]
  post.({'key' => other})
  state = -> { api.call('GET', "/api/state?key=#{other}", nil)[1]['verdict'] }
  wait_for('The refusal never arrived') { state.call&.fetch('status') == 'error' }
  assert(state.call['message'] == 'Wait 2 minutes.', 'The page shows what JevMyPR said')
  post.({'key' => other, 'again' => true})
  sleep 0.1
  assert(sent.length == 2, 'Try again waits until JevMyPR allows another call')
  api.state.save_verdict('def456', state.call.merge('retry_at' => (Time.now - 1).utc.iso8601))
  reply = [200, {}, JSON.generate(answer.merge('verdict' => 'none'))]
  post.({'key' => other})
  wait_for('The retry never answered') { state.call&.fetch('status') == 'ready' }
  assert(sent.length == 3 && state.call['verdict'] == 'none', 'Once the wait is over, opening the review asks again')

  code, bad = post.({'key' => 'bad key!'})
  assert(code == 400 && bad['error'].include?('Invalid review key'), 'A bad key is refused')
end
puts 'server: nothing is sent until turned on for the repository; one request per diff; errors reach the page'
