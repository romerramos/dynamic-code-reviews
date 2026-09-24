'use strict';
// Exercise shutdown of the actual recorder scripts without browser capture permission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function shutdown(recoverable) {
  const nodes = new Map(), intervals = new Set(), events = new EventTarget();
  const element = () => ({hidden:false, textContent:'', children:[], addEventListener() {}, setAttribute() {}, append(child) { this.children.push(child); }});
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const classes = new Set();
  const body = element();
  body.classList = {contains:name=>classes.has(name), add:name=>classes.add(name), remove:name=>classes.delete(name)};
  const panel = element();
  panel.querySelector = node;
  node('#qa-artifacts').children = recoverable ? [element()] : [];
  let polls = 0;
  const finished = new Promise(resolve => events.addEventListener('qa-session-ended', resolve));
  const context = vm.createContext({
    document: {
      body,
      createElement: tag => tag === 'section' ? panel : element(),
      querySelector: selector => selector.startsWith('meta') ? {content:'token'} : null,
      getElementById: id => id === 'qa-panel' ? panel : null
    },
    window: events,
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } },
    fetch: async url => { if (url === '/next') { polls++; throw new Error('Server stopped'); } return {ok:true}; },
    setInterval: callback => { intervals.add(callback); return callback; },
    clearInterval: callback => intervals.delete(callback),
    setTimeout: callback => queueMicrotask(callback), clearTimeout() {},
  });
  for (const file of ['qa-panel.js','recorder.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../recorder',file),'utf8'), context);
  }
  assert.ok(classes.has('qa-live'));
  await finished;
  assert.equal(polls,3);
  assert.equal(intervals.size,0, 'Stopped sessions must release background timers');
  assert.ok(!classes.has('qa-live'), 'The offline Video QA banner must become visible again');
  assert.equal(panel.hidden,!recoverable, 'Unsaved recordings must remain reachable');
  assert.equal(node('.qa-primary').hidden,true, 'A stopped session must not offer tab sharing');
  assert.equal(node('#qa-connect').disabled,true);
}

(async () => {
  await shutdown(false);
  await shutdown(true);
  console.log('PASS recorder shutdown restores the offline QA banner, stops background work and retains recoverable recordings');
})().catch(error => { console.error(error); process.exitCode=1; });
