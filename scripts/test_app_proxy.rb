# frozen_string_literal: true
# The review's app proxy against fixture apps over plain HTTP and over HTTPS with a local CA.
require 'socket'
require 'openssl'
require 'json'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/dcr/app_proxy'

def assert(condition, message)
  raise message unless condition
end

REVIEW = 'http://127.0.0.1:1'

# A tiny app: each path exercises one behaviour, and /echo returns what the proxy sent upstream.
def app_server(tls: nil)
  server = TCPServer.new('127.0.0.1', 0)
  port = server.addr[1]
  listener = tls ? OpenSSL::SSL::SSLServer.new(server, tls) : server
  # Handshakes happen per connection, so a refused one does not stop the server.
  listener.start_immediately = false if tls
  Thread.new do
    loop do
      Thread.new(listener.accept) do |client|
        client.accept if tls
        request = []
        while (line = client.gets("\r\n")) && line != "\r\n" do request << line.chomp("\r\n") end
        method, path = request.first.split
        headers = request.drop(1).to_h { |line| line.split(': ', 2) }
        body = headers['Content-Length'] ? client.read(Integer(headers['Content-Length'])) : ''
        base = "#{tls ? 'https' : 'http'}://localhost:#{port}"
        reply = lambda do |status, type, content, extra = []|
          head = ["HTTP/1.1 #{status}", "Content-Type: #{type}", "Content-Length: #{content.bytesize}", *extra]
          client.write("#{head.join("\r\n")}\r\n\r\n#{content}")
        end
        case path
        when '/page'
          reply.call('200 OK', 'text/html; charset=utf-8', %(<!doctype html><html><head><!-- <head> in a comment --><title>App</title></head><body><a href="#{base}/next">next</a></body></html>),
                     ['Content-Security-Policy: default-src none', 'X-Frame-Options: DENY', 'Strict-Transport-Security: max-age=1',
                      'Set-Cookie: _app_session=abc; domain=.localhost; path=/; secure; HttpOnly; SameSite=None'])
        when '/echo' then reply.call('200 OK', 'application/json', JSON.generate(method: method, headers: headers, body: body))
        when '/stream'
          client.write("HTTP/1.1 200 OK\r\nContent-Type: text/vnd.turbo-stream.html\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")
        when '/chunked-page'
          client.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\nf\r\n<html><head></h\r\n10\r\nead><body>ok</bo\r\n5\r\ndy></\r\n5\r\nhtml>\r\n0\r\n\r\n")
        when '/home' then reply.call('302 Found', 'text/html', '', ["Location: #{base}/page"])
        when '/sso' then reply.call('302 Found', 'text/html', '', ['Location: https://login.example.com/start'])
        when '/cable'
          client.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Origin: #{headers['Origin']}\r\n\r\n")
          loop { client.write(client.readpartial(1024).upcase) }
        else reply.call('404 Not Found', 'text/plain', 'missing')
        end
      rescue EOFError, IOError, SystemCallError, OpenSSL::SSL::SSLError
        nil
      ensure
        client.close rescue nil
      end
    end
  end
  port
end

