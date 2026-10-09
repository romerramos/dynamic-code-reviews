# frozen_string_literal: true

# Run with ruby scripts/test_second_opinion.rb. Stdlib only; stand-in agent CLIs, nothing is asked for real.
require 'fileutils'
require 'json'
require 'tmpdir'
require_relative 'series'
require_relative '../lib/dcr/second_opinion'

def assert(condition, message)
  raise message unless condition
end

# Stand-in CLIs on PATH: each prints what a real one would, so the panel and the runners are real.
def with_agents(scripts)
  Dir.mktmpdir('dcr-agents') do |bin|
    scripts.each do |name, body|
      File.write(File.join(bin, name), "#!/bin/sh\n#{body}\n")
      File.chmod(0o755, File.join(bin, name))
    end
    path = ENV['PATH']
    # Only the stand-ins and the system's own tools: an agent installed on this computer must not join in.
    ENV['PATH'] = [bin, '/usr/bin', '/bin'].join(File::PATH_SEPARATOR)
    yield bin
  ensure
    ENV['PATH'] = path
  end
end

assert(DCR::Agents.check(' Codex ') == 'codex', 'Agent names are normalised')
begin
  DCR::Agents.check('rm -rf')
  assert(false, 'An agent name with spaces was accepted')
rescue ArgumentError
  nil
end
assert(DCR::Agents.detect('CLAUDECODE' => '1') == 'claude' && DCR::Agents.detect('GEMINI_CLI' => '1') == 'gemini' && DCR::Agents.detect({}).nil?, 'The calling agent is detected from its environment')
assert(DCR::Agents.name('grok') == 'Grok' && DCR::Agents.name('antigravity') == 'Antigravity' && DCR::Agents.name('my-bot') == 'My-bot', 'Agents are named')
puts 'PASS agents are named, checked and detected from the CLI that runs them'

with_agents('codex' => 'exit 0', 'grok' => 'exit 0', 'claude' => 'exit 0') do
  ENV.delete('GEMINI_API_KEY')
  assert(DCR::Agents.panel('claude', {}) == ['codex', ['grok']], 'Claude is checked by Codex, with Grok beside it')
  assert(DCR::Agents.panel('codex', {}) == ['claude', ['grok']], 'An author never checks its own comment')
  assert(DCR::Agents.panel('claude', 'DCR_ADVERSARY' => 'grok') == ['grok', ['codex']], 'DCR_ADVERSARY picks the second reviewer')
  assert(DCR::Agents.panel('claude', 'DCR_SECOND_OPINIONS' => 'off') == ['codex', []], 'Side opinions can be turned off')
  assert(DCR::Agents.panel('claude', 'DCR_ADVERSARY' => 'off') == [nil, []], 'Second opinions can be turned off')
end
with_agents('codex' => 'exit 0', 'agy' => 'exit 0') do
  assert(DCR::Agents.panel('claude', {}) == ['codex', ['antigravity']], 'Antigravity is found by its `agy` command')
end
puts 'PASS one installed agent is the second reviewer, the others weigh in beside it, and both can be configured'

assert(DCR::SecondOpinion.verdict("Disagree\nThe cap is enforced.") == ['disagree', 'The cap is enforced.'], 'A verdict line is read and removed')
assert(DCR::SecondOpinion.verdict('**Partly agree.** It is bounded, but not here.') == ['partly', 'It is bounded, but not here.'], 'A verdict in bold on the first line is read')
assert(DCR::SecondOpinion.verdict('Agree') == ['agree', 'Agree'], 'A bare verdict keeps its text')
assert(DCR::SecondOpinion.verdict('Hard to say.') == [nil, 'Hard to say.'], 'No verdict, no guess')
assert(DCR::SecondOpinion.verdict("I'll check how stats are cached.Agree\n\nThe key keeps the head only.") == ['agree', 'The key keeps the head only.'], 'Narration before a verdict is dropped')
assert(DCR::SecondOpinion.verdict("Looking at it now.\n**Disagree**\nIt is fine.") == ['disagree', 'It is fine.'], 'A verdict on its own later line is read')
assert(DCR::SecondOpinion.verdict('I agree with most of it.') == [nil, 'I agree with most of it.'], 'A verdict word inside a sentence is not a verdict')
assert(DCR::SecondOpinion.tidy('See [app/a.rb:160](/Users/me/app/a.rb:160) and [docs](https://example.com).') == 'See `app/a.rb:160` and [docs](https://example.com).', 'Local file links become code; web links stay')
puts 'PASS the verdict (agree, partly, disagree) is read from the first line of an answer'

