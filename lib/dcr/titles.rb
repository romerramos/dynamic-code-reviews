# frozen_string_literal: true

require 'tmpdir'
require_relative 'agents'

module DCR
  # A short title for the reviewer's own comment, written by an agent from the whole message, so the
  # page lists it the way it lists the agent's comments: by what it asks, in a few words that fit.
  module Titles
    module_function

    LIMIT = 60
    TIMEOUT = 90
    # The quickest model a CLI offers, for a few words; others run on their own setting.
    FAST = {'claude' => 'haiku'}.freeze

    # The comment is only something to name: the agent must not answer it, look anything up or ask back.
    def prompt(text) = <<~TEXT
      You name comments. Below, between <comment> tags, is a comment a reviewer wrote on a code change. Do not answer it, do not look anything up and do not ask for more: only name it.
      Reply with one line: a title of at most #{LIMIT} characters that says what the comment asks or says, in plain words, like a GitHub issue title. Put code names in backticks. No quotes, no label, no full stop at the end.

      <comment>
      #{text}
      </comment>
    TEXT

    # The answer's first line, without a "Title:" label, quotes or a full stop, cut on a word to fit.
    def clean(answer)
      line = answer.to_s.lines.map(&:strip).reject(&:empty?).first.to_s
      line = line.sub(/\A(?:\*\*)?title:?(?:\*\*)?\s*/i, '').gsub(/\A["'“”*]+|["'“”*.]+\z/, '').strip
      return line if line.length <= LIMIT
      cut = line.rindex(' ', LIMIT - 1)
      "#{line[0, cut && cut > 20 ? cut : LIMIT - 1]}…"
    end

    # The agent that writes it: the one running the review, else the first CLI installed here.
    def writer(listener)
      ([listener] + Agents::RUNNERS.keys).compact.uniq.find { |slug| Agents.installed?(slug) }
    end

    def make(text, agent:, ask: Agents.method(:ask))
      title = clean(ask.call(agent, prompt(text), dir: Dir.tmpdir, model: FAST[agent], timeout: TIMEOUT))
      raise ArgumentError, "#{Agents.name(agent)} gave no title" if title.empty?
      title
    end
  end
end
