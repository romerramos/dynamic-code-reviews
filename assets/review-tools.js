/* Pure helpers shared by the offline UI and its Node checks. */
'use strict';
globalThis.ReviewTools = (() => {
  function focusFiles(layers) {
    const seen = new Set();
    return layers.flatMap(layer => walkthroughSections(layer).flatMap(section => section.item ? [section.item] : section.items || [])
      .flatMap(item => { if (seen.has(item.file)) return []; seen.add(item.file); return [{file:item.file, layer}]; }));
  }
  function fullFileHunks(file) {
    if (!file.source) return null;
    const lines = side => file.source[side] === '' ? [] : file.source[side].replace(/\n$/, '').split('\n');
    const old = lines('old'), after = lines('new');
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
  function anchor(snapshot, comment) {
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
  return {focusFiles, fullFileHunks, componentGroups, categories, category, walkthroughSections, viewedFiles, fileProgress, anchor, sourceText, commentText, reviewText, overviewFeedback, comparisonText, evidenceFlows, flowOwner, commentBody, postingText};
})();
