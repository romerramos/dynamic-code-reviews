# frozen_string_literal: true

# Stand-in icons and images for template previews. The review HTML stays offline, so
# app icon fonts and URL images are swapped while previews are built. Choosing a
# stand-in is the agent's job, not a lookup table: the builder finds what needs one,
# embeds what the agent chose and marks it; anything unchosen becomes a placeholder.
# - Icons: Lucide SVGs (the icon set the report already uses), by the same name or by
#   the agent's spec icon_map; fetched from the Lucide CDN, cached and sanitized.
# - Images: local files the agent found and saved with its own tools (spec image_map).
# Every preview that uses a stand-in says so. Ruby standard library only.
require 'base64'
require 'fileutils'
require 'net/http'
require 'uri'

module ReviewPreviewStandIns
  LUCIDE = 'https://cdn.jsdelivr.net/npm/lucide-static@1.42.0/icons/'
  IMAGE_LIMIT = 500 * 1024
  # Icon-font class prefixes (Font Awesome, Bootstrap Icons, Tabler, Remix, Material
  # Design Icons, Phosphor, Line Awesome) and style/size/animation suffixes, which never
  # name an icon.
  ICON_CLASS = /\A(?:fa|bi|ti|ri|mdi|ph|la|las|lar|lab)-([a-z0-9-]+)\z/
  MODIFIERS = %w[solid regular light thin duotone brands sharp sharp-duotone classic semibold fw lg sm xs xl 2xs 2xl
                 1x 2x 3x 4x 5x 6x 7x 8x 9x 10x spin spin-pulse spin-reverse pulse beat beat-fade fade bounce flip shake
                 border inverse stack stack-1x stack-2x li ul pull-left pull-right pull-start pull-end rotate-90 rotate-180
                 rotate-270 rotate-by flip-horizontal flip-vertical flip-both width-auto kit fill bold].freeze
  LIGATURE_CLASS = /\A(?:material-icons|material-symbols)(?:-[a-z]+)?\z/
  PLACEHOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>'

  class Source
    # fetch: ->(url) { [status, body] }, injectable for tests.
    def initialize(network: true, cache: default_cache, fetch: nil)
      @network = network
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
      status, body = @fetch.call("#{LUCIDE}#{name}.svg")
      status == 200 ? ReviewPreviewStandIns.clean_svg(body) : nil
    end

    def http_get(url)
      uri = URI(url)
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) { |http| http.get(uri.request_uri) }
      [response.code.to_i, response.body.to_s]
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
  def icon_key(classes, text)
    classes.split.each do |name|
      icon = name[ICON_CLASS, 1]
      return [name, icon] if icon && !MODIFIERS.include?(icon)
    end
    return ["material:#{text}", text] if classes.split.any? { |name| name.match?(LIGATURE_CLASS) } && text.match?(/\A[a-z0-9_]+\z/)
    nil
  end

  # A photo the agent saved locally, as a data URI. Only real raster images of a
  # reasonable size are embedded; anything else is refused.
  def local_image(path)
    raise ArgumentError, "Stand-in image must be a regular file: #{path}" if File.symlink?(path) || !File.file?(path)
    raise ArgumentError, "Stand-in image is over #{IMAGE_LIMIT / 1024} KiB; save a smaller size: #{path}" if File.size(path) > IMAGE_LIMIT
    bytes = File.binread(path)
    type = if bytes.start_with?("\xFF\xD8\xFF".b) then 'image/jpeg'
           elsif bytes.start_with?("\x89PNG\r\n\x1a\n".b) then 'image/png'
           elsif bytes.start_with?('RIFF') && bytes.byteslice(8, 4) == 'WEBP' then 'image/webp'
           elsif bytes.start_with?('GIF87a', 'GIF89a') then 'image/gif'
           end
    raise ArgumentError, "Stand-in image must be JPEG, PNG, WebP or GIF: #{path}" unless type
    "data:#{type};base64,#{Base64.strict_encode64(bytes)}"
  end

  # Replaces icon-font glyphs and URL images; returns [html, mocks or nil]. What the
  # agent has not chosen yet is listed (mocks 'unmatched' icons, 'unmatched_images')
  # and shown as a placeholder. image_map: {src => {'path' =>, 'credit' =>}}; relative
  # paths resolve against base_dir (the spec's directory).
  def apply(html, source, icon_map = {}, image_map = {}, base_dir: Dir.pwd)
    mocks = Hash.new(0)
    credits = []
    unmatched = []
    unmatched_images = []
    html = html.gsub(%r{<(i|span)\b([^>]*?)\bclass="([^"]*)"([^>]*)>([^<]*)</\1>}i) do
      tag, before, classes, after, text = $1, $2, $3, $4, $5.strip
      key, name = icon_key(classes, text)
      next $& unless key && (text.empty? || key.start_with?('material:'))
      svg = source.icon(key, name, icon_map)
      unmatched << key unless svg
      mocks[svg ? 'icons' : 'placeholders'] += 1
      %(<#{tag}#{before}class="#{classes} review-mock-icon"#{after}>#{svg || PLACEHOLDER_ICON}</#{tag}>)
    end
    html = html.gsub(/<img\b[^>]*>/i) do |tag|
      src = tag[/\ssrc="([^"]*)"/i, 1].to_s
      next tag if src.start_with?('data:')
      chosen = image_map[src]
      width = tag[/\swidth="(\d+)"/i, 1]
      height = tag[/\sheight="(\d+)"/i, 1]
      if chosen
        uri = local_image(File.expand_path(chosen.fetch('path'), base_dir))
        credits << chosen['credit'].to_s[0, 200] unless chosen['credit'].to_s.strip.empty?
        mocks['images'] += 1
      else
        details = [("alt “#{tag[/\salt="([^"]*)"/i, 1]}”" if tag.match?(/\salt="[^"]+"/i)), ("#{width}×#{height}" if width && height),
                   ("class #{tag[/\sclass="([^"]*)"/i, 1]}" if tag.match?(/\sclass="[^"]+"/i))].compact.join(', ')
        unmatched_images << [src, details].reject(&:empty?).join(' — ')
        uri = placeholder_image(width || 120, height || width || 120)
        mocks['image_placeholders'] += 1
      end
      tag.sub(/\ssrc="[^"]*"/i, %( src="#{uri}")).sub(/\ssrcset="[^"]*"/i, '').sub('<img', '<img data-review-mock="image"')
    end
    return [html, nil] if mocks.empty?
    [html, mocks.merge('credits' => credits.uniq, 'unmatched' => unmatched.uniq, 'unmatched_images' => unmatched_images.uniq)]
  end

  def placeholder_image(width, height)
    svg = %(<svg xmlns="http://www.w3.org/2000/svg" width="#{Integer(width)}" height="#{Integer(height)}" viewBox="0 0 24 24"><rect width="24" height="24" fill="#e9ecf2"/><path d="M5 17l4-5 3 3 3-4 4 6z" fill="#b6bfcd"/><circle cx="9" cy="8" r="2" fill="#b6bfcd"/></svg>)
    "data:image/svg+xml;base64,#{Base64.strict_encode64(svg)}"
  end
end
