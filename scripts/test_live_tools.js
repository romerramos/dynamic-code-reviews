/* Node built-ins only; the conversation layer's pure helpers. */
'use strict';
const assert = require('node:assert/strict');
require('../assets/review-tools.js');
require('../live/live-tools.js');
const tools = globalThis.LiveTools;

const file = {id:'f1', path:'app/a.rb', hunks:[{id:'h1', old_start:1, old_count:1, new_start:1, new_count:1, rows:{unified:[{kind:'add', new:1, text:'x = 2'}]}}]};
const snapshot = {fingerprint:'abc', head:'HEAD', created:'now', mode:'uncommitted', files:[file]};
const generated = {id:'c1', hunk:'h1', side:'new', start:1, end:1, label:'issue', decoration:'blocking', subject:'Unbounded', discussion:'It loops'};
const review = {comments:[generated], findings:[], history:{series:'feature', revision:2}};
const personal = {id:'mine-1', hunk:'h1', side:'new', start:1, end:1, label:'question', decoration:'non-blocking', subject:'Why?', discussion:'', general:false};

assert.equal(tools.progressKey(snapshot, review), 'dynamic-review:abc:feature:2');
assert.equal(tools.progressKey(snapshot, {}), 'dynamic-review:abc');
assert.match(tools.progressKey(snapshot, review), /^dynamic-review:[A-Za-z0-9_.:-]{1,300}$/, 'the key must satisfy the server rule');

const comments = tools.allComments(review, {personalComments:[personal, {id:'other-2', subject:'x'}]});
assert.deepEqual(comments.map(comment => [comment.id, comment.personal]), [['c1', false], ['mine-1', true]]);
console.log('PASS the progress key matches the server rule and only reader comments count as personal');

assert.deepEqual(tools.drafts(comments, {}).map(comment => comment.id), ['mine-1'], 'findings are never drafts');
assert.deepEqual(tools.drafts(comments, {'mine-1':{delivery:'sent', live:true}}), []);
assert.deepEqual(tools.drafts(comments, {'mine-1':{delivery:'draft', live:false, messages:[{author:'user'}]}}).map(comment => comment.id), ['mine-1'], 'a private note keeps the comment a draft');
assert.deepEqual(tools.drafts(comments, {}, ['mine-1']), [], 'resolved comments are not sent');
assert.deepEqual(tools.summary(comments, {a:{delivery:'sent'}, b:{delivery:'answered'}, c:{delivery:'answered'}}), {drafts:1, waiting:1, answered:2});
assert.deepEqual(tools.drafts([{...personal, personal:true, audience:'pr'}, {...personal, personal:true, id:'mine-2', audience:'agent'}], {}).map(comment => comment.id), ['mine-2'], 'a PR comment is for GitHub, not an unsent message');
console.log('PASS drafts exclude findings, sent and resolved comments, and a private note does not send; PR comments are not agent drafts');

