#!/usr/bin/env ruby
# frozen_string_literal: true

# Run with ruby scripts/test_review.rb. No gems or application database needed.
require 'tmpdir'
require_relative 'review'

module ReviewChecks
  def self.assert(condition, message)
    raise message unless condition
  end

  def self.rejects(message)
    begin
      yield
    rescue ArgumentError
      return
    end
    raise message
  end

  def self.fixture
    identity = %w[user.name user.email].to_h do |key|
      value, status = Open3.capture2('git', 'config', '--get', key)
      raise "Configure your own Git #{key} before running the fixture checks" unless status.success? && !value.strip.empty?
      [key, value.strip]
    end
    Dir.mktmpdir('dynamic-review-check-') do |root|
      DynamicReviews.git(root, 'init', '-q')
      # Preserve the user's existing Git identity in disposable local fixtures.
      identity.each { |key, value| DynamicReviews.git(root, 'config', '--local', key, value) }
      File.write(File.join(root, 'sample.rb'), "class Sample\n  def value\n    1\n  end\nend\n")
      File.write(File.join(root, 'delete.txt'), "old\n")
      DynamicReviews.git(root, 'add', '.')
      tree = DynamicReviews.git(root, 'write-tree').strip
      commit = DynamicReviews.git(root, 'commit-tree', tree, '-m', 'test: create local review fixture').strip
      DynamicReviews.git(root, 'update-ref', 'HEAD', commit)
      yield root, commit
    end
  end

  def self.run
    checks = {}
    checks['pairs replacement blocks and preserves line numbers'] = lambda do
      patch = "@@ -10,4 +10,5 @@\n same\n-old one\n-old two\n+new one\n+new two\n+new three\n tail\n"
      hunk = DynamicReviews.hunks(patch, 'f1').first
      rows = DynamicReviews.diff_rows(hunk)
      assert(rows['split'][1]['old']['text'] == 'old one' && rows['split'][1]['new']['text'] == 'new one', 'Replacement pair is not aligned')
      assert(rows['split'][3]['old'].nil? && rows['split'][3]['new']['new'] == 13, 'Extra addition needs an empty old cell')
      assert(rows['split'].last['old']['old'] == 13 && rows['split'].last['new']['new'] == 14, 'Context line numbers drifted')
    end
    checks['handles pure additions, deletions and missing final newline'] = lambda do
      addition = DynamicReviews.hunks("@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n", 'f1').first
      rows = DynamicReviews.diff_rows(addition)
      assert(rows['split'].all? { |row| row['old'].nil? }, 'Addition has phantom old numbers')
      assert(rows['unified'].last['no_newline'], 'Missing final newline was lost')
      deletion = DynamicReviews.hunks("@@ -4,1 +3,0 @@\n-gone\n", 'f2').first
      assert(DynamicReviews.diff_rows(deletion)['split'].first['new'].nil?, 'Deletion has phantom new number')
    end
    checks['collects net staged, unstaged, untracked and omitted content'] = lambda do
      fixture do |root, _commit|
        File.write(File.join(root, 'sample.rb'), "staged\n")
        DynamicReviews.git(root, 'add', 'sample.rb')
        File.write(File.join(root, 'sample.rb'), "final\n")
        File.delete(File.join(root, 'delete.txt'))
        File.write(File.join(root, '[literal].txt'), "literal\n")
        File.write(File.join(root, 'empty.txt'), '')
        File.write(File.join(root, '.env.local'), 'secret-fixture')
        File.binwrite(File.join(root, 'binary.bin'), "\0first")
        snapshot = DynamicReviews.collect(repo: root)
        files = snapshot['files'].to_h { |file| [file['path'], file] }
        assert(files['sample.rb']['patch'].include?('+final') && !files['sample.rb']['patch'].include?('+staged'), 'Net worktree scope is wrong')
        assert(files['delete.txt']['patch'].include?('-old'), 'Deletion missing')
        assert(files['[literal].txt']['patch'].include?('+literal'), 'Literal path not collected')
        assert(files.key?('empty.txt') && files['binary.bin']['patch'].empty?, 'Empty/binary accounting is wrong')
        assert(!JSON.generate(snapshot).include?('secret-fixture'), 'Sensitive file leaked')
        File.binwrite(File.join(root, 'binary.bin'), "\0changed")
        assert(snapshot['fingerprint'] != DynamicReviews.collect(repo: root)['fingerprint'], 'Omitted binary edit did not invalidate snapshot')
      end
    end
    checks['commit and PR scopes exclude dirty working files'] = lambda do
      fixture do |root, first|
        assert(DynamicReviews.collect(repo: root, mode: 'commit', commit: first)['files'].length == 2, 'Root commit scope failed')
        File.write(File.join(root, 'sample.rb'), "committed\n")
        DynamicReviews.git(root, 'add', '.')
        tree = DynamicReviews.git(root, 'write-tree').strip
        second = DynamicReviews.git(root, 'commit-tree', tree, '-p', first, '-m', 'test: update local review fixture').strip
        File.write(File.join(root, 'sample.rb'), "dirty\n")
        [DynamicReviews.collect(repo: root, mode: 'commit', commit: second), DynamicReviews.collect(repo: root, mode: 'pr', base: first, head: second)].each do |snapshot|
          assert(snapshot['files'].length == 1 && snapshot['files'][0]['patch'].include?('+committed'), 'Committed scope mismatch')
          assert(!snapshot['files'][0]['patch'].include?('+dirty'), 'Dirty content leaked into committed review')
        end
      end
    end
    checks['validates comment ranges, hunk coverage and safe offline rendering'] = lambda do
      fixture do |root, _commit|
        File.write(File.join(root, 'sample.rb'), "</script><script>unexpected()</script>\nsecond\n")
        snapshot = DynamicReviews.collect(repo: root)
        status = DynamicReviews.git(root, 'status', '--porcelain')
        file = snapshot['files'].first
        hunk = file['hunks'].first
        review = {'title' => 'Fixture', 'groups' => [{'title' => 'Group', 'layers' => [{'items' => [{'file' => file['id'], 'summaries' => {hunk['id'] => 'Explain this change'}}]}]}],
                  'comments' => [{'id' => 'note-1', 'label' => 'note', 'decoration' => 'non-blocking', 'subject' => 'A range note', 'hunk' => hunk['id'], 'side' => 'new', 'start' => 1, 'end' => 2}]}
        output = DynamicReviews.render(snapshot: snapshot, review: review, name: 'fixture')
        html = File.read(output)
        assert(!html.include?('</script><script>unexpected()'), 'Raw source can close the data script')
        assert(!html.match?(/<(?:script|link)\b[^>]*(?:src|href)=["']https?:/), 'Report depends on remote assets')
        assert(DynamicReviews.extract(output)['review']['comments'].first['end'] == 2, 'Round trip lost comment range')
        assert(DynamicReviews.git(root, 'status', '--porcelain') == status, 'Rendering changed source status')
        assert(!DynamicReviews.git(root, 'check-ignore', '.reviews/fixture.html').empty?, 'Report not ignored')
        assert(DynamicReviews.collect(repo: root)['fingerprint'] == snapshot['fingerprint'], 'Report altered collection scope')
        review['comments'][0]['end'] = 999
        rejects('Invalid comment accepted') { DynamicReviews.validate(snapshot, review) }
        review['comments'][0]['end'] = 2
        review['groups'][0]['layers'][0]['items'][0]['summaries'] = {}
        rejects('Missing hunk accepted') { DynamicReviews.validate(snapshot, review) }
      end
    end
    checks['validates QA media, status and comment references'] = lambda do
      snapshot = {'fingerprint' => 'fixture'}
      qa = {'status' => 'pending', 'fingerprint' => 'fixture', 'summary' => 'Capture planned', 'flows' => []}
      ReviewQA.validate(qa, snapshot)
      qa['status'] = 'awaiting-environment'
      ReviewQA.validate(qa, snapshot)
      qa['status'] = 'complete'
      rejects('Empty completed QA accepted') { ReviewQA.validate(qa, snapshot) }
      qa['environment'] = 'Synthetic fixture'
      qa['flows'] = [{'title' => 'State', 'steps' => ['Open'], 'expected' => 'Visible', 'observed' => 'Visible', 'result' => 'passed',
                      'assets' => [{'caption' => 'State', 'data_uri' => 'https://example.com/private.png'}]}]
      rejects('External media accepted') { ReviewQA.validate(qa, snapshot) }
      asset = qa['flows'][0]['assets'][0]
      asset['data_uri'] = 'data:image/png;base64,' + Base64.strict_encode64('<svg>not a PNG</svg>')
      rejects('Spoofed image accepted') { ReviewQA.validate(qa, snapshot) }
      asset['data_uri'] = 'data:image/png;base64,' + Base64.strict_encode64("\x89PNG\r\n\x1a\n".b)
      asset['comment_id'] = 'missing'
      rejects('Unknown comment accepted') { ReviewQA.validate(qa, snapshot, {'comments' => []}) }
      asset.delete('comment_id')
      qa['flows'][0]['comment_id'] = 'missing'
      rejects('Unknown flow owner accepted') { ReviewQA.validate(qa, snapshot, {'comments' => []}) }
      qa['flows'][0].delete('comment_id')
      qa['flows'][0]['journey'] = ['Open', 'Select']
      ReviewQA.validate(qa, snapshot)
      [[], [''], [1], 'Open'].each do |invalid|
        qa['flows'][0]['journey'] = invalid
        rejects('Invalid journey accepted') { ReviewQA.validate(qa, snapshot) }
      end
      qa['flows'][0].delete('journey')
      ReviewQA.validate(qa, snapshot)
      qa['flows'][0]['assets'] = []
      rejects('Completed visual QA without media accepted') { ReviewQA.validate(qa, snapshot) }
      qa['status'] = 'partial'
      ReviewQA.validate(qa, snapshot)
      qa['status'] = 'complete'
      qa['flows'][0]['assets'] = [asset]
      qa['flows'][0]['result'] = 'not-run'
      rejects('Unrun flow accepted as complete') { ReviewQA.validate(qa, snapshot) }
    end
    checks.each do |description, check|
      check.call
      puts "PASS #{description}"
    end
    puts "#{checks.length} checks passed"
  end
end

ReviewChecks.run if $PROGRAM_NAME == __FILE__
