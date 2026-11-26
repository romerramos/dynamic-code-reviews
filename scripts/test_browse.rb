# frozen_string_literal: true
# Run with ruby scripts/test_browse.rb. Stdlib only; `browse` is a stub script, never the real one.
ENV['DCR_FOCUS'] = '0' # never raise the reader's browser from a test
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config') # never touch the real user settings
require 'socket'
require_relative '../lib/dcr/browse'
require_relative '../lib/dcr/live_cli'
require_relative '../lib/dcr/server'
require_relative '../lib/dcr/state'

def assert(condition, message)
  raise message unless condition
end

KEY = 'dynamic-review:abc123:feature:2'

Dir.mktmpdir('dcr-browse-test') do |directory|
  # A stand-in for `browse status --json` that prints whatever the test last wrote.
  answer = File.join(directory, 'status.json')
  stub = File.join(directory, 'browse')
  File.write(stub, "#!/bin/sh\ncat #{answer}\n")
  File.chmod(0o755, stub)
  status = lambda do |value|
    File.write(answer, value.is_a?(String) ? value : JSON.generate(value))
    DCR::Browse.run_status(binary: stub)
  end
  ready = {'connected' => true, 'pairingState' => 'connected', 'nextStep' => nil, 'extension' => {'connected' => true, 'browsers' => [{'id' => 'work-chrome', 'connected' => true}]}}

  assert(DCR::Browse.classify(status.call(ready)) == {'state' => 'ready', 'next_step' => nil}, 'A connected browse with nothing to do is not ready')
  assert(DCR::Browse.run_status(binary: File.join(directory, 'missing')).nil?, 'A missing binary is not reported as missing')
  assert(DCR::Browse.classify(nil)['state'] == 'not-installed', 'No binary is not "not installed"')
  missing = status.call('connected' => false, 'pairingState' => 'not-seen', 'nextStep' => 'Add the browse extension from the Chrome Web Store.', 'extension' => {'connected' => false, 'browsers' => []})
  assert(DCR::Browse.classify(missing) == {'state' => 'extension-missing', 'next_step' => 'Add the browse extension from the Chrome Web Store.'}, "An extension never seen is not missing: #{DCR::Browse.classify(missing)}")
  unpaired = status.call('connected' => false, 'pairingState' => 'unpaired', 'nextStep' => 'Run `browse pair` and enter its code in the extension.', 'extension' => {'connected' => false, 'browsers' => [{'id' => 'work-chrome', 'connected' => false}]})
  assert(DCR::Browse.classify(unpaired) == {'state' => 'not-paired', 'next_step' => 'Run `browse pair` and enter its code in the extension.'}, 'A known but unconnected extension is not "not paired" with browse\'s own step')
  assert(DCR::Browse.classify(status.call(ready.merge('nextStep' => 'Open Chrome.')))['state'] != 'ready', 'A step still to do counts as ready')
  assert(DCR::Browse.classify(status.call('not json'))['state'] == 'extension-missing', 'Unreadable output counts as ready')

  # Whether the app answers: something listening, or nothing.
  listener = TCPServer.new('127.0.0.1', 0)
  open_port = listener.addr[1]
  Thread.new do
    loop do
      client = listener.accept
      client.readpartial(4096)
      client.write("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
      client.close
    end
  rescue IOError
    nil
  end
  closed = TCPServer.new('127.0.0.1', 0).then { |free| free.addr[1].tap { free.close } }
  assert(DCR::Browse.check(app: "http://127.0.0.1:#{open_port}/", status: ready)['app'] == true, 'A listening app does not answer')
  assert(DCR::Browse.check(app: "http://127.0.0.1:#{closed}/", status: ready)['app'] == false, 'A closed port answers')
  assert(DCR::Browse.check(status: ready)['app'].nil?, 'Without an app there is no answer to give')
  puts 'PASS browse status reads as ready, not installed, extension missing or not paired (with browse\'s own step), and the app as answering or not'

  # Install anomalyco/browse: a thread the agent answers, handed over by `dcr wait` as a setup task.
  series = File.join(directory, 'series')
  FileUtils.mkdir_p(series)
  File.write(File.join(series, 'manifest.json'), JSON.generate('version' => 1, 'name' => 'feat', 'repo' => '/work/shop'))
  File.write(File.join(series, 'current.html'), %(<html><body><script type="application/json" id="data">{}</script></body></html>))
  state = DCR::State.new(series)
  id = DCR::Browse.request(series_dir: series, state: state, key: KEY, origin: 'http://127.0.0.1:4100')['id']
  thread = state.read.dig('threads', KEY, id)
  assert(id.start_with?('app-setup-') && thread['delivery'] == 'sent' && thread.dig('anchor', 'kind') == 'setup', 'The install request is not a sent setup thread')
  entry = state.pending.last
  assert(entry['kind'] == 'setup' && entry['thread_ids'] == [id], 'The install request was not queued for the agent')
  out = DCR::LiveCLI.render(state.pending, '--repo /work/shop --name feat')
  assert(out.include?('BROWSE SETUP REQUEST') && !out.include?('REPLY ONLY'), 'The install request reads as a conversation')
  [DCR::Browse::INSTALLER, '--no-open --no-wait', "browse navigate 'http://127.0.0.1:4100/#overview'", "reply --repo /work/shop --name feat #{id}"].each do |step|
    assert(out.include?(step), "The install request does not say: #{step}")
  end
  state.send_items(KEY, [{'id' => 'c1', 'text' => 'Why a fee?'}])
  mixed = DCR::LiveCLI.render(state.pending, '--repo /work/shop --name feat')
  assert(mixed.include?('BROWSE SETUP REQUEST') && mixed.include?('only the browse setup request installs something'), 'With a conversation, the install request is not set apart from reply only')
  puts 'PASS Install anomalyco/browse queues a setup thread whose steps install the CLI, add it to the agent and open the review in a browse tab'

  # The served review asks the server, which runs browse again each time.
  ENV['DCR_BROWSE_BIN'] = stub
  File.write(answer, JSON.generate(unpaired))
  server = DCR::Server.new(directory: File.join(directory, 'capture'), report: File.join(series, 'current.html'), app: "http://127.0.0.1:#{open_port}/")
  Thread.new { server.run }
  get = lambda do |path|
    socket = TCPSocket.new('127.0.0.1', server.port)
    socket.write("GET #{path} HTTP/1.1\r\nHost: 127.0.0.1:#{server.port}\r\nOrigin: #{server.url}\r\nX-QA-Token: #{server.token}\r\n\r\n")
    socket.close_write
    response = socket.read
    socket.close
    response
  end
  begin
    page = get.call('/')
    assert(page.include?('name="dcr-browse"') && page.include?('not-paired'), 'The served page does not carry the serve-time check')
    File.write(answer, JSON.generate(ready))
    found = JSON.parse(get.call('/api/browse?app=1').split("\r\n\r\n", 2).last)
    assert(found == {'state' => 'ready', 'next_step' => nil, 'app' => true}, "The endpoint does not check again: #{found}")
    quick = JSON.parse(get.call('/api/browse').split("\r\n\r\n", 2).last)
    assert(quick['state'] == 'ready' && quick['app'].nil?, 'Without ?app the check still waits on the app')
    puts 'PASS the served review carries the serve-time check and /api/browse checks again'
  ensure
    server.close
    listener.close
    ENV.delete('DCR_BROWSE_BIN')
  end
end
