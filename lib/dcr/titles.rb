# frozen_string_literal: true

require 'tmpdir'
require_relative 'agents'

module DCR
  # A short title for the reviewer's own comment, or one from GitHub, written by an agent from the whole
  # message (a GitHub comment's replies too), so the page lists it the way it lists the agent's
  # comments: by what it asks, in a few words that fit.
  module Titles
    module_function

    LIMIT = 60
    # Where a thread's replies start, after the comment itself.
    REPLIES = '--- Replies ---'
    TIMEOUT = 90
    # A quick model that still tells the point of a comment from its replies (Haiku titled the replies
    # or the kind of comment instead); others run on their own setting.
    FAST = {'claude' => 'sonnet'}.freeze

    # The comment is only something to name: the agent must not answer it, look anything up or ask back.
    def prompt(text) = <<~TEXT
      You name comments. Below, between <comment> tags, is a comment someone wrote on a code change. Do not answer it, do not look anything up and do not ask for more: only name it.
      A part after a line #{REPLIES} holds the replies to it, only as context: the title names the point the comment itself raised, never what a reply said.
      Reply with one line: a title of at most #{LIMIT - 10} characters that says what the comment asks or says, in plain words, like a GitHub issue title. Say its point itself, never what kind of comment it is or who wrote it (not "Comment:", "Reviewer asks", "Question about"). Put code names in backticks. No quotes, no label, no full stop at the end.

      <comment>
      #{text}
      </comment>
    TEXT

    # Asked when the first answer runs over: the same title, shorter, rather than cut mid-thought.
    def shorter(title) = <<~TEXT
      Shorten this title to at most #{LIMIT - 10} characters, keeping its point. Reply with the title only, no quotes, no full stop.

      #{title}
    TEXT

    # The answer's first line, without a "Title:" label, quotes or a full stop.
    def line(answer)
      first = answer.to_s.lines.map(&:strip).reject(&:empty?).first.to_s
      first.sub(/\A(?:\*\*)?title:?(?:\*\*)?\s*/i, '').gsub(/\A["'“”*]+|["'“”*.]+\z/, '').strip
    end

    # That line, cut on a word to fit.
    def clean(answer)
      line = line(answer)
      return line if line.length <= LIMIT
      cut = line.rindex(' ', LIMIT - 1)
      "#{line[0, cut && cut > 20 ? cut : LIMIT - 1]}…"
    end

    # The agent that writes it: the one running the review, else the first CLI installed here.
    def writer(listener)
      ([listener] + Agents::RUNNERS.keys).compact.uniq.find { |slug| Agents.installed?(slug) }
    end

    def make(text, agent:, ask: Agents.method(:ask))
      said = line(ask.call(agent, prompt(text), dir: Dir.tmpdir, model: FAST[agent], timeout: TIMEOUT))
      said = line(ask.call(agent, shorter(said), dir: Dir.tmpdir, model: FAST[agent], timeout: TIMEOUT)) if said.length > LIMIT
      title = clean(said)
      raise ArgumentError, "#{Agents.name(agent)} gave no title" if title.empty?
      title
    end
  end
end
