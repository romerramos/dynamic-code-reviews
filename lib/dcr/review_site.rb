# frozen_string_literal: true

require_relative 'http'
require_relative 'live_api'
require_relative 'page'

module DCR
  # The served review: the current review page (rendered for serving), its saved sibling pages,
  # drawn template previews, the live scripts, and the JSON routes the page talks to.
  class ReviewSite
    LIVE = File.expand_path('../../live', __dir__)
    LIVE_ASSETS = {'/live-tools.js' => ['live-tools.js', 'text/javascript'], '/live.js' => ['live.js', 'text/javascript'], '/live.css' => ['live.css', 'text/css'], '/try-band.js' => ['try-band.js', 'text/javascript']}.freeze
    APP_ASSETS = {'/app-view.js' => ['app-view.js', 'text/javascript'], '/app-view.css' => ['app-view.css', 'text/css']}.freeze
    # The saved pages of a series: its history, the refreshed revision views and the immutable snapshots.
    SAVED_PAGE = %r{\A/(?:revisions/)?[a-z0-9_-]+\.html\z}

    attr_reader :live

    # report: the series' current.html. capture_dir: where the recorder saves, which the agent
    # attaches from. origin: the review's loopback address. app: the AppProxy, or nil.
    # on_first_view: called the first time the review page is loaded.
    def initialize(report:, capture_dir:, token:, origin:, app: nil, on_first_view: nil)
      @report = report
      @series = File.dirname(report)
      @capture_dir = capture_dir
      @token = token
      @origin = origin
      @app = app
      @on_first_view = on_first_view
      @live = LiveAPI.new(@series, evidence: method(:attach))
    end

    # Returns a response, or nil when the request is not the review's.
    def call(request)
      return api(request) if request.path.start_with?('/api/')
      return unless request.get?
      path = request.path # `/?app` opens the review straight into the running app
      return preview(request) if path == '/preview'
      return review_page(request) if path == '/'
      return saved_page(request, path) if path.match?(SAVED_PAGE)
      asset, type = LIVE_ASSETS[path] || (@app && APP_ASSETS[path])
      HTTP::Response.new(200, File.binread(File.join(LIVE, asset)), type, csp(request)) if asset
    end

    private

    # Same token and origin rules as recorder control: the page sends its own origin,
    # the terminal sends none, a foreign page fails.
    def api(request)
      raise ArgumentError, 'Invalid review token' unless request.token == @token
      raise ArgumentError, 'Cross-origin review request rejected' unless request.from_page_or_terminal?
      raise ArgumentError, 'Writes must come from the review page or the terminal' unless request.get? || request.post?
      return export if request.get? && request.path == '/api/export'
      if request.post? && request.path == '/api/qa'
        input = request.json(LiveAPI::BODY_LIMIT)
        raise ArgumentError, 'Expected a JSON object' unless input.is_a?(Hash)
        require_relative 'qa_request'
        return HTTP.json(QARequest.call(series_dir: @series, state: @live.state, key: input['key'].to_s, route: input['route'], origin: @origin, app: @app, capture_dir: @capture_dir), csp: Page::SERVED_CSP)
      end
      code, payload = @live.call(request.method, request.target, -> { request.body(LiveAPI::BODY_LIMIT) })
      HTTP.json(payload, code: code, csp: Page::SERVED_CSP)
    end

    def export
      require_relative 'export'
      html, _warnings = Export.html(@series)
      HTTP.html(html, csp: Page::SERVED_CSP, headers: {'Content-Disposition' => %(attachment; filename="#{File.basename(@series)}-review.html")})
    end

    # / is the current review rendered for serving: seeded with saved progress, with the live panel.
    def review_page(request)
      @on_first_view&.call
      @on_first_view = nil
      served = Page::Served.new(token: @token, progress: @live.progress, app: @app&.describe(shared: request.shared?))
      HTTP.html(Page.review(Page.payload(File.read(@report, encoding: 'UTF-8')), served: served), csp: served.csp)
    end

    # Sibling pages are served exactly as saved, so the review's own history links keep working
    # and a saved snapshot stays the page it was.
    def saved_page(request, path)
      file = File.join(@series, path.delete_prefix('/'))
      return HTTP.not_found unless File.file?(file) && !File.symlink?(file)
      HTTP.html(File.read(file, encoding: 'UTF-8'), csp: csp(request))
    end

    # One drawn template preview on its own page, so the agent can look at what it submitted before the
    # reviewer does. Read-only and loopback-only, like the review page itself; the preview has no scripts.
    def preview(request)
      asked = request.query['path'].to_s
      previews = @live.state.read['previews']
      # A ViewComponent's class and template share one preview, saved under whichever was asked for.
      sibling = asked.sub(/_component\.rb\z/, '_component.html.erb').then { |other| other == asked ? asked.sub(/_component\.html\.erb\z/, '_component.rb') : other }
      key, wanted = [asked, sibling].uniq.flat_map { |candidate| previews.keys.select { |name| previews.dig(name, candidate, 'status') == 'ready' }.map { |name| [name, candidate] } }
                                   .max_by { |name, _| name.split(':').last.to_i }
      return HTTP.text(404, 'No ready preview of that template') unless key
      HTTP.html(previews.dig(key, wanted, 'html'), csp: csp(request))
    end

    def csp(request) = Page.served_csp(@app&.describe(shared: request.shared?)&.dig(:origin))

    def attach(input)
      require_relative 'evidence'
      # {items: [...]} saves a session's recordings as one revision; a single object still works.
      if input.key?('items') then Evidence.attach_all(series_dir: @series, capture_dir: @capture_dir, inputs: input['items'])
      else Evidence.attach(series_dir: @series, capture_dir: @capture_dir, input: input)
      end
    end
  end
end
