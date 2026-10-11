# frozen_string_literal: true

require 'set'
require 'strscan'

module DCR
  # daisyUI's stylesheet is some 7,400 rules, most of them for screen widths and components the app
  # never draws. A browser tests every element of a page against every one of them, which makes a
  # long file slow to open: half a second for a thousand lines of diff. So a page carries only the
  # rules whose classes the app's own files name.
  module Stylesheet
    module_function

    GROUPS = /\A@(?:layer|media|supports|container|scope|starting-style)\b/
    WORD = /[A-Za-z0-9_-]+/

    # Every word in the given files: the class names the app can put on an element, and more.
    def words(paths) = paths.flat_map { |path| File.read(path).scan(WORD) }.to_set

    # The stylesheet without the rules for classes that are not among the words. A rule stays when
    # one of its selectors can match; of a list of selectors, those that can.
    def prune(css, words) = block(StringScanner.new(css), words)

    # A class is known when the files name it, or build it: `badge-${tone}` leaves the word `badge-`.
    def known?(name, words)
      return true if words.include?(name)

      (0...name.length).any? { |index| name[index] == '-' && words.include?(name[0..index]) }
    end

    # What a block holds up to the brace that closes it, without the rules that go.
    def block(scanner, words)
      out = +''
      start = scanner.pos
      depth = 0
      while scanner.scan_until(%r{[{};()"']|/\*})
        case scanner.matched
        when '/*' then scanner.scan_until(%r{\*/})
        when '"', "'" then scanner.scan_until(/(?<!\\)#{scanner.matched}/)
        when '(' then depth += 1
        when ')' then depth -= 1
        when ';'
          next unless depth.zero?

          out << scanner.string.byteslice(start...scanner.pos)
          start = scanner.pos
        when '}'
          next unless depth.zero?

          return out << scanner.string.byteslice(start...scanner.pos - 1)
        when '{'
          next unless depth.zero?

          out << rule(scanner.string.byteslice(start...scanner.pos - 1), scanner, words)
          start = scanner.pos
        end
      end
      out << scanner.string.byteslice(start..)
    end

    def rule(prelude, scanner, words)
      name = prelude.gsub(%r{/\*.*?\*/}m, '').strip
      if name.start_with?('@')
        from = scanner.pos
        inner = block(scanner, words)
        return "#{prelude}{#{scanner.string.byteslice(from...scanner.pos - 1)}}" unless name.match?(GROUPS) # keyframes and the like: as written

        return inner.strip.empty? ? '' : "#{prelude}{#{inner}}"
      end
      kept = selectors(name).select { |selector| possible?(selector, words) }
      inner = block(scanner, words)
      kept.empty? ? '' : "#{kept.join(',')}{#{inner}}"
    end

    PIECE = /\\.|"[^"]*"|'[^']*'|[()\[\],]|[^\\"'()\[\],]+/m

    # A selector list, split at the commas that are not inside brackets.
    def selectors(list)
      depth = 0
      list.scan(PIECE).each_with_object([+'']) do |piece, found|
        depth += 1 if ['(', '['].include?(piece)
        depth -= 1 if [')', ']'].include?(piece)
        piece == ',' && depth.zero? ? found << +'' : found.last << piece
      end.map(&:strip).reject(&:empty?)
    end

    # Whether a selector can match anything the app draws: the classes it names outright are all
    # known, and each :is() or :where() has a choice that can. A class inside :not() or :has() does
    # not count: it is one the element must not have, or one that belongs to something else.
    def possible?(selector, words)
      depth = 0
      bare = +''
      choices = []
      open = nil
      selector.scan(PIECE).each do |piece|
        opening = ['(', '['].include?(piece)
        depth -= 1 if [')', ']'].include?(piece)
        if depth.zero?
          if opening then open = piece == '(' && bare.match?(/:(?:is|where)\z/) ? +'' : nil
          elsif open then choices << open and open = nil
          elsif ![')', ']'].include?(piece) then bare << piece
          end
        elsif open then open << piece
        end
        depth += 1 if opening
      end
      named = bare.scan(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/).flatten.map do |name|
        name.gsub(/\\([0-9a-fA-F]{1,6}) ?/) { [Regexp.last_match(1).hex].pack('U') }.gsub(/\\(.)/, '\1')
      end
      named.all? { |name| known?(name, words) } && choices.all? { |list| selectors(list).any? { |choice| possible?(choice, words) } }
    end
  end
end