def fetch(proxy, method, path, headers = {}, body = '')
  socket = TCPSocket.new('127.0.0.1', proxy.port)
  all = {'Host' => "127.0.0.1:#{proxy.port}"}.merge(headers).compact
  all['Content-Length'] = body.bytesize.to_s unless body.empty?
  socket.write("#{method} #{path} HTTP/1.1\r\n#{all.map { |key, value| "#{key}: #{value}" }.join("\r\n")}\r\n\r\n#{body}")
  response = socket.read
  socket.close
  head, content = response.split("\r\n\r\n", 2)
  [head, content]
end

def exercise(proxy, upstream)
  Thread.new { proxy.run }

  head, html = fetch(proxy, 'GET', '/page', 'Accept' => 'text/html')
  assert(head.start_with?('HTTP/1.1 200') && head.include?('X-DCR-Agent: injected'), "HTML was not injected: #{head}")
  assert(html.index('<script src="/__dcr/agent.js"></script>') < html.index('<title>'), 'The agent must load at the start of <head>, not inside a comment')
  assert(html.include?(%(<a href="#{proxy.origin}/next">)) && !html.include?(upstream), 'Absolute links to the app must stay inside the proxy')
  assert(!head.match?(/X-Frame-Options|default-src none|Strict-Transport/i), 'Framing, CSP and HSTS headers must be removed from HTML')
  assert(head.include?("Content-Security-Policy: frame-ancestors #{REVIEW}"), 'Only the review may frame the app')
  cookie = head[/^Set-Cookie: [^\r]*/]
  assert(cookie == 'Set-Cookie: _app_session=abc; path=/; HttpOnly; SameSite=Lax', "Cookie was not rewritten for the proxy host: #{cookie}")

  _, echoed = fetch(proxy, 'POST', '/echo', {'Origin' => proxy.origin, 'Referer' => "#{proxy.origin}/page", 'Accept-Encoding' => 'gzip, br', 'Content-Type' => 'application/json'}, '{"a":1}')
  sent = JSON.parse(echoed)
  assert(sent['headers']['Host'] == upstream.sub(%r{\Ahttps?://}, ''), "Upstream did not see its own Host: #{sent['headers']['Host']}")
  assert(sent['headers']['Origin'] == upstream && sent['headers']['Referer'] == "#{upstream}/page", 'Origin and Referer must be the app\'s own, for CSRF checks')
  assert(sent['headers']['Accept-Encoding'] == 'identity' && sent['body'] == '{"a":1}' && sent['method'] == 'POST', 'Request body or encoding was not forwarded as expected')

  head, body = fetch(proxy, 'GET', '/stream', 'Accept' => 'text/vnd.turbo-stream.html, text/html')
  assert(head.include?('Transfer-Encoding: chunked') && body == "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n" && !head.include?('X-DCR-Agent'), 'A Turbo Stream must pass through untouched')

  head, body = fetch(proxy, 'GET', '/chunked-page')
  assert(body == '<html><head><script src="/__dcr/agent.js"></script></head><body>ok</body></html>' && head.include?("Content-Length: #{body.bytesize}"), "A chunked page was not de-chunked and injected: #{body.inspect}")

  head, = fetch(proxy, 'GET', '/home')
  assert(head.include?("\r\nLocation: /page"), 'A redirect within the app must stay inside the proxy')
  head, body = fetch(proxy, 'GET', '/sso', 'Sec-Fetch-Dest' => 'iframe')
  assert(head.start_with?('HTTP/1.1 200') && body.include?('name="dcr-left" content="https://login.example.com/start"'), 'A redirect to another host must be reported, not followed')

  head, = fetch(proxy, 'GET', '/page', 'Host' => 'evil.example:80')
  assert(head.start_with?('HTTP/1.1 400'), 'A foreign Host header must be refused (DNS rebinding)')
  head, script = fetch(proxy, 'GET', '/__dcr/agent.js')
  assert(head.start_with?('HTTP/1.1 200') && script.include?(%('#{REVIEW}')) && !script.include?('__DCR_REVIEW_ORIGIN__'), 'Agent script must carry the review origin')
  assert(script.include?("const UPSTREAM_SECURE = #{upstream.start_with?('https')};"), 'Agent must know whether the app is really https, to upgrade its other-host connections')

  socket = TCPSocket.new('127.0.0.1', proxy.port)
  socket.write("GET /cable HTTP/1.1\r\nHost: 127.0.0.1:#{proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: #{proxy.origin}\r\n\r\n")
  handshake = +''
  handshake << socket.readpartial(1024) until handshake.include?("\r\n\r\n")
  assert(handshake.start_with?('HTTP/1.1 101') && handshake.include?("X-Origin: #{upstream}"), "WebSocket upgrade failed: #{handshake}")
  socket.write('ping')
  assert(socket.readpartial(1024) == 'PING', 'WebSocket frames were not tunnelled')
  socket.close
ensure
  proxy.close
end

# Plain HTTP on a port: the common case.
port = app_server
exercise(DCR::AppProxy.new(upstream: "http://localhost:#{port}/page", review_origin: REVIEW), "http://localhost:#{port}")

# Shared on the tailnet: Tailscale Serve forwards under the tailnet name and says who is asking.
shared = DCR::AppProxy.new(upstream: "http://localhost:#{port}/page", review_origin: REVIEW)
Thread.new { shared.run }
tailnet = "laptop.tail0.ts.net:#{shared.port}"
shared.share!(host: tailnet, origin: "https://#{tailnet}", review_origin: 'https://laptop.tail0.ts.net:9', allowed: ['me@github'])
head, = fetch(shared, 'GET', '/page', 'Host' => tailnet, 'Tailscale-User-Login' => 'colleague@github')
assert(head.start_with?('HTTP/1.1 403'), 'A tailnet login the review is not shared with must be refused')
head, page = fetch(shared, 'GET', '/page', 'Host' => tailnet, 'Tailscale-User-Login' => 'me@github')
assert(head.include?('frame-ancestors https://laptop.tail0.ts.net:9') && page.include?("https://#{tailnet}/next"), 'Shared, the app answers with the tailnet addresses')
head, page = fetch(shared, 'GET', '/page')
assert(head.include?("frame-ancestors #{REVIEW}") && page.include?("http://127.0.0.1:#{shared.port}/next"), 'Locally, the app keeps its local addresses')
shared.close

# HTTPS with a local CA that Ruby does not trust by default, as with mkcert.
key = OpenSSL::PKey::RSA.new(2048)
ca = OpenSSL::X509::Certificate.new
ca.version = 2; ca.serial = 1; ca.subject = ca.issuer = OpenSSL::X509::Name.parse('/CN=dcr test CA')
ca.public_key = key.public_key; ca.not_before = Time.now - 60; ca.not_after = Time.now + 3600
extensions = OpenSSL::X509::ExtensionFactory.new(ca, ca)
ca.add_extension(extensions.create_extension('basicConstraints', 'CA:TRUE', true))
ca.add_extension(extensions.create_extension('keyUsage', 'keyCertSign,cRLSign', true))
ca.sign(key, OpenSSL::Digest.new('SHA256'))
leaf = OpenSSL::X509::Certificate.new
leaf.version = 2; leaf.serial = 2; leaf.subject = OpenSSL::X509::Name.parse('/CN=localhost'); leaf.issuer = ca.subject
leaf.public_key = key.public_key; leaf.not_before = ca.not_before; leaf.not_after = ca.not_after
extensions = OpenSSL::X509::ExtensionFactory.new(ca, leaf)
leaf.add_extension(extensions.create_extension('subjectAltName', 'DNS:localhost', false))
leaf.sign(key, OpenSSL::Digest.new('SHA256'))
tls = OpenSSL::SSL::SSLContext.new
tls.cert = leaf; tls.key = key
port = app_server(tls: tls)

Dir.mktmpdir('dcr-proxy-ca') do |directory|
  ca_file = File.join(directory, 'rootCA.pem')
  File.write(ca_file, ca.to_pem)
  # Without the CA the proxy must refuse, and say how to fix it.
  untrusted = DCR::AppProxy.new(upstream: "https://localhost:#{port}", review_origin: REVIEW)
  Thread.new { untrusted.run }
  head, body = fetch(untrusted, 'GET', '/page')
  assert(head.start_with?('HTTP/1.1 502') && body.include?('--app-ca'), 'An untrusted certificate must fail with a hint')
  untrusted.close
  exercise(DCR::AppProxy.new(upstream: "https://localhost:#{port}", review_origin: REVIEW, ca_file: ca_file), "https://localhost:#{port}")
end

down = DCR::AppProxy.new(upstream: 'http://127.0.0.1:9', review_origin: REVIEW)
Thread.new { down.run }
head, body = fetch(down, 'GET', '/')
assert(head.start_with?('HTTP/1.1 502') && body.include?('Is the app running?') && body.include?('/__dcr/agent.js'), 'An unreachable app must explain itself and still report to the review')
down.close

begin
  DCR::AppProxy.new(upstream: 'file:///etc/passwd', review_origin: REVIEW)
  assert(false, 'A non-HTTP app URL was accepted')
rescue ArgumentError
  nil
end
# `dcr serve --app`: the review frames only the proxy, and loads the App view.
require_relative 'qa_capture'
port = app_server
Dir.mktmpdir('dcr-serve-app') do |directory|
  ENV['DCR_CONFIG_DIR'] = File.join(directory, 'config')
  report = File.join(directory, 'series', 'current.html')
  FileUtils.mkdir_p(File.dirname(report))
  File.write(report, %(<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Review</title></head><body></body></html>))
  server = QACapture::Server.new(directory: File.join(directory, 'captures'), report: report, app: "http://localhost:#{port}/page")
  Thread.new { server.run }
  review = Struct.new(:port).new(server.port)
  head, html = fetch(review, 'GET', '/?app')
  proxy_origin = server.app_url[%r{\Ahttp://127\.0\.0\.1:\d+}]
  assert(head.start_with?('HTTP/1.1 200') && html.include?('<script src="/app-view.js"></script>'), 'The review did not load the App view at /?app')
  assert(head.include?("frame-src #{proxy_origin};") && html.include?("frame-src #{proxy_origin};"), 'The review must be allowed to frame the proxy, and only it')
  assert(html.include?('&quot;start&quot;:&quot;/page&quot;'), 'The App view did not get the start page')
  assert(fetch(review, 'GET', '/app-view.css').first.start_with?('HTTP/1.1 200'), 'App view styles missing')
  _, page = fetch(Struct.new(:port).new(proxy_origin.split(':').last.to_i), 'GET', '/page')
  assert(page.include?('/__dcr/agent.js'), 'The proxy started by serve did not inject the agent')
  server.close

  # A restart comes back at the same address and token, so an open page keeps working.
  again = QACapture::Server.new(directory: File.join(directory, 'captures'), report: report, app: "http://localhost:#{port}/page")
  assert([again.port, again.token, again.app_url] == [server.port, server.token, server.app_url], 'A restarted review must keep its port, token and app address')
  assert(File.stat(File.join(directory, 'series', '.serve.json')).mode & 0o777 == 0o600, 'The saved token must be private')
  # While that address is taken, a second server still starts, on another port.
  other = QACapture::Server.new(directory: File.join(directory, 'captures2'), report: report, app: "http://localhost:#{port}/page")
  assert(other.port != again.port && other.app_url != again.app_url, 'A taken port must fall back to a free one')
  [again, other].each(&:close)
end
puts 'app proxy: ok'
