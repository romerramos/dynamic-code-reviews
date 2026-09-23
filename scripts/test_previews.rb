# frozen_string_literal: true
require 'open3'
require 'tmpdir'
require_relative 'previews'

def assert(condition, message)
  raise message unless condition
end

css = <<~CSS.b
  @charset "UTF-8";
  @font-face{font-family:Icons;src:url("/fonts/icons.woff2")}
  :root{--brand:#123}
  html{margin:0}
  .card{padding:4px}
  .card .title,.other .title{font-weight:600}
  .missing{color:red}
  :is(.card,.nope)>p{margin:0}
  :is(.nope,.gone){color:blue}
  .card:not(.gone){display:block}
  @media (max-width:600px){.card{padding:2px}.missing{padding:0}}
  @media print{.card{display:none}}
  .spinner{animation:spin 1s}
  @keyframes spin{from{opacity:0}to{opacity:1}}
  @keyframes unused{from{opacity:0}}
  .panel{max-height:45vh;height:calc(100dvh - 10px)}
CSS
html = %(<div class="card"><p class="title">Hi</p></div>)
pruned = ReviewPreviews.prune(ReviewPreviews.parse(css), html)
assert(pruned.include?(':root{--brand:#123}') && pruned.include?('.card{padding:4px}'), 'Base and matching rules were dropped')
assert(pruned.include?('.card .title{font-weight:600}') && !pruned.include?('.other'), 'Selector lists must keep only matching selectors')
assert(!pruned.include?('.missing') && !pruned.include?('font-face') && !pruned.include?('print'), 'Unmatched rules, fonts or print styles leaked into a preview')
assert(pruned.include?(':is(.card,.nope)>p') && !pruned.include?('.gone){color:blue'), ':is() must match only when one of its options does')
assert(pruned.include?('.card:not(.gone)'), ':not() arguments must not be required in the preview')
assert(pruned.include?('@media (max-width:600px){.card{padding:2px}}'), 'Media blocks must keep only matching rules')
spinner = ReviewPreviews.prune(ReviewPreviews.parse(css), %(<i class="spinner"></i>))
assert(spinner.include?('@keyframes spin') && !spinner.include?('unused'), 'Only keyframes used by kept rules belong in a preview')
panel = ReviewPreviews.fixed_viewport(ReviewPreviews.prune(ReviewPreviews.parse(css), %(<div class="panel"></div>)), 900)
assert(panel.include?('max-height:405.0px') && panel.include?('calc(900.0px - 10px)'), 'Viewport heights must not depend on the preview frame height')
puts 'PASS previews keep only the CSS their HTML can use, without fonts, print styles or frame-relative heights'

assert(ReviewPreviews.strip_scripts(%(<p>ok</p><script>alert(1)</script><SCRIPT src="x">)) == '<p>ok</p>', 'Scripts survived into a preview')
document = ReviewPreviews.document('<p>x</p>', 'p{color:red}</style><b>', {'width' => 240}, 'nav-v2 "><img')
assert(document.include?('<\/style><b>') && !document.include?('class="nav-v2 "><img"'), 'CSS or body class could break out of the preview document')
script = ReviewPreviews.app_script({'previews' => [{'id' => 'a', 'ruby' => 'render "x"'}]})
_, status = Open3.capture2e(RbConfig.ruby, '-c', stdin_data: script)
assert(status.success? && script.include?('raise ActiveRecord::Rollback') && script.include?('requires_new: true'), 'Generated app script must parse and roll back every preview')
puts 'PASS preview documents strip scripts, escape their CSS and run each example in a rolled-back savepoint'

Dir.mktmpdir('previews-validate') do
  snapshot = {'files' => [{'path' => 'app/views/_card.html.erb'}, {'path' => 'app/views/_stream.html.erb'}]}
  valid = [{'id' => 'card', 'files' => ['app/views/_card.html.erb'], 'status' => 'rendered', 'source' => 'example', 'html' => '<!doctype html><p>x</p>'},
           {'id' => 'stream', 'files' => ['app/views/_stream.html.erb'], 'status' => 'not_visual'}]
  valid.last['note'] = 'Renders only Turbo stream actions.'
  ReviewPreviews.validate(valid, snapshot)
  broken = lambda { |changes| [valid.first.merge(changes), valid.last] }
  [
    broken.call('id' => 'Bad id!'),
    broken.call('files' => ['app/views/_card.html.erb', 'app/other.html.erb']),
    broken.call('html' => nil),
    broken.call('html' => '<script>1</script>'),
    broken.call('status' => 'unavailable'),
    valid + [valid.first],
    [valid.first], # the stream partial is not accounted for
    [valid.first, valid.last.merge('note' => ' ')] # not_visual without a reason
  ].each do |previews|
    rejected = begin
      ReviewPreviews.validate(previews, snapshot)
      false
    rescue ArgumentError
      true
    end
    assert(rejected, "Invalid previews accepted: #{previews.inspect[0, 120]}")
  end
end
puts 'PASS preview validation requires every changed template, reasons for non-visual ones, unique ids and script-free HTML'

desktop = {'files' => ['app/components/nav_component.html.erb'], 'wrap' => '<aside class="rail">%s</aside>'}
mobile = {'files' => ['app/components/nav_component.html.erb'], 'wrap' => '<aside class="drawer">%s</aside>'}
same = ReviewPreviews.duplicate_key(desktop, %(<ul id="rail-1" data-action="a" aria-controls="rail-1"><li>Inbox</li></ul>)) ==
       ReviewPreviews.duplicate_key(mobile, %(<ul id="drawer-1" data-action="b" aria-controls="drawer-1"><li>Inbox</li></ul>))
different = ReviewPreviews.duplicate_key(desktop, '<ul><li>Inbox</li></ul>') == ReviewPreviews.duplicate_key(mobile, '<ul><li>Inbox</li><li>Sent</li></ul>')
assert(same && !different, 'Examples differing only in ids, data or ARIA wiring are one example; visible differences are not')
puts 'PASS identical example markup is shown once'
