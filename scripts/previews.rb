#!/usr/bin/env ruby
# frozen_string_literal: true

# Static previews of changed templates (Rails partials and ViewComponents), rendered by
# the reviewed app itself and embedded in the review. Ruby standard library only.
require 'json'
require 'open3'
require 'optparse'
require 'securerandom'
require 'shellwords'
require 'set'
require_relative 'preview_stand_ins'

module ReviewPreviews
  STATUSES = %w[rendered unavailable not_visual].freeze
  SOURCES = %w[lookbook example].freeze
  LIMIT = 8 * 1024 * 1024
  MARKER = '::REVIEW_PREVIEWS::'
  ALWAYS_TAGS = %w[html body].freeze
  module_function

  # Renders every visual preview of the spec with the app's own runner (for example
  # `docker exec -i web bin/rails runner -`), each in a rolled-back transaction.
  def render(spec:, runner:, css: [], stand_ins: ReviewPreviewStandIns::Source.new)
    rendered = run_app(spec, runner)
    # Parse bytes: character indexing into a large UTF-8 string is quadratic.
    stylesheet = parse(css.map { |path| File.binread(path) }.join("\n"))
    seen = {}
    previews = spec.fetch('previews').filter_map do |preview|
      entry = preview.slice('id', 'files', 'title', 'source', 'note', 'width')
      entry['source'] ||= 'example'
      html = rendered.dig(preview['id'], 'html')
      if preview['status'] == 'not_visual'
        entry.merge('status' => 'not_visual')
      elsif (error = rendered.dig(preview['id'], 'error')) || !html
        entry.merge('status' => 'unavailable', 'note' => [preview['note'], error || 'The app returned no HTML.'].compact.join(' — '))
      elsif (twin = seen[duplicate_key(preview, html)])
        # Same template output twice (for example desktop and mobile variants that
        # render alike): show it once and say so instead of two identical frames.
        twin['note'] = [twin['note'], "“#{preview['title'] || preview['id']}” renders the same markup, so it is shown once."].compact.join(' ')
        nil
      else
        body, mocks = ReviewPreviewStandIns.apply(strip_scripts((preview['wrap'] || '%s').sub('%s') { html }), stand_ins, spec.fetch('icon_map', {}))
        body_class = preview['body_class'] || spec['body_class']
        css = fixed_viewport(prune(stylesheet, %(<body class="#{body_class}">#{body})), preview['viewport_height'] || spec['viewport_height'] || 900)
        entry = entry.merge('status' => 'rendered', 'html' => document(body, css, preview, body_class))
        entry['mocks'] = mocks if mocks
        seen[duplicate_key(preview, html)] = entry
      end
    end
    {'previews' => previews}
  end

  # Markup identity ignoring per-instance ids, data and ARIA wiring attributes.
  def duplicate_key(preview, html)
    [Array(preview['files']).sort, preview['wrap'].to_s.gsub(/\sclass="[^"]*"/, ''),
     html.gsub(/\s(?:id|for|data-[\w-]+|aria-[\w-]+)="[^"]*"/, '').gsub(/\s+/, ' ').strip]
  end

  def run_app(spec, runner)
    stdout, stderr, status = Open3.capture3(*Shellwords.split(runner), stdin_data: app_script(spec))
    line = stdout.lines.reverse.find { |text| text.start_with?(MARKER) }
    raise ArgumentError, "The app runner failed: #{(stderr.empty? ? stdout : stderr).lines.last(8).join}" unless status.success? && line
    JSON.parse(line.delete_prefix(MARKER))
  end

  # Executed inside the app. Each preview gets a fresh controller, request and savepoint,
  # so example records never persist and previews cannot affect each other.
  def app_script(spec)
    terminator = "REVIEW_PREVIEW_SPEC_#{SecureRandom.hex(6).upcase}"
    <<~RUBY
      require "json"
      spec = JSON.parse(<<~'#{terminator}')
      #{JSON.generate(spec)}
      #{terminator}
      controller_class = (spec["controller"] || "ApplicationController").constantize
      results = {}
      spec.fetch("previews").each do |preview|
        next if preview["status"] == "not_visual"
        ActiveRecord::Base.transaction(requires_new: true) do
          begin
            Current.reset if defined?(Current) && Current.respond_to?(:reset)
            request = ActionDispatch::TestRequest.create("HTTP_HOST" => spec["host"] || "localhost", "HTTPS" => "on")
            controller = controller_class.new
            controller.set_request!(request)
            controller.set_response!(controller_class.make_response!(request))
            view = controller.view_context
            html = view.instance_eval([spec["setup"], preview.fetch("ruby")].compact.join("\\n"), "(preview \#{preview["id"]})")
            results[preview["id"]] = {"html" => html.to_s}
          rescue Exception => error # ScriptError too: a broken example must not stop the others.
            results[preview["id"]] = {"error" => "\#{error.class}: \#{error.message}"[0, 600]}
          end
          raise ActiveRecord::Rollback
        end
      end
      puts
      puts "#{MARKER}\#{JSON.generate(results)}"
    RUBY
  end

  # A preview frame is sized to its content, so viewport-height units would shrink with it
  # (45vh of a 120px frame). Resolve them against a typical window height instead.
  def fixed_viewport(css, height)
    css.gsub(/(?<![\w-])(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?vh\b/) { "#{($1.to_f * Integer(height) / 100).round(2)}px" }
  end

  def strip_scripts(html)
    html.gsub(%r{<script\b[^>]*>.*?</script\s*>}mi, '').gsub(/<script\b[^>]*>/i, '')
  end

  def document(body, css, preview, body_class = nil)
    width = preview['width'] ? "width:#{Integer(preview['width'])}px" : 'width:auto'
    body_attribute = body_class.to_s.match?(/\A[\w\s-]+\z/) ? %( class="#{body_class}") : ''
    <<~HTML.strip
      <!doctype html><html lang="en"><head><meta charset="utf-8"><style>#{css.gsub('</', '<\\/')}</style><style>html{position:static!important;overflow:visible!important;min-width:0!important;min-height:0!important}html,body{margin:0;background:#{preview['background'] || '#fff'}!important;min-height:0!important}body{padding:16px}.review-preview-root{#{width};max-width:none}.review-preview-root>*{position:relative!important;inset:auto!important}.review-mock-icon::before{content:none!important;display:none!important}.review-mock-icon>svg{width:1em;height:1em;vertical-align:-.125em;display:inline-block}.review-preview-root>*:not([style*="height"]){height:auto!important;min-height:0!important;max-height:none!important}</style></head><body#{body_attribute}><div class="review-preview-root">#{body}</div></body></html>
    HTML
  end

  # A small CSS reader: top-level rules, grouping at-rules (@media, @supports, @layer,
  # @container) and other at-rule blocks, honouring comments and strings.
  def parse(css)
    items, = parse_block(css, 0)
    items
  end

  def parse_block(css, pos)
    items = []
    prelude = +''
    while pos < css.length
      if css[pos, 2] == '/*'
        pos = (css.index('*/', pos + 2) || css.length) + 2
      elsif css[pos] == '"' || css[pos] == "'"
        stop = string_end(css, pos)
        prelude << css[pos...stop]
        pos = stop
      elsif css[pos] == '{'
        head = prelude.strip
        prelude = +''
        if head.match?(/\A@(media|supports|layer|container|document)\b/i)
          children, pos = parse_block(css, pos + 1)
          items << [:group, head, children]
        else
          body, pos = read_body(css, pos + 1)
          items << (head.start_with?('@') ? [:at, head, body] : [:rule, head, body])
        end
      elsif css[pos] == '}'
        return [items, pos + 1]
      elsif css[pos] == ';'
        prelude = +''
        pos += 1
      else
        prelude << css[pos]
        pos += 1
      end
    end
    [items, pos]
  end

  def read_body(css, pos)
    start = pos
    depth = 1
    while pos < css.length
      if css[pos, 2] == '/*' then pos = (css.index('*/', pos + 2) || css.length) + 2; next end
      if css[pos] == '"' || css[pos] == "'" then pos = string_end(css, pos); next end
      depth += 1 if css[pos] == '{'
      depth -= 1 if css[pos] == '}'
      return [css[start...pos], pos + 1] if depth.zero?
      pos += 1
    end
    [css[start..], pos]
  end

  def string_end(css, pos)
    quote = css[pos]
    pos += 1
    pos += css[pos] == '\\' ? 2 : 1 while pos < css.length && css[pos] != quote
    pos + 1
  end

  # Keeps only selectors whose classes, ids and element names all occur in the preview,
  # plus :root/html/body rules and the keyframes they use. Fonts are never embedded.
  def prune(items, html)
    vocabulary = {
      classes: html.scan(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i).flatten.compact.flat_map(&:split).to_set,
      ids: html.scan(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i).flatten.compact.to_set,
      tags: (html.scan(/<([a-zA-Z][\w-]*)/).flatten.map(&:downcase) + ALWAYS_TAGS).to_set
    }
    kept = prune_items(items, vocabulary)
    used = kept.join
    kept += items.select { |kind, head, _| kind == :at && head.match?(/\A@(-webkit-)?keyframes\s+([\w-]+)/i) && used.include?(head.split.last) }.map { |_, head, body| "#{head}{#{body}}" }
    kept.join("\n").force_encoding('UTF-8').scrub
  end

  def prune_items(items, vocabulary)
    items.filter_map do |kind, head, body|
      case kind
      when :rule
        selectors = split_selectors(head).select { |selector| match?(selector, vocabulary) }
        "#{selectors.join(',')}{#{body}}" if selectors.any?
      when :group
        next if head.match?(/\A@media\s+print\b/i)
        children = prune_items(body, vocabulary)
        "#{head}{#{children.join}}" if children.any?
      when :at
        "#{head}{#{body}}" if head.match?(/\A@property\b/i)
      end
    end
  end

  def split_selectors(head)
    parts = []
    depth = 0
    current = +''
    head.each_char do |char|
      depth += 1 if '(['.include?(char)
      depth -= 1 if ')]'.include?(char)
      if char == ',' && depth.zero? then parts << current.strip; current = +'' else current << char end
    end
    parts << current.strip
    parts.reject(&:empty?)
  end

  def match?(selector, vocabulary)
    selector = selector.dup.force_encoding('UTF-8').scrub
    # :is()/:where() match when one of their options does; :not()/:has() are ignored.
    options = selector.scan(/:(?:is|where|matches|-webkit-any)\(((?:[^()]|\([^()]*\))*)\)/).flatten
    return false unless options.all? { |list| split_selectors(list).any? { |option| match?(option, vocabulary) } }
    simple = selector.gsub(/::?[\w-]+\((?:[^()]|\([^()]*\))*\)/, ' ').gsub(/\[[^\]]*\]/, ' ').gsub(/::?[\w-]+/, ' ')
    classes = simple.scan(/\.((?:\\.|[\w-])+)/).flatten.map { |name| name.gsub(/\\(.)/, '\1') }
    ids = simple.scan(/#((?:\\.|[\w-])+)/).flatten
    tags = simple.gsub(/[.#](?:\\.|[\w-])+/, ' ').scan(/(?:\A|[\s>+~])([a-zA-Z][\w-]*)/).flatten.map(&:downcase)
    classes.all? { |name| vocabulary[:classes].include?(name) } &&
      ids.all? { |name| vocabulary[:ids].include?(name) } &&
      tags.all? { |name| vocabulary[:tags].include?(name) }
  end

  # Review-time validation: previews name captured files, carry known statuses and stay
  # inside a size budget. Rendered HTML is shown only in sandboxed, script-less frames.
  # Changed templates a preview set must account for: HTML ERB views and partials, and
  # ViewComponent classes. Deleted files have nothing left to render.
  def template_paths(snapshot)
    snapshot.fetch('files').reject { |file| file['patch'].to_s.match?(/^deleted file mode /) }.map { |file| file['path'] }
            .select { |path| path.end_with?('.html.erb') || path.match?(%r{\Aapp/components/.+_component\.rb\z}) }
  end

  def validate(previews, snapshot)
    return if previews.nil?
    raise ArgumentError, 'previews must be a list' unless previews.is_a?(Array)
    paths = snapshot.fetch('files').map { |file| file['path'] }.to_set
    covered = previews.flat_map { |preview| Array(preview['files']) }.to_set
    missing = template_paths(snapshot).reject { |path| covered.include?(path) }
    raise ArgumentError, "Every changed template needs a preview entry (rendered, unavailable or not_visual with a reason). Missing: #{missing.join(', ')}" if missing.any?
    previews.each do |preview|
      raise ArgumentError, "Preview #{preview['id']} marked not_visual needs a note explaining why" if preview['status'] == 'not_visual' && preview['note'].to_s.strip.empty?
    end
    ids = Set.new
    total = 0
    previews.each do |preview|
      id = preview['id'].to_s
      raise ArgumentError, "Preview id must be letters, digits and hyphens: #{id.inspect}" unless id.match?(/\A[a-z0-9-]{1,80}\z/)
      raise ArgumentError, "Duplicate preview id #{id}" unless ids.add?(id)
      files = Array(preview['files'])
      raise ArgumentError, "Preview #{id} must name captured files" if files.empty? || !files.all? { |path| paths.include?(path) }
      raise ArgumentError, "Preview #{id} has an unknown status" unless STATUSES.include?(preview['status'])
      raise ArgumentError, "Preview #{id} has an unknown source" unless SOURCES.include?(preview['source'] || 'example')
      html = preview['html']
      raise ArgumentError, "Preview #{id} must include HTML only when rendered" unless (preview['status'] == 'rendered') == html.is_a?(String)
      raise ArgumentError, "Preview #{id} contains a script" if html&.match?(/<script\b/i)
      mocks = preview['mocks']
      unless mocks.nil? || (mocks.is_a?(Hash) && mocks.all? { |key, value| %w[credits unmatched].include?(key) ? value.is_a?(Array) && value.all?(String) : value.is_a?(Integer) })
        raise ArgumentError, "Preview #{id} has malformed stand-in details"
      end
      total += html.to_s.bytesize
    end
    raise ArgumentError, 'Previews exceed the 8 MiB report budget' if total > LIMIT
  end
end

if $PROGRAM_NAME == __FILE__
  command = ARGV.shift
  options = {css: []}
  OptionParser.new do |parser|
    parser.banner = 'Usage: ruby previews.rb render --spec <spec.json> --runner "<app runner reading Ruby from stdin>" [--css <file>]... --out <previews.json>'
    parser.on('--spec PATH') { |value| options[:spec] = value }
    parser.on('--runner COMMAND') { |value| options[:runner] = value }
    parser.on('--css PATH') { |value| options[:css] << value }
    parser.on('--out PATH') { |value| options[:out] = value }
    parser.on('--offline', 'Use cached or placeholder icons and images; fetch nothing') { options[:offline] = true }
  end.parse!
  abort 'Usage: ruby previews.rb render --spec <spec.json> --runner "<command>" [--css <file>]... [--offline] --out <previews.json>' unless command == 'render' && options.values_at(:spec, :runner, :out).all?
  begin
    result = ReviewPreviews.render(spec: JSON.parse(File.read(options[:spec])), runner: options[:runner], css: options[:css],
                                   stand_ins: ReviewPreviewStandIns::Source.new(network: !options[:offline]))
    File.write(options[:out], JSON.generate(result))
    unmatched = result['previews'].flat_map { |preview| preview.dig('mocks', 'unmatched') || [] }.uniq
    puts "Icons without a Lucide match (add spec icon_map entries by meaning, then re-render): #{unmatched.join(', ')}" if unmatched.any?
    result['previews'].each do |preview|
      stand_ins = preview['mocks']&.reject { |key, _| %w[credits unmatched].include?(key) }&.map { |key, count| "#{count} #{key.tr('_', ' ')}" }&.join(', ')
      puts "#{preview['status'].ljust(11)} #{preview['id']} #{preview['html'] ? "#{preview['html'].bytesize / 1024} KiB" : preview['note']}#{stand_ins ? " · stand-ins: #{stand_ins}" : ''}"
    end
  rescue ArgumentError, KeyError, SystemCallError, JSON::ParserError => error
    abort error.message
  end
end
