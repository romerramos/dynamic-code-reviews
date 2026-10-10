# frozen_string_literal: true

# Run with ruby scripts/test_themes.rb. Pure string checks, no browser.
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings
require_relative '../lib/dcr/page'
require_relative '../lib/dcr/settings'

def assert(condition, message)
  raise message unless condition
end

ROOT = File.expand_path('..', __dir__)
SHEETS = %w[assets/report.css live/live.css live/app-view.css].to_h { |path| [path, File.read(File.join(ROOT, path))] }
base = File.read(File.join(ROOT, 'assets/themes/base.css'))
defined = base.scan(/(--[\w-]+):/).flatten.uniq
DAISY = %w[--color-base-100 --color-base-200 --color-base-300 --color-base-content --color-primary --color-primary-content --color-secondary --color-secondary-content
           --color-accent --color-accent-content --color-neutral --color-neutral-content --color-info --color-info-content --color-success --color-success-content
           --color-warning --color-warning-content --color-error --color-error-content --radius-selector --radius-field --radius-box --size-selector --size-field --border --depth --noise].freeze

# Colour tokens the stylesheets read must exist in the contract, or a theme could not set them.
SHEETS.each do |path, css|
  used = css.scan(/var\((--(?:bg|ink|line|ring)-[\w-]+|--shade|--dcr-[\w-]+|--rec|--surface|--canvas|--line|--ink|--muted|--accent(?:-soft)?|--added|--removed|--note(?:-bg)?|--yours(?:-soft)?)\b/).flatten.uniq
  missing = used - defined
  assert(missing.empty?, "#{path} reads tokens base.css does not define: #{missing.first(8).join(', ')}")
end
puts 'PASS every colour token the stylesheets read is defined in the theme contract'

# The page's colours come from tokens: a hard-coded colour in a rule would ignore the theme.
ALLOWED = /\A(?:--tok-|--agent-|--thread-|(?:-webkit-)?mask)/ # syntax themes, agent marks and comment types carry their own palettes; a mask's colour is never seen
SHEETS.each do |path, css|
  stray = css.gsub(%r{/\*.*?\*/}m, '').scan(/([\w-]+)\s*:\s*([^;{}]*#\h{3,8}\b[^;{}]*)/).reject { |property, value| property.match?(ALLOWED) || value.match?(/\A\s*url\(/) }
  assert(stray.empty?, "#{path} has #{stray.length} hard-coded colours: #{stray.first(5).map { |property, value| "#{property}:#{value.strip[0, 40]}" }.join(' | ')}")
  assert(!css.include?('data-theme'), "#{path} must key on data-mode, never on a theme's name")
end
puts 'PASS the stylesheets hold no colours of their own and never name a theme'

themes = DCR::Page.themes
assert(themes.include?('aida') && !themes.include?('base'), "The themes are the files beside base.css: #{themes}")
themes.each do |name|
  css = File.read(File.join(ROOT, 'assets/themes', "#{name}.css"))
  %w[light dark].each do |mode|
    block = css[/\[data-theme="#{name}-#{mode}"\]\{([^}]*)\}/m, 1]
    assert(block, "#{name} needs a #{name}-#{mode} block: every theme has a light and a dark mode")
    assert(block.match?(/color-scheme:\s*#{mode}/), "#{name}-#{mode} must set color-scheme, so the browser's own controls follow")
    missing = DAISY.reject { |variable| block.match?(/#{Regexp.escape(variable)}:/) }
    assert(missing.empty?, "#{name}-#{mode} must set daisyUI's variables; missing #{missing.join(', ')}")
    unknown = block.scan(/(--[\w-]+):/).flatten.uniq - DAISY - defined
    assert(unknown.empty?, "#{name}-#{mode} sets tokens nothing reads: #{unknown.first(8).join(', ')}")
  end
end
puts 'PASS each theme is a light and a dark daisyUI theme that sets only tokens the app knows'

styles = DCR::Page.theme_styles
assert(styles.index('Theme contract') < styles.index('[data-theme="aida-light"]'), 'The contract comes before the themes, so a theme\'s values win')
Dir.mktmpdir('dcr-theme') do |dir|
  settings = DCR::Settings.new(dir)
  assert(settings.write('theme' => 'aida') == {'theme' => 'aida'} && settings.write('theme' => 'nope') == {'theme' => 'aida'}, 'A theme is saved only when it exists')
end
puts 'PASS the page carries the contract and every theme, and the chosen theme is kept with the settings'
