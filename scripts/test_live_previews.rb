# frozen_string_literal: true
# Run with ruby scripts/test_live_previews.rb. Template previews the agent builds for a served review.
ENV['DCR_FOCUS'] = '0' # never raise the reader's browser from a test
require 'tmpdir'
require 'base64'
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config')
require 'open3'
require 'rbconfig'
require_relative '../lib/dcr/server'
require_relative '../lib/dcr/state'
require_relative '../lib/dcr/previews'

def assert(condition, message)
  raise message unless condition
end

def rejects(message)
  yield
  raise "Accepted: #{message}"
rescue ArgumentError => error
  error.message
end

KEY = 'dynamic-review:abc123:feature:2'
PATH = 'app/views/orders/show.html.erb'

# --- what an agent may submit -----------------------------------------------------------------
OFFLINE = Object.new.tap { |source| def source.icon(*) = nil } # no Lucide downloads in tests
built = DCR::Previews.build(<<~HTML, title: ' Order page ', icons: OFFLINE)
  <div class="order"><i class="order__tick" data-icon="check"></i><i data-icon="no-such-icon"></i><i class="fa-solid fa-truck order__truck"></i>
  <img src="https://cdn.example.test/p.png" width="40" height="30" srcset="x 2x">
  <script>alert(1)</script><iframe src="https://evil.test"></iframe><link rel="stylesheet" href="https://evil.test/a.css">
  <a href="javascript:steal()" onclick="steal()">go</a><button onmouseover="x()">Pay</button>
  <style>@import url(https://evil.test/x.css); .order{background:url(https://evil.test/bg.png);color:red}</style></div>
HTML
html = built['html']
assert(html.include?('class="order"') && html.include?('>Pay</button>') && html.include?('color:red'), 'Legitimate markup and styles must survive')
assert(html.include?('stroke-linecap') && built['mocks'].values_at('icons', 'placeholders', 'image_placeholders') == [1, 2, 1], "Icon and image stand-ins are wrong: #{built['mocks']}")
assert(html.include?('class="order__tick review-mock-icon"') && built['mocks']['unknown_icons'] == ['no-such-icon'] && built['mocks']['unmatched'] == ['fa-truck'], "The agent must be told which icons to choose again: #{built['mocks']}")
%w[<script <iframe <link alert(1) javascript: onclick onmouseover evil.test @import cdn.example.test srcset].each { |bad| assert(!html.include?(bad), "Unsafe content survived: #{bad}") }
assert(built['title'] == 'Order page', 'The title must be trimmed')
fenced = DCR::Previews.build("```html\n<p>Hello</p>\n```")
assert(fenced['html'].include?('<p>Hello</p>') && !fenced['html'].include?('```'), 'A Markdown fence around the HTML is removed')
document = DCR::Previews.build("<!doctype html><html><head><title>t</title><style>.a{color:blue}</style></head><body><p class=\"a\">In body</p></body></html>")
assert(document['html'].include?('In body') && document['html'].include?('.a{color:blue}') && !document['html'].include?('<title>t</title>'), 'A whole document is reduced to its body and styles')
messages = [
  rejects('prose before the HTML') { DCR::Previews.build("Here is the preview:\n<div>x</div>") },
  rejects('prose after the HTML') { DCR::Previews.build("<div>x</div>\nLet me know!") },
  rejects('plain text') { DCR::Previews.build('just words') },
  rejects('empty') { DCR::Previews.build('  ') },
  rejects('oversized') { DCR::Previews.build("<div>#{'x' * (DCR::Previews::LIMIT + 1)}</div>") }
]
assert(messages[0].include?('Submit only HTML') && messages[4].include?('Simplify'), 'Rejections must tell the agent what to do')
puts 'PASS agent HTML keeps its markup and styles, loses anything that could run or fetch, and prose around it is refused with advice'

# --- real stylesheets: a capture from the app, or a drawn preview given the project's CSS ----------
stylesheet = '.pane{display:flex;height:100vh}.unused-rule{color:red}.dark .pane{background:#000}@media (min-width:600px){.pane .row{gap:4px}.nowhere{x:y}}' \
             '@import url(https://evil.test/x.css);.row{background:url(https://evil.test/bg.png)}'
captured = DCR::Previews.build('<div class="pane"><p class="row">Hi</p></div>', css: stylesheet, page_class: 'dark md:flex')
doc = captured['html']
assert(doc.include?('.pane{display:flex;height:900') && doc.include?('.dark .pane') && doc.include?('.pane .row{gap:4px}'), "Rules the markup uses must be kept: #{doc[0, 600]}")
assert(!doc.include?('unused-rule') && !doc.include?('nowhere') && !doc.include?('evil.test'), 'Unused or remote rules must be dropped')
assert(doc.include?('<body class="dark">'), 'The page classes must be kept, without classes that are not plain names')
puts 'PASS a drawn preview given the project stylesheet keeps only the rules its markup uses, safely, inside the page classes around it'

# --- the request lifecycle ---------------------------------------------------------------------
Dir.mktmpdir('dcr-previews-test') do |directory|
  series = File.join(directory, 'series')
  state = DCR::State.new(series)
  [['../etc/passwd', 'dotdot'], ['/abs/path.rb', 'absolute'], ['no-extension', 'no extension'], ["a b.rb", 'space']].each do |path, label|
    rejects(label) { state.request_preview(KEY, path) }
  end
  entry = state.request_preview(KEY, PATH)
  assert(entry['kind'] == 'preview' && entry['path'] == PATH && state.read.dig('previews', KEY, PATH, 'status') == 'requested', 'A request must be queued and recorded')
  rejects('a second request while one is being built') { state.request_preview(KEY, PATH) }
  assert(state.pending.length == 1, 'Only one request may be queued')
  state.ack(entry['seq'])
  assert(state.read.dig('previews', KEY, PATH, 'status') == 'working' && state.read.dig('previews', KEY, PATH, 'delivered_at'), 'Handing the request over means the agent is working on it')
  rejects('submitting a template nobody asked for') { state.submit_preview('app/views/other.html.erb', DCR::Previews.build('<p>x</p>')) }
  state.submit_preview(PATH, DCR::Previews.build('<p>Done</p>', title: 'Order'))
  ready = state.read.dig('previews', KEY, PATH)
  assert(ready['status'] == 'ready' && ready['html'].include?('Done') && ready['title'] == 'Order', 'A submitted preview is ready')
  state.request_preview(KEY, PATH) # building it again after it is ready is allowed
  state.fail_preview(PATH, 'The template needs a database to render anything useful.')
  assert(state.read.dig('previews', KEY, PATH).values_at('status', 'error') == ['failed', 'The template needs a database to render anything useful.'], 'A failure keeps its reason')
  fp = 'a' * 64
  old_key = "dynamic-review:#{fp}:feat:1"
  state.request_preview(old_key, PATH)
  state.carry_forward('feat', [{'number' => 1, 'fingerprint' => fp}, {'number' => 2, 'fingerprint' => fp}])
  assert(state.read.dig('previews', "dynamic-review:#{fp}:feat:2", PATH, 'status') == 'requested', 'A same-code revision keeps its previews')
  puts 'PASS a preview request is queued once, becomes working when the agent has it, then ready or failed, and follows a same-code revision'

  # --- what the agent sees and does -------------------------------------------------------------
  dcr = File.expand_path('../bin/dcr', __dir__)
  run = ->(*args, stdin: nil) { Open3.capture3(RbConfig.ruby, dcr, *args, stdin_data: stdin.to_s) }
  agent_dir = File.join(directory, 'agent')
  agent = DCR::State.new(agent_dir)
  agent.request_preview(KEY, PATH)
  out, _err, status = run.call('wait', '--dir', agent_dir, '--timeout', '3')
  assert(status.success? && out.start_with?('PREVIEW REQUEST. Draw the HTML'), 'A preview request opens with its own rule, not the reply-only conversation rule')
  assert(!out.include?('REPLY ONLY') && !out.include?('dcr reply'), 'A pure preview request is not a conversation')
  %w[PREVIEW\ REQUEST:\ app/views/orders/show.html.erb everything\ it\ renders Submit\ ONLY\ HTML data-icon dcr\ preview\ submit dcr\ preview\ fail].each { |needle| assert(out.include?(needle), "The request is missing: #{needle}") }
  assert(out.include?('Do not edit, create or delete anything in the project'), 'The request forbids project changes')
  assert(agent.read.dig('previews', KEY, PATH, 'status') == 'working', 'Printing the request marks it working')
  assert(!out.include?('resolve threads') && out.include?('Then run `dcr wait` again') && out.rstrip.end_with?('Reminder: submit HTML only, change nothing in the project.'), 'A pure preview request has no thread instructions')
  assert(out.include?('--css') && out.include?('data-icon') && out.include?('--image-map'), 'The agent draws with the real stylesheet and chooses icons and photos')
  out, err, status = run.call('preview', 'submit', '--dir', agent_dir, '--path', PATH, '--title', 'Order', stdin: '<section><h1>Order 7</h1></section>')
  assert(status.success? && out.include?('is ready in the review') && agent.read.dig('previews', KEY, PATH, 'status') == 'ready', "Submitting on stdin failed: #{err}")
  file = File.join(directory, 'p.html')
  File.write(file, '<p>From a file, Reply to Priya Shah…</p>')
  agent.request_preview(KEY, PATH)
  _out, err, status = run.call('preview', 'submit', '--dir', agent_dir, '--path', PATH, '--file', file)
  assert(status.success? && agent.read.dig('previews', KEY, PATH, 'html').include?('From a file'), "Submitting a file failed: #{err}")
  photo = File.join(directory, 'face.png')
  File.binwrite(photo, Base64.strict_decode64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='))
  File.write(file, '<div><img src="avatar.jpg" width="32" height="32" alt="Priya"><img src="unit.jpg" width="80" height="60"></div>')
  agent.request_preview(KEY, PATH)
  out, err, status = run.call('preview', 'submit', '--dir', agent_dir, '--path', PATH, '--file', file, '--image-map', JSON.generate('avatar.jpg' => {'path' => photo, 'credit' => 'randomuser.me'}))
  photo_html = agent.read.dig('previews', KEY, PATH, 'html').to_s
  assert(status.success? && photo_html.include?('data:image/png;base64,') && !photo_html.include?('avatar.jpg'), "A mapped photo must be embedded: #{err}")
  assert(out.include?('Images left as placeholders: unit.jpg'), "Unmapped images must be listed for the agent: #{out}")
  agent.request_preview(KEY, PATH)
  _out, err, status = run.call('preview', 'submit', '--dir', agent_dir, '--path', PATH, stdin: "Sure! Here you go:\n<p>x</p>")
  assert(!status.success? && err.include?('Submit only HTML'), 'Prose around the HTML must be refused')
  assert(agent.read.dig('previews', KEY, PATH, 'status') == 'requested', 'A refused submission leaves the request open')
  _out, err, status = run.call('preview', 'submit', '--dir', agent_dir, '--path', 'app/views/never.html.erb', stdin: '<p>x</p>')
  assert(!status.success? && err.include?('No preview of app/views/never.html.erb was requested'), 'A preview nobody asked for is refused clearly')
  _out, err, status = run.call('preview', 'fail', '--dir', agent_dir, '--path', PATH, '--reason', 'Needs live data')
  assert(status.success? && agent.read.dig('previews', KEY, PATH, 'status') == 'failed', "Failing a preview did not work: #{err}")
  agent.send_items(KEY, [{'id' => 'c1', 'text' => 'a question'}])
  agent.request_preview(KEY, PATH)
  out, = run.call('wait', '--dir', agent_dir, '--timeout', '3')
  assert(out.include?('REPLY ONLY') && out.include?('PREVIEW REQUEST: app/views') && out.include?('a question'), 'A mixed batch carries both rules')
  puts 'PASS dcr wait prints a self-contained preview request, dcr preview submit takes only HTML from a file or stdin, and mistakes get a clear message'

  # --- the page's side ----------------------------------------------------------------------------
  FileUtils.mkdir_p(series)
  File.write(File.join(series, 'current.html'), %(<html><body><script type="application/json" id="data">{}</script></body></html>))
  server = DCR::Server.new(directory: File.join(directory, 'capture'), report: File.join(series, 'current.html'))
  Thread.new { server.run }
  request = lambda do |method, path, body = '', extra = {}|
    socket = TCPSocket.new('127.0.0.1', server.port)
    headers = {'Host' => "127.0.0.1:#{server.port}", 'Content-Length' => body.bytesize.to_s, 'Origin' => server.url, 'X-QA-Token' => server.token}.merge(extra).compact
    socket.write("#{method} #{path} HTTP/1.1\r\n#{headers.map { |key, value| "#{key}: #{value}" }.join("\r\n")}\r\n\r\n#{body}")
    socket.close_write
    response = +''
    begin
      loop { response << socket.readpartial(65_536) }
    rescue EOFError, Errno::ECONNRESET
      nil
    end
    socket.close
    response
  end
  json = ->(response) { JSON.parse(response.split("\r\n\r\n", 2).last) }
  begin
    assert(request.call('POST', '/api/preview', JSON.generate(key: KEY, path: '../x.rb')).start_with?('HTTP/1.1 400'), 'A bad path must be refused')
    assert(request.call('POST', '/api/preview', JSON.generate(key: KEY, path: PATH), 'Origin' => 'https://evil.example').start_with?('HTTP/1.1 400'), 'A foreign origin must be refused')
    assert(request.call('POST', '/api/preview', JSON.generate(key: KEY, path: PATH)).start_with?('HTTP/1.1 200'), 'The page could not request a preview')
    assert(request.call('POST', '/api/preview', JSON.generate(key: KEY, path: PATH)).start_with?('HTTP/1.1 400'), 'A duplicate request must be refused')
    snapshot = json.call(request.call('GET', "/api/state?key=#{KEY}"))
    assert(snapshot.dig('previews', PATH, 'status') == 'requested', 'The page sees the request')
    DCR::State.new(series).submit_preview(PATH, DCR::Previews.build('<p>Rendered</p>', title: 'Order'))
    alone = request.call('GET', "/preview?#{URI.encode_www_form(path: PATH)}", '', 'X-QA-Token' => nil, 'Origin' => nil)
    assert(alone.start_with?('HTTP/1.1 200') && alone.include?('<p>Rendered</p>') && alone.include?("script-src 'self'"), 'The agent can look at its preview on its own page')
    assert(request.call('GET', '/preview?path=app/views/none.html.erb', '', 'X-QA-Token' => nil, 'Origin' => nil).start_with?('HTTP/1.1 404'), 'A template with no ready preview is not found')
    snapshot = json.call(request.call('GET', "/api/state?key=#{KEY}"))
    assert(snapshot.dig('previews', PATH, 'status') == 'ready' && !snapshot.dig('previews', PATH).key?('html'), 'State carries status only, never the markup')
    fetched = json.call(request.call('GET', "/api/preview?key=#{KEY}&path=#{PATH}"))
    assert(fetched['html'].include?('Rendered') && fetched['ready_at'], 'The ready preview is fetched on its own')
    assert(request.call('GET', "/api/preview?key=#{KEY}&path=app/views/none.html.erb").start_with?('HTTP/1.1 400'), 'A preview that is not ready cannot be fetched')
    puts 'PASS the page can request a preview, sees its status without the markup, and fetches the ready preview separately'
  ensure
    server.close
  end
end
