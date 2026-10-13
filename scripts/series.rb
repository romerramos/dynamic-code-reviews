#!/usr/bin/env ruby
# frozen_string_literal: true

# Incremental review storage and reuse. Ruby standard library + Git only.
require_relative 'review'
require_relative '../lib/dcr/state'
require_relative '../lib/dcr/anchors'
require_relative '../lib/dcr/activity'
require 'securerandom'

module ReviewSeries
  module_function

  def copy(value)
    Marshal.load(Marshal.dump(value))
  end

  def read(path)
    JSON.parse(File.read(path))
  end

  def digest(value)
    Digest::SHA256.hexdigest(JSON.generate(value))
  end

  def branch(repo)
    DynamicReviews.git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD', allowed: [0, 1]).strip
  end

  def directory(repo, name, create: false)
    raise ArgumentError, 'Use a short lowercase series slug' unless name.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
    root = DynamicReviews.git(repo, 'rev-parse', '--show-toplevel').strip
    raise ArgumentError, '.reviews contains tracked files' unless DynamicReviews.git(root, 'ls-files', '--', '.reviews').empty?
    path = root
    ['.reviews', name, 'revisions'].each do |part|
      path = File.join(path, part)
      raise ArgumentError, "Unsafe review directory: #{path}" if File.symlink?(path) || (File.exist?(path) && !File.directory?(path))
      Dir.mkdir(path) if create && !Dir.exist?(path)
    end
    if create && DynamicReviews.git(root, 'check-ignore', '--', '.reviews/probe.html', allowed: [0, 1]).empty?
      exclude = File.expand_path(DynamicReviews.git(root, 'rev-parse', '--git-path', 'info/exclude').strip, root)
      FileUtils.mkdir_p(File.dirname(exclude))
      File.open(exclude, 'a') { |file| file.write("\n/.reviews/\n") }
    end
    File.dirname(path)
  end

  def safe_file(path)
    raise ArgumentError, "Refusing symlink: #{path}" if File.symlink?(path)
    path
  end

  def atomic_write(path, text)
    safe_file(path)
    temporary = "#{path}.#{SecureRandom.hex(6)}.tmp"
    begin
      File.open(temporary, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(text) }
      File.rename(temporary, path)
    ensure
      File.unlink(temporary) if File.exist?(temporary)
    end
  end

  def locked(path)
    File.open(safe_file(File.join(path, '.lock')), File::RDWR | File::CREAT, 0o600) do |file|
      file.flock(File::LOCK_EX)
      yield
    end
  end

  def manifest(path)
    data = read(safe_file(File.join(path, 'manifest.json')))
    raise ArgumentError, 'Unsupported review history' unless data['version'] == 1
    data
  end

  def revision_path(path, number)
    raise ArgumentError, 'Invalid revision number' unless number.is_a?(Integer) && number.positive?
    safe_file(File.join(path, 'revisions', format('%03d.html', number)))
  end

  def latest(path, history = manifest(path))
    DynamicReviews.extract(revision_path(path, history.fetch('revisions').last.fetch('number')))
  end

  # Ignore presentation IDs and hunk header line offsets; content must match
  # uniquely on both sides before any explanation or range can be remapped.
  def hunk_key(hunk)
    digest(hunk.fetch('patch').lines.drop(1).join)
  end

  def file_key(file)
    # Omitted changes use their raw digest; visible text uses source ranges.
    return digest(file.values_at('path', 'content_digest', 'note', 'patch')) if file['hunks'].empty?
    digest([file['path'], file_metadata(file), file['hunks'].map { |h| h.values_at('old_start', 'old_count', 'new_start', 'new_count') + [hunk_key(h)] }])
  end

  def file_metadata(file)
    return ["new file mode #{file.fetch('git_mode', '100644')}"] if file['note'] == 'Untracked addition'
    file.fetch('patch', '').lines.grep(/^(?:old mode|new mode|new file mode|deleted file mode) /).map(&:strip)
  end

  def code_key(snapshot)
    digest(snapshot['files'].map { |file| [file['path'], file_key(file)] })
  end

  def context_digest(snapshot, path)
    raise ArgumentError, 'Context paths must be repository-relative' if Pathname.new(path).absolute? || path.split('/').include?('..') || path.start_with?('.reviews/') || path == '.reviews'
    raise ArgumentError, 'Do not record sensitive context' if DynamicReviews.sensitive?(path)
    root = snapshot.fetch('repo')
    if snapshot['working_tree'] || snapshot['mode'] == 'uncommitted'
      target = root
      path.split('/').each do |part|
        target = File.join(target, part)
        raise ArgumentError, "Context symlink: #{path}" if File.symlink?(target)
      end
      return File.file?(target) ? Digest::SHA256.file(target).hexdigest : 'missing'
    end
    object = DynamicReviews.git(root, 'rev-parse', '--verify', '--end-of-options', "#{snapshot.fetch('head')}:#{path}", allowed: [0, 128]).strip
    return 'missing' if object.empty?
    Digest::SHA256.hexdigest(DynamicReviews.git(root, 'cat-file', 'blob', object))
  end

  def contexts(snapshot, paths)
    paths.uniq.sort.to_h { |path| [path, context_digest(snapshot, path)] }
  end

  def normalize(review)
    review = copy(review)
    review['groups'].each_with_index do |group, gi|
      group['id'] ||= "group-#{gi + 1}"
      group['layers'].each_with_index { |layer, li| layer['id'] ||= "#{group['id']}-step-#{li + 1}" }
    end
    Array(review['findings']).each_with_index { |finding, i| finding['id'] ||= "F#{i + 1}" }
    review
  end

  def compare(old, current, context_changed: false)
    old_files = old['files'].to_h { |f| [f['path'], f] }
    new_files = current['files'].to_h { |f| [f['path'], f] }
    mapping, files, required = {}, [], []
    new_files.each do |path, file|
      previous = old_files[path]
      state = previous.nil? ? 'added' : file_key(previous) == file_key(file) ? 'unchanged' : 'modified'
      state = 'needs-check' if file['hunks'].empty? && !file['content_digest'] && !file['note'].to_s.empty?
      old_groups = Array(previous && previous['hunks']).group_by { |h| hunk_key(h) }
      new_groups = file['hunks'].group_by { |h| hunk_key(h) }
      file['hunks'].each do |hunk|
        candidates = old_groups[hunk_key(hunk)] || []
        if !context_changed && candidates.length == 1 && new_groups[hunk_key(hunk)].length == 1
          prior = candidates.first
          mapping[prior['id']] = {'file' => file['id'], 'hunk' => hunk['id'], 'old_offset' => hunk['old_start'] - prior['old_start'], 'new_offset' => hunk['new_start'] - prior['new_start']}
        else
          required << {'file' => file['id'], 'path' => path, 'hunk' => hunk['id'], 'patch' => hunk['patch']}
        end
      end
      files << {'path' => path, 'file' => file['id'], 'previous_file' => previous && previous['id'], 'state' => state,
                'metadata_before' => previous ? file_metadata(previous) : [], 'metadata_after' => file_metadata(file),
                'metadata_recheck' => file['hunks'].empty? && (state != 'unchanged' || context_changed)}
    end
    (old_files.keys - new_files.keys).each { |path| files << {'path' => path, 'state' => 'removed'} }
    {'files' => files, 'mapping' => mapping, 'required_hunks' => required,
     'removed_hunks' => old['files'].flat_map { |f| f['hunks'].reject { |h| mapping.key?(h['id']) }.map { |h| {'path' => f['path'], 'hunk' => h['id'], 'patch' => h['patch']} }}}
  end

  # unexplained: keep the items whose ranges have no carried explanation (an update shows them as
  # they are); a draft for the agent drops them, so each must be explained again.
  def draft_review(previous, current, changes, unexplained: false)
    review = normalize(previous)
    mapping = changes['mapping']
    lookup = changes['files'].select { |f| f['previous_file'] && f['file'] }.to_h { |f| [f['previous_file'], f] }
    review['groups'].each do |group|
      group['layers'].each do |layer|
        layer['items'] = layer['items'].filter_map do |item|
          file = lookup[item['file']]
          next unless file
          summaries = item.fetch('summaries', {}).filter_map { |hid, prose| [mapping[hid]['hunk'], prose] if mapping[hid] && (unexplained || !prose.strip.empty?) }.to_h
          unless unexplained
            next if summaries.empty? && current['files'].find { |f| f['id'] == file['file'] }['hunks'].any?
            next if file['metadata_recheck']
          end
          item.merge('file' => file['file'], 'summaries' => summaries)
        end
        if layer.key?('related_tests')
          remaining = layer['items'].map { |item| item['file'] }
          layer['related_tests'] = layer['related_tests'].filter_map do |panel|
            refs = %w[entities files].to_h { |key| [key, panel[key].filter_map { |fid| lookup.dig(fid, 'file') }.select { |fid| remaining.include?(fid) }] }
            panel.merge(refs) if refs.values.all?(&:any?)
          end
          # Changed test ranges need newly authored summaries and associations.
          layer.delete('related_tests') if layer['related_tests'].empty?
        end
      end
    end
    review['comments'] = Array(review['comments']).filter_map do |comment|
      match = mapping[comment['hunk']]
      next unless match
      offset = match.fetch("#{comment['side']}_offset")
      comment.merge('hunk' => match['hunk'], 'start' => comment['start'] + offset, 'end' => comment['end'] + offset)
    end
    # Tests and issue/quality conclusions are time-sensitive, unlike explanations.
    review['findings'] = []
    review['validation'] = []
    review['sections'] = []
    review['coverage'] = ''
    review.delete('risk_ranking') # a judgement of this change's risk, made again for each increment
    review.delete('history')
    review.delete('qa') # Captures prove a particular runtime/snapshot, never an automatic increment.
    review.delete('previews') # Rendered from one snapshot's templates; re-render after code changes.
    review.delete('preview_scope')
    review.delete('no_screenshots')
    review.delete('screenshots') # of the app as that code drew it; an update keeps those whose files did not change
    review.delete('unreviewed')
    review
  end

  def prepare(repo:, name:, out:, head: nil, base: nil, working_tree: false, **_unused)
    path = directory(repo, name)
    history = manifest(path)
    raise ArgumentError, 'Series belongs to another checkout' unless history['repo'] == File.realpath(repo)
    raise ArgumentError, 'Branch changed; choose the correct series or start a new one' unless history['branch'] == branch(repo)
    previous = latest(path, history)
    raise ArgumentError, 'The latest revision is still in progress; finish it with `dcr series finish` first' if previous.dig('review', 'status') == 'in_progress'
    previous['review']['comments'] = with_posted(path, history, previous['review'])
    current = current_snapshot(repo, history, previous, head: head, base: base, working_tree: working_tree)
    old_context = previous['review'].fetch('context', {})
    current_context = contexts(current, old_context.keys)
    changed_context = old_context.keys.select { |key| old_context[key] != current_context[key] }
    changes = compare(previous['snapshot'], current, context_changed: changed_context.any?)
    # Ranges an update brought in were never explained: they are the agent's to inspect, like changed ones.
    pending = Array(previous['review']['unreviewed']).filter_map { |id| changes['mapping'][id] }
    paths = current['files'].to_h { |file| [file['id'], file['path']] }
    ranges = DynamicReviews.hunk_index(current)
    changes['required_hunks'].concat(pending.map { |match| match.slice('file', 'hunk').merge('path' => paths[match['file']], 'patch' => ranges.dig(match['hunk'], 1, 'patch')) })
    status = code_key(previous['snapshot']) == code_key(current) && changed_context.empty? && pending.empty? ? 'unchanged' : 'changed'
    status = 'changed' if changes['files'].any? { |file| file['state'] == 'needs-check' }
    plan = {'version' => 1, 'repo' => current['repo'], 'series' => name, 'revision' => history['revisions'].last['number'],
            'status' => status, 'snapshot_key' => code_key(current), 'context' => current_context, 'changed_context' => changed_context,
            'context_note' => old_context.empty? ? 'No dependency fingerprints recorded; inspect affected callers before trusting reuse.' : 'Tracked context compared; unrecorded dependencies still require judgment.',
            'changes' => changes, 'previous_findings' => previous['review'].fetch('findings', []),
            'previous_finding_states' => previous['review'].dig('history', 'finding_states') || [],
            'comments_to_recheck' => Array(previous['review']['comments']).reject { |c| changes['mapping'].key?(c['hunk']) }}
    raise ArgumentError, 'Prepare output must be outside the repository' if File.expand_path(out).start_with?("#{current['repo']}/")
    FileUtils.mkdir_p(out)
    {'snapshot' => current, 'plan' => plan, 'draft' => draft_review(previous['review'], current, changes)}.each do |label, value|
      atomic_write(File.join(out, "#{label}.json"), JSON.pretty_generate(value))
    end
    { 'status' => status, 'previous_revision' => plan['revision'], 'files' => changes['files'],
      'ranges_to_inspect' => changes['required_hunks'].map { |h| h.slice('file', 'path', 'hunk') }, 'reusable_ranges' => changes['mapping'].length - pending.length,
      'changed_context' => changed_context, 'pending_findings' => plan['previous_findings'].map { |f| f['id'] }, 'prepared' => File.expand_path(out) }
  end

  # The series' code as it is now. Refused when the checkout no longer continues the previous revision.
  # checkout: a pull request's series read from the checkout as it is, which its reviewer chose
  # (Follow my checkout), instead of from a verified head.
  def current_snapshot(repo, history, previous, head: nil, base: nil, working_tree: false, checkout: false)
    if history['origin_mode'] == 'pr' && !checkout
      raise ArgumentError, 'PR series requires explicitly verified --base and --head refs' unless base && head
      current_base = DynamicReviews.git(repo, 'merge-base', DynamicReviews.sha(repo, base), DynamicReviews.sha(repo, head)).strip
      raise ArgumentError, 'PR base changed; start a new baseline series' unless current_base == history['base']
    end
    if working_tree && head && DynamicReviews.sha(repo, 'HEAD') != DynamicReviews.sha(repo, head)
      raise ArgumentError, 'Working-tree PR review requires the checkout HEAD to match the verified PR head'
    end
    current = DynamicReviews.collect(repo: repo, mode: 'series', base: history.fetch('base'), head: working_tree ? nil : head)
    common = DynamicReviews.git(repo, 'merge-base', previous['snapshot']['head'], current['head'], allowed: [0, 1]).strip
    if history['origin_mode'] == 'pr'
      # An amended or force-pushed PR keeps the verified base, and the comparison is by content against it.
      # Only a head moved back to an ancestor of the previous revision is refused.
      # A verified head is compared with the last one verified, not with local commits a followed
      # checkout showed in between.
      last = checkout ? previous['snapshot']['head'] : history['pinned_head'] || previous['snapshot']['head']
      back = DynamicReviews.git(repo, 'merge-base', last, current['head'], allowed: [0, 1]).strip
      if back == current['head'] && back != last
        raise ArgumentError, checkout ? 'This checkout is behind the code the review shows: pull the branch first, or ask your agent for a new review' : 'PR head moved back to an ancestor of the previous revision; start a new baseline series'
      end
    else
      raise ArgumentError, 'History was rewritten; start a new baseline series and reassess the full scope' unless common == previous['snapshot']['head']
    end
    current
  end

  def apply_update(draft, update)
    review = copy(draft)
    allowed = %w[title headline summary effort coverage validation sections flow file_categories qa comparison risk_ranking]
    update.fetch('review', {}).each do |key, value|
      raise ArgumentError, "Unsupported review update: #{key}" unless allowed.include?(key)
      review[key] = value
    end
    review['groups'].reject! { |g| Array(update['remove_groups']).include?(g['id']) }
    Array(update['groups']).each do |group|
      index = review['groups'].index { |g| g['id'] == group.fetch('id') }
      index ? review['groups'][index] = group : review['groups'] << group
    end
    Array(update['items']).each do |item|
      group = review['groups'].find { |g| g['id'] == item.fetch('group') }
      layer = group && group['layers'].find { |l| l['id'] == item.fetch('layer') }
      raise ArgumentError, 'Item needs an existing group and layer ID' unless layer
      value = item.reject { |key, _| %w[group layer].include?(key) }
      existing = layer['items'].find { |i| i['file'] == item.fetch('file') }
      if existing
        existing['summaries'] = existing.fetch('summaries', {}).merge(value.fetch('summaries', {}))
        existing['summary'] = value['summary'] if value.key?('summary')
      else
        layer['items'] << value
      end
    end
    review['comments'].reject! { |c| Array(update['remove_comments']).include?(c['id']) }
    Array(update['comments']).each do |comment|
      review['comments'].reject! { |c| c['id'] == comment.fetch('id') }
      review['comments'] << comment
    end
    review['groups'].each { |g| g['layers'].reject! { |l| l['items'].empty? } }
    review['groups'].reject! { |g| g['layers'].empty? }
    if update.key?('group_order')
      order = update['group_order']
      unless order.is_a?(Array) && order.uniq == order && order.sort == review['groups'].map { |group| group['id'] }.sort
        raise ArgumentError, 'Group order must list every current group ID exactly once'
      end
      review['groups'].sort_by! { |group| order.index(group['id']) }
    end
    ids = review['groups'].flat_map { |g| [g.fetch('id')] + g['layers'].map { |l| l.fetch('id') } }
    raise ArgumentError, 'Group/layer IDs must be unique' unless ids.uniq == ids
    review
  end

  def finding_states(plan, update)
    previous = plan.fetch('previous_findings')
    decisions = update.fetch('finding_updates', [])
    raise ArgumentError, 'Duplicate finding decisions' unless decisions.map { |d| d['id'] }.uniq.length == decisions.length
    previous.each do |finding|
      raise ArgumentError, "Reassess previous finding #{finding['id']} explicitly" unless decisions.any? { |d| d['id'] == finding['id'] }
    end
    states, findings = [], []
    old_states = plan.fetch('previous_finding_states', [])
    decisions.each do |decision|
      id, status = decision.values_at('id', 'status')
      raise ArgumentError, 'Finding ID must be URL-safe' unless id.is_a?(String) && id.match?(/\A[a-zA-Z0-9-]+\z/)
      raise ArgumentError, 'Use open, resolved or needs-rechecking' unless %w[open resolved needs-rechecking].include?(status)
      raise ArgumentError, 'Finding decision requires evidence/reason' if decision.fetch('reason').strip.empty?
      old = previous.find { |f| f['id'] == id }
      known = old || old_states.find { |f| f['id'] == id }
      raise ArgumentError, 'Cannot resolve an unknown finding' if status == 'resolved' && !known
      if status == 'open'
        finding = decision.fetch('finding').merge('id' => id)
        findings << finding
        title = finding.fetch('title')
      else
        title = old && old['title'] || decision['title'] || known && known['title']
        raise ArgumentError, 'Finding needs a title' unless title
      end
      states << {'id' => id, 'status' => status, 'change' => known ? (status == 'open' ? 'still open' : status) : 'new', 'title' => title, 'reason' => decision['reason']}
    end
    # Unresolved unanchored concerns remain visible until explicitly reassessed.
    old_states.each { |entry| states << entry if !states.any? { |s| s['id'] == entry['id'] } }
    [findings, states]
  end

  # What a revision changed since the one before it: the diff between the files as the two
  # revisions captured them, never between their two diffs. A line put back as the base has it is
  # gone from the whole change, and is a change here. A file in one revision only was as its base
  # has it in the other. Returns {'revision' => the earlier number, 'files' => [...]}, each file
  # with the ranges of that diff, or a note when its text was not captured.
  def since(previous, current, number)
    was, now = [previous, current].map { |snapshot| snapshot['files'].to_h { |file| [file['path'], file] } }
    files = (was.keys | now.keys).sort.filter_map do |path|
      old, new = was[path], now[path]
      next if old && new && file_key(old) == file_key(new)
      before = old ? old.dig('source', 'new') : new.dig('source', 'old')
      after = new ? new.dig('source', 'new') : old.dig('source', 'old')
      state = !old ? 'joined' : !new ? 'left' : 'changed'
      next({'path' => path, 'state' => state, 'note' => 'Changed, but its text was not captured in both revisions.', 'hunks' => []}) unless before && after
      next if before == after && state == 'changed'
      {'path' => path, 'state' => state, 'patch' => text_diff(before, after)}
    end
    files.each_with_index do |file, index|
      file['id'] = "d#{index + 1}"
      file['hunks'] = DynamicReviews.hunks(file['patch'], file['id']) if file['patch']
    end
    {'revision' => number, 'files' => files}
  end

  # A unified diff of two texts, from its first range on.
  def text_diff(before, after)
    Dir.mktmpdir('dcr-since-') do |dir|
      File.write(File.join(dir, 'a'), before)
      File.write(File.join(dir, 'b'), after)
      patch = DynamicReviews.text(DynamicReviews.git(dir, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', 'a', 'b', allowed: [0, 1]))
      patch[/^@@ .*/m].to_s
    end
  end

  def publish(prepared:, update:, record: false, **_unused)
    plan = read(File.join(prepared, 'plan.json'))
    snapshot = read(File.join(prepared, 'snapshot.json'))
    draft = read(File.join(prepared, 'draft.json'))
    update = read(update) if update.is_a?(String)
    raise ArgumentError, 'No code/context changes; the revision stands, or use --record to save an intentional reassessment into it' if plan['status'] == 'unchanged' && !record
    raise ArgumentError, 'Explain this increment in since_previous' if update.fetch('since_previous', '').strip.empty?
    raise ArgumentError, 'Provide current coverage and validation (previous results are historical)' if update.dig('review', 'coverage').to_s.strip.empty? || !update.dig('review', 'validation').is_a?(Array) || update['review']['validation'].empty?
    path = directory(plan.fetch('repo'), plan.fetch('series'))
    locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Another revision was published; prepare again' unless history['revisions'].last['number'] == plan['revision']
      raise ArgumentError, 'Branch changed since preparation' unless history['branch'] == branch(plan['repo'])
      fresh = DynamicReviews.collect(repo: plan['repo'], mode: 'series', base: history['base'], head: snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code moved since preparation; prepare again' unless code_key(fresh) == plan['snapshot_key'] && code_key(snapshot) == plan['snapshot_key'] && fresh['head'] == snapshot['head']
      raise ArgumentError, 'Context moved since preparation; prepare again' unless contexts(fresh, plan['context'].keys) == plan['context']
      # A review of the verified head again ends following the checkout.
      %w[follows pinned_head].each { |field| history.delete(field) } if history['origin_mode'] == 'pr' && !snapshot['working_tree']
      review = apply_update(draft, update)
      review['findings'], states = finding_states(plan, update)
      paths = (plan['context'].keys + Array(update['context_paths'])).uniq
      review['context'] = contexts(snapshot, paths)
      # The same code reviewed again stays one revision, with the evidence it already has.
      previous = latest(path, history)
      same = code_key(previous['snapshot']) == plan['snapshot_key']
      if same
        %w[qa previews preview_scope no_screenshots].each { |field| review[field] = previous['review'][field] if previous['review'].key?(field) && !review.key?(field) }
        shots = with_screenshots(path, history, previous['review'])
        review['screenshots'] = shots if shots.any? && !review.key?('screenshots')
      end
      DynamicReviews.validate(snapshot, review)
      changes = plan['changes']['files']
      group_states = review['groups'].to_h do |group|
        reused = group['layers'].flat_map { |l| l['items'] }.all? do |item|
          file = changes.find { |f| f['file'] == item['file'] }
          file && file['state'] == 'unchanged' && plan['changed_context'].empty?
        end
        explicitly_updated = Array(update['groups']).any? { |g| g['id'] == group['id'] } || Array(update['items']).any? { |i| i['group'] == group['id'] }
        [group['id'], reused && !explicitly_updated ? 'reused' : 'updated']
      end
      increment = {'summary' => update['since_previous'], 'files' => changes,
                   'reused_ranges' => plan['changes']['mapping'].length, 'inspected_ranges' => plan['changes']['required_hunks'].length,
                   'changed_context' => plan['changed_context'], 'groups' => group_states, 'finding_states' => states}
      next append(path, history, snapshot, review, increment.merge('since' => since(previous['snapshot'], snapshot, plan['revision']))) unless same
      # Its files are still what the revision changed, not this comparison of the code with itself.
      amend(path, history, snapshot, review, update['since_previous'], increment.except('files'), was: previous['review']['history'])
    end
  end

  # Attach evidence to the exact reviewed snapshot, in its revision, without rewriting the analysis.
  def qa(repo:, name:, update:, revision:, **_unused)
    update_path = File.expand_path(update)
    evidence = ReviewQA.pack(read(update_path), directory: File.dirname(update_path))
    path = directory(repo, name)
    locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Another revision was published; inspect it before attaching QA' unless history['revisions'].last['number'] == Integer(revision)
      raise ArgumentError, 'Branch changed; use the original review checkout' unless history['branch'] == branch(repo)
      payload = latest(path, history)
      snapshot, review = payload.values_at('snapshot', 'review')
      keep_posted(path, history, review)
      ReviewQA.validate(evidence, snapshot, review)
      fresh = DynamicReviews.collect(repo: repo, mode: 'series', base: snapshot['base'], head: snapshot['mode'] == 'uncommitted' || snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code changed; review the new snapshot before attaching QA' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
      recorded_context = review.fetch('context', {})
      raise ArgumentError, 'Context changed; reassess before attaching QA' unless contexts(fresh, recorded_context.keys) == recorded_context
      raise ArgumentError, 'QA evidence is unchanged' if review['qa'] == evidence
      review['qa'] = evidence
      amend(path, history, snapshot, review, "QA evidence updated: #{evidence['summary']}", was: review['history'])
    end
  end

  # Attach template previews rendered by the app for the exact reviewed snapshot.
  def previews(repo:, name:, update:, revision:, targeted: false, **_unused)
    rendered = read(File.expand_path(update)).fetch('previews')
    path = directory(repo, name)
    locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Another revision was published; inspect it before attaching previews' unless history['revisions'].last['number'] == Integer(revision)
      raise ArgumentError, 'Branch changed; use the original review checkout' unless history['branch'] == branch(repo)
      payload = latest(path, history)
      snapshot, review = payload.values_at('snapshot', 'review')
      keep_posted(path, history, review)
      ReviewPreviews.validate(rendered, snapshot, full: !targeted)
      fresh = DynamicReviews.collect(repo: repo, mode: 'series', base: snapshot['base'], head: snapshot['mode'] == 'uncommitted' || snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code changed; review the new snapshot before attaching previews' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
      if targeted
        raise ArgumentError, 'Targeted preview needs at least one example' if rendered.empty?
        existing = Array(review['previews']).reject { |item| rendered.any? { |entry| entry['id'] == item['id'] } }
        rendered = existing + rendered
        ReviewPreviews.validate(rendered, snapshot, full: review['preview_scope'] != 'targeted' && !review['previews'].nil?)
        review['preview_scope'] = 'targeted' unless review['preview_scope'].nil? && !review['previews'].nil?
      else
        review.delete('preview_scope')
      end
      raise ArgumentError, 'Previews are unchanged' if review['previews'] == rendered
      review['previews'] = rendered
      shown = rendered.count { |preview| preview['status'] == 'rendered' }
      amend(path, history, snapshot, review, "Template previews updated: #{shown} rendered of #{rendered.count { |preview| preview['status'] != 'not_visual' }} visual templates.", was: review['history'])
    end
  end

  # Attach finished QA and either selected or all template previews in one save.
  def enrich(repo:, name:, update:, revision:, targeted: false, **_unused)
    update_path = File.expand_path(update)
    input = read(update_path)
    raise ArgumentError, 'Enrichment needs QA and template previews' unless input['qa'].is_a?(Hash) && input['previews'].is_a?(Array)
    if input.key?('validation')
      raise ArgumentError, 'Validation update must be a nonempty list of statements' unless input['validation'].is_a?(Array) && input['validation'].any? && input['validation'].all? { |item| item.is_a?(String) && !item.strip.empty? }
    end
    evidence = ReviewQA.pack(input.fetch('qa'), directory: File.dirname(update_path))
    rendered = input.fetch('previews')
    path = directory(repo, name)
    locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Another revision was published; inspect it before attaching visual evidence' unless history['revisions'].last['number'] == Integer(revision)
      raise ArgumentError, 'Branch changed; use the original review checkout' unless history['branch'] == branch(repo)
      payload = latest(path, history)
      snapshot, review = payload.values_at('snapshot', 'review')
      keep_posted(path, history, review)
      ReviewQA.validate(evidence, snapshot, review)
      ReviewPreviews.validate(rendered, snapshot, full: !targeted)
      if targeted
        raise ArgumentError, 'Targeted preview needs at least one example' if rendered.empty?
        existing = Array(review['previews']).reject { |item| rendered.any? { |entry| entry['id'] == item['id'] } }
        rendered = existing + rendered
        ReviewPreviews.validate(rendered, snapshot, full: review['preview_scope'] != 'targeted' && !review['previews'].nil?)
        review['preview_scope'] = 'targeted' unless review['preview_scope'].nil? && !review['previews'].nil?
      else
        review.delete('preview_scope')
      end
      fresh = DynamicReviews.collect(repo: repo, mode: 'series', base: snapshot['base'], head: snapshot['mode'] == 'uncommitted' || snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code changed; review the new snapshot before attaching visual evidence' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
      recorded_context = review.fetch('context', {})
      raise ArgumentError, 'Context changed; reassess before attaching visual evidence' unless contexts(fresh, recorded_context.keys) == recorded_context
      raise ArgumentError, 'Visual evidence is unchanged' if review['qa'] == evidence && review['previews'] == rendered
      review['qa'] = evidence
      review['previews'] = rendered
      review['validation'] = input['validation'] if input.key?('validation')
      shown = rendered.count { |preview| preview['status'] == 'rendered' }
      amend(path, history, snapshot, review, "Visual evidence updated: #{evidence['summary']} #{shown} template previews rendered.", was: review['history'])
    end
  end

  def start(repo:, name:, report: nil, snapshot: nil, review: nil, in_progress: false, **_unused)
    raise ArgumentError, 'Provide --report or both --snapshot and --review' unless report || (snapshot && review)
    raise ArgumentError, '--in-progress starts from --snapshot and --review' if in_progress && report
    payload = report ? DynamicReviews.extract(report) : {'snapshot' => read(snapshot), 'review' => read(review)}
    if in_progress
      payload['review']['status'] = 'in_progress'
      assign_outline_ranges(payload['review'], payload.fetch('snapshot'))
    end
    snapshot = payload.fetch('snapshot')
    root = DynamicReviews.git(repo, 'rev-parse', '--show-toplevel').strip
    raise ArgumentError, 'Report belongs to another checkout' unless snapshot['repo'] == root
    path = directory(root, name, create: true)
    locked(path) do
      raise ArgumentError, 'Series already exists' if File.exist?(File.join(path, 'manifest.json'))
      review = normalize(payload.fetch('review'))
      review.delete('history')
      if review['context_paths']
        if snapshot['mode'] == 'uncommitted'
          fresh = DynamicReviews.collect(repo: root)
          raise ArgumentError, 'Working code changed before recording context' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
        end
        review['context'] = contexts(snapshot, review.delete('context_paths'))
      end
      history = {'version' => 1, 'name' => name, 'repo' => root, 'branch' => branch(root), 'base' => snapshot['base'], 'origin_mode' => snapshot['mode'], 'revisions' => []}
      states = Array(review['findings']).map { |f| {'id' => f['id'], 'status' => 'open', 'change' => 'new', 'title' => f['title'], 'reason' => 'Recorded in the original review.'} }
      summary = if report then 'Original review imported. Its captured scope and validation remain historical.'
                elsif in_progress then 'Review in progress: the changes are ready to read while the agent reviews them.'
                else 'Initial review saved as the starting point for this series.'
                end
      append(path, history, snapshot, review, {'summary' => summary, 'groups' => {}, 'files' => [], 'finding_states' => states})
    end
  end

  # An outline names files, not ranges: give each file's ranges to its first item, unexplained
  # for now, so the walkthrough shows them and comments can be found in it.
  def assign_outline_ranges(review, snapshot)
    ranges = snapshot.fetch('files').to_h { |file| [file['id'], file['hunks'].map { |hunk| hunk['id'] }] }
    items = Array(review['groups']).flat_map { |group| Array(group['layers']) }.flat_map { |layer| Array(layer['items']) }
    taken = items.flat_map { |item| (item['summaries'] || {}).keys }
    items.each do |item|
      free = Array(ranges[item['file']]) - taken
      next if item.key?('summaries') || free.empty?
      item['summaries'] = free.to_h { |id| [id, ''] }
      taken.concat(free)
    end
  end

  # Completes a series started --in-progress: the full review replaces the outline in the same
  # revision, since the code is the same, so the open page keeps the reader's progress and conversations.
  # Comments the agent posted to the open page are kept; one with the same id in the review wins.
  def finish(repo:, name:, review:, **_unused)
    path = directory(repo, name)
    saved = locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Branch changed; use the original review checkout' unless history['branch'] == branch(repo)
      payload = latest(path, history)
      snapshot = payload.fetch('snapshot')
      raise ArgumentError, 'The latest revision is not in progress; publish increments with `dcr series prepare` and `publish`' unless payload.dig('review', 'status') == 'in_progress'
      fresh = DynamicReviews.collect(repo: repo, mode: 'series', base: snapshot['base'], head: snapshot['mode'] == 'uncommitted' || snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code changed while reviewing; run `dcr sync` to bring the review up to it, then finish with a review of that code' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
      review = normalize(read(review))
      %w[history status qa previews preview_scope screenshots no_screenshots].each { |field| review.delete(field) }
      entry = history['revisions'].last
      posted = with_posted(path, history, payload.fetch('review'))
      own = Array(review['comments']).map { |comment| comment['id'] }
      review['comments'] = Array(review['comments']) + posted.reject { |comment| own.include?(comment['id']) }
      shots = with_screenshots(path, history, payload.fetch('review'))
      review['screenshots'] = shots if shots.any?
      # A review served with the running app shows what the change looks like, or says why not:
      # an agent that skipped the screenshots is told here, where it cannot miss it.
      why = DCR::State.new(path).read.dig('no_screenshots', DCR::State.review_key(entry['fingerprint'], name, entry['number']))
      served = (JSON.parse(File.read(File.join(path, '.serve.json'))) rescue {})
      if served['app_port'] && shots.empty? && why.to_s.empty?
        raise ArgumentError, "This review is served with the running app, but shows no screenshot of it. Do \"Show the UI changes\" in SKILL.md now: take the screenshots in a tab of your own and post them with `dcr screenshot --repo #{repo} --name #{name} --file <screenshots.json>`. If there is nothing to show (no UI in this change, or no tool here that saves an image), say why instead: `dcr screenshot --repo #{repo} --name #{name} --none '<why, in a few words>'`. Then run this finish again."
      end
      review['no_screenshots'] = why if shots.empty? && !why.to_s.empty?
      # The Risk ranking the agent posted while reviewing, unless the full review brings its own.
      ranked = DCR::State.new(path).read.dig('risk_rankings', DCR::State.review_key(entry['fingerprint'], name, entry['number']))
      review['risk_ranking'] = ranked.except('posted_at') if ranked&.key?('files') && !review.key?('risk_ranking')
      # Comments written straight into the review are the finishing agent's, like the posted ones.
      author = DCR::Agents.detect
      review['comments'].each { |comment| comment['agent'] ||= author } if author
      review['context'] = contexts(snapshot, review.delete('context_paths')) if review['context_paths']
      states = Array(review['findings']).map { |f| {'id' => f['id'], 'status' => 'open', 'change' => 'new', 'title' => f['title'], 'reason' => 'Recorded in the full review.'} }
      summary = 'Full review ready: walkthrough explanations, findings and validation.'
      amend(path, history, snapshot, review, summary, {'summary' => summary, 'finding_states' => states}, was: payload.dig('review', 'history'))
    end
    # The full review is ready: bring the open page forward, where it offers to show it.
    if ENV['DCR_FOCUS'] != '0' && File.file?(File.join(path, '.serve.json'))
      require_relative '../lib/dcr/focus'
      DCR::Focus.served(path) rescue nil
    end
    saved
  end

  # A review's comments with the ones its agent posted to the open page, which only the state has
  # until a revision saves them.
  def with_posted(path, history, review)
    entry = history['revisions'].last
    saved = Array(review['comments'])
    posted = DCR::State.new(path).read.dig('comments', DCR::State.review_key(entry['fingerprint'], history['name'], entry['number'])) || []
    saved + posted.reject { |comment| saved.any? { |own| own['id'] == comment['id'] } }
  end

  # A review's screenshots with the ones its agent posted to the open page, images embedded. One
  # posted again under its id replaces the saved one.
  def with_screenshots(path, history, review)
    entry = history['revisions'].last
    records = DCR::State.new(path).read.dig('screenshots', DCR::State.review_key(entry['fingerprint'], history['name'], entry['number'])) || []
    posted = ReviewScreenshots.embedded(path, records)
    Array(review['screenshots']).reject { |shot| posted.any? { |own| own['id'] == shot['id'] } } + posted
  end

  # A save into a revision is made from the saved review: what the agent posted to the open page
  # since (comments after an update, screenshots) goes into it, or it would be left behind.
  def keep_posted(path, history, review)
    review['comments'] = with_posted(path, history, review)
    shots = with_screenshots(path, history, review)
    review['screenshots'] = shots if shots.any?
  end

  UPDATES = 'updates' # the walkthrough group for files an update brought in

  # Brings the saved review up to the code as it is now, with no new analysis: the next revision
  # shows the current diff, keeps the explanations of the ranges that did not change and leaves the
  # others unexplained. Every comment follows its lines or becomes outdated, and the reader's
  # progress and conversations come along. Returns what changed, for whoever reviews it next.
  def sync(repo:, name:, follow: false, **_unused)
    path = directory(repo, name)
    locked(path) do
      history = manifest(path)
      raise ArgumentError, 'Series belongs to another checkout' unless history['repo'] == File.realpath(repo)
      raise ArgumentError, 'Branch changed; choose the correct series or start a new one' unless history['branch'] == branch(repo)
      previous = latest(path, history)
      entry = history['revisions'].last
      pr = history['origin_mode'] == 'pr'
      # A pull request's review shows its pushed head until the reviewer has it follow the checkout.
      if pr && history['follows'] != 'checkout'
        raise ArgumentError, 'This review follows its pull request, not your checkout. The reviewer chooses Follow my checkout in the page (Update), or you run `dcr sync --follow-checkout` when they ask for it.' unless follow
        history.merge!('follows' => 'checkout', 'pinned_head' => previous['snapshot']['head'])
        atomic_write(File.join(path, 'manifest.json'), JSON.pretty_generate(history))
      end
      current = current_snapshot(repo, history, previous, working_tree: true, checkout: pr)
      next({'status' => 'unchanged', 'revision' => entry['number']}) if code_key(previous['snapshot']) == code_key(current)
      changes = compare(previous['snapshot'], current)
      in_progress = previous.dig('review', 'status') == 'in_progress'
      review = draft_review(previous['review'], current, changes, unexplained: true)
      place_unexplained(review, current)
      ranges = review['groups'].flat_map { |group| group['layers'] }.flat_map { |layer| layer['items'] }.flat_map { |item| item.fetch('summaries', {}).select { |_, prose| prose.strip.empty? }.keys }
      review['unreviewed'] = ranges unless in_progress || ranges.empty?
      anchors = DCR::Anchors.new(previous['snapshot'], current, changes['mapping'], entry['number'])
      review['comments'] = with_posted(path, history, previous['review']).map { |comment| anchors.carry(comment) }
      # A finding stays open on a range that did not change; on one that did it needs checking again.
      findings = Array(previous['review']['findings'])
      review['findings'] = findings.filter_map { |finding| changes['mapping'][finding['hunk']]&.then { |match| finding.merge('hunk' => match['hunk']) } }
      lost = findings.map { |finding| finding['id'] } - review['findings'].map { |finding| finding['id'] }
      states = (previous['review'].dig('history', 'finding_states') || []).map do |state|
        lost.include?(state['id']) ? state.merge('status' => 'needs-rechecking', 'change' => 'needs-rechecking', 'reason' => 'The code it was found in changed in an update. Not checked again.') : state
      end
      changed = changes['files'].reject { |file| file['state'] == 'unchanged' }
      outdated = review['comments'].select { |comment| comment.dig('outdated', 'revision') == entry['number'] }
      kept = changes['files'].select { |file| file['state'] == 'unchanged' }.map { |file| file['path'] }
      # A screenshot still shows the app as it is when none of its files changed; the others go.
      placed = review['comments'].reject { |comment| comment['outdated'] }.map { |comment| comment['id'] }
      shots, dropped = with_screenshots(path, history, previous['review']).partition { |shot| (shot['paths'] - kept).empty? && (!shot['comment_id'] || placed.include?(shot['comment_id'])) }
      review['screenshots'] = shots if shots.any?
      summary = "Updated to the code as it is now: #{count(changed.length, 'file')} changed since revision #{entry['number']}"
      summary += in_progress || ranges.empty? ? '.' : ", #{count(ranges.length, 'range')} not reviewed yet."
      summary += " #{count(outdated.length, 'comment')} #{outdated.length == 1 ? 'is' : 'are'} outdated." if outdated.any?
      summary += " #{count(dropped.length, 'screenshot')} of changed files #{dropped.length == 1 ? 'was' : 'were'} dropped." if dropped.any?
      key = ->(revision, fingerprint) { DCR::State.review_key(fingerprint, name, revision) }
      DynamicReviews.validate(current, review)
      # The reader's side first, so a page that opens the new revision at once finds it there.
      state = DCR::State.new(path)
      state.carry_changed(key.call(entry['number'], entry['fingerprint']), key.call(entry['number'] + 1, current['fingerprint']), kept) { |comment| anchors.carry(comment, full: true) }
      delta = since(previous['snapshot'], current, entry['number'])
      append(path, history, current, review, {'summary' => summary, 'files' => changes['files'], 'reused_ranges' => changes['mapping'].length,
             'inspected_ranges' => 0, 'changed_context' => [], 'groups' => {}, 'finding_states' => states, 'update' => true, 'since' => delta})
      # Each comment whose lines changed, with what is needed to say what became of it: the code it
      # was written on, what changed in its file since, and what other agents said of it.
      kept_state = state.read
      own = Array(kept_state.dig('blobs', key.call(entry['number'] + 1, current['fingerprint']), 'personalComments')).select { |comment| comment.dig('outdated', 'revision') == entry['number'] }
      threads = kept_state.dig('threads', key.call(entry['number'] + 1, current['fingerprint'])) || {}
      patches = delta['files'].to_h { |file| [file['path'], file['patch']] }
      lost = (outdated + own.map { |comment| comment.merge('reader' => true) }).map do |comment|
        comment.slice('id', 'label', 'decoration', 'subject', 'discussion', 'agent', 'outdated', 'reader').merge('patch' => patches[comment.dig('outdated', 'path')], 'opinions' => opinions(threads[comment['id']])).compact
      end
      {'status' => 'updated', 'outdated_comments' => lost, 'revision' => entry['number'] + 1, 'previous_revision' => entry['number'], 'summary' => summary, 'base' => history['base'],
       'key' => key.call(entry['number'] + 1, current['fingerprint']),
       'files' => changed.map { |file| file.slice('path', 'state') }, 'outdated' => outdated.map { |comment| comment['id'] },
       'screenshots_dropped' => dropped.map { |shot| shot.slice('id', 'title', 'page', 'comment_id') },
       'unreviewed' => changes['required_hunks'].map { |hunk| hunk.slice('path', 'hunk', 'patch') }}
    end
  end

  # What other agents said of a comment, a line each, for whoever looks at it again.
  def opinions(thread)
    said = Array(thread&.dig('messages')).select { |message| message['role'] == 'adversary' }.map { |message| [message['agent'], 'second reviewer', message['verdict'], message['body']] } +
           (thread&.dig('opinions') || {}).select { |_, opinion| opinion['body'] }.map { |agent, opinion| [agent, nil, opinion['verdict'], opinion['short'] || opinion['body']] }
    said.map { |agent, role, verdict, body| "- #{DCR::Agents.name(agent)}#{" (#{[role, verdict].compact.join(', ')})" if role || verdict}: #{body.gsub(/\s*\n\s*/, ' ')[0, 700]}" }
  end

  def count(number, noun) = "#{number} #{noun}#{'s' unless number == 1}"

  BRIEF_LINES = 400 # of changed code handed to the agent; the rest it reads itself
  OUTDATED_LINES = 80 # of what changed in an outdated comment's file

  # What an update changed, for the agent that comments on it: the ranges nobody has reviewed, as patches.
  def sync_brief(result)
    out = ["CODE UPDATE: #{result['summary']}", result['files'].map { |file| "#{file['state']}: #{file['path']}" }.join("\n")]
    Array(result['outdated_comments']).each do |comment|
      was = comment['outdated']
      lines = was['start'] == was['end'] ? "line #{was['start']}" : "lines #{was['start']}-#{was['end']}"
      patch = comment['patch'].to_s.lines
      out << ["OUTDATED COMMENT #{comment['id']} (#{comment['reader'] ? 'written by the reviewer' : "by #{DCR::Agents.name(comment['agent'] || 'agent')}"}): #{[comment['label'], comment['subject']].compact.join(': ')}",
              comment['discussion'].to_s.strip.then { |text| text unless text.empty? },
              "The code it was written on (#{was['path']}, #{was['side'] == 'new' ? 'after' : 'before'} the change, #{lines}, revision #{was['revision']}):\n#{Array(was['lines']).join("\n")}",
              patch.empty? ? nil : "What changed in #{was['path']} since revision #{was['revision']}:\n#{patch.first(OUTDATED_LINES).join.chomp}#{"\n(#{patch.length - OUTDATED_LINES} more lines: read the file)" if patch.length > OUTDATED_LINES}",
              Array(comment['opinions']).empty? ? nil : "What other agents said of it:\n#{comment['opinions'].join("\n")}"].compact.join("\n\n")
    end
    gone = Array(result['screenshots_dropped'])
    out << "Screenshots dropped because their files changed; take the ones still worth showing again and post them with `dcr screenshot`:\n#{gone.map { |shot| "- #{shot['id']}: #{shot['title']}#{" (#{shot['page']})" if shot['page']}" }.join("\n")}" if gone.any?
    left = BRIEF_LINES
    shown = result['unreviewed'].take_while { |range| (left -= range['patch'].lines.length) >= 0 }
    out << "Not reviewed yet (#{count(result['unreviewed'].length, 'range')}):" if result['unreviewed'].any?
    shown.each { |range| out << "#{range['path']}  #{range['hunk']}\n#{range['patch'].chomp}" }
    rest = result['unreviewed'].drop(shown.length)
    out << "#{count(rest.length, 'more range')} in #{rest.map { |range| range['path'] }.uniq.join(', ')}: read them with `git diff #{result['base']} -- <path>`; their ids are #{rest.map { |range| range['hunk'] }.join(', ')}." if rest.any?
    out.join("\n\n")
  end

  # Whether the code moved on since the latest revision, for a page that offers to update itself.
  def stale(repo:, name:, **_unused)
    path = directory(repo, name)
    history = manifest(path)
    raise ArgumentError, 'Branch changed; choose the correct series or start a new one' unless history['branch'] == branch(repo)
    previous = latest(path, history)
    pr = history['origin_mode'] == 'pr'
    changes = compare(previous['snapshot'], current_snapshot(repo, history, previous, working_tree: true, checkout: pr))
    result = {'changed' => changes['files'].count { |file| file['state'] != 'unchanged' }}
    # pinned: it shows the pull request's head, and the reader has not chosen the checkout yet.
    result['pinned'] = true if pr && history['follows'] != 'checkout'
    result['warning'] = rebased(repo, history, previous) if pr
    result.compact
  end

  # Says so when the branch was rebased or merged onto a newer base than the review starts from:
  # an update would then show what the base branch gained too. Known only when the review named it.
  def rebased(repo, history, previous)
    label = previous.dig('review', 'comparison', 'base_label').to_s
    return if label.empty? || label.start_with?('-')
    ref = ["origin/#{label}", label].find { |name| !DynamicReviews.git(repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', "#{name}^{commit}", allowed: [0, 1, 128]).strip.empty? }
    return unless ref
    start = DynamicReviews.git(repo, 'merge-base', ref, 'HEAD', allowed: [0, 1]).strip
    "This branch now starts from a newer #{label} than the review does, so an update would also show what #{label} gained since. Ask your agent for a new review instead." unless start.empty? || start == history['base']
  end

  # Gives every range no item explains to its file's first item, unexplained, and puts the files
  # the walkthrough does not have yet in one last group, so the whole diff can be read at once.
  def place_unexplained(review, snapshot)
    review['groups'].each { |group| group['layers'].reject! { |layer| layer['items'].empty? } }
    review['groups'].reject! { |group| group['layers'].empty? }
    items = review['groups'].flat_map { |group| group['layers'] }.flat_map { |layer| layer['items'] }
    taken = items.flat_map { |item| item.fetch('summaries', {}).keys }
    added = snapshot['files'].filter_map do |file|
      free = (file['hunks'].map { |hunk| hunk['id'] } - taken).to_h { |id| [id, ''] }
      item = items.find { |candidate| candidate['file'] == file['id'] }
      next({'file' => file['id'], 'summaries' => free}) unless item
      item['summaries'] = item.fetch('summaries', {}).merge(free) unless free.empty?
      nil
    end
    # A test panel that lost its code or its tests is gone, and its layer's tests read as plain files.
    review['groups'].flat_map { |group| group['layers'] }.each do |layer|
      next unless layer.key?('related_tests')
      tests = layer['items'].map { |item| item['file'] }.select { |id| DynamicReviews.test_path?(snapshot['files'].find { |file| file['id'] == id }['path']) }
      layer.delete('related_tests') unless (tests - layer['related_tests'].flat_map { |panel| panel['files'] }).empty?
    end
    return if added.empty?
    group = review['groups'].find { |candidate| candidate['id'] == UPDATES }
    unless group
      group = {'id' => UPDATES, 'title' => 'Added since the review', 'summary' => 'Files that came in after the review was written. They are not explained yet.',
               'layers' => [{'id' => "#{UPDATES}-step-1", 'title' => 'New files', 'summary' => 'Files the walkthrough does not place yet.', 'items' => []}]}
      review['groups'] << group
    end
    group['layers'].first['items'].concat(added)
  end

  # A revision is one diff: it is saved when the series starts and when the code changes
  # (`publish`, `sync`), never for anything else.
  def append(path, history, snapshot, review, increment)
    number = (history['revisions'].last || {}).fetch('number', 0) + 1
    raise ArgumentError, 'Revision already exists; preserved rather than overwritten' if File.exist?(revision_path(path, number))
    history['revisions'] << {'number' => number, 'created' => Time.now.utc.iso8601, 'captured' => snapshot['created'], 'head' => snapshot['head'], 'fingerprint' => snapshot['fingerprint'], 'title' => review['title'], 'summary' => increment['summary']}
    write(path, history, snapshot, review, increment)
  end

  # What is learned later about the same code (the full review, QA, previews, a reassessment) is
  # saved into its revision and listed on it, newest last.
  # note: the save in a sentence. increment: what it changes in the revision's own account (a
  # 'summary' becomes the revision's). was: that account as saved, the review's `history`.
  def amend(path, history, snapshot, review, note, increment = {}, was:)
    entry = history['revisions'].last
    key = -> { DCR::State.review_key(entry['fingerprint'], history['name'], entry['number']) }
    before = key.call
    (entry['saves'] ||= []) << {'at' => Time.now.utc.iso8601, 'summary' => note}
    entry.merge!({'captured' => snapshot['created'], 'head' => snapshot['head'], 'fingerprint' => snapshot['fingerprint'], 'title' => review['title'], 'summary' => increment['summary']}.compact)
    # The same code under another commit: what the reader has on it goes with it.
    DCR::State.new(path).rekey(before, key.call) unless key.call == before
    write(path, history, snapshot, review, was.except('series', 'revision', 'save', 'entries', 'preview', 'origin_mode', 'local').merge(increment))
  end

  def write(path, history, snapshot, review, increment)
    entry = history['revisions'].last
    output = revision_path(path, entry['number'])
    # A pull request's review that shows the checkout says so: its code may not be on the pull request.
    increment = increment.merge('local' => true) if history['origin_mode'] == 'pr' && history['follows'] == 'checkout' && snapshot['working_tree']
    review['history'] = increment.merge('series' => history['name'], 'revision' => entry['number'], 'save' => Array(entry['saves']).length, 'entries' => history['revisions'], 'origin_mode' => history['origin_mode'])
    html = DynamicReviews.review_html(snapshot, review)
    # The revision's page is durable first; the manifest is the commit point.
    atomic_write(output, html)
    refresh_views(path, history)
    atomic_write(File.join(path, 'manifest.json'), JSON.pretty_generate(history))
    output
  end

  # Browsing pages may refresh their navigation/UI; the saved revisions are not touched.
  def refresh_views(path, history)
    history.fetch('revisions').each do |entry|
      payload = DynamicReviews.extract(revision_path(path, entry.fetch('number')))
      review = payload.fetch('review')
      review['history']['preview'] = true
      review['history']['origin_mode'] = history['origin_mode']
      review['history']['entries'] = history['revisions']
      html = DynamicReviews.review_html(payload.fetch('snapshot'), review)
      atomic_write(File.join(path, format('revision-%03d.html', entry['number'])), html)
      atomic_write(File.join(path, 'current.html'), html) if entry == history['revisions'].last
    end
    atomic_write(File.join(path, 'index.html'), DCR::Page.history(history))
  end

  def list(repo:, **_unused)
    root = DynamicReviews.git(repo, 'rev-parse', '--show-toplevel').strip
    raise ArgumentError, 'Unsafe .reviews directory' if File.symlink?(File.join(root, '.reviews'))
    Dir.glob(File.join(root, '.reviews', '*', 'manifest.json')).filter_map do |file|
      name = File.basename(File.dirname(file))
      path = directory(root, name)
      data = manifest(path)
      {'name' => name, 'branch' => data['branch'], 'current_branch' => data['branch'] == branch(root), 'latest' => data['revisions'].last, 'index' => File.join(path, 'index.html')}
    end
  end

  def refresh(repo:, name:, **_unused)
    path = directory(repo, name)
    locked(path) do
      refresh_views(path, manifest(path))
      File.join(path, 'current.html')
    end
  end

  def run(argv)
    command = argv.shift
    options = {}
    parser = OptionParser.new do |p|
      p.banner = 'ruby series.rb start|prepare|publish|finish|sync|qa|previews|enrich|refresh|list [options]'
      %w[repo name report snapshot review out head base prepared update revision].each { |key| p.on("--#{key} VALUE") { |value| options[key.to_sym] = value } }
      p.on('--working-tree', 'Include current working files with the verified PR head') { options[:working_tree] = true }
      p.on('--record', 'publish: save an intentional reassessment of unchanged code into its revision') { options[:record] = true }
      p.on('--targeted', 'Attach only requested preview files, preserving existing examples') { options[:targeted] = true }
      p.on('--in-progress', 'start: publish an outline to read while the review is still being written') { options[:in_progress] = true }
    end
    parser.parse!(argv)
    raise ArgumentError, parser.to_s unless %w[start prepare publish finish sync qa previews enrich refresh list].include?(command)
    # For `dcr log`: what ran on the series, and what it was refused with.
    series = options[:repo] && options[:name].to_s.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/) ? File.join(File.expand_path(options[:repo]), '.reviews', options[:name]) : nil
    said = ["series #{command}", *%i[working_tree record targeted in_progress].select { |flag| options[flag] }.map { |flag| "--#{flag.to_s.tr('_', '-')}" }].join(' ')
    begin
      result = public_send(command, **options)
    rescue ArgumentError, KeyError, SystemCallError, JSON::ParserError => error
      DCR::Activity.record(series, said, 'failed', error.message)
      raise
    end
    DCR::Activity.record(series, said, 'ok')
    puts result.is_a?(String) ? result : JSON.pretty_generate(result)
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    ReviewSeries.run(ARGV)
  rescue ArgumentError, KeyError, SystemCallError, JSON::ParserError => error
    abort error.message
  end
end
