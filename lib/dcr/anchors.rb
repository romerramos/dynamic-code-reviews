# frozen_string_literal: true

require 'open3'
require 'tmpdir'

module DCR
  # Where a comment's lines are once the code under a review has changed. A comment keeps its place
  # when its lines are still in the file, wherever they moved to; otherwise it is kept as outdated,
  # with the lines it was written on, as GitHub does.
  class Anchors
    ANCHOR = %w[hunk side start end].freeze
    KEPT_LINES = 60 # of the code an outdated comment was written on

    # old, new: the snapshots before and after. mapping: ReviewSeries.compare's unchanged ranges.
    # revision: the one the comments were written on, said on those that become outdated.
    def initialize(old, new, mapping, revision)
      @old = old
      @new = new
      @mapping = mapping
      @revision = revision
      @new_files = new['files'].to_h { |file| [file['path'], file] }
      @maps = {}
    end

    # The comment on the new snapshot. full: the comment may sit on a line outside every changed
    # range, as the reader's own can; one the review wrote needs a range.
    def carry(comment, full: false)
      return comment if comment['general'] || !comment['hunk']
      file, lines = written_on(comment)
      return outdated(comment, file, lines) unless file && lines
      same = @mapping[comment['hunk']]
      if same
        offset = same.fetch("#{comment['side']}_offset")
        return comment.merge('hunk' => same['hunk'], 'start' => comment['start'] + offset, 'end' => comment['end'] + offset)
      end
      target = @new_files[file['path']]
      first = target && moved_to(file, target, comment, lines)
      return outdated(comment, file, lines) unless first
      last = first + lines.length - 1
      range = target['hunks'].find { |hunk| ((first..last).to_a - numbers(hunk, comment['side'])).empty? }
      return comment.merge('hunk' => range['id'], 'start' => first, 'end' => last) if range
      return comment.merge('hunk' => "full:#{target['id']}", 'start' => first, 'end' => last) if full && target['source']
      outdated(comment, file, lines)
    end

    private

    # [file, the text of the lines] a comment was written on, in the old snapshot.
    def written_on(comment)
      side, first, last = comment.values_at('side', 'start', 'end')
      return unless %w[old new].include?(side) && first.is_a?(Integer) && last.is_a?(Integer) && first.between?(1, last)
      file = @old['files'].find { |candidate| comment['hunk'] == "full:#{candidate['id']}" }
      if file
        source = file.dig('source', side)&.lines(chomp: true)
        return [file, source && last <= source.length ? source[(first - 1)..(last - 1)] : nil]
      end
      file = @old['files'].find { |candidate| candidate['hunks'].any? { |hunk| hunk['id'] == comment['hunk'] } }
      return unless file
      rows = rows(file['hunks'].find { |hunk| hunk['id'] == comment['hunk'] }).select { |row| row[side]&.between?(first, last) }
      [file, rows.length == last - first + 1 ? rows.map { |row| row['text'] } : nil]
    end

    # The first line the comment's lines start on in the new file, when every one of them is still
    # there, together and unchanged. The base of a series is fixed, so its side never moves.
    def moved_to(file, target, comment, lines)
      side, first = comment.values_at('side', 'start')
      after = target.dig('source', side)&.lines(chomp: true)
      return unless after
      at = side == 'old' ? first : line_map(file, target)&.call(first)
      at if at && after[(at - 1), lines.length] == lines
    end

    # Old line number to new one, or nil for a line that changed or went: Git compares the two
    # captured versions of the file.
    def line_map(file, target)
      @maps.fetch(file['path']) do
        before, after = file.dig('source', 'new'), target.dig('source', 'new')
        @maps[file['path']] = before && after && (before == after ? ->(line) { line } : changes(before, after))
      end
    end

    def changes(before, after)
      diff = Dir.mktmpdir('dcr-lines-') do |directory|
        paths = {'a' => before, 'b' => after}.map { |name, text| File.join(directory, name).tap { |path| File.write(path, text) } }
        output, _error, status = Open3.capture3('git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--', *paths)
        return nil unless [0, 1].include?(status.exitstatus)
        output
      end
      changed = diff.scan(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/).map { |start, removed, added| [start.to_i, (removed || '1').to_i, (added || '1').to_i] }
      lambda do |line|
        shift = 0
        changed.each do |start, removed, added|
          # With no context, an insertion names the line it follows.
          break if line < (removed.zero? ? start + 1 : start)
          return nil if line < start + removed
          shift += added - removed
        end
        line + shift
      end
    end

    def numbers(hunk, side) = rows(hunk).filter_map { |row| row[side] }

    # A hunk's lines with their real numbers; a snapshot read back from a saved page has them already.
    def rows(hunk)
      return hunk.dig('rows', 'unified') if hunk.dig('rows', 'unified')
      old_line, new_line = hunk.values_at('old_start', 'new_start')
      hunk['patch'].lines.drop(1).filter_map do |raw|
        next unless [' ', '+', '-'].include?(raw[0])
        row = {'text' => raw[1..].delete_suffix("\n")}
        (row['old'] = old_line; old_line += 1) unless raw[0] == '+'
        (row['new'] = new_line; new_line += 1) unless raw[0] == '-'
        row
      end
    end

    # No place in the new code: it becomes a general comment that says where it was.
    def outdated(comment, file, lines)
      was = comment.slice('side', 'start', 'end').merge('path' => file && file['path'], 'lines' => Array(lines).first(KEPT_LINES), 'revision' => @revision).compact
      comment.reject { |name, _| ANCHOR.include?(name) }.merge('general' => true, 'outdated' => was)
    end
  end
end