const text = tools.sendText(snapshot, review, comments[0], '  please check the caller too ');
assert.match(text, /File: app\/a\.rb/);
assert.match(text, /x = 2/, 'the captured code is included');
assert.match(text, /issue \(blocking\): Unbounded/);
assert.match(text, /Reviewer's message:\nplease check the caller too$/);
assert.ok(!/Conversation: resolved/.test(tools.sendText(snapshot, review, {...comments[0], resolved:true})), 'resolution state is not sent to the agent');
assert.ok(!tools.sendText(snapshot, review, comments[0]).includes("Reviewer's message"));
console.log('PASS the first send carries captured code, the comment and the reader note, reusing Copy for LLMs formatting');

// Copy for LLMs carries the conversation once there is one; the first send to the agent never does.
const reviewTools = globalThis.ReviewTools;
const convo = {'mine-1': {messages: [{id:'m1', author:'user', body:'Is it bounded?', at:'2026-10-08T10:00:00Z'}, {id:'m2', author:'agent', body:'Yes: `limit` caps it.', at:'2026-10-08T10:02:00Z'}]}};
reviewTools.setConversationSource(id => convo[id] ? {messages: convo[id].messages, series: 'feature'} : null);
const withRepo = {...snapshot, repo: '/Users/me/my app'};
const copied = reviewTools.commentText(withRepo, comments[1]);
assert.match(copied, /question \(non-blocking\): Why\?\n\nConversation with the agent\n\nReviewer · 2026-10-08 10:00 UTC\nIs it bounded\?\n\nAgent · 2026-10-08 10:02 UTC\nYes: `limit` caps it\./);
assert.match(copied, /\nThread: mine-1\nLatest messages: dcr comments --repo '\/Users\/me\/my app' --name feature --thread mine-1$/, 'the thread id and a quoted command to read the latest messages');
assert.match(reviewTools.reviewText(withRepo, [comments[1]]), /Conversation with the agent/, 'Copy all carries conversations too');
assert.ok(!reviewTools.commentText(withRepo, comments[0]).includes('Conversation with the agent'), 'a comment without messages copies as before');
assert.ok(!tools.sendText(withRepo, review, comments[1]).includes('Conversation with the agent'), 'the first send does not repeat the conversation to the agent');
assert.ok(!reviewTools.commentText(snapshot, comments[1]).includes('Latest messages'), 'without the repository path there is no command, only the thread id');
reviewTools.setConversationSource(null);
assert.ok(!reviewTools.commentText(withRepo, comments[1]).includes('Conversation'), 'clearing the source restores the plain copy');
console.log('PASS Copy for LLMs carries the conversation, the thread id and the dcr command; sending to the agent does not');

// What GitHub receives: the paste-ready text, and for a line comment its file, side and lines.
const item = reviewTools.githubItem(snapshot, comments[1]);
assert.deepEqual({...item, body: undefined}, {id: 'mine-1', body: undefined, general: false, path: 'app/a.rb', side: 'RIGHT', line: 1, start_line: 1});
assert.match(item.body, /^question \(non-blocking\): Why\?/);
assert.ok(!item.body.includes('File: app/a.rb'), 'a comment placed on its lines does not repeat its location');
assert.deepEqual(reviewTools.githubItem(snapshot, {id: 'g', general: true, label: 'note', decoration: 'non-blocking', subject: 'Overall', discussion: ''}), {id: 'g', body: 'note (non-blocking): Overall', general: true});
console.log('PASS a comment becomes a GitHub line or conversation comment with paste-ready text');

assert.equal(tools.actionLabel(undefined), 'Ask agent');
assert.equal(tools.actionLabel({live:true}), 'Reply');
console.log('PASS the action is Ask agent until the comment is with the agent, then Reply');

// Reading an answer: formatting that helps, and nothing that can become markup.
const md = tools.markdown('Observed: `to_h` is **there**.\nSecond line.\n\n- one `a<b>`\n- two\n\n1. first\n2. second\n\n```ruby\nx = "<b>"\n```\nSee [docs](https://example.com/x?a=1&b=2).');
assert.match(md, /<p>Observed: <code>to_h<\/code> is <strong>there<\/strong>\.<br>Second line\.<\/p>/);
assert.match(md, /<ul><li>one <code>a&lt;b&gt;<\/code><\/li><li>two<\/li><\/ul>/);
assert.match(md, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
assert.match(md, /<pre><code>x = &quot;&lt;b&gt;&quot;<\/code><\/pre>/);
assert.match(md, /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
for (const hostile of ['<img src=x onerror=alert(1)>', '`<script>alert(1)</script>`', '[x](javascript:alert(1))', '**<b onclick=1>**', '[a](https://x.test/" onmouseover="alert(1))', '<a href="https://evil.test">x</a>']) {
  const out = tools.markdown(hostile);
  // Only the tags the formatter itself writes may remain; every link must be https with no extra attributes.
  const stripped = out.replace(/<\/?(p|br|ul|ol|li|pre|code|strong|em)>/g, '').replace(/<a href="https:\/\/[^"\s<>]*" target="_blank" rel="noopener noreferrer">|<\/a>/g, '');
  assert.ok(!stripped.includes('<'), `markup leaked for ${hostile}: ${out}`);
  assert.ok(!/href="(?!https:)/.test(out), `non-https link for ${hostile}: ${out}`);
}
assert.equal(tools.markdown(''), '');
assert.equal(tools.markdown('a\n\n\nb'), '<p>a</p><p>b</p>');
assert.equal(tools.markdown('Call `phone_to\nnumber(@site)` once.'), '<p>Call <code>phone_to number(@site)</code> once.</p>', 'a code span wrapped across lines stays one span');
console.log('PASS answers render paragraphs, lists, code and links, and hostile text stays inert');

assert.equal(tools.snippet('I would keep `Data`. **Observed:** `to_params` uses `with` and `to_h`; see [the docs](https://x.test).\n\nSecond paragraph.'), 'I would keep Data. Observed: to_params uses with and to_h; see the docs.', 'only the first paragraph, marks removed, identifiers intact');
assert.equal(tools.snippet('```ruby\nx = 1\n```\n\nAfter the code'), 'After the code', 'a leading code block is skipped');
assert.equal(tools.snippet('- first point\n- second point'), 'first point second point', 'list markers are dropped');
assert.equal(tools.snippet(undefined), '');
console.log('PASS the list snippet is the first paragraph as plain text and keeps underscored identifiers');

const now = Date.parse('2026-10-07T12:00:00Z');
assert.equal(tools.relativeTime('2026-10-07T11:59:40Z', now), 'just now');
assert.equal(tools.relativeTime('2026-10-07T11:55:00Z', now), '5 min ago');
assert.equal(tools.relativeTime('2026-10-07T09:00:00Z', now), '3 h ago');
assert.equal(tools.relativeTime('nonsense', now), '');
console.log('PASS message times read as just now, minutes and hours');

// What the page tells you about a thread and about the agent.
assert.equal(tools.statusModel(undefined, true), null);
assert.equal(tools.statusModel({delivery:'draft'}, true), null);
assert.equal(tools.statusModel({delivery:'sent'}, true).tone, 'wait');
assert.equal(tools.statusModel({delivery:'sent'}, false).tone, 'idle');
assert.match(tools.statusModel({delivery:'sent'}, false).text, /No agent is listening/);
assert.deepEqual(tools.statusModel({delivery:'delivered'}, true), {tone:'work', text:'Your agent is working on an answer', typing:true});
assert.equal(tools.statusModel({delivery:'answered', messages:[{author:'agent', at:'t'}]}, true).at, 't');
const late = '2026-10-07T11:40:00Z';
const staleThread = {delivery:'delivered', delivered_at:late};
assert.equal(tools.statusModel({delivery:'delivered', delivered_at:'2026-10-07T11:58:00Z'}, true, now).tone, 'work', 'a recent hand-over is being worked on');
assert.equal(tools.statusModel(staleThread, true, now).tone, 'idle', 'an old hand-over with no answer is not shown as work in progress');
assert.match(tools.statusModel(staleThread, true, now).text, /20 min ago and has not answered/);
assert.equal(tools.agentModel({a:staleThread}, true, now).tone, 'ok', 'a stale hand-over does not keep the agent working');
assert.equal(tools.agentModel({}, true, now, {'a.erb':{status:'working'}}).tone, 'work', 'building a preview is working');
assert.equal(tools.agentModel({}, true, now, {'a.erb':{status:'requested'}}).tone, 'ok', 'a request nobody has picked up yet is not work in progress');
assert.equal(tools.agentModel({}, undefined), null, 'an old server that cannot say shows nothing');
assert.equal(tools.agentModel({}, true).tone, 'ok');
assert.equal(tools.agentModel({}, false).tone, 'off');
assert.equal(tools.agentModel({a:{delivery:'delivered'}}, false).tone, 'work', 'working wins over not listening');
console.log('PASS thread and agent status say whether a message is waiting, being worked on, or answered');

// Messages: plain thread, escaped, New until seen.
const threadWith = {messages:[{id:'m1', author:'user', body:'ok & thanks', at:'2026-10-07T11:59:59Z'}, {id:'m2', author:'agent', body:'<img src=x onerror=alert(1)> `code`', at:'2026-10-07T11:59:59Z'}]};
const html = tools.messagesHTML(threadWith, {seen:new Set(['m1']), now});
assert.ok(!html.includes('<img'), 'message text must be escaped');
assert.match(html, /ok &amp; thanks/);
assert.match(html, /dcr-you[\s\S]*dcr-agent/);
assert.match(html, /<span class="dcr-new">New<\/span>/, 'an unseen agent message is marked New');
assert.ok(!tools.messagesHTML(threadWith, {seen:new Set(['m1', 'm2']), now}).includes('dcr-new'), 'a seen message is not');
assert.ok(!/dcr-new[\s\S]*dcr-new/.test(html) && !tools.messagesHTML({messages:[threadWith.messages[0]]}, {now}).includes('dcr-new'), 'your own messages are never New');
assert.deepEqual(tools.unseen({t:threadWith}, new Set(['m1'])), [{thread:'t', id:'m2'}]);
assert.deepEqual(tools.unseen({t:threadWith}, new Set(['m2'])), []);
assert.equal(tools.messagesHTML(undefined), '');
console.log('PASS the conversation renders as an escaped thread with New on unseen agent messages only');

// --- who wrote it, and what the other agents think ---------------------------------------------------
globalThis.ReviewBrands = {codex:'<svg data-mark="codex"></svg>'};
assert.equal(tools.agentInfo('codex').name, 'Codex');
assert.equal(tools.agentInfo('codex').company, 'OpenAI');
assert.equal(tools.agentInfo('my-bot').name, 'My-bot', 'an unknown agent keeps its own name');
assert.equal(tools.agentInfo(null).name, 'Agent', 'older messages stay "Agent"');
assert.match(tools.avatarHTML('codex'), /data-mark="codex"/, 'a known agent shows its mark');
assert.match(tools.avatarHTML('my-bot'), /<b>M<\/b>/, 'an agent with no bundled mark shows its letter');
assert.equal(tools.agentInfo('antigravity').company, 'Google');

const debated = {delivery:'draft', live:false, adversary:'codex', waiting_on:['gemini'],
  messages:[{id:'m1', author:'agent', agent:'codex', role:'adversary', verdict:'disagree', body:'The cap is already enforced in `limit`.', at:'2026-10-09T10:00:00Z'}],
  opinions:{grok:{id:'o1', body:'Looks right to me.', verdict:'agree', at:'2026-10-09T10:01:00Z'}, claude:{error:'Claude took longer than 5 minutes'}}};
const thread = tools.messagesHTML(debated, {seen:new Set(['m1'])});
assert.match(thread, /<strong>Codex<\/strong><span class="dcr-verdict dcr-v-disagree">.*Disagrees<\/span><span class="dcr-role">second reviewer<\/span>/s, 'the second reviewer is named, shows its verdict, then its role in plain text');
assert.match(thread, /dcr-adversary dcr-v-disagree/);
assert.match(tools.messagesHTML({messages:[{id:'r1', author:'agent', body:'ok'}]}, {agent:'claude'}), /<strong>Claude<\/strong>/, 'an unnamed reply takes the listening agent');
assert.deepEqual(tools.tally(debated), {total:2, agree:1, partly:0, disagree:1});
assert.equal(tools.tallyText(tools.tally(debated)), '1 agrees · 1 disagrees');
const side = tools.opinionsHTML(debated);
assert.match(side, /Other opinions/);
assert.match(side, /data-dcr-opinion="grok" aria-expanded="false">.*<strong>Grok<\/strong><span class="dcr-op-verdict dcr-v-agree">.*Agree<\/span>.*dcr-op-snippet">Looks right to me\.</s, 'a side opinion is one row: its mark, name, verdict and the start of its answer');
assert.match(side, /is-waiting[^>]*>.*Gemini.*is reading the code/s, 'an agent still reading shows as waiting');
assert.match(side, /is-failed[^>]*>.*Claude.*did not answer/s, 'a failed agent says so, quietly');
assert.doesNotMatch(side, /data-dcr-opinion="codex"/, 'the second reviewer is in the conversation, not among the rows');
assert.match(side, /dcr-consensus dcr-v-partly">1 agrees · 1 disagrees</, 'the heading says how the whole panel came out');
const opened = tools.opinionsHTML(debated, {open:['grok']});
assert.match(opened, /aria-expanded="true">.*<\/button><div class="dcr-op-body dcr-body"><p>Looks right to me\.<\/p>/s, 'an open row shows the full answer under it');
assert.equal((opened.match(/data-agent="grok"/g) || []).length, 1, 'an open opinion shows its mark once');
assert.equal((opened.match(/<strong>Grok<\/strong>/g) || []).length, 1, 'and its name once');
assert.equal(tools.consensus({total:2, agree:2, partly:0, disagree:0}), 'Everyone agrees');
assert.equal(tools.opinionsHTML({messages:[]}), '', 'no opinions, no section');
const checking = tools.statusModel({...debated, messages:[], waiting_on:['codex', 'gemini']}, true);
assert.deepEqual([checking.text, checking.agent, checking.typing], ['Codex is checking this comment', 'codex', true]);
const quiet = {...debated, messages:[], waiting_on:['codex', 'gemini'], asked_at:'2026-10-07T11:40:00Z'};
assert.equal(tools.statusModel(quiet, true, Date.parse('2026-10-07T11:45:00Z')).typing, true, 'a second reviewer asked minutes ago is still checking');
const lost = tools.statusModel(quiet, true, Date.parse('2026-10-07T12:00:00Z'));
assert.equal(lost.tone, 'idle', 'a second reviewer silent past every timeout is not shown as typing');
assert.match(lost.text, /Codex was asked to check this comment 20 min ago and has not answered.*run it again/);
const lostRows = tools.opinionsHTML(quiet, {now: Date.parse('2026-10-07T12:00:00Z')});
assert.match(lostRows, /is-failed[^>]*>.*Gemini.*did not answer/s, 'a side opinion that never came reads as not answered');
assert.doesNotMatch(lostRows, /is reading the code/);
assert.equal(tools.agentModel({}, true, Date.now(), {}, 'claude').text, 'Claude listening');
const asked = tools.sendText(snapshot, review, comments[0], '', debated);
assert.match(asked, /Second opinions from other agents:\n- Codex \(second reviewer, disagrees\): The cap is already enforced/);
assert.match(asked, /- Grok \(agrees\): Looks right to me\./);
assert.doesNotMatch(asked, /took longer/, 'failures are not sent as opinions');
console.log('PASS agents are named with their marks; the second reviewer joins the conversation and the others are rows under it, each named once, sent along when you ask your agent');

// Adversaries: the agent card and the + on a question.
const chosen = [{agent:'codex', model:null, effort:null}, {agent:'claude', model:null, effort:null}, {agent:'opencode', model:'opencode/big-pickle', effort:null}];
assert.deepEqual(tools.activeAdversaries(chosen, 'claude').map(entry => entry.agent), ['codex', 'opencode'], 'the agent running the review is left out on its own settings');
assert.deepEqual(tools.activeAdversaries([{agent:'claude', model:'opus'}], 'claude').map(entry => entry.agent), ['claude'], 'and kept on a model the reviewer named');
assert.deepEqual(tools.activeAdversaries(chosen, 'claude', [{slug:'codex', installed:false}, {slug:'opencode', installed:true}]).map(entry => entry.agent), ['opencode'], 'only an installed agent is asked');
const many = tools.facesHTML(['codex', 'grok', 'gemini', 'antigravity', 'opencode'], 3);
assert.equal((many.match(/data-agent=/g) || []).length, 2, 'past the few that fit, the marks give way to a count');
assert.match(many, /dcr-stack-more">\+3</, 'every adversary is counted, however many');
const noon = Date.parse('2026-10-09T12:00:00Z');
assert.deepEqual([tools.agentStatus({ready:true}).text, tools.agentStatus({ready:false, bin:'agy'}).text, tools.agentStatus({ready:null}).text], ['Ready', 'Signed out', 'Installed']);
assert.match(tools.agentStatus({ready:false, bin:'agy'}).hint, /Run `agy` once/);
assert.equal(tools.agentStatus({ready:null, last:{ok:true, at:'2026-10-09T10:00:00Z'}}, noon).text, 'Ready', 'a CLI with no status command is ready once it answered');
assert.equal(tools.agentStatus({ready:null, last:{ok:false, error:'Grok is not signed in.'}}).text, 'Last try failed');
const opencode = {slug:'opencode', name:'opencode', installed:true, models:[{id:'openai/gpt-5.5'}, {id:'opencode/exo-free', free:true}], efforts:[], suggested:'opencode/big-pickle'};
const options = tools.modelOptionsHTML(opencode, 'opencode/big-pickle');
assert.match(options, /^<optgroup label="Free">.*exo-free.*<\/optgroup><optgroup label="Other models">.*opencode\/big-pickle" selected.*gpt-5\.5/s, 'free models come first, and the suggested one is offered even when the CLI did not list it');
assert.doesNotMatch(options, /Default model/, 'no vague "default" choice when the CLI lists its models');
assert.match(tools.modelOptionsHTML(opencode, null), /^<option value="" selected>Pick a model<\/option>/, 'an agent left without a model asks for one');
const codex = {slug:'codex', name:'Codex', installed:true, ready:true, efforts:[], models:[{id:'gpt-a', efforts:['low', 'high']}, {id:'gpt-b', efforts:['medium', 'high', 'xhigh']}]};
assert.deepEqual(tools.effortLevels(codex, 'gpt-a'), ['low', 'high'], 'a model offers the efforts it takes');
assert.deepEqual(tools.effortLevels(codex, null), ['low', 'high', 'medium', 'xhigh'], 'the default model offers every effort the models take');
assert.equal(tools.effortOptionsHTML(opencode, 'opencode/big-pickle', null), '', 'no effort to choose when the CLI takes none');
const catalog = [{slug:'claude', name:'Claude', installed:true, ready:true}, codex, opencode, {slug:'gemini', name:'Gemini', installed:false}];
const panel = tools.adversaryPanelHTML({catalog, adversaries:[{agent:'opencode', model:'opencode/big-pickle', effort:null}, {agent:'codex', model:null, effort:'high'}], author:'claude', now: noon});
assert.deepEqual([...panel.matchAll(/data-agent="(\w+)"><label/g)].map(match => match[1]), ['claude', 'codex', 'opencode'], 'rows keep their place, whatever is on');
assert.match(panel, /2 on/);
assert.match(panel, /Runs this review: it checks itself only on a model you pick/, 'the running agent says why it is different');
assert.match(panel, /opencode answers in each comment's conversation; Codex weighs in beside it/, 'one line says the order');
assert.match(panel, /data-dcr-adv-effort[^>]*>.*value="high" selected/s, 'a row that is on shows its model and effort');
assert.match(panel, /Not found here: Gemini/);
assert.match(tools.adversaryPanelHTML({catalog:null}), /Looking for agents/);
assert.match(tools.adversaryPanelHTML({catalog, adversaries:[], author:'claude'}), /none is on until you choose/, 'none is on until chosen');
// A question asked of agents that already answered: they read again, and nobody is "checking this comment".
const reasked = {...debated, waiting_on:['codex', 'grok'], asked_at:'2026-10-09T11:59:00Z'};
assert.notEqual(tools.statusModel(reasked, true, noon)?.text, 'Codex is checking this comment', 'a second reviewer that already answered is not shown checking again');
const rereading = tools.opinionsHTML(reasked, {now: noon});
['Codex', 'Grok'].forEach(name => assert.match(rereading, new RegExp(`is-waiting"><span[^>]*>.*?</span><span class="dcr-op-line"><strong>${name}</strong><span class="dcr-op-note">is reading the code`), `asked again, ${name} shows as reading until its new answer`));
// Real choices instead of "default": what the CLI says it runs, else the first it lists; medium effort when it does not say.
const grokAgent = {slug:'grok', efforts:['low', 'medium', 'high'], models:[{id:'grok-4.6'}, {id:'grok-4.7', default:true}], default_model:'grok-4.7'};
assert.deepEqual(tools.settle(grokAgent, {agent:'grok', model:null, effort:null}), {agent:'grok', model:'grok-4.7', effort:'medium'});
assert.match(tools.modelOptionsHTML(grokAgent, 'grok-4.7'), /grok-4\.7 · default/, 'the CLI default is marked');
const codexAgent = {slug:'codex', efforts:[], default_model:'gpt-b', default_effort:'xhigh', models:[{id:'gpt-a', efforts:['low', 'high']}, {id:'gpt-b', efforts:['medium', 'xhigh']}]};
assert.deepEqual(tools.settle(codexAgent, {agent:'codex', model:null, effort:null}), {agent:'codex', model:'gpt-b', effort:'xhigh'}, "Codex's own config decides");
assert.deepEqual(tools.settle(codexAgent, {agent:'codex', model:'gpt-a', effort:'xhigh'}), {agent:'codex', model:'gpt-a', effort:'low'}, 'an effort the model does not take becomes one it does');
assert.deepEqual(tools.settle({slug:'antigravity', efforts:['low', 'medium'], models:[{id:'m1'}, {id:'m2'}]}, {agent:'antigravity'}), {agent:'antigravity', model:'m1', effort:'medium'}, 'with no default said, the first model it lists');
console.log('PASS adversaries: who is asked, their marks, their status, models and efforts from the CLIs, and the card that sets them');
