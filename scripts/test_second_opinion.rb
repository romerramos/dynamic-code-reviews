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

# Settings and answer records go to a scratch folder, never the reviewer's own.
ENV['DCR_CONFIG_DIR'] = Dir.mktmpdir('dcr-config')
chosen = [{'agent' => 'grok', 'model' => nil, 'effort' => nil}, {'agent' => 'codex', 'model' => nil, 'effort' => nil}, {'agent' => 'claude', 'model' => nil, 'effort' => nil}, {'agent' => 'gemini', 'model' => nil, 'effort' => nil}]
with_agents('codex' => 'exit 0', 'grok' => 'exit 0', 'claude' => 'exit 0', 'agy' => 'exit 0') do
  assert(DCR::Agents.panel('claude', []) == [], 'Nobody is asked until the reviewer chooses adversaries')
  assert(DCR::Agents.panel('claude', chosen).map { |entry| entry['agent'] } == %w[grok codex], 'The chosen adversaries answer in their order; one not installed is left out, and so is the author')
  assert(DCR::Agents.panel('claude', chosen + [{'agent' => 'antigravity'}]).last['agent'] == 'antigravity', 'Antigravity is found by its `agy` command')
  on_opus = chosen.map { |entry| entry['agent'] == 'claude' ? entry.merge('model' => 'opus') : entry }
  assert(DCR::Agents.panel('claude', on_opus).map { |entry| entry['agent'] } == %w[grok codex claude], 'An agent checks its own comments only on a model the reviewer named')
end
puts 'PASS the chosen adversaries answer in their order, never the author on its own settings'

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
    assert(DCR::Agents::RUNNERS['codex'].call('q', '/o', 'gpt-x', 'high')[0].each_cons(2).to_a.include?(['-c', 'model_reasoning_effort="high"']) && DCR::Agents::RUNNERS['codex'].call('q', '/o', 'gpt-x', nil)[0].include?('gpt-x'), 'Codex runs on the chosen model and effort')
    assert(DCR::Agents::RUNNERS['claude'].call('q', nil, nil, nil)[0] == %w[claude -p --tools Read,Grep,Glob], 'No model or effort chosen: the CLI keeps its own')
    assert(DCR::Agents::RUNNERS['opencode'].call('q', nil, 'opencode/big-pickle', nil)[0] == %w[opencode run --agent plan -m opencode/big-pickle q], 'opencode answers through its read-only plan agent')
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
  ask = lambda do |agent, question, dir:, model:, effort:|
    asked << [agent, question, dir, model, effort]
    raise ArgumentError, 'Grok did not answer (exit 1)' if agent == 'grok'
    "Disagree\nTen is the documented retry limit."
  end
  DCR::Settings.new.save_adversaries([{'agent' => 'codex', 'model' => 'gpt-x', 'effort' => 'low'}, {'agent' => 'grok'}])
  with_agents('codex' => 'exit 0', 'grok' => 'exit 0') do
    result = DCR::SecondOpinion.run(series_dir: series, comment_ids: ['c1'], author: 'claude', ask: ask)
    assert(result == {'c1' => {'codex' => 'disagree', 'grok' => 'failed: Grok did not answer (exit 1)'}}, "The run reports each agent: #{result}")
  end
  questions = Array.new(asked.size) { asked.pop }
  assert(questions.map(&:first).sort == %w[codex grok] && questions.all? { |_, _, dir| dir == series }, 'Each agent is asked once, in the repository')
  assert(questions.find { |agent, _| agent == 'codex' }.last(2) == %w[gpt-x low] && questions.find { |agent, _| agent == 'grok' }.last(2) == [nil, nil], 'Each runs on the model and effort the reviewer saved')
  results = DCR::AgentCatalog::Results.read
  assert(results.dig('codex', 'ok') == true && results.dig('grok', 'ok') == false && results.dig('grok', 'error').include?('did not answer'), "How each answered is remembered for the agent card: #{results}")
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

require_relative '../lib/dcr/live_api'
codex_catalog = JSON.generate('models' => [{'slug' => 'gpt-a', 'display_name' => 'GPT-A', 'visibility' => 'list', 'default_reasoning_level' => 'medium', 'supported_reasoning_levels' => [{'effort' => 'low'}, {'effort' => 'high'}]}, {'slug' => 'gpt-hidden', 'visibility' => 'hide'}])
assert(DCR::AgentCatalog.codex_models(codex_catalog) == [{'id' => 'gpt-a', 'label' => 'GPT-A', 'efforts' => %w[low high], 'default_effort' => 'medium'}], 'Codex lists its visible models with their efforts')
assert(DCR::AgentCatalog.grok_models("You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n") == [{'id' => 'grok-4.7', 'default' => true}, {'id' => 'grok-4.6'}], 'Grok lists its models and its default')
assert(DCR::AgentCatalog.signed_in("You are logged in with grok.com.", true) == true && DCR::AgentCatalog.signed_in('Error: not logged in', false) == false && DCR::AgentCatalog.signed_in('models', true).nil?, 'Signed in is read only where the CLI says it')
assert(DCR::AgentCatalog.agy_models("Fetching available models...\ngemini-x-high\tGemini X (High)\n") == [{'id' => 'gemini-x-high', 'label' => 'Gemini X (High)'}], 'Antigravity lists its models by id and name')
assert(DCR::AgentCatalog.opencode_models("opencode/big-pickle\nopencode/exo-free\nopenai/gpt-5.5\nnoise line\n") == [{'id' => 'opencode/big-pickle', 'free' => true}, {'id' => 'opencode/exo-free', 'free' => true}, {'id' => 'openai/gpt-5.5'}], 'opencode lists its models, the free ones marked')
puts 'PASS each CLI lists its own models and efforts, so nothing is kept by hand'

