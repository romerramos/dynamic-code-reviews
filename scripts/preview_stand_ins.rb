# frozen_string_literal: true

# Stand-in icons and images for template previews. The review HTML stays offline, so
# stand-ins are fetched while previews are built, cached, sanitized and embedded.
# Icon fonts become Lucide SVGs (the icon set the report already uses); remote or
# relative images become openly licensed photos: Pexels when PEXELS_API_KEY is set,
# otherwise Openverse (no key; CC0, public domain, CC BY or CC BY-SA only), otherwise a
# local placeholder. Every preview that uses a stand-in says so. Ruby stdlib only.
require 'base64'
require 'fileutils'
require 'json'
require 'net/http'
require 'uri'

module ReviewPreviewStandIns
  LUCIDE = 'https://cdn.jsdelivr.net/npm/lucide-static@1.42.0/icons/'
  PEXELS = 'https://api.pexels.com/v1/search'
  OPENVERSE = 'https://api.openverse.org/v1/images/'
  IMAGE_LIMIT = 300 * 1024
  # Icon-font class prefixes (Font Awesome, Bootstrap Icons, Tabler, Remix, Material
  # Design Icons, Phosphor, Line Awesome) and their style/size/animation suffixes, which
  # never name an icon. Which Lucide icon replaces a glyph is not a lookup table: exact
  # names match automatically and the agent maps the rest by meaning (spec icon_map).
  ICON_CLASS = /\A(?:fa|bi|ti|ri|mdi|ph|la|las|lar|lab)-([a-z0-9-]+)\z/
  MODIFIERS = %w[solid regular light thin duotone brands sharp sharp-duotone classic semibold fw lg sm xs xl 2xs 2xl
                 1x 2x 3x 4x 5x 6x 7x 8x 9x 10x spin spin-pulse spin-reverse pulse beat beat-fade fade bounce flip shake
                 border inverse stack stack-1x stack-2x li ul pull-left pull-right pull-start pull-end rotate-90 rotate-180
                 rotate-270 rotate-by flip-horizontal flip-vertical flip-both width-auto kit fill bold duotone].freeze
  LIGATURE_CLASS = /\A(?:material-icons|material-symbols)(?:-[a-z]+)?\z/
  PLACEHOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>'

  class Source
    attr_reader :network

    # fetch: ->(url, headers) { [status, body, content_type] }, injectable for tests.
    def initialize(network: true, pexels_key: ENV.fetch('PEXELS_API_KEY', nil), cache: default_cache, fetch: nil)
      @network = network
      @pexels_key = pexels_key.to_s.strip.empty? ? nil : pexels_key
      @cache = cache
      @fetch = fetch || method(:http_get)
    end

    def default_cache
      File.join(ENV['XDG_CACHE_HOME'] || File.join(Dir.home, '.cache'), 'dynamic-code-reviews')
    end

    # Lucide SVG for an icon key (for example "fa-user-group"): the agent's icon_map choice
    # first, then the same name in Lucide. nil when neither exists.
    def icon(key, name, icon_map = {})
      [icon_map[key], name.tr('_', '-')].compact.uniq.each do |candidate|
        next unless candidate.match?(/\A[a-z0-9-]{1,60}\z/)
        svg = cached("lucide/#{candidate}") { fetch_icon(candidate) }
        return svg if svg
      end
      nil
    end

    # {'data_uri' => ..., 'credit' => ...} for a stand-in photo, or nil when offline or none found.
    def photo(query)
      query = query.to_s.gsub(/[^\p{L}\p{N} ]+/, ' ').squeeze(' ').strip[0, 60]
      query = 'abstract texture' if query.empty?
      provider = @pexels_key ? 'pexels' : 'openverse'
      found = cached("#{provider}/#{query.downcase.tr(' ', '-')}") { @pexels_key ? fetch_pexels(query) : fetch_openverse(query) }
      found && JSON.parse(found)
    end

    private

    def cached(key)
      path = File.join(@cache, "#{key}.cache")
      return File.read(path).then { |text| text.empty? ? nil : text } if File.file?(path)
      return nil unless @network
      value = yield
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, value.to_s) # an empty file records a miss so it is not fetched again
      value
    rescue StandardError
      nil
    end

    def fetch_icon(name)
      status, body = @fetch.call("#{LUCIDE}#{name}.svg", {})
      status == 200 ? ReviewPreviewStandIns.clean_svg(body) : nil
    end

    def fetch_pexels(query)
      status, body = @fetch.call("#{PEXELS}?#{URI.encode_www_form(query: query, per_page: 1, orientation: 'square')}", {'Authorization' => @pexels_key})
      return nil unless status == 200
      photo = JSON.parse(body).fetch('photos', []).first or return nil
      embed(photo.dig('src', 'tiny'), 'images.pexels.com', "Photo by #{photo['photographer'].to_s[0, 80]} on Pexels")
    end

    def fetch_openverse(query)
      status, body = @fetch.call("#{OPENVERSE}?#{URI.encode_www_form(q: query, page_size: 1, license: 'cc0,pdm,by,by-sa')}", {})
      return nil unless status == 200
      image = JSON.parse(body).fetch('results', []).first or return nil
      embed(image['thumbnail'], 'api.openverse.org', image['attribution'].to_s.split('. To view')[0][0, 200])
    end

    # Downloads a thumbnail from the expected host only and embeds it as a data URI.
    def embed(url, host, credit)
      return nil unless url && URI(url).host == host
      status, image, type = @fetch.call(url, {})
      type = type.to_s.split(';').first
      return nil unless status == 200 && image.bytesize <= IMAGE_LIMIT && %w[image/jpeg image/png image/webp].include?(type)
      JSON.generate('data_uri' => "data:#{type};base64,#{Base64.strict_encode64(image)}", 'credit' => credit)
    end

    # HTTPS GET following up to three redirects on the same host (Openverse thumbnails).
    def http_get(url, headers, redirects = 3)
      uri = URI(url)
      return [0, '', nil] unless uri.scheme == 'https'
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) do |http|
        http.get(uri.request_uri, headers.merge('User-Agent' => 'dynamic-code-reviews preview builder'))
      end
      location = response['location'] && URI.join(url, response['location'])
      return http_get(location.to_s, headers, redirects - 1) if response.is_a?(Net::HTTPRedirection) && redirects.positive? && location.host == uri.host
      [response.code.to_i, response.body.to_s, response['content-type']]
    end
  end

  module_function

  # Accept only plain shape SVG (Lucide's shape); anything that could script, link or
  # embed content is rejected. Sized to the surrounding text like an icon glyph.
  def clean_svg(text)
    svg = text.to_s.sub(/<!--.*?-->/m, '')[%r{<svg\b.*</svg>}m] or return nil
    return nil if svg.match?(/<(?!\/?(?:svg|path|circle|rect|line|polyline|polygon|ellipse|g)\b)[a-z]/i) || svg.match?(/\son\w+\s*=|href|javascript:|url\(/i)
    svg.gsub(/\s+/, ' ').sub(/\swidth="\d+"/, ' width="1em"').sub(/\sheight="\d+"/, ' height="1em"').sub('<svg ', '<svg aria-hidden="true" ')
  end

  # [key, name] for an icon element: a prefixed icon class ("fa-user-group") or a
  # Material ligature ("material:home"); nil for ordinary elements.
  def icon_key(tag, classes, text)
    classes.split.each do |name|
      icon = name[ICON_CLASS, 1]
      return [name, icon] if icon && !MODIFIERS.include?(icon)
    end
    return ["material:#{text}", text] if classes.split.any? { |name| name.match?(LIGATURE_CLASS) } && text.match?(/\A[a-z0-9_]+\z/)
    nil
  end

  # Replaces icon-font glyphs and URL images; returns [html, mocks or nil]. Icons that
  # neither the agent's icon_map nor an identical Lucide name covers are listed in
  # mocks['unmatched'] and shown as a dashed placeholder.
  def apply(html, source, icon_map = {})
    mocks = Hash.new(0)
    credits = []
    unmatched = []
    html = html.gsub(%r{<(i|span)\b([^>]*?)\bclass="([^"]*)"([^>]*)>([^<]*)</\1>}i) do
      tag, before, classes, after, text = $1, $2, $3, $4, $5.strip
      key, name = icon_key(tag, classes, text)
      next $& unless key && (text.empty? || key.start_with?('material:'))
      svg = source.icon(key, name, icon_map)
      unmatched << key unless svg
      mocks[svg ? 'icons' : 'placeholders'] += 1
      %(<#{tag}#{before}class="#{classes} review-mock-icon"#{after}>#{svg || PLACEHOLDER_ICON}</#{tag}>)
    end
    html = html.gsub(/<img\b[^>]*>/i) do |tag|
      source_url = tag[/\ssrc="([^"]*)"/i, 1].to_s
      next tag if source_url.start_with?('data:')
      query = tag[/\salt="([^"]*)"/i, 1].to_s
      query = File.basename(source_url.split('?').first.to_s, '.*').tr('_-', '  ') if query.strip.empty?
      query = 'person portrait' if tag.match?(/avatar|profile|user|staff|member/i) # alt text is usually a name
      photo = source.photo(query)
      mocks[photo ? 'images' : 'image_placeholders'] += 1
      credits << photo['credit'] if photo
      width = tag[/\swidth="(\d+)"/i, 1] || 120
      height = tag[/\sheight="(\d+)"/i, 1] || width
      uri = photo ? photo['data_uri'] : placeholder_image(width, height)
      tag.sub(/\ssrc="[^"]*"/i, %( src="#{uri}")).sub(/\ssrcset="[^"]*"/i, '').sub('<img', '<img data-review-mock="image"')
    end
    return [html, nil] if mocks.empty?
    [html, mocks.merge('credits' => credits.uniq, 'unmatched' => unmatched.uniq)]
  end

  def placeholder_image(width, height)
    svg = %(<svg xmlns="http://www.w3.org/2000/svg" width="#{Integer(width)}" height="#{Integer(height)}" viewBox="0 0 24 24"><rect width="24" height="24" fill="#e9ecf2"/><path d="M5 17l4-5 3 3 3-4 4 6z" fill="#b6bfcd"/><circle cx="9" cy="8" r="2" fill="#b6bfcd"/></svg>)
    "data:image/svg+xml;base64,#{Base64.strict_encode64(svg)}"
  end
end
