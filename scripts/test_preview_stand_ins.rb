# frozen_string_literal: true
require 'tmpdir'
require_relative 'preview_stand_ins'

def assert(condition, message)
  raise message unless condition
end

def rejected?
  yield
  false
rescue ArgumentError
  true
end

# A simulated Lucide CDN that knows a few icons; no real network is used.
LUCIDE_ICONS = %w[house bell mail star].freeze
calls = []
fetch = lambda do |url|
  calls << url
  name = url[%r{lucide-static@[\d.]+/icons/([a-z0-9-]+)\.svg\z}, 1]
  next [404, 'Not found'] unless LUCIDE_ICONS.include?(name)
  [200, %(<!-- @license lucide-static - ISC --><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 10h18"/></svg>)]
end

Dir.mktmpdir('stand-ins') do |dir|
  cache = File.join(dir, 'cache')
  # The agent found and saved this photo with its own tools, then named it in image_map.
  File.binwrite(File.join(dir, 'jane.jpg'), "\xFF\xD8\xFF\xE0fake-jpeg".b)
  source = ReviewPreviewStandIns::Source.new(network: true, cache: cache, fetch: fetch)
  html = <<~HTML
    <i class="fa-solid fa-house"></i>
    <i class="bi bi-bell-fill"></i>
    <span class="material-symbols-outlined">mail</span>
    <i class="ti ti-star"></i>
    <i class="fa-regular fa-thumbtack-angle"></i>
    <i class="fa-light fa-circle-nodes"></i>
    <i class="icon-arrow">text is not an icon glyph</i>
    <img src="/assets/team/jane.png" alt="Jane" class="user-avatar" width="32" height="32">
    <img src="https://cdn.example.com/hero.webp" alt="Warehouse hero" width="640" height="320">
    <img src="data:image/png;base64,AAAA" alt="inline">
  HTML
  icon_map = {'fa-thumbtack-angle' => 'star', 'bi-bell-fill' => 'bell'}
  image_map = {'/assets/team/jane.png' => {'path' => 'jane.jpg', 'credit' => 'Photo by Someone on Unsplash'}}
  output, mocks = ReviewPreviewStandIns.apply(html, source, icon_map, image_map, base_dir: dir)
  assert(output.scan('review-mock-icon').size == 6, 'Every icon-font glyph from any supported library must be replaced')
  assert(mocks['icons'] == 5 && mocks['placeholders'] == 1, "Expected 5 Lucide icons and 1 placeholder, got #{mocks.inspect}")
  assert(mocks['unmatched'] == ['fa-circle-nodes'], 'Unmatched icons must be listed for the agent to map by meaning')
  assert(output.include?('<span class="material-symbols-outlined review-mock-icon"><svg aria-hidden="true"'), 'Material ligatures must become SVGs')
  assert(output.include?('text is not an icon glyph'), 'Elements with real text must be left alone')
  assert(output.include?('src="data:image/png;base64,AAAA"'), 'Inline data images belong to the app and must stay')
  assert(output.match?(/data-review-mock="image"[^>]*src="data:image\/jpeg;base64,/) && mocks['images'] == 1, "The agent's saved photo must be embedded")
  assert(mocks['credits'] == ['Photo by Someone on Unsplash'], 'Stand-in photos must keep their credit')
  assert(mocks['image_placeholders'] == 1 && mocks['unmatched_images'] == ['https://cdn.example.com/hero.webp — alt “Warehouse hero”, 640×320'],
         'Images without an agent choice are listed with their context and shown as placeholders')
  assert(!output.include?('/assets/team/jane.png') && !output.include?('cdn.example.com') && !output.include?('<!--'), 'Remote URLs and license comments must not reach the preview')
  assert(calls.none? { |url| !url.start_with?(ReviewPreviewStandIns::LUCIDE) }, 'The builder fetches nothing but chosen Lucide icons')

  requests = calls.size
  offline = ReviewPreviewStandIns::Source.new(network: false, cache: cache, fetch: ->(*) { raise 'offline builds must not fetch' })
  again, = ReviewPreviewStandIns.apply(html, offline, icon_map, image_map, base_dir: dir)
  assert(again == output && calls.size == requests, 'Cached icons must be reused without any network')
  cold = ReviewPreviewStandIns::Source.new(network: false, cache: File.join(dir, 'empty'), fetch: ->(*) { raise 'no fetch' })
  _, degraded = ReviewPreviewStandIns.apply(html, cold)
  assert(degraded['placeholders'] == 6 && degraded['image_placeholders'] == 2, 'Offline builds without choices fall back to placeholders')
  failing = ReviewPreviewStandIns::Source.new(network: true, cache: File.join(dir, 'failing'), fetch: ->(*) { raise SocketError, 'down' })
  _, down = ReviewPreviewStandIns.apply(html, failing)
  assert(down['placeholders'] == 6, 'A failing icon CDN must degrade to placeholders, never fail the build')

  File.write(File.join(dir, 'page.html'), '<html>not an image</html>')
  File.binwrite(File.join(dir, 'huge.jpg'), "\xFF\xD8\xFF".b + ('x' * (ReviewPreviewStandIns::IMAGE_LIMIT + 1)))
  File.symlink(File.join(dir, 'jane.jpg'), File.join(dir, 'link.jpg'))
  %w[page.html huge.jpg link.jpg missing.jpg].each do |name|
    assert(rejected? { ReviewPreviewStandIns.apply(html, offline, {}, {'/assets/team/jane.png' => {'path' => name}}, base_dir: dir) }, "#{name} must not be embedded as a stand-in image")
  end
end
puts 'PASS stand-ins cover any supported icon font, embed only agent-chosen images and degrade offline'

unsafe = [%(<svg><script>alert(1)</script></svg>), %(<svg onload="x()"><path d="M0 0"/></svg>), %(<svg><a href="https://x"><path/></a></svg>),
          %(<svg><foreignObject><div/></foreignObject></svg>), %(<svg><use href="#x"/></svg>), %(<svg style="background:url(x)"><path/></svg>)]
assert(unsafe.none? { |svg| ReviewPreviewStandIns.clean_svg(svg) }, 'SVG that can script, link or embed content must be rejected')
assert(ReviewPreviewStandIns.clean_svg(%(<svg width="24" height="24"><circle cx="1" cy="1" r="1"/></svg>)).include?('width="1em"'), 'Plain shape SVG is sized like a glyph')
puts 'PASS stand-in icons accept only plain shape SVG'