Dir.mktmpdir('dcr-settings') do |dir|
  settings = DCR::Settings.new(dir)
  settings.write('colorMode' => 'dark')
  assert(settings.save_adversaries([{'agent' => 'opencode', 'model' => 'opencode/big-pickle'}, {'agent' => 'codex', 'effort' => 'high'}]) == [{'agent' => 'opencode', 'model' => 'opencode/big-pickle', 'effort' => nil}, {'agent' => 'codex', 'model' => nil, 'effort' => 'high'}], 'Adversaries are saved in order')
  settings.write('colorMode' => 'light')
  assert(settings.adversaries.length == 2 && settings.read == {'colorMode' => 'light'}, 'Display settings and adversaries are written apart and keep each other')
  %w[Codex rm\ -rf].each do |bad|
    settings.save_adversaries([{'agent' => bad}])
    assert(false, "An invalid adversary was saved: #{bad}")
  rescue ArgumentError
    nil
  end
  assert(settings.save_adversaries([]) == [] && settings.read == {'colorMode' => 'light'}, 'Turning every adversary off keeps the display settings')
end
puts 'PASS adversaries are kept per reviewer, beside the display settings, and checked'

Dir.mktmpdir('dcr-question') do |series|
  state = DCR::State.new(series)
  key = DCR::State.review_key('f00d', 'job', 1)
  state.send_items(key, [{'id' => 'mine-1', 'text' => "File: app/job.rb\n\nWhy ten?"}])
  state.agent_reply('mine-1', 'It matches the retry limit.', key: key, agent: 'claude')
  state.user_message(key, 'mine-1', 'Is that limit documented?')
  text = DCR::SecondOpinion.follow_up(state.read, key, 'mine-1')
  assert(text.start_with?("File: app/job.rb\n\nWhy ten?") && text.include?('Claude: It matches the retry limit.') && text.end_with?("The reviewer now asks:\n\nIs that limit documented?"), "A follow-up carries what was first sent and the conversation since:\n#{text}")
  asked = Queue.new
  ask = ->(agent, question, dir:, model:, effort:) { asked << [agent, question]; "Agree\nIt is in the README." }
  with_agents('codex' => 'exit 0', 'opencode' => 'exit 0', 'claude' => 'exit 0') do
    result = DCR::SecondOpinion.question(state: state, key: key, id: 'mine-1', text: text, author: 'claude', repo: series, ask: ask,
                                         adversaries: [{'agent' => 'claude'}, {'agent' => 'codex'}, {'agent' => 'opencode', 'model' => 'opencode/big-pickle'}])
    assert(result.keys.sort == %w[codex opencode], "The review's own agent is not asked again: #{result}")
  end
  questions = Array.new(asked.size) { asked.pop }
  assert(questions.all? { |_, question| question.include?('independent answer') && question.include?('Is that limit documented?') }, 'Each adversary answers the question itself')
  thread = state.read.dig('threads', key, 'mine-1')
  assert(thread['messages'].none? { |message| message['role'] == 'adversary' } && thread['adversary'].nil?, 'On a question nobody takes the second reviewer\'s place in the conversation')
  assert(thread.dig('opinions', 'codex', 'body') == "Agree\nIt is in the README." && thread.dig('opinions', 'codex', 'verdict').nil? && thread['waiting_on'] == [], 'Answers to a question sit beside the conversation, with no verdict')
end
puts 'PASS a question asked with adversaries ticked: each answers it beside the review\'s agent, knowing what it was sent'

Dir.mktmpdir('dcr-api') do |series|
  settings = DCR::Settings.new(File.join(series, 'config'))
  asked = []
  api = DCR::LiveAPI.new(series, settings: settings, catalog: ->(fresh) { [{'slug' => 'codex', 'fresh' => fresh}] }, ask_adversaries: ->(*job) { asked << job })
  key = DCR::State.review_key('f00d', 'job', 1)
  body = ->(value) { -> { JSON.generate(value) } }
  status, listed = api.call('GET', '/api/agents?fresh=1', nil)
  assert(status == 200 && listed['agents'] == [{'slug' => 'codex', 'fresh' => true}] && listed['adversaries'] == [], "The page lists the agents and the saved adversaries: #{listed}")
  status, saved = api.call('POST', '/api/agents', body.call('adversaries' => [{'agent' => 'codex', 'effort' => 'high'}]))
  assert(status == 200 && saved['adversaries'] == [{'agent' => 'codex', 'model' => nil, 'effort' => 'high'}] && api.call('GET', '/api/adversaries', nil)[1]['adversaries'] == saved['adversaries'], 'The page saves the adversaries')
  assert(api.call('POST', '/api/agents', body.call('adversaries' => [{'agent' => '../x'}]))[0] == 400, 'An invalid adversary is refused')
  api.call('POST', '/api/send', body.call('key' => key, 'items' => [{'id' => 'mine-1', 'text' => 'Why ten?'}]))
  assert(asked.empty?, 'Without the tick, only the review\'s agent is asked')
  api.call('POST', '/api/send', body.call('key' => key, 'items' => [{'id' => 'mine-2', 'text' => 'Why five?'}], 'adversaries' => true))
  api.call('POST', '/api/message', body.call('key' => key, 'id' => 'mine-1', 'body' => 'And eleven?', 'adversaries' => true))
  assert(asked.map { |job| job.first(2) } == [[key, 'mine-2'], [key, 'mine-1']] && asked[0][2] == 'Why five?' && asked[1][2].start_with?('Why ten?') && asked[1][2].end_with?('And eleven?'), "With the tick, adversaries get the same question: #{asked}")
end
puts 'PASS the page lists agents, saves adversaries, and asks them only when the reviewer ticks it'
