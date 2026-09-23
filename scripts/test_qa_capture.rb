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
               'Origin' => server.url, 'X-QA-Token' => server.token}.merge(extra)
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
  ensure
    server.close
    thread.join
  end
end
