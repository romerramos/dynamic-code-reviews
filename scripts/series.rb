#!/usr/bin/env ruby
# frozen_string_literal: true

# Incremental review storage and reuse. Ruby standard library + Git only.
require_relative 'review'
require 'cgi'
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

  def draft_review(previous, current, changes)
    review = normalize(previous)
    mapping = changes['mapping']
    lookup = changes['files'].select { |f| f['previous_file'] && f['file'] }.to_h { |f| [f['previous_file'], f] }
    review['groups'].each do |group|
      group['layers'].each do |layer|
        layer['items'] = layer['items'].filter_map do |item|
          file = lookup[item['file']]
          next unless file
          summaries = item.fetch('summaries', {}).filter_map { |hid, prose| [mapping[hid]['hunk'], prose] if mapping[hid] }.to_h
          next if summaries.empty? && current['files'].find { |f| f['id'] == file['file'] }['hunks'].any?
          next if file['metadata_recheck']
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
    review.delete('history')
    review.delete('qa') # Captures prove a particular runtime/snapshot, never an automatic increment.
    review
  end

  def prepare(repo:, name:, out:, head: nil, base: nil, **_unused)
    path = directory(repo, name)
    history = manifest(path)
    raise ArgumentError, 'Series belongs to another checkout' unless history['repo'] == File.realpath(repo)
    raise ArgumentError, 'Branch changed; choose the correct series or start a new one' unless history['branch'] == branch(repo)
    previous = latest(path, history)
    if history['origin_mode'] == 'pr'
      raise ArgumentError, 'PR series requires explicitly verified --base and --head refs' unless base && head
      current_base = DynamicReviews.git(repo, 'merge-base', DynamicReviews.sha(repo, base), DynamicReviews.sha(repo, head)).strip
      raise ArgumentError, 'PR base changed; start a new baseline series' unless current_base == history['base']
    end
    current = DynamicReviews.collect(repo: repo, mode: 'series', base: history.fetch('base'), head: head)
    common = DynamicReviews.git(repo, 'merge-base', previous['snapshot']['head'], current['head'], allowed: [0, 1]).strip
    raise ArgumentError, 'History was rewritten; start a new baseline series and reassess the full scope' unless common == previous['snapshot']['head']
    old_context = previous['review'].fetch('context', {})
    current_context = contexts(current, old_context.keys)
    changed_context = old_context.keys.select { |key| old_context[key] != current_context[key] }
    changes = compare(previous['snapshot'], current, context_changed: changed_context.any?)
    status = code_key(previous['snapshot']) == code_key(current) && changed_context.empty? ? 'unchanged' : 'changed'
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
      'ranges_to_inspect' => changes['required_hunks'].map { |h| h.slice('file', 'path', 'hunk') }, 'reusable_ranges' => changes['mapping'].length,
      'changed_context' => changed_context, 'pending_findings' => plan['previous_findings'].map { |f| f['id'] }, 'prepared' => File.expand_path(out) }
  end

  def apply_update(draft, update)
    review = copy(draft)
    allowed = %w[title headline summary effort coverage validation sections flow file_categories qa comparison]
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

  def publish(prepared:, update:, record: false, **_unused)
    plan = read(File.join(prepared, 'plan.json'))
    snapshot = read(File.join(prepared, 'snapshot.json'))
    draft = read(File.join(prepared, 'draft.json'))
    update = read(update) if update.is_a?(String)
    raise ArgumentError, 'No code/context changes; use existing revision, or --record for an intentional reassessment' if plan['status'] == 'unchanged' && !record
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
      review = apply_update(draft, update)
      review['findings'], states = finding_states(plan, update)
      paths = (plan['context'].keys + Array(update['context_paths'])).uniq
      review['context'] = contexts(snapshot, paths)
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
      append(path, history, snapshot, review, {'summary' => update['since_previous'], 'files' => changes,
             'reused_ranges' => plan['changes']['mapping'].length, 'inspected_ranges' => plan['changes']['required_hunks'].length,
             'changed_context' => plan['changed_context'], 'groups' => group_states, 'finding_states' => states})
    end
  end

  # Attach evidence to the exact reviewed snapshot without rewriting analysis/history.
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
      ReviewQA.validate(evidence, snapshot)
      fresh = DynamicReviews.collect(repo: repo, mode: 'series', base: snapshot['base'], head: snapshot['mode'] == 'uncommitted' || snapshot['working_tree'] ? nil : snapshot['head'])
      raise ArgumentError, 'Code changed; review the new snapshot before attaching QA' unless code_key(fresh) == code_key(snapshot) && fresh['head'] == snapshot['head']
      recorded_context = review.fetch('context', {})
      raise ArgumentError, 'Context changed; reassess before attaching QA' unless contexts(fresh, recorded_context.keys) == recorded_context
      raise ArgumentError, 'QA evidence is unchanged' if review['qa'] == evidence
      review['qa'] = evidence
      increment = {'summary' => "QA evidence updated: #{evidence['summary']}", 'files' => [], 'groups' => {},
                   'finding_states' => review.dig('history', 'finding_states') || []}
      append(path, history, snapshot, review, increment)
    end
  end

  def start(repo:, name:, report: nil, snapshot: nil, review: nil, **_unused)
    raise ArgumentError, 'Provide --report or both --snapshot and --review' unless report || (snapshot && review)
    payload = report ? DynamicReviews.extract(report) : {'snapshot' => read(snapshot), 'review' => read(review)}
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
      summary = report ? 'Original review imported. Its captured scope and validation remain historical.' : 'Initial review saved as the starting point for this series.'
      append(path, history, snapshot, review, {'summary' => summary, 'groups' => {}, 'files' => [], 'finding_states' => states})
    end
  end

  def append(path, history, snapshot, review, increment)
    number = (history['revisions'].last || {}).fetch('number', 0) + 1
    output = revision_path(path, number)
    raise ArgumentError, 'Revision already exists; preserved rather than overwritten' if File.exist?(output)
    entry = {'number' => number, 'created' => Time.now.utc.iso8601, 'captured' => snapshot['created'], 'head' => snapshot['head'], 'fingerprint' => snapshot['fingerprint'], 'title' => review['title'], 'summary' => increment['summary']}
    history['revisions'] << entry
    review['history'] = increment.merge('series' => history['name'], 'revision' => number, 'entries' => history['revisions'], 'origin_mode' => history['origin_mode'])
    html = DynamicReviews.review_html(snapshot, review)
    # Revision is durable first; manifest is the commit point. Old HTML is never rewritten.
    atomic_write(output, html)
    refresh_views(path, history)
    atomic_write(File.join(path, 'manifest.json'), JSON.pretty_generate(history))
    output
  end

  # Browsing pages may refresh their navigation/UI; saved snapshots remain immutable.
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
    atomic_write(File.join(path, 'index.html'), index_html(history))
  end

  def index_html(history)
    esc = ->(s) { CGI.escapeHTML(s.to_s) }
    styles = File.read(File.join(DynamicReviews::ASSETS, 'vendor/daisyui.css')) + File.read(File.join(DynamicReviews::ASSETS, 'report.css'))
    icon = File.read(File.join(DynamicReviews::ASSETS, 'icon.svg'))
    entries = history['revisions'].reverse.map do |entry|
      label = entry == history['revisions'].last ? 'Latest review' : 'Open revision'
      target = entry == history['revisions'].last ? 'current.html' : "revision-#{format('%03d', entry['number'])}.html"
      "<article class='section-card card'><span class='badge neutral'>Revision #{entry['number']}</span><h2>#{esc.call(entry['title'])}</h2><p>#{esc.call(entry['summary'])}</p><p class='muted'>Saved #{esc.call(entry['created'])} · code #{esc.call(entry['head'][0, 8])}</p><a class='btn btn-sm btn-primary' href='#{target}'>#{label}</a> <a class='btn btn-sm btn-ghost' href='revisions/#{format('%03d', entry['number'])}.html'>Saved snapshot</a></article>"
    end.join
    "<!doctype html><html lang='en' data-theme='light'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\"><title>#{esc.call(history['name'])} · Review history</title><style>#{styles}</style></head><body><main style='max-width:960px;margin:40px auto;padding:24px'><div class='brand'><span class='brand-icon' aria-hidden='true'>#{icon}</span><strong>Dynamic Code Reviews</strong></div><h1 style='margin-top:30px'>#{esc.call(history['name'])}</h1><p class='lead'>#{history['revisions'].length} saved revisions · #{esc.call(history['branch'])}</p><p class='muted'>Each revision preserves its original review and test results. Continue from the latest review to inspect the next increment.</p>#{entries}</main></body></html>"
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

  def refresh(repo:, name:, record: false, **_unused)
    path = directory(repo, name)
    locked(path) do
      history = manifest(path)
      if record
        payload = latest(path, history)
        review = payload.fetch('review')
        increment = copy(review.fetch('history')).except('series', 'revision', 'entries', 'preview', 'origin_mode')
        increment.merge!('summary' => 'Presentation refreshed; captured code, review conclusions and original validation evidence are unchanged.',
                         'files' => [], 'groups' => {}, 'changed_context' => [], 'inspected_ranges' => 0)
        append(path, history, payload.fetch('snapshot'), review, increment)
      else
        refresh_views(path, history)
      end
      File.join(path, 'current.html')
    end
  end

  def run(argv)
    command = argv.shift
    options = {}
    parser = OptionParser.new do |p|
      p.banner = 'ruby series.rb start|prepare|publish|qa|refresh|list [options]'
      %w[repo name report snapshot review out head base prepared update revision].each { |key| p.on("--#{key} VALUE") { |value| options[key.to_sym] = value } }
      p.on('--record', 'Save an intentional reassessment or a presentation-only refresh revision') { options[:record] = true }
    end
    parser.parse!(argv)
    raise ArgumentError, parser.to_s unless %w[start prepare publish qa refresh list].include?(command)
    result = public_send(command, **options)
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
