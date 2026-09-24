'use strict';
const assert = require('node:assert/strict');
require('../assets/review-tools.js');
const tools = globalThis.ReviewTools;
const snapshot = {repo:'/tmp/example project', fingerprint:'snapshot-a', head:'head-a', base:'base-a', mode:'uncommitted', files:[
  {path:'app/views/a.html.erb'}, {path:'app/views/b.html.erb'},
  {path:'app/views/gone.html.erb',patch:'deleted file mode 100644\n'},
  {path:'app/models/item.rb'}, {path:'app/components/item_component.rb'}
]};
const review = {history:{series:'example-review', revision:2}, previews:[{files:['app/views/b.html.erb'],status:'rendered'}]};
const selected = ['app/views/a.html.erb','app/views/a.html.erb','app/views/b.html.erb','app/views/gone.html.erb','app/models/item.rb','unknown'];
assert.deepEqual(tools.pendingPreviews(snapshot,review,selected),['app/views/a.html.erb']);
assert.deepEqual(tools.pendingPreviews(snapshot,review,null),[]);
assert.deepEqual(tools.pendingPreviews(snapshot,{previews:[{files:['app/views/a.html.erb'],status:'unavailable'}]},selected),['app/views/a.html.erb','app/views/b.html.erb']);
const prompt=tools.visualPrompt(snapshot,review,{kind:'previews',paths:selected});
assert.ok(prompt.includes('/tmp/example project/.reviews/example-review/current.html'));
assert.ok(prompt.includes('"revision": 2') && prompt.includes('"snapshot": "snapshot-a"') && prompt.includes('"working_tree": true'));
assert.ok(prompt.includes('"app/views/a.html.erb"'));
for (const excluded of selected.slice(2)) assert.ok(!prompt.includes(`- "${excluded}"`));
assert.ok(prompt.includes('previews --targeted'));
assert.equal(selected.length,6);
assert.throws(()=>tools.visualPrompt(snapshot,review,{kind:'previews',paths:[]}));
const later={...review,history:{...review.history,revision:3},previews:[...review.previews,{files:['app/views/a.html.erb'],status:'rendered'}]};
assert.deepEqual(tools.pendingPreviews(snapshot,later,selected),[]);
const video=tools.visualPrompt(snapshot,review,{kind:'qa'});
assert.ok(video.includes('Choose a small set of meaningful checks'));
assert.ok(video.includes('findings, walkthroughs and changed user flows'));
assert.ok(video.includes('comment_id') && video.includes('successful walkthrough/flow checks'));
assert.ok(video.includes('short videos') && video.includes('before opening the recorder'));
assert.ok(!video.includes('previews --targeted'));
assert.throws(()=>tools.visualPrompt(snapshot,review,{kind:'unknown'}));
// Copying moves the selection into requests; the counter returns to zero.
const requestedState=tools.requestPreviews({previews:['app/views/a.html.erb'],requested:[{path:'app/views/a.html.erb',at:'old',revision:1}]},2,'now');
assert.deepEqual(requestedState,{previews:[],requested:[{path:'app/views/a.html.erb',at:'now',revision:2}]});
const waiting=tools.previewLifecycle(snapshot,review,requestedState);
assert.deepEqual(waiting.selected,[]);
assert.deepEqual(waiting.requested.map(item=>item.path),['app/views/a.html.erb']);
assert.deepEqual(waiting.ready.map(item=>[item.path,item.fresh]),[['app/views/b.html.erb',false]]);
// A later revision renders the request: it is ready and marked fresh until opened.
const arrived=tools.previewLifecycle(snapshot,later,requestedState);
assert.deepEqual(arrived.requested,[]);
assert.deepEqual(arrived.ready.map(item=>[item.path,item.fresh]),[['app/views/a.html.erb',true],['app/views/b.html.erb',false]]);
assert.equal(arrived.fresh,1);
// An unavailable record from before the request does not resolve it; a later one does.
const before={...review,previews:[{files:['app/views/a.html.erb'],status:'unavailable',note:'Needs a signed-in student'}]};
assert.deepEqual(tools.previewLifecycle(snapshot,before,requestedState).requested.map(item=>item.path),['app/views/a.html.erb']);
const failed=tools.previewLifecycle(snapshot,{...before,history:{...review.history,revision:3}},requestedState);
assert.deepEqual(failed.requested,[]);
assert.deepEqual(failed.unavailable,[{path:'app/views/a.html.erb',status:'unavailable',note:'Needs a signed-in student'}]);
// Unknown or ineligible stored paths are ignored.
assert.deepEqual(tools.previewLifecycle(snapshot,review,{requested:[{path:'app/models/item.rb'},{path:'nope'},null]}).requested,[]);
console.log('PASS preview lifecycle moves copied selections to requested, then ready or unavailable in a later revision');
console.log('PASS visual prompts preserve snapshot identity, select only pending templates, retain selections and keep QA driven by findings and changed flows');