hunk = {'id' => 'h1', 'old_start' => 1, 'old_count' => 3, 'new_start' => 1, 'new_count' => 4, 'patch' => "@@ -1,3 +1,4 @@\n def run\n-  loop { work }\n+  10.times { work }\n+  done\n end\n"}
snapshot = {'files' => [{'id' => 'f1', 'path' => 'app/job.rb', 'hunks' => [hunk]}]}
comment = {'id' => 'c1', 'hunk' => 'h1', 'side' => 'new', 'start' => 2, 'end' => 2, 'label' => 'issue', 'decoration' => 'blocking', 'subject' => 'Why ten?', 'discussion' => 'Ten looks arbitrary.'}
code = DCR::SecondOpinion.code(snapshot, comment)
assert(code[:where].start_with?('app/job.rb, after the change, line 2') && code[:language] == 'ruby', "The code says where it is: #{code[:where]}")
assert(code[:lines] == "1    def run\n2 +>   10.times { work }\n3 +    done\n4    end", "The commented line is marked among its neighbours:\n#{code[:lines]}")
prompt = DCR::SecondOpinion.prompt(asked: 'codex', author: 'claude', context: 'Stop the job from running forever.', code: code, comment: comment, adversary: true)
assert(prompt.include?('Claude left this comment') && prompt.include?('You are Codex') && prompt.include?('Agree, Partly agree or Disagree'), 'The question names both agents and asks for a verdict')
assert(prompt.include?('plain, simple words') && prompt.include?('Do not change anything'), 'The answer is asked to be simple and read-only')
assert(prompt.include?("Stop the job from running forever.\n") && prompt.include?('10.times') && prompt.include?('Why ten?') && prompt.include?('Ten looks arbitrary.'), 'The question carries the context, the code and the comment')
assert(prompt.length < 2000, "The question stays compact (#{prompt.length} characters)")
puts 'PASS the question is compact: what the change is for, the marked code, the comment, then simple rules'

Dir.mktmpdir('dcr-ask') do |dir|
  with_agents('grok' => 'echo "Agree"; echo "Fine as is."', 'codex' => 'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cat > /dev/null; printf "Disagree\\nNo." > "$out"; echo noise',
              'claude' => 'sleep 5', 'gemini' => 'echo "Opening authentication page in your browser"; exit 1') do
    assert(DCR::Agents.ask('grok', 'q', dir: dir) == "Agree\nFine as is.", 'A CLI that answers on stdout is read')
    assert(DCR::Agents.ask('codex', 'q', dir: dir) == "Disagree\nNo.", 'Codex is read from its last-message file, not its log')
    begin
      DCR::Agents.ask('claude', 'q', dir: dir, timeout: 1)
      assert(false, 'A hanging agent was waited on')
    rescue ArgumentError => error
      assert(error.message.include?('took longer'), error.message)
    end
    begin
      DCR::Agents.ask('gemini', 'q', dir: dir)
      assert(false, 'An agent that needs a sign-in was trusted')
    rescue ArgumentError => error
      assert(error.message.include?('not signed in'), error.message)
    end
  end
end
puts 'PASS each CLI is asked headless and read-only; a hang or a missing sign-in becomes a sentence, not a stuck review'

