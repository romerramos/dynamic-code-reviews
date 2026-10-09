/* Node built-ins only; the ignore-whitespace view of diff rows. */
'use strict';
const assert = require('node:assert/strict');
require('../assets/review-tools.js');
const tools = globalThis.ReviewTools;

const unified = [
  {kind:'context', old:1, new:1, text:'a'},
  {kind:'del', old:2, text:'  x = 1'}, {kind:'del', old:3, text:'y=2'},
  {kind:'add', new:2, text:'x   =   1'}, {kind:'add', new:3, text:'y = 2'},
  {kind:'context', old:4, new:4, text:'b'},
  {kind:'del', old:5, text:'old()'}, {kind:'add', new:5, text:'new()'}
];
const frozen = JSON.stringify(unified);
assert.equal(tools.displayRows(unified, 'unified', false), unified, 'off returns the same rows');
const shown = tools.displayRows(unified, 'unified', true);
assert.deepEqual(shown.slice(0, 3).map(row => [row.kind, row.old, row.new]), [['context', 1, 1], ['context', 2, 2], ['context', 3, 3]]);
assert.equal(shown[1].text, 'x   =   1', 'the new text is shown for a whitespace-only change');
assert.deepEqual(shown.slice(4).map(row => row.kind), ['del', 'add'], 'a real change stays a change');
assert.equal(JSON.stringify(unified), frozen, 'captured rows are never modified');
console.log('PASS whitespace-only replacements become context with both line numbers while real changes stay');

const mixed = [{kind:'del', old:1, text:'a b'}, {kind:'del', old:2, text:'c'}, {kind:'add', new:1, text:'ab'}, {kind:'add', new:2, text:'changed'}];
const folded = tools.displayRows(mixed, 'unified', true);
assert.deepEqual(folded.map(row => row.kind), ['context', 'del', 'add'], 'a reindented line folds even beside a real change');
assert.deepEqual([folded[0].old, folded[0].new, folded[1].old, folded[2].new], [1, 1, 2, 2]);
const interleaved = [{kind:'del', old:1, text:'a'}, {kind:'del', old:2, text:'b'}, {kind:'del', old:3, text:'c'}, {kind:'add', new:1, text:'A'}, {kind:'add', new:2, text:' b'}, {kind:'add', new:3, text:'C'}];
assert.deepEqual(tools.displayRows(interleaved, 'unified', true).map(row => row.kind + (row.old ?? '') + (row.new ?? '')), ['del1', 'add1', 'context22', 'del3', 'add3'].map(x => x), 'real changes around a folded line stay grouped as removals then additions');
const uneven = [{kind:'del', old:1, text:'x'}, {kind:'add', new:1, text:'x'}, {kind:'add', new:2, text:'y'}];
assert.deepEqual(tools.displayRows(uneven, 'unified', true).map(row => row.kind), ['context', 'add'], 'blocks of different sizes are matched line by line, like git diff -w');
// A block wrapped in a new condition: every line re-indented, two really changed.
const body = ['<span class="chip">', '<button data-action="old#open">', '<%= label %>', '</button>', '<%= link_to list_path %>', '</span>'];
const wrapped = [
  ...body.map((text, at) => ({kind:'del', old:20 + at, text:`      ${text}`})),
  {kind:'add', new:20, text:'      <% if selected.any? %>'},
  ...body.map((text, at) => ({kind:'add', new:21 + at, text:`        ${text.replace('old#open', 'filters#open').replace('list_path', 'without_assignee_path')}`})),
  {kind:'add', new:27, text:'      <% end %>'}
];
assert.deepEqual(tools.displayRows(wrapped, 'unified', true).map(row => `${row.kind}${row.old ?? ''}/${row.new ?? ''}`),
  ['add/20', 'context20/21', 'del21/', 'add/22', 'context22/23', 'context23/24', 'del24/', 'add/25', 'context25/26', 'add/27'],
  'a re-indented block inside a new wrapper shows only the wrapper and the lines that really changed');
const pureAdd = [{kind:'add', new:1, text:'  '}];
assert.deepEqual(tools.displayRows(pureAdd, 'unified', true).map(row => row.kind), ['add'], 'an added blank line is still a change');
console.log('PASS a reindented line folds beside a real change, re-indented blocks show only real changes, added lines are never hidden');

const split = [
  {old:{kind:'del', old:1, text:'\tfoo()'}, new:{kind:'add', new:1, text:'  foo()'}},
  {old:{kind:'del', old:2, text:'bar'}, new:{kind:'add', new:2, text:'baz'}},
  {old:null, new:{kind:'add', new:3, text:'extra'}},
  {old:{kind:'context', old:4, new:4, text:'same'}, new:{kind:'context', old:4, new:4, text:'same'}}
];
const splitShown = tools.displayRows(split, 'split', true);
assert.deepEqual([splitShown[0].old.kind, splitShown[0].new.kind, splitShown[0].old.old, splitShown[0].new.new], ['context', 'context', 1, 1]);
assert.deepEqual([splitShown[1].old.kind, splitShown[1].new.kind], ['del', 'add']);
assert.deepEqual(splitShown[2], {old:null, new:split[2].new}, 'an unpaired addition stays on its own');
assert.deepEqual([splitShown[3].old.kind, splitShown.length], ['context', 4]);
const splitWrapped = tools.displayRows([{old:{kind:'del', old:1, text:'  a'}, new:{kind:'add', new:1, text:'<% if x %>'}}, {old:null, new:{kind:'add', new:2, text:'    a'}}, {old:null, new:{kind:'add', new:3, text:'<% end %>'}}], 'split', true);
assert.deepEqual(splitWrapped.map(row => [row.old?.kind ?? null, row.new?.kind ?? null]), [[null, 'add'], ['context', 'context'], [null, 'add']], 'split rows are matched across the block, not only side by side');
console.log('PASS split rows fold across the block and keep unpaired and different lines');

// Anchors are computed from the captured rows, so a comment on a folded line still resolves.
const snapshot = {files:[{id:'f', path:'a.rb', hunks:[{id:'h', rows:{unified}}]}]};
assert.equal(tools.anchor(snapshot, {hunk:'h', side:'new', start:2, end:3})?.lines.length, 2);
console.log('PASS comment anchors still resolve on lines folded by the whitespace option');

// The composer's single text box: headline first, detail after.
assert.deepEqual(tools.splitComment('  Rename this\n\nIt reads oddly next to `items`.\nAnd the spec.  '), {subject:'Rename this', discussion:'It reads oddly next to `items`.\nAnd the spec.'});
assert.deepEqual(tools.splitComment('Just a headline'), {subject:'Just a headline', discussion:''});
assert.deepEqual(tools.splitComment('   '), {subject:'', discussion:''});
const long = 'word '.repeat(40).trim();
const cut = tools.splitComment(long);
assert.ok(cut.subject.length <= 140 && cut.subject.length > 100 && !cut.subject.endsWith(' ') && (cut.subject + ' ' + cut.discussion).replace(/\s+/g, ' ') === long, 'a long single line is cut at a word and nothing is lost');
assert.deepEqual(tools.splitComment('x'.repeat(200)).subject.length, 140, 'with no spaces it is cut at 140');
assert.equal(tools.splitComment('x'.repeat(200)).discussion.length, 60);
console.log('PASS the composer splits one text box into a headline and detail without losing any text');
