#!/usr/bin/env ruby
# frozen_string_literal: true

# Loopback-only capture helper. Ruby stdlib; no browser automation or encoder dependency.
require 'socket'
require 'json'
require 'optparse'
require 'securerandom'
require 'fileutils'
require 'timeout'

module QACapture
  LIMIT = 24 * 1024 * 1024
  ASSETS = File.expand_path('../recorder', __dir__)
  class Server
    attr_reader :port, :token

    def initialize(directory:, port: 0)
      @directory = File.expand_path(directory)
      raise ArgumentError, 'Capture output must not be a symlink' if File.symlink?(@directory)
      FileUtils.mkdir_p(@directory)
      @token = SecureRandom.hex(24)
      @socket = TCPServer.new('127.0.0.1', port)
      @port = @socket.addr[1]
      @origin = "http://127.0.0.1:#{@port}"
    end

    def url = @origin
    def close = @socket.close

    def run
      loop do
        client = @socket.accept
        begin
          Timeout.timeout(15) { serve(client) }
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
      if method == 'GET'
        asset, type = {'/' => ['index.html', 'text/html; charset=utf-8'], '/recorder.js' => ['recorder.js', 'text/javascript'], '/style.css' => ['style.css', 'text/css']}[path]
        return respond(client, 404, 'Not found', 'text/plain') unless asset
        content = File.binread(File.join(ASSETS, asset)).sub('__QA_TOKEN__', @token)
        return respond(client, 200, content, type)
      end
      raise ArgumentError, 'Only same-origin capture uploads are accepted' unless method == 'POST' && headers['origin'] == @origin && headers['x-qa-token'] == @token
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

    def respond(client, code, body, type)
      client.write("HTTP/1.1 #{code} #{code == 200 ? 'OK' : 'Error'}\r\nContent-Type: #{type}\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; media-src blob:; img-src 'self' blob:; frame-ancestors 'none'\r\n\r\n")
      client.write(body)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  options = {port: 0}
  OptionParser.new do |parser|
    parser.banner = 'Usage: ruby qa_capture.rb --out <capture-directory> [--port 0]'
    parser.on('--out PATH') { |value| options[:directory] = value }
    parser.on('--port NUMBER', Integer) { |value| options[:port] = value }
  end.parse!
  abort 'Provide --out <capture-directory>' unless options[:directory]
  server = QACapture::Server.new(**options)
  $stdout.sync = true
  puts "QA recorder: #{server.url}"
  puts "Local capture files: #{File.expand_path(options[:directory])}"
  begin
    server.run
  rescue Interrupt
    nil
  ensure
    server.close
  end
end
