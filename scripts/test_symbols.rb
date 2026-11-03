# frozen_string_literal: true

# Run with ruby scripts/test_symbols.rb. Needs Universal Ctags (bin/dcr setup); skips without it.
require_relative '../lib/dcr/symbols'

def assert(condition, message)
  raise message unless condition
end

unless DCR::Symbols.ctags
  puts 'SKIP no Universal Ctags; run bin/dcr setup'
  exit 0
end

ruby_old = "class Billing\n  def charge(order)\n    total(order)\n  end\n\n  def refund(order) = nil\nend\n"
ruby_new = "class Billing\n  def charge(order)\n    total(order)\n  end\n\n  def total(order)\n    order.sum\n  end\nend\n"
svelte = "<script lang=\"ts\">\n  export let name: string;\n  function greet(who: string) { return who }\n</script>\n<h1>{greet(name)}</h1>\n"
files = [
  {'id' => 'f1', 'path' => 'app/models/billing.rb', 'source' => {'old' => ruby_old, 'new' => ruby_new}},
  {'id' => 'f2', 'path' => 'web/Greeting.svelte', 'source' => {'old' => '', 'new' => svelte}},
  {'id' => 'f3', 'path' => 'web/list.tsx', 'source' => {'old' => '', 'new' => "export function List() {\n  return <ul />\n}\n"}},
  {'id' => 'f4', 'path' => 'config/settings.yml', 'source' => {'old' => '', 'new' => "total: 1\n"}},
  {'id' => 'f5', 'path' => 'big.rb', 'hunks' => []}
]
payload = DCR::Symbols.add({'snapshot' => {'files' => files}, 'review' => {}})
index = payload.fetch('symbols')

assert(index['total'] == [['f1', 'new', 6, 'method']], "A method added in the change is found where it is defined after it: #{index['total'].inspect}")
assert(index['charge'] == [['f1', 'new', 2, 'method']], "A definition on both sides is kept once, on the new side: #{index['charge'].inspect}")
assert(index['refund'] == [['f1', 'old', 6, 'method']], "A removed definition is found on the old side: #{index['refund'].inspect}")
puts 'PASS Ruby definitions on each side of the change'

assert(index['greet'] == [['f2', 'new', 3, 'function']], "Svelte's script block is read, on its own lines: #{index['greet'].inspect}")
assert(index['List']&.first&.first(3) == ['f3', 'new', 1], "A .tsx file is read: #{index['List'].inspect}")
puts 'PASS script blocks of templates and TSX files'

assert(index.values.flatten(1).none? { |entry| entry[0] == 'f4' }, 'Data files add no definitions: a YAML key is not a name code calls')
puts 'PASS data files are left out'

assert(DCR::Symbols.add({'snapshot' => {'files' => []}})['symbols'] == {}, 'A review with no saved text has an empty index')
original = DCR::Symbols.method(:ctags)
DCR::Symbols.define_singleton_method(:ctags) { nil }
kept = {'snapshot' => {'files' => files}, 'symbols' => {'x' => []}}
assert(DCR::Symbols.add(kept).equal?(kept), 'Without ctags the payload is unchanged, keeping an index rendered earlier')
DCR::Symbols.define_singleton_method(:ctags, original)
puts 'PASS without ctags the page is the same'