Dir.mktmpdir('dcr-opinions') do |series|
  FileUtils.mkdir_p(File.join(series, 'revisions'))
  File.write(File.join(series, 'manifest.json'), JSON.generate('version' => 1, 'name' => 'job', 'repo' => series, 'revisions' => [{'number' => 1, 'fingerprint' => 'f00d'}]))
  File.write(File.join(series, 'revisions', '001.html'), DCR::Page.review({'snapshot' => snapshot, 'review' => {'title' => 'Bound the job', 'status' => 'in_progress', 'comments' => []}}))
  state = DCR::State.new(series)
  key = DCR::State.review_key('f00d', 'job', 1)
  state.post_comments(key, [comment.merge('agent' => 'claude')])
  asked = Queue.new
  ask = lambda do |agent, question, dir:|
    asked << [agent, question, dir]
    raise ArgumentError, 'Grok did not answer (exit 1)' if agent == 'grok'
    "Disagree\nTen is the documented retry limit."
  end
  with_agents('codex' => 'exit 0', 'grok' => 'exit 0') do
    result = DCR::SecondOpinion.run(series_dir: series, comment_ids: ['c1'], author: 'claude', ask: ask)
    assert(result == {'c1' => {'codex' => 'disagree', 'grok' => 'failed: Grok did not answer (exit 1)'}}, "The run reports each agent: #{result}")
  end
  questions = Array.new(asked.size) { asked.pop }
  assert(questions.map(&:first).sort == %w[codex grok] && questions.all? { |_, _, dir| dir == series }, 'Each agent is asked once, in the repository')
  assert(questions.find { |agent, _| agent == 'codex' }[1].include?('Check whether this comment is right'), 'The second reviewer is asked to challenge the comment')
  assert(questions.all? { |_, question| question.include?('Bound the job') }, 'Without a given context, the review title says what the change is for')
  thread = state.read.dig('threads', key, 'c1')
  message = thread['messages'].first
  assert(thread['messages'].length == 1 && message.values_at('author', 'agent', 'role', 'verdict', 'body') == ['agent', 'codex', 'adversary', 'disagree', 'Ten is the documented retry limit.'], "The second reviewer answers in the conversation: #{message}")
  assert(thread['delivery'] == 'draft' && !thread['live'], 'A second opinion is not an answer to the reviewer and sends nothing')
  assert(thread['adversary'] == 'codex' && thread['waiting_on'] == [] && thread.dig('opinions', 'grok', 'error').include?('did not answer'), 'Nobody is left waiting, and a failure is kept beside the conversation')
  state.add_opinion(key, 'c1', 'codex', 'Agreed after all.', verdict: 'agree', adversary: true)
  state.add_opinion(key, 'c1', 'grok', 'Fine.', verdict: 'agree')
  state.opinion_failed(key, 'c1', 'grok', 'Grok took longer than 5 minutes')
  again = state.read.dig('threads', key, 'c1')
  assert(again['messages'].map { |entry| entry['body'] } == ['Agreed after all.'], 'Asking again replaces the earlier answer, it does not repeat it')
  assert(again.dig('opinions', 'grok', 'body') == 'Fine.', 'A failed retry keeps the answer already given')
end
puts 'PASS a posted comment gets the second reviewer in its conversation and the others beside it, failures included'

Dir.mktmpdir('dcr-carried') do |series|
  state = DCR::State.new(series)
  first, second = [1, 2].map { |number| DCR::State.review_key('f00d', 'job', number) }
  state.post_comments(first, [comment.merge('agent' => 'claude')])
  state.await_opinions(first, 'c1', 'codex', ['grok'])
  assert(Time.now - Time.parse(state.read.dig('threads', first, 'c1', 'asked_at')) < 60, 'The page is told when the agents were asked, to show a wait that outlived them')
  state.carry_forward('job', [{'number' => 1, 'fingerprint' => 'f00d'}, {'number' => 2, 'fingerprint' => 'f00d'}])
  state.add_opinion(first, 'c1', 'codex', "Agree\nIt is bounded.", verdict: 'agree', adversary: true)
  state.opinion_failed(first, 'c1', 'grok', 'Grok is not signed in.')
  [first, second].each do |key|
    thread = state.read.dig('threads', key, 'c1')
    assert(thread['waiting_on'] == [] && thread['messages'].map { |message| message['agent'] } == ['codex'] && thread.dig('opinions', 'grok', 'error'), "Revision #{key[-1]} still waits or misses the answer: #{thread}")
  end
end
puts 'PASS an answer that arrives after the thread was carried to a new revision reaches every copy'
