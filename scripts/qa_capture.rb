#!/usr/bin/env ruby
# frozen_string_literal: true

# Loopback-only capture helper. Ruby stdlib; no browser automation or encoder dependency.
require 'socket'
require 'json'
require 'optparse'
require 'securerandom'
require 'fileutils'
require 'timeout'
require 'net/http'
require 'time'

module QACapture
  LIMIT = 24 * 1024 * 1024
  ACTIONS = %w[start stop still end status reload].freeze
  SESSION = '.qa-session.json'
  ASSETS = File.expand_path('../recorder', __dir__)
  PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; media-src blob:; img-src 'self' blob:; frame-ancestors 'none'"
  # The served review keeps its own inline scripts and embedded media, and may also load
  # the QA panel and talk to this helper. The saved HTML file keeps its stricter offline policy.
  REPORT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  class Server
    attr_reader :port, :token

    # report: a review HTML (normally .reviews/<series>/current.html) served at / with the
    # QA panel, so the reader starts capture from the review instead of a separate page.
    def initialize(directory:, port: 0, report: nil)
      @directory = File.expand_path(directory)
      raise ArgumentError, 'Capture output must not be a symlink' if File.symlink?(@directory)
      if report
        @report = File.expand_path(report)
        raise ArgumentError, 'The review report must be an existing HTML file' unless @report.end_with?('.html') && File.file?(@report) && !File.symlink?(@report)
      end
      FileUtils.mkdir_p(@directory)
      @token = SecureRandom.hex(24)
      @socket = TCPServer.new('127.0.0.1', port)
      @port = @socket.addr[1]
      @origin = "http://127.0.0.1:#{@port}"
      # Terminal commands queue here; the recorder page polls and runs them in order,
      # so the agent never has to operate the recorder tab through a browser harness.
      @commands = []
      @results = {}
      @requests = []
      @last_presence = nil
      @page_closed_at = nil
      @last_poll = nil
      @lock = Mutex.new
      @signal = ConditionVariable.new
      session = File.join(@directory, SESSION)
      File.unlink(session) if File.file?(session)
      File.open(session, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(JSON.generate(url: @origin, token: @token)) }
    end

    def url = @origin
    def close = @socket.close

    def run
      loop do
        # One thread per connection so the page's long poll never blocks uploads or commands.
        Thread.new(@socket.accept) do |client|
          Timeout.timeout(15) { serve(client) }
        rescue Timeout::Error
          # Browsers open idle connections ahead of time; answering one with an error would
          # show that error for whichever navigation later reuses the socket.
          nil
        rescue StandardError => error
          respond(client, 400, JSON.generate(error: error.message), 'application/json') rescue nil
        ensure
          client.close
        end
      end
    rescue IOError, Errno::EBADF
      nil
    end

    def serve(client)
      first = client.gets("\r\n", 4096).to_s
      method, path, version = first.split
      raise ArgumentError, 'Invalid HTTP request' unless version == 'HTTP/1.1' && path
      headers = {}; count = 0
      while (line = client.gets("\r\n", 4096)) && line != "\r\n"
        count += line.bytesize
        raise ArgumentError, 'Headers too large' if count > 16_384
        key, value = line.split(':', 2)
        raise ArgumentError, 'Invalid header' unless value
        headers[key.downcase] = value.strip
      end
      raise ArgumentError, 'Invalid Host' unless headers['host'] == "127.0.0.1:#{@port}"
      if method == 'GET' && !path.start_with?('/next', '/result/', '/requests/')
        return serve_report(client, path) if @report && (path == '/' || path.match?(%r{\A/(?:revisions/)?[a-z0-9_-]+\.html\z}))
        asset, type = {'/' => ['index.html', 'text/html; charset=utf-8'], '/recorder.js' => ['recorder.js', 'text/javascript'], '/qa-panel.js' => ['qa-panel.js', 'text/javascript'], '/style.css' => ['style.css', 'text/css']}[path]
        return respond(client, 404, 'Not found', 'text/plain') unless asset
        content = File.binread(File.join(ASSETS, asset)).sub('__QA_TOKEN__', @token)
        return respond(client, 200, content, type)
      end
      raise ArgumentError, 'Invalid capture token' unless headers['x-qa-token'] == @token
      return requests(client, method, path, headers) if path == '/request' || path == '/presence' || path == '/requests/next'
      return control(client, method, path, headers) if path == '/next' || path == '/control' || path.start_with?('/result/')
      raise ArgumentError, 'Only same-origin capture uploads are accepted' unless method == 'POST' && headers['origin'] == @origin
      match = path.match(%r{\A/save/([a-z0-9_-]{1,80})\.(png|webm|json)\z})
      raise ArgumentError, 'Invalid capture filename' unless match
      length = Integer(headers.fetch('content-length'))
      raise ArgumentError, 'Capture must be between 1 byte and 24 MiB' unless length.positive? && length <= LIMIT
      raise ArgumentError, 'Chunked uploads are unsupported' if headers['transfer-encoding']
      output = File.join(@directory, "#{match[1]}-#{SecureRandom.hex(4)}.#{match[2]}")
      begin
        File.open(output, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
          remaining = length
          while remaining.positive?
            bytes = client.read([remaining, 65536].min)
            raise ArgumentError, 'Incomplete capture upload' unless bytes && !bytes.empty?
            file.write(bytes); remaining -= bytes.bytesize
          end
        end
      rescue StandardError
        File.unlink(output) if File.file?(output)
        raise
      end
      respond(client, 200, JSON.generate(path: output, bytes: length), 'application/json')
    end

    # A live report submits optional work. The terminal waits on this queue without
    # polling the browser or starting media capture before the reader requests it.
    def requests(client, method, path, headers)
      if method == 'GET' && path == '/requests/next'
        raise ArgumentError, 'Browser cannot read the work queue' if headers['origin']
        event = @lock.synchronize do
          @signal.wait(@lock, @page_closed_at ? 3 : 10) if @requests.empty?
          stale = @last_presence && Time.now - @last_presence > 45
          closed = @page_closed_at && Time.now - @page_closed_at > 3
          @requests.shift || (closed || stale ? {'closed' => true} : nil)
        end
        return event ? respond(client, 200, JSON.generate(event), 'application/json') : respond(client, 204, '', 'text/plain')
      end
      raise ArgumentError, 'Only the live review may request work' unless headers['origin'] == @origin
      if method == 'POST' && path == '/presence'
        input = JSON.parse(small_body(client, headers))
        raise ArgumentError, 'Invalid presence event' unless %w[open closed].include?(input['state'])
        @lock.synchronize do
          @last_presence = Time.now
          @page_closed_at = input['state'] == 'closed' ? Time.now : nil
          @signal.broadcast
        end
        return respond(client, 200, '{}', 'application/json')
      end
      if method == 'POST' && path == '/request'
        input = JSON.parse(small_body(client, headers))
        kind = input['kind']
        file = input['file'].to_s
        raise ArgumentError, 'Unknown enhancement' unless %w[qa preview].include?(kind)
        raise ArgumentError, 'Invalid preview path' unless kind == 'qa' && file.empty? || kind == 'preview' && file.match?(%r{\A(?:app/views|app/components)/[A-Za-z0-9_./-]+\.(?:html\.erb|rb)\z}) && !file.split('/').include?('..')
        event = {'kind' => kind, 'file' => file, 'created' => Time.now.utc.iso8601}
        @lock.synchronize do
          unless @requests.any? { |pending| pending['kind'] == kind && pending['file'] == file }
            raise ArgumentError, 'Too many pending requests' if @requests.length >= 32
            @requests << event
            @signal.broadcast
          end
        end
        return respond(client, 200, JSON.generate(event), 'application/json')
      end
      respond(client, 404, 'Not found', 'text/plain')
    end

    # GET /next and POST /result/<id> come from the recorder page; POST /control and
    # GET /result/<id> come from the terminal client, which sends no Origin header.
    def control(client, method, path, headers)
      raise ArgumentError, 'Cross-origin control rejected' unless [nil, @origin].include?(headers['origin'])
      id = path[%r{\A/result/([a-f0-9]{16})\z}, 1]
      if method == 'GET' && path == '/next'
        # Long poll: a hidden recorder tab's timers are throttled, but a pending fetch is not.
        command = @lock.synchronize do
          @last_poll = Time.now
          @signal.wait(@lock, 10) if @commands.empty?
          @last_poll = Time.now
          @commands.shift
        end
        command ? respond(client, 200, JSON.generate(command), 'application/json') : respond(client, 204, '', 'text/plain')
      elsif method == 'POST' && path == '/control'
        request = JSON.parse(small_body(client, headers))
        raise ArgumentError, 'Unknown recorder action' unless ACTIONS.include?(request['action'])
        name = request['name'].to_s
        raise ArgumentError, 'Invalid evidence name' unless name.empty? || name.match?(/\A[a-z0-9_-]{1,80}\z/)
        command = {id: SecureRandom.hex(8), action: request['action'], name: name}
        @lock.synchronize { @commands << command; @signal.signal }
        respond(client, 200, JSON.generate(id: command[:id]), 'application/json')
      elsif method == 'POST' && id
        raise ArgumentError, 'Only the recorder page reports results' unless headers['origin'] == @origin
        result = JSON.parse(small_body(client, headers))
        @lock.synchronize { @results[id] = result }
        respond(client, 200, '{}', 'application/json')
      elsif method == 'GET' && id
        result, connected = @lock.synchronize { [@results.delete(id), @last_poll && Time.now - @last_poll < 12] }
        return respond(client, 200, JSON.generate(result), 'application/json') if result
        respond(client, 202, JSON.generate(pending: true, page_connected: !!connected), 'application/json')
      else
        respond(client, 404, 'Not found', 'text/plain')
      end
    end

    def small_body(client, headers)
      length = Integer(headers.fetch('content-length'))
      raise ArgumentError, 'Control message too large' unless length.between?(1, 65_536)
      body = client.read(length)
      raise ArgumentError, 'Incomplete control message' unless body&.bytesize == length
      body
    end

    # / is the current review with the QA panel; sibling revision pages are served as
    # saved, so the review's own history links keep working.
    def serve_report(client, path)
      file = path == '/' ? @report : File.join(File.dirname(@report), path.delete_prefix('/'))
      return respond(client, 404, 'Not found', 'text/plain') unless File.file?(file) && !File.symlink?(file)
      html = File.read(file, encoding: 'UTF-8').sub(/<meta http-equiv="Content-Security-Policy"[^>]*>/i) do
        %(<meta http-equiv="Content-Security-Policy" content="#{REPORT_CSP}">)
      end
      if path == '/'
        panel = %(<meta name="qa-token" content="#{@token}"><link rel="stylesheet" href="/style.css"><script src="/qa-panel.js"></script><script src="/recorder.js"></script>)
        at = html.rindex('</body>') || html.length
        html = html.dup.insert(at, panel)
      end
      respond(client, 200, html, 'text/html; charset=utf-8', REPORT_CSP)
    end

    def respond(client, code, body, type, csp = PANEL_CSP)
      reason = {200 => 'OK', 202 => 'Accepted', 204 => 'No Content', 404 => 'Not Found'}.fetch(code, 'Error')
      client.write("HTTP/1.1 #{code} #{reason}\r\nContent-Type: #{type}\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: #{csp}\r\n\r\n")
      client.write(body)
    end
  end

  # Terminal side of the command queue. Each call waits for the recorder page's result.
  module Client
    module_function

    def call(directory:, action:, name: nil, timeout: 60)
      session = JSON.parse(File.read(File.join(File.expand_path(directory), SESSION)))
      uri = URI(session['url'])
      http = Net::HTTP.new(uri.host, uri.port)
      headers = {'X-QA-Token' => session['token'], 'Content-Type' => 'application/json'}
      id = JSON.parse(http.post('/control', JSON.generate(action: action, name: name.to_s), headers).body)['id']
      raise 'The capture helper rejected the command' unless id
      started = Time.now
      loop do
        response = http.get("/result/#{id}", headers)
        result = JSON.parse(response.body)
        return result unless response.code == '202'
        waited = Time.now - started
        raise 'The recorder page is not open. Open the recorder URL in Chrome and keep that tab open.' if !result['page_connected'] && waited > 5
        raise "The recorder did not finish #{action} within #{timeout} seconds" if waited > timeout
        sleep 0.2
      end
    end

    # Waits until the user has shared a tab from the recorder page.
    def wait_ready(directory:, timeout: 180)
      deadline = Time.now + timeout
      loop do
        status = call(directory: directory, action: 'status', timeout: 10)
        return status if status['ok'] && status.dig('value', 'ready')
        raise 'No tab was shared before the timeout' if Time.now > deadline
        sleep 1
      end
    end

    def wait_request(directory:, timeout: 120)
      session = JSON.parse(File.read(File.join(File.expand_path(directory), SESSION)))
      uri = URI(session.fetch('url'))
      headers = {'X-QA-Token' => session.fetch('token')}
      deadline = Time.now + timeout
      loop do
        response = Net::HTTP.start(uri.host, uri.port) { |http| http.get('/requests/next', headers) }
        return JSON.parse(response.body) if response.code == '200'
        raise 'The enhancement helper rejected the request wait' unless response.code == '204'
        return {'timeout' => true} if Time.now >= deadline
      end
    end
  end
end

if $PROGRAM_NAME == __FILE__ && ARGV.first == 'control'
  ARGV.shift
  options = {}
  OptionParser.new do |parser|
    parser.banner = "Usage: ruby qa_capture.rb control --out <capture-directory> <#{QACapture::ACTIONS.join('|')}|wait-ready|wait-request> [--name NAME] [--timeout SECONDS]"
    parser.on('--out PATH') { |value| options[:directory] = value }
    parser.on('--name NAME') { |value| options[:name] = value }
    parser.on('--timeout SECONDS', Integer) { |value| options[:timeout] = value }
  end.parse!
  action = ARGV.shift
  abort 'Provide --out <capture-directory> and an action' unless options[:directory] && action
  abort "Unknown action #{action}" unless %w[wait-ready wait-request].include?(action) || QACapture::ACTIONS.include?(action)
  begin
    result = if action == 'wait-request'
      puts JSON.generate(QACapture::Client.wait_request(directory: options[:directory], timeout: options[:timeout] || 120))
      exit 0
    elsif action == 'wait-ready'
      QACapture::Client.wait_ready(directory: options[:directory], timeout: options[:timeout] || 180)
    else
      QACapture::Client.call(directory: options[:directory], action: action, name: options[:name], timeout: options[:timeout] || 60)
    end
    puts JSON.generate(result)
    exit(result['ok'] ? 0 : 1)
  rescue StandardError => error
    warn error.message
    exit 1
  end
elsif $PROGRAM_NAME == __FILE__
  options = {port: 0}
  OptionParser.new do |parser|
    parser.banner = 'Usage: ruby qa_capture.rb --out <capture-directory> [--report <review.html>] [--port 0]'
    parser.on('--out PATH') { |value| options[:directory] = value }
    parser.on('--report PATH') { |value| options[:report] = value }
    parser.on('--port NUMBER', Integer) { |value| options[:port] = value }
  end.parse!
  abort 'Provide --out <capture-directory>' unless options[:directory]
  server = QACapture::Server.new(**options)
  $stdout.sync = true
  puts options[:report] ? "Review with QA panel: #{server.url}/#overview" : "QA recorder: #{server.url}"
  puts "Local capture files: #{File.expand_path(options[:directory])}"
  puts "Control: ruby #{__FILE__} control --out #{File.expand_path(options[:directory])} <wait-request|wait-ready|start|still|stop|end|status|reload> [--name NAME]"
  begin
    server.run
  rescue Interrupt
    nil
  ensure
    server.close
  end
end
