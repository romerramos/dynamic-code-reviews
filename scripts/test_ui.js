/* Node built-ins only; exercises category boundaries and copyable evidence. */
'use strict';
const assert = require('node:assert/strict');
require('../assets/review-tools.js');
const tools = globalThis.ReviewTools;
require('./test_navigation');
const componentFiles = new Map([
  ['ruby', {path:'app/components/back_office/message_component.rb'}],
  ['erb', {path:'app/components/back_office/message_component.html.erb'}],
  ['other', {path:'app/components/customer/message_component.html.erb'}],
  ['view', {path:'app/views/message_component.html.erb'}]
]);
const componentItems = ['erb','other','ruby','view'].map(file => ({file}));
const pairs = tools.componentGroups(componentItems, componentFiles);
assert.equal(pairs.length, 1);
assert.equal(pairs[0].name, 'MessageComponent');
assert.equal(pairs[0].namespace, 'BackOffice');
assert.deepEqual(pairs[0].items.map(item => item.file), ['ruby','erb']);
assert.equal(tools.componentGroups([componentItems[0]], componentFiles).length, 0);
assert.deepEqual(componentItems.map(item => item.file), ['erb','other','ruby','view']);
console.log('PASS component pairs respect directory and layer boundaries without changing source order');
assert.equal(tools.category('app/views/rentals/show.html.erb'), 'Design / UI');
assert.equal(tools.category('app/assets/stylesheets/rentals.scss'), 'Design / UI');
assert.equal(tools.category('app/javascript/controllers/rental_controller.js'), 'Frontend');
assert.equal(tools.category('app/javascript/controllers/rental_controller.js', {'app/javascript/controllers/rental_controller.js':'Design / UI'}), 'Frontend');
assert.equal(tools.category('app/helpers/rentals_helper.rb'), 'Frontend');
assert.equal(tools.category('app/controllers/rentals_controller.rb'), 'Backend');
assert.equal(tools.category('app/controllers/rentals_controller.rb', {'app/controllers/rentals_controller.rb':'Frontend'}), 'Frontend');
assert.equal(tools.category('test/controllers/rentals_controller_test.rb'), 'Tests');
assert.equal(tools.category('app/policies/rental_policy.rb'), 'Security');
assert.equal(tools.category('docs/setup.md'), 'Documentation');
assert.equal(tools.category('AGENTS.md'), 'AI');
assert.equal(tools.category('db/schema.rb'), 'Backend');
assert.equal(tools.category('db/structure.sql'), 'Backend');
assert.equal(tools.category('db/migrate/20260907120000_add_permissions.rb'), 'Backend');
assert.equal(tools.category('config/routes.rb'), 'Backend');
assert.equal(tools.category('.github/workflows/test.yml'), 'Platform');
assert.equal(tools.category('config/environments/development.rb'), 'Platform');
assert.equal(tools.category('vite.config.js'), 'Platform');
assert.equal(tools.category('data/catalog.yml'), 'Other');
console.log('PASS responsibility grouping keeps behavior out of Design / UI');
const snapshot = {head:'abc123',base:'old123',created:'2026-09-07',mode:'uncommitted',fingerprint:'snapshot1',files:[{path:'app/example.rb',hunks:[{id:'h1',rows:{unified:[{kind:'context',old:9,new:10,text:'before()'},{kind:'del',old:10,text:'unsafe()'},{kind:'add',new:11,text:'safe()'},{kind:'add',new:12,text:'~~~~'},{kind:'context',old:11,new:13,text:'after()'}]}}]}]};
const comment = {hunk:'h1',side:'new',start:11,end:12,label:'suggestion',decoration:'non-blocking',subject:'Check the fallback',discussion:'Use the existing behavior.'};
const copied = tools.commentText(snapshot, comment);
assert.match(copied, /File: app\/example.rb/);
assert.match(copied, /After lines 11–12/);
assert.match(copied, /working tree captured at 2026-09-07/);
assert.match(copied, /11 \| safe\(\)/);
assert.match(copied, /~~~~~\n11/);
assert.ok(!copied.includes('unsafe()'));
assert.ok(!copied.includes('after()'));
assert.match(copied, /suggestion \(non-blocking\): Check the fallback/);
assert.match(tools.commentText(snapshot, {...comment,side:'old',start:10,end:10}), /10 \| unsafe\(\)/);
assert.equal(tools.anchor(snapshot,{...comment,end:15}), null);
assert.throws(()=>tools.commentText(snapshot,{...comment,hunk:'missing'}));
console.log('PASS copy includes exact source side, lines, snippet and comment');
const combined = tools.reviewText(snapshot,[comment],[{title:'Extra checks',paths:['app/example.rb'],text:'A step note'}]);
assert.match(combined,/Snapshot: snapshot1/);
assert.match(combined,/Step: Extra checks/);
assert.match(combined,/A step note/);
const resolved = tools.reviewText(snapshot,[{...comment,resolved:true}]);
assert.match(resolved,/Conversation: resolved locally \(not verification that the code was fixed\)/);
assert.match(resolved,/11 \| safe\(\)/);
assert.match(resolved,/Check the fallback/);
console.log('PASS combined review retains comments and personal step notes');
const issue = {id:'c1', label:'issue', hunk:'h1'};
const finding = {id:'F1', hunk:'h1', severity:'P2'};
const review = {comments:[issue],findings:[finding]};
assert.deepEqual(tools.overviewFeedback(review), {comments:[{...issue,severity:'P2'}],findings:[]});
assert.equal(issue.severity, undefined);
assert.equal(tools.overviewFeedback({comments:[{...issue,label:'note'}],findings:[finding]}).findings.length,1);
assert.equal(tools.overviewFeedback({comments:[issue],findings:[finding,{...finding,id:'F2'}]}).findings.length,2);
assert.equal(tools.overviewFeedback({comments:[issue,{...issue,id:'c2'}],findings:[finding]}).findings.length,1);
assert.equal(tools.overviewFeedback({comments:[issue,{...issue,id:'c2'}],findings:[{...finding,comment_id:'c1'}]}).findings.length,0);
assert.equal(tools.overviewFeedback({comments:[issue],findings:[{...finding,comment_id:'missing'}]}).findings.length,1);
assert.deepEqual(tools.overviewFeedback({}),{comments:[],findings:[]});
console.log('PASS overview deduplicates only matching issues and retains unmatched findings');
const endpoints = {mode:'pr',base:'abcdef123',head:'123456789'};
const comparison = {base:endpoints.base,head:endpoints.head,base_label:'main',head_label:'feat/inbox',pr_number:123};
assert.match(tools.comparisonText(endpoints,{comparison}), /PR #123 · feat\/inbox compared with main/);
assert.match(tools.comparisonText({...endpoints,head:'newhead123'},{comparison}), /newhead1 compared with abcdef12/);
assert.match(tools.comparisonText({...endpoints,mode:'uncommitted'},{comparison}), /^Uncommitted changes .*HEAD$/);
assert.match(tools.comparisonText({...endpoints,mode:'commit'}), /^Commit review · 12345678 compared with abcdef12/);
assert.match(tools.comparisonText({...endpoints,mode:'series',working_tree:true},{comparison,history:{origin_mode:'uncommitted'}}), /^Cumulative review · committed and uncommitted changes compared with main$/);
assert.match(tools.comparisonText({...endpoints,mode:'series',working_tree:false},{comparison,history:{origin_mode:'pr'}}), /^PR #123/);
assert.match(tools.comparisonText({...endpoints,mode:'series',working_tree:false}), /^Cumulative review/);
const qa = {flows:[{assets:[{comment_id:'c1'},{comment_id:'c1'}]},{assets:[]},{assets:[{comment_id:'c1'}]}]};
assert.deepEqual(tools.evidenceFlows(qa,{id:'c1'}),[0,2]);
assert.deepEqual(tools.evidenceFlows(qa,{id:'c1',personal:true}),[]);
assert.deepEqual(tools.evidenceFlows(undefined,{id:'c1'}),[]);
console.log('PASS scope labels distinguish review modes and evidence links target unique flows');
const evidenceComment = {...comment,id:'c1',discussion:''};
const evidenceQA = {flows:[{comment_id:'c1',steps:['Open the list.','Reopen the conversation.'],expected:'Row returns.',observed:'Row is missing.',assets:[]}]};
const post = tools.postingText(snapshot,evidenceComment,evidenceQA);
assert.match(post,/File: app\/example.rb \(after lines 11–12\)/);
assert.match(post,/1\. Open the list\.\n2\. Reopen the conversation\./);
assert.match(post,/Expected: Row returns\.\nActual: Row is missing\./);
assert.ok(!post.includes('safe()') && !post.includes('Source:') && !post.includes('resolved locally'));
assert.match(tools.commentText(snapshot,evidenceComment,evidenceQA),/11 \| safe\(\)/);
assert.match(tools.commentText(snapshot,evidenceComment,evidenceQA),/2\. Reopen the conversation\./);
const general = {id:'mine-general',general:true,personal:true,label:'question',decoration:'non-blocking',subject:'Check the empty list',discussion:'Can we clarify the empty state?',resolved:true};
assert.match(tools.commentText(snapshot,general),/General comment · abc123/);
assert.match(tools.commentText(snapshot,general),/resolved locally/);
assert.ok(!tools.postingText(snapshot,general).includes('File:'));
assert.ok(!tools.postingText(snapshot,general).includes('resolved locally'));
const allUser = tools.reviewText(snapshot,[general,{...comment,personal:true}],[{title:'Step',paths:['app/example.rb'],text:'Keep this note'}]);
assert.match(allUser,/Check the empty list/);assert.match(allUser,/11 \| safe\(\)/);assert.match(allUser,/Keep this note/);
assert.deepEqual(tools.evidenceFlows(evidenceQA,evidenceComment),[0]);
assert.equal(tools.flowOwner({comment_id:'c1',assets:[{comment_id:'c2'}]}),'c1');
assert.equal(tools.flowOwner({assets:[{comment_id:'c1'},{comment_id:'c2'}]}),'c1');
console.log('PASS posting and LLM copies retain reproduction; general and anchored user comments combine safely');

const testLayer = {items:[{file:'capture'}, {file:'capture-test'}, {file:'send'}, {file:'send-test'}, {file:'display'}],
  related_tests:[{title:'Reply acceptance',summary:'Accepted replies create one event.',entities:['capture','send'],files:['capture-test','send-test']}]};
const walkthrough = tools.walkthroughSections(testLayer);
assert.deepEqual(walkthrough.map(section => section.item?.file || section.tests.title), ['capture','send','Reply acceptance','display']);
assert.deepEqual(walkthrough[2].items.map(item=>item.file), ['capture-test','send-test']);
assert.deepEqual(walkthrough.flatMap(section=>section.items || [section.item]).map(item=>item.file).sort(), testLayer.items.map(item=>item.file).sort());
assert.deepEqual(tools.walkthroughSections({items:testLayer.items}), testLayer.items.map(item=>({item})));
console.log('PASS related tests follow their last entity and retain every file exactly once');

const progressSnapshot = {files:[{id:'a',path:'app/shared.rb'},{id:'b',path:'test/shared_test.rb'},{id:'c',path:'docs/notes.md'}]};
const progressLayers = [{id:'g0l0',items:[{file:'a'},{file:'b'}]},{id:'g1l0',items:[{file:'a'},{file:'c'}]}];
assert.deepEqual(tools.viewedFiles(progressSnapshot,progressLayers,{viewed:['g0l0']}), ['test/shared_test.rb']);
assert.deepEqual(tools.viewedFiles(progressSnapshot,progressLayers,{viewed:['g0l0','g1l0']}), progressSnapshot.files.map(f=>f.path));
assert.deepEqual(tools.viewedFiles(progressSnapshot,progressLayers,{viewed:['g0l0'],viewedFiles:[]}), []);
const restored = JSON.parse(JSON.stringify({viewedFiles:['app/shared.rb','app/shared.rb','no-longer-present.rb'],fileOpen:{'app/shared.rb':false},notes:{g0l0:'Resume here'}}));
const viewed = tools.viewedFiles(progressSnapshot,progressLayers,restored);
assert.deepEqual(viewed,['app/shared.rb']);
assert.deepEqual(tools.fileProgress(['app/shared.rb','app/shared.rb','test/shared_test.rb'],viewed),{total:2,viewed:1});
assert.deepEqual(tools.fileProgress([],viewed),{total:0,viewed:0});
assert.equal(restored.notes.g0l0,'Resume here');
console.log('PASS file progress survives storage, deduplicates shared files and migrates only fully reviewed legacy files');

const focusLayers = [
  {id:'first', items:[{file:'b'},{file:'test'},{file:'a'}], related_tests:[{entities:['a'],files:['test']}]},
  {id:'second',items:[{file:'a'},{file:'c'}]}
];
const focusFiles = new Map([['b',{path:'app/b.rb'}],['test',{path:'test/b_test.rb'}],['a',{path:'app/a.rb'}],['c',{path:'app/c.rb'}]]);
assert.deepEqual(tools.focusFiles(focusLayers,focusFiles).map(entry => [entry.layer.id,entry.file]), [['first','b'],['first','a'],['first','test'],['second','c']]);
const sharedGroup = {title:'One review group'};
const groupedLayers = [
  {id:'code-step',group:sharedGroup,items:[{file:'test'},{file:'b'}]},
  {id:'more-code',group:sharedGroup,items:[{file:'c'},{file:'a'}]}
];
const firstStep = tools.layerFiles(groupedLayers[0],focusFiles);
assert.deepEqual(firstStep.code, ['b']);
assert.deepEqual(firstStep.tests, ['test']);
assert.deepEqual(tools.focusFiles(groupedLayers,focusFiles).map(entry=>entry.file), ['b','test','c','a']);
const componentOrder = {items:[{file:'template'},{file:'controller'},{file:'test'}], related_tests:[{entities:['controller'],files:['test']}]} ;
const componentOrderFiles = new Map([['template',{path:'app/components/example_component.html.erb'}],['controller',{path:'app/components/example_component.rb'}],['test',{path:'test/components/example_component_test.rb'}]]);
assert.deepEqual(tools.sidebarFiles(componentOrder,componentOrderFiles), ['controller','template','test']);
assert.deepEqual(tools.focusFiles([{id:'component',...componentOrder}],componentOrderFiles).map(entry=>entry.file), ['controller','template','test']);
console.log('PASS file-by-file order matches each step-end Tests divider and paired components');
const middleHunk = {id:'fh1',old_start:3,old_count:1,new_start:3,new_count:2,rows:{unified:[{kind:'del',old:3,text:'old'},{kind:'add',new:3,text:'new'},{kind:'add',new:4,text:'extra'}]}};
const full = tools.fullFileHunks({id:'f',source:{old:'one\ntwo\nold\nfour',new:'one\ntwo\nnew\nextra\nfour'},hunks:[middleHunk]});
assert.equal(full[1],middleHunk);
assert.deepEqual(full.flatMap(h => h.rows.unified).filter(r=>r.old).map(r=>[r.old,r.text]), [[1,'one'],[2,'two'],[3,'old'],[4,'four']]);
assert.deepEqual(full.flatMap(h => h.rows.unified).filter(r=>r.new).map(r=>r.new),[1,2,3,4,5]);
const fullSnapshot = {files:[{id:'f',path:'app/example.rb',source:{old:'one\ntwo\nold\nfour',new:'one\ntwo\nnew\nextra\nfour'},hunks:[middleHunk]}]};
const fullRange = {hunk:'full:f',side:'new',start:2,end:5};
assert.deepEqual(tools.anchor(fullSnapshot,fullRange).lines.map(line=>line.text),['two','new','extra','four']);
assert.match(tools.sourceText(fullSnapshot,fullRange),/2 \| two\n3 \| new\n4 \| extra\n5 \| four/);
assert.equal(tools.anchor(fullSnapshot,{...fullRange,end:6}),null);
assert.equal(tools.anchor({files:[{...fullSnapshot.files[0],source:null}]},fullRange),null);
console.log('PASS full-file comment anchors cross changed and unchanged lines without extending past captured source');
assert.equal(tools.fullFileHunks({hunks:[]}),null);
assert.throws(()=>tools.fullFileHunks({id:'x',source:{old:'wrong',new:'other'},hunks:[]}));
for (const [oldText,newText,oldCount,newCount] of [['','new',0,1],['old','',1,0]]) {
 const h = {id:'add-delete',old_start:oldCount,old_count:oldCount,new_start:newCount,new_count:newCount};
 assert.deepEqual(tools.fullFileHunks({id:'edge',source:{old:oldText,new:newText},hunks:[h]}),[h]);
}
console.log('PASS focus preserves walkthrough order and complete source line coverage');
