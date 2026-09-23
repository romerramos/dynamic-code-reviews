# frozen_string_literal: true
require 'json'
require 'tmpdir'
require_relative 'preview_stand_ins'

def assert(condition, message)
  raise message unless condition
end

# A simulated network: Lucide knows a few icons, image search always finds a photo.
LUCIDE_ICONS = %w[house bell mail star].freeze
calls = []
fetch = lambda do |url, headers|
  calls << url
  case url
  when %r{lucide-static@[\d.]+/icons/([a-z0-9-]+)\.svg\z}
    next [404, 'Not found', 'text/plain'] unless LUCIDE_ICONS.include?($1)
    [200, %(<!-- @license lucide-static - ISC --><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 10h18"/></svg>), 'image/svg+xml']
  when /api\.openverse\.org\/v1\/images\/\?/
    [200, JSON.generate(results: [{thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/', attribution: '"Photo" by Someone is licensed under CC BY 2.0. To view a copy …'}]), 'application/json']
  when %r{api\.openverse\.org/v1/images/abc/thumb/}
    [200, "\xFF\xD8\xFFfake-jpeg".b, 'image/jpeg']
  else
    [500, '', 'text/plain']
  end
end

Dir.mktmpdir('stand-ins') do |cache|
  source = ReviewPreviewStandIns::Source.new(network: true, pexels_key: nil, cache: cache, fetch: fetch)
  html = <<~HTML
    <i class="fa-solid fa-house"></i>
    <i class="bi bi-bell-fill"></i>
    <span class="material-symbols-outlined">mail</span>
    <i class="ti ti-star"></i>
    <i class="fa-regular fa-thumbtack-angle"></i>
    <i class="fa-light fa-circle-nodes"></i>
    <i class="icon-arrow">text is not an icon glyph</i>
    <img src="/assets/team/jane.png" alt="Jane" class="user-avatar" width="32" height="32">
    <img src="data:image/png;base64,AAAA" alt="inline">
  HTML
  output, mocks = ReviewPreviewStandIns.apply(html, source, {'fa-thumbtack-angle' => 'star', 'bi-bell-fill' => 'bell'})
  assert(output.scan('review-mock-icon').size == 6, 'Every icon-font glyph from any supported library must be replaced')
  assert(mocks['icons'] == 5 && mocks['placeholders'] == 1, "Expected 5 Lucide icons and 1 placeholder, got #{mocks.inspect}")
  assert(mocks['unmatched'] == ['fa-circle-nodes'], 'Unmatched icons must be listed for the agent to map by meaning')
  assert(output.include?('<span class="material-symbols-outlined review-mock-icon"><svg aria-hidden="true"'), 'Material ligatures must become SVGs')
  assert(output.include?('text is not an icon glyph'), 'Elements with real text must be left alone')
  assert(output.include?('src="data:image/png;base64,AAAA"'), 'Inline data images belong to the app and must stay')
  assert(output.match?(/data-review-mock="image"[^>]*src="data:image\/jpeg;base64,/) && mocks['images'] == 1, 'URL images must become an embedded stand-in photo')
  assert(mocks['credits'] == ['"Photo" by Someone is licensed under CC BY 2.0'], 'Stand-in photos must keep their attribution')
  assert(calls.any? { |url| url.include?('q=person+portrait') && url.include?('license=cc0%2Cpdm%2Cby%2Cby-sa') }, 'Avatars search for a portrait with permissive licenses only')
  assert(!output.include?('/assets/team/jane.png') && !output.include?('<!--'), 'Remote URLs and license comments must not reach the preview')

  requests = calls.size
  offline = ReviewPreviewStandIns::Source.new(network: false, pexels_key: nil, cache: cache, fetch: ->(*) { raise 'offline builds must not fetch' })
  again, cached = ReviewPreviewStandIns.apply(html, offline, {'fa-thumbtack-angle' => 'star', 'bi-bell-fill' => 'bell'})
  assert(again == output && cached['icons'] == 5 && calls.size == requests, 'Cached stand-ins must be reused without any network')
  cold = ReviewPreviewStandIns::Source.new(network: false, pexels_key: nil, cache: File.join(cache, 'empty'), fetch: ->(*) { raise 'no fetch' })
  _, degraded = ReviewPreviewStandIns.apply(html, cold)
  assert(degraded['placeholders'] == 6 && degraded['image_placeholders'] == 1 && degraded['images'].zero?, 'Offline builds fall back to placeholders')
  failing = ReviewPreviewStandIns::Source.new(network: true, pexels_key: nil, cache: File.join(cache, 'failing'), fetch: ->(*) { raise SocketError, 'down' })
  _, down = ReviewPreviewStandIns.apply(html, failing)
  assert(down['placeholders'] == 6 && down['image_placeholders'] == 1, 'A failing CDN or image API must degrade to placeholders, never fail the build')
end
puts 'PASS stand-ins cover any supported icon font, map by agent choice, embed licensed photos and degrade offline'

unsafe = [%(<svg><script>alert(1)</script></svg>), %(<svg onload="x()"><path d="M0 0"/></svg>), %(<svg><a href="https://x"><path/></a></svg>),
          %(<svg><foreignObject><div/></foreignObject></svg>), %(<svg><use href="#x"/></svg>), %(<svg style="background:url(x)"><path/></svg>)]
assert(unsafe.none? { |svg| ReviewPreviewStandIns.clean_svg(svg) }, 'SVG that can script, link or embed content must be rejected')
assert(ReviewPreviewStandIns.clean_svg(%(<svg width="24" height="24"><circle cx="1" cy="1" r="1"/></svg>)).include?('width="1em"'), 'Plain shape SVG is sized like a glyph')
puts 'PASS stand-in icons accept only plain shape SVG'
