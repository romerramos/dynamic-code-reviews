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
require 'tmpdir'
require 'shellwords'
require_relative '../lib/dcr/live_api'

module QACapture
  LIMIT = 24 * 1024 * 1024
  ACTIONS = %w[start stop still end status reload].freeze
  SESSION = '.qa-session.json'
  ENDPOINT = '.serve.json' # in the series: the served review's port and token, reused on restart
  ASSETS = File.expand_path('../recorder', __dir__)
  LIVE_ASSETS = File.expand_path('../live', __dir__)
  PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; media-src blob:; img-src 'self' blob:; frame-ancestors 'none'"
  # The served review keeps its own inline scripts and embedded media, and may also load
  # the QA panel and talk to this helper. The saved HTML file keeps its stricter offline policy.
  REPORT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  class Server
    attr_reader :port, :token

    # report: a review HTML (normally .reviews/<series>/current.html) served at / with the
    # QA panel, so the reader starts capture from the review instead of a separate page.
    # share: also serve the review (and the running app inside it) on the tailnet with Tailscale Serve,
    # answering only the tailnet logins in share_with plus the computer's own user.
    def initialize(directory:, port: 0, report: nil, app: nil, app_ca: nil, share: false, share_with: [])
      @directory = File.expand_path(directory)
      raise ArgumentError, 'Capture output must not be a symlink' if File.symlink?(@directory)
      if report
        @report = File.expand_path(report)
        raise ArgumentError, 'The review report must be an existing HTML file' unless @report.end_with?('.html') && File.file?(@report) && !File.symlink?(@report)
        # A served report keeps its conversation threads and progress beside it, in the series.
        series_dir = File.dirname(@report)
        attach = lambda do |input|
          require_relative '../lib/dcr/evidence'
          # {items: [...]} saves a session's recordings as one revision; a single object still works.
          if input.key?('items') then DCR::Evidence.attach_all(series_dir: series_dir, capture_dir: @directory, inputs: input['items'])
          else DCR::Evidence.attach(series_dir: series_dir, capture_dir: @directory, input: input)
          end
        end
        @live = DCR::LiveAPI.new(series_dir, evidence: attach)
        @endpoint = File.join(series_dir, ENDPOINT)
      end
      FileUtils.mkdir_p(@directory)
      # A served review comes back at the same address with the same token after a restart,
      # so a page the reviewer still has open keeps working. A taken port falls back to a new one.
      saved = endpoint
      @token = saved['token'].to_s.match?(/\A\h{48}\z/) ? saved['token'] : SecureRandom.hex(24)
      @socket = listen(port.zero? ? saved['port'].to_i : port)
      @port = @socket.addr[1]
      @origin = "http://127.0.0.1:#{@port}"
      if app
        raise ArgumentError, '--app needs a served review (--report or --name)' unless @live
        require_relative '../lib/dcr/app_proxy'
        app_port = saved['app_port'].to_i
        @app = begin
          DCR::AppProxy.new(upstream: app, review_origin: @origin, ca_file: app_ca, port: app_port)
        rescue Errno::EADDRINUSE
          DCR::AppProxy.new(upstream: app, review_origin: @origin, ca_file: app_ca)
        end
      end
      share_on_tailnet(share_with) if share
      if @endpoint
        File.open(@endpoint, File::WRONLY | File::CREAT | File::TRUNC, 0o600) { |file| file.write(JSON.generate(port: @port, token: @token, app_port: @app&.port, shared: @shared_origin)) }
        File.chmod(0o600, @endpoint)
      end
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

    def endpoint
      return {} unless @endpoint && File.file?(@endpoint) && !File.symlink?(@endpoint)
      value = JSON.parse(File.read(@endpoint))
      value.is_a?(Hash) ? value : {}
    rescue JSON::ParserError
      {}
    end

    def listen(port)
      TCPServer.new('127.0.0.1', port.between?(1, 65_535) ? port : 0)
    rescue Errno::EADDRINUSE
      TCPServer.new('127.0.0.1', 0)
    end

    attr_reader :shared_origin, :share_note

    # Tailscale Serve in front of both servers. Anything missing (no Tailscale, HTTPS certificates off)
    # leaves the review local and says why; sharing is never required to review.
    def share_on_tailnet(share_with)
      require_relative '../lib/dcr/share'
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

    # The address a request came in on, checked: the loopback one, or the tailnet one for allowed logins.
    def arrival(headers)
      return :local if headers['host'] == "127.0.0.1:#{@port}"
      raise ArgumentError, 'Invalid Host' unless @shared_host && headers['host'] == @shared_host
      raise ArgumentError, 'This review is not shared with you' unless @allowed.include?(headers['tailscale-user-login'].to_s)
      :shared
    end

    # The page's own origin for the way it was opened; writes must come from it (or from the terminal).
    def own_origin?(origin) = origin == (Thread.current[:dcr_arrival] == :shared ? @shared_origin : @origin)

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
      Thread.current[:dcr_arrival] = arrival(headers)
      return live_api(client, method, path, headers) if @live && path.start_with?('/api/')
      if method == 'GET' && !path.start_with?('/next', '/result/', '/requests/')
        page = path.split('?', 2).first # `/?app` opens the review straight into the running app
        return serve_preview(client, path) if @live && page == '/preview'
        return serve_report(client, page) if @report && (page == '/' || page.match?(%r{\A/(?:revisions/)?[a-z0-9_-]+\.html\z}))
        asset, type = {'/' => ['index.html', 'text/html; charset=utf-8'], '/recorder.js' => ['recorder.js', 'text/javascript'], '/qa-panel.js' => ['qa-panel.js', 'text/javascript'], '/style.css' => ['style.css', 'text/css']}[path]
        live_asset, live_type = {'/live-tools.js' => ['live-tools.js', 'text/javascript'], '/live.js' => ['live.js', 'text/javascript'], '/live.css' => ['live.css', 'text/css'], '/try-band.js' => ['try-band.js', 'text/javascript']}[path] if @live
        live_asset, live_type = {'/app-view.js' => ['app-view.js', 'text/javascript'], '/app-view.css' => ['app-view.css', 'text/css']}[path] if @app && !live_asset
        return respond(client, 200, File.binread(File.join(LIVE_ASSETS, live_asset)), live_type, report_csp) if live_asset
        return respond(client, 404, 'Not found', 'text/plain') unless asset
        content = File.binread(File.join(ASSETS, asset)).sub('__QA_TOKEN__', @token)
        return respond(client, 200, content, type)
      end
      raise ArgumentError, 'Invalid capture token' unless headers['x-qa-token'] == @token
      return requests(client, method, path, headers) if path == '/request' || path == '/presence' || path == '/requests/next'
      return control(client, method, path, headers) if path == '/next' || path == '/control' || path.start_with?('/result/')
      raise ArgumentError, 'Only same-origin capture uploads are accepted' unless method == 'POST' && own_origin?(headers['origin'])
      # The final frame of a clip, saved beside it as its poster (the thumbnail in the review).
      if (clip = path[%r{\A/save-poster/([a-z0-9_-]{1,80}-[0-9a-f]{8})\.png\z}, 1])
        raise ArgumentError, 'No such clip' unless File.file?(File.join(@directory, "#{clip}.webm"))
        return save_upload(client, headers, File.join(@directory, "#{clip}.poster.png"))
      end
      match = path.match(%r{\A/save/([a-z0-9_-]{1,80})\.(png|webm|json)\z})
      raise ArgumentError, 'Invalid capture filename' unless match
      save_upload(client, headers, File.join(@directory, "#{match[1]}-#{SecureRandom.hex(4)}.#{match[2]}"))
    end

    def save_upload(client, headers, output)
      length = Integer(headers.fetch('content-length'))
      raise ArgumentError, 'Capture must be between 1 byte and 24 MiB' unless length.positive? && length <= LIMIT
      raise ArgumentError, 'Chunked uploads are unsupported' if headers['transfer-encoding']
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
      raise ArgumentError, 'Only the live review may request work' unless own_origin?(headers['origin'])
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
      raise ArgumentError, 'Cross-origin control rejected' unless headers['origin'].nil? || own_origin?(headers['origin'])
      id = path[%r{\A/result/([a-f0-9]{16})\z}, 1]
      if method == 'GET' && path == '/next'
        # Long poll: a hidden recorder tab's timers are throttled, but a pending fetch is not.
        # Several review pages may be open; a recorder command belongs to the one sharing its tab.
        sharing = headers['x-qa-sharing'] == '1'
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
        command ? respond(client, 200, JSON.generate(command), 'application/json') : respond(client, 204, '', 'text/plain')
      elsif method == 'POST' && path == '/control'
        request = JSON.parse(small_body(client, headers))
        raise ArgumentError, 'Unknown recorder action' unless ACTIONS.include?(request['action'])
        name = request['name'].to_s
        raise ArgumentError, 'Invalid evidence name' unless name.empty? || name.match?(/\A[a-z0-9_-]{1,80}\z/)
        command = {id: SecureRandom.hex(8), action: request['action'], name: name}
        @lock.synchronize { @commands << command; @signal.broadcast }
        respond(client, 200, JSON.generate(id: command[:id]), 'application/json')
      elsif method == 'POST' && id
        raise ArgumentError, 'Only the recorder page reports results' unless own_origin?(headers['origin'])
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

    # A page that is not sharing takes a command only when no sharing page has polled lately, so a
    # second open review page cannot swallow the agent's `dcr record start`.
    def take_command(sharing)
      return nil if @commands.empty?
      sharer_present = @last_sharing_poll && Time.now - @last_sharing_poll < 12
      sharing || !sharer_present ? @commands.shift : nil
    end

    # The served review's conversation routes. Same token and origin rules as recorder
    # control: the page sends its own origin, the terminal sends none, a foreign page fails.
    def live_api(client, method, path, headers)
      raise ArgumentError, 'Invalid review token' unless headers['x-qa-token'] == @token
      raise ArgumentError, 'Cross-origin review request rejected' unless headers['origin'].nil? || own_origin?(headers['origin'])
      raise ArgumentError, 'Writes must come from the review page or the terminal' unless method == 'GET' || method == 'POST'
      if method == 'GET' && path == '/api/export'
        require_relative '../lib/dcr/export'
        html, _warnings = DCR::Export.html(File.dirname(@report))
        name = "#{File.basename(File.dirname(@report))}-review.html"
        return respond(client, 200, html, 'text/html; charset=utf-8', REPORT_CSP, "Content-Disposition: attachment; filename=\"#{name}\"")
      end
      body = -> { read_body(client, headers, DCR::LiveAPI::BODY_LIMIT) }
      if method == 'POST' && path == '/api/qa'
        input = JSON.parse(body.call)
        raise ArgumentError, 'Expected a JSON object' unless input.is_a?(Hash)
        return respond(client, 200, JSON.generate(qa_request(input)), 'application/json', REPORT_CSP)
      end
      code, payload = @live.call(method, path, body)
      respond(client, code, JSON.generate(payload), 'application/json', REPORT_CSP)
    end

    # Start QA review: the reviewer has shared this tab (cut to the app) and asks the agent to record
    # evidence for the review. The server writes the request, because only it knows the recorder
    # folder, the review's address, the app and the comments, and it fixes the rules the agent follows.
    def qa_request(input)
      require_relative 'series'
      key = input['key'].to_s
      series_dir = File.dirname(@report)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      payload = ReviewSeries.latest(series_dir, ReviewSeries.manifest(series_dir))
      review = payload['review']
      flags = "--repo #{Shellwords.escape(manifest.fetch('repo'))} --name #{Shellwords.escape(manifest.fetch('name'))}"
      dcr = Shellwords.escape(File.expand_path('../bin/dcr', __dir__))
      out = Shellwords.escape(@directory)
      paths = Array(payload.dig('snapshot', 'files')).flat_map { |file| Array(file['hunks']).map { |hunk| [hunk['id'], file['path']] } }.to_h
      comments = Array(review['comments']).map do |comment|
        where = paths[comment['hunk']] ? " (#{paths[comment['hunk']]}, lines #{comment['start']}-#{comment['end']})" : ''
        "- #{comment['id']}: #{comment['label']}, #{comment['decoration']}: #{comment['subject']}#{where}"
      end
      # Comments on elements; older ones carry no kind, recordings and QA requests are left out.
      threads = (@live.state.read.dig('threads', key) || {}).select { |id, thread| id.start_with?('app-') && !thread.dig('anchor', 'selector').to_s.empty? && !%w[clip still request].include?(thread.dig('anchor', 'kind')) }
      app_comments = threads.map { |id, thread| "- #{id}: on #{thread.dig('anchor', 'path')}, #{thread.dig('anchor', 'selector')} (\"#{thread.dig('anchor', 'text')}\"): #{thread['messages'].first&.dig('body').to_s.lines.first.to_s.strip}" }
      id = "app-qa-#{SecureRandom.hex(4)}"
      text = <<~TEXT
        The reviewer pressed Start QA review. Record visual evidence for this review now, in one pass, while they watch.

        Where: the review is open at #{@origin}/?app#overview in the reviewer's browser, and its App view shows the running app (#{@app ? @app.describe[:upstream] : 'no app'}), currently at #{input['route'].to_s.empty? ? '/' : input['route']}. The reviewer already shared that tab with the recorder, cut down to the app, so recording needs no prompt.

        How:
        - Act in that very tab with your browser tool. If it cannot reach the tab (for example Claude in Chrome only reaches tabs in its own group), reply in this thread asking the reviewer to open the review from your tool's tab and press Start QA review there; do not record another tab.
        - Start, stop and snapshot only with the `dcr record` commands below. While they drive the recorder, the review draws your pointer and a ring on each click inside the app, at the coordinates of the input you send, so a tool that never moves the system pointer (DevTools protocol, Playwright, Claude in Chrome) still records a clip a viewer can follow. A computer-use tool that moves the real pointer is shown as it is. Never add a cursor to a recording afterwards.
        - Move to an element before clicking it (hover, then click), at a human pace, so the pointer travels the way a person's would.
        - The app is the large pane in the middle of the App view; act inside it. Change the page with the address field at the top of the App view. Do not close the App view, reload the review or open another tab.
        - If the app asks you to log in, log in inside the pane with the project's development seed account. Use only development data.

        What: for each item below that a viewer would understand better by seeing it, record one short clip; skip items that are about code only, and say why.
        1. Bring the app to the starting state first; that part is not recorded.
        2. #{dcr} record --out #{out} start --name <item id>
        3. Do the steps at a human pace, about a second per action, and hold one second on the result.
        4. #{dcr} record --out #{out} stop        (prints the saved file's path; `still --name <id>` saves a PNG instead)

        Review comments:
        #{comments.empty? ? '- (none)' : comments.join("\n")}

        Comments on the app:
        #{app_comments.empty? ? '- (none)' : app_comments.join("\n")}

        Also record any changed user flow that has no comment, if seeing it helps.

        Attach everything in one go, which saves one revision the open review offers to the reviewer. This QA review replaces the clips of any previous QA review (the reviewer's own recordings stay), so record every item worth showing now, not only what is new:
        #{dcr} evidence attach #{flags} --file <items.json>
        items.json: [{"path": "<saved file>", "comment_id": "<review comment id, or omit>", "title": "<what the clip shows>", "result": "passed or failed", "observed": "<one sentence on what you saw>", "page": "<app path>"}]
        Use a review comment's id as comment_id so the clip appears on that comment. For a comment on the app, put its id in the title and reply in that thread with what you saw.

        Then reply to this thread: #{dcr} reply #{flags} #{id} '<what you recorded, what you skipped and why>'
      TEXT
      @live.state.request_qa(key, id, text)
      {'id' => id}
    end

    def read_body(client, headers, limit)
      length = Integer(headers.fetch('content-length'))
      raise ArgumentError, "Request body must be between 1 byte and #{limit} bytes" unless length.between?(1, limit)
      raise ArgumentError, 'Chunked bodies are unsupported' if headers['transfer-encoding']
      body = client.read(length)
      raise ArgumentError, 'Incomplete request body' unless body&.bytesize == length
      body
    end

    def small_body(client, headers)
      length = Integer(headers.fetch('content-length'))
      raise ArgumentError, 'Control message too large' unless length.between?(1, 65_536)
      body = client.read(length)
      raise ArgumentError, 'Incomplete control message' unless body&.bytesize == length
      body
    end

    # One drawn template preview on its own page, so the agent can look at what it submitted before the
    # reviewer does. Read-only and loopback-only, like the review page itself; the preview has no scripts.
    def serve_preview(client, path)
      asked = URI.decode_www_form(path.split('?', 2)[1].to_s).to_h['path'].to_s
      previews = @live.state.read['previews']
      # A ViewComponent's class and template share one preview, saved under whichever was asked for.
      sibling = asked.sub(/_component\.rb\z/, '_component.html.erb').then { |other| other == asked ? asked.sub(/_component\.html\.erb\z/, '_component.rb') : other }
      key, wanted = [asked, sibling].uniq.flat_map { |candidate| previews.keys.select { |name| previews.dig(name, candidate, 'status') == 'ready' }.map { |name| [name, candidate] } }
                                   .max_by { |name, _| name.split(':').last.to_i }
      return respond(client, 404, 'No ready preview of that template', 'text/plain') unless key
      respond(client, 200, previews.dig(key, wanted, 'html'), 'text/html; charset=utf-8', report_csp)
    end

    # / is the current review with the QA panel; sibling revision pages are served as
    # saved, so the review's own history links keep working.
    def serve_report(client, path)
      file = path == '/' ? @report : File.join(File.dirname(@report), path.delete_prefix('/'))
      return respond(client, 404, 'Not found', 'text/plain') unless File.file?(file) && !File.symlink?(file)
      html = File.read(file, encoding: 'UTF-8').sub(/<meta http-equiv="Content-Security-Policy"[^>]*>/i) do
        %(<meta http-equiv="Content-Security-Policy" content="#{report_csp}">)
      end
      if path == '/'
        bring_forward
        # Saved progress and settings go in first, ahead of the early theme script and the
        # review script, which each read them once on load.
        html = html.dup.insert(html.index('<title>') || html.index('<script') || 0, @live.bootstrap_script) if @live
        panel = %(<meta name="qa-token" content="#{@token}"><link rel="stylesheet" href="/style.css"><script src="/qa-panel.js"></script><script src="/recorder.js"></script>)
        panel += %(<link rel="stylesheet" href="/live.css"><script src="/live-tools.js"></script><script src="/live.js"></script>) if @live
        panel += %(<meta name="dcr-app" content="#{JSON.generate(@app.describe(shared: Thread.current[:dcr_arrival] == :shared)).gsub('"', '&quot;')}"><link rel="stylesheet" href="/app-view.css"><script src="/app-view.js"></script>) if @app
        panel += %(<script src="/try-band.js"></script>) if @live
        at = html.rindex('</body>') || html.length
        html = html.dup.insert(at, panel)
      end
      respond(client, 200, html, 'text/html; charset=utf-8', report_csp)
    end

    # The first time the review page loads, raise the browser showing it, so the reviewer notices
    # it is ready even while busy elsewhere. Once per server; failures stay quiet (dcr focus says why).
    def bring_forward
      return if @brought_forward || !@live || ENV['DCR_FOCUS'] == '0'
      @brought_forward = true
      require_relative '../lib/dcr/focus'
      Thread.new do
        sleep 1.5 # let the tab take the address and the page its title
        DCR::Focus.front(DCR::Focus.prefixes(@port, @shared_origin), title: DCR::Focus.title_of(@report))
      rescue StandardError
        nil
      end
    end

    # The running app is the only page the review may frame.
    def report_csp = @app ? REPORT_CSP.sub("connect-src 'self';", "connect-src 'self'; frame-src #{@app.describe(shared: Thread.current[:dcr_arrival] == :shared)[:origin]};") : REPORT_CSP

    def respond(client, code, body, type, csp = PANEL_CSP, extra = nil)
      reason = {200 => 'OK', 202 => 'Accepted', 204 => 'No Content', 400 => 'Bad Request', 404 => 'Not Found'}.fetch(code, 'Error')
      client.write("HTTP/1.1 #{code} #{reason}\r\nContent-Type: #{type}\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: #{csp}\r\n#{extra ? "#{extra}\r\n" : ''}\r\n")
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
    parser.banner = 'Usage: ruby qa_capture.rb (--repo <root> --name <series> | --report <review.html>) [--out <capture-directory>] [--port 0] [--app URL [--app-ca PATH]]'
    parser.on('--out PATH', 'Where recordings are saved; a temporary directory when omitted') { |value| options[:directory] = value }
    parser.on('--report PATH') { |value| options[:report] = value }
    parser.on('--repo PATH', 'With --name: serve that series\' current review') { |value| options[:repo] = value }
    parser.on('--name SLUG') { |value| options[:name] = value }
    parser.on('--port NUMBER', Integer) { |value| options[:port] = value }
    parser.on('--app URL', 'The running app to show inside the review, like http://localhost:3000 or https://app.myproject.test') { |value| options[:app] = value }
    parser.on('--app-ca PATH', 'A local CA certificate the app\'s HTTPS uses (mkcert\'s root is found automatically)') { |value| options[:app_ca] = value }
    parser.on('--share', 'Also serve it on your tailnet with Tailscale Serve, for your own login; stays local when Tailscale cannot') { options[:share] = true }
    parser.on('--share-with LOGIN', 'Another tailnet login allowed to open the shared review (repeatable)') { |value| (options[:share_with] ||= []) << value }
  end.parse!
  if options[:name]
    abort 'Use a short lowercase series slug' unless options[:name].match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
    options[:report] ||= File.join(File.expand_path(options.fetch(:repo, Dir.pwd)), '.reviews', options[:name], 'current.html')
  end
  if options[:name]
    # A page saved by an older version lacks today's UI; rebuild its display files first.
    require_relative 'series'
    repo = options.fetch(:repo, Dir.pwd)
    abort 'No saved review for that series' unless File.file?(options[:report])
    unless File.read(options[:report])[/<meta name="dcr-ui" content="([0-9a-f]+)">/, 1] == DynamicReviews.ui_version
      ReviewSeries.refresh(repo: repo, name: options[:name])
      warn 'Refreshed the saved report with the current review UI. Saved revisions are unchanged.'
    end
  end
  options.delete(:repo)
  options.delete(:name)
  options[:directory] ||= Dir.mktmpdir('dcr-capture-')
  server = QACapture::Server.new(**options)
  $stdout.sync = true
  puts options[:report] ? "Review with QA panel: #{server.url}/#overview" : "QA recorder: #{server.url}"
  puts "App inside the review: #{server.url}/?app#overview (proxying #{options[:app]} through #{server.app_url})" if server.app_url
  puts 'Open the review in a tab your browser tool controls (Claude in Chrome: its tab group), so you can act in it when the reviewer presses Start QA review.' if server.app_url
  puts 'No --app: the review shows the older recorder card and has no Start QA review. Find the running app and serve again with --app <url>, or tell the reviewer why it is missing.' if options[:report] && !server.app_url
  puts "On your tailnet: #{server.shared_origin}/#overview (only for your Tailscale login#{options[:share_with] ? ' and the ones you shared it with' : ''})" if server.shared_origin
  puts server.share_note if server.share_note
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
