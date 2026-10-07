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

    # Returns {'html' => document, 'mocks' => counts or nil}. Raises ArgumentError, with advice, when the
    # submission is not usable HTML.
    def build(raw, title: nil)
      fragment = unwrap(raw)
      mocks = Hash.new(0)
      body = sanitize(fragment)
      body = icons_in(body, mocks)
      body = images_in(body, mocks)
      html = ReviewPreviews.document(body, BASE_CSS, {})
      {'html' => html, 'mocks' => mocks.empty? ? nil : mocks.to_h, 'title' => title.to_s.strip[0, 120]}
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

    def icons_in(html, mocks)
      html.gsub(%r{<(i|span)\b([^>]*?)\bdata-icon="([a-z0-9-]{1,60})"([^>]*)>\s*</\1>}i) do
        tag, before, name, after = Regexp.last_match.captures
        path = File.join(ICON_DIR, "#{name}.svg")
        svg = File.file?(path) ? ReviewPreviewStandIns.clean_svg(File.read(path)) : nil
        mocks[svg ? 'icons' : 'placeholders'] += 1
        %(<#{tag}#{before}#{after} class="review-mock-icon">#{svg || ReviewPreviewStandIns::PLACEHOLDER_ICON}</#{tag}>)
      end
    end

    def images_in(html, mocks)
      html.gsub(/<img\b[^>]*>/i) do |tag|
        next tag if tag[/\ssrc="([^"]*)"/i, 1].to_s.start_with?('data:image/')
        width = tag[/\swidth="(\d{1,4})"/i, 1] || '120'
        height = tag[/\sheight="(\d{1,4})"/i, 1] || width
        mocks['image_placeholders'] += 1
        uri = ReviewPreviewStandIns.placeholder_image(width, height)
        tag.sub(/\ssrc\s*=\s*("[^"]*"|'[^']*')/i, '').sub(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/i, '').sub('<img', %(<img src="#{uri}" data-review-mock="image"))
      end
    end
  end
end
