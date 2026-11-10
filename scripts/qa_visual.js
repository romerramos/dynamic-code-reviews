#!/usr/bin/env node
/* Visual QA of the review page: renders a made-up review (scripts/qa_fixture.rb) in every theme,
   light and dark, in each state below and at two laptop sizes, measures the page and asserts what
   must hold, and saves a screenshot of every combination with a contact sheet.

     node scripts/qa_visual.js [--out .reviews/qa/after] [--compare .reviews/qa/before]
                               [--themes aida,terminal,minimal] [--modes light,dark]
                               [--states overview,...] [--viewports 1440x900,1280x800] [--no-fail]

   Headless Chrome through its DevTools protocol (scripts/qa_browser.js); Ruby for the fixture and
   `bin/dcr serve`. Nothing here ships with the skill. Exits 1 when an assertion fails. */
'use strict';
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {launch, sleep} = require('./qa_browser');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const list = (name, fallback) => option(name, fallback).split(',').filter(Boolean);
const OUT = path.resolve(option('out', path.join(ROOT, '.reviews/qa/after')));
const COMPARE = option('compare', null) && path.resolve(option('compare'));
const THEMES = list('themes', 'aida,terminal,minimal');
const MODES = list('modes', 'light,dark');
const VIEWPORTS = list('viewports', '1440x900,1280x800').map(size => { const [width, height] = size.split('x').map(Number); return {width, height, name: size}; });
const STATES = list('states', 'overview,resolved,open-one,open-all,sidebar-collapsed,ledger,conversation,popover,popover-own,settings,offline');
const NO_FAIL = args.includes('--no-fail');
// --probe file.js: print what an expression in that file returns in each combination, and nothing else.
const PROBE = option('probe', null) && fs.readFileSync(option('probe'), 'utf8');

// --- the made-up review, offline and served ------------------------------------------------------
// The Ruby on this PATH (mise's, say), not whatever a login shell finds first.
function ruby() { return process.env.PATH.split(':').map(dir => path.join(dir, 'ruby')).find(file => fs.existsSync(file)); }
async function serve(work) {
  const config = path.join(work, 'config');
  fs.mkdirSync(config, {recursive: true});
  const env = {...process.env, DCR_CONFIG_DIR: config, DCR_FOCUS: '0'};
  const fixture = JSON.parse(execFileSync(ruby(), [path.join(ROOT, 'scripts/qa_fixture.rb'), work], {env, encoding: 'utf8'}));
  // No agent CLI and no GitHub: the page must never spend anyone's account or show anyone real.
  const rubyDir = path.dirname(ruby());
  const quiet = {...env, PATH: [rubyDir, '/usr/bin', '/bin'].join(':'), DCR_GH: '/usr/bin/false'};
  const server = spawn(ruby(), [path.join(ROOT, 'bin/dcr'), 'serve', '--report', fixture.report, '--without-app', 'Made-up fixture, no app to run'], {env: quiet, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  const url = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`dcr serve did not start: ${output}`)), 20000);
    const read = chunk => { output += chunk; const found = output.match(/(http:\/\/127\.0\.0\.1:\d+)\/#overview/); if (found) { clearTimeout(timer); done(found[1]); } };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
  });
  const pristine = fs.readFileSync(path.join(fixture.series, 'state.json'));
  return {fixture, url, server, config, pristine};
}

// A made-up face: two soft colours and a round head, as a PNG data URI drawn by the browser itself.
const FACE = `(() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#7aa6c2'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#f2d4b8'; g.beginPath(); g.arc(32, 26, 13, 0, 7); g.fill();
  g.fillStyle = '#35546b'; g.beginPath(); g.arc(32, 64, 24, 0, 7); g.fill(); return c.toDataURL('image/png'); })()`;
const ME = {login: 'sam-rivera'};

