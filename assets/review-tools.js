/* Pure helpers shared by the offline UI and its Node checks. */
'use strict';
globalThis.ReviewTools = (() => {
  const categories = ['Design / UI', 'Frontend', 'Backend', 'Documentation', 'Tests', 'Platform', 'Security', 'AI', 'Other'];
  const designFile = path => /(?:\.html(?:\.erb)?|\.(?:css|scss|sass))$/i.test(path);
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
  return {categories, category, walkthroughSections, anchor, sourceText, commentText, reviewText, overviewFeedback, comparisonText, evidenceFlows, flowOwner, commentBody, postingText};
})();
