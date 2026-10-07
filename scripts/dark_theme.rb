# frozen_string_literal: true

# Derives the report's dark theme from its light stylesheet, so the two cannot drift apart.
# Every hex colour is remapped by the role of the property that uses it (surface, text or
# border) and emitted under html[data-theme="dark"]. Variable-driven colours are not
# touched here; the stylesheet sets those variables for dark itself. Ruby stdlib only.
module ReviewDarkTheme
  module_function

  HEX = /#(?:\h{8}|\h{6}|\h{4}|\h{3})(?!\h)/
  NAMED = {'white' => '#ffffff', 'black' => '#000000'}.freeze
  COLOR = /#{HEX}|\b(?:white|black)\b/
  PREFIX = 'html[data-theme="dark"]'

  def css(source)
    "\n/* Dark theme, derived from the light rules above. */\n#{block(source)}"
  end

  # --- stylesheet walking ---------------------------------------------------------------

  def block(source)
    out = +''
    each_rule(source) do |prelude, body|
      if prelude.start_with?('@media', '@supports')
        inner = block(body)
        out << "#{prelude}{#{inner}}\n" unless inner.empty?
      elsif !prelude.start_with?('@')
        declarations = changed_declarations(body)
        next if declarations.empty?
        selectors = split_top(prelude, ',').map { |selector| prefixed(selector.strip) }
        out << "#{selectors.join(',')}{#{declarations.join(';')}}\n"
      end
    end
    out
  end

  def each_rule(source)
    index = 0
    while index < source.length
      open = source.index('{', index) or break
      prelude = source[index...open].gsub(%r{/\*.*?\*/}m, '').strip
      depth = 1
      cursor = open + 1
      quote = nil
      while cursor < source.length && depth.positive?
        char = source[cursor]
        if quote then quote = nil if char == quote && source[cursor - 1] != '\\'
        elsif char == '"' || char == "'" then quote = char
        elsif char == '{' then depth += 1
        elsif char == '}' then depth -= 1
        end
        cursor += 1
      end
      yield prelude, source[(open + 1)...(cursor - 1)]
      index = cursor
    end
  end

  # Splits on a separator outside parentheses, brackets and quotes.
  def split_top(text, separator)
    parts = []
    current = +''
    depth = 0
    quote = nil
    text.each_char do |char|
      if quote then quote = nil if char == quote
      elsif char == '"' || char == "'" then quote = char
      elsif '([' .include?(char) then depth += 1
      elsif ')]'.include?(char) then depth -= 1
      elsif char == separator && depth.zero?
        parts << current
        current = +''
        next
      end
      current << char
    end
    parts << current
  end

  def prefixed(selector)
    return PREFIX if selector == ':root' || selector == 'html'
    return selector.sub(/\A(?::root|html)/, PREFIX) if selector.match?(/\A(?::root|html)[\[.:]/)
    "#{PREFIX} #{selector}"
  end

  # --- colour mapping ---------------------------------------------------------------------

  def changed_declarations(body)
    split_top(body, ';').filter_map do |declaration|
      property, value = declaration.split(':', 2)
      next unless value
      property = property.strip.downcase
      role = role_of(property)
      next unless role
      mapped = value.gsub(COLOR) { |color| remap(color, role) }
      "#{property}:#{mapped.strip}" unless mapped == value
    end
  end

  def role_of(property)
    return :surface if property.start_with?('background')
    return :text if %w[color fill stroke caret-color text-decoration-color].include?(property)
    return :border if property.start_with?('border', 'outline') || property == 'column-rule'
    nil
  end

  def remap(color, role)
    color, alpha = split_alpha(color)
    red, green, blue = rgb(color)
    hue, saturation, lightness = to_hsl(red, green, blue)
    case role
    when :surface
      # Strong fills (primary buttons, badges) already work on dark; only pale and neutral surfaces flip.
      return color + alpha if saturation > 0.3 && lightness.between?(0.25, 0.65) || lightness < 0.35
      lightness = 0.10 + (1 - lightness) * 0.14
      saturation *= 0.7
    when :text
      # White text sits on strong fills that stay as they are.
      return color + alpha if lightness > 0.97
      lightness = (1 - lightness).clamp(0.58, 0.94)
    when :border
      lightness = 0.17 + (1 - lightness) * 0.28
      saturation *= 0.6
    end
    hex(*from_hsl(hue, saturation, lightness)) + alpha
  end

  # "#rrggbbaa" and "#rgba" carry an opacity that must survive the colour change.
  def split_alpha(color)
    digits = color.delete('#')
    return [color, ''] unless color.start_with?('#')
    return [color, ''] unless [4, 8].include?(digits.length)
    digits.length == 4 ? ["##{digits[0, 3]}", digits[3] * 2] : ["##{digits[0, 6]}", digits[6, 2]]
  end

  def rgb(color)
    color = NAMED.fetch(color, color).delete('#')
    color = color.chars.map { |digit| digit * 2 }.join if color.length == 3
    color.scan(/../).map { |pair| pair.to_i(16) / 255.0 }
  end

  def hex(red, green, blue) = format('#%02x%02x%02x', *[red, green, blue].map { |channel| (channel * 255).round.clamp(0, 255) })

  def to_hsl(red, green, blue)
    high, low = [red, green, blue].max, [red, green, blue].min
    lightness = (high + low) / 2
    return [0.0, 0.0, lightness] if high == low
    spread = high - low
    saturation = lightness > 0.5 ? spread / (2 - high - low) : spread / (high + low)
    hue = case high
          when red then (green - blue) / spread + (green < blue ? 6 : 0)
          when green then (blue - red) / spread + 2
          else (red - green) / spread + 4
          end
    [hue / 6, saturation, lightness]
  end

  def from_hsl(hue, saturation, lightness)
    return [lightness, lightness, lightness] if saturation.zero?
    q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
    p = 2 * lightness - q
    [hue + 1.0 / 3, hue, hue - 1.0 / 3].map do |t|
      t += 1 if t.negative?
      t -= 1 if t > 1
      if t < 1.0 / 6 then p + (q - p) * 6 * t
      elsif t < 0.5 then q
      elsif t < 2.0 / 3 then p + (q - p) * (2.0 / 3 - t) * 6
      else p
      end
    end
  end
end
