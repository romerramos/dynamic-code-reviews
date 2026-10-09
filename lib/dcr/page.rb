# frozen_string_literal: true

require 'digest'
require 'erb'
require 'json'
require_relative '../../scripts/dark_theme'

module DCR
  # Every HTML page a review is read in comes from here, rendered from a template in assets/.
  # A review page opens in one of three places, and that alone decides what it carries beyond the
  # review itself:
  #   offline (the saved file): the review, its styles and scripts, and the strict offline policy.
  #   served (dcr serve): seeded with the reviewer's saved progress, plus the live panel and the app view.
  #   export: one read-only file with the conversation and progress baked in.
  module Page
    module_function

    ASSETS = File.expand_path('../../assets', __dir__)
    LIVE = File.expand_path('../../live', __dir__)
    LANGUAGES = %w[core markup clike javascript css ruby sql json yaml bash typescript].freeze
    OFFLINE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"
    # The served review keeps its own inline scripts and embedded media, and may also load
    # the QA panel and talk to the server. The saved HTML file keeps its stricter offline policy.
    SERVED_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

    # What a served page needs from the server: its token, the browser progress to seed (the server's
    # copy wins over a stale browser one), and the running app it may frame, if any.
    Served = Struct.new(:token, :progress, :app, keyword_init: true) do
      def csp = Page.served_csp(app && app[:origin])
    end

    # The running app is the only page a served review may frame.
    def served_csp(frame_origin = nil) = frame_origin ? SERVED_CSP.sub("connect-src 'self';", "connect-src 'self'; frame-src #{frame_origin};") : SERVED_CSP

    # payload: {'snapshot' => ..., 'review' => ...} with its render data already derived.
    # export: {'key', 'progress', 'threads', 'previews'} for a read-only copy.
    def review(payload, served: nil, export: nil)
      raise ArgumentError, 'A page is either served or exported' if served && export
      ReviewView.new(payload, served: served, export: export).render
    end

    def history(history) = HistoryView.new(history).render

    # Identifies the report UI a page was rendered with, so an older saved page can be refreshed
    # before it is served. Covers the files that make up the page, not the vendored libraries.
    def ui_version
      files = %w[report.html.erb report.css report.js review-tools.js icon.svg].map { |name| File.join(ASSETS, name) } + [File.expand_path('../../scripts/dark_theme.rb', __dir__)]
      Digest::SHA256.hexdigest(files.map { |path| File.read(path) }.join("\0"))[0, 16]
    end

    # The review data embedded in a rendered page, as `render` received it.
    def payload(html)
      json = html[/<script\b(?=[^>]*\bid=["']data["'])[^>]*>(.*?)<\/script>/m, 1]
      raise ArgumentError, 'Report has no embedded review data' unless json
      JSON.parse(json)
    end

    # Helpers the templates share. A template renders against its view's binding.
    class View
      def render = ERB.new(File.read(File.join(ASSETS, self.class::TEMPLATE)), trim_mode: '-').result(binding)

      private

      def asset(name) = File.read(File.join(ASSETS, name))
      def h(value) = ERB::Util.html_escape(value.to_s)
      def icon = @icon ||= asset('icon.svg')
      def favicon = "data:image/svg+xml;base64,#{[icon].pack('m0')}"
      # Text placed inside an inline <script> must not close it early.
      def inline_script(text) = text.gsub(%r{</script}i, '<\\/script')
      def script_json(value) = JSON.generate(value, script_safe: true)
    end

    class ReviewView < View
      TEMPLATE = 'report.html.erb'

      def initialize(payload, served:, export:)
        @payload = payload
        @served = served
        @export = export
      end

      private

      attr_reader :served, :export

      def csp = served ? served.csp : OFFLINE_CSP
      def ui_version = Page.ui_version
      def data = JSON.generate(@payload).gsub('<', '\\u003c').gsub('>', '\\u003e').gsub('&', '\\u0026')
      def live(name) = File.read(File.join(LIVE, name))

      def styles
        licenses = %w[DAISYUI-LICENSE PRISM-LICENSE lucide/LICENSE glightbox/LICENSE].map { |name| asset(File.join('vendor', name)) }.join("\n")
        report = asset('report.css')
        "/* Third-party licenses\n#{licenses}\n*/\n#{asset('vendor/daisyui.css')}\n#{asset('vendor/glightbox/glightbox.min.css')}\n#{report}#{ReviewDarkTheme.css(report)}"
      end

      def scripts
        prism = LANGUAGES.map { |lang| asset("vendor/prism-#{lang}.min.js") }.join("\n")
        icons = Dir[File.join(ASSETS, 'vendor/lucide/*.svg')].sort.to_h { |path| [File.basename(path, '.svg'), File.read(path)] }
        # Agent marks, without their tooltip title or their own size and style: the avatar sizes them.
        brands = Dir[File.join(ASSETS, 'vendor/brands/*.svg')].sort.to_h do |path|
          mark = File.read(path).sub(/<title>.*?<\/title>/m, '').sub(/<svg[^>]*>/) { |tag| tag.gsub(/ (?:width|height|style|role)="[^"]*"/, '').sub('<svg', '<svg aria-hidden="true" focusable="false"') }
          [File.basename(path, '.svg'), mark]
        end
        inline_script("window.Prism = {manual: true};\nwindow.ReviewIcons = #{JSON.generate(icons)};\nwindow.ReviewBrands = #{JSON.generate(brands)};\n#{prism}\n#{asset('vendor/glightbox/glightbox.min.js')}\n#{asset('review-tools.js')}\n#{asset('report.js')}")
      end
    end

    class HistoryView < View
      TEMPLATE = 'history.html.erb'

      def initialize(history)
        @history = history
      end

      private

      def styles = asset('vendor/daisyui.css') + asset('report.css')
      def name = @history['name']
      def revisions = @history['revisions']
      def latest?(entry) = entry == revisions.last
      def target(entry) = latest?(entry) ? 'current.html' : format('revision-%03d.html', entry['number'])
      def snapshot(entry) = format('revisions/%03d.html', entry['number'])
    end
  end
end
