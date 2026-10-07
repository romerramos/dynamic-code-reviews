# frozen_string_literal: true
# Run with ruby scripts/test_dark_theme.rb. Pure string checks, no browser.
require_relative 'dark_theme'

def assert(condition, message)
  raise message unless condition
end

def lightness(hex)
  r, g, b = ReviewDarkTheme.rgb(hex)
  ReviewDarkTheme.to_hsl(r, g, b).last
end

dark = ReviewDarkTheme.css(<<~CSS)
  :root{--ink:#1f2430;color:var(--ink)}
  .card,.panel > .row{background:#fff;color:#3f4656;border:1px solid #e0e5ed}
  .banner{background:#fffaeccc;box-shadow:0 1px 2px #00000022}
  .primary{background:#6048b5;color:white}
  .pale-green{background:#e9f5ed;color:#28713e}
  .tooltip{background:#1f2430}
  .quote::before{content:"{ not a rule }";color:#667080}
  .no-color{display:block;margin:0}
  @media (max-width:900px){.narrow{background:#f7f8fa}}
  @keyframes spin{from{background:#fff}to{background:#000}}
  .data{background:url("data:image/svg+xml;utf8,<svg fill='%23fff'/>") #fff}
CSS

assert(dark.include?('html[data-theme="dark"] .card,html[data-theme="dark"] .panel > .row{'), 'Every selector in a list must be prefixed')
card = dark[/\.card,[^{]*\{([^}]*)\}/, 1]
assert(lightness(card[/background:(#\h{6})/, 1]) < 0.2, 'A white surface must become dark')
assert(lightness(card[/color:(#\h{6})/, 1]) > 0.58, 'Dark text must become light')
border = card[/border:1px solid (#\h{6})/, 1]
assert(lightness(border) > lightness(card[/background:(#\h{6})/, 1]), 'A border must stay visible against its surface')
assert(dark.match?(/\.banner\{background:#\h{6}cc\}/), 'Opacity in an 8-digit colour must be kept')
assert(!dark.include?('.primary'), 'A strong fill with white text already works on dark and must not be emitted')
assert(dark.match?(/\.pale-green\{background:#\h{6};color:#\h{6}\}/) && lightness(dark[/\.pale-green\{background:(#\h{6})/, 1]) < 0.2, 'A pale tint must become a dark tint')
assert(!dark.include?('.tooltip'), 'An already dark surface is left alone')
assert(dark.include?('.quote::before{color:'), 'A brace inside a string must not confuse the parser')
assert(!dark.include?('no-color') && !dark.include?('spin') && !dark.include?('--ink'), 'Rules without remappable colours, keyframes and variables are not emitted')
assert(dark.include?('@media (max-width:900px){html[data-theme="dark"] .narrow{'), 'Media queries must wrap the derived rule')
assert(dark.include?('.data{background:url("data:image/svg+xml;utf8,<svg fill=\'%23fff\'/>") #'), 'Colours inside url() data must not be rewritten, only the real colour')
puts 'PASS the derived dark theme flips surfaces, text and borders by role, keeps fills, opacity and structure intact'

real = ReviewDarkTheme.css(File.read(File.join(__dir__, '../assets/report.css')))
assert(real.bytesize.between?(5_000, 80_000), "Derived stylesheet has an implausible size: #{real.bytesize}")
assert(real.scan('{').length == real.scan('}').length, 'Derived stylesheet has unbalanced braces')
puts 'PASS the real report stylesheet derives a balanced dark theme of plausible size'
