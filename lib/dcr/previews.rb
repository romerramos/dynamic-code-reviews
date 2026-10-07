# frozen_string_literal: true

require 'base64'
require_relative '../../scripts/previews'
require_relative '../../scripts/preview_stand_ins'

module DCR
  # Turns the HTML an agent writes for a template into a safe preview document. The agent is asked to
  # send only HTML; this refuses anything else with a message it can act on, removes whatever could run
  # or fetch, and replaces icons and images with stand-ins that work offline.
  module Previews
    module_function

    LIMIT = 600 * 1024
    ICON_DIR = File.expand_path('../../assets/vendor/lucide', __dir__)
    BLOCKED_TAGS = %w[script iframe frame frameset object embed applet link base meta audio video source track].freeze
    BASE_CSS = 'body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1f2430}img,svg{max-width:100%}.review-mock-icon{display:inline-flex}'
    PATH = %r{\A(?!.*\.\.)(?!/)[A-Za-z0-9_./@+-]{1,300}\z}

    # Lucide names the review ships with, for `<i data-icon="name"></i>`.
    def icons = Dir[File.join(ICON_DIR, '*.svg')].map { |path| File.basename(path, '.svg') }.sort

    def valid_path?(path) = path.to_s.match?(PATH) && path.to_s.include?('.')

    CSS_LIMIT = 8 * 1024 * 1024
    # Icon fonts are never translated by name: the agent chooses each Lucide icon itself.
    NO_ICONS = Object.new.tap { |source| def source.icon(*) = nil }

    # Returns {'html' => document, 'mocks' => counts or nil}. Raises ArgumentError, with advice, when the
    # submission is not usable HTML.
    # css: the project's compiled stylesheets; only the rules the markup uses are kept. page_class: the
    # classes of the page around it, which rules like `.dark .card` depend on.
    # Stand-ins are the agent's choices, embedded as given: `<i data-icon="name">` is the Lucide icon the
    # agent picked (bundled, or fetched from Lucide once and cached); image_map ({src => {'path',
    # 'credit'}}) points each image at a photo the agent saved. Nothing is mapped by name here: an icon-font
    # element left in the markup, an unknown icon name or an unmapped image becomes a placeholder and is
    # listed in mocks, so the agent can choose and submit again.
    def build(raw, title: nil, css: nil, page_class: nil, image_map: {}, base_dir: Dir.pwd, icons: nil)
      fragment = unwrap(raw)
      mocks = Hash.new(0)
      body = sanitize(fragment)
      unknown = []
      body = icons_in(body, mocks, icons || ReviewPreviewStandIns::Source.new, unknown)
      mocks['unknown_icons'] = unknown.uniq if unknown.any?
      body, found = ReviewPreviewStandIns.apply(body, NO_ICONS, {}, image_map, base_dir: base_dir)
      mocks.merge!(found) { |_, ours, theirs| ours + theirs } if found
      page_class = page_class.to_s.split.grep(/\A[\w-]+\z/).uniq.join(' ')
      styles = BASE_CSS
      unless css.to_s.empty?
        raise ArgumentError, "The stylesheets are over #{CSS_LIMIT / 1024 / 1024} MiB." if css.bytesize > CSS_LIMIT
        kept = ReviewPreviews.prune(ReviewPreviews.parse(css.dup.force_encoding(Encoding::BINARY)), %(<body class="#{page_class}">#{body}))
        styles = "#{styles}\n#{clean_css(ReviewPreviews.fixed_viewport(kept, 900))}"
      end
      html = ReviewPreviews.document(body, styles, {}, page_class.empty? ? nil : page_class)
      raise ArgumentError, "The preview is over #{LIMIT * 2 / 1024} KiB with its styles and images. Use smaller images or fewer rules." if html.bytesize > LIMIT * 2
      {'html' => html, 'mocks' => mocks.empty? ? nil : {}.merge(mocks), 'title' => title.to_s.strip[0, 120]}
    end

    # A fragment, a body, or a whole document: keep the markup and its styles, nothing around it.
    def unwrap(raw)
      text = raw.to_s.delete_prefix("﻿").strip
      raise ArgumentError, 'The preview is empty. Submit the HTML of the template.' if text.empty?
      raise ArgumentError, "The preview is over #{LIMIT / 1024} KiB. Simplify it." if text.bytesize > LIMIT
      text = text.sub(/\A```[a-z]*\s*\n/i, '').sub(/\n```\s*\z/, '').strip
      if text.match?(/<body\b/i)
        styles = text[/<head\b.*?<\/head>/mi].to_s.scan(%r{<style\b.*?</style>}mi).join("\n")
        text = "#{styles}\n#{text[%r{<body\b[^>]*>(.*)</body>}mi, 1] || text.sub(/\A.*?<body\b[^>]*>/mi, '')}".strip
      end
      text = text.sub(/\A<!doctype[^>]*>\s*/i, '')
      unless text.start_with?('<') && text.end_with?('>') && text.match?(/<[a-z][^>]*>/i)
        raise ArgumentError, 'Submit only HTML: the first and last characters must be tags. Remove headings, explanations and Markdown fences outside the HTML; the page uses your output directly.'
      end
      text
    end

    def sanitize(html)
      out = ReviewPreviews.strip_scripts(html)
      BLOCKED_TAGS.each do |tag|
        out = out.gsub(%r{<#{tag}\b[^>]*>.*?</#{tag}\s*>}mi, '').gsub(/<#{tag}\b[^>]*>/i, '')
      end
      out = out.gsub(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
      out = out.gsub(/\s(href|src|action|formaction|xlink:href)\s*=\s*("|')\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/i, ' \1="#"')
      out = out.gsub(%r{<style\b[^>]*>.*?</style\s*>}mi) { |block| clean_css(block) }
      out.gsub(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i) { |attribute| clean_css(attribute) }
    end

    # No @import, no remote url(): a preview never reaches the network.
    def clean_css(css)
      css.gsub(/@import[^;]*;?/i, '').gsub(%r{url\(\s*["']?\s*(?:https?:)?//[^)]*\)}i, 'none').gsub(/expression\s*\(|behavior\s*:|-moz-binding\s*:/i, 'x')
    end

    # `<i data-icon="name">`, with any classes of its own: the bundled Lucide icon, or Lucide's icon of that
    # name fetched once. An unknown name becomes a placeholder and is listed for the agent.
    def icons_in(html, mocks, source, unknown = [])
      html.gsub(%r{<(i|span)\b([^>]*?)\bdata-icon="([a-z0-9-]{1,60})"([^>]*)>\s*</\1>}i) do
        tag, before, name, after = Regexp.last_match.captures
        bundled = File.join(ICON_DIR, "#{name}.svg")
        svg = File.file?(bundled) ? ReviewPreviewStandIns.clean_svg(File.read(bundled)) : source.icon(name, name)
        mocks[svg ? 'icons' : 'placeholders'] += 1
        unknown << name unless svg
        attributes = "#{before}#{after}"
        classes = attributes[/\sclass="([^"]*)"/i, 1]
        attributes = attributes.sub(/\sclass="[^"]*"/i, '')
        %(<#{tag}#{attributes} class="#{[classes, 'review-mock-icon'].compact.join(' ')}">#{svg || ReviewPreviewStandIns::PLACEHOLDER_ICON}</#{tag}>)
      end
    end
  end
end