// --- what the page is put in before each screenshot -------------------------------------------------
const steps = {
  async overview(page) { await page.evaluate(`(${openFolds})()`); },
  async 'open-one'(page) { await page.evaluate(`(${openFolds})()`); await toggle(page, 'fee-window'); await page.evaluate(`document.querySelector('.overview-comments').scrollIntoView({block: 'start'})`); },
  async resolved(page) { await page.evaluate(`(${openFolds})()`); await page.evaluate(`document.querySelector('#my-review').scrollIntoView({block: 'start'})`); },
  async 'open-all'(page) {
    await page.evaluate(`(${openFolds})()`);
    for (const id of await page.evaluate(`[...document.querySelectorAll('.overview-reading .review-thread[data-thread-id]')].map(node => node.dataset.threadId)`)) await toggle(page, id);
    await page.evaluate(`document.querySelector('.overview-comments').scrollIntoView({block: 'start'})`);
  },
  async 'sidebar-collapsed'(page) { await page.evaluate(`(${openFolds})()`); await page.evaluate(`document.body.classList.contains('sidebar-collapsed') || (document.querySelector('.sidebar-hide:not([hidden])') || document.getElementById('sidebar-toggle'))?.click()`); await sleep(400); },
  async ledger(page) { await page.evaluate(`document.body.classList.contains('ledger-open') || document.getElementById('ledger-toggle').click()`); await sleep(500); },
  async conversation(page) {
    await steps.ledger(page);
    await page.evaluate(`document.querySelector('[data-dcr-open="fee-window"]')?.click()`);
    await sleep(600);
  },
  async popover(page) { await openPopover(page, 'fee-window'); },
  async 'popover-own'(page) { await openPopover(page, 'mine-file-note'); },
  async settings(page) {
    await page.evaluate(`document.querySelector('[data-open-settings]')?.click()`);
    await sleep(300);
    await page.evaluate(`document.querySelector('[data-settings-tab="agents"]')?.click()`);
    await sleep(400);
  },
  async offline(page) { await page.evaluate(`(${openFolds})()`); }
};
async function openPopover(page, id) {
    await page.evaluate(`document.querySelector('.thread-go[data-comment="${id}"]')?.click() || document.querySelector('.review-thread[data-thread-id="${id}"] [data-comment="${id}"]')?.click()`);
    await sleep(900);
    // A real click on the comment's mark beside the code, once the scroll has settled.
    await page.evaluate(`(() => { const trigger = [...document.querySelectorAll('.comment-trigger')].find(node => node.dataset.notes.split(' ').includes('${id}')); trigger?.scrollIntoView({block: 'center'}); })()`);
    await sleep(500);
    const at = await page.evaluate(`(() => { const trigger = [...document.querySelectorAll('.comment-trigger')].find(node => node.dataset.notes.split(' ').includes('${id}')); const r = trigger?.getBoundingClientRect(); return r ? {x: r.left + r.width / 2, y: r.top + r.height / 2} : null; })()`);
    if (at) await page.click(at.x, at.y);
    await sleep(700);
  }

function openFolds() {
  document.querySelectorAll('.overview-settled details.overview-fold:not([open])').forEach(fold => { fold.open = true; });
}
async function toggle(page, id) {
  // A click where a reader clicks: the middle of the comment's title.
  const point = await page.evaluate(`(() => { const node = document.querySelector('.review-thread[data-thread-id="${id}"] .thread-summary strong'); if (!node) return null; node.scrollIntoView({block: 'nearest'}); const r = node.getBoundingClientRect(); return {x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2}; })()`);
  if (!point) return;
  const before = await page.evaluate(`document.querySelector('.review-thread[data-thread-id="${id}"] > details').open`);
  await page.click(point.x, point.y);
  await sleep(250);
  // Something floating (the bar) can be where the title is; then the comment is opened as a keyboard would.
  if (await page.evaluate(`document.querySelector('.review-thread[data-thread-id="${id}"] > details').open`) === before) {
    await page.evaluate(`document.querySelector('.review-thread[data-thread-id="${id}"] > details > summary').click()`);
    await sleep(250);
  }
}

