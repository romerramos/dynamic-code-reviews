# frozen_string_literal: true

require_relative 'agent_catalog'
require_relative 'agents'
require_relative 'settings'
require_relative 'state'

module DCR
  # The reviewer's adversaries (Settings#adversaries) at work. On a comment the review's agent posted,
  # the first checks it and answers in the comment's conversation, the others give a short opinion
  # beside it; each gets the same compact question: what the change is for, the code, the comment.
  # On a question the reviewer asks with adversaries ticked, every one answers it beside the
  # review's agent, on its own: a short answer, then details. Once the review's agent has answered
  # too, one of them (the judge) says how far each answer agrees with it, without knowing whose is whose.
  module SecondOpinion
    module_function

    CONTEXT_LINES = 4 # unchanged lines shown around the commented range
    VERDICT = /\A\W*(agree|partly agree|partially agree|mostly agree|disagree)\b\W*/i
    # `Answer:` opens the short answer, wherever an agent's narration ends ("I'll check the cache.Answer: Yes").
    ANSWER = /(?:\A|[\n.!?:])[ \t*_#]*answer[*_]*:[*_]*[ \t]*/i
    DETAILS = /^[ \t*_#]*details[*_]*:[*_]*[ \t]*\n?/i
    PATIENCE = 600 # seconds the judge waits for the review's agent to answer the question
    JUDGED = 1500 # characters of an answer the judge reads

    def prompt(asked:, author:, context:, code:, comment:, adversary:)
      role = adversary ? 'You are the second reviewer. Check whether this comment is right, and say what it gets wrong or misses. Be fair: agree when it is right.' : 'Give a quick second opinion on this comment.'
      <<~TEXT
        #{role}

        #{Agents.name(author)} left this comment while reviewing a code change. You are #{Agents.name(asked)}.

        How to answer:
        - Start with one word on its own line: Agree, Partly agree or Disagree.
        - Then 2 to 4 short sentences in plain, simple words. No jargon you do not need, no long words.
        - Talk about this code only. Name the file and line when it helps.
        - If you would change the comment, say how in one sentence.
        - You may read files in this repository to check. Do not change anything.

        What the change is about:
        #{context.to_s.strip.empty? ? '(not given)' : context.strip}

        The code (#{code[:where]}):
        ```#{code[:language]}
        #{code[:lines]}
        ```

        #{Agents.name(author)}'s comment (#{comment['label']}, #{comment['decoration']}):
        #{comment['subject']}
        #{comment['discussion'].to_s.strip}
      TEXT
    end

    # The commented lines with a few around them, numbered on the comment's side.
    def code(snapshot, comment)
      file = snapshot.fetch('files').find { |entry| entry['hunks'].any? { |hunk| hunk['id'] == comment['hunk'] } }
      raise ArgumentError, "No captured code for comment #{comment['id']}" unless file
      hunk = file['hunks'].find { |entry| entry['id'] == comment['hunk'] }
      side = comment['side']
      first, last = comment.values_at('start', 'end')
      rows = (hunk['rows'] || DynamicReviews.diff_rows(hunk))['unified'].select { |row| row[side] }
      shown = rows.select { |row| row[side].between?(first - CONTEXT_LINES, last + CONTEXT_LINES) }
      width = shown.map { |row| row[side].to_s.length }.max.to_i
      marks = {'add' => '+', 'del' => '-', 'context' => ' '}
      lines = shown.map { |row| "#{row[side].to_s.rjust(width)} #{marks[row['kind']]}#{row[side].between?(first, last) ? '>' : ' '} #{row['text']}" }.join("\n")
      range = first == last ? "line #{first}" : "lines #{first}-#{last}"
      {where: "#{file['path']}, #{side == 'new' ? 'after' : 'before'} the change, #{range}; > marks the commented lines", language: language(file['path']), lines: lines}
    end

    def language(path) = {'.rb' => 'ruby', '.erb' => 'erb', '.js' => 'javascript', '.ts' => 'typescript', '.py' => 'python', '.go' => 'go', '.css' => 'css', '.sql' => 'sql', '.yml' => 'yaml', '.yaml' => 'yaml'}.fetch(File.extname(path.to_s), '')

    # A verdict that ends a sentence of narration ("I'll check the cache.Agree") or stands on its own line.
    LATE_VERDICT = /(?:[.!?:]|\n)[ \t*_]*(agree|partly agree|partially agree|mostly agree|disagree)[.!*_]*[ \t]*(?:\n|\z)/i

    # [verdict, body without the verdict line]. verdict is agree, partly or disagree, or nil.
    # Anything an agent narrated before its verdict ("I'll check how...") is dropped with it.
    def verdict(answer)
      text = tidy(answer)
      match = text.match(VERDICT) || text.match(LATE_VERDICT) or return [nil, text]
      word = match[1].downcase
      rest = text[match.end(0)..].to_s.strip
      [word == 'disagree' ? 'disagree' : (word == 'agree' ? 'agree' : 'partly'), rest.empty? ? text : rest]
    end

    # Local links (a file on this computer) read as code; the page links only to the web.
    def tidy(answer) = answer.to_s.gsub(/\[([^\]\n]+)\]\((?!https?:)[^)\s]+\)/) { "`#{Regexp.last_match(1).delete('`')}`" }.strip

    # Asks the panel about each comment and posts every answer as it arrives. Returns what happened,
    # per comment and agent, for the terminal.
    def run(series_dir:, comment_ids:, author:, context: nil, repo: nil, ask: Agents.method(:ask), adversaries: Settings.new.adversaries)
      require_relative '../../scripts/series'
      panel = Agents.panel(author, adversaries)
      return {} if panel.empty?
      history = ReviewSeries.manifest(series_dir)
      payload = ReviewSeries.latest(series_dir, history)
      entry = history['revisions'].last
      key = State.review_key(entry['fingerprint'], history['name'], entry['number'])
      state = State.new(series_dir)
      posted = (state.read.dig('comments', key) || []) + Array(payload.dig('review', 'comments'))
      context ||= [payload.dig('review', 'title'), payload.dig('review', 'summary')].compact.join('. ')[0, 600]
      repo ||= history['repo']
      comment_ids.to_h do |id|
        comment = posted.find { |candidate| candidate['id'] == id } or raise ArgumentError, "No comment #{id} in this review"
        excerpt = code(payload['snapshot'], comment)
        state.await_opinions(key, id, panel.first['agent'], panel.drop(1).map { |adversary| adversary['agent'] })
        results = consult(state, key, id, panel, repo, ask) do |agent, adversarial|
          prompt(asked: agent, author: author, context: context, code: excerpt, comment: comment, adversary: adversarial)
        end
        [id, results]
      end
    end

    # A question the reviewer asked with adversaries ticked: each answers it on its own, beside the
    # review's agent (author), which answers in the conversation as usual. text: what the review's
    # agent was sent, so they know as much as it does.
    def question(state:, key:, id:, text:, author:, repo:, ask: Agents.method(:ask), adversaries: Settings.new.adversaries, patience: PATIENCE, pause: 2)
      panel = Agents.panel(author, adversaries)
      return {} if panel.empty?
      heard = state.answers(key, id).map { |message| message['id'] }
      asked_at = state.await_opinions(key, id, nil, panel.map { |adversary| adversary['agent'] })
      results = consult(state, key, id, panel, repo, ask, on_comment: false) { |agent, _| question_prompt(asked: agent, author: author, text: text) }
      judge(state: state, key: key, id: id, text: text, asked_at: asked_at, heard: heard, judge: panel.first, repo: repo, ask: ask, patience: patience, pause: pause)
      results
    end

    # [short answer, the whole answer without its markers]. short is nil when the agent did not mark one.
    def structured(answer)
      text = tidy(answer)
      match = text.match(ANSWER) or return [nil, text]
      short, details = text[match.end(0)..].split(DETAILS, 2).map { |part| part.to_s.strip }
      return [nil, text] if short.to_s.empty?
      [short, [short, details].reject { |part| part.to_s.empty? }.join("\n\n")]
    end

    # The adversaries answered on their own. When the review's agent has answered too, the judge
    # compares each answer with it and the verdicts land on the opinions. Nothing happens when the
    # review's agent does not answer in time, or the reviewer asked again meanwhile. heard: the ids
    # of what the review's agent had already said when the question was asked.
    def judge(state:, key:, id:, text:, asked_at:, heard:, judge:, repo:, ask: Agents.method(:ask), patience: PATIENCE, pause: 2)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + patience
      loop do
        thread = state.read.dig('threads', key, id) or return
        return unless thread['asked_at'] == asked_at
        opinions = (thread['opinions'] || {}).select { |_, opinion| opinion['body'] && opinion['role'] != 'adversary' }
        return if opinions.empty?
        main = state.answers(key, id).reject { |message| heard.include?(message['id']) }.last&.fetch('body')
        if main
          answer = ask.call(judge['agent'], judge_prompt(question: thread['messages'].reverse.find { |message| message['author'] == 'user' }&.fetch('body') || text, main: main, answers: opinions.values.map { |opinion| opinion['short'] || opinion['body'] }), dir: repo, model: judge['model'], effort: judge['effort'])
          verdicts, differ = judged(answer, opinions.length)
          # The judge knew the answers by letter; the reviewer reads who it was.
          differ = differ&.gsub(/\banswer ([A-Z])\b/i) { (agent = opinions.keys[Regexp.last_match(1).upcase.ord - 65]) ? Agents.name(agent) : Regexp.last_match(0) }
          return state.judge_opinions(key, id, opinions.keys.zip(verdicts).to_h { |agent, word| [agent, {'body' => opinions[agent]['body'], 'verdict' => word}] }, differ)
        end
        return if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
        sleep pause
      end
    rescue ArgumentError, SystemCallError => error
      warn "The answers to #{id} could not be compared: #{error.message}"
    end

    # The answers carry letters, not names: the judge must not know whose is whose.
    def judge_prompt(question:, main:, answers:)
      letters = ('A'..'Z').first(answers.length)
      <<~TEXT
        A reviewer asked a question about a code change. One agent gave the main answer; #{answers.length == 1 ? 'another agent' : 'other agents'} answered on #{answers.length == 1 ? 'its' : 'their'} own, without seeing it. Say how far each other answer agrees with the main answer.

        - Agree: the same conclusion.
        - Partly agree: the same conclusion with a real caveat, or a different fix.
        - Disagree: a different conclusion.

        Judge only what is written here. Do not read files. Reply with exactly these lines and nothing else:
        #{letters.map { |letter| "#{letter}: Agree, Partly agree or Disagree" }.join("\n")}
        Differ: one short, plain sentence on where the answers differ most, or the word nothing when they all agree. Name an answer as `Answer A`, each time.

        The question:
        #{question.to_s.strip[0, JUDGED]}

        The main answer:
        #{main.to_s.strip[0, JUDGED]}

        #{letters.zip(answers).map { |letter, answer| "Answer #{letter}:\n#{answer.to_s.strip[0, JUDGED]}" }.join("\n\n")}
      TEXT
    end

    # [[verdict or nil per answer, in order], where they differ or nil].
    def judged(answer, count)
      lines = tidy(answer).lines.map(&:strip)
      verdicts = ('A'..'Z').first(count).map do |letter|
        word = lines.filter_map { |line| line[/\A\W*#{letter}\W*:\W*(agree|partly agree|partially agree|mostly agree|disagree)\b/i, 1] }.first&.downcase
        word && (word == 'disagree' ? 'disagree' : (word == 'agree' ? 'agree' : 'partly'))
      end
      differ = lines.filter_map { |line| line[/\A\W*differ\w*\W*:\s*(.+)/i, 1] }.first.to_s.strip
      [verdicts, differ.empty? || differ.match?(/\Anothing\W*\z/i) ? nil : differ[0, 300]]
    end

    def question_prompt(asked:, author:, text:)
      <<~TEXT
        You are #{Agents.name(asked)}. A reviewer is going through a code change with #{author ? Agents.name(author) : 'their agent'}, the agent running the review, and asked what follows. Give your own, independent answer; the reviewer reads it beside theirs.

        How to answer:
        - Write `Answer:` and then your answer in one or two plain sentences. The reviewer may read nothing else, so it must stand on its own.
        - Only if the answer needs backing, add a line `Details:` and under it at most four short bullets, and at most one short code block. Leave it out when the answer is enough.
        - Write nothing before `Answer:`. Do not say what you are about to do.
        - Plain, simple words. Name the file and line when it helps.
        - You may read files in this repository to check. Do not change anything.

        ---

        #{text.to_s.strip}
      TEXT
    end

    # What adversaries need to answer a follow-up: what the review's agent was first sent about the
    # thread, the conversation since, and the new message (already the thread's last).
    def follow_up(state_data, key, id)
      first = state_data['outbox'].find { |entry| entry['kind'] == 'send' && entry['key'] == key && entry['thread_ids'] == [id] && !entry['text'].start_with?('Follow-up in thread') }
      *earlier, latest = state_data.dig('threads', key, id, 'messages') || []
      said = earlier.reject { |message| message['role'] }.map { |message| "#{message['author'] == 'user' ? 'Reviewer' : Agents.name(message['agent'] || 'agent')}: #{message['body']}" }
      [first&.fetch('text'), said.empty? ? nil : "The conversation so far:\n\n#{said.join("\n\n")}", "The reviewer now asks:\n\n#{latest&.fetch('body')}"].compact.join("\n\n")
    end

    # Asks every adversary at once and posts each answer as it arrives. On a comment the first
    # answers in the conversation and each says what it thinks of the comment; on a question
    # (on_comment false) they all answer beside it, a short answer first. Returns {agent => verdict or what failed}.
    def consult(state, key, id, panel, repo, ask, on_comment: true)
      panel.each_with_index.map do |adversary, index|
        agent, model, effort = adversary.values_at('agent', 'model', 'effort')
        adversarial = on_comment && index.zero?
        Thread.new do
          answer = ask.call(agent, yield(agent, adversarial), dir: repo, model: model, effort: effort)
          word, body = on_comment ? verdict(answer) : [nil, nil]
          short, body = structured(answer) unless on_comment
          state.add_opinion(key, id, agent, body, verdict: word, short: short, adversary: adversarial, model: model, effort: effort)
          AgentCatalog::Results.record(agent)
          [agent, word || 'answered']
        rescue ArgumentError, SystemCallError => error
          state.opinion_failed(key, id, agent, error.message, adversary: adversarial)
          AgentCatalog::Results.record(agent, error.message)
          [agent, "failed: #{error.message}"]
        end
      end.map(&:value).to_h
    end
  end
end
