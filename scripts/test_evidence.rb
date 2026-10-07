# frozen_string_literal: true
# Run with ruby scripts/test_evidence.rb. Uses a disposable git repository and series.
require 'base64'
require 'open3'
require 'timeout'
require 'rbconfig'
require_relative 'qa_capture'
require_relative 'test_series'
require_relative '../lib/dcr/evidence'
require_relative '../lib/dcr/state'
require_relative '../lib/dcr/export'

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
    html, warnings = DCR::Export.html(series_dir)
    assert(warnings.empty?, 'A small export should not warn')
    assert(html.include?('Checked: no caller passes nil') && html.include?('window.__DCR_EXPORT') && html.include?('"resolvedComments":["value-note"]'), 'The conversation and progress are not baked in')
    assert(html.index('__DCR_EXPORT') < html.index('id="data"'), 'The seed must run before the review script')
    assert(html.scan('data:image/png;base64,').length >= 2, 'Embedded recordings were dropped')
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
    assert(stamp.call(File.read(current)) == DynamicReviews.ui_version, 'A rendered report must carry the current UI version')
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
    assert(stamp.call(File.read(current)) == DynamicReviews.ui_version, 'The refreshed report does not carry the current UI version')
    assert(Dir[File.join(series_dir, 'revisions', '*.html')].sort.map { |path| [path, File.read(path)] } == revisions_before, 'Refreshing changed a saved revision')
    puts 'PASS serving by name refreshes a report from an older UI first and never touches saved revisions'

    server = QACapture::Server.new(directory: captures, report: File.join(series_dir, 'current.html'))
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
    server.close
    puts 'PASS the served page can download the export, and only with the review token and a trusted origin'
  end
end
