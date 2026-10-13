#!/usr/bin/env ruby
# frozen_string_literal: true
ENV['DCR_FOCUS'] = '0' # never raise the reader's browser from a test
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
    checks['reorders existing groups explicitly and remaps related tests by file identity'] = lambda do
      draft = {'groups' => [{'id' => 'consumer', 'layers' => [{'id' => 'display', 'items' => [{'file' => 'f1'}]}]},
                           {'id' => 'producer', 'layers' => [{'id' => 'capture', 'items' => [{'file' => 'f2'}]}]}], 'comments' => []}
      reordered = ReviewSeries.apply_update(draft, {'group_order' => ['producer', 'consumer']})
      assert(reordered['groups'].map { |group| group['id'] } == ['producer', 'consumer'], 'Existing groups did not move')
      rejects('Accepted incomplete group order') { ReviewSeries.apply_update(draft, {'group_order' => ['producer']}) }
      rejects('Accepted duplicate group IDs') { ReviewSeries.apply_update(draft, {'group_order' => ['producer', 'producer']}) }
      panel = {'title' => 'Related tests', 'summary' => 'Values remain valid.', 'entities' => ['f1'], 'files' => ['f2']}
      old = {'groups' => [{'layers' => [{'items' => [{'file' => 'f1', 'summaries' => {'h1' => 'Value'}}, {'file' => 'f2', 'summaries' => {'h2' => 'Coverage'}}], 'related_tests' => [panel]}]}]}
      current = {'files' => [{'id' => 'f8', 'hunks' => [{'id' => 'h8'}]}, {'id' => 'f9', 'hunks' => [{'id' => 'h9'}]}]}
      changes = {'files' => [{'previous_file' => 'f1', 'file' => 'f8'}, {'previous_file' => 'f2', 'file' => 'f9'}],
                 'mapping' => {'h1' => {'hunk' => 'h8'}, 'h2' => {'hunk' => 'h9'}}}
      remapped = ReviewSeries.draft_review(old, current, changes).dig('groups', 0, 'layers', 0, 'related_tests', 0)
      assert(remapped['entities'] == ['f8'] && remapped['files'] == ['f9'], 'Related tests kept stale file IDs')
      changes['mapping'].delete('h2')
      assert(!ReviewSeries.draft_review(old, current, changes).dig('groups', 0, 'layers', 0).key?('related_tests'), 'Removed test ranges kept an empty panel')
    end
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
          series_path = File.dirname(File.dirname(first))
          older_view = DynamicReviews.extract(File.join(series_path, 'revision-001.html'))
          original = DynamicReviews.extract(first)
          assert(older_view['snapshot'] == original['snapshot'], 'Browsing older revision changed its code')
          assert(older_view['review'].reject { |key, _| key == 'history' } == original['review'].reject { |key, _| key == 'history' }, 'Browsing older revision changed its conclusions')
          assert(older_view['review']['history']['revision'] == 1, 'Older view lost its revision identity')
          assert(older_view['review']['history']['entries'].map { |entry| entry['number'] } == [1, 2], 'Older view cannot navigate to the newer revision')
          ReviewSeries.refresh(repo: root, name: 'values')
          assert(File.binread(first) == original_bytes, 'Refreshing navigation rewrote original snapshot')
          assert(DynamicReviews.extract(File.join(series_path, 'revision-001.html')) == older_view, 'Refresh changed older review data')
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
          # The same code reviewed again on purpose is the same revision, although the commit gave
          # it another fingerprint: what the reader has on it goes with it.
          state = DCR::State.new(series_path)
          key = ->(page) { DCR::State.review_key(DynamicReviews.extract(page)['snapshot']['fingerprint'], 'values', 2) }
          was = key.call(second)
          state.save_blob(was, {'viewedFiles' => ['aaa.rb']})
          again = ReviewSeries.publish(prepared: out, update: increment(out).merge('since_previous' => 'Checked again after committing.'), record: true)
          account = DynamicReviews.extract(again)['review']['history']
          entries = ReviewSeries.manifest(series_path)['revisions']
          assert(again == second && entries.length == 2 && entries.last['saves'].map { |save| save['summary'] } == ['Checked again after committing.'] && account.values_at('revision', 'save') == [2, 1], 'A review of unchanged code became a new revision')
          assert(account['files'].any? { |file| file['state'] != 'unchanged' }, 'The revision forgot which files it changed')
          assert(key.call(again) != was && state.read['blobs'] == {key.call(again) => {'viewedFiles' => ['aaa.rb']}}, 'The reader\'s progress did not follow the revision to its committed code')
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
          current = DynamicReviews.extract(File.join(root, '.reviews/pr-values/current.html'))
          assert(current['review']['history']['origin_mode'] == 'pr', 'PR comparison type lost in browsing view')
          labels = {'base' => first, 'head' => second, 'base_label' => 'main', 'head_label' => 'feature'}
          updated = ReviewSeries.apply_update(current['review'], {'review' => {'comparison' => labels}})
          assert(updated['comparison'] == labels, 'Comparison labels lost in review update')
          File.write(File.join(root, 'sample.rb'), "dirty working content\n")
          rejects('PR continued without verified refs') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out) }
          unchanged = ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: second)
          assert(unchanged['status'] == 'unchanged', 'PR included dirty worktree content')
          amended = DynamicReviews.git(root, 'commit-tree', tree, '-p', first, '-m', 'test: amended PR snapshot').strip
          amended_prepare = ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: amended)
          assert(amended_prepare['status'] == 'unchanged', 'Amended PR head with identical content was not accepted as unchanged')
          mixed = ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: second, working_tree: true)
          captured = ReviewSeries.read(File.join(out, 'snapshot.json'))
          assert(mixed['status'] == 'changed' && captured['working_tree'], 'Explicit local scope was not captured')
          assert(captured['files'].any? { |file| file['patch'].include?('dirty working content') }, 'Current file content missing')
          rejects('Mismatched checkout accepted') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: first, working_tree: true) }
          rejects('Moved PR base was accepted') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: second, head: second) }
          rejects('Rewound PR head was accepted') { ReviewSeries.prepare(repo: root, name: 'pr-values', out: out, base: first, head: first) }
          old = original['snapshot']
          metadata_only = ReviewSeries.copy(old)
          metadata_only['files'][0]['patch'] = "old mode 100644\nnew mode 100755\n" + metadata_only['files'][0]['patch']
          assert(ReviewSeries.code_key(old) != ReviewSeries.code_key(metadata_only), 'Executable-bit change was ignored')
        end
      end
    end
    checks['a pull request review follows the checkout only once its reviewer says so, and returns to the verified head'] = lambda do
      require_relative '../lib/dcr/github'
      ReviewChecks.fixture do |root, first|
        Dir.mktmpdir('review-pr-follow-') do |out|
          original = DynamicReviews.extract(initial(root))
          DynamicReviews.git(root, 'add', 'sample.rb')
          second = DynamicReviews.git(root, 'commit-tree', DynamicReviews.git(root, 'write-tree').strip, '-p', first, '-m', 'test: create PR snapshot').strip
          DynamicReviews.git(root, 'update-ref', 'HEAD', second)
          snapshot = DynamicReviews.collect(repo: root, mode: 'pr', base: first, head: second)
          review = original['review'].merge('comparison' => {'base' => snapshot['base'], 'head' => second, 'pr_url' => 'https://github.com/acme/app/pull/7'})
          ReviewSeries.start(repo: root, name: 'pr-follow', report: DynamicReviews.render(snapshot: snapshot, review: review, name: 'pr-follow'))
          series = File.join(root, '.reviews/pr-follow')
          assert(ReviewSeries.stale(repo: root, name: 'pr-follow') == {'changed' => 0, 'pinned' => true, 'pr' => true}, 'A pull request review did not say it follows the pull request')
          File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
          assert(ReviewSeries.stale(repo: root, name: 'pr-follow') == {'changed' => 1, 'pinned' => true, 'pr' => true}, 'The checkout was not compared with the pull request')
          rejects('A pull request review took the checkout unasked') { ReviewSeries.sync(repo: root, name: 'pr-follow') }
          result = ReviewSeries.sync(repo: root, name: 'pr-follow', follow: true)
          assert(result.values_at('status', 'revision') == ['updated', 2], 'Following the checkout did not save it')
          assert(ReviewSeries.manifest(series).values_at('follows', 'pinned_head') == ['checkout', second], 'The choice to follow the checkout was not kept')
          local = DynamicReviews.extract(File.join(series, 'current.html'))
          assert(local['review']['history']['local'] == true && local['snapshot']['working_tree'], 'The revision does not say it shows the checkout')
          assert(ReviewSeries.stale(repo: root, name: 'pr-follow') == {'changed' => 0, 'pr' => true}, 'A review that follows the checkout still asks')
          # GitHub takes comments only where the checkout shows what the pull request has.
          target = DCR::GitHub.new(series).send(:target, DCR::State.review_key(local['snapshot']['fingerprint'], 'pr-follow', 2))
          assert(target.values_at(:commit, :unpushed) == [second, ['extra.rb']] && target[:hunks].keys == ['sample.rb'], 'Comments could reach GitHub on code that is not pushed')
          File.write(File.join(root, 'extra.rb'), "EXTRA = 2\n")
          assert(ReviewSeries.sync(repo: root, name: 'pr-follow')['revision'] == 3, 'A later update asked again')
          # A review of the verified head again ends it, although local revisions came in between.
          File.unlink(File.join(root, 'extra.rb'))
          ReviewSeries.prepare(repo: root, name: 'pr-follow', out: out, base: first, head: second)
          ReviewSeries.publish(prepared: out, update: increment(out).merge('items' => []))
          assert(!ReviewSeries.manifest(series).key?('follows') && !DynamicReviews.extract(File.join(series, 'current.html'))['review']['history'].key?('local'), 'A review of the pull request did not end following the checkout')
          assert(ReviewSeries.stale(repo: root, name: 'pr-follow')['pinned'] == true, 'The review does not follow the pull request again')
          # Fix this asks for a change in the checkout, so it makes that choice itself.
          require_relative '../lib/dcr/live_api'
          current = DynamicReviews.extract(File.join(series, 'current.html'))
          key = DCR::State.review_key(current['snapshot']['fingerprint'], 'pr-follow', current['review']['history']['revision'])
          asked = DCR::LiveAPI.new(series).call('POST', '/api/fix', -> { JSON.generate({key: key, id: 'value-note', text: 'Use a named constant.'}) })
          assert(asked[0] == 200 && asked[1]['followed'] == true && !asked[1].key?('revision') && ReviewSeries.manifest(series)['follows'] == 'checkout', "A fix on a pull request's review did not have it follow the checkout: #{asked}")
          assert(DCR::State.new(series).read.dig('threads', key, 'value-note', 'fix', 'state') == 'requested', 'The fix did not reach the agent')
        end
      end
    end
    checks['Update on a pull request review takes the newer push from GitHub; the checkout only when the reader says so'] = lambda do
      require_relative '../lib/dcr/github'
      require_relative '../lib/dcr/live_api'
      ReviewChecks.fixture do |root, first|
        Dir.mktmpdir('review-pr-push-') do |out|
          original = DynamicReviews.extract(initial(root))
          git = ->(*args) { DynamicReviews.git(root, *args).strip }
          git.call('add', 'sample.rb')
          second = git.call('commit-tree', git.call('write-tree'), '-p', first, '-m', 'test: the pull request')
          git.call('update-ref', 'HEAD', second)
          snapshot = DynamicReviews.collect(repo: root, mode: 'pr', base: first, head: second)
          review = original['review'].merge('comparison' => {'base' => snapshot['base'], 'head' => second, 'pr_url' => 'https://github.com/acme/app/pull/7'})
          ReviewSeries.start(repo: root, name: 'pushed', report: DynamicReviews.render(snapshot: snapshot, review: review, name: 'pushed'))
          series = File.join(root, '.reviews/pushed')
          # Someone pushes a commit the checkout does not have checked out.
          File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
          git.call('add', 'extra.rb')
          third = git.call('commit-tree', git.call('write-tree'), '-p', second, '-m', 'test: a newer push')
          git.call('rm', '-q', '--cached', 'extra.rb')
          File.unlink(File.join(root, 'extra.rb'))
          gh = File.join(out, 'gh')
          File.write(gh, "#!/bin/sh\ncat #{File.join(out, 'pull.json')}\n")
          File.chmod(0o755, gh)
          at = ->(head) { File.write(File.join(out, 'pull.json'), JSON.generate('head' => {'sha' => head}, 'base' => {'sha' => first, 'ref' => 'main'})) }
          api = ->(method, body = {}) { DCR::LiveAPI.new(series, github: DCR::GitHub.new(series, gh: gh)).call(method, '/api/sync', -> { JSON.generate(body) })[1] }
          at.call(second)
          assert(api.call('GET').slice('pinned', 'pr', 'remote') == {'pinned' => true, 'pr' => true}, "A pull request with nothing new was reported as pushed to: #{api.call('GET')}")
          assert(api.call('POST', {'from' => 'pr'})['status'] == 'unchanged', 'An update from a pull request with nothing new saved a revision')
          at.call(third)
          assert(api.call('GET')['remote'].slice('head', 'changed') == {'head' => third, 'changed' => 1}, "A newer push was not noticed: #{api.call('GET')}")
          assert(api.call('POST', {'from' => 'pr'}).values_at('status', 'revision') == ['updated', 2], 'The newer push was not saved as the next revision')
          saved = DynamicReviews.extract(File.join(series, 'current.html'))
          assert(saved['snapshot']['head'] == third && !saved['snapshot']['working_tree'] && !saved['review']['history'].key?('local') && saved['snapshot']['files'].map { |file| file['path'] } == %w[extra.rb sample.rb], 'The revision does not show the pull request as pushed')
          assert(!api.call('GET').key?('remote'), 'A push the review already shows is still offered')
          # The checkout is shown when the reader chooses it, and the pull request takes it back.
          # A checkout that does not have the push yet cannot be shown, and stops nothing else.
          assert(api.call('GET').slice('changed', 'behind', 'unavailable') == {'changed' => 0, 'behind' => 'This checkout is behind the code the review shows: pull the branch first, or ask your agent for a new review'}, "A checkout behind the pull request made the review unavailable: #{api.call('GET')}")
          git.call('update-ref', 'HEAD', third)
          File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
          File.write(File.join(root, 'local.rb'), "LOCAL = 1\n")
          assert(api.call('GET').slice('changed', 'remote', 'behind') == {'changed' => 1}, "The checkout's own differences were lost: #{api.call('GET')}")
          assert(api.call('POST', {'follow' => true})['revision'] == 3 && ReviewSeries.manifest(series)['follows'] == 'checkout', 'The checkout was not followed when asked')
          assert(api.call('POST', {'from' => 'pr'})['revision'] == 4 && !ReviewSeries.manifest(series).key?('follows'), 'An update from the pull request did not take the review back to it')
          assert(DynamicReviews.extract(File.join(series, 'current.html'))['snapshot']['head'] == third, 'The review went back to something other than the pushed head')
        end
      end
    end
    checks['a branch that took in its base branch is updated from where it starts now, without what the base gained'] = lambda do
      ReviewChecks.fixture do |root, first|
        original = DynamicReviews.extract(initial(root))
        git = ->(*args) { DynamicReviews.git(root, *args).strip }
        git.call('add', 'sample.rb')
        second = git.call('commit-tree', git.call('write-tree'), '-p', first, '-m', 'test: the branch')
        git.call('update-ref', 'HEAD', second)
        git.call('update-ref', 'refs/heads/trunk', first)
        snapshot = DynamicReviews.collect(repo: root, mode: 'pr', base: first, head: second)
        review = original['review'].merge('comparison' => {'base' => snapshot['base'], 'head' => second, 'base_label' => 'trunk', 'pr_url' => 'https://github.com/acme/app/pull/7'})
        ReviewSeries.start(repo: root, name: 'merged', report: DynamicReviews.render(snapshot: snapshot, review: review, name: 'merged'))
        # trunk gains a change of its own, and the branch merges it in.
        File.write(File.join(root, 'delete.txt'), "newer\n")
        git.call('read-tree', first)
        git.call('add', 'delete.txt')
        trunk = git.call('commit-tree', git.call('write-tree'), '-p', first, '-m', 'test: trunk moves on')
        git.call('update-ref', 'refs/heads/trunk', trunk)
        git.call('add', 'sample.rb')
        git.call('update-ref', 'HEAD', git.call('commit-tree', git.call('write-tree'), '-p', second, '-p', trunk, '-m', 'test: merge trunk'))
        assert(ReviewSeries.stale(repo: root, name: 'merged') == {'changed' => 0, 'pinned' => true, 'pr' => true}, "What the base branch gained counts as the branch's change: #{ReviewSeries.stale(repo: root, name: 'merged')}")
        File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
        result = ReviewSeries.sync(repo: root, name: 'merged', follow: true)
        assert(result['files'] == [{'path' => 'extra.rb', 'state' => 'added'}] && ReviewSeries.manifest(File.join(root, '.reviews/merged'))['base'] == trunk, "The update did not go on from where the branch starts now: #{result['files']}")
        assert(DynamicReviews.extract(File.join(root, '.reviews/merged/current.html'))['snapshot']['files'].map { |file| file['path'] } == %w[extra.rb sample.rb], 'The review shows code the branch did not change')
        # A base branch that was rewritten (here: put back) is not somewhere to go on from: the reader is told.
        git.call('update-ref', 'refs/heads/trunk', first)
        assert(ReviewSeries.stale(repo: root, name: 'merged')['warning'].to_s.include?('Ask your agent for a new review'), 'A rewritten base branch was not reported')
      end
    end
    checks['attaches offline QA to the revision of its code without rewriting findings; rejects stale inputs'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-qa-check-') do |out|
          first = ReviewSeries.start(repo: root, name: 'qa-check', report: initial(root))
          payload = DynamicReviews.extract(first)
          png = Base64.strict_decode64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=')
          File.binwrite(File.join(out, 'state.png'), png)
          gif = Base64.strict_decode64('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=')
          File.binwrite(File.join(out, 'motion.gif'), gif)
          File.binwrite(File.join(out, 'motion.webm'), "\x1a\x45\xdf\xa3".b + 'video fixture')
          qa = {'status' => 'complete', 'fingerprint' => payload['snapshot']['fingerprint'], 'summary' => 'A synthetic state was captured.', 'environment' => 'Synthetic fixture, not an application test.',
                'flows' => [{'title' => 'Inspect state', 'steps' => ['Inspect a synthetic state'], 'expected' => 'A sample image', 'observed' => 'Sample image attached', 'result' => 'passed',
                             'motion_preview' => {'path' => 'motion.webm', 'caption' => 'Synthetic video fixture'},
                             'assets' => [{'path' => 'state.png', 'caption' => 'Synthetic fixture', 'comment_id' => 'value-note'},
                                          {'path' => 'motion.gif', 'caption' => 'Synthetic animation'}]}]}
          input = File.join(out, 'qa.json')
          File.write(input, JSON.generate(qa))
          second = ReviewSeries.qa(repo: root, name: 'qa-check', revision: 1, update: input)
          after = DynamicReviews.extract(second)
          assert(File.read(second).include?('media-src data:;'), 'Offline media blocked by report CSP')
          entry = ReviewSeries.manifest(File.dirname(File.dirname(first)))['revisions'].last
          assert(second == first && entry['number'] == 1 && entry['saves'].map { |save| save['summary'] } == ['QA evidence updated: A synthetic state was captured.'], 'QA of the same code is not a save into its revision')
          assert(after['review']['history'].values_at('revision', 'save', 'summary') == [1, 1, payload['review']['history']['summary']], 'The page does not say it is the same revision, saved once more')
          assert(after['snapshot'] == payload['snapshot'] && after['review']['findings'] == payload['review']['findings'], 'QA changed code conclusions')
          assert(after['review']['qa']['flows'][0]['assets'][0]['data_uri'].start_with?('data:image/png;base64,'), 'Media not embedded')
          assert(after['review']['qa']['flows'][0]['assets'][1]['data_uri'].start_with?('data:image/gif;base64,'), 'GIF not embedded')
          assert(after['review']['qa']['flows'][0]['motion_preview']['data_uri'].start_with?('data:video/webm;base64,'), 'Motion preview not embedded')
          assert(!after['review']['qa']['flows'][0]['assets'][0].key?('path'), 'Scratch path leaked into report')
          rejects('The same QA saved twice') { ReviewSeries.qa(repo: root, name: 'qa-check', revision: 1, update: input) }
          qa['summary'] = 'New evidence'; File.write(input, JSON.generate(qa))
          rejects('QA for another revision accepted') { ReviewSeries.qa(repo: root, name: 'qa-check', revision: 2, update: input) }
          qa['fingerprint'] = 'wrong'; File.write(input, JSON.generate(qa))
          rejects('Wrong snapshot accepted') { ReviewSeries.qa(repo: root, name: 'qa-check', revision: 1, update: input) }
          qa['fingerprint'] = payload['snapshot']['fingerprint']; File.write(input, JSON.generate(qa))
          File.write(File.join(root, 'sample.rb'), "changed after capture\n")
          rejects('Changed source accepted') { ReviewSeries.qa(repo: root, name: 'qa-check', revision: 1, update: input) }
          draft = ReviewSeries.draft_review(after['review'], after['snapshot'], ReviewSeries.compare(after['snapshot'], after['snapshot']))
          assert(!draft.key?('qa'), 'An increment silently reused historical QA')
          saved = ReviewSeries.manifest(File.dirname(File.dirname(first)))['revisions']
          assert(saved.length == 1 && saved.last['saves'].length == 1, 'Rejected QA was saved')
        end
      end
    end
    checks['opens an outline in progress, keeps posted comments and finishes in the same revision'] = lambda do
      require_relative '../lib/dcr/live_cli'
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-in-progress-') do |out|
          File.write(File.join(root, 'sample.rb'), "class Sample\n  def value\n    2\n  end\nend\n")
          snapshot = DynamicReviews.collect(repo: root)
          file = snapshot['files'].first
          hid = file['hunks'].first['id']
          outline = {'title' => 'Sample review', 'summary' => '', 'groups' => [{'title' => 'Values', 'summary' => 'Values.', 'layers' => [{'title' => 'Return a value', 'items' => [{'file' => file['id']}]}]}]}
          File.write(File.join(out, 'snapshot.json'), JSON.generate(snapshot))
          File.write(File.join(out, 'outline.json'), JSON.generate(outline))
          rejects('An unexplained review was saved as finished') { ReviewSeries.start(repo: root, name: 'live-check', snapshot: File.join(out, 'snapshot.json'), review: File.join(out, 'outline.json')) }
          first = ReviewSeries.start(repo: root, name: 'live-check', snapshot: File.join(out, 'snapshot.json'), review: File.join(out, 'outline.json'), in_progress: true)
          opened = DynamicReviews.extract(first)['review']
          assert(opened['status'] == 'in_progress', 'The outline was not marked in progress')
          assert(opened.dig('groups', 0, 'layers', 0, 'items', 0, 'summaries') == {hid => ''}, 'The outline did not give the walkthrough its ranges')
          series = File.dirname(File.dirname(first))
          state = DCR::State.new(series)
          comment = {'id' => 'value-two', 'hunk' => hid, 'side' => 'new', 'start' => 3, 'end' => 3, 'label' => 'question', 'decoration' => 'non-blocking', 'subject' => 'Why two?'}
          post = lambda do |value|
            File.write(File.join(out, 'comment.json'), JSON.generate(value))
            DCR::LiveCLI.comment(state, {file: File.join(out, 'comment.json')}, series)
          end
          post.call(comment)
          key = DCR::State.review_key(snapshot['fingerprint'], 'live-check', 1)
          assert(state.read.dig('comments', key).map { |entry| entry['id'] } == ['value-two'], 'The posted comment is not on the open review')
          rejects('A duplicate comment id was posted') { post.call(comment) }
          rejects('A comment outside its hunk was posted') { post.call(comment.merge('id' => 'far', 'start' => 40, 'end' => 40)) }
          # The Risk ranking arrives while the reader is on the diff, checked against the snapshot.
          risk = {'summary' => 'The value changes for every caller.', 'files' => [{'file' => file['id'], 'score' => 72, 'tags' => %w[shared-code user-facing], 'reason' => 'Every caller of value now gets two.', 'line' => 3}]}
          map = lambda do |value|
            File.write(File.join(out, 'risk.json'), JSON.generate(value))
            DCR::LiveCLI.risk_ranking(state, {file: File.join(out, 'risk.json')}, series)
          end
          rejects('An empty risk ranking was posted') { map.call(risk.merge('files' => [])) }
          rejects('A ranking of an unknown file was posted') { map.call(risk.merge('files' => [risk['files'][0].merge('file' => 'nope')])) }
          rejects('A tag outside the rubric was posted') { map.call(risk.merge('files' => [risk['files'][0].merge('tags' => ['browser-history'])])) }
          rejects('A file ranked twice was posted') { map.call(risk.merge('files' => risk['files'] * 2)) }
          rejects('A reason with a line break was posted') { map.call(risk.merge('files' => [risk['files'][0].merge('reason' => "One\nTwo")])) }
          DCR::LiveCLI.risk_ranking(state, {none: 'Only copy changed'}, series)
          assert(state.read.dig('risk_rankings', key, 'none') == 'Only copy changed', 'Saying no file stands out was not kept')
          File.binwrite(File.join(out, 'screen.png'), "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".unpack1('m'))
          File.write(File.join(out, 'shot.json'), JSON.generate('id' => 'two', 'path' => 'screen.png', 'title' => 'The value shows two', 'paths' => ['sample.rb']))
          DCR::LiveCLI.screenshot(state, {file: File.join(out, 'shot.json')}, series)
          map.call(risk)
          assert(state.read.dig('risk_rankings', key, 'files').length == 1, 'The posted risk ranking is not on the open review')
          rejects('An increment built on an unfinished review') { ReviewSeries.prepare(repo: root, name: 'live-check', out: File.join(out, 'prepared')) }
          full = outline.merge('summary' => 'Return two.', 'groups' => [{'title' => 'Values', 'summary' => 'Values.', 'layers' => [{'title' => 'Return a value', 'items' => [{'file' => file['id'], 'summaries' => {hid => 'Return two.'}}]}]}])
          File.write(File.join(out, 'full.json'), JSON.generate(full))
          second = ReviewSeries.finish(repo: root, name: 'live-check', review: File.join(out, 'full.json'))
          finished = DynamicReviews.extract(second)['review']
          assert(second == first && !finished.key?('status') && finished['history'].values_at('revision', 'save', 'summary') == [1, 1, 'Full review ready: walkthrough explanations, findings and validation.'], 'Finishing did not complete the revision the outline opened')
          assert(ReviewSeries.manifest(series)['revisions'].map { |entry| entry.values_at('number', 'summary') } == [[1, finished['history']['summary']]], 'The same code became a second revision')
          assert(finished['comments'].map { |entry| entry['id'] } == ['value-two'], 'Finishing lost the comment posted while in progress')
          assert(finished['risk_ranking'] == risk, 'Finishing lost the risk ranking posted while in progress')
          assert(finished['screenshots'].map { |shot| shot['id'] } == ['two'], 'Finishing lost the screenshot posted while in progress')
          rejects('A finished review was finished again') { ReviewSeries.finish(repo: root, name: 'live-check', review: File.join(out, 'full.json')) }
          rejects('A comment was posted to a finished review') { post.call(comment.merge('id' => 'late')) }
          # Rank again, on the finished review: the page shows it ranking and dcr wait hands the agent the task.
          done_key = key # the same code, so the same review: what the reader has on it stays
          state.request_risk_ranking(done_key)
          assert(state.read.dig('risk_rankings', done_key, 'requested'), 'A requested risk ranking does not show as being ranked')
          printed = DCR::LiveCLI.render(state.pending.last(1), '--repo r --name s')
          assert(printed.start_with?('RISK RANKING REQUEST.') && printed.include?('Rank the risk') && printed.include?('dcr risk-ranking --repo r --name s --file') && !printed.include?('REPLY ONLY'), "dcr wait must hand over the risk ranking request as a task:\n#{printed}")
          map.call(risk)
          assert(state.read.dig('risk_rankings', done_key, 'files').length == 1, 'A ranking redone on a finished review was not kept')
        end
      end
    end
    checks['updates a review to the current code: comments follow their lines or become outdated'] = lambda do
      require_relative '../lib/dcr/live_cli'
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-sync-') do |out|
          first = ReviewSeries.start(repo: root, name: 'live', report: initial(root))
          series = File.dirname(File.dirname(first))
          state = DCR::State.new(series)
          before = DynamicReviews.extract(first)['snapshot']
          hid = before['files'].first['hunks'].first['id']
          old_key = DCR::State.review_key(before['fingerprint'], 'live', 1)
          mine = ->(id, line) { {'id' => id, 'hunk' => hid, 'side' => 'new', 'start' => line, 'end' => line, 'label' => 'note', 'decoration' => 'non-blocking', 'subject' => id} }
          state.save_blob(old_key, {'personalComments' => [mine.call('mine-kept', 2), mine.call('mine-gone', 3)], 'viewedFiles' => ['sample.rb'], 'notes' => {'group-1-step-1' => 'Mine'}})
          state.user_message(old_key, 'mine-kept', 'Why this name?')
          state.await_opinions(old_key, 'value-note', 'codex')
          state.add_opinion(old_key, 'value-note', 'codex', 'It should be three.', verdict: 'disagree', adversary: true)
          assert(ReviewSeries.sync(repo: root, name: 'live')['status'] == 'unchanged', 'Unchanged code was saved as an update')
          assert(ReviewSeries.stale(repo: root, name: 'live') == {'changed' => 0}, 'Unchanged code was reported as moved')
          File.write(File.join(root, 'sample.rb'), "# frozen_string_literal: true\nclass Sample\n  def value\n    3\n  end\nend\n")
          File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
          assert(ReviewSeries.stale(repo: root, name: 'live') == {'changed' => 2}, 'Moved code was not noticed')
          result = ReviewSeries.sync(repo: root, name: 'live')
          assert(result.values_at('status', 'revision') == ['updated', 2] && result['outdated'] == ['value-note'], 'The update did not save the next revision')
          assert(result['unreviewed'].map { |range| range['path'] } == ['extra.rb', 'sample.rb'], 'The changed ranges were not handed over')
          saved = DynamicReviews.extract(File.join(series, 'current.html'))
          review = saved['review']
          # What this revision changed since the one before, as its own diff: the value went from 2 to 3
          # there, although the whole change still shows it going from 1 to 3.
          since = review['history']['since']
          lines = ->(path) { since['files'].find { |file| file['path'] == path }['hunks'].flat_map { |hunk| hunk['rows']['unified'] }.reject { |row| row['kind'] == 'context' }.map { |row| [row['kind'], row['text']] } }
          assert(since['revision'] == 1 && since['files'].map { |file| file.values_at('path', 'state') } == [%w[extra.rb joined], %w[sample.rb changed]], 'The revision does not say which files it changed since the previous one')
          assert(lines.call('sample.rb') == [['add', '# frozen_string_literal: true'], ['del', '    2'], ['add', '    3']] && lines.call('extra.rb') == [['add', 'EXTRA = 1']], "The diff since the previous revision is not between the two captured files: #{lines.call('sample.rb')}")
          note = review['comments'].find { |comment| comment['id'] == 'value-note' }
          assert(note['general'] && !note.key?('hunk') && note['outdated'] == {'side' => 'new', 'start' => 3, 'end' => 3, 'path' => 'sample.rb', 'lines' => ['    2'], 'revision' => 1}, 'A comment on a changed line was not kept as outdated')
          assert(review['unreviewed'] == %w[f2h1 f1h1] && review['groups'].last['id'] == 'updates', 'New code was not placed unexplained')
          assert(review['findings'].empty? && review['history']['finding_states'].first['status'] == 'needs-rechecking', 'A finding on changed code stayed open unchecked')
          new_key = DCR::State.review_key(saved['snapshot']['fingerprint'], 'live', 2)
          blob = state.read['blobs'][new_key]
          kept, gone = blob['personalComments']
          assert(kept.values_at('hunk', 'start', 'end') == ['f2h1', 3, 3], 'A comment on a line that only moved did not follow it')
          assert(gone['general'] && gone.dig('outdated', 'lines') == ['    2'], 'The reader\'s comment on a changed line was lost')
          assert(blob['viewedFiles'].empty? && blob['notes'] == {'group-1-step-1' => 'Mine'}, 'Progress did not come along as it should')
          assert(state.read.dig('threads', new_key, 'mine-kept', 'messages', 0, 'body') == 'Why this name?', 'The conversation did not come along')
          assert(ReviewSeries.sync(repo: root, name: 'live')['status'] == 'unchanged' && ReviewSeries.manifest(series)['revisions'].length == 2, 'A second update invented a revision')
          # What became of each comment the update outdated is the agent's to say. It is handed the
          # comment, the code it was written on, what changed since and what other agents said of it.
          lost = result['outdated_comments']
          assert(lost.map { |comment| comment.values_at('id', 'reader') } == [['value-note', nil], ['mine-gone', true]] && lost.all? { |comment| comment['patch'].include?("-    2\n+    3") }, 'The outdated comments were not handed over with what changed under them')
          brief = ReviewSeries.sync_brief(result)
          assert(brief.include?('OUTDATED COMMENT value-note (by ') && brief.include?('OUTDATED COMMENT mine-gone (written by the reviewer)') && brief.include?("revision 1):\n    2") && brief.include?('What changed in sample.rb since revision 1:'), "The agent is not told what each outdated comment was about:\n#{brief}")
          assert(brief.include?('- Codex (second reviewer, disagree): It should be three.') && brief.scan('What other agents said of it').length == 1, 'What the adversaries said of an outdated comment was not passed on')
          outcome = ->(id, word) { DCR::LiveCLI.reply(state, {dir: series, outcome: word, second_opinion: false, agent: 'claude'}, [id, 'The value is three now.'], nil) }
          outcome.call('value-note', 'addressed')
          said = state.read.dig('threads', new_key, 'value-note')
          assert(said['outcome'].values_at('verdict', 'revision', 'agent') == ['addressed', 2, 'claude'] && said['messages'].last.values_at('outcome', 'body') == ['addressed', 'The value is three now.'], 'The outcome was not kept on the comment\'s thread')
          assert(!state.read.dig('blobs', new_key, 'resolvedComments').to_a.include?('value-note'), 'An outcome resolved a comment; only the reviewer does')
          outcome.call('mine-gone', 'not-relevant')
          assert(state.read.dig('threads', new_key, 'mine-gone', 'outcome', 'verdict') == 'not-relevant', 'The agent could not say what became of the reader\'s own comment')
          rejects('An outcome on a comment the review does not have') { outcome.call('nobody', 'addressed') }
          rejects('An outcome outside the three') { outcome.call('value-note', 'fixed') }
          # The agent comments on what came in; the next full review still has to explain it. A
          # comment that takes up an outdated one says which.
          rejects('A follow-up of an unknown comment was posted') do
            File.write(File.join(out, 'comment.json'), JSON.generate(mine.call('lost-note', 1).merge('hunk' => 'f1h1', 'follows' => 'nobody')))
            DCR::LiveCLI.comment(state, {file: File.join(out, 'comment.json'), second_opinion: false}, series)
          end
          File.write(File.join(out, 'comment.json'), JSON.generate(mine.call('extra-note', 1).merge('hunk' => 'f1h1', 'follows' => 'value-note')))
          DCR::LiveCLI.comment(state, {file: File.join(out, 'comment.json'), second_opinion: false}, series)
          assert(state.read.dig('comments', new_key).last.values_at('id', 'follows') == %w[extra-note value-note], 'A follow-up lost the comment it takes up')
          prepared = ReviewSeries.prepare(repo: root, name: 'live', out: out)
          assert(prepared['status'] == 'changed' && prepared['ranges_to_inspect'].map { |range| range['hunk'] }.sort == %w[f1h1 f2h1], 'Unreviewed ranges were not left to inspect')
          assert(ReviewSeries.read(File.join(out, 'draft.json'))['comments'].map { |comment| comment['id'] } == ['extra-note'], 'A comment posted after the update was not kept')
          # Fix this: the one request that changes code, one at a time, so the revision a fix ends
          # in holds that fix and nothing else. For the same reason a review behind its code is
          # updated first, unasked: what was already different gets a revision of its own.
          require_relative '../lib/dcr/live_api'
          api = DCR::LiveAPI.new(series)
          fix = ->(id, extra = {}) { api.call('POST', '/api/fix', -> { JSON.generate({key: new_key, id: id, text: 'Use a named constant.'}.merge(extra)) }) }
          File.write(File.join(root, 'other.rb'), "OTHER = 1\n")
          behind = fix.call('extra-note')
          assert(behind[0] == 200 && behind[1].values_at('revision', 'followed') == [3, false] && ReviewSeries.stale(repo: root, name: 'live') == {'changed' => 0}, "A fix on a review behind its code did not update it first: #{behind}")
          new_key = DCR::State.review_key(DynamicReviews.extract(File.join(series, 'current.html'))['snapshot']['fingerprint'], 'live', 3)
          assert(state.read.dig('threads', new_key, 'extra-note').values_at('delivery', 'live') == ['sent', true], 'Fix this did not reach the agent on the revision the update saved')
          asked = DCR::LiveCLI.render(state.pending.last(1), '--repo r --name s')
          assert(asked.start_with?('FIX REQUEST.') && asked.include?('Use a named constant.') && asked.include?('dcr sync --repo r --name s') && asked.include?("--outcome addressed extra-note") && !asked.include?('REPLY ONLY') && asked.include?('No commits'), "dcr wait must hand over a fix as a task that changes code:\n#{asked}")
          busy = fix.call('value-note')
          assert(busy[0] == 400 && busy[1]['error'].include?('One fix at a time'), "A second fix started while one was running: #{busy}")
          outcome.call('extra-note', 'addressed')
          assert(state.read.dig('threads', new_key, 'extra-note', 'fix', 'state') == 'done', 'Saying what was done did not end the fix')
          # What is asked depends on the comment: a suggestion is applied, and a question is acted
          # on with the reader's answer, which joins the conversation.
          assert(fix.call('value-note', ask: 'answer')[0] == 400 && fix.call('value-note', ask: 'rewrite')[0] == 400, 'A question was acted on without an answer, or an unknown request was taken')
          assert(fix.call('value-note', ask: 'answer', note: 'Yes, make it three.')[0] == 200, 'Acting on an answered question did not reach the agent')
          acted = DCR::LiveCLI.render(state.pending.last(1), '--repo r --name s')
          assert(acted.include?('What the reviewer asks: act on the comment as their message under it says') && state.read.dig('threads', new_key, 'value-note', 'messages').last.values_at('author', 'body') == ['user', 'Yes, make it three.'], "The answer did not go with the request:\n#{acted}")
          assert(asked.include?('What the reviewer asks: fix what the comment says.'), 'A plain fix does not say what is asked')
          # A fix handed over with a conversation keeps the two apart: only the fix changes code.
          state.send_items(new_key, [{'id' => 'mine-kept', 'text' => 'Why this name?'}])
          both = DCR::LiveCLI.render(state.pending.last(2), '--repo r --name s')
          assert(both.include?('REPLY ONLY') && both.include?('FIX REQUEST.') && both.end_with?('Every other thread is reply only. No commits, no pushes.'), "A fix beside a conversation ends on the wrong reminder:\n#{both.lines.last}")
          # A comment whose own lines the checkout already changed is outdated by that update:
          # there is nothing left to fix as it was written, and the agent says what became of it.
          File.write(File.join(root, 'extra.rb'), "EXTRA = 2\n")
          gone = fix.call('extra-note')
          assert(gone[0] == 200 && gone[1].values_at('revision', 'outdated', 'entry') == [4, true, nil] && state.read['threads'].select { |name, _| name.end_with?(':4') }.values.first.dig('extra-note', 'fix', 'state') == 'done', "A fix was asked for on code that had already changed: #{gone}")
        end
      end
    end
    checks['keeps the agent\'s screenshots: on the open page, in saved revisions, through an update while their files hold'] = lambda do
      require_relative '../lib/dcr/live_cli'
      require_relative '../lib/dcr/evidence'
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-screenshots-') do |out|
          first = ReviewSeries.start(repo: root, name: 'shots', report: initial(root))
          series = File.dirname(File.dirname(first))
          state = DCR::State.new(series)
          png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".unpack1('m')
          File.binwrite(File.join(out, 'screen.png'), png)
          File.write(File.join(out, 'notes.txt'), 'not an image')
          post = lambda do |value|
            File.write(File.join(out, 'shots.json'), JSON.generate(value))
            DCR::LiveCLI.screenshot(state, {file: File.join(out, 'shots.json')}, series)
          end
          shown = {'id' => 'home', 'path' => 'screen.png', 'title' => 'The value on the home page', 'page' => '/', 'paths' => ['sample.rb']}
          post.call([shown, {'id' => 'on-note', 'path' => 'screen.png', 'title' => 'The value, wrong', 'comment_id' => 'value-note'}])
          key = ->(number, saved) { DCR::State.review_key(saved['snapshot']['fingerprint'], 'shots', number) }
          posted = state.read.dig('screenshots', key.call(1, DynamicReviews.extract(first)))
          assert(posted.map { |shot| shot.values_at('id', 'paths', 'comment_id') } == [['home', ['sample.rb'], nil], ['on-note', ['sample.rb'], 'value-note']], 'The screenshots are not on the open review, each with its files')
          # The page gets the records with its state and each image once, on its own.
          require_relative '../lib/dcr/live_api'
          require_relative '../lib/dcr/qa_request'
          api = DCR::LiveAPI.new(series)
          first_key = key.call(1, DynamicReviews.extract(first))
          listed = api.call('GET', "/api/state?key=#{first_key}", nil)[1]['screenshots']
          assert(listed.map { |shot| shot['id'] } == %w[home on-note] && listed.none? { |shot| shot.key?('file') || shot.key?('data_uri') }, 'The page was not told of the screenshots')
          assert(api.call('GET', "/api/screenshot?key=#{first_key}&id=home", nil)[1]['data_uri'].start_with?('data:image/png;base64,'), 'The page cannot fetch a screenshot')
          assert(api.call('GET', "/api/screenshot?key=#{first_key}&id=nope", nil)[0] == 400, 'An unknown screenshot was served')
          # Start QA review hands them over, so a clip can take a screenshot's place.
          DCR::QARequest.call(series_dir: series, state: state, key: first_key, route: '/', origin: 'http://127.0.0.1:1', app: nil, capture_dir: out)
          asked = state.read['outbox'].last['text']
          assert(asked.include?('- home: The value on the home page on / (Seen in the app)') && asked.include?('- on-note: The value, wrong (on comment value-note)'), 'The QA request did not list the screenshots')
          rejects('A screenshot of a file outside the review was posted') { post.call(shown.merge('id' => 'far', 'paths' => ['nope.rb'])) }
          rejects('A screenshot with no files was posted') { post.call(shown.except('paths').merge('id' => 'loose')) }
          rejects('A screenshot on an unknown comment was posted') { post.call(shown.merge('id' => 'lost', 'comment_id' => 'nobody')) }
          rejects('A file that is not an image was posted') { post.call(shown.merge('id' => 'text', 'path' => 'notes.txt')) }
          rejects('More screenshots than UI changes shows were posted') { post.call((1..6).map { |number| shown.merge('id' => "more-#{number}") }) }
          post.call(shown.merge('title' => 'The home page'))
          # A QA clip of what a screenshot shows takes its place; the revision it is saved into keeps both.
          File.binwrite(File.join(out, 'clip.png'), png)
          DCR::Evidence.attach(series_dir: series, capture_dir: out, input: {'path' => File.join(out, 'clip.png'), 'title' => 'The value changes', 'observed' => 'It shows two.', 'result' => 'failed', 'comment_id' => 'value-note'})
          second = DynamicReviews.extract(File.join(series, 'current.html'))
          assert(second['review']['screenshots'].map { |shot| shot['id'] } == %w[on-note home] && second['review']['screenshots'].all? { |shot| shot['data_uri'].start_with?('data:image/png;base64,') && !shot.key?('file') }, 'The revision did not embed the screenshots')
          assert(second['review']['qa']['flows'].first['screenshot_id'] == 'on-note', 'The clip did not take the place of its comment\'s screenshot')
          # An update keeps a screenshot while none of its files changed.
          File.write(File.join(root, 'extra.rb'), "EXTRA = 1\n")
          assert(ReviewSeries.sync(repo: root, name: 'shots')['screenshots_dropped'].empty?, 'An update dropped screenshots of files that did not change')
          assert(DynamicReviews.extract(File.join(series, 'current.html'))['review']['screenshots'].map { |shot| shot['id'] } == %w[on-note home], 'An update lost screenshots of files that did not change')
          File.write(File.join(root, 'sample.rb'), "class Sample\n  def value\n    3\n  end\nend\n")
          result = ReviewSeries.sync(repo: root, name: 'shots')
          assert(result['screenshots_dropped'].map { |shot| shot['id'] } == %w[on-note home] && result['summary'].include?('2 screenshots of changed files were dropped'), 'An update kept screenshots of code that changed')
          assert(!DynamicReviews.extract(File.join(series, 'current.html'))['review'].key?('screenshots') && ReviewSeries.sync_brief(result).include?('- home: The home page (/)'), 'The dropped screenshots were not handed over')
          # A second, different capture of a page it already shows gets a heads-up; the same file again does not.
          File.binwrite(File.join(out, 'other.png'), "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=".unpack1('m'))
          require 'stringio'
          said = lambda do |value|
            original = $stdout
            $stdout = StringIO.new
            post.call(shown.merge('page' => '/x').merge(value))
            $stdout.string
          ensure
            $stdout = original
          end
          said.call('id' => 'p1')
          assert(!said.call('id' => 'p2').include?('Heads up'), 'Reusing an image was warned about')
          assert(said.call('id' => 'p3', 'path' => 'other.png').include?('Heads up: p3 is a second capture of /x, which p1, p2 already show'), 'A retake of a page already shown got no heads-up')
        end
      end
    end
    checks['a review served with the app is not finished without its screenshots or the reason, and the log says what ran'] = lambda do
      require_relative '../lib/dcr/live_cli'
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-served-') do |out|
          File.write(File.join(root, 'sample.rb'), "class Sample\n  def value\n    2\n  end\nend\n")
          snapshot = DynamicReviews.collect(repo: root)
          file = snapshot['files'].first
          outline = {'title' => 'Sample review', 'summary' => 'Return two.', 'groups' => [{'title' => 'Values', 'summary' => 'Values.', 'layers' => [{'title' => 'Return a value', 'items' => [{'file' => file['id'], 'summaries' => {file['hunks'].first['id'] => 'Return two.'}}]}]}]}
          File.write(File.join(out, 'snapshot.json'), JSON.generate(snapshot))
          File.write(File.join(out, 'outline.json'), JSON.generate(outline))
          first = ReviewSeries.start(repo: root, name: 'served', snapshot: File.join(out, 'snapshot.json'), review: File.join(out, 'outline.json'), in_progress: true)
          series = File.dirname(File.dirname(first))
          File.write(File.join(series, '.serve.json'), JSON.generate('port' => 1, 'app_port' => 2))
          finish = -> { ReviewSeries.run(['finish', '--repo', root, '--name', 'served', '--review', File.join(out, 'outline.json')]) }
          rejects('A review served with the app was finished with no screenshot and no reason') { finish.call }
          begin
            DCR::LiveCLI.run('screenshot', ['--dir', series, '--none', ' '])
          rescue SystemExit
            nil
          end
          DCR::LiveCLI.run('screenshot', ['--dir', series, '--none', 'Only a constant changed'])
          finish.call
          assert(DynamicReviews.extract(File.join(series, 'current.html'))['review']['no_screenshots'] == 'Only a constant changed', 'The reason for no screenshots was not kept')
          log = DCR::Activity.entries(series).map { |row| row.values_at('command', 'outcome') }
          assert(log == [['series finish', 'failed'], ['screenshot --none', 'failed'], ['screenshot --none', 'ok'], ['series finish', 'ok']], "The log does not say what ran: #{log.inspect}")
          assert(DCR::Activity.entries(series).first['detail'].include?('shows no screenshot of it') && DCR::Activity.text(series).lines.length == 4, 'The log does not say why a command was refused')
        end
      end
    end
    checks['attaches QA and previews to the revision of their code in one save'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        Dir.mktmpdir('review-enrich-check-') do |out|
          first = ReviewSeries.start(repo: root, name: 'enrich-check', report: initial(root))
          payload = DynamicReviews.extract(first)
          png = Base64.strict_decode64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=')
          File.binwrite(File.join(out, 'state.png'), png)
          qa = {'status' => 'complete', 'fingerprint' => payload['snapshot']['fingerprint'], 'summary' => 'Static state checked.',
                'environment' => 'Synthetic fixture for helper validation.',
                'flows' => [{'title' => 'Inspect state', 'steps' => ['Inspect the state'], 'expected' => 'Readable state',
                             'observed' => 'Readable synthetic state', 'result' => 'passed',
                             'assets' => [{'path' => 'state.png', 'caption' => 'Synthetic state'}]}]}
          preview = {'id' => 'sample', 'files' => [payload['snapshot']['files'].first['path']], 'title' => 'Sample',
                     'source' => 'example', 'status' => 'rendered', 'html' => '<!doctype html><html><body><p>Sample</p></body></html>'}
          input = File.join(out, 'enrich.json')
          File.write(input, JSON.generate({'qa' => qa, 'previews' => [preview], 'validation' => ['Synthetic visual state checked.']}))
          second = ReviewSeries.enrich(repo: root, name: 'enrich-check', revision: 1, update: input)
          after = DynamicReviews.extract(second)
          assert(second == first && after['review']['history'].values_at('revision', 'save') == [1, 1], 'Combined evidence was not one save into its revision')
          assert(after['review']['qa']['flows'][0]['assets'][0]['data_uri'].start_with?('data:image/png;base64,'), 'QA media was not embedded')
          assert(after['review']['previews'] == [preview], 'Template preview was not embedded')
          assert(after['review']['validation'] == ['Synthetic visual state checked.'], 'Enrichment did not update validation')
          assert(after['review']['findings'] == payload['review']['findings'], 'Enrichment changed code conclusions')
          rejects('The same evidence saved twice') { ReviewSeries.enrich(repo: root, name: 'enrich-check', revision: 1, update: input) }
          rejects('Evidence for another revision accepted') { ReviewSeries.enrich(repo: root, name: 'enrich-check', revision: 2, update: input) }
          saved = ReviewSeries.manifest(File.dirname(File.dirname(first)))['revisions']
          assert(saved.length == 1 && saved.last['saves'].length == 1, 'Rejected enrichment was saved')
        end
      end
    end
    checks['adds one requested template preview without requiring a full pass'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        Dir.mkdir(File.join(root, 'app'))
        Dir.mkdir(File.join(root, 'app/views'))
        %w[alpha beta gamma].each { |name| File.write(File.join(root, "app/views/#{name}.html.erb"), "<p>#{name}</p>\n") }
        snapshot = DynamicReviews.collect(repo: root)
        items = snapshot['files'].map { |file| {'file' => file['id'], 'summaries' => file['hunks'].to_h { |hunk| [hunk['id'], 'Show the changed view.'] }} }
        review = {'title' => 'View review', 'summary' => 'Three example views changed.', 'effort' => {'score' => 1, 'reason' => 'Three small templates'},
                  'coverage' => 'All templates reviewed.', 'validation' => ['Synthetic fixture only.'],
                  'groups' => [{'title' => 'Views', 'summary' => 'The two view examples belong together.', 'layers' => [{'title' => 'Render examples', 'items' => items}]}],
                  'comments' => [], 'findings' => []}
        Dir.mktmpdir('review-targeted-preview-') do |out|
          File.write(File.join(out, 'snapshot.json'), JSON.generate(snapshot))
          File.write(File.join(out, 'review.json'), JSON.generate(review))
          first = ReviewSeries.start(repo: root, name: 'targeted-previews', snapshot: File.join(out, 'snapshot.json'), review: File.join(out, 'review.json'))
          entry = lambda do |id|
            {'id' => id, 'files' => ["app/views/#{id}.html.erb"], 'status' => 'rendered', 'source' => 'example', 'title' => id,
             'html' => "<!doctype html><html><body><p>#{id}</p></body></html>"}
          end
          input = File.join(out, 'previews.json')
          File.write(input, JSON.generate('previews' => [entry.call('alpha')]))
          second = ReviewSeries.previews(repo: root, name: 'targeted-previews', revision: 1, update: input, targeted: true)
          partial = DynamicReviews.extract(second)['review']
          assert(partial['preview_scope'] == 'targeted' && partial['previews'].map { |preview| preview['id'] } == ['alpha'], 'Targeted preview did not preserve partial scope')
          assert(File.read(second).include?('Select for preview') && File.read(second).include?('Preview this template') && File.read(second).include?('data-request-preview'), 'Unrendered template lost its request control')
          qa = {'status' => 'complete', 'fingerprint' => snapshot['fingerprint'], 'summary' => 'Selected flow checked.',
                'environment' => 'Synthetic test fixture.', 'flows' => [{'title' => 'Selected flow', 'steps' => ['Open fixture'], 'expected' => 'Visible', 'observed' => 'Visible', 'result' => 'passed', 'assets' => [{'caption' => 'Fixture', 'data_uri' => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='}]}]}
          File.write(input, JSON.generate('previews' => [entry.call('beta')], 'qa' => qa))
          combined = ReviewSeries.enrich(repo: root, name: 'targeted-previews', revision: 1, update: input, targeted: true)
          enriched = DynamicReviews.extract(combined)['review']
          assert(enriched['previews'].map { |p| p['id'] } == %w[alpha beta], 'Combined targeted update lost an existing preview')
          assert(enriched['qa']['summary'] == qa['summary'], 'Combined targeted update lost QA')
          assert(enriched['history'].values_at('revision', 'save') == [1, 2], 'Combined targeted batch was not one more save into the revision')
          File.write(input, JSON.generate('previews' => [entry.call('alpha'), entry.call('beta'), entry.call('gamma')]))
          third = ReviewSeries.previews(repo: root, name: 'targeted-previews', revision: 1, update: input)
          full = DynamicReviews.extract(third)['review']
          assert(!full.key?('preview_scope') && full['previews'].length == 3, 'Full pass did not replace the targeted set')
          assert(third == first && ReviewSeries.manifest(File.dirname(File.dirname(first)))['revisions'].length == 1, 'Previews of the same code became revisions')
        end
      end
    end
    checks['a presentation refresh keeps the captured code and evidence, and saves nothing'] = lambda do
      ReviewChecks.fixture do |root, _commit|
        first = ReviewSeries.start(repo: root, name: 'presentation', report: initial(root))
        before = File.binread(first)
        original = DynamicReviews.extract(first)
        # A refresh must not silently collect newer working code.
        File.write(File.join(root, 'sample.rb'), "unreviewed local change\n")
        current = ReviewSeries.refresh(repo: root, name: 'presentation')
        after = DynamicReviews.extract(current)
        assert(after['snapshot'] == original['snapshot'], 'Presentation refresh recollected code')
        assert(after['review'].reject { |k, _| k == 'history' } == original['review'].reject { |k, _| k == 'history' }, 'Presentation refresh changed analysis or evidence')
        assert(File.binread(first) == before, 'Presentation refresh rewrote the saved revision')
        saved = ReviewSeries.manifest(File.dirname(current))['revisions']
        assert(saved.length == 1 && !saved.last.key?('saves'), 'Presentation refresh was recorded as a revision or a save')
      end
    end
    checks.each { |description, check| check.call; puts "PASS #{description}" }
    puts "#{checks.length} series checks passed"
  end
end

SeriesChecks.run if $PROGRAM_NAME == __FILE__
