/* Pure helpers shared by the offline UI and its Node checks. */
'use strict';
globalThis.ReviewTools = (() => {
  // The sidebar and File by file share this order. A paired component occupies
  // one sidebar entry, with Ruby and Template in its visible shortcut order.
  function sidebarFiles(layer, files) {
    const pairs = componentGroups(layer.items, files);
    const emitted = new Set();
    return layer.items.flatMap(item => {
      const pair = pairs.find(pair => pair.items.some(member => member.file === item.file));
      if (pair) {
        if (emitted.has(pair.key)) return [];
        emitted.add(pair.key);
        return pair.items.map(member => member.file);
      }
      if (emitted.has(item.file)) return [];
      emitted.add(item.file);
      return [item.file];
    });
  }
  function layerFiles(layer, files) {
    const ordered = {code:[], tests:[]};
    sidebarFiles(layer, files).forEach(file => {
      ordered[category(files.get(file).path) === 'Tests' ? 'tests' : 'code'].push(file);
    });
    return ordered;
  }
  function focusFiles(layers, files) {
    const seen = new Set();
    return layers.flatMap(layer => {
      const ordered = layerFiles(layer, files);
      return [...ordered.code, ...ordered.tests].map(file => ({file, layer}));
    }).filter(entry => {
      if (seen.has(entry.file)) return false;
      seen.add(entry.file);
      return true;
    });
  }
  function fullFileHunks(file) {
    if (!file.source) return null;
    const old = sourceLines(file, 'old'), after = sourceLines(file, 'new');
    const result = [];
    let oi = 0, ni = 0;
    const context = (oe, ne) => {
      const before = old.slice(oi, oe), next = after.slice(ni, ne);
      if (before.length !== next.length || before.some((text, i) => text !== next[i])) throw new Error('Captured source does not match diff context');
      if (before.length) {
        const unified = before.map((text, i) => ({kind:'context', text, old:oi + i + 1, new:ni + i + 1}));
        result.push({id:`${file.id}-context-${result.length}`, contextOnly:true, rows:{unified, split:unified.map(line => ({old:line, new:line}))}});
      }
    };
    file.hunks.forEach(hunk => {
      context(hunk.old_count ? hunk.old_start - 1 : hunk.old_start, hunk.new_count ? hunk.new_start - 1 : hunk.new_start);
      result.push(hunk);
      oi = hunk.old_count ? hunk.old_start - 1 + hunk.old_count : hunk.old_start;
      ni = hunk.new_count ? hunk.new_start - 1 + hunk.new_count : hunk.new_start;
    });
    context(old.length, after.length);
    return result;
  }
  const categories = ['Design / UI', 'Frontend', 'Backend', 'Documentation', 'Tests', 'Platform', 'Security', 'AI', 'Other'];
  const designFile = path => /(?:\.html(?:\.erb)?|\.(?:css|scss|sass))$/i.test(path);
  // Pair only conventional, changed sidecars within this walkthrough layer.
  function componentGroups(items, files) {
    const pairs = new Map();
    items.forEach(item => {
      const path = files.get(item.file).path;
      const match = path.match(/^app\/components\/(.+_component)\.(rb|html\.erb)$/);
      if (!match) return;
      const key = match[1];
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(item);
    });
    return [...pairs].filter(([, members]) => members.length === 2).map(([key, members]) => {
      const parts = key.split('/').map(part => part.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(''));
      const path = files.get(members[0].file).path;
      return {key, name:parts.pop(), namespace:parts.join('::'), directory:path.slice(0, path.lastIndexOf('/')), items:members.sort((a,b) => Number(!files.get(a.file).path.endsWith('.rb')) - Number(!files.get(b.file).path.endsWith('.rb')))};
    });
  }
  function category(path, overrides = {}) {
    const requested = overrides[path];
    if (categories.includes(requested) && (requested !== 'Design / UI' || designFile(path))) return requested;
    if (/(^|\/)(test|tests|spec|specs|fixtures|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path)) return 'Tests';
    if (/(^|\/)(\.codex|\.claude|\.cursor|prompts?|skills)(\/|$)|(^|\/)(AGENTS|CLAUDE|SKILL)\.md$/i.test(path)) return 'AI';
    if (designFile(path)) return 'Design / UI';
    if (/(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|txt)$/i.test(path)) return 'Documentation';
    if (/^db\/|^config\/routes(?:\.rb|\/)/i.test(path)) return 'Backend';
    if (/^config\/locales\//i.test(path)) return 'Frontend';
    if (/(^|\/)(policies|security|authentication|authorization)(\/|$)|(?:encrypt|csrf|csp|credentials|permissions)/i.test(path)) return 'Security';
    if (/(^|\/)(\.github|\.circleci|\.devcontainer|infra|terraform|deploy|config)(\/|$)|(^|\/)(Dockerfile|Makefile|Gemfile|Procfile)|^(?:compose|docker-compose|webpack|vite|rollup|esbuild|postcss|tailwind|babel|eslint)(?:\.|\/)|\.tf$/i.test(path)) return 'Platform';
    if (/\.(?:[cm]?js|jsx|tsx?)$/i.test(path) || /(^|\/)(helpers|presenters|decorators)(\/|$)/.test(path)) return 'Frontend';
    if (/\.(?:rb|rake|gemspec|py|go|rs|java|php|ex|exs)$/i.test(path)) return 'Backend';
    return 'Other';
  }
  // Tests stay assigned to their owning layer, but follow the last related entity.
  function walkthroughSections(layer) {
    const panels = layer.related_tests || [];
    const hidden = new Set(panels.flatMap(panel => panel.files));
    return layer.items.flatMap((item, index) => {
      const sections = hidden.has(item.file) ? [] : [{item}];
      panels.filter(panel => Math.max(...panel.entities.map(file => layer.items.findIndex(item => item.file === file))) === index).forEach(panel => {
        sections.push({tests:panel, items:panel.files.map(file => layer.items.find(item => item.file === file))});
      });
      return sections;
    });
  }
  // Old reports stored completed layers. A file split across layers is complete
  // only when every owning layer was reviewed; new marks always use full paths.
  function viewedFiles(snapshot, layers, saved) {
    if (Array.isArray(saved.viewedFiles)) {
      return snapshot.files.filter(file => saved.viewedFiles.includes(file.path)).map(file => file.path);
    }
    const viewed = Array.isArray(saved.viewed) ? saved.viewed : [];
    return snapshot.files.filter(file => {
      const owners = layers.filter(layer => layer.items.some(item => item.file === file.id));
      return owners.length > 0 && owners.every(layer => viewed.includes(layer.id));
    }).map(file => file.path);
  }
  function fileProgress(paths, viewed) {
    const unique = [...new Set(paths)];
    return {total:unique.length, viewed:unique.filter(path => viewed.includes(path)).length};
  }
  function sourceLines(file, side) {
    return file.source[side] === '' ? [] : file.source[side].replace(/\n$/, '').split('\n');
  }
  function anchor(snapshot, comment) {
    const fullFile = snapshot.files.find(file => comment.hunk === `full:${file.id}`);
    if (fullFile) {
      if (!fullFile.source || !['old','new'].includes(comment.side) || !Number.isInteger(comment.start) || !Number.isInteger(comment.end) || comment.start < 1 || comment.start > comment.end) return null;
      const source = sourceLines(fullFile, comment.side);
      if (comment.end > source.length) return null;
      const lines = source.slice(comment.start - 1, comment.end).map((text, index) => ({text, [comment.side]:comment.start + index}));
      return {file:fullFile, lines, fullFile:true};
    }
    const file = snapshot.files.find(file => file.hunks.some(hunk => hunk.id === comment.hunk));
    const hunk = file?.hunks.find(hunk => hunk.id === comment.hunk);
    if (!hunk || !['old','new'].includes(comment.side) || !Number.isInteger(comment.start) || !Number.isInteger(comment.end) || comment.start > comment.end) return null;
    const lines = hunk.rows.unified.filter(line => line[comment.side] >= comment.start && line[comment.side] <= comment.end);
    if (lines.length !== comment.end - comment.start + 1) return null;
    return {file, hunk, lines};
  }
  // Render-time view of a hunk's rows with whitespace-only changes shown as unchanged
  // context. The captured rows are never altered, so comment anchors and copied code keep
  // their original lines. Like `git diff -w`, all whitespace is ignored, and lines are matched
  // in order across a whole changed block (its longest common run), so re-indented code inside
  // a new wrapper shows only the lines that really changed.
  const squeeze = text => String(text ?? '').replace(/\s+/g, '');
  const MATCH_LIMIT = 4000000; // removed × added lines compared; past it, only equal-sized blocks fold
  // [[removedIndex, addedIndex], ...] of lines equal but for whitespace, in order.
  function matchIgnoringWhitespace(removed, added) {
    const a = removed.map(row => squeeze(row.text)), b = added.map(row => squeeze(row.text));
    if (a.length * b.length > MATCH_LIMIT) return a.length === b.length ? a.flatMap((text, at) => text === b[at] ? [[at, at]] : []) : [];
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    const pairs = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
    return pairs;
  }
  // One changed block (its removals, then its additions) with the whitespace-only pairs folded
  // into context; the real changes between them stay grouped, removals before additions.
  function foldBlock(removed, added) {
    const context = (before, after) => ({kind:'context', text:after.text, old:before.old, new:after.new});
    const result = [];
    let i = 0, j = 0;
    for (const [at, to] of [...matchIgnoringWhitespace(removed, added), [removed.length, added.length]]) {
      result.push(...removed.slice(i, at), ...added.slice(j, to));
      if (at < removed.length) result.push(context(removed[at], added[to]));
      i = at + 1; j = to + 1;
    }
    return result;
  }
  function foldUnified(rows) {
    const result = [];
    for (let index = 0; index < rows.length;) {
      if (rows[index].kind === 'context') { result.push(rows[index++]); continue; }
      const removed = [], added = [];
      while (index < rows.length && rows[index].kind !== 'context') (rows[index].kind === 'del' ? removed : added).push(rows[index++]);
      result.push(...foldBlock(removed, added));
    }
    return result;
  }
  // Split rows from unified ones, paired as the captured split is: within each changed run,
  // the nth removal beside the nth addition.
  function pairSplit(unified) {
    const rows = [];
    let removed = [], added = [];
    const flush = () => { for (let at = 0; at < Math.max(removed.length, added.length); at++) rows.push({old:removed[at] ?? null, new:added[at] ?? null}); removed = []; added = []; };
    unified.forEach(line => {
      if (line.kind === 'context') { flush(); rows.push({old:line, new:line}); }
      else (line.kind === 'del' ? removed : added).push(line);
    });
    flush();
    return rows;
  }
  function displayRows(rows, mode, ignoreWhitespace) {
    if (!ignoreWhitespace) return rows;
    if (mode !== 'split') return foldUnified(rows);
    // A split hunk lists each changed run's removals and additions side by side; read them back
    // in unified order, fold, and pair again.
    const unified = [];
    let removed = [], added = [];
    const flush = () => { unified.push(...removed, ...added); removed = []; added = []; };
    rows.forEach(row => {
      if (row.old?.kind === 'context' || row.new?.kind === 'context') { flush(); unified.push(row.new || row.old); return; }
      if (row.old) removed.push(row.old);
      if (row.new) added.push(row.new);
    });
    flush();
    return pairSplit(foldUnified(unified));
  }
  // A comment typed in one box: the first line is the headline, the rest is the detail. A single
  // long line is cut at a word near 140 characters, the remainder becoming the detail.
  function splitComment(text) {
    const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    const [first = '', ...rest] = value.split('\n');
    let subject = first.trim();
    let detail = rest.join('\n').trim();
    if (subject.length > 140) {
      const at = subject.lastIndexOf(' ', 140);
      const cut = at > 60 ? at : 140;
      detail = `${subject.slice(cut).trim()}${detail ? `\n${detail}` : ''}`;
      subject = subject.slice(0, cut).trim();
    }
    return {subject, discussion: detail};
  }
  function sourceText(snapshot, comment) {
    const found = anchor(snapshot, comment);
    return found ? found.lines.map(line => `${line[comment.side]} | ${line.text}`).join('\n') : '';
  }
  // What a recording says, in at most two short lines. A check that passed says what was seen (the
  // comment already says what the change should do); one that failed says what should happen and
  // what happened instead. Older recordings saved a stock expectation, which says nothing.
  function flowLines(flow) {
    const expected = String(flow?.expected || '').trim();
    const said = expected && !/^(the change )?(behaves|works) as intended\.?$/i.test(expected);
    if (flow?.result === 'failed' && said) return [{kind: 'expected', label: 'Should', text: expected}, {kind: 'result', label: 'Instead', text: flow.observed}];
    const label = {failed: 'Failed', blocked: 'Blocked', 'not-run': 'Not run'}[flow?.result] || 'Seen in the app';
    return [{kind: 'result', label, text: flow?.observed}];
  }
  function commentBody(comment, qa) {
    const evidence = evidenceFlows(qa, comment).map(index => {
      const flow = qa.flows[index];
      return `${flow.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\n${flowLines(flow).map(line => `${line.label}: ${line.text}`).join('\n')}`;
    });
    return [comment.discussion, ...evidence].filter(Boolean).join('\n\n');
  }
  // placed: the text is pasted on the lines themselves (Comment on GitHub), so it needs no location.
  // located: false leaves the file and lines out whatever the anchor, for text a server places itself.
  function postingText(snapshot, comment, qa, {placed = false, located = true} = {}) {
    const found = anchor(snapshot, comment);
    if (!found && !comment.general) throw new Error('Comment range is not present in this snapshot.');
    const lines = comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}–${comment.end}`;
    const location = located && found && !(placed && !found.fullFile) ? `File: ${found.file.path} (${comment.side === 'new' ? 'after' : 'before'} ${lines})\n\n` : '';
    const body = commentBody(comment, qa);
    return `${comment.label} (${comment.decoration}): ${comment.subject}\n\n${location}${body}`.trim();
  }
  // What GitHub needs to post a comment: the paste-ready text and, for a line comment, its file,
  // side and lines. The server decides whether the lines are in the diff.
  function githubItem(snapshot, comment, qa) {
    // On GitHub the label is bold, as Conventional Comments writes it there (and as its browser
    // extension recognises it): **suggestion (non-blocking):** the subject.
    // Never the file and lines in the text: the server puts the comment on them, and names them
    // itself in the one case where GitHub will not take the lines.
    const body = postingText(snapshot, comment, qa, {placed: true, located: false}).replace(/^([a-z][a-z -]*(?: \([^)\n]*\))?:)(?= )/, '**$1**');
    const found = comment.general ? null : anchor(snapshot, comment);
    if (!found) return {id: comment.id, body, general: true};
    return {id: comment.id, body, general: false, path: found.file.path, side: comment.side === 'old' ? 'LEFT' : 'RIGHT', line: comment.end, start_line: comment.start};
  }
  // The conversation with the agent under a comment lives outside the saved review: a served or
  // exported review registers where to find it, and copies for an LLM then carry it along.
  let conversationSource = () => null;
  const setConversationSource = source => { conversationSource = typeof source === 'function' ? source : () => null; };
  const shellWord = value => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
  function conversationText(snapshot, comment) {
    const found = conversationSource(comment.id);
    const messages = (found?.messages || []).filter(message => String(message.body || '').trim());
    if (!messages.length) return '';
    const when = at => { const date = new Date(at); return Number.isFinite(date.getTime()) ? ` · ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''; };
    // Who said each message, so a reader (the GitHub rewrite among them) can follow where it went: the
    // second reviewer disagreeing, the review's agent changing its mind, a teammate's words not yours.
    const name = slug => globalThis.UI?.agentInfo?.(slug)?.name || slug.charAt(0).toUpperCase() + slug.slice(1);
    const stance = {agree: 'agrees', partly: 'partly agrees', disagree: 'disagrees'};
    const who = message => message.author === 'user' ? 'Reviewer'
      : message.author === 'person' ? `@${message.person?.login || 'someone'} (a teammate, on GitHub)`
      : !message.agent ? 'Agent'
      : message.role === 'adversary' ? `${name(message.agent)}, checking the comment${stance[message.verdict] ? ` (${stance[message.verdict]})` : ''}`
      : `${name(message.agent)} (the review's agent)`;
    const lines = messages.map(message => `${who(message)}${when(message.at)}\n${String(message.body).trim()}`);
    const where = found.series && snapshot.repo ? `\nLatest messages: dcr comments --repo ${shellWord(snapshot.repo)} --name ${shellWord(found.series)} --thread ${shellWord(comment.id)}` : '';
    return `\n\nConversation with the agent\n\n${lines.join('\n\n')}\n\nThread: ${comment.id}${where}`;
  }
  // conversation: false leaves the agent's conversation out, as in the first message sent to it.
  function commentText(snapshot, comment, qa, {conversation = true} = {}) {
    const tail = conversation ? conversationText(snapshot, comment) : '';
    return commentOnly(snapshot, comment, qa) + tail;
  }
  // A comment whose lines changed in an update (`dcr sync`) says where it was written: the file
  // and lines as they were, and the code it was about.
  function outdatedWhere(comment) {
    const was = comment.outdated;
    if (!was?.path) return null;
    return {path: was.path, lines: `${was.side === 'old' ? 'Before' : 'After'} L${was.start}${was.end !== was.start ? `–${was.end}` : ''}`, code: (was.lines || []).join('\n'), revision: was.revision};
  }
  function outdatedText(comment) {
    const was = outdatedWhere(comment);
    if (!was) return '';
    const fence = '~'.repeat(Math.max(3, ...[...was.code.matchAll(/~+/g)].map(match => match[0].length + 1)));
    return `Outdated: these lines changed after the comment was written\nFile: ${was.path}\nRange: ${was.lines}, as it was in revision ${was.revision}\n\n${fence}\n${was.code}\n${fence}\n\n`;
  }
  function commentOnly(snapshot, comment, qa) {
    const found = anchor(snapshot, comment);
    const body = commentBody(comment, qa);
    if (comment.general) return `${outdatedText(comment)}General comment · ${snapshot.head}\nSnapshot: ${snapshot.fingerprint}${comment.resolved ? '\nConversation: resolved locally (not verification that the code was fixed)' : ''}\n\n${postingText(snapshot, comment, qa)}`;
    if (!found) throw new Error('Comment range is not present in this snapshot.');
    const code = sourceText(snapshot, comment);
    const fence = '~'.repeat(Math.max(3, ...[...code.matchAll(/~+/g)].map(match => match[0].length + 1)));
    const endpoint = comment.side === 'old' ? snapshot.base : (snapshot.working_tree || snapshot.mode === 'uncommitted' ? `working tree captured at ${snapshot.created} (HEAD ${snapshot.head})` : snapshot.head);
    return `File: ${found.file.path}\nRange: ${comment.side === 'new' ? 'After' : 'Before'} lines ${comment.start}–${comment.end}\nSource: ${endpoint}${comment.resolved ? '\nConversation: resolved locally (not verification that the code was fixed)' : ''}\n\n${fence}\n${code}\n${fence}\n\n${comment.label} (${comment.decoration}): ${comment.subject}${body ? `\n\n${body}` : ''}`;
  }
  function reviewText(snapshot, comments, notes = [], qa) {
    const header = `My code review\nSnapshot: ${snapshot.fingerprint}\nCaptured: ${snapshot.created}\n\nThese comments refer to the captured code below. Check the current code before applying changes.`;
    const parts = comments.map(comment => commentText(snapshot, comment, qa));
    notes.filter(note => note.text.trim()).forEach(note => parts.push(`Step: ${note.title}\nFiles: ${note.paths.join(', ')}\n\n${note.text}`));
    return [header, ...parts].join('\n\n---\n\n');
  }
  function previewEligible(file) {
    return !/^deleted file mode /m.test(file.patch || '') && (/\.html\.erb$/.test(file.path) || /^app\/components\/.*_component\.rb$/.test(file.path));
  }
  function pendingPreviews(snapshot, review, paths) {
    const eligible = new Set(snapshot.files.filter(previewEligible).map(file => file.path));
    const complete = new Set((review.previews || []).filter(p => ['rendered','not_visual'].includes(p.status)).flatMap(p => p.files));
    return [...new Set(Array.isArray(paths) ? paths : [])].filter(path => eligible.has(path) && !complete.has(path));
  }
  // One place answers "what happened to the templates I picked?" A request is
  // browser-local ({path, at, revision}); it resolves when a later revision
  // carries any preview record for that path, and stays "fresh" until opened.
  function previewLifecycle(snapshot, review, visual = {}) {
    const order = snapshot.files.map(file => file.path);
    const eligible = new Set(snapshot.files.filter(previewEligible).map(file => file.path));
    const records = new Map();
    (review.previews || []).forEach(preview => (preview.files || []).forEach(path => {
      if (!records.has(path)) records.set(path, []);
      records.get(path).push(preview);
    }));
    const requests = new Map((Array.isArray(visual.requested) ? visual.requested : [])
      .filter(entry => entry && typeof entry.path === 'string' && eligible.has(entry.path))
      .map(entry => [entry.path, entry]));
    const revision = Number(review.history?.revision) || 0;
    const byOrder = (a, b) => order.indexOf(a.path) - order.indexOf(b.path);
    const ready = [], unavailable = [], requested = [];
    records.forEach((list, path) => {
      const rendered = list.filter(preview => preview.status === 'rendered');
      if (rendered.length) ready.push({path, examples:rendered.length, titles:rendered.map(preview => preview.title).filter(Boolean), fresh:requests.has(path)});
      else unavailable.push({path, status:list.some(preview => preview.status === 'not_visual') ? 'not_visual' : 'unavailable', note:list.map(preview => preview.note).filter(Boolean).join(' ')});
    });
    requests.forEach((entry, path) => {
      if (ready.some(item => item.path === path)) return;
      if (records.has(path) && revision > (Number(entry.revision) || 0)) return;
      requested.push({path, at:entry.at || null, revision:Number(entry.revision) || null});
    });
    const selected = pendingPreviews(snapshot, review, visual.previews);
    return {ready:ready.sort(byOrder), requested:requested.sort(byOrder), selected, unavailable:unavailable.sort(byOrder),
      fresh:ready.filter(item => item.fresh).length};
  }
  // Copying the prompt turns the selection into requests, so the counter returns to zero.
  function requestPreviews(visual, revision, at) {
    const selected = Array.isArray(visual.previews) ? visual.previews : [];
    const previous = (Array.isArray(visual.requested) ? visual.requested : []).filter(entry => !selected.includes(entry.path));
    return {...visual, previews:[], requested:[...previous, ...selected.map(path => ({path, at, revision}))]};
  }
  function visualPrompt(snapshot, review, {kind, paths = []}) {
    if (!['previews','qa'].includes(kind)) throw new Error('Unknown visual task');
    const selected = pendingPreviews(snapshot, review, paths);
    if (kind === 'previews' && !selected.length) throw new Error('Select at least one template');
    const series = review.history?.series;
    const metadata = {repository: snapshot.repo, series, revision: review.history?.revision,
      report: series && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(series) ? `${snapshot.repo}/.reviews/${series}/current.html` : undefined,
      snapshot: snapshot.fingerprint, head: snapshot.head, base: snapshot.base,
      working_tree: !!snapshot.working_tree || snapshot.mode === 'uncommitted'};
    const task = kind === 'previews'
      ? `Generate static HTML previews for only these changed templates:\n${selected.map(path => `- ${JSON.stringify(path)}`).join('\n')}\nUse the app renderer and example data. Attach the batch with series.rb previews --targeted.`
      : `Run video QA driven by this saved review. Choose a small set of meaningful checks from its findings, walkthroughs and changed user flows; determine the scenarios yourself. Record short videos preserving the computer-use pointer already rendered by the harness. Attach each finding's evidence to its relevant review comment using comment_id, and retain relevant successful walkthrough/flow checks as compact evidence. Discover the app and prepare access yourself. Prepare and verify control of the app tab before opening the recorder. Wait for sharing without asking for a typed reply. Capture the useful flows directly; do not run a routine cursor probe or synthesize cursor overlays.`;
    return `Use the dynamic-code-reviews skill to extend this saved review.\n\nReview context:\n${JSON.stringify(metadata, null, 2)}\n\n${task}\n\nRead the latest saved revision and verify its snapshot and the current checkout before attaching evidence. If code changed, review that change first; do not label new-code evidence as belonging to the old snapshot. Preserve existing findings, comments and evidence. Complete only the requested additions, publish one revision for this batch, and return the updated report link. Copying this prompt does not authorize changes to application source.`;
  }
  // Labels belong to these exact endpoints; old labels must not describe new code.
  function comparisonLabels(snapshot, review = {}) {
    const supplied = review.comparison;
    return supplied && supplied.base === snapshot.base && supplied.head === snapshot.head ? supplied : {};
  }
  const prReview = (snapshot, review = {}) => snapshot.mode === 'pr' || (snapshot.mode === 'series' && review.history?.origin_mode === 'pr');
  // The header badge: a PR's number and title when known (its title names the issue), else the scope and head.
  function scopeLabel(snapshot, review = {}) {
    const labels = comparisonLabels(snapshot, review);
    if (prReview(snapshot, review) && labels.pr_title) return `${labels.pr_number ? `#${labels.pr_number} · ` : ''}${labels.pr_title}`;
    if (snapshot.paths) return `Critical code · ${snapshot.paths.length} file${snapshot.paths.length === 1 ? '' : 's'} · ${String(snapshot.head).slice(0, 8)}`;
    return `${snapshot.mode === 'series' ? (snapshot.working_tree ? 'Series + working tree' : 'Committed series') : snapshot.mode} · ${String(snapshot.head).slice(0, 8)}`;
  }
  // SHA-256 of a string's UTF-8 bytes, as hex. GitHub names a file's diff by it, and a saved
  // report opened from disk has no crypto.subtle to ask.
  function sha256(text) {
    // The round constants: the fractional parts of the cube roots of the first 64 primes.
    const prime = n => { for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
    const k = [];
    for (let n = 2; k.length < 64; n++) if (prime(n)) k.push(Math.floor((Math.cbrt(n) % 1) * 2 ** 32));
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const message = new TextEncoder().encode(String(text));
    const bits = message.length * 8;
    const bytes = [...message, 0x80];
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bits / 2 ** (i * 8)) & 255);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let at = 0; at < bytes.length; at += 64) {
      const w = [];
      for (let i = 0; i < 64; i++) {
        if (i < 16) w[i] = (bytes[at + i * 4] << 24) | (bytes[at + i * 4 + 1] << 16) | (bytes[at + i * 4 + 2] << 8) | bytes[at + i * 4 + 3];
        else w[i] = (w[i - 16] + (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
      }
      h.forEach((value, i) => { h[i] = (value + [a, b, c, d, e, f, g, hh][i]) | 0; });
    }
    return h.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  }
  // Where to paste a comment on the PR: its lines in GitHub's Files changed tab (a file's diff is
  // `diff-<sha256 of its path>`, its lines R<n> after and L<n> before), the file when the lines are
  // outside the diff, the conversation for a general comment. Null without a verified GitHub PR URL.
  // The pull request's page on GitHub, when this review is of one.
  function pullRequestUrl(snapshot, review) {
    const url = comparisonLabels(snapshot, review).pr_url;
    return prReview(snapshot, review) && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url || '') ? url : null;
  }
  // A file in the pull request's Files changed tab.
  function githubFileLink(snapshot, review, path) {
    const url = pullRequestUrl(snapshot, review);
    return url && path ? `${url}/files#diff-${sha256(path)}` : null;
  }
  function githubLink(snapshot, review, comment) {
    const url = pullRequestUrl(snapshot, review);
    if (!url) return null;
    if (comment.general) return url;
    const found = anchor(snapshot, comment);
    if (!found) return null;
    const file = githubFileLink(snapshot, review, found.file.path);
    if (found.fullFile) return file;
    const side = comment.side === 'new' ? 'R' : 'L';
    return `${file}${side}${comment.start}${comment.end !== comment.start ? `-${side}${comment.end}` : ''}`;
  }
  function comparisonText(snapshot, review = {}) {
    const short = value => String(value || 'unknown').slice(0, 8);
    const labels = comparisonLabels(snapshot, review);
    const before = labels.base_label || short(snapshot.base);
    const after = labels.head_label || short(snapshot.head);
    // A critical-code review: the repository's chosen files, each read whole as it is now.
    if (snapshot.paths) return `Critical code review · ${snapshot.paths.length} chosen file${snapshot.paths.length === 1 ? '' : 's'} read whole, as they are in the working tree at ${short(snapshot.head)}`;
    if (snapshot.mode === 'uncommitted') return 'Uncommitted changes · staged and unstaged edits, plus non-ignored untracked files, compared with HEAD';
    if (snapshot.mode === 'series' && snapshot.working_tree) return `Cumulative review · committed and uncommitted changes compared with ${before}`;
    if (prReview(snapshot, review)) return `${labels.pr_number ? `PR #${labels.pr_number}` : 'PR review'} · ${after} compared with ${before} · branch changes since their merge base`;
    if (snapshot.mode === 'commit') return `Commit review · ${short(snapshot.head)} compared with ${before}`;
    return `Cumulative review · ${after} compared with ${before}`;
  }
  // Where a review is working, in the reader's words: the issue its branch names (cor-1653 in
  // sscott/cor-1653-consent is COR-1653), its pull request, whether it shows the checkout or what
  // was pushed, and the two branches. comparisonText is the whole account, for a tooltip.
  function where(snapshot, review = {}) {
    const labels = comparisonLabels(snapshot, review) || {};
    const head = labels.head_label || snapshot.branch || '';
    const issue = (String(head).match(/(?:^|[\/_-])([A-Za-z]{2,10}-\d{1,6})(?=$|[\/_-])/) || [])[1]?.toUpperCase() || null;
    const local = snapshot.mode === 'uncommitted' || !!snapshot.working_tree || !!review.history?.local;
    // A pull request's review of what was pushed needs no word for it: PR #n says so.
    const place = snapshot.paths ? 'Critical code' : snapshot.mode === 'uncommitted' ? 'Your uncommitted changes' : local ? 'Your checkout' : prReview(snapshot, review) ? null : snapshot.mode === 'commit' ? 'One commit' : 'Your branch';
    return {issue, pr: labels.pr_number || null, place, head: head || null, base: labels.base_label || null};
  }
  // The issue's page in Linear, when the text names it with a linear.app link (a pull request's
  // description usually does); null otherwise, never a guessed address.
  function issueUrl(issue, text) {
    if (!/^[A-Za-z]{2,10}-\d{1,6}$/.test(String(issue || ''))) return null;
    return String(text || '').match(new RegExp(`https://linear\\.app/[\\w-]+/issue/${issue}(?:/[\\w%-]+)?(?![\\w-])`, 'i'))?.[0] || null;
  }
  // The pull request's own description, as the review last read it (`dcr context`), when this
  // review is of that pull request and it says something; null otherwise.
  function pullRequestDescription(snapshot, review = {}) {
    const url = pullRequestUrl(snapshot, review);
    const said = review.pull_request;
    return url && said?.url === url && typeof said.body === 'string' && said.body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim() ? said.body : null;
  }
  // What the Overview opens with: the pull request's description (pr) or the agent's summary
  // (tldr). The reader's last choice, and the description by default; tldr when there is none.
  const overviewShows = (chosen, description) => description && chosen !== 'tldr' ? 'pr' : 'tldr';
  // Above the title, one small line: the issue (a link to it in Linear when the description names
  // its page), then the pull request and its branches as one link to it on GitHub, and whether
  // this is the checkout. The exact comparison is its tooltip. A branch is written out, and cut
  // with an ellipsis only where the line has no room for it.
  function whereLine(snapshot, review = {}, description = '') {
    const at = where(snapshot, review);
    const pr = pullRequestUrl(snapshot, review);
    const link = (url, title, html, name) => `<a class="${name}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(title)}">${html}</a>`;
    const tracker = at.issue && issueUrl(at.issue, description);
    const issue = at.issue && (tracker ? link(tracker, `Open ${at.issue} in Linear`, `<b>${escapeHTML(at.issue)}</b>`, 'where-issue') : `<b>${escapeHTML(at.issue)}</b>`);
    // In the link its parts are spaced with the text's own spaces, so its underline runs unbroken.
    const branches = (into = '→') => at.head && at.base && `<span class="where-branches"><span class="where-branch">${escapeHTML(at.head)}</span><span aria-label="into">${into}</span><span class="where-branch">${escapeHTML(at.base)}</span></span>`;
    const dot = '<i aria-hidden="true">·</i>';
    const number = at.pr && `PR #${escapeHTML(at.pr)}`;
    const revision = review.history?.revision > 1 && `Revision ${escapeHTML(review.history.revision)}`;
    const parts = pr && number
      ? [issue, link(pr, 'Open the pull request on GitHub', [number, branches('&nbsp;→&nbsp;')].filter(Boolean).join('<i aria-hidden="true">&nbsp;·&nbsp;</i>'), 'where-pr'), at.place && escapeHTML(at.place), revision]
      : [issue, number, at.place && escapeHTML(at.place), revision, branches()];
    return `<p class="overview-where" title="${escapeHTML(comparisonText(snapshot, review))}">${parts.filter(Boolean).join(dot)}</p>`;
  }
  function flowOwner(flow) { return flow.comment_id || (flow.assets || []).find(asset => asset.comment_id)?.comment_id; }
  function evidenceFlows(qa, comment) {
    if (comment.personal) return [];
    return (qa?.flows || []).flatMap((flow, index) => flowOwner(flow) === comment.id ? [index] : []);
  }
  // The comments whose thread is resolved on GitHub, whoever resolved it, as the review's threads
  // have it ({id: {by, at}}): settled here too, until it is reopened there.
  function githubResolved(threads) {
    return Object.fromEntries(Object.entries(threads || {}).filter(([, thread]) => thread?.github_resolved).map(([id, thread]) => [id, thread.github_resolved]));
  }
  function resolvedOnGitHub(resolution) { return resolution ? `Resolved on GitHub${resolution.by ? ` by @${resolution.by}` : ''}` : ''; }
  // A comment the review waits on: its own, not resolved. One from GitHub is settled there, so it
  // never holds back All clear or publishing (ReviewReport.facts), open or not.
  function waitsOnReader(comment) { return !comment.resolved && !comment.author; }
  // Show each issue once, but never hide findings behind an ambiguous comment match.
  function overviewFeedback(review) {
    const comments = (review.comments || []).map(comment => ({...comment}));
    const findings = review.findings || [];
    const remaining = findings.filter(finding => {
      // A finding that names its comment is that comment, whatever its label (a question or a
      // nitpick too): the issue is said once, by the comment, with the finding's priority on it.
      // One that names none is matched only when it is the one issue on its hunk.
      const candidates = comments.filter(comment => comment.label === 'issue' && comment.hunk === finding.hunk);
      const match = finding.comment_id
        ? comments.find(comment => comment.id === finding.comment_id)
        : candidates.length === 1 && findings.filter(other => other.hunk === finding.hunk).length === 1 ? candidates[0] : null;
      if (!match) return true;
      match.severity = finding.severity;
      return false;
    });
    return {comments, findings:remaining};
  }
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  // A path in three parts, which read as the path: the first folder (code or tests), the folders
  // between, and the file's name. A phone squeezes the middle to keep the line; a tap shows it all.
  const pathParts = path => {
    const slash = path.lastIndexOf('/'), first = path.indexOf('/');
    if (slash < 0) return `<span class="path-name">${escapeHTML(path)}</span>`;
    return `<span class="path-head">${escapeHTML(path.slice(0, first + 1))}</span><span class="path-mid"><bdi>${escapeHTML(path.slice(first + 1, slash + 1))}</bdi></span><span class="path-name">${escapeHTML(path.slice(slash + 1))}</span>`;
  };
  // A path that keeps one line on a phone or a tablet, wherever it is shown: its parts, then what
  // follows it and is never cut (the lines a comment is on). Where a tap does nothing else, it
  // shows the whole path (toggle).
  const pathFit = (path, rest = '', toggle = false) => `<span class="path-fit" title="${escapeHTML(path + rest)}"${toggle ? ' data-path-toggle' : ''}><span class="path-parts">${pathParts(path)}</span>${rest ? `<span class="path-rest">${escapeHTML(rest)}</span>` : ''}</span>`;
  // When something was said, as a person reads it beside a message: the day and the time.
  const whenText = at => {
    const date = new Date(Date.parse(at));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  };
  // A row of Your review, drawn the same for every comment, whoever wrote it: where it is in the
  // code on top (path and lines; a general comment says so), then the face, the name and when,
  // and what was said. nameHTML is escaped already.
  const ledgerPlace = (id, path, where) => `<button type="button" class="ledger-place" data-ledger-jump="${escapeHTML(id)}" title="Show in the code">${path ? pathFit(path, ` · ${where}`) : escapeHTML(where)}${(globalThis.ReviewIcons?.['arrow-up-right'] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"')}</button>`;
  const ledgerBy = (nameHTML, at, extra = '') => `<span class="ledger-by"><b class="ledger-name ${extra}">${nameHTML}</b><time class="ledger-when" data-when="${escapeHTML(at || '')}">${escapeHTML(whenText(at))}</time></span>`;
  // Agent-written text (comments, findings, answers) and a pull request's description as a small,
  // safe subset of Markdown: paragraphs, headings, lists (nested by indent), tables, fenced code,
  // `code`, **bold**, *italic*, https links (written or bare) and https images. Everything is
  // escaped first, so nothing a message contains can become markup. HTML comments are not shown.
  // Code and images are set aside first, so **bold**, *italic* and links can hold them, and then
  // put back as they were. An image is the page's own <img> with only its https address and its
  // alt text, written as Markdown or as GitHub's <img> tag.
  const image = (src, alt) => `<img class="md-image" src="${escapeHTML(src)}" alt="${escapeHTML(alt)}" loading="lazy">`;
  const URL_TEXT = '(?:[^\\s<&]|&amp;)*(?:[^\\s<&.,;:!?)\\]*_]|&amp;)';
  const BARE_URL = new RegExp(`(^|\\s)(https:\\/\\/${URL_TEXT})`, 'g');
  const inline = text => {
    const codes = [], images = [];
    const held = String(text).replace(/[\u0000\u0001]/g, '').replace(/`([^`]+)`/g, (match, code) => `\u0000${codes.push(code) - 1}\u0000`)
      .replace(/!\[([^\]\n]*)\]\((https:\/\/[^\s)\u0000]+)\)/g, (match, alt, src) => `\u0001${images.push(image(src, alt)) - 1}\u0001`)
      .replace(/<img\b[^>]*>/gi, tag => {
        const src = tag.match(/\ssrc\s*=\s*["']?(https:\/\/[^"'\s>]+)/i)?.[1];
        return src ? `\u0001${images.push(image(src, tag.match(/\salt\s*=\s*"([^"]*)"|\salt\s*=\s*'([^']*)'/i)?.slice(1).find(Boolean) || '')) - 1}\u0001` : tag;
      });
    return escapeHTML(held)
      .replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, '<strong>$1</strong>') // a bold line may hold *italic*
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)\u0000]+)\)/g, (match, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .replace(BARE_URL, (match, before, url) => `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
      .replace(/\n/g, '<br>')
      .replace(/\u0001(\d+)\u0001/g, (match, index) => images[index])
      .replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${escapeHTML(codes[index].replace(/\s*\n\s*/g, ' '))}</code>`);
  };
  // An image the reader's browser could not load (GitHub's attachments need its sign-in): a link to
  // it instead, never a broken image.
  const screenshotLink = src => /^https:\/\//.test(String(src || '')) ? `<a class="md-image-link" href="${escapeHTML(src)}" target="_blank" rel="noopener noreferrer">Screenshot ↗</a>` : '';
  // A table row's cells. A pipe inside `code` or written as \| belongs to the cell.
  const tableCells = line => {
    const cells = [''];
    let code = false;
    const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      if (char === '\\' && row[i + 1] === '|') { cells[cells.length - 1] += '|'; i++; }
      else if (char === '|' && !code) cells.push('');
      else { if (char === '`') code = !code; cells[cells.length - 1] += char; }
    }
    return cells.map(cell => cell.trim());
  };
  const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const tableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('|');
  const LIST_ITEM = /^(\s*)([-*]|\d+[.)]) +(\S.*)$/;
  // A list and the lists indented under its items, from line i: [html, the line after it].
  const list = (lines, i) => {
    const [, lead, mark] = lines[i].match(LIST_ITEM);
    const ordered = /\d/.test(mark);
    const items = [];
    while (i < lines.length) {
      const item = lines[i].match(LIST_ITEM);
      if (!item || item[1].length < lead.length) break;
      if (item[1].length > lead.length && items.length) { const [nested, next] = list(lines, i); items[items.length - 1] += nested; i = next; continue; }
      if (/\d/.test(item[2]) !== ordered) break;
      items.push(inline(item[3]));
      i++;
    }
    return [`<${ordered ? 'ol' : 'ul'}>${items.map(item => `<li>${item}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`, i];
  };
  // HTML comments are hidden, as GitHub hides them, except inside fenced code.
  const withoutComments = text => text.split(/(^\s*```[^\n]*\n[\s\S]*?^\s*```[^\n]*$)/m).map((part, index) => index % 2 ? part : part.replace(/<!--[\s\S]*?(?:-->|$)/g, '')).join('');
  // headings: how far below the page's own headings a # is (a comment's # is h3; a pull request's
  // description, read under the review's title, starts at h2).
  function markdown(text, {headings = 2} = {}) {
    const lines = withoutComments(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n');
    const out = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (HEADING.test(line)) {
        const [, marks, title] = line.match(HEADING);
        const level = Math.min(6, marks.length + headings);
        out.push(`<h${level}>${inline(title)}</h${level}>`);
        i++;
      } else if (tableStart(lines, i)) {
        const head = tableCells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
        const cells = (row, tag) => head.map((_, n) => `<${tag}>${inline(row[n] ?? '')}</${tag}>`).join('');
        out.push(`<div class="md-table"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table></div>`);
      } else if (/^\s*```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
      } else if (LIST_ITEM.test(line)) {
        const [html, next] = list(lines, i);
        out.push(html);
        i = next;
      } else if (!line.trim()) {
        i++;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !HEADING.test(lines[i]) && !tableStart(lines, i)) para.push(lines[i++]);
        out.push(`<p>${inline(para.join('\n'))}</p>`);
      }
    }
    return out.join('');
  }

  // Whose judgement it is: an agent's model and effort as a short label ("grok-4.7 · high",
  // "big-pickle"), without a provider path; '' when the agent did not say. Claude's models read
  // as their names ("claude-fable-5-2" is "Fable 5.2", the alias "opus" is "Opus").
  function modelName(model) {
    const name = String(model || '').trim().split('/').pop();
    const claude = name.match(/^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+)-(\d+))?(?:-\d{8})?$/i);
    if (!claude) return name;
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1).toLowerCase();
    return claude[2] ? `${family} ${claude[2]}.${claude[3]}` : family;
  }
  function modelText(model, effort) {
    const name = modelName(model);
    return name ? `${name}${effort ? ` · ${effort}` : ''}` : '';
  }

  // --- the Overview's Risk ranking -----------------------------------------------------------
  // The changed files the agent judged risky, scored against a fixed rubric. The level is written
  // from the score, so every file reads the same way: 80+ CRITICAL, 60+ HIGH, 35+ MEDIUM, else LOW.
  const RISK_LEVELS = [[80, 'critical', 'CRITICAL'], [60, 'high', 'HIGH'], [35, 'medium', 'MEDIUM'], [0, 'low', 'LOW']];
  function riskLevel(score) {
    const [, key, label] = RISK_LEVELS.find(([min]) => Number(score) >= min) || RISK_LEVELS[3];
    return {key, label};
  }
  // Two things are known about a file, and its sidebar row shows them apart. The outside verdict
  // (human, llm, none) is who has to read it: the row stays bright when that is the reviewer and
  // dims when it is not. The Risk ranking is how bad a mistake in it would be: a word at the end
  // of the row, MEDIUM or worse. The tip says both in full. Null when neither is known.
  const NEEDS = {human: 'Needs a human review', llm: 'An LLM review is enough', none: 'Needs no review'};
  const RISK_WORDS = {critical: 'CRIT', high: 'HIGH', medium: 'MED'};
  const needLabel = verdict => NEEDS[verdict] || null;
  function fileNeed(verdict, risk) {
    const level = risk ? riskLevel(risk.score) : null;
    const who = NEEDS[verdict] ? verdict : null;
    const lines = [];
    if (who) lines.push(`${NEEDS[who]}, says JevMyPR`);
    if (risk) lines.push(`Risk ${risk.score}% (${level.label})${risk.reason ? `: ${risk.reason}` : ''}`);
    const word = RISK_WORDS[level?.key] || null;
    return who || word ? {who, word, tone: word ? level.key : null, lines} : null;
  }
  const RISK_TAGS = {security: 'Security', 'data-volume': 'Data volume', schema: 'Schema', money: 'Money', background: 'Background work', contract: 'Contract', 'shared-code': 'Shared code', 'user-facing': 'User-facing'};
  const riskTag = tag => RISK_TAGS[tag] || tag;
  // Most risky first; files of equal score keep the agent's order.
  const riskFiles = ranking => [...(ranking?.files || [])].sort((a, b) => b.score - a.score);
  // Your review is not on the Overview, which lists the comments already; elsewhere it is open by
  // choice, and until you choose, on a wide screen once there is something in it. Where it slides
  // over the page it opens for this visit only (overOpen).
  const ledgerOpen = ({view, wide, zen, chosen, overOpen, filled}) => {
    if (view === 'overview') return false;
    if (!wide && !zen) return !!overOpen;
    return typeof chosen === 'boolean' ? chosen : !!(wide && filled);
  };
  // A popover from a button: under it, right edges aligned, or over it when the button is low on
  // the screen, and never past the window's edges.
  const popoverPlace = (anchor, menu, view) => {
    const below = anchor.bottom + 8 + menu.height <= view.height - 8;
    return {top: Math.round(below ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - menu.height)),
      left: Math.round(Math.max(12, Math.min(anchor.right - menu.width, view.width - menu.width - 12)))};
  };
  // Where a review opens. An address that names a step or a view is a link to it. A bare address,
  // or the Overview link every command prints, resumes where the reader stopped, like a bookmark
  // in a book. forced: the page itself reloads onto a view (the Overview, to show new QA clips).
  const landing = (hash, savedView, views, forced) => {
    if (views.includes(forced)) return forced;
    if (hash !== 'overview' && views.includes(hash)) return hash;
    return views.includes(savedView) ? savedView : 'overview';
  };

  return {githubResolved, resolvedOnGitHub, waitsOnReader, whenText, ledgerPlace, screenshotLink, issueUrl, pullRequestDescription, overviewShows, whereLine, ledgerBy, pathParts, pathFit, modelName, modelText, riskLevel, fileNeed, needLabel, riskTag, riskFiles, ledgerOpen, popoverPlace, landing, markdown, focusFiles, layerFiles, sidebarFiles, fullFileHunks, componentGroups, categories, category, walkthroughSections, viewedFiles, fileProgress, anchor, outdatedWhere, displayRows, splitComment, sourceText, commentText, reviewText, setConversationSource, githubItem, overviewFeedback, comparisonText, where, scopeLabel, sha256, githubLink, githubFileLink, evidenceFlows, flowLines, flowOwner, commentBody, postingText, previewEligible, pendingPreviews, previewLifecycle, requestPreviews, visualPrompt};
})();
