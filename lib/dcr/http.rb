# frozen_string_literal: true

require 'json'
require 'uri'

module DCR
  # The little HTTP/1.1 the review server speaks: one request per connection, no chunked bodies.
  # Ruby has no HTTP server in its standard library, so parsing and limits live here, in one place.
  module HTTP
    # The policy for anything that is not the review page itself (the recorder page, errors).
    STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; media-src blob:; img-src 'self' blob:; frame-ancestors 'none'"
    HEADERS_LIMIT = 16_384
    CONTROL_LIMIT = 65_536
    REASONS = {200 => 'OK', 202 => 'Accepted', 204 => 'No Content', 400 => 'Bad Request', 404 => 'Not Found', 502 => 'Bad Gateway'}.freeze

    # target is the request path with its query. arrival is :local or :shared (the tailnet), and
    # own_origin the origin a page opened that way sends, so writes can be held to it.
    class Request
      attr_reader :method, :target, :headers, :socket, :arrival, :own_origin

      def initialize(method:, target:, headers:, socket:, arrival: :local, own_origin: nil)
        @method, @target, @headers, @socket, @arrival, @own_origin = method, target, headers, socket, arrival, own_origin
      end

      def self.read(socket)
        method, target, version = socket.gets("\r\n", 4096).to_s.split
        raise ArgumentError, 'Invalid HTTP request' unless version == 'HTTP/1.1' && target
        headers = {}; size = 0
        while (line = socket.gets("\r\n", 4096)) && line != "\r\n"
          size += line.bytesize
          raise ArgumentError, 'Headers too large' if size > HEADERS_LIMIT
          key, value = line.split(':', 2)
          raise ArgumentError, 'Invalid header' unless value
          headers[key.downcase] = value.strip
        end
        new(method: method, target: target, headers: headers, socket: socket)
      end

      def with(arrival:, own_origin:) = self.class.new(method: method, target: target, headers: headers, socket: socket, arrival: arrival, own_origin: own_origin)

      def get? = method == 'GET'
      def post? = method == 'POST'
      def path = target.split('?', 2).first
      def query = URI.decode_www_form(target.split('?', 2)[1].to_s).to_h
      def shared? = arrival == :shared
      def origin = headers['origin']
      def token = headers['x-qa-token']
      # The terminal sends no Origin; a page must send its own.
      def from_page? = origin == own_origin
      def from_page_or_terminal? = origin.nil? || from_page?
      def length = Integer(headers.fetch('content-length'))

      def body(limit)
        size = length
        raise ArgumentError, "Request body must be between 1 byte and #{limit} bytes" unless size.between?(1, limit)
        raise ArgumentError, 'Chunked bodies are unsupported' if headers['transfer-encoding']
        read_exactly(size, 'Incomplete request body')
      end

      # The recorder and work-queue messages: small JSON.
      def control_body
        size = length
        raise ArgumentError, 'Control message too large' unless size.between?(1, CONTROL_LIMIT)
        read_exactly(size, 'Incomplete control message')
      end

      def json(limit = nil) = JSON.parse(limit ? body(limit) : control_body)

      private

      def read_exactly(size, message)
        data = socket.read(size)
        raise ArgumentError, message unless data&.bytesize == size
        data
      end
    end

    Response = Struct.new(:code, :body, :type, :csp, :headers) do
      def write(socket)
        extra = (headers || {}).map { |name, value| "#{name}: #{value}\r\n" }.join
        socket.write("HTTP/1.1 #{code} #{REASONS.fetch(code, 'Error')}\r\nContent-Type: #{type}\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: #{csp || STRICT_CSP}\r\n#{extra}\r\n")
        socket.write(body)
      end
    end

    module_function

    def json(payload, code: 200, csp: nil) = Response.new(code, JSON.generate(payload), 'application/json', csp)
    def html(body, csp:, headers: nil) = Response.new(200, body, 'text/html; charset=utf-8', csp, headers)
    def text(code, body, csp: nil) = Response.new(code, body, 'text/plain', csp)
    def empty = Response.new(204, '', 'text/plain')
    def not_found(csp: nil) = text(404, 'Not found', csp: csp)
  end
end
