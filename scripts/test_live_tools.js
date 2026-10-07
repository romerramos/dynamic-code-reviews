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
assert.equal(tools.statusText({delivery:'delivered'}), 'Your agent has this');
assert.equal(tools.statusText({delivery:'draft'}), '');
const html = tools.messagesHTML({messages:[{author:'agent', body:'<img src=x onerror=alert(1)>'}, {author:'user', body:'ok & thanks'}]});
assert.ok(!html.includes('<img'), 'message text must be escaped');
assert.match(html, /dcr-agent[\s\S]*dcr-user/);
assert.match(html, /ok &amp; thanks/);
console.log('PASS messages render escaped, in order, with the agent distinguished');
