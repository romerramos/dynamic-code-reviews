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
  function sourceText(snapshot, comment) {
    const found = anchor(snapshot, comment);
    return found ? found.lines.map(line => `${line[comment.side]} | ${line.text}`).join('\n') : '';
  }
  function commentBody(comment, qa) {
    const evidence = evidenceFlows(qa, comment).map(index => {
      const flow = qa.flows[index];
      return `${flow.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\nExpected: ${flow.expected}\nActual: ${flow.observed}`;
    });
    return [comment.discussion, ...evidence].filter(Boolean).join('\n\n');
  }
  function postingText(snapshot, comment, qa) {
    const found = anchor(snapshot, comment);
    if (!found && !comment.general) throw new Error('Comment range is not present in this snapshot.');
    const location = found ? `File: ${found.file.path} (${comment.side === 'new' ? 'after' : 'before'} lines ${comment.start}–${comment.end})\n\n` : '';
    const body = commentBody(comment, qa);
    return `${comment.label} (${comment.decoration}): ${comment.subject}\n\n${location}${body}`.trim();
  }
  function commentText(snapshot, comment, qa) {
    const found = anchor(snapshot, comment);
    const body = commentBody(comment, qa);
    if (comment.general) return `General comment · ${snapshot.head}\nSnapshot: ${snapshot.fingerprint}${comment.resolved ? '\nConversation: resolved locally (not verification that the code was fixed)' : ''}\n\n${postingText(snapshot, comment, qa)}`;
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
  function comparisonText(snapshot, review = {}) {
    const short = value => String(value || 'unknown').slice(0, 8);
    const supplied = review.comparison;
    // Labels belong to these exact endpoints; old labels must not describe new code.
    const labels = supplied?.base === snapshot.base && supplied?.head === snapshot.head ? supplied : {};
    const before = labels.base_label || short(snapshot.base);
    const after = labels.head_label || short(snapshot.head);
    if (snapshot.mode === 'uncommitted') return 'Uncommitted changes · staged and unstaged edits, plus non-ignored untracked files, compared with HEAD';
    if (snapshot.mode === 'series' && snapshot.working_tree) return `Cumulative review · committed and uncommitted changes compared with ${before}`;
    if (snapshot.mode === 'pr' || (snapshot.mode === 'series' && review.history?.origin_mode === 'pr')) return `${labels.pr_number ? `PR #${labels.pr_number}` : 'PR review'} · ${after} compared with ${before} · branch changes since their merge base`;
    if (snapshot.mode === 'commit') return `Commit review · ${short(snapshot.head)} compared with ${before}`;
    return `Cumulative review · ${after} compared with ${before}`;
  }
  function flowOwner(flow) { return flow.comment_id || (flow.assets || []).find(asset => asset.comment_id)?.comment_id; }
  function evidenceFlows(qa, comment) {
    if (comment.personal) return [];
    return (qa?.flows || []).flatMap((flow, index) => flowOwner(flow) === comment.id ? [index] : []);
  }
  // Show each issue once, but never hide findings behind an ambiguous comment match.
  function overviewFeedback(review) {
    const comments = (review.comments || []).map(comment => ({...comment}));
    const findings = review.findings || [];
    const remaining = findings.filter(finding => {
      const candidates = comments.filter(comment => comment.label === 'issue' && comment.hunk === finding.hunk);
      const match = finding.comment_id
        ? candidates.find(comment => comment.id === finding.comment_id)
        : candidates.length === 1 && findings.filter(other => other.hunk === finding.hunk).length === 1 ? candidates[0] : null;
      if (!match) return true;
      match.severity = finding.severity;
      return false;
    });
    return {comments, findings:remaining};
  }
  return {focusFiles, layerFiles, sidebarFiles, fullFileHunks, componentGroups, categories, category, walkthroughSections, viewedFiles, fileProgress, anchor, sourceText, commentText, reviewText, overviewFeedback, comparisonText, evidenceFlows, flowOwner, commentBody, postingText, previewEligible, pendingPreviews, previewLifecycle, requestPreviews, visualPrompt};
})();
