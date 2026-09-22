/* DOM doubles exercise real navigation handlers without a browser dependency. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../assets/review-tools.js');
const calls = [];
const nodes = new Map();
function node(name) {
  return {style:{setProperty(){}}, value:'', textContent:'', innerHTML:'', dataset:{}, scrollTop:0,
    classList:{remove(){},add(){},toggle(){}},
    addEventListener(){}, setAttribute(){}, matches(){return false;},
    querySelectorAll(){return [];}, querySelector(){return null;},
    scrollIntoView(options){calls.push([name,'scroll',options.block]);},
    focus(options){calls.push([name,'focus',options.preventScroll]);}};
}
const get = id => {
  if (!nodes.has(id)) nodes.set(id,node(id));
  return nodes.get(id);
};
const files = ['app/components/back_office/long_message_component.rb', 'app/components/back_office/long_message_component.html.erb', 'app/models/message.rb'].map((path,i)=>({id:`f${i}`,path,hunks:[],patch:'example'}));
const layer = {title:'Assign messages',items:files.map(file=>({file:file.id,summaries:{}}))};
const data = {snapshot:{repo:'/fixture',base:'12345678',head:'abcdef12',mode:'pr',fingerprint:'fixture',files},review:{title:'Example',summary:'Example',groups:[{title:'Assign messages',layers:[layer]},{title:'Other behavior',layers:[{title:'Other behavior',items:[layer.items[2]]}]}],comments:[],findings:[],sections:[]}};
get('data').textContent = JSON.stringify(data);
const header = node('component header');
const component = node('component section');
component.querySelector = () => header;
// Model the browser distinction: a pinned header moves only slightly, whereas
// the normal-flow section returns the scroll container to its actual start.
header.scrollIntoView = options => { calls.push(['component header','scroll',options.block]); get('content').scrollTop -= 8; };
const content = get('content');
let paddingTop = 30;
content.clientTop = 1;
content.getBoundingClientRect = () => ({top:141});
component.getBoundingClientRect = () => ({top:142 + 338 - content.scrollTop});
content.scrollTo = options => { calls.push(['content','scroll',options.top]); content.scrollTop = options.top; };
const summary = node('file summary');
const parentPanel = {tagName:'DETAILS',open:false,parentElement:null};
const pairedCard = {parentElement:null,closest(){return component;},querySelector(){return summary;}};
const plainCard = {parentElement:parentPanel,closest(){return null;},querySelector(){return summary;}};
let stored;
const listeners = {};
const sandbox = {
  cancelAnimationFrame(){}, requestAnimationFrame(){return 1;},
  ReviewTools:globalThis.ReviewTools,
  Prism:{languages:{}},
  document:{getElementById:get,querySelector:selector=>selector.includes('f2') ? plainCard : pairedCard,querySelectorAll:()=>[],body:node('body'),
    addEventListener(type,fn){(listeners[type] ||= []).push(fn);}},
  window:{ReviewIcons:{},addEventListener(){}},
  localStorage:{getItem:key=>key === 'dynamic-review:reading-mode' ? 'walkthrough' : null,setItem:(key,value)=>{stored=JSON.parse(value);}},
  matchMedia:()=>({matches:false,addEventListener(){}}),
  location:{hash:'#overview'},history:{replaceState(){}},
  GLightbox:()=>({on(){},close(){},lightboxOpen:false}),
  setTimeout,clearTimeout,console,
  getComputedStyle:()=>({paddingTop:String(paddingTop)})
};
vm.createContext(sandbox);
const source = fs.readFileSync(require.resolve('../assets/report.js'),'utf8');
// Expose the real closures, suppressing only the initial overview render.
vm.runInContext(source.replace(/  render\(\);\n\}\)\(\);\s*$/, '  globalThis.navigationTest = {renderNavigation, navigateFile, select, layers};\n})();'), sandbox);
const ui = sandbox.navigationTest;
ui.renderNavigation();
assert(!get('navigation').innerHTML.includes('data-component-link='), 'Overview should not expand every step');
ui.navigateFile(ui.layers[0], 'f1');
assert.deepEqual(calls, [['content','scroll',300],['component header','focus',true]], 'Scroll the section below the padded sticky boundary, then focus without another scroll');
assert.equal(stored.componentFiles['g0l0:back_office/long_message_component'],'f1');
assert.equal(stored.navFile,'f1');
let html = get('navigation').innerHTML;
assert.equal((html.match(/data-component-link=/g)||[]).length,1);
assert.equal((html.match(/Assign messages/g)||[]).length,1, 'Single-step title must not be duplicated');
assert(!/<li class="nav-component[^]*?<ul>/.test(html), 'Component files must not add another nested list');
assert(html.includes('data-file-link="f1"'), 'Template shortcut must remain directly reachable');
calls.length = 0;
const button = {dataset:{componentLink:'back_office/long_message_component',fileLayer:'g0l0'}};
const event = {target:{closest:selector=>selector==='[data-component-link]' ? button : null}};
get('content').scrollTop = 1500;
listeners.click[0](event);
assert.equal(get('content').scrollTop,300,'Clicking the same component from mid-file must return to its beginning');
assert.equal(stored.componentFiles['g0l0:back_office/long_message_component'],'f1','Component title must restore the last selected template');
assert.deepEqual(calls,[['content','scroll',300],['component header','focus',true]]);
calls.length=0;
get('content').scrollTop = 2500;
listeners.click[0](event);
assert.equal(get('content').scrollTop,300,'Repeated component navigation from the end must return to the same section start');
assert.deepEqual(calls,[['content','scroll',300],['component header','focus',true]]);
for (const padding of [24, 25, 0]) {
  paddingTop = padding;
  content.scrollTop = 2500;
  listeners.click[0](event);
  assert.equal(component.getBoundingClientRect().top - content.getBoundingClientRect().top - content.clientTop, padding + 8, 'Section start must clear the current responsive padding');
}
calls.length=0;
ui.navigateFile(ui.layers[0],'f2');
assert(parentPanel.open,'Test/file links must reveal containing disclosures');
assert.deepEqual(calls,[['file summary','scroll','start'],['file summary','focus',true]]);
ui.select('g1l0');
assert(!get('navigation').innerHTML.includes('data-component-link='),'Switching steps should collapse the previous file list');
get('search').value='LongMessageComponent';
ui.renderNavigation();
assert(get('navigation').innerHTML.includes('data-component-link='),'Component-name search must reveal its step');
console.log('PASS navigation reveals component controls, restores selection and keeps the sidebar shallow');
// A fresh report opens in full-file focus with Unified selected, while explicit
// Overview links retain their destination.
sandbox.location.hash = '';
sandbox.localStorage.getItem = () => null;
vm.runInContext(source.replace(/  render\(\);\n\}\)\(\);\s*$/, '  globalThis.focusTest = {render, renderHunk, hunkFiles, select, chooseReadingMode, fileReadingActive, selectedReadingMode:()=>focusMode, changedSectionPosition, updateChangeNavigation, jumpChangedSection};\n})();'), sandbox);
sandbox.focusTest.render();
assert.equal(get('focus').textContent, 'File by file');
assert(get('content').innerHTML.includes('focus-reader'));
assert(get('content').innerHTML.includes('Group 1 of 2'));
assert(get('content').innerHTML.includes('data-file-viewed="f0"'));
assert(!get('content').innerHTML.includes('Viewed & next'));
const headings = [100, 400, 700].map((top,i) => ({id:`anchor-${i}`,classList:{toggle(){}},getBoundingClientRect:()=>({top})}));
content.querySelectorAll = () => headings;
const previous = node('previous section'), next = node('next section');
sandbox.document.querySelector = selector => selector === '.focus-file-header' ? {getBoundingClientRect:()=>({bottom:192})} : selector.includes('"-1"') ? previous : next;
sandbox.focusTest.updateChangeNavigation();
assert(previous.disabled);
assert(!next.disabled);
assert.equal(get('change-position').textContent, 'Section 1 of 3');
headings.forEach((heading,i)=>heading.getBoundingClientRect=()=>({top:-500+i*300}));
sandbox.focusTest.updateChangeNavigation();
assert(!previous.disabled);
assert(next.disabled, 'Last section must not wrap to the beginning');
assert.equal(get('change-position').textContent, 'Section 3 of 3');
console.log('PASS focus defaults, original group orientation, independent Viewed and section boundaries');

assert(!get('content').innerHTML.includes('focus-file-picker'));
assert(get('content').innerHTML.includes('data-copy-file'));
// Reproduce an initially unpinned header and a long file with two changes.
content.scrollTop = 0;
content.clientHeight = 600;
content.scrollHeight = 3000;
const anchors = [250, 1100].map((top,i) => ({id:`anchor-${i}`,classList:{toggle(){}},getBoundingClientRect:()=>({top:top-content.scrollTop})}));
content.querySelectorAll = () => anchors;
sandbox.document.querySelector = selector => selector === '.focus-file-header' ? {getBoundingClientRect:()=>({bottom:content.scrollTop ? 192 : 222})} : selector.includes('"-1"') ? previous : next;
sandbox.focusTest.jumpChangedSection(1);
assert.equal(content.scrollTop, 900, 'One click must reach the second change and correct the moving sticky header');
assert(next.disabled, 'Second of two sections must be the final destination');
sandbox.focusTest.jumpChangedSection(-1);
assert.equal(content.scrollTop, 50, 'Previous returns directly to the first changed line');
const sampleHunk = {id:'test-hunk',old_start:1,new_start:1,old_count:2,new_count:2,rows:{unified:[{kind:'context',text:'context',old:1,new:1},{kind:'del',text:'before',old:2},{kind:'add',text:'after',new:2}]}};
sandbox.focusTest.hunkFiles.set(sampleHunk.id, {path:'file.txt'});
const sampleHtml = sandbox.focusTest.renderHunk(sampleHunk,'Explanation','file.txt','unified');
assert(!sampleHtml.includes('range-heading'), 'Notes must not insert rows into the source');
assert(sampleHtml.includes('class="code-row change-anchor" id="test-hunk"><td class="gutter del'));
assert(sampleHtml.includes('popover="auto"'));
assert(sampleHtml.includes('Read review note for this change'));
console.log('PASS one-click hunk navigation with sticky header, sidebar-only file selection and on-demand notes');

// Reaching the scroll limit must retain the clicked block, not infer another one.
content.scrollTop = 0;
content.scrollTo = options => { content.scrollTop = Math.max(0, Math.min(600, options.top)); };
sandbox.focusTest.jumpChangedSection(1);
assert.equal(get('change-position').textContent, 'Section 2 of 2');
assert(!previous.disabled, 'Previous stays usable when the final block cannot reach the sticky header');
sandbox.focusTest.jumpChangedSection(-1);
assert.equal(get('change-position').textContent, 'Section 1 of 2');
sampleHunk.rows.unified.push({kind:'context',text:'gap',old:3,new:3},{kind:'add',text:'later',new:4});
const multipleBlocks = sandbox.focusTest.renderHunk(sampleHunk,'Explanation','file.txt','unified');
assert.equal((multipleBlocks.match(/code-row change-anchor/g)||[]).length,2, 'Separate changes within one hunk need separate destinations');

// Overview and All changes are destinations, not changes to the reading preference.
content.querySelectorAll = () => [];
sandbox.document.querySelector = () => null;
sandbox.focusTest.select('files');
assert.equal(sandbox.focusTest.selectedReadingMode(), true);
assert.equal(sandbox.focusTest.fileReadingActive(), false);
sandbox.focusTest.select('g0l0');
assert.equal(sandbox.focusTest.fileReadingActive(), true);
sandbox.focusTest.chooseReadingMode(false);
sandbox.focusTest.select('files');
sandbox.focusTest.select('g0l0');
assert.equal(sandbox.focusTest.selectedReadingMode(), false);
assert.equal(sandbox.focusTest.fileReadingActive(), false);
console.log('PASS destination navigation preserves the selected reading mode');
