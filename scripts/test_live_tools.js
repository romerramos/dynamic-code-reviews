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
console.log('PASS drafts exclude findings, sent and resolved comments, and a private note does not send');

const text = tools.sendText(snapshot, review, comments[0], '  please check the caller too ');
assert.match(text, /File: app\/a\.rb/);
assert.match(text, /x = 2/, 'the captured code is included');
assert.match(text, /issue \(blocking\): Unbounded/);
assert.match(text, /Reviewer's message:\nplease check the caller too$/);
assert.ok(!/Conversation: resolved/.test(tools.sendText(snapshot, review, {...comments[0], resolved:true})), 'resolution state is not sent to the agent');
assert.ok(!tools.sendText(snapshot, review, comments[0]).includes("Reviewer's message"));
console.log('PASS the first send carries captured code, the comment and the reader note, reusing Copy for LLMs formatting');

assert.equal(tools.actionLabel(undefined), 'Send to agent');
assert.equal(tools.actionLabel({live:true}), 'Reply');
console.log('PASS the action is Send to agent until the comment is with the agent, then Reply');

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
