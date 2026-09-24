#!/usr/bin/env ruby
# frozen_string_literal: true

if (RUBY_VERSION.split('.').map(&:to_i) <=> [3, 1, 0]).negative?
  abort "Dynamic Code Reviews requires Ruby 3.1+ (found #{RUBY_VERSION}). Select a supported Ruby on PATH and retry."
end

# Ruby standard library only. Git collects the patch; this file owns scope,
# line alignment, validation and embedding. Browser presentation lives in assets/.
require 'digest'
require 'fileutils'
require 'json'
require 'open3'
require 'optparse'
require 'pathname'
require 'time'
require_relative 'qa_assets'
require_relative 'previews'

module DynamicReviews
  ASSETS = File.expand_path('../assets', __dir__)
  LABELS = %w[issue suggestion question note praise nitpick todo thought chore typo polish quibble].freeze
  LANGUAGES = %w[core markup clike javascript css ruby sql json yaml bash typescript].freeze

  def self.git(root, *args, allowed: [0])
    literal = %w[diff ls-files ls-tree].include?(args.first) ? ['--literal-pathspecs'] : []
    output, error, status = Open3.capture3('git', *literal, '-C', root.to_s, *args)
    raise ArgumentError, error.strip unless allowed.include?(status.exitstatus)
    output
  end

  def self.text(bytes)
    bytes.dup.force_encoding(Encoding::UTF_8).scrub
  end

  def self.sha(root, ref)
    git(root, 'rev-parse', '--verify', '--end-of-options', "#{ref}^{commit}").strip
  end

  # One row per context line or paired replacement. Unmatched added/deleted
  # lines have a genuinely empty cell on the other side, never a fake number.
  def self.diff_rows(hunk)
    old_line, new_line = hunk.values_at('old_start', 'new_start')
    unified = []
    hunk.fetch('patch').lines.drop(1).each do |raw|
      line = raw.delete_suffix("\n")
      kind = {' ' => 'context', '+' => 'add', '-' => 'del'}[line[0]]
      unless kind
        unified.last['no_newline'] = true if line.start_with?('\\') && unified.last
        next
      end
      entry = {'kind' => kind, 'text' => line[1..-1]}
      entry['old'] = old_line if kind != 'add'
      entry['new'] = new_line if kind != 'del'
      old_line += 1 if kind != 'add'
      new_line += 1 if kind != 'del'
      unified << entry
    end
    unless old_line == hunk['old_start'] + hunk['old_count'] && new_line == hunk['new_start'] + hunk['new_count']
      raise ArgumentError, "Hunk line counts do not match its header: #{hunk['id']}"
    end
    split = []
    pending = []
    flush = lambda do
      removed = pending.select { |line| line['kind'] == 'del' }
      added = pending.select { |line| line['kind'] == 'add' }
      [removed.length, added.length].max.times do |i|
        split << {'old' => removed[i], 'new' => added[i]}
      end
      pending.clear
    end
    unified.each do |line|
      if line['kind'] == 'context'
        flush.call
        split << {'old' => line, 'new' => line}
      else
        pending << line
      end
    end
    flush.call
    {'unified' => unified, 'split' => split}
  end

  def self.hunks(patch, file_id)
    matches = patch.to_enum(:scan, /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/).map { Regexp.last_match }
    matches.each_with_index.map do |match, index|
      hunk = {'id' => "#{file_id}h#{index + 1}", 'old_start' => match[1].to_i, 'old_count' => (match[2] || '1').to_i,
              'new_start' => match[3].to_i, 'new_count' => (match[4] || '1').to_i,
              'patch' => patch[match.begin(0)...(matches[index + 1]&.begin(0) || patch.length)]}
      diff_rows(hunk) # Reject inconsistent patches at collection time.
      hunk
    end
  end

  def self.sensitive?(path)
    path.split('/').any? { |part| %w[.secrets .env credentials].include?(part) || part.start_with?('.env.') } ||
      %w[.pem .key .p12 .pfx .enc].include?(File.extname(path))
  end

  def self.sensitive_identity(root, path, working_tree:, head:)
    if working_tree
      target = File.join(root, path)
      if File.symlink?(target)
        Digest::SHA256.hexdigest(JSON.generate(['120000', File.readlink(target)]))
      elsif File.file?(target)
        mode = (File.stat(target).mode & 0o111).zero? ? '100644' : '100755'
        Digest::SHA256.hexdigest(JSON.generate([mode, Digest::SHA256.file(target).hexdigest]))
      else
        'deleted'
      end
    else
      Digest::SHA256.hexdigest(git(root, 'ls-tree', '-z', head, '--', path))
    end
  end

  def self.collect(repo: '.', mode: 'uncommitted', commit: nil, base: nil, head: nil, max_bytes: 300_000, **_unused)
    root = git(repo, 'rev-parse', '--show-toplevel').strip
    working_tree = mode == 'uncommitted' || (mode == 'series' && head.nil?)
    if mode == 'commit'
      raise ArgumentError, '--commit is required' unless commit
      head = sha(root, commit)
      parents = git(root, 'rev-list', '--parents', '-n', '1', head).split.drop(1)
      raise ArgumentError, 'Merge commit: select a parent with --base' if parents.length > 1 && !base
      base = base ? sha(root, base) : parents.first || git(root, 'hash-object', '-t', 'tree', '--stdin').strip
      raise ArgumentError, '--base must be a parent of the selected commit' if parents.any? && !parents.include?(base)
    elsif mode == 'pr'
      raise ArgumentError, 'PR mode requires verified --base and --head refs' unless base && head
      head = sha(root, head)
      base = git(root, 'merge-base', sha(root, base), head).strip
    elsif mode == 'uncommitted'
      head = sha(root, 'HEAD')
      base = head
    elsif mode == 'series'
      raise ArgumentError, 'Series requires its original --base' unless base
      empty_tree = git(root, 'hash-object', '-t', 'tree', '--stdin').strip
      base = sha(root, base) unless base == empty_tree
      head = sha(root, head || 'HEAD')
    else
      raise ArgumentError, 'Mode must be uncommitted, commit, pr or series'
    end
    raise ArgumentError, 'Unresolved conflicts: resolve them or choose a committed scope' if working_tree && !git(root, 'ls-files', '-u').empty?
    compare = working_tree ? [base] : [base, head]
    paths = git(root, 'diff', '--name-only', '-z', '--no-renames', *compare).split("\0")
    paths += git(root, 'ls-files', '--others', '--exclude-standard', '-z').split("\0") if working_tree
    files = paths.uniq.sort.reject { |path| path == '.reviews' || path.start_with?('.reviews/') }.map.with_index do |path, index|
      file = {'id' => "f#{index + 1}", 'path' => text(path), 'note' => '', 'patch' => '', 'hunks' => []}
      target = File.join(root, path)
      if sensitive?(path)
        file['note'] = 'Excluded: potentially sensitive file'
        file['content_digest'] = sensitive_identity(root, path, working_tree: working_tree, head: head) if File.extname(path) == '.enc'
      elsif working_tree && git(root, 'ls-files', '--error-unmatch', '--', path, allowed: [0, 1]).empty?
        if File.symlink?(target) || !File.file?(target)
          file['note'] = 'Untracked symlink or non-regular file; content omitted'
        else
          file['content_digest'] = Digest::SHA256.file(target).hexdigest
          file['git_mode'] = (File.stat(target).mode & 0o111).zero? ? '100644' : '100755'
          if File.size(target) > max_bytes
            file['note'] = 'Large untracked file omitted; inspect separately'
          else
            data = File.binread(target)
            if data.include?("\0")
              file['note'] = 'Binary untracked file; content omitted'
            else
              lines = text(data).lines.map { |line| "+#{line}" }
              unless lines.empty?
                file['patch'] = "--- /dev/null\n+++ b/#{text(path)}\n@@ -0,0 +1,#{lines.length} @@\n#{lines.join}"
                file['patch'] += "\n\\ No newline at end of file\n" unless data.end_with?("\n")
              end
              file['note'] = 'Untracked addition'
            end
          end
        end
      else
        patch = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', *compare, '--', path)
        file['content_digest'] = Digest::SHA256.hexdigest(patch)
        file['patch'] = text(patch) if patch.bytesize <= max_bytes
        file['note'] = 'Patch omitted: exceeds size limit' if patch.bytesize > max_bytes
      end
      file['hunks'] = hunks(file['patch'], file['id'])
      file['note'] = 'Metadata-only or binary change; inspect patch header' if file['hunks'].empty? && !file['patch'].empty?
      file['digest'] = Digest::SHA256.hexdigest(JSON.generate(file))
      file
    end
    fingerprint = Digest::SHA256.hexdigest(JSON.generate([root, mode, base, head, files]))
    result = {'version' => 2, 'repo' => root, 'mode' => mode, 'base' => base, 'head' => head,
              'created' => Time.now.utc.iso8601, 'fingerprint' => fingerprint, 'files' => files}
    result['working_tree'] = working_tree if mode == 'series'
    add_sources(result, working_tree: working_tree, max_bytes: max_bytes)
  end

  # Full context is captured separately from patch identity. Legacy committed
  # reports can recover it from immutable Git objects, never today's worktree.
  def self.add_sources(snapshot, working_tree: false, max_bytes: 300_000)
    snapshot['files'].each do |file|
      next if file.key?('source') || sensitive?(file['path']) || file['patch'].empty? || file['note'].include?('omitted')
      root, path = snapshot['repo'], file['path']
      source = %w[old new].to_h do |side|
        ref = snapshot[side == 'old' ? 'base' : 'head']
        entry = git(root, 'ls-tree', ref, '--', path).split
        data = if side == 'new' && working_tree
                 target = File.join(root, path)
                 next [side, nil] if File.symlink?(target) || (File.file?(target) && File.size(target) > max_bytes)
                 File.file?(target) ? File.binread(target) : ''
               elsif entry.empty?
                 ''
               elsif entry[1] == 'blob' && %w[100644 100755].include?(entry[0]) && git(root, 'cat-file', '-s', entry[2]).to_i <= max_bytes
                 git(root, 'cat-file', 'blob', entry[2])
               end
        [side, data && !data.include?("\0") ? text(data) : nil]
      end
      file['source'] = source if source.values.all?
    rescue ArgumentError, Errno::ENOENT
      # Exported reports remain usable if the original repository is absent.
      next
    end
    snapshot
  end

  def self.test_path?(path)
    path.match?(%r{(^|/)(test|tests|spec|specs|fixtures|__tests__)(/|$)|\.(test|spec)\.[^.]+$}i)
  end

  def self.validate(snapshot, review)
    ReviewQA.validate(review['qa'], snapshot, review)
    ReviewPreviews.validate(review['previews'], snapshot, full: review['preview_scope'] != 'targeted')
    files = snapshot.fetch('files').to_h { |file| [file.fetch('id'), file] }
    hunks = files.values.flat_map { |file| file.fetch('hunks').map { |hunk| [hunk['id'], [file['id'], hunk]] } }.to_h
    covered, seen = [], []
    review.fetch('groups').each do |group|
      group.fetch('layers').each do |layer|
        layer_files = layer.fetch('items').map { |item| item.fetch('file') }
        grouped_tests = []
        Array(layer['related_tests']).each do |panel|
          unless %w[title summary].all? { |key| panel[key].is_a?(String) && !panel[key].strip.empty? } &&
                 %w[entities files].all? { |key| panel[key].is_a?(Array) && !panel[key].empty? && panel[key].uniq == panel[key] && (panel[key] - layer_files).empty? }
            raise ArgumentError, 'Related tests need a title, behavior summary and distinct file/entity references in their layer'
          end
          unless panel['files'].all? { |fid| files[fid] && test_path?(files[fid]['path']) } &&
                 panel['entities'].all? { |fid| files[fid] && !test_path?(files[fid]['path']) } && (panel['files'] & grouped_tests).empty?
            raise ArgumentError, 'Related test panels must contain test files once, separate from their entities'
          end
          grouped_tests.concat(panel['files'])
        end
        if layer.key?('related_tests') && (layer_files.select { |fid| files[fid] && test_path?(files[fid]['path']) } - grouped_tests).any?
          raise ArgumentError, 'Assign every test item to a related test panel'
        end
        layer.fetch('items').each do |item|
          fid = item.fetch('file')
          raise ArgumentError, "Unknown file: #{fid}" unless files.key?(fid)
          covered << fid
          item.fetch('summaries', {}).each do |hid, summary|
            raise ArgumentError, "Invalid summary: #{hid}" unless hunks.dig(hid, 0) == fid && summary.is_a?(String) && !summary.strip.empty?
            seen << hid
          end
        end
      end
    end
    unless seen.sort == hunks.keys.sort && covered.uniq.sort == files.keys.sort
      raise ArgumentError, 'Assign every file and each hunk exactly once (files may span layers)'
    end
    Array(review['findings']).each do |finding|
      raise ArgumentError, 'Finding must anchor to a collected hunk' unless hunks.key?(finding['hunk'])
    end
    ids = []
    Array(review['comments']).each do |comment|
      ids << comment.fetch('id')
      raise ArgumentError, 'Comment ID must be unique and URL-safe' unless comment['id'].match?(/\A[a-zA-Z0-9-]+\z/) && ids.uniq == ids
      raise ArgumentError, 'Invalid Conventional Comments label' unless LABELS.include?(comment['label'])
      raise ArgumentError, 'Comment must explicitly be blocking or non-blocking' unless %w[blocking non-blocking].include?(comment['decoration'])
      raise ArgumentError, 'Comment subject is required' if comment.fetch('subject').strip.empty?
      side = comment.fetch('side')
      raise ArgumentError, 'Comment side must be old or new' unless %w[old new].include?(side)
      hunk = hunks.dig(comment['hunk'], 1)
      raise ArgumentError, 'Comment must anchor to a collected hunk' unless hunk
      first, last = comment.values_at('start', 'end')
      numbers = diff_rows(hunk)['unified'].filter_map { |line| line[side] }
      unless first.is_a?(Integer) && last.is_a?(Integer) && first <= last && (first..last).all? { |line| numbers.include?(line) }
        raise ArgumentError, "Comment range is outside its #{side} hunk: #{comment['id']}"
      end
    end
  end

  def self.extract(report)
    html = File.read(report)
    json = html[/<script\b(?=[^>]*\bid=["']data["'])[^>]*>(.*?)<\/script>/m, 1]
    raise ArgumentError, 'Report has no embedded review data' unless json
    JSON.parse(json)
  end

  def self.render(snapshot:, review:, name:, replace: false, **_unused)
    snapshot = JSON.parse(File.read(snapshot)) if snapshot.is_a?(String)
    review = JSON.parse(File.read(review)) if review.is_a?(String)
    validate(snapshot, review)
    raise ArgumentError, 'Use a short lowercase kebab-case name' unless name.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
    root = snapshot.fetch('repo')
    directory = File.join(root, '.reviews')
    raise ArgumentError, '.reviews must not be a symlink' if File.symlink?(directory)
    raise ArgumentError, '.reviews contains tracked files' unless git(root, 'ls-files', '--', '.reviews').empty?
    if git(root, 'check-ignore', '--', '.reviews/probe.html', allowed: [0, 1]).empty?
      exclude = File.expand_path(git(root, 'rev-parse', '--git-path', 'info/exclude').strip, root)
      FileUtils.mkdir_p(File.dirname(exclude))
      File.open(exclude, 'a') { |file| file.write("\n/.reviews/\n") }
    end
    raise ArgumentError, 'Unable to ignore .reviews' if git(root, 'check-ignore', '--', '.reviews/probe.html', allowed: [0, 1]).empty?
    output = File.join(directory, "#{name}.html")
    raise ArgumentError, 'Report must not be a symlink' if File.symlink?(output)
    output = File.join(directory, "#{name}-#{Time.now.utc.strftime('%Y%m%d-%H%M%S-%6N')}.html") if File.exist?(output) && !replace
    FileUtils.mkdir_p(directory)
    File.write(output, review_html(snapshot, review))
    output
  end

  def self.review_html(snapshot, review)
    validate(snapshot, review)
    # Reviewer calibration is an instruction, not report content. Remove legacy
    # calibration sections from both the visible HTML and its embedded payload.
    review = Marshal.load(Marshal.dump(review))
    review['sections'] = Array(review['sections']).reject { |section| section['title'].to_s.match?(/\Areview standard/i) } if review.key?('sections')
    # Derived rows are render data. They do not alter the captured fingerprint.
    snapshot = Marshal.load(Marshal.dump(snapshot))
    add_sources(snapshot) unless snapshot['mode'] == 'uncommitted' || snapshot['working_tree']
    snapshot['files'].each { |file| file['hunks'].each { |hunk| hunk['rows'] = diff_rows(hunk) } }
    payload = JSON.generate({'snapshot' => snapshot, 'review' => review}).gsub('<', '\\u003c').gsub('>', '\\u003e').gsub('&', '\\u0026')
    licenses = %w[DAISYUI-LICENSE PRISM-LICENSE lucide/LICENSE glightbox/LICENSE].map { |name| File.read(File.join(ASSETS, 'vendor', name)) }.join("\n")
    styles = "/* Third-party licenses\n#{licenses}\n*/\n" + File.read(File.join(ASSETS, 'vendor/daisyui.css')) + "\n" + File.read(File.join(ASSETS, 'vendor/glightbox/glightbox.min.css')) + "\n" + File.read(File.join(ASSETS, 'report.css'))
    prism = LANGUAGES.map { |lang| File.read(File.join(ASSETS, "vendor/prism-#{lang}.min.js")) }.join("\n")
    icons = Dir[File.join(ASSETS, 'vendor/lucide/*.svg')].sort.to_h { |path| [File.basename(path, '.svg'), File.read(path)] }
    scripts = "window.Prism = {manual: true};\nwindow.ReviewIcons = #{JSON.generate(icons)};\n#{prism}\n#{File.read(File.join(ASSETS, 'vendor/glightbox/glightbox.min.js'))}\n#{File.read(File.join(ASSETS, 'review-tools.js'))}\n#{File.read(File.join(ASSETS, 'report.js'))}"
    replacements = {'__STYLES__' => styles, '__SCRIPTS__' => scripts.gsub(%r{</script}i, '<\\/script'), '__REVIEW_DATA__' => payload, '__ICON__' => File.read(File.join(ASSETS, 'icon.svg'))}
    html = File.read(File.join(ASSETS, 'report.html')).gsub(/__STYLES__|__SCRIPTS__|__REVIEW_DATA__|__ICON__/) { |token| replacements.fetch(token) }
    html
  end

  def self.run(argv)
    command = argv.shift
    options = {}
    parser = OptionParser.new do |p|
      p.banner = 'ruby review.rb collect|render|extract [options]'
      %w[repo mode commit base head out snapshot review name report].each { |key| p.on("--#{key} VALUE") { |v| options[key.to_sym] = v } }
      p.on('--max-bytes N', Integer) { |v| options[:max_bytes] = v }
      p.on('--brief', 'Print counts and omissions; full snapshot stays in --out') { options[:brief] = true }
      p.on('--replace', 'Replace the named report when refreshing its layout') { options[:replace] = true }
    end
    parser.parse!(argv)
    case command
    when 'collect'
      brief = options.delete(:brief)
      data = collect(**options)
      File.write(options.fetch(:out), JSON.pretty_generate(data))
      if brief
        omissions = data['files'].select { |f| f['note'].match?(/Excluded|omitted|Binary|non-regular|symlink/i) }
        puts JSON.generate({'fingerprint' => data['fingerprint'], 'file_count' => data['files'].length,
                            'hunk_count' => data['files'].sum { |f| f['hunks'].length },
                            'omitted' => omissions.map { |f| f.slice('path', 'note') }})
      else
        puts JSON.pretty_generate({'fingerprint' => data['fingerprint'], 'files' => data['files'].map { |f| f.slice('id', 'path', 'note').merge('hunks' => f['hunks'].map { |h| h['id'] }) }})
      end
    when 'render'
      puts render(**options)
    when 'extract'
      File.write(options.fetch(:out), JSON.pretty_generate(extract(options.fetch(:report))))
    else
      raise ArgumentError, parser.to_s
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    DynamicReviews.run(ARGV)
  rescue ArgumentError, KeyError, SystemCallError, JSON::ParserError => error
    abort error.message
  end
end