// --- measuring --------------------------------------------------------------------------------------
// Runs in the page. Returns [{check, pass, detail}] for what is on screen now.
function measure(context) {
  const out = [];
  const add = (check, pass, detail = '') => out.push({check, pass: !!pass, detail: String(detail).slice(0, 300)});
  const visible = node => { if (!node || !node.isConnected) return false; const r = node.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(node); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  // Any CSS colour (rgb, color(srgb ...), oklch ...) as {r, g, b, a}, by painting one pixel with it.
  const paint = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
  const rgba = color => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = 'rgba(0,0,0,0)'; paint.fillStyle = String(color); paint.fillRect(0, 0, 1, 1); const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data; return {r, g, b, a: a / 255}; };
  const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  const backgroundOf = node => { for (let at = node; at; at = at.parentElement) { const c = rgba(getComputedStyle(at).backgroundColor); if (c.a > 0.5) return c; } return rgba(getComputedStyle(document.body).backgroundColor); };
  const label = node => node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${[...node.classList].slice(0, 2).map(name => `.${name}`).join('')}` : '?';
  const textRects = root => {
    const rects = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim() || !visible(text.parentElement)) continue;
      if ([text.parentElement, text.parentElement.parentElement].some(node => node && getComputedStyle(node).clipPath.startsWith('inset(50%'))) continue; // read only by screen readers
      const range = document.createRange(); range.selectNodeContents(text);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) rects.push({r, node: text.parentElement});
    }
    return rects;
  };
  // What of a box is really on screen: cut by the viewport and by every ancestor that clips.
  const shown = (r, node) => {
    let box = {left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, innerWidth), bottom: Math.min(r.bottom, innerHeight)};
    for (let at = node; at && at !== document.documentElement; at = at.parentElement) {
      const s = getComputedStyle(at);
      if (at !== node && (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY) || at.tagName === 'DETAILS')) { const c = at.getBoundingClientRect(); box = {left: Math.max(box.left, c.left), top: Math.max(box.top, c.top), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom)}; }
      if (s.display === 'none' || s.visibility === 'hidden' || s.contentVisibility === 'hidden') return null;
    }
    return box.right - box.left > 1 && box.bottom - box.top > 1 ? box : null;
  };
  const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  // 1. No horizontal page scroll.
  const content = document.getElementById('content');
  add('no-page-hscroll', document.documentElement.scrollWidth <= innerWidth + 1 && (!content || content.scrollWidth <= content.clientWidth + 1), `page ${document.documentElement.scrollWidth}/${innerWidth}, content ${content?.scrollWidth}/${content?.clientWidth}`);

  // 2. Nothing overlaps: no two pieces of text on top of each other, in what is on screen.
  const scopes = [...document.querySelectorAll('.overview-reading, #ledger:not([hidden]), .comment-popover:popover-open, #settings-dialog[open] .modal-box, .review-bar')].filter(visible);
  const overlaps = [];
  scopes.forEach(scope => {
    const rects = textRects(scope).map(item => ({...item, r: shown(item.r, item.node)})).filter(item => item.r);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.node === b.node || a.node.contains(b.node) || b.node.contains(a.node)) continue;
      if (inter(a.r, b.r) > 4) overlaps.push(`${label(a.node)} "${a.node.textContent.trim().slice(0, 20)}" × ${label(b.node)} "${b.node.textContent.trim().slice(0, 20)}"`);
    }
  });
  add('no-overlap', !overlaps.length, overlaps.slice(0, 4).join(' | '));

  // 3. A comment's line: face, title and chevron do not overlap one another or touch the card's edge.
  const lines = [...document.querySelectorAll('.overview-reading .review-thread .thread-summary')].filter(visible);
  const lineProblems = [];
  lines.forEach(line => {
    const parts = [...line.querySelectorAll(':scope > *, :scope strong > .thread-go')].filter(visible).map(node => ({node, r: node.getBoundingClientRect()}));
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (!parts[i].node.contains(parts[j].node) && inter(parts[i].r, parts[j].r) > 2) lineProblems.push(`${line.closest('[data-thread-id]')?.dataset.threadId}: ${label(parts[i].node)} × ${label(parts[j].node)}`);
  });
  add('line-parts-apart', !lineProblems.length, lineProblems.slice(0, 4).join(' | '));

  // 4. An open card keeps one inner margin: nothing crosses its edge, and its left and right margins match.
  const boxed = node => { const s = getComputedStyle(node); const border = ['Top', 'Right', 'Bottom', 'Left'].filter(side => parseFloat(s[`border${side}Width`]) > 0 && rgba(s[`border${side}Color`]).a > 0.1); const bg = rgba(s.backgroundColor); const filled = bg.a > 0.5 && distance(bg, backgroundOf(node.parentElement)) > 3; return {border, filled, shadow: s.boxShadow !== 'none', card: border.length >= 3 || filled || (s.boxShadow !== 'none' && border.length > 0)}; };
  const cards = [...document.querySelectorAll('.overview-reading .review-thread:has(> .thread-details[open])')].filter(visible);
  const marginProblems = [];
  cards.forEach(card => {
    const box = card.getBoundingClientRect();
    const leaves = [...textRects(card).map(item => shown(item.r, item.node) && item.r), ...[...card.querySelectorAll('button, img, svg, input, textarea, select, .btn')].filter(visible).filter(node => !node.parentElement.closest('svg')).map(node => shown(node.getBoundingClientRect(), node) && node.getBoundingClientRect())].filter(Boolean);
    if (!leaves.length) return;
    const left = Math.min(...leaves.map(r => r.left)) - box.left, right = box.right - Math.max(...leaves.map(r => r.right));
    const top = Math.min(...leaves.map(r => r.top)) - box.top, bottom = box.bottom - Math.max(...leaves.map(r => r.bottom));
    const id = card.dataset.threadId;
    const shape = boxed(card);
    if (shape.card) {
      if (Math.min(left, right, top, bottom) < 8) marginProblems.push(`${id}: touches its edge (l${left.toFixed(0)} r${right.toFixed(0)} t${top.toFixed(0)} b${bottom.toFixed(0)})`);
      if (Math.abs(left - right) > 2) marginProblems.push(`${id}: left ${left.toFixed(1)} ≠ right ${right.toFixed(1)}`);
    } else if (Math.min(left, right) < -0.5) marginProblems.push(`${id}: crosses its column (l${left.toFixed(1)} r${right.toFixed(1)})`);
  });
  add('card-inner-margin', !marginProblems.length, marginProblems.slice(0, 4).join(' | '));

  // 5. The open card's words start on one column: title, comment, View in file and answers.
  const columnProblems = [];
  cards.forEach(card => {
    const title = card.querySelector('.thread-summary strong');
    const starts = [['title', title], ['body', card.querySelector('.thread-body .comment-discussion')], ['source', card.querySelector('.thread-source')], ['answer', card.querySelector('.dcr-msg .dcr-msg-main, .dcr-msg .dcr-body')]].filter(([, node]) => visible(node));
    if (starts.length < 2) return;
    const textLeft = node => { const rects = textRects(node).map(item => item.r.left); return rects.length ? Math.min(...rects) : node.getBoundingClientRect().left; };
    const base = textLeft(title);
    starts.slice(1).forEach(([name, node]) => { const at = name === 'source' ? node.getBoundingClientRect().left : textLeft(node); if (Math.abs(at - base) > 2) columnProblems.push(`${card.dataset.threadId}: ${name} at ${at.toFixed(0)}, title at ${base.toFixed(0)}`); });
  });
  add('open-card-one-column', !columnProblems.length, columnProblems.slice(0, 4).join(' | '));

  // 6. Between rows: never two rules, exactly one where the theme draws rules; open cards apart.
  const ruleProblems = [];
  const lineOf = (node, side) => { const s = getComputedStyle(node); return parseFloat(s[`border${side}Width`]) > 0 && rgba(s[`border${side}Color`]).a > 0.1 ? 1 : 0; };
  document.querySelectorAll('.overview-reading :is(.overview-comments, #my-review, .overview-fold) ').forEach(group => {
    const rows = [...group.querySelectorAll(':scope > .review-thread, :scope > .overview-fold-body > .review-thread, :scope > div > .review-thread')].filter(visible);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const openA = !!a.querySelector(':scope > .thread-details[open]'), openB = !!b.querySelector(':scope > .thread-details[open]');
      const gap = b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      const rules = lineOf(a, 'Bottom') + lineOf(b, 'Top') + lineOf(a.querySelector('.thread-summary'), 'Bottom') * (openA ? 0 : 1);
      if (!openA && !openB) { if (rules > 1 && gap < 2) ruleProblems.push(`${a.dataset.threadId}/${b.dataset.threadId}: ${rules} rules`); }
      // A closed row right above an open card gives the card its rule: one line, so no gap is needed.
      else if (!openA && openB && gap < 2) { if (lineOf(a, 'Bottom') + lineOf(b, 'Top') > 1) ruleProblems.push(`${a.dataset.threadId}/${b.dataset.threadId}: two rules over an open card`); }
      else if ((openA || openB) && boxed(openA ? a : b).card && gap < 8) ruleProblems.push(`${a.dataset.threadId}/${b.dataset.threadId}: open card ${gap.toFixed(1)}px from its neighbour`);
      else if (openA && openB && gap < 8) ruleProblems.push(`${a.dataset.threadId}/${b.dataset.threadId}: open comments ${gap.toFixed(1)}px apart`);
    }
  });
  add('rows-one-rule-cards-apart', !ruleProblems.length, ruleProblems.slice(0, 4).join(' | '));

  // 7. A photo face is the round photo alone: no box, ring or shadow behind it.
  const faceProblems = [];
  document.querySelectorAll('img').forEach(img => {
    if (!visible(img) || !/^data:image\/png/.test(img.src) || img.naturalWidth !== 64) return; // the made-up face only
    const holder = img.parentElement, s = getComputedStyle(holder), r = img.getBoundingClientRect(), hr = holder.getBoundingClientRect();
    const round = parseFloat(getComputedStyle(img).borderTopLeftRadius) >= r.width / 2 - 1 || (parseFloat(s.borderTopLeftRadius) >= hr.width / 2 - 1 && s.overflow !== 'visible' && Math.abs(hr.width - r.width) < 1);
    const box = rgba(s.backgroundColor).a > 0.05 && (hr.width - r.width > 1 || hr.height - r.height > 1 || !round);
    if (!round || box || (s.boxShadow !== 'none' && !/0px 0px 0px 0px/.test(s.boxShadow)) || parseFloat(s.borderTopWidth) > 0) faceProblems.push(`${label(holder)} in ${label(holder.closest('[class]')?.parentElement)}: ${!round ? 'not round' : box ? 'box behind' : 'ring'}`);
  });
  add('photo-face-alone', !faceProblems.length, faceProblems.slice(0, 4).join(' | '));

  // 8. Agent marks follow the theme's style everywhere: brand colours, or plain ink.
  const ink = rgba(getComputedStyle(document.body).color);
  const style = (getComputedStyle(document.documentElement).getPropertyValue('--avatar-style').trim() || context.expectedStyle);
  const markProblems = [];
  // The bar's and the composer's mark is the field's icon, drawn in the text's colour in every theme.
  const probe = document.createElement('i'); probe.style.color = 'var(--agent-claude, #d97757)'; document.body.append(probe); const brand = rgba(getComputedStyle(probe).color); probe.remove();
  const marks = [...document.querySelectorAll('[data-agent="claude"] svg, [data-agent="codex"] svg')].filter(visible).filter(svg => !svg.closest('.dcr-intro, .composer-agent-mark, .review-bar'));
  marks.forEach(svg => {
    const holder = svg.closest('[data-agent]');
    const fill = rgba(getComputedStyle(svg.querySelector('path') || svg).fill);
    const isInk = distance(fill, ink) < 40;
    const where = label(holder.parentElement);
    if (context.expectedStyle === 'mono' && !isInk) markProblems.push(`${where}: ${holder.dataset.agent} not ink`);
    // Brand: Claude's mark in Claude's own colour (--agent-claude for this mode), not ink, not black.
    if (context.expectedStyle === 'brand' && holder.dataset.agent === 'claude' && distance(fill, brand) > 40) markProblems.push(`${where}: claude not in its brand colour`);
  });
  add('agent-marks-theme-style', !markProblems.length && (style === context.expectedStyle || !document.documentElement.style), `${marks.length} marks, style ${style}; ${markProblems.slice(0, 4).join(' | ')}`);

  // 9. Your comments and the agent's line up: one face column and one title column.
  const columns = (rows, face, title) => {
    const at = rows.filter(visible).map(row => ({face: row.querySelector(face), title: row.querySelector(title)})).filter(item => visible(item.face) && visible(item.title));
    const faces = new Set(at.map(item => Math.round(item.face.getBoundingClientRect().left)));
    const titles = new Set(at.map(item => Math.round(item.title.getBoundingClientRect().left)));
    return {n: at.length, faces: [...faces], titles: [...titles]};
  };
  const overviewCols = columns([...document.querySelectorAll('.overview-reading .review-thread:not(:has(> .thread-details[open]))')], '.thread-summary > :is(.thread-face, .comment-avatar, .ui-avatar):not([hidden])', '.thread-summary > strong');
  const ledgerCols = columns([...document.querySelectorAll('#ledger .ledger-item[data-ledger]')], '.ledger-msg > :is(.dcr-avatar, .comment-avatar, .ui-avatar)', '.ledger-subject');
  const aligned = cols => cols.n < 2 || (Math.max(...cols.faces) - Math.min(...cols.faces) <= 1 && Math.max(...cols.titles) - Math.min(...cols.titles) <= 1);
  const sameComponent = [...document.querySelectorAll('.overview-reading .review-thread')].every(node => node.dataset.ui === 'CommentCard') && [...document.querySelectorAll('#ledger .ledger-item[data-ledger]')].every(node => node.dataset.ui === 'LedgerRow');
  add('yours-and-agents-line-up', aligned(overviewCols) && aligned(ledgerCols) && sameComponent, `overview faces ${overviewCols.faces} titles ${overviewCols.titles}; ledger faces ${ledgerCols.faces} titles ${ledgerCols.titles}; one component ${sameComponent}`);

  // 10. An answer's table or code does not scroll sideways when there is room.
  const scrolling = [...document.querySelectorAll('.dcr-body :is(pre, table, .md-table, .table-wrap)')].filter(visible).filter(node => node.scrollWidth > node.clientWidth + 1 && node.scrollWidth < (node.closest('.dcr-msg, .dcr-detail, .review-thread, .popover-comment') || document.body).clientWidth);
  add('answers-no-hscroll', !scrolling.length, scrolling.slice(0, 3).map(node => `${label(node)} ${node.scrollWidth}/${node.clientWidth}`).join(' | '));

  // 11. The floating bar stands apart from the page, in the dark too.
  const bar = document.querySelector('.review-bar');
  if (visible(bar)) {
    const s = getComputedStyle(bar), own = rgba(s.backgroundColor), page = backgroundOf(document.getElementById('content') || document.body);
    add('bar-stands-out', distance(own, page) > 6 || (parseFloat(s.borderTopWidth) > 0 && distance(rgba(s.borderTopColor), page) > 20), `bar ${s.backgroundColor} on ${JSON.stringify(page)}`);
  }

  // 12. Resolved rows: the type a soft tag in its colour, no check, no file line, the way to the code after the title.
  const resolvedProblems = [];
  document.querySelectorAll('.overview-reading .review-thread.is-resolved:not(:has(> .thread-details[open]))').forEach(row => {
    if (!visible(row)) return;
    const id = row.dataset.threadId;
    if (visible(row.querySelector('.thread-resolved'))) resolvedProblems.push(`${id}: check shown`);
    if (visible(row.querySelector('.thread-file'))) resolvedProblems.push(`${id}: file line shown`);
    const tag = row.querySelector('.thread-summary .thread-type, .thread-summary .ui-tag');
    if (visible(tag) && rgba(getComputedStyle(tag).backgroundColor).a < 0.1 && !context.plainTags) resolvedProblems.push(`${id}: type tag has no tint`);
    const go = row.querySelector('.thread-go'), title = row.querySelector('.thread-summary strong');
    if (visible(go)) {
      const words = textRects(title).filter(item => !go.contains(item.node)).map(item => item.r);
      const end = Math.max(...words.filter(r => Math.abs(r.top - go.getBoundingClientRect().top) < 14).map(r => r.right), -1e9);
      const gap = go.getBoundingClientRect().left - end;
      if (!(gap >= -1 && gap <= 10)) resolvedProblems.push(`${id}: way to the code ${gap.toFixed(0)}px after the title`);
    }
  });
  add('resolved-rows', !resolvedProblems.length, resolvedProblems.slice(0, 4).join(' | '));

  return out;
}

// The line of a comment must not move when it opens or closes: measured around a real click.
async function lineStability(page) {
  const results = [];
  for (const id of ['fee-window', 'mine-file-note', 'refund-route']) {
    const where = `(() => { const row = document.querySelector('.review-thread[data-thread-id="${id}"]'); if (!row) return null; const box = node => { const r = node?.getBoundingClientRect(); return r && r.width ? [r.left, r.top + document.getElementById('content').scrollTop, r.width] : null; }; return {face: box(row.querySelector('.thread-summary :is(.thread-face,.comment-avatar,.ui-avatar):not([hidden])')), title: box(row.querySelector('.thread-summary > strong')), chevron: box(row.querySelector('.thread-chevron'))}; })()`;
    const before = await page.evaluate(where);
    if (!before) continue;
    await toggle(page, id);
    const opened = await page.evaluate(where);
    await toggle(page, id);
    const closed = await page.evaluate(where);
    const moved = [];
    for (const part of ['face', 'title', 'chevron']) {
      if (!before[part]) continue;
      for (const [name, after] of [['open', opened], ['closed again', closed]]) {
        if (!after[part]) { moved.push(`${part} gone when ${name}`); continue; }
        const dx = Math.abs(after[part][0] - before[part][0]), dy = Math.abs(after[part][1] - before[part][1]);
        if (dx > 0.5 || dy > 0.5) moved.push(`${part} moved ${dx.toFixed(1)},${dy.toFixed(1)} when ${name}`);
      }
    }
    results.push(`${id}: ${moved.length ? moved.join(', ') : 'still'}`);
    if (moved.length) return {check: 'line-still-on-open', pass: false, detail: results.join(' | ')};
  }
  return {check: 'line-still-on-open', pass: true, detail: results.join(' | ')};
}

// From the Overview to the code and back.
async function backToOverview(page) {
  await page.evaluate(`document.querySelector('.thread-go[data-comment="fee-window"]')?.click() || document.querySelector('.review-thread[data-thread-id="fee-window"] [data-comment="fee-window"]')?.click()`);
  await sleep(700);
  const back = await page.evaluate(`(() => { const node = document.getElementById('bar-back'); const r = node?.getBoundingClientRect(); return node && !node.hidden && r.width > 0 && getComputedStyle(node).display !== 'none' ? node.textContent.trim() : ''; })()`);
  return {check: 'back-to-overview', pass: /Overview/.test(back), detail: back || 'no way back shown'};
}

// A picture of the contact sheet (index.html), for whoever reads the results without a browser.
async function sheetPicture(browser, dir) {
  const page = await browser.page({width: 1600, height: 900});
  await page.goto(`file://${path.join(dir, 'index.html')}`);
  await sleep(1500);
  const height = await page.evaluate('Math.min(document.documentElement.scrollHeight, 16000)');
  await page.call('Emulation.setDeviceMetricsOverride', {width: 1600, height, deviceScaleFactor: 1, mobile: false});
  await sleep(500);
  await page.screenshot(path.join(dir, 'contact-sheet.png'));
  await page.close();
}

