# frozen_string_literal: true
# Run with ruby scripts/test_evidence.rb. Uses a disposable git repository and series.
ENV['DCR_FOCUS'] = '0' # never raise the reader's browser from a test
require 'base64'
require 'open3'
require 'timeout'
require 'rbconfig'
require_relative '../lib/dcr/server'
require_relative 'test_series'
require_relative '../lib/dcr/evidence'
require_relative '../lib/dcr/state'
require_relative '../lib/dcr/export'
require_relative '../lib/dcr/previews'
require_relative '../lib/dcr/live_cli'

PNG = Base64.strict_decode64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=')

def assert(condition, message) = ReviewChecks.assert(condition, message)

def rejected(message)
  yield
  raise "Accepted: #{message}"
rescue ArgumentError
  nil
end

ReviewChecks.fixture do |root, _commit|
  Dir.mktmpdir('dcr-evidence-') do |captures|
    series = ReviewSeries.start(repo: root, name: 'evidence', report: SeriesChecks.initial(root))
    series_dir = File.dirname(File.dirname(series)) # start returns revisions/001.html
    png = File.join(captures, 'state-1234.png')
    File.binwrite(png, PNG)
    base = {'path' => png, 'title' => 'Value page', 'result' => 'failed', 'observed' => 'The value shows 2'}

    [[{'path' => ''}, 'no file'], [{'path' => '/etc/passwd'}, 'file outside the capture directory'],
     [{'title' => ' '}, 'blank title'], [{'observed' => ''}, 'blank observation'], [{'result' => 'maybe'}, 'unknown result'],
     [{'comment_id' => 'nope'}, 'unknown comment']].each do |change, label|
      rejected(label) { DCR::Evidence.attach(series_dir: series_dir, capture_dir: captures, input: base.merge(change)) }
    end
    File.write(File.join(captures, 'notes.txt'), 'x')
    rejected('non-media file') { DCR::Evidence.attach(series_dir: series_dir, capture_dir: captures, input: base.merge('path' => File.join(captures, 'notes.txt'))) }
    File.symlink('/etc/hosts', File.join(captures, 'link.png'))
    rejected('symlink') { DCR::Evidence.attach(series_dir: series_dir, capture_dir: captures, input: base.merge('path' => File.join(captures, 'link.png'))) }
    assert(ReviewSeries.manifest(series_dir)['revisions'].length == 1, 'A rejected attachment saved a revision')
    puts 'PASS attaching refuses missing, foreign, symlinked and non-media files, blank text and unknown comments, saving nothing'

    result = DCR::Evidence.attach(series_dir: series_dir, capture_dir: captures, input: base.merge('comment_id' => 'value-note'))
    assert(result['revision'] == 2, 'Attaching did not save the next revision')
    saved = DynamicReviews.extract(File.join(series_dir, 'revisions', '002.html'))
    flow = saved['review']['qa']['flows'].last
    assert(flow['result'] == 'failed' && flow['comment_id'] == 'value-note' && flow['assets'][0]['data_uri'].start_with?('data:image/png;base64,'), 'The recording is not embedded in the revision')
    assert(saved['review']['qa']['status'] == 'partial' && saved['review']['qa']['environment'].include?('not verified'), 'Reviewer evidence must not claim a verified build')
    assert(saved['snapshot'] == DynamicReviews.extract(File.join(series_dir, 'revisions', '001.html'))['snapshot'], 'Attaching changed the captured code')
    assert(Dir.children(captures).none? { |name| name.start_with?('attach-') }, 'The temporary update file was left behind')
    second = DCR::Evidence.attach(series_dir: series_dir, capture_dir: captures, input: base.merge('title' => 'Again'))
    assert(second['revision'] == 3 && DynamicReviews.extract(File.join(series_dir, 'revisions', '003.html'))['review']['qa']['flows'].length == 2, 'A second recording must be added, not replace the first')
    puts 'PASS a reviewer recording becomes a new revision of the same code with its evidence embedded, and later ones add to it'

    rejected('a batch with one bad item') { DCR::Evidence.attach_all(series_dir: series_dir, capture_dir: captures, inputs: [base, base.merge('observed' => '')]) }
    assert(ReviewSeries.manifest(series_dir)['revisions'].length == 3, 'A rejected batch must save nothing')
    batch = DCR::Evidence.attach_all(series_dir: series_dir, capture_dir: captures, inputs: [base.merge('title' => 'One', 'page' => '/inbox?status=closed'), base.merge('title' => 'Two', 'result' => 'passed')])
    flows = DynamicReviews.extract(File.join(series_dir, 'revisions', '004.html'))['review']['qa']['flows']
    assert(batch.values_at('revision', 'attached') == [4, 2] && flows.map { |item| item['title'] } == ['Value page', 'Again', 'One', 'Two'], 'A session of recordings must become one revision')
    assert(flows[2]['steps'] == ['Recorded by the reviewer on /inbox?status=closed.'], 'The page a recording was made on must be kept')
    puts 'PASS several recordings from one session save as one revision, and a bad one saves none'

    # The conversation survives: same code, so the new revision inherits progress and threads.
    manifest = ReviewSeries.manifest(series_dir)
    first, latest = manifest['revisions'].first, manifest['revisions'].last
    state = DCR::State.new(series_dir)
    old_key = "dynamic-review:#{first['fingerprint']}:evidence:#{first['number']}"
    state.save_blob(old_key, {'resolvedComments' => ['value-note']})
    state.send_items(old_key, [{'id' => 'value-note', 'text' => 'q'}])
    state.carry_forward('evidence', manifest['revisions'])
    new_key = "dynamic-review:#{latest['fingerprint']}:evidence:#{latest['number']}"
    assert(first['fingerprint'] == latest['fingerprint'] && state.read['threads'][new_key]['value-note']['live'], 'Attaching evidence must not lose the conversation')
    puts 'PASS the conversation carries to the revision that holds the new evidence'

    # Export: one offline file with the conversation baked in.
    state.agent_reply('value-note', 'Checked: no caller passes nil', key: new_key)
    state.agent_reply('value-note', 'tricky </script><img src=x onerror=alert(1)> text', key: new_key)
    saved_report = File.read(File.join(series_dir, 'current.html'))
    state.save_blob(new_key, {'resolvedComments' => ['value-note'], 'personalComments' => []})
    state.request_preview(new_key, 'app/views/orders/show.html.erb')
    state.submit_preview('app/views/orders/show.html.erb', DCR::Previews.build('<p class="exported-preview">Order 1042</p>', title: 'Order'))
    html, warnings = DCR::Export.html(series_dir)
    assert(warnings.empty?, 'A small export should not warn')
    assert(html.include?('Checked: no caller passes nil') && html.include?('window.__DCR_EXPORT') && html.include?('"resolvedComments":["value-note"]'), 'The conversation and progress are not baked in')
    assert(html.index('__DCR_EXPORT') < html.index('id="data"'), 'The seed must run before the review script')
    assert(html.scan('data:image/png;base64,').length >= 2, 'Embedded recordings were dropped')
    assert(html.include?('exported-preview') && html.include?('"path":"app\\/views\\/orders\\/show.html.erb"') && html.include?('Order 1042'), 'A preview your agent built is part of the export')
    assert(!html.include?('qa-token') && !html.include?('/api/') && !html.include?('X-QA-Token'), 'An export must not carry the server token or API')
    assert(!html.include?('</script><img') && html.include?('tricky '), 'A message containing a script end tag must not break out of the seed script')
    assert(File.read(File.join(series_dir, 'current.html')) == saved_report, 'Exporting changed the saved report')
    out = File.join(captures, 'exported.html')
    stdout, stderr, status = Open3.capture3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'export', '--dir', series_dir, '--out', out)
    assert(status.success? && stdout.strip == out && File.read(out) == html && File.stat(out).mode & 0o777 == 0o600, "dcr export failed: #{stderr}")
    puts 'PASS dcr export writes one offline file with threads, progress and recordings, no server token, leaving the saved report unchanged'

    # Serving by name refreshes a page saved by an older UI, and leaves a current one alone.
    current = File.join(series_dir, 'current.html')
    stamp = ->(html) { html[/<meta name="dcr-ui" content="([0-9a-f]+)">/, 1] }
    assert(stamp.call(File.read(current)) == DCR::Page.ui_version, 'A rendered report must carry the current UI version')
    serve = lambda do
      stdin, stdout, stderr, thread = Open3.popen3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'serve', '--repo', root, '--name', 'evidence')
      stdin.close
      url = Timeout.timeout(30) { stdout.gets.to_s }
      Process.kill('TERM', thread.pid)
      thread.value
      [url, stderr.read]
    end
    revisions_before = Dir[File.join(series_dir, 'revisions', '*.html')].sort.map { |path| [path, File.read(path)] }
    url, warning = serve.call
    assert(url.include?('http://127.0.0.1:') && warning.empty?, "A current report must be served as is: #{warning}")
    File.write(current, File.read(current).sub(/(<meta name="dcr-ui" content=")[0-9a-f]+/, '\\1old'))
    url, warning = serve.call
    assert(url.include?('http://127.0.0.1:') && warning.include?('Refreshed the saved report'), "A stale report must be refreshed before serving: #{warning}")
    assert(stamp.call(File.read(current)) == DCR::Page.ui_version, 'The refreshed report does not carry the current UI version')
    assert(Dir[File.join(series_dir, 'revisions', '*.html')].sort.map { |path| [path, File.read(path)] } == revisions_before, 'Refreshing changed a saved revision')
    puts 'PASS serving by name refreshes a report from an older UI first and never touches saved revisions'

    server = DCR::Server.new(directory: captures, report: File.join(series_dir, 'current.html'))
    Thread.new { server.run }
    fetch = lambda do |extra = {}|
      socket = TCPSocket.new('127.0.0.1', server.port)
      headers = {'Host' => "127.0.0.1:#{server.port}", 'X-QA-Token' => server.token}.merge(extra).compact
      socket.write("GET /api/export HTTP/1.1\r\n#{headers.map { |key, value| "#{key}: #{value}" }.join("\r\n")}\r\n\r\n")
      response = +''
      begin
        loop { response << socket.readpartial(65_536) }
      rescue EOFError, Errno::ECONNRESET
        nil
      end
      response
    end
    ok = fetch.call
    assert(ok.start_with?('HTTP/1.1 200') && ok.include?('Content-Disposition: attachment; filename="evidence-review.html"') && ok.include?('__DCR_EXPORT'), 'The served export is not a download of the baked file')
    assert(fetch.call('X-QA-Token' => 'wrong').start_with?('HTTP/1.1 400') && fetch.call('Origin' => 'https://evil.example').start_with?('HTTP/1.1 400'), 'Export must need the token and a trusted origin')
    puts 'PASS the served page can download the export, and only with the review token and a trusted origin'

    # Start QA review: the server writes the request with the real recorder folder and comments,
    # and dcr wait hands it over as a task, not a reply-only conversation.
    latest = ReviewSeries.manifest(series_dir)['revisions'].last
    review_key = "dynamic-review:#{latest['fingerprint']}:evidence:#{latest['number']}"
    # A comment on the app from before anchors had a kind must still be listed.
    DCR::State.new(series_dir).send_items(review_key, [{'id' => 'app-old1', 'text' => 't', 'message' => 'The Filters button looks off', 'anchor' => {'selector' => 'button[data-test="assignee-trigger"]', 'path' => '/inbox', 'text' => 'Filters'}}])
    socket = TCPSocket.new('127.0.0.1', server.port)
    body = JSON.generate(key: review_key, route: '/inbox')
    socket.write("POST /api/qa HTTP/1.1\r\nHost: 127.0.0.1:#{server.port}\r\nX-QA-Token: #{server.token}\r\nOrigin: #{server.url}\r\nContent-Type: application/json\r\nContent-Length: #{body.bytesize}\r\n\r\n#{body}")
    answer = +''
    begin
      loop { answer << socket.readpartial(65_536) }
    rescue EOFError, Errno::ECONNRESET
      nil
    end
    qa_id = JSON.parse(answer.split("\r\n\r\n", 2).last)['id']
    queued = DCR::State.new(series_dir).pending.last
    assert(qa_id&.start_with?('app-qa-') && queued['kind'] == 'qa' && queued['thread_ids'] == [qa_id], "A QA request must be queued as its own kind: #{answer[0, 200]}")
    assert(queued['text'].include?('app-old1: on /inbox') && queued['text'].include?('The Filters button looks off'), 'Comments on the app must be listed, also ones made before anchors had a kind')
    assert(queued['text'].include?("record --out #{captures}") && queued['text'].include?('value-note') && queued['text'].include?("reply --repo") && queued['text'].include?(qa_id), 'The QA request must name the recorder folder, the comments and its thread')
    printed = DCR::LiveCLI.render([queued], '--repo r --name s')
    assert(printed.start_with?('QA REQUEST.') && !printed.include?('REPLY ONLY') && printed.include?('record and attach only'), 'dcr wait must hand a QA request over as a task')
    server.close
    puts 'PASS Start QA review queues a task for the agent with the recorder folder, the comments and its thread'

    # The agent attaches what it recorded: one revision, each recording on its comment.
    items = File.join(captures, 'items.json')
    File.write(items, JSON.generate([{'path' => png, 'comment_id' => 'value-note', 'title' => 'Value page, recorded by the agent', 'result' => 'passed', 'observed' => 'The value shows 3.', 'page' => '/values'}]))
    before = ReviewSeries.manifest(series_dir)['revisions'].length
    out, err, status = Open3.capture3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'evidence', 'attach', '--dir', series_dir, '--file', items)
    flows = DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']['flows']
    assert(status.success? && out.include?('Attached 1 recording') && ReviewSeries.manifest(series_dir)['revisions'].length == before + 1, "dcr evidence attach failed: #{err}")
    assert(flows.last.values_at('title', 'comment_id') == ['Value page, recorded by the agent', 'value-note'], 'The agent recording must land on its comment')
    assert(flows.last['steps'] == ['Recorded by the agent on /values.'], 'Agent evidence must say the agent recorded it, not the reviewer')
    assert(DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']['status'] == 'complete', 'A finished QA review must be complete, so the Overview shows no partial-evidence note')
    qa = DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']
    assert(qa['summary'] == '1 recording, all passed; 4 recordings by the reviewer.' && qa['environment'].include?('Recorded by the reviewer') && qa['environment'].include?('Recorded by the agent'), "A series with both kinds of recordings must say what each holds: #{qa['summary']}")
    # A second QA review replaces the first one's clips instead of adding to them; the reviewer's stay.
    reviewer_flows = flows.count { |item| item['source'] == 'reviewer' || Array(item['steps']).first.to_s.start_with?('Recorded by the reviewer') }
    File.write(items, JSON.generate([{'path' => png, 'comment_id' => 'value-note', 'title' => 'Value page, second QA review', 'result' => 'passed', 'observed' => 'The value shows 3.', 'page' => '/values'}]))
    out, err, status = Open3.capture3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'evidence', 'attach', '--dir', series_dir, '--file', items)
    again = DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']['flows']
    assert(status.success? && out.include?('replacing 1 from the previous QA review'), "The second QA review must say it replaced the first: #{out}#{err}")
    assert(again.count { |item| item['source'] == 'agent' } == 1 && again.last['title'] == 'Value page, second QA review', 'Only the latest QA review clips may remain')
    assert(again.count { |item| item['source'] == 'reviewer' || Array(item['steps']).first.to_s.start_with?('Recorded by the reviewer') } == reviewer_flows, 'The reviewer recordings must stay')
    _, err, status = Open3.capture3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'evidence', 'attach', '--dir', series_dir, '--file', items, '--replace', 'all')
    fresh = DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']['flows']
    assert(status.success? && fresh.map { |item| item['title'] } == ['Value page, second QA review'], "Starting over must leave only the new recordings: #{err}")
    fresh_qa = DynamicReviews.extract(File.join(series_dir, 'current.html'))['review']['qa']
    assert(fresh_qa['summary'] == '1 recording, all passed.' && !fresh_qa['environment'].include?('Recorded by the reviewer'), "The QA summary must describe only the recordings that remain: #{fresh_qa.slice('summary', 'environment')}")
    File.write(items, JSON.generate([{'path' => '/etc/hosts', 'title' => 'x', 'result' => 'passed', 'observed' => 'x'}]))
    _, err, status = Open3.capture3(RbConfig.ruby, File.expand_path('../bin/dcr', __dir__), 'evidence', 'attach', '--dir', series_dir, '--file', items)
    assert(!status.success? && err.include?('not a recorder folder'), 'Only files from a recorder folder can be attached')
    puts 'PASS dcr evidence attach puts the agent recordings on their comments as one revision, from a recorder folder only'
  end
end
