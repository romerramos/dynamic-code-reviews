/* DOM doubles exercise real navigation handlers without a browser dependency. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../assets/review-tools.js');
const calls = [];
const nodes = new Map();
function node(name) {
  return {value:'', textContent:'', innerHTML:'', dataset:{}, scrollTop:0,
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
  ReviewTools:globalThis.ReviewTools,
  document:{getElementById:get,querySelector:selector=>selector.includes('f2') ? plainCard : pairedCard,querySelectorAll:()=>[],body:node('body'),
    addEventListener(type,fn){(listeners[type] ||= []).push(fn);}},
  window:{ReviewIcons:{},addEventListener(){}},
  localStorage:{getItem:()=>null,setItem:(key,value)=>{stored=JSON.parse(value);}},
  matchMedia:()=>({matches:false,addEventListener(){}}),
  location:{hash:''},history:{replaceState(){}},
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
