# frozen_string_literal: true

require 'json'
require 'net/http'
require 'securerandom'
require 'time'
require_relative 'http'

module DCR
  # The QA recorder's side of the server: its page and scripts, the command queue the terminal
  # drives it with (`dcr record`), the work queue a live review asks the agent through, and the
  # uploads of what it captured. No browser automation or encoder dependency.
  class Recorder
    LIMIT = 24 * 1024 * 1024
    ACTIONS = %w[start stop still end status reload].freeze
    SESSION = '.qa-session.json' # in the capture folder: where the terminal client finds the server
    ASSETS = File.expand_path('../../recorder', __dir__)
    PAGES = {'/' => ['index.html', 'text/html; charset=utf-8'], '/recorder.js' => ['recorder.js', 'text/javascript'], '/qa-panel.js' => ['qa-panel.js', 'text/javascript'], '/style.css' => ['style.css', 'text/css']}.freeze

    attr_reader :directory

    def initialize(directory:, token:, url:)
      @directory = directory
      @token = token
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
      File.open(session, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(JSON.generate(url: url, token: token)) }
    end

    def call(request)
      path = request.target
      if request.get? && !path.start_with?('/next', '/result/', '/requests/')
        asset, type = PAGES[path]
        return HTTP.not_found unless asset
        return HTTP::Response.new(200, File.binread(File.join(ASSETS, asset)).sub('__QA_TOKEN__', @token), type)
      end
      raise ArgumentError, 'Invalid capture token' unless request.token == @token
      return requests(request) if %w[/request /presence /requests/next].include?(path)
      return control(request) if path == '/next' || path == '/control' || path.start_with?('/result/')
      upload(request)
    end

    private

    def upload(request)
      raise ArgumentError, 'Only same-origin capture uploads are accepted' unless request.post? && request.from_page?
      # The final frame of a clip, saved beside it as its poster (the thumbnail in the review).
      if (clip = request.target[%r{\A/save-poster/([a-z0-9_-]{1,80}-[0-9a-f]{8})\.png\z}, 1])
        raise ArgumentError, 'No such clip' unless File.file?(File.join(@directory, "#{clip}.webm"))
        return save(request, File.join(@directory, "#{clip}.poster.png"))
      end
      match = request.target.match(%r{\A/save/([a-z0-9_-]{1,80})\.(png|webm|json)\z})
      raise ArgumentError, 'Invalid capture filename' unless match
      save(request, File.join(@directory, "#{match[1]}-#{SecureRandom.hex(4)}.#{match[2]}"))
    end

    def save(request, output)
      length = request.length
      raise ArgumentError, 'Capture must be between 1 byte and 24 MiB' unless length.positive? && length <= LIMIT
      raise ArgumentError, 'Chunked uploads are unsupported' if request.headers['transfer-encoding']
      begin
        File.open(output, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
          remaining = length
          while remaining.positive?
            bytes = request.socket.read([remaining, 65536].min)
            raise ArgumentError, 'Incomplete capture upload' unless bytes && !bytes.empty?
            file.write(bytes); remaining -= bytes.bytesize
          end
        end
      rescue StandardError
        File.unlink(output) if File.file?(output)
        raise
      end
      HTTP.json({path: output, bytes: length})
    end

    # A live report submits optional work. The terminal waits on this queue without
    # polling the browser or starting media capture before the reader requests it.
    def requests(request)
      path = request.target
      if request.get? && path == '/requests/next'
        raise ArgumentError, 'Browser cannot read the work queue' if request.origin
        event = @lock.synchronize do
          @signal.wait(@lock, @page_closed_at ? 3 : 10) if @requests.empty?
          stale = @last_presence && Time.now - @last_presence > 45
          closed = @page_closed_at && Time.now - @page_closed_at > 3
          @requests.shift || (closed || stale ? {'closed' => true} : nil)
        end
        return event ? HTTP.json(event) : HTTP.empty
      end
      raise ArgumentError, 'Only the live review may request work' unless request.from_page?
      if request.post? && path == '/presence'
        input = request.json
        raise ArgumentError, 'Invalid presence event' unless %w[open closed].include?(input['state'])
        @lock.synchronize do
          @last_presence = Time.now
          @page_closed_at = input['state'] == 'closed' ? Time.now : nil
          @signal.broadcast
        end
        return HTTP.json({})
      end
      if request.post? && path == '/request'
        input = request.json
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
        return HTTP.json(event)
      end
      HTTP.not_found
    end

    # GET /next and POST /result/<id> come from the recorder page; POST /control and
    # GET /result/<id> come from the terminal client, which sends no Origin header.
    def control(request)
      raise ArgumentError, 'Cross-origin control rejected' unless request.from_page_or_terminal?
      path = request.target
      id = path[%r{\A/result/([a-f0-9]{16})\z}, 1]
      if request.get? && path == '/next'
        # Long poll: a hidden recorder tab's timers are throttled, but a pending fetch is not.
        # Several review pages may be open; a recorder command belongs to the one sharing its tab.
        sharing = request.headers['x-qa-sharing'] == '1'
        command = @lock.synchronize do
          deadline = Time.now + 10
          loop do
            @last_poll = Time.now
            @last_sharing_poll = Time.now if sharing
            taken = take_command(sharing)
            break taken if taken || Time.now >= deadline
            @signal.wait(@lock, deadline - Time.now)
          end
        end
        command ? HTTP.json(command) : HTTP.empty
      elsif request.post? && path == '/control'
        input = request.json
        raise ArgumentError, 'Unknown recorder action' unless ACTIONS.include?(input['action'])
        name = input['name'].to_s
        raise ArgumentError, 'Invalid evidence name' unless name.empty? || name.match?(/\A[a-z0-9_-]{1,80}\z/)
        command = {id: SecureRandom.hex(8), action: input['action'], name: name}
        @lock.synchronize { @commands << command; @signal.broadcast }
        HTTP.json({id: command[:id]})
      elsif request.post? && id
        raise ArgumentError, 'Only the recorder page reports results' unless request.from_page?
        result = request.json
        @lock.synchronize { @results[id] = result }
        HTTP.json({})
      elsif request.get? && id
        result, connected = @lock.synchronize { [@results.delete(id), @last_poll && Time.now - @last_poll < 12] }
        return HTTP.json(result) if result
        HTTP.json({pending: true, page_connected: !!connected}, code: 202)
      else
        HTTP.not_found
      end
    end

    # A page that is not sharing takes a command only when no sharing page has polled lately, so a
    # second open review page cannot swallow the agent's `dcr record start`.
    def take_command(sharing)
      return nil if @commands.empty?
      sharer_present = @last_sharing_poll && Time.now - @last_sharing_poll < 12
      sharing || !sharer_present ? @commands.shift : nil
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
end
