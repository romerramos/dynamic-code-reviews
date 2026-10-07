# frozen_string_literal: true

require 'socket'
require 'openssl'
require 'uri'
require 'zlib'
require 'stringio'
require 'timeout'

module DCR
  # Loopback reverse proxy that shows a running app inside the served review. HTML pages get
  # a small agent script so the review knows the route and can pin comments to elements;
  # everything else (assets, JSON, Turbo Streams, WebSockets, server-sent events) is piped
  # through untouched. One request per connection keeps framing trivial: the upstream closes
  # after its response, so a body always ends at EOF.
  class AppProxy
    AGENT = File.expand_path('../../live/app-agent.js', __dir__)
    PREFIX = '/__dcr/'
    HTML_LIMIT = 8 * 1024 * 1024
    HOP = %w[connection keep-alive proxy-connection proxy-authorization te trailer transfer-encoding upgrade].freeze
    # Headers that would stop the review framing the page or loading the agent.
    FRAMING = %w[content-security-policy content-security-policy-report-only x-frame-options].freeze

    attr_reader :origin, :port, :upstream

    def initialize(upstream:, review_origin:, port: 0, ca_file: nil)
      @upstream = URI(upstream)
      raise ArgumentError, 'The app URL must be http or https, like http://localhost:3000' unless %w[http https].include?(@upstream.scheme) && @upstream.host
      raise ArgumentError, 'The app URL must not contain credentials' if @upstream.userinfo
      @base = "#{@upstream.scheme}://#{@upstream.host}#{":#{@upstream.port}" unless @upstream.port == @upstream.default_port}"
      @host_header = @base.sub(%r{\Ahttps?://}, '')
      @review_origin = review_origin
      @ssl = ssl_context(ca_file) if @upstream.scheme == 'https'
      @socket = TCPServer.new('127.0.0.1', port)
      @port = @socket.addr[1]
      @origin = "http://127.0.0.1:#{@port}"
    end

    # Where the review first points the frame: the path of the URL the app was given.
    def start_path
      path = @upstream.path.to_s.empty? ? '/' : @upstream.path
      @upstream.query ? "#{path}?#{@upstream.query}" : path
    end

    def describe = {origin: @origin, upstream: @base, start: start_path}

    def close = @socket.close

    def run
      loop do
        Thread.new(@socket.accept) do |client|
          handle(client)
        rescue StandardError => error
          fail_page(client, error) rescue nil
        ensure
          client.close rescue nil
        end
      end
    rescue IOError, Errno::EBADF
      nil
    end

    # Ruby trusts only its own CA file, so a local development CA (mkcert, or one passed
    # explicitly) is added to the system store rather than switching verification off.
    def ssl_context(ca_file)
      store = OpenSSL::X509::Store.new
      store.set_default_paths
      [ca_file, mkcert_root].compact.uniq.each do |path|
        raise ArgumentError, "No CA file at #{path}" if path == ca_file && !File.file?(path)
        store.add_file(path) if File.file?(path)
      rescue OpenSSL::X509::StoreError
        nil # already in the store
      end
      context = OpenSSL::SSL::SSLContext.new
      context.set_params(verify_mode: OpenSSL::SSL::VERIFY_PEER, cert_store: store)
      context
    end

    def mkcert_root
      root = ENV['CAROOT'] || (RUBY_PLATFORM.include?('darwin') ? File.expand_path('~/Library/Application Support/mkcert') : File.join(ENV.fetch('XDG_DATA_HOME', File.expand_path('~/.local/share')), 'mkcert'))
      path = File.join(root, 'rootCA.pem')
      path if File.file?(path)
    end

    private

    def handle(client)
      head = read_head(client, 15) or return
      method, target, version = head.first.split(' ', 3)
      raise ArgumentError, 'Invalid HTTP request' unless method && target&.start_with?('/') && version&.start_with?('HTTP/1.')
      headers = parse_headers(head.drop(1))
      # A page on another site that rebinds its name to 127.0.0.1 must not reach the app.
      return plain(client, 400, 'Invalid Host') unless header(headers, 'host') == "127.0.0.1:#{@port}"
      return serve_agent(client, method, target) if target.start_with?(PREFIX)

      upstream = connect
      begin
        websocket = header(headers, 'upgrade')&.casecmp?('websocket')
        upstream.write(request_head(method, target, headers, websocket))
        forward_body(client, upstream, headers) unless websocket
        response = read_head(upstream, 120) or raise IOError, 'The app closed the connection without answering'
        status = response.first.split(' ', 3)[1].to_i
        response_headers = parse_headers(response.drop(1))
        if websocket && status == 101
          client.write(build_head(response.first, response_headers))
          tunnel(client, upstream)
        elsif foreign_redirect?(status, response_headers) && document?(headers)
          left_page(client, header(response_headers, 'location'))
        elsif html?(method, status, response_headers)
          inject(client, upstream, response.first, response_headers)
        else
          client.write(build_head(response.first, rewrite(response_headers, keep_framing: true)))
          IO.copy_stream(upstream, client)
        end
      ensure
        upstream.close rescue nil
      end
    end

    def read_head(io, timeout)
      lines = []
      size = 0
      loop do
        return nil if lines.empty? && io.respond_to?(:to_io) && !io.is_a?(OpenSSL::SSL::SSLSocket) && !IO.select([io], nil, nil, timeout)
        line = io.gets("\r\n", 16_384)
        return nil if line.nil? && lines.empty?
        raise IOError, 'Truncated HTTP head' unless line
        size += line.bytesize
        raise ArgumentError, 'HTTP head too large' if size > 65_536
        break if line == "\r\n"
        lines << line.chomp("\r\n")
      end
      lines
    end

    def parse_headers(lines)
      lines.map do |line|
        name, value = line.split(':', 2)
        raise ArgumentError, 'Invalid header' unless value
        [name.strip, value.strip]
      end
    end

    def header(headers, name) = headers.find { |key, _| key.casecmp?(name) }&.last

    def connect
      socket = Socket.tcp(@upstream.host, @upstream.port, connect_timeout: 5)
      return socket unless @ssl
      tls = OpenSSL::SSL::SSLSocket.new(socket, @ssl)
      tls.hostname = @upstream.host
      tls.sync_close = true
      Timeout.timeout(10) { tls.connect }
      tls
    rescue Timeout::Error
      raise IOError, "TLS to #{@base} did not complete within 10 seconds"
    rescue OpenSSL::SSL::SSLError => error
      raise IOError, "TLS to #{@base} failed (#{error.message}). If the app uses a local CA, pass --app-ca <rootCA.pem>."
    rescue SystemCallError, SocketError => error
      raise IOError, "Could not reach #{@base} (#{error.message}). Is the app running?"
    end

    # The app sees its own host and origin, so host allow-lists and CSRF origin checks pass.
    def request_head(method, target, headers, websocket)
      out = headers.reject { |name, _| HOP.include?(name.downcase) || %w[host accept-encoding].include?(name.downcase) }.map do |name, value|
        case name.downcase
        when 'origin' then [name, value == @origin ? @base : value]
        when 'referer' then [name, value.start_with?("#{@origin}/") || value == @origin ? value.sub(@origin, @base) : value]
        else [name, value]
        end
      end
      out.unshift(['Host', @host_header])
      # Uncompressed responses let the proxy inject into HTML without a decoder.
      out << ['Accept-Encoding', 'identity']
      out += websocket ? [['Connection', 'Upgrade'], ['Upgrade', header(headers, 'upgrade')]] : [['Connection', 'close']]
      "#{method} #{target} HTTP/1.1\r\n#{out.map { |name, value| "#{name}: #{value}" }.join("\r\n")}\r\n\r\n"
    end

    def forward_body(client, upstream, headers)
      length = header(headers, 'content-length')
      raise ArgumentError, 'Chunked request bodies are not supported by the review proxy' if header(headers, 'transfer-encoding') && !length
      IO.copy_stream(client, upstream, Integer(length)) if length && Integer(length).positive?
    end

    def tunnel(client, upstream)
      pumps = [[client, upstream], [upstream, client]].map do |from, to|
        Thread.new do
          loop { to.write(from.readpartial(65_536)) }
        rescue IOError, SystemCallError, OpenSSL::SSL::SSLError
          nil
        end
      end
      # Either side closing ends the tunnel; the ensure blocks close both sockets.
      sleep 0.1 while pumps.all?(&:alive?)
    end

    def document?(headers)
      %w[document iframe].include?(header(headers, 'sec-fetch-dest').to_s) || header(headers, 'accept').to_s.include?('text/html')
    end

    # Any HTML document, whatever the method: a form that re-renders with errors is a page too.
    def html?(method, status, headers)
      method != 'HEAD' && ![204, 304].include?(status) && status >= 200 && header(headers, 'content-type').to_s.downcase.start_with?('text/html')
    end

    def foreign_redirect?(status, headers)
      location = header(headers, 'location')
      return false unless (300..399).cover?(status) && location
      uri = URI.join("#{@base}/", location)
      "#{uri.scheme}://#{uri.host}#{":#{uri.port}" unless uri.port == uri.default_port}" != @base
    rescue URI::Error
      false
    end

    # Header rewrites common to every response: cookies land on the proxy host, same-origin
    # redirects stay inside the proxy, and HSTS never pins the loopback address.
    def rewrite(headers, keep_framing:)
      headers.filter_map do |name, value|
        key = name.downcase
        next if %w[connection keep-alive strict-transport-security alt-svc].include?(key)
        next if !keep_framing && FRAMING.include?(key)
        case key
        when 'set-cookie' then [name, cookie(value)]
        when 'location' then [name, local_location(value)]
        else [name, value]
        end
      end + [['Connection', 'close']]
    end

    def cookie(value)
      parts = value.split(';').map(&:strip)
      kept = parts.drop(1).reject { |part| part.match?(/\A(?:domain|secure)\b/i) }.map { |part| part.match?(/\Asamesite\s*=\s*none\z/i) ? 'SameSite=Lax' : part }
      [parts.first, *kept].join('; ')
    end

    def local_location(value)
      return value unless value.start_with?(@base) && (value.length == @base.length || %w[/ ? #].include?(value[@base.length]))
      value.delete_prefix(@base).then { |rest| rest.empty? ? '/' : rest }
    end

    def build_head(status_line, headers)
      "#{status_line}\r\n#{headers.map { |name, value| "#{name}: #{value}" }.join("\r\n")}\r\n\r\n"
    end

    def inject(client, upstream, status_line, headers)
      raw = upstream.read(HTML_LIMIT + 1).to_s
      if raw.bytesize > HTML_LIMIT
        client.write(build_head(status_line, rewrite(headers, keep_framing: true) + [['X-DCR-Agent', 'skipped-oversized']]))
        client.write(raw)
        return IO.copy_stream(upstream, client)
      end
      body = header(headers, 'transfer-encoding').to_s.downcase.include?('chunked') ? dechunk(raw) : raw
      encoding = header(headers, 'content-encoding').to_s.downcase
      body = Zlib::GzipReader.new(StringIO.new(body)).read if encoding == 'gzip'
      unless ['', 'identity', 'gzip'].include?(encoding)
        client.write(build_head(status_line, rewrite(headers, keep_framing: true) + [['X-DCR-Agent', "skipped-#{encoding}"]]))
        return client.write(raw)
      end
      html, injected = add_agent(body)
      kept = rewrite(headers, keep_framing: false).reject { |name, _| %w[content-length transfer-encoding content-encoding].include?(name.downcase) }
      # Only the review may frame the proxied app.
      kept += [['Content-Length', html.bytesize.to_s], ['Content-Security-Policy', "frame-ancestors #{@review_origin}"], ['X-DCR-Agent', injected ? 'injected' : 'failed']]
      client.write(build_head(status_line, kept))
      client.write(html)
    end

    def dechunk(raw)
      io = StringIO.new(raw)
      out = +''.b
      while (line = io.gets("\r\n"))
        size = line.to_i(16)
        break if size.zero?
        out << io.read(size).to_s
        io.read(2)
      end
      out
    end

    # The agent goes at the start of <head> so it runs before the app's own scripts (and before
    # a service worker could register). Turbo-style navigations keep a head script with the same
    # src, so it runs once per full page load. Absolute links to the app's own origin are pointed
    # at the proxy so clicking them stays inside the review.
    def add_agent(body)
      html = body.dup.force_encoding(Encoding::BINARY)
      html = html.gsub(@base.b, @origin.b).gsub(@base.gsub('/', '\/').b, @origin.gsub('/', '\/').b)
      tag = %(<script src="#{PREFIX}agent.js"></script>).b
      masked = html.gsub(/<!--.*?-->/m) { |comment| ' ' * comment.bytesize }
      at = masked =~ /<head\b[^>]*>/i ? Regexp.last_match.end(0) : masked =~ /<html\b[^>]*>/i ? Regexp.last_match.end(0) : nil
      at ||= masked =~ /<body\b[^>]*>/i ? Regexp.last_match.end(0) : nil
      return [html, false] unless at
      [html.insert(at, tag), true]
    end

    def serve_agent(client, method, target)
      return plain(client, 404, 'Not found') unless method == 'GET' && target.split('?').first == "#{PREFIX}agent.js"
      script = File.read(AGENT).sub('__DCR_REVIEW_ORIGIN__', @review_origin).sub('__DCR_UPSTREAM_SECURE__', (@upstream.scheme == 'https').to_s)
      client.write("HTTP/1.1 200 OK\r\nContent-Type: text/javascript; charset=utf-8\r\nContent-Length: #{script.bytesize}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n#{script}")
    end

    def left_page(client, location)
      target = URI.join("#{@base}/", location).to_s
      escaped = target.gsub('&', '&amp;').gsub('<', '&lt;').gsub('"', '&quot;')
      page(client, 200, 'Left the reviewed app', "<p>The app redirected to <a href=\"#{escaped}\" target=\"_blank\" rel=\"noopener\">#{escaped}</a>, which is outside <b>#{@base}</b>.</p><p>Open it in a separate tab, or point the review at that address.</p>", left: target)
    end

    def fail_page(client, error)
      page(client, 502, 'The app did not answer', "<p>#{error.message.gsub('&', '&amp;').gsub('<', '&lt;')}</p>")
    end

    # Pages the proxy writes itself still load the agent, so the review shows their state.
    def page(client, code, title, body, left: nil)
      meta = left ? %(<meta name="dcr-left" content="#{left.gsub('"', '&quot;')}">) : ''
      html = "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"#{PREFIX}agent.js\"></script>#{meta}<title>#{title}</title><style>body{font:15px/1.55 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;color:#1f2430}h1{font-size:18px}</style></head><body><h1>#{title}</h1>#{body}</body></html>"
      client.write("HTTP/1.1 #{code} #{code == 200 ? 'OK' : 'Bad Gateway'}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: #{html.bytesize}\r\nContent-Security-Policy: frame-ancestors #{@review_origin}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n#{html}")
    end

    def plain(client, code, text)
      client.write("HTTP/1.1 #{code} Error\r\nContent-Type: text/plain\r\nContent-Length: #{text.bytesize}\r\nConnection: close\r\n\r\n#{text}")
    end
  end
end
