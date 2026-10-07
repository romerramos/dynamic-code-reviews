# frozen_string_literal: true
# Run with ruby scripts/test_live.rb. Stdlib only; starts a loopback server in a temp directory.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config') # never touch the real user settings
require 'open3'
require 'rbconfig'
require_relative 'qa_capture'
require_relative '../lib/dcr/state'

def assert(condition, message)
  raise message unless condition
end

KEY = 'dynamic-review:abc123:feature:2'

Dir.mktmpdir('dcr-live-test') do |directory|
  series = File.join(directory, 'series')
  FileUtils.mkdir_p(series)
  File.write(File.join(series, 'current.html'), %(<html><body><script type="application/json" id="data">{}</script><script>var app=1</script></body></html>))
  state = DCR::State.new(series)

  # Thread and queue semantics, with no server involved.
  state.send_items(KEY, [{'id' => 'c1', 'text' => 'first question'}])
  assert(state.pending.length == 1 && state.pending.first['text'] == 'first question', 'Sent comment was not queued')
  assert(state.read.dig('threads', KEY, 'c1').values_at('delivery', 'live') == ['sent', true], 'Sending must make the thread live')
  state.user_message(KEY, 'c1', 'and one more thing')
  assert(state.pending.length == 2 && state.pending.last['text'].include?('Follow-up in thread c1'), 'Live thread follow-up was not queued')
  state.user_message(KEY, 'c2', 'a private draft note')
  assert(state.pending.length == 2 && state.read.dig('threads', KEY, 'c2', 'delivery') == 'draft', 'A draft thread must not reach the agent')
  state.ack(state.pending.first['seq'])
  assert(state.pending.length == 1 && state.read.dig('threads', KEY, 'c1', 'delivery') == 'delivered', 'Ack must leave the later message queued and mark delivery')
  reply = state.agent_reply('c1', 'Fixed in app/a.rb')
  assert(reply['author'] == 'agent' && state.read.dig('threads', KEY, 'c1', 'delivery') == 'answered', 'Agent reply was not recorded on the thread')
  begin
    state.agent_reply('missing', 'x')
    assert(false, 'Reply to an unknown thread was accepted')
  rescue ArgumentError => error
    assert(error.message.include?('No thread missing'), 'Unhelpful unknown thread error')
  end
  [[:agent_reply, ['c1', '  ']], [:user_message, [KEY, 'bad id!', 'x']], [:save_blob, ['bad key!', {}]]].each do |method, args|
    begin
      state.public_send(method, *args)
      assert(false, "#{method} accepted invalid input")
    rescue ArgumentError
      nil
    end
  end
  assert(File.stat(state.path).mode & 0o777 == 0o600, 'State file is readable by others')
  puts 'PASS threads go live when sent, drafts stay private, acknowledgement redelivers nothing twice and agent replies attach'

  # A revision of the same code keeps progress and threads; a different snapshot starts fresh.
  carry = DCR::State.new(File.join(directory, 'carry'))
  fp = 'a' * 64
  carry.save_blob("dynamic-review:#{fp}:feat:1", {'resolvedComments' => ['c1']})
  carry.send_items("dynamic-review:#{fp}:feat:1", [{'id' => 'c1', 'text' => 'x'}])
  revisions = [{'number' => 1, 'fingerprint' => fp}, {'number' => 2, 'fingerprint' => fp}, {'number' => 3, 'fingerprint' => 'b' * 64}]
  carry.carry_forward('feat', revisions)
  carried = carry.read
  assert(carried['blobs']["dynamic-review:#{fp}:feat:2"] == {'resolvedComments' => ['c1']}, 'Progress was not carried to the same-code revision')
  assert(carried['threads']["dynamic-review:#{fp}:feat:2"]['c1']['live'] == true, 'Threads were not carried to the same-code revision')
  assert(carried['blobs'].keys.none? { |name| name.include?(':feat:3') } && carried['threads'].keys.none? { |name| name.include?(':feat:3') }, 'A different snapshot must not inherit progress')
  carry.agent_reply('c1', 'answer')
  assert(carry.read.dig('threads', "dynamic-review:#{fp}:feat:2", 'c1', 'messages').last['body'] == 'answer' && carry.read.dig('threads', "dynamic-review:#{fp}:feat:1", 'c1', 'messages').empty?, 'A reply must land on the newest revision that has the thread')
  rev_before = carry.read['rev']
  carry.carry_forward('feat', revisions)
  assert(carry.read['rev'] == rev_before, 'Carrying forward twice must change nothing')
  puts 'PASS progress and threads carry to a same-code revision and never to a different snapshot'

  # Two writers share the file without losing updates.
  writers = 8.times.map { |index| Thread.new { 5.times { |n| state.user_message(KEY, 'c3', "m#{index}-#{n}") } } }
  writers.each(&:join)
  assert(state.read.dig('threads', KEY, 'c3', 'messages').length == 40, 'Concurrent writers lost a message')
  puts 'PASS concurrent writers do not lose messages'

  # The agent's terminal commands, run as real processes against a separate series.
  dcr = File.expand_path('../bin/dcr', __dir__)
  run = ->(*args) { Open3.capture3(RbConfig.ruby, dcr, *args) }
  agent_dir = File.join(directory, 'agent-series')
  agent_state = DCR::State.new(agent_dir)
  out, _err, status = run.call('wait', '--dir', agent_dir, '--timeout', '1')
  assert(status.success? && out.include?('Timed out'), 'An idle wait did not time out cleanly')
  waiter = Thread.new { run.call('wait', '--dir', agent_dir, '--timeout', '20') }
  sleep 1
  started = Time.now
  agent_state.send_items(KEY, [{'id' => 'c9', 'text' => "File: app/a.rb\n\nWhy is this bounded?"}])
  out, _err, status = waiter.value
  assert(status.success? && Time.now - started < 5, 'A blocked wait did not return when the reviewer sent')
  assert(out.include?('Thread: c9') && out.include?('Why is this bounded?') && out.include?("dcr reply --dir #{agent_dir}"), 'Wait output is missing the thread, its text or the reply command')
  assert(agent_state.pending.empty?, 'Wait did not acknowledge what it printed')
  out, _err, status = run.call('reply', '--dir', agent_dir, 'c9', 'Because', 'it', 'is', 'capped')
  assert(status.success? && agent_state.read.dig('threads', KEY, 'c9', 'messages').last['body'] == 'Because it is capped', 'Reply was not stored')
  out, = run.call('comments', '--dir', agent_dir)
  assert(out.include?('c9 [answered, live]') && out.include?('agent: Because it is capped'), 'Comments listing is wrong')
  _out, err, status = run.call('reply', '--dir', agent_dir, 'nope', 'text')
  assert(!status.success? && err.include?('No thread nope'), 'Reply to an unknown thread did not fail clearly')
  agent_state.finish(KEY)
  out, = run.call('wait', '--dir', agent_dir, '--timeout', '2')
  assert(out.include?('finished this round'), 'Finish was not reported')
  puts 'PASS dcr wait blocks until the reviewer sends, prints thread and reply command, acknowledges, and dcr reply/comments round-trip'

  FileUtils.rm_f(state.path)
  server = QACapture::Server.new(directory: File.join(directory, 'capture'), report: File.join(series, 'current.html'))
  Thread.new { server.run }
  request = lambda do |method, path, body = '', extra = {}|
    socket = TCPSocket.new('127.0.0.1', server.port)
    headers = {'Host' => "127.0.0.1:#{server.port}", 'Content-Length' => body.bytesize.to_s, 'Origin' => server.url, 'X-QA-Token' => server.token}.merge(extra).compact
    socket.write("#{method} #{path} HTTP/1.1\r\n#{headers.map { |key, value| "#{key}: #{value}" }.join("\r\n")}\r\n\r\n#{body}")
    socket.close_write
    response = +''
    begin
      loop { response << socket.readpartial(65_536) }
    rescue EOFError, Errno::ECONNRESET
      nil
    end
    socket.close
    response
  end
  json = ->(response) { JSON.parse(response.split("\r\n\r\n", 2).last) }
  begin
    [{'X-QA-Token' => 'wrong'}, {'X-QA-Token' => nil}, {'Origin' => 'https://evil.example'}, {'Host' => 'evil.example'}].each do |extra|
      assert(request.call('GET', "/api/state?key=#{KEY}", '', extra).start_with?('HTTP/1.1 400'), "Unsafe API read accepted: #{extra}")
    end
    assert(request.call('POST', '/api/send', JSON.generate(key: KEY, items: [{id: 'c1', text: 'x'}]), 'Origin' => 'https://evil.example').start_with?('HTTP/1.1 400'), 'Cross-origin send accepted')
    assert(request.call('POST', '/api/send', '{"key":"bad key!","items":[{"id":"c1","text":"x"}]}').start_with?('HTTP/1.1 400'), 'Invalid key accepted')
    assert(request.call('PUT', '/api/state', '{}').start_with?('HTTP/1.1 400'), 'PUT accepted')
    assert(!File.exist?(state.path), 'Rejected requests wrote state')
    puts 'PASS the conversation API rejects a wrong token, a foreign origin or host, invalid keys and unsupported methods'

    blob = {'viewedFiles' => ['a.rb'], 'personalComments' => [{'id' => 'mine-1', 'subject' => 'x'}]}
    assert(request.call('POST', '/api/state', JSON.generate(key: KEY, blob: blob)).start_with?('HTTP/1.1 200'), 'Progress was not saved')
    page = request.call('GET', '/')
    assert(page.include?('localStorage.setItem') && page.include?('mine-1'), 'Saved progress is not seeded into the page')
    assert(page.index('mine-1') < page.index('id="data"'), 'Progress must be seeded before the review data and script')
    assert(page.include?('/live.js'), 'Live script is not loaded')
    assert(!File.read(File.join(series, 'current.html')).include?('mine-1'), 'The saved report file was modified')
    puts 'PASS saved progress is seeded before the review script and the report file stays unchanged'

    assert(json.call(request.call('GET', '/api/settings')) == {}, 'Fresh settings should be empty')
    saved = json.call(request.call('POST', '/api/settings', JSON.generate('colorMode' => 'dark', 'syntaxTheme' => 'github', 'ignoreWhitespace' => true, 'evil' => 'x', 'theme' => '<script>')))
    assert(saved == {'colorMode' => 'dark', 'syntaxTheme' => 'github', 'ignoreWhitespace' => true}, 'Unknown settings keys must be dropped')
    assert(request.call('POST', '/api/settings', JSON.generate('colorMode' => 'neon')).start_with?('HTTP/1.1 200') && json.call(request.call('GET', '/api/settings'))['colorMode'] == 'dark', 'An invalid value must not replace a valid one')
    assert(File.stat(File.join(ENV['DCR_CONFIG_DIR'], 'settings.json')).mode & 0o777 == 0o600, 'Settings file is readable by others')
    assert(request.call('GET', '/').include?('dynamic-review:settings') , 'Saved settings are not seeded into the page')
    assert(request.call('POST', '/api/settings', '{"colorMode":"light"}', 'Origin' => 'https://evil.example').start_with?('HTTP/1.1 400'), 'Cross-origin settings write accepted')
    puts 'PASS display settings are saved once per user, validated, private and seeded into every served review'

    sent = json.call(request.call('POST', '/api/send', JSON.generate(key: KEY, items: [{id: 'c1', text: 'Please explain'}])))
    assert(sent['queued'] == 1, 'Send was not queued')
    current = json.call(request.call('GET', "/api/state?key=#{KEY}"))
    assert(current['pending'] == 1 && current.dig('threads', 'c1', 'live') == true, 'State does not show the sent thread')

    started = Time.now
    waiting = Thread.new { json.call(request.call('GET', "/api/poll?key=#{KEY}&since=#{current['rev']}")) }
    sleep 0.6
    state.agent_reply('c1', 'Because it is bounded', key: KEY) # the terminal writes the file; the page learns by polling
    polled = waiting.value
    assert(Time.now - started < 5, 'Poll did not return when the agent replied')
    assert(polled.dig('threads', 'c1', 'messages').last['body'] == 'Because it is bounded', 'Poll did not carry the agent reply')
    follow = json.call(request.call('POST', '/api/message', JSON.generate(key: KEY, id: 'c1', body: 'thanks, also check B')))
    assert(follow.dig('message', 'author') == 'user' && state.pending.last['text'].include?('also check B'), 'Live follow-up was not queued')
    assert(request.call('POST', '/api/finish', JSON.generate(key: KEY)).start_with?('HTTP/1.1 200') && state.pending.last['kind'] == 'finish', 'Finish was not queued')
    File.write(File.join(series, 'manifest.json'), JSON.generate(revisions: [{number: 1}, {number: 3}]))
    assert(json.call(request.call('GET', "/api/state?key=#{KEY}"))['latest_revision'] == 3, 'The newest saved revision is not reported to the page')
    puts 'PASS a sent comment is queued, an agent reply wakes the page, follow-ups and Finish reach the queue, and a newer revision is reported'
  ensure
    server.close
  end
end