// --- the run ----------------------------------------------------------------------------------------
if (option('sheet', null)) {
  (async () => { const browser = await launch(); await sheetPicture(browser, path.resolve(option('sheet'))); await browser.close(); })();
  return;
}
(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-qa-visual-'));
  const served = await serve(work);
  const browser = await launch();
  const report = [];
  const listening = '.listening';
  const expected = {aida: 'brand', terminal: 'brand', minimal: 'mono'};
  const face = await (async () => { const p = await browser.page({width: 64, height: 64}); const data = await p.evaluate(FACE); await p.close(); return data; })();
  try {
    for (const viewport of VIEWPORTS) for (const theme of THEMES) for (const mode of MODES) for (const state of STATES) {
      fs.writeFileSync(path.join(served.fixture.series, 'state.json'), served.pristine);
      fs.writeFileSync(path.join(served.fixture.series, listening), `${Date.now() / 1000} claude claude-opus-5-5 high`);
      const page = await browser.page(viewport);
      const progress = {...served.fixture.progress, ledgerOpen: ['ledger', 'conversation'].includes(state), sidebarCollapsed: state === 'sidebar-collapsed'};
      await page.emulateDark(mode === 'dark');
      await page.beforeLoad(`try {
        localStorage.clear();
        localStorage.setItem('dynamic-review:settings', ${JSON.stringify(JSON.stringify({theme, colorMode: mode, defaults: 'terminal-dark'}))});
        localStorage.setItem(${JSON.stringify(served.fixture.key)}, ${JSON.stringify(JSON.stringify(progress))});
      } catch (e) {}
`);
      await page.call('Fetch.enable', {patterns: [{urlPattern: '*/api/github/me*'}, {urlPattern: '*/api/title*'}]});
      // The reader is made up: a login and a drawn face, never the GitHub account of whoever runs this.
      const fulfil = async message => {
        if (message.method !== 'Fetch.requestPaused') return;
        const body = message.params.request.url.includes('/api/github/me') ? JSON.stringify({...ME, avatar: face}) : JSON.stringify({error: 'no titles in QA'});
        await page.call('Fetch.fulfillRequest', {requestId: message.params.requestId, responseCode: message.params.request.url.includes('/api/title') ? 400 : 200, responseHeaders: [{name: 'Content-Type', value: 'application/json'}], body: Buffer.from(body).toString('base64')});
      };
      page.onEvent(message => { fulfil(message).catch(() => {}); });
      const url = state === 'offline' ? `file://${served.fixture.report}#overview` : `${served.url}/#overview`;
      await page.goto(url);
      await sleep(1600);
      // Every state starts on the Overview, whatever an earlier page left saved.
      await page.evaluate(`document.querySelector('.overview-reading') || document.querySelector('#navigation [data-view="overview"]')?.click()`);
      await sleep(300);
      await steps[state](page);
      await sleep(300);
      const name = `${theme}-${mode}-${state}-${viewport.name}`;
      if (PROBE) { console.log(name, JSON.stringify(await page.evaluate(PROBE))); await page.close(); await sleep(400); continue; }
      await page.screenshot(path.join(OUT, `${name}.png`));
      const checks = await page.evaluate(`(${measure})(${JSON.stringify({expectedStyle: expected[theme], plainTags: theme === 'minimal'})})`);
      if (state === 'overview') { checks.push(await lineStability(page)); checks.push(await backToOverview(page)); }
      checks.push({check: 'no-script-errors', pass: !page.errors.length, detail: page.errors.slice(0, 2).join(' | ')});
      report.push({name, theme, mode, state, viewport: viewport.name, checks});
      const failed = checks.filter(check => !check.pass);
      console.log(`${failed.length ? 'FAIL' : 'pass'} ${name}${failed.length ? `: ${failed.map(check => `${check.check} (${check.detail})`).join('; ')}` : ''}`);
      await page.close();
      await sleep(400); // what the closed page saved on its way out lands before the next restore
    }
    // --merge: rerun some combinations into a folder that has the rest.
    if (args.includes('--merge') && fs.existsSync(path.join(OUT, 'report.json'))) {
      const done = new Set(report.map(entry => entry.name));
      report.unshift(...JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')).filter(entry => !done.has(entry.name)));
    }
    if (COMPARE) await compare(browser, report);
    writeSheet(report);
    await sheetPicture(browser, OUT);
  } finally {
    await browser.close();
    served.server.kill();
    fs.rmSync(work, {recursive: true, force: true});
  }
  const failures = report.flatMap(entry => entry.checks.filter(check => !check.pass).map(check => `${entry.name}: ${check.check}`));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\n${report.length} screenshots in ${OUT}; ${failures.length} failed check(s).`);
  process.exit(failures.length && !NO_FAIL ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });

// --- before and after -------------------------------------------------------------------------------
async function compare(browser, report) {
  const page = await browser.page({width: 400, height: 300});
  await page.goto(`file://${OUT}/`);
  for (const entry of report) {
    const before = path.join(COMPARE, `${entry.name}.png`), after = path.join(OUT, `${entry.name}.png`);
    if (!fs.existsSync(before)) { entry.diff = null; continue; }
    const data = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    const result = await page.evaluate(`(async () => {
      const load = src => new Promise(done => { const img = new Image(); img.onload = () => done(img); img.src = src; });
      const [a, b] = await Promise.all([load(${JSON.stringify(data(before))}), load(${JSON.stringify(data(after))})]);
      const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      g.drawImage(a, 0, 0); const pa = g.getImageData(0, 0, w, h).data;
      g.clearRect(0, 0, w, h); g.drawImage(b, 0, 0); const pb = g.getImageData(0, 0, w, h);
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.abs(pa[i] - pb.data[i]) + Math.abs(pa[i + 1] - pb.data[i + 1]) + Math.abs(pa[i + 2] - pb.data[i + 2]);
        if (d > 24) { changed++; pb.data[i] = 255; pb.data[i + 1] = 0; pb.data[i + 2] = 80; pb.data[i + 3] = 255; }
        else { pb.data[i + 3] = 60; }
      }
      g.putImageData(pb, 0, 0);
      return {changed: changed / (w * h), image: canvas.toDataURL('image/png')};
    })()`);
    entry.diff = Math.round(result.changed * 10000) / 100;
    fs.mkdirSync(path.join(OUT, 'diff'), {recursive: true});
    fs.writeFileSync(path.join(OUT, 'diff', `${entry.name}.png`), Buffer.from(result.image.split(',')[1], 'base64'));
  }
  await page.close();
}

function writeSheet(report) {
  const escape = text => String(text).replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));
  const checks = [...new Set(report.flatMap(entry => entry.checks.map(check => check.check)))];
  const rows = report.map(entry => `<tr><td>${escape(entry.name)}</td>${checks.map(name => { const check = entry.checks.find(item => item.check === name); return check ? `<td class="${check.pass ? 'ok' : 'bad'}" title="${escape(check.detail)}">${check.pass ? 'pass' : 'FAIL'}</td>` : '<td>–</td>'; }).join('')}${entry.diff !== undefined ? `<td>${entry.diff === null ? 'new' : `${entry.diff}%`}</td>` : ''}</tr>`).join('');
  const shots = report.map(entry => `<figure><a href="${escape(entry.name)}.png"><img src="${escape(entry.name)}.png"></a>${entry.diff !== undefined && entry.diff !== null ? `<a href="diff/${escape(entry.name)}.png">diff ${entry.diff}%</a>` : ''}<figcaption>${escape(entry.name)}</figcaption></figure>`).join('');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Visual QA</title><style>body{font:13px system-ui;margin:20px}table{border-collapse:collapse;margin-bottom:24px}td,th{border:1px solid #ccc;padding:2px 6px;font-size:11px}.ok{color:#176}.bad{background:#fdd;color:#900;font-weight:600}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0}img{width:100%;border:1px solid #ddd}</style>
<h1>Visual QA: ${report.length} screenshots</h1><table><tr><th>combination</th>${checks.map(name => `<th>${escape(name)}</th>`).join('')}${COMPARE ? '<th>diff</th>' : ''}</tr>${rows}</table><div class="grid">${shots}</div>`);
}
