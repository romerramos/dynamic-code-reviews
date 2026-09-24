# frozen_string_literal: true
require 'tmpdir'
require_relative 'qa_capture'

def assert(condition, message)
  raise message unless condition
end

Dir.mktmpdir('qa-capture-test') do |directory|
  server = QACapture::Server.new(directory: directory)
  thread = Thread.new { server.run }
  request = lambda do |method, path, body = '', extra = {}|
    socket = TCPSocket.new('127.0.0.1', server.port)
    headers = {'Host' => "127.0.0.1:#{server.port}", 'Content-Length' => body.bytesize.to_s,
               'Origin' => server.url, 'X-QA-Token' => server.token}.merge(extra).compact # nil omits a header
    socket.write("#{method} #{path} HTTP/1.1\r\n#{headers.map { |key, value| "#{key}: #{value}" }.join("\r\n")}\r\n\r\n")
    socket.write(body)
    socket.close_write
    response = +''
    begin
      loop { response << socket.readpartial(65_536) }
    rescue EOFError, Errno::ECONNRESET
      # Rejected requests may close before consuming their unauthorized body.
    end
    socket.close
    response
  end
  begin
    page = request.call('GET', '/')
    assert(page.start_with?('HTTP/1.1 200'), 'Recorder page unavailable')
    assert(page.include?(server.token), 'Recorder has no upload token')
    assert(request.call('GET', '/etc/passwd').start_with?('HTTP/1.1 404'), 'Arbitrary path served')
    assert(request.call('GET', '/recorder.js').include?('getDisplayMedia'), 'Capture script unavailable')
    body = "\x89PNG\r\n\x1a\n\x00\xff".b
    response = request.call('POST', '/save/result.png', body)
    saved = JSON.parse(response.split("\r\n\r\n", 2).last)
    assert(File.binread(saved['path']) == body, 'Capture bytes changed')
    repeated = JSON.parse(request.call('POST', '/save/result.png', body).split("\r\n\r\n", 2).last)
    assert(saved['path'] != repeated['path'], 'Repeated filename overwrote a capture')
    count = Dir.children(directory).length
    [
      ['/save/rejected.png', {'X-QA-Token' => 'wrong'}],
      ['/save/rejected.png', {'Origin' => 'https://untrusted.example'}],
      ['/save/rejected.png', {'Host' => 'untrusted.example'}],
      ['/save/../rejected.png', {}],
      ['/save/rejected.html', {}],
      ['/save/rejected.png', {'Content-Length' => (QACapture::LIMIT + 1).to_s}],
      ['/save/rejected.png', {'Content-Length' => (body.bytesize + 2).to_s}]
    ].each do |path, headers|
      assert(request.call('POST', path, body, headers).start_with?('HTTP/1.1 400'), "Unsafe/incomplete write accepted: #{path}")
    end
    assert(Dir.children(directory).length == count, 'Rejected upload left a file')
    puts 'PASS capture server preserves bytes, serves only its UI, prevents cross-origin writes and cleans incomplete uploads'

    session = File.join(directory, QACapture::SESSION)
    assert(File.stat(session).mode & 0o777 == 0o600, 'Session token file is readable by others')
    # The terminal client queues a command; a simulated recorder page receives it and reports back.
    client = Thread.new { QACapture::Client.call(directory: directory, action: 'still', name: 'result-still', timeout: 10) }
    command = JSON.parse(request.call('GET', '/next').split("\r\n\r\n", 2).last)
    assert(command['action'] == 'still' && command['name'] == 'result-still', 'Recorder page did not receive the command')
    request.call('POST', "/result/#{command['id']}", JSON.generate(ok: true, value: {path: 'saved.png'}))
    assert(client.value == {'ok' => true, 'value' => {'path' => 'saved.png'}}, 'Terminal client did not receive the page result')
    assert(request.call('GET', '/next').start_with?('HTTP/1.1 204'), 'Empty queue returned a command')
    waiting = Thread.new { QACapture::Client.wait_request(directory: directory, timeout: 12) }
    request.call('POST', '/presence', JSON.generate(state: 'open'))
    event = JSON.parse(request.call('POST', '/request', JSON.generate(kind: 'preview', file: 'app/views/students/show.html.erb')).split("\r\n\r\n", 2).last)
    assert(event['kind'] == 'preview' && waiting.value['file'] == 'app/views/students/show.html.erb', 'Requested preview did not wake the waiting client')
    waiting = Thread.new { QACapture::Client.wait_request(directory: directory, timeout: 12) }
    request.call('POST', '/request', JSON.generate(kind: 'qa'))
    assert(waiting.value['kind'] == 'qa', 'QA request did not wake the waiting client')
    waiting = Thread.new { QACapture::Client.wait_request(directory: directory, timeout: 12) }
    request.call('POST', '/presence', JSON.generate(state: 'closed'))
    assert(waiting.value['closed'], 'Closing the report did not release the waiting client')
    [
      ['POST', '/control', JSON.generate(action: 'start'), {'X-QA-Token' => 'wrong', 'Origin' => nil}],
      ['POST', '/control', JSON.generate(action: 'start'), {'Origin' => 'https://untrusted.example'}],
      ['POST', '/control', JSON.generate(action: 'connect'), {}],
      ['POST', '/control', JSON.generate(action: 'start', name: '../escape'), {}],
      ['POST', '/request', JSON.generate(kind: 'preview', file: '../etc/passwd'), {}],
      ['POST', '/request', JSON.generate(kind: 'preview', file: 'app/views/x.html.erb'), {'Origin' => 'https://untrusted.example'}],
      ['GET', '/next', '', {'X-QA-Token' => 'wrong'}],
      ['POST', "/result/#{'0' * 16}", '{}', {'Origin' => nil}]
    ].each do |method, path, body, headers|
      assert(request.call(method, path, body, headers).start_with?('HTTP/1.1 400'), "Unsafe control accepted: #{method} #{path} #{headers}")
    end
    missing = begin
      QACapture::Client.call(directory: directory, action: 'status', timeout: 2)
    rescue RuntimeError => error
      error.message
    end
    assert(missing.to_s.include?('did not finish') || missing.to_s.include?('not open'), 'Unanswered command did not time out')
    puts 'PASS terminal commands reach the recorder page, results return, and untrusted control is rejected'
  ensure
    server.close
    thread.join
  end
end

Dir.mktmpdir('qa-capture-report') do |directory|
  series = File.join(directory, 'series'); FileUtils.mkdir_p(File.join(series, 'revisions'))
  offline = %(<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'">)
  report = File.join(series, 'current.html')
  File.write(report, %(<!doctype html><html><head>#{offline}</head><body><script>const $ = 1;</script><main>Review body</main></body></html>))
  File.write(File.join(series, 'revisions', '001.html'), %(<html><head>#{offline}</head><body>Saved revision</body></html>))
  File.write(File.join(directory, 'outside.html'), 'outside')
  server = QACapture::Server.new(directory: File.join(directory, 'captures'), report: report)
  thread = Thread.new { server.run }
  http = Net::HTTP.new('127.0.0.1', server.port)
  begin
    page = http.get('/')
    assert(page.code == '200' && page.body.include?('Review body'), 'Served review unavailable')
    assert(page.body.index('/qa-panel.js') > page.body.index('Review body') && page.body.include?(server.token), 'QA panel not injected after the review content')
    assert(!page.body.include?("connect-src 'none'") && page['content-security-policy'].include?("connect-src 'self'"), 'Served review cannot reach the capture helper')
    assert(File.read(report).include?("connect-src 'none'"), 'Saved review file was modified')
    revision = http.get('/revisions/001.html')
    assert(revision.body.include?('Saved revision') && !revision.body.include?('qa-panel.js'), 'Revision pages must be served as saved, without the panel')
    assert(http.get('/qa-panel.js').body.include?('qa-connect'), 'Panel script unavailable')
    ['/../outside.html', '/%2e%2e/outside.html', '/captures/.qa-session.json', '/manifest.json'].each do |path|
      assert(%w[400 404].include?(http.get(path).code), "Served a file outside the review pages: #{path}")
    end
    recorder = File.read(File.join(QACapture::ASSETS, 'recorder.js'))
    assert(recorder.start_with?("'use strict';") && recorder.include?('(() => {') && recorder.rstrip.end_with?('})();'), 'Recorder globals would leak into the review page')
    puts 'PASS served review keeps its content, gains the QA panel only at /, and exposes no other files'
  ensure
    server.close
    thread.join
  end
end
