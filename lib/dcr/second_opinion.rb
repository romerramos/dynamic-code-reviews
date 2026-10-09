# frozen_string_literal: true

require_relative 'agents'
require_relative 'state'

module DCR
  # Second opinions on a comment the review's agent posted: one adversary checks it and answers in
  # the comment's conversation; other installed agents give a short opinion beside it. Each gets the
  # same compact question: what the change is for, the code, the comment, and what they think.
  module SecondOpinion
    module_function

    CONTEXT_LINES = 4 # unchanged lines shown around the commented range
    VERDICT = /\A\W*(agree|partly agree|partially agree|mostly agree|disagree)\b\W*/i

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
    def run(series_dir:, comment_ids:, author:, context: nil, repo: nil, ask: Agents.method(:ask))
      require_relative '../../scripts/series'
      adversary, others = Agents.panel(author)
      return {} unless adversary
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
        panel = [[adversary, true]] + others.map { |agent| [agent, false] }
        state.await_opinions(key, id, adversary, others)
        results = panel.map do |agent, adversarial|
          Thread.new do
            question = prompt(asked: agent, author: author, context: context, code: excerpt, comment: comment, adversary: adversarial)
            word, body = verdict(ask.call(agent, question, dir: repo))
            state.add_opinion(key, id, agent, body, verdict: word, adversary: adversarial)
            [agent, word || 'answered']
          rescue ArgumentError, SystemCallError => error
            state.opinion_failed(key, id, agent, error.message, adversary: adversarial)
            [agent, "failed: #{error.message}"]
          end
        end.map(&:value)
        [id, results.to_h]
      end
    end
  end
end
