# frozen_string_literal: true

require 'digest'
require_relative 'agents'

module DCR
  # A review comment rewritten the way its reviewer talks, before it goes to GitHub under their
  # name. An agent on this computer writes it from the comment, its code and what was said about it;
  # the reviewer reads it, changes it and sends it themselves. Nothing here posts anything.
  module GitHubDraft
    module_function

    TIMEOUT = 120
    LIMIT = 60_000 # of material handed to the agent
    # How the reviewer writes, until they say otherwise in the preview (Settings#github_voice).
    DEFAULT_VOICE = <<~TEXT.strip
      - I start with the label my team uses, in bold, then the point: `**question:**`, `**suggestion (non-blocking):**`, `**nitpick:**`, `**thought:**`, `**issue (blocking):**`. Keep the review comment's own label and whether it blocks.
      - Short. Most of my comments are one or two sentences: the one thing I noticed, or the question. I leave out what the author already knows and the side details; if they want more, they ask.
      - I think in ideas, not paragraphs. A second idea (usually what we could do about it) goes on its own line after a blank line, so the comment can be scanned at a glance. Never a block of text, and three short ideas at most.
      - Conversational, in the first person, like a chat message to a teammate I like. Plain words.
      - Never overconfident. Even when I am sure, I leave the door open: "I think", "I guess", "it feels like", "I'm not sure if", "maybe we could", never "this is a bug" or "this must change".
      - I often make the point as a question ("do we need both?", "is this the same?"), or end by asking what they think.
      - One suggestion, not a menu of options.
    TEXT
    # Earlier defaults. A reviewer who saved the dialog without changing its text has one of these
    # in their settings, and means the default, so they follow it as it improves.
    FORMER_VOICES = [<<~TEXT.strip].freeze
      - Conversational and friendly, in the first person, like talking to a teammate I like.
      - Never overconfident. Even when I am sure, I say what I checked and what I think is happening, and I leave the door open: I may be missing something. "I think", "it looks like", "maybe we could", never "this is a bug" or "this must change".
      - When it fits, I end with a question that asks for their view ("what do you think?", "or am I missing something?").
      - Short: one paragraph. I say what I need to say and stop; if they have questions, we follow up. Longer only when it truly cannot be said in one.
      - Plain words and short sentences. No corporate tone, no lecture.
    TEXT

    # The reviewer's own voice, or nil when what they saved is a default, this one or an earlier one.
    def own_voice(saved)
      text = saved.to_s.strip
      text.empty? || text == DEFAULT_VOICE || FORMER_VOICES.include?(text) ? nil : text
    end

    # Names the instructions a rewrite was written under, so one written under others is not reused.
    def version(voice, emojis) = Digest::SHA256.hexdigest(prompt(voice: voice, context: '', emojis: emojis))[0, 12]

    # The emojis they use, until they list their own; an empty list means they use none.
    DEFAULT_EMOJIS = '🤔 🙃 😅 🙋‍♂️'

    def emoji_rule(emojis)
      list = emojis.to_s.split.uniq
      return '- No emojis at all.' if list.empty?
      "- Emojis: only these, which are the ones I use: #{list.join(' ')}. One now and then at the end of a sentence, to show how I feel or to soften what I said; one or two in a comment at most, often none. Never any other emoji."
    end

    # context: the comment with its code and conversation, as Copy for LLMs gives it.
    # opinions: what other agents said beside the conversation, [{agent, body}].
    def prompt(voice:, context:, opinions: [], emojis: DEFAULT_EMOJIS)
      others = opinions.map { |opinion| "#{Agents.name(opinion['agent'])}: #{opinion['body']}" }.join("\n\n")
      <<~TEXT
        A person reviewed a code change with an AI review tool. Below is one of its review comments, the code it is about, and what was said about it: the person's questions, the review agent's answers and other agents' opinions.

        Write the comment this person will post on the GitHub pull request under their own name, to the teammate who wrote the code.

        How they write:
        #{voice}
        #{emoji_rule(emojis)}

        What always holds:
        - Say the main point and, when there is one, the suggestion. Secondary observations, extra evidence and caveats about what was not checked stay out unless the point does not stand without them: the reader can ask. Add no fact, file, line number or claim that is not in the material below.
        - If the discussion changed the point (an agent disagreed and was right, or the person learned something), write the comment for where the discussion ended, not where it started.
        - Do not repeat the file and lines the comment sits on: it is placed on them. Naming another file, method or identifier that helps the reader is welcome.
        - No headings, no summary, no bullet list. As short as their way of writing asks, and never longer than the review comment. Identifiers and code in backticks.
        - Never mention AI, agents, the review tool or this discussion.
        - Say nothing about how the point was found or checked: not that the code was only read, not that something was or was not tried, run or opened in a browser. The material describes what an agent did; what the person did is theirs to say, and they may well have checked it themselves. Hedge the point ("I think", "maybe"), never the method.
        - Write in the language of the review comment.

        Reply with the text of the comment and nothing else: no preamble, no quotes around it, no explanation.

        --- The review comment, its code and the conversation ---

        #{context.to_s[0, LIMIT]}
        #{others.empty? ? '' : "\n--- Other agents' opinions ---\n\n#{others[0, LIMIT / 3]}\n"}
      TEXT
    end

    # The agents that can write it, in order: the one that ran the review, then the reviewer's
    # adversaries, among those installed here.
    def writers(author, adversaries, installed: Agents.method(:installed?))
      ([{'agent' => author}] + adversaries).select { |entry| entry['agent'] && installed.call(entry['agent']) }.uniq { |entry| entry['agent'] }
    end

    # Returns [text, agent]. One that cannot answer (signed out, a model its account does not have)
    # hands over to the next; when none can, raises ArgumentError with the last one's sentence.
    def write(context:, opinions:, voice:, author:, adversaries:, repo:, emojis: DEFAULT_EMOJIS, ask: Agents.method(:ask), installed: Agents.method(:installed?))
      candidates = writers(author, adversaries, installed: installed)
      raise ArgumentError, 'No agent on this computer can write it: the review\'s agent is not installed here and no adversary is set up.' if candidates.empty?
      text = prompt(voice: voice, context: context, opinions: opinions, emojis: emojis)
      candidates.each_with_index do |chosen, index|
        return [tidy(ask.call(chosen['agent'], text, dir: repo, model: chosen['model'], effort: chosen['effort'], timeout: TIMEOUT)), chosen['agent']]
      rescue ArgumentError
        raise if index == candidates.length - 1
      end
    end

    # The comment alone: an agent that wrapped it in a fence or in quotes anyway is unwrapped.
    def tidy(answer)
      text = answer.to_s.strip
      text = Regexp.last_match(1).strip if text.match(/\A```[a-z]*\n(.*)\n```\z/m)
      text = text[1..-2].strip if text.length > 1 && text.start_with?('"') && text.end_with?('"') && text.count('"') == 2
      raise ArgumentError, 'The agent answered with nothing.' if text.empty?
      text
    end
  end
end
