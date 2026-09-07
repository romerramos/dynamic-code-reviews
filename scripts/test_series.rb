#!/usr/bin/env ruby
# frozen_string_literal: true
require_relative 'test_review'
require_relative 'series'

module SeriesChecks
  module_function

  def assert(value, message)
    ReviewChecks.assert(value, message)
  end

  def rejects(message, &block)
    ReviewChecks.rejects(message, &block)
  end

  def initial(root)
    File.write(File.join(root, 'sample.rb'), "class Sample\n  def value\n    2\n  end\nend\n")
    snapshot = DynamicReviews.collect(repo: root)
    file = snapshot['files'].first
    hid = file['hunks'].first['id']
    review = {'title' => 'Sample review', 'summary' => 'Review the new value.', 'effort' => {'score' => 1, 'reason' => 'Small change'}, 'coverage' => 'Original review', 'validation' => ['Original test result'],
              'groups' => [{'title' => 'Values', 'summary' => 'Keep related values together.', 'layers' => [{'title' => 'Return a value', 'items' => [{'file' => file['id'], 'summaries' => {hid => 'Return two.'}}]}]}],
              'comments' => [{'id' => 'value-note', 'hunk' => hid, 'side' => 'new', 'start' => 3, 'end' => 3, 'label' => 'note', 'decoration' => 'non-blocking', 'subject' => 'A source range'}],
              'findings' => [{'id' => 'F1', 'hunk' => hid, 'severity' => 'P2', 'title' => 'An example concern', 'body' => 'Synthetic concern'}],
              'context' => ReviewSeries.contexts(snapshot, ['delete.txt'])}
    DynamicReviews.render(snapshot: snapshot, review: review, name: 'initial')
  end

  def increment(out, finding: true)
    plan = ReviewSeries.read(File.join(out, 'plan.json'))
    draft = ReviewSeries.read(File.join(out, 'draft.json'))
    group = draft['groups'].first
    layer = group['layers'].first
    items = plan['changes']['required_hunks'].group_by { |h| h['file'] }.map do |fid, hunks|
      {'group' => group['id'], 'layer' => layer['id'], 'file' => fid, 'summaries' => hunks.to_h { |h| [h['hunk'], 'Explain the changed behavior.'] }}
    end
    decision = if finding
      old = plan['previous_findings'].first
      mapped = plan['changes']['mapping'][old['hunk']]
      [{'id' => 'F1', 'status' => 'open', 'reason' => 'Rechecked the example concern.', 'finding' => old.merge('hunk' => mapped['hunk'])}]
    else
      [{'id' => 'F1', 'status' => 'needs-rechecking', 'reason' => 'The code left this scope; this is not proof of resolution.'}]
    end
    {'since_previous' => 'A new increment.', 'review' => {'coverage' => 'Inspected new ranges and related callers.', 'validation' => ['Current checks not run: synthetic fixture.']}, 'items' => items, 'finding_updates' => decision}
  end

  def run
    checks = {}
    checks['matches ranges despite changed IDs/offsets; rejects ambiguous content'] = lambda do
      old_hunk = DynamicReviews.hunks("@@ -10,2 +10,2 @@\n-old\n+new\n same\n", 'f2').first
      new_hunk = DynamicReviews.hunks("@@ -20,2 +22,2 @@\n-old\n+new\n same\n", 'f9').first
      old = {'files' => [{'id' => 'f2', 'path' => 'x.rb', 'hunks' => [old_hunk]}]}
      current = {'files' => [{'id' => 'f9', 'path' => 'x.rb', 'hunks' => [new_hunk]}]}
      result = ReviewSeries.compare(old, current)
      assert(result['mapping']['f2h1']['new_offset'] == 12, 'New-side remap lost offset')
      review = {'groups' => [{'layers' => [{'items' => [{'file' => 'f2', 'summaries' => {'f2h1' => 'Explanation'}}]}]}], 'comments' => [{'id' => 'note', 'hunk' => 'f2h1', 'side' => 'new', 'start' => 10, 'end' => 11}]}
      remapped = ReviewSeries.draft_review(review, current, result)
      assert(remapped['comments'][0].values_at('hunk', 'start', 'end') == ['f9h1', 22, 23], 'Comment did not follow content')
      current['files'][0]['hunks'] << new_hunk.merge('id' => 'f9h2')
      assert(ReviewSeries.compare(old, current)['mapping'].empty?, 'Ambiguous identical ranges were reused')
    end
    checks['saves immutable history, incrementally fills gaps and survives committing'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-increment-') do |out|
          report = initial(root)
          first = ReviewSeries.start(repo: root, name: 'values', report: report)
          original_bytes = File.binread(first)
          refreshed = ReviewSeries.refresh(repo: root, name: 'values')
          assert(DynamicReviews.extract(refreshed)['snapshot'] == DynamicReviews.extract(first)['snapshot'], 'UI refresh changed captured code')
          assert(ReviewSeries.manifest(File.dirname(refreshed))['revisions'].length == 1, 'UI refresh invented a revision')
          assert(File.binread(first) == original_bytes, 'UI refresh rewrote history')
          File.write(File.join(root, 'aaa.rb'), "NEW_VALUE = 3\n")
          result = ReviewSeries.prepare(repo: root, name: 'values', out: out)
          assert(result['reusable_ranges'] == 1 && result['ranges_to_inspect'].length == 1, 'Unchanged explanation not reused')
          draft = ReviewSeries.read(File.join(out, 'draft.json'))
          assert(draft['comments'][0]['hunk'] == 'f2h1', 'Sequential file ID change broke comment anchor')
          assert(draft['validation'].empty? && draft['findings'].empty?, 'Historical claims copied as fresh')
          update = increment(out)
          missing = ReviewSeries.copy(update); missing.delete('finding_updates')
          rejects('Old finding silently vanished') { ReviewSeries.publish(prepared: out, update: missing) }
          second = ReviewSeries.publish(prepared: out, update: update)
          payload = DynamicReviews.extract(second)
          assert(payload['review']['history']['revision'] == 2, 'Revision numbering failed')
          assert(payload['review']['findings'][0]['hunk'] == 'f2h1', 'Finding not remapped/reassessed')
          assert(File.binread(first) == original_bytes, 'Original revision changed')
          assert(File.read(File.join(root, '.reviews/values/index.html')).include?('002.html'), 'Index not advanced')
          rejects('Stale prepared review overwritten') { ReviewSeries.publish(prepared: out, update: update) }
          DynamicReviews.git(root, 'add', '.')
          tree = DynamicReviews.git(root, 'write-tree').strip
          parent = DynamicReviews.sha(root, 'HEAD')
          committed = DynamicReviews.git(root, 'commit-tree', tree, '-p', parent, '-m', 'test: commit reviewed changes').strip
          DynamicReviews.git(root, 'update-ref', 'HEAD', committed)
          unchanged = ReviewSeries.prepare(repo: root, name: 'values', out: out)
          assert(unchanged['status'] == 'unchanged', 'Committing alone created a fresh change')
          rejects('No-op revision created by default') { ReviewSeries.publish(prepared: out, update: update) }
          File.write(File.join(root, 'delete.txt'), "dependency changed\n")
          changed = ReviewSeries.prepare(repo: root, name: 'values', out: out)
          assert(changed['changed_context'] == ['delete.txt'] && changed['reusable_ranges'].zero?, 'Dependency edit did not invalidate reuse')
          update = increment(out, finding: false)
          third = ReviewSeries.publish(prepared: out, update: update)
          concern = DynamicReviews.extract(third)['review']['history']['finding_states'].find { |s| s['id'] == 'F1' }
          assert(concern['status'] == 'needs-rechecking', 'Unanchored concern was treated as resolved')
        end
      end
    end
    checks['detects edits after preparation and protects history paths'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-stale-') do |out|
          report = initial(root)
          ReviewSeries.start(repo: root, name: 'values', report: report)
          File.write(File.join(root, 'aaa.rb'), "VALUE = 1\n")
          ReviewSeries.prepare(repo: root, name: 'values', out: out)
          update = increment(out)
          File.write(File.join(root, 'aaa.rb'), "VALUE = 2\n")
          rejects('Published stale code') { ReviewSeries.publish(prepared: out, update: update) }
          rejects('Series was overwritten') { ReviewSeries.start(repo: root, name: 'values', report: report) }
          rejects('Accepted path traversal') { ReviewSeries.directory(root, '../escape', create: true) }
          File.symlink(out, File.join(root, '.reviews/escape'))
          rejects('Followed series symlink') { ReviewSeries.directory(root, 'escape', create: true) }
          File.write(File.join(out, 'private.txt'), 'outside')
          File.symlink(out, File.join(root, 'context-link'))
          rejects('Read context outside checkout') { ReviewSeries.context_digest({'repo' => root, 'mode' => 'uncommitted'}, 'context-link/private.txt') }
        end
      end
    end
    checks['keeps PR scope committed and rejects moved bases or rewritten history'] = lambda do
      ReviewChecks.fixture do |root, first|
        Dir.mktmpdir('review-pr-') do |out|
          original = DynamicReviews.extract(initial(root))
          DynamicReviews.git(root, 'add', 'sample.rb')
          tree = DynamicReviews.git(root, 'write-tree').strip
          second = DynamicReviews.git(root, 'commit-tree', tree, '-p', first, '-m', 'test: create PR snapshot').strip
          DynamicReviews.git(root, 'update-ref', 'HEAD', second)
          snapshot = DynamicReviews.collect(repo: root, mode: 'pr', base: first, head: second)
          report = DynamicReviews.render(snapshot: snapshot, review: original['review'], name: 'pr')
          ReviewSeries.start(repo: root, name: 'pr-values', report: report)
          File.write(File.join(root, 'sample.rb'), "dirty working content\n")
          rejects('PR continued without verified refs') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out) }
          unchanged = ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: second)
          assert(unchanged['status'] == 'unchanged', 'PR included dirty worktree content')
          rejects('Moved PR base was accepted') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: second, head: second) }
          rejects('Rewound PR head was accepted') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: first) }
          old = original['snapshot']
          metadata_only = ReviewSeries.copy(old)
          metadata_only['files'][0]['patch'] = "old mode 100644\nnew mode 100755\n" + metadata_only['files'][0]['patch']
          assert(ReviewSeries.code_key(old) != ReviewSeries.code_key(metadata_only), 'Executable-bit change was ignored')
        end
      end
    end
    checks.each { |description, check| check.call; puts "PASS #{description}" }
    puts "#{checks.length} series checks passed"
  end
end

SeriesChecks.run if $PROGRAM_NAME == __FILE__
