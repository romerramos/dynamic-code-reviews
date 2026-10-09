# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'securerandom'
require 'socket'
require 'timeout'
require_relative 'http'
require_relative 'recorder'

module DCR
  # The loopback server behind `dcr serve`. It owns the socket, the addresses a request may arrive
  # on (this computer, or the tailnet for allowed logins) and the token; what a request means is up
  # to its handlers: the served review (ReviewSite) when there is one, then the QA recorder.
  class Server
    ENDPOINT = '.serve.json' # in the series: the served review's port and token, reused on restart

    attr_reader :port, :token, :shared_origin, :share_note

    # report: a review HTML (normally .reviews/<series>/current.html) served at / with the
    # QA panel, so the reader starts capture from the review instead of a separate page.
    # directory: where the recorder saves captures.
    # app: the running app's URL, shown inside the review through a proxy.
    # share: also serve the review (and the running app inside it) on the tailnet with Tailscale Serve,
    # answering only the tailnet logins in share_with plus the computer's own user.
    def initialize(directory:, port: 0, report: nil, app: nil, app_ca: nil, share: false, share_with: [])
      directory = File.expand_path(directory)
      raise ArgumentError, 'Capture output must not be a symlink' if File.symlink?(directory)
      if report
        report = File.expand_path(report)
        raise ArgumentError, 'The review report must be an existing HTML file' unless report.end_with?('.html') && File.file?(report) && !File.symlink?(report)
        @report = report
        @endpoint = File.join(File.dirname(report), ENDPOINT)
      end
      raise ArgumentError, '--app needs a served review (--report or --name)' if app && !report
      FileUtils.mkdir_p(directory)
      # A served review comes back at the same address with the same token after a restart,
      # so a page the reviewer still has open keeps working. A taken port falls back to a new one.
      saved = endpoint
      @token = saved['token'].to_s.match?(/\A\h{48}\z/) ? saved['token'] : SecureRandom.hex(24)
      @socket = listen(port.zero? ? saved['port'].to_i : port)
      @port = @socket.addr[1]
      @origin = "http://127.0.0.1:#{@port}"
      @app = proxy(app, app_ca, saved['app_port'].to_i) if app
      share_on_tailnet(share_with) if share
      save_endpoint if @endpoint
      @recorder = Recorder.new(directory: directory, token: @token, url: @origin)
      if report
        require_relative 'review_site'
        @site = ReviewSite.new(report: report, capture_dir: directory, token: @token, origin: @origin, app: @app, on_first_view: method(:bring_forward))
      end
    end

    def url = @origin
    def app_url = @app && "#{@app.origin}#{@app.start_path}"

    def close
      (@shared_ports || []).each { |port| DCR::Share.withdraw(port) }
      @app&.close
      @socket.close
    end

    def run
      Thread.new { @app.run } if @app
      loop do
        # One thread per connection so the page's long poll never blocks uploads or commands.
        Thread.new(@socket.accept) do |client|
          Timeout.timeout(15) { serve(client) }
        rescue Timeout::Error
          # Browsers open idle connections ahead of time; answering one with an error would
          # show that error for whichever navigation later reuses the socket.
          nil
        rescue StandardError => error
          HTTP.json({error: error.message}, code: 400).write(client) rescue nil
        ensure
          client.close
        end
      end
    rescue IOError, Errno::EBADF
      nil
    end

    private

    def serve(client)
      request = HTTP::Request.read(client)
      arrival = arrival(request.headers)
      request = request.with(arrival: arrival, own_origin: arrival == :shared ? @shared_origin : @origin)
      response = @site&.call(request) || @recorder.call(request)
      response.write(client)
    end

    # The address a request came in on, checked: the loopback one, or the tailnet one for allowed logins.
    def arrival(headers)
      return :local if headers['host'] == "127.0.0.1:#{@port}"
      raise ArgumentError, 'Invalid Host' unless @shared_host && headers['host'] == @shared_host
      raise ArgumentError, 'This review is not shared with you' unless @allowed.include?(headers['tailscale-user-login'].to_s)
      :shared
    end

    def endpoint
      return {} unless @endpoint && File.file?(@endpoint) && !File.symlink?(@endpoint)
      value = JSON.parse(File.read(@endpoint))
      value.is_a?(Hash) ? value : {}
    rescue JSON::ParserError
      {}
    end

    def save_endpoint
      File.open(@endpoint, File::WRONLY | File::CREAT | File::TRUNC, 0o600) { |file| file.write(JSON.generate(port: @port, token: @token, app_port: @app&.port, shared: @shared_origin)) }
      File.chmod(0o600, @endpoint)
    end

    def listen(port)
      TCPServer.new('127.0.0.1', port.between?(1, 65_535) ? port : 0)
    rescue Errno::EADDRINUSE
      TCPServer.new('127.0.0.1', 0)
    end

    def proxy(app, ca_file, saved_port)
      require_relative 'app_proxy'
      AppProxy.new(upstream: app, review_origin: @origin, ca_file: ca_file, port: saved_port)
    rescue Errno::EADDRINUSE
      AppProxy.new(upstream: app, review_origin: @origin, ca_file: ca_file)
    end

    # Tailscale Serve in front of both servers. Anything missing (no Tailscale, HTTPS certificates off)
    # leaves the review local and says why; sharing is never required to review.
    def share_on_tailnet(share_with)
      require_relative 'share'
      found = DCR::Share.check
      return @share_note = "Not shared on your tailnet: #{found['reason']}." unless found['ok']
      @allowed = ([found['login']] + Array(share_with)).map(&:to_s).reject(&:empty?).uniq
      @shared_host = "#{found['host']}:#{@port}"
      @shared_origin = DCR::Share.expose(@port, found['host'])
      @shared_ports = [@port]
      return unless @app
      app_origin = DCR::Share.expose(@app.port, found['host'])
      @shared_ports << @app.port
      @app.share!(host: "#{found['host']}:#{@app.port}", origin: app_origin, review_origin: @shared_origin, allowed: @allowed)
    rescue ArgumentError => error
      @share_note = "Not shared on your tailnet: #{error.message}."
    end

    # The first time the review page loads, raise the browser showing it, so the reviewer notices
    # it is ready even while busy elsewhere. Failures stay quiet (dcr focus says why).
    def bring_forward
      return if ENV['DCR_FOCUS'] == '0'
      require_relative 'focus'
      Thread.new do
        sleep 1.5 # let the tab take the address and the page its title
        DCR::Focus.front(DCR::Focus.prefixes(@port, @shared_origin), title: DCR::Focus.title_of(@report))
      rescue StandardError
        nil
      end
    end
  end
end
