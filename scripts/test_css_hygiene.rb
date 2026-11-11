# frozen_string_literal: true

# Run with ruby scripts/test_css_hygiene.rb. Pure string checks, no browser.
#
# Layout is grid and flex with gap: nothing is nudged into place. A negative offset, !important,
# position:absolute or fixed, or a selector given a second rule in the same place is how a fix gets
# layered on top of a rule instead of changing it. Each sheet may hold no more of them than its
# ceiling below; when a cleanup brings a count down, lower the ceiling to it, so the count only falls.

def assert(condition, message)
  raise message unless condition
end

ROOT = File.expand_path('..', __dir__)
SHEETS = (%w[assets/report.css live/live.css] + Dir[File.join(ROOT, 'assets/{themes,components}/*.css')].map { |path| path.delete_prefix("#{ROOT}/") }).sort

# [context, selector, declarations] for every rule, the context being its @media/@supports chain.
def rules(css)
  css = css.gsub(%r{/\*.*?\*/}m, '')
  out = []
  stack = []
  buffer = +''
  css.each_char do |char|
    case char
    when '{' then stack << buffer.strip; buffer = +''
    when '}'
      if !buffer.strip.empty? && (head = stack.last) && !head.start_with?('@')
        context = stack[0...-1].select { |part| part.start_with?('@') && !part.start_with?('@layer') }.join(' ')
        head.split(/,(?![^(]*\))/).map(&:strip).each { |selector| out << [context, selector, buffer.strip] }
      end
      buffer = +''
      stack.pop
    else buffer << char
    end
  end
  out
end

def counts(css)
  list = rules(css)
  declarations = list.map(&:last).uniq.join(';')
  {
    'negative offsets' => declarations.scan(/(?:\A|;)\s*(?:margin[\w-]*|top|right|bottom|left|inset[\w-]*|translate)\s*:[^;]*(?<![\w-])-\d/).length,
    '!important' => css.scan('!important').length,
    'absolute or fixed' => declarations.scan(/position\s*:\s*(?:absolute|fixed)/).length,
    'repeated selectors' => list.group_by { |context, selector, _| [context, selector] }.sum { |_, same| same.length - 1 }
  }
end

CEILING = {
  'assets/report.css' => {'negative offsets' => 10, '!important' => 21, 'absolute or fixed' => 47, 'repeated selectors' => 97},
  'live/live.css' => {'negative offsets' => 11, '!important' => 3, 'absolute or fixed' => 10, 'repeated selectors' => 16},
  'assets/themes/minimal.css' => {'negative offsets' => 0, '!important' => 0, 'absolute or fixed' => 9, 'repeated selectors' => 36},
  'assets/themes/terminal.css' => {'negative offsets' => 3, '!important' => 0, 'absolute or fixed' => 6, 'repeated selectors' => 2},
  'assets/components/comment-card.css' => {'negative offsets' => 0, '!important' => 0, 'absolute or fixed' => 0, 'repeated selectors' => 2},
  'assets/components/comment-popover.css' => {'negative offsets' => 0, '!important' => 0, 'absolute or fixed' => 0, 'repeated selectors' => 2}
}.freeze
CLEAN = {'negative offsets' => 0, '!important' => 0, 'absolute or fixed' => 0, 'repeated selectors' => 0}.freeze

over = []
lower = []
SHEETS.each do |path|
  have = counts(File.read(File.join(ROOT, path)))
  ceiling = CEILING.fetch(path, CLEAN)
  have.each do |kind, count|
    limit = ceiling.fetch(kind)
    over << "#{path}: #{count} #{kind}, at most #{limit}" if count > limit
    lower << "#{path} #{kind}: #{limit} -> #{count}" if count < limit
  end
end
assert(over.empty?, "Layout layered on instead of changed:\n  #{over.join("\n  ")}")
puts 'PASS no sheet holds more negative offsets, !important, absolute positions or repeated selectors than its ceiling'
puts "  lower these ceilings to lock in the cleanup: #{lower.join('; ')}" unless lower.empty?
