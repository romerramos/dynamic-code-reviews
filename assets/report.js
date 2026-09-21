/* Offline review UI. No framework, build step, network requests or code execution. */
'use strict';
(() => {
  const {snapshot, review} = JSON.parse(document.getElementById('data').textContent);
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => (window.ReviewIcons[name] || '').replace('class="lucide', 'class="review-icon lucide').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  const files = new Map(snapshot.files.map(file => [file.id, file]));
  const hunkFiles = new Map(snapshot.files.flatMap(file => file.hunks.map(hunk => [hunk.id, file])));
  const layers = review.groups.flatMap((group, groupIndex) => group.layers.map((layer, layerIndex) => ({...layer, group, id:`g${groupIndex}l${layerIndex}`})));
  const feedback = ReviewTools.overviewFeedback(review);
  const generatedComments = feedback.comments;
  let comments = [];
  const storageKey = `dynamic-review:${snapshot.fingerprint}${review.history ? `:${review.history.series}:${review.history.revision}` : ""}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { /* file:// storage may be disabled */ }
  const state = {view:'overview', notes:{}, personalComments:[], resolvedComments:[], fileOpen:{}, groupOpen:{}, ...saved};
  state.viewedFiles = ReviewTools.viewedFiles(snapshot, layers, saved);
  delete state.viewed;
  const fileViewed = file => state.viewedFiles.includes(file.path);
  const fileOpen = file => Object.hasOwn(state.fileOpen, file.path) ? state.fileOpen[file.path] : !fileViewed(file);
  const progress = items => ReviewTools.fileProgress(items.map(item => files.get(item.file).path), state.viewedFiles);
  const progressText = value => `${value.viewed} of ${value.total} files viewed`;
  state.resolvedComments = Array.isArray(state.resolvedComments) ? state.resolvedComments.filter(id => typeof id === 'string') : [];
  state.personalComments = Array.isArray(state.personalComments) ? state.personalComments.filter(comment => typeof comment.id === 'string' && comment.id.startsWith('mine-') && typeof comment.subject === 'string' && (comment.general === true || ReviewTools.anchor(snapshot, comment))) : [];
  function refreshComments() { comments = [...generatedComments.map(comment => ({...comment, personal:false})), ...state.personalComments.map(comment => ({...comment, personal:true}))].map(comment => ({...comment, resolved:state.resolvedComments.includes(comment.id)})); }
  refreshComments();
  const tabletLayout = matchMedia('(max-width: 1199px)');
  let layoutChoice = 'auto';
  let layout = tabletLayout.matches ? 'unified' : 'split';
  let categoryFilter = 'All';
  let selection = null;
  let editorRange = null;
  let editingID = null;
  let showComments = true;
  const highlightCache = new Map();

  function persist() {
    let stored = true;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { stored = false; }
    $('progress').textContent = progressText({viewed:state.viewedFiles.length, total:files.size});
    $('progress-bar').max = Math.max(1, files.size);
    $('progress-bar').value = state.viewedFiles.length;
    return stored;
  }
  const bulletList = items => items?.length ? `<ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  const flow = steps => steps?.length ? `<div class="flow" role="img" aria-label="${escape(steps.join(' → '))}">${steps.map((step, index) => `${index ? '<b aria-hidden="true">→</b>' : ''}<span>${escape(step)}</span>`).join('')}</div>` : '';
  const hunkIDs = layer => layer.items.flatMap(item => Object.keys(item.summaries || {}));
  const layerComments = layer => comments.filter(comment => hunkIDs(layer).includes(comment.hunk));
  const titleWithoutNumber = title => title.replace(/^\d+\s*[·.]\s*/, '');

  function renderNavigation() {
    const query = $('search').value.trim().toLowerCase();
    let html = `<ul class="menu"><li><button data-view="overview" aria-current="${state.view === 'overview' ? 'page' : 'false'}"><span class="step-number">☷</span><span class="step-body"><strong>Overview</strong><small>Comments & evidence</small></span></button></li><li><button data-view="files" aria-current="${state.view === 'files' ? 'page' : 'false'}"><span class="step-number">⌘</span><span class="step-body"><strong>All changes</strong><small>Diffs by responsibility · ${files.size} files</small></span></button></li></ul>`;
    review.groups.forEach((group, groupIndex) => {
      const matching = layers.filter(layer => layer.group === group && `${group.title} ${layer.title} ${layer.items.map(item => files.get(item.file).path).join(' ')}`.toLowerCase().includes(query));
      if (!matching.length) return;
      const groupKey = group.id || `group-${groupIndex}`;
      const groupProgress = progress(group.layers.flatMap(layer => layer.items));
      html += `<details data-nav-group="${escape(groupKey)}" ${query || state.groupOpen[groupKey] !== false ? 'open' : ''}><summary>${escape(titleWithoutNumber(group.title))}<small class="group-progress">${progressText(groupProgress)}</small></summary><ul class="menu">`;
      matching.forEach(layer => {
        const count = layerComments(layer).length;
        const revisionState = review.history?.groups?.[layer.group.id];
        const completed = progress(layer.items);
        const links = [...new Set(layer.items.map(item => item.file))].map(id => {
          const file = files.get(id);
          const slash = file.path.lastIndexOf('/');
          const filename = file.path.slice(slash + 1);
          const directory = slash < 0 ? '' : file.path.slice(0, slash);
          return `<li><button class="nav-file ${fileViewed(file) ? 'is-viewed' : ''}" data-file-link="${id}" data-file-layer="${layer.id}" title="${escape(file.path)}" aria-label="${escape(`Open ${file.path}${fileViewed(file) ? ', viewed' : ', not viewed'}`)}"><span class="file-status" aria-hidden="true">${fileViewed(file) ? icon('check') : ''}</span><span class="nav-file-label"><span class="nav-file-name">${escape(filename)}</span>${directory ? `<small class="nav-file-directory">${escape(directory)}</small>` : ''}</span></button></li>`;
        }).join('');
        html += `<li><button data-view="${layer.id}" aria-current="${state.view === layer.id ? 'page' : 'false'}"><span class="step-number">${completed.total && completed.viewed === completed.total ? icon('check') : layers.indexOf(layer) + 1}</span><span class="step-body"><strong>${escape(layer.title)}</strong><small>${progressText(completed)}${count ? ` · ${count} comments` : ''}${revisionState ? ` · ${escape(revisionState)}` : ''}</small></span></button><ul class="nav-files">${links}</ul></li>`;
      });
      html += '</ul></details>';
    });
    $('navigation').innerHTML = html;
  }

  function language(path) {
    if (/\.html\.erb$/i.test(path)) return 'markup';
    if (/\.(scss|sass)$/i.test(path)) return 'css';
    const extension = path.split('.').pop().toLowerCase();
    return ({rb:'ruby',rake:'ruby',gemspec:'ruby',js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',json:'json',yml:'yaml',yaml:'yaml',sql:'sql',html:'markup',xml:'markup',svg:'markup',css:'css',sh:'bash',bash:'bash'})[extension] || (/\b(Gemfile|Rakefile)$/.test(path) ? 'ruby' : 'none');
  }

  // Tokenize a whole side of a hunk, then distribute escaped tokens across its
  // physical lines. This preserves multiline strings/comments and exact text.
  function highlightedLines(lines, lang) {
    if (!lines.length) return [];
    const source = lines.map(line => line.text).join('\n');
    const tokens = Prism.languages[lang] ? Prism.tokenize(source, Prism.languages[lang]) : [source];
    const result = [''];
    function append(token, ancestors = []) {
      if (Array.isArray(token)) { token.forEach(item => append(item, ancestors)); return; }
      if (typeof token !== 'string') { append(token.content, [...ancestors, token.type]); return; }
      token.split('\n').forEach((part, index) => {
        if (index) result.push('');
        const content = escape(part);
        result[result.length - 1] += ancestors.reduceRight((inner, type) => `<span class="token ${escape(type)}">${inner}</span>`, content);
      });
    }
    append(tokens);
    return result;
  }

  function highlights(hunk, path) {
    if (highlightCache.has(hunk.id)) return highlightCache.get(hunk.id);
    const result = {};
    ['old','new'].forEach(side => {
      const lines = hunk.rows.unified.filter(line => line[side] !== undefined);
      const colored = highlightedLines(lines, language(path));
      result[side] = new Map(lines.map((line, index) => [line[side], colored[index]]));
    });
    highlightCache.set(hunk.id, result);
    return result;
  }

  let commentAnchor = null;

  function lineButton(hunk, side, number, comment = null) {
    if (number === undefined) return '';
    if (comment) return `<span class="line-number">${number}</span>`;
    return `<button class="line-number" type="button" data-select-line="${number}" data-range-hunk="${hunk.id}" data-range-side="${side}" aria-label="Select ${side === 'new' ? 'after' : 'before'} line ${number} in ${escape(hunkFiles.get(hunk.id).path)}" title="Select line to comment">${number}</button>`;
  }
  function clearSelection() {
    selection = null;
    $('range-actions').hidden = true;
    document.querySelectorAll('.user-range-selected').forEach(cell => cell.classList.remove('user-range-selected'));
  }
  function paintSelection() {
    document.querySelectorAll('.user-range-selected').forEach(cell => cell.classList.remove('user-range-selected'));
    if (!selection) return;
    document.querySelectorAll('.gutter[data-line]').forEach(cell => {
      if (cell.dataset.hunk !== selection.hunk || cell.dataset.side !== selection.side || Number(cell.dataset.line) < selection.start || Number(cell.dataset.line) > selection.end) return;
      cell.classList.add('user-range-selected');
      (layout === 'split' ? cell.nextElementSibling : cell.parentElement.querySelector('.code'))?.classList.add('user-range-selected');
    });
    $('range-label').textContent = `${selection.side === 'new' ? 'After' : 'Before'} L${selection.start}–${selection.end} · ${hunkFiles.get(selection.hunk).path.split('/').pop()}`;
    $('range-actions').hidden = false;
  }
  function selectLine(button) {
    closeComments();
    const number = Number(button.dataset.selectLine);
    const hunk = button.dataset.rangeHunk;
    const side = button.dataset.rangeSide;
    const origin = selection?.hunk === hunk && selection.side === side ? selection.origin : number;
    selection = {hunk, side, origin, start:Math.min(origin, number), end:Math.max(origin, number)};
    if (!ReviewTools.anchor(snapshot, selection)) { clearSelection(); return; }
    paintSelection();
  }
  function openEditor(comment = null, general = false) {
    const range = comment || (general ? {general:true} : selection);
    if (!range || (!range.general && !ReviewTools.anchor(snapshot, range))) return;
    closeComments();
    editorRange = range.general ? {general:true} : {hunk:range.hunk, side:range.side, start:range.start, end:range.end};
    editingID = comment?.id || null;
    $('editor-title').textContent = comment ? 'Edit your comment' : 'Add your comment';
    $('editor-location').textContent = range.general ? 'General comment on this review' : `${hunkFiles.get(range.hunk).path} · ${range.side === 'new' ? 'After' : 'Before'} L${range.start}–${range.end}`;
    $('editor-snippet').hidden = !!range.general;
    $('editor-snippet').textContent = range.general ? '' : ReviewTools.sourceText(snapshot, range);
    $('editor-label').value = comment?.label || 'note';
    $('editor-subject').value = comment?.subject || '';
    $('editor-discussion').value = comment?.discussion || '';
    $('editor-blocking').checked = comment?.decoration === 'blocking';
    $('comment-editor').showModal();
    $('editor-subject').focus();
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
    catch {
      closeComments();
      $('copy-text').value = text;
      $('copy-dialog').showModal();
      $('copy-text').focus(); $('copy-text').select();
    }
  }

  function commentHTML(comment) {
    return `<section class="popover-comment"><p class="comment-location">${escape(ReviewTools.anchor(snapshot, comment)?.file.path || '')}</p><div class="thread-badges">${threadBadges(comment)}</div><p class="comment-location">${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}</p><h4>${escape(comment.subject)}</h4>${ReviewTools.commentBody(comment, review.qa) ? `<p class="comment-discussion">${escape(ReviewTools.commentBody(comment, review.qa))}</p>` : ''}${ReviewTools.evidenceFlows(review.qa, comment).length ? `<button class="btn btn-xs btn-soft" data-evidence="${escape(comment.id)}">See visual evidence</button>` : ''}<div class="comment-actions"><button class="btn btn-xs btn-ghost" data-copy="${escape(comment.id)}">${icon('copy')} Copy for LLMs</button>${comment.personal ? `<button class="btn btn-xs btn-ghost" data-edit="${escape(comment.id)}">${icon('pencil')} Edit</button><button class="btn btn-xs btn-ghost" data-delete="${escape(comment.id)}">${icon('trash-2')} Delete</button>` : ""}</div></section>`;
  }

  function commentTrigger(hunk, side, number, comment = null) {
    if (comment || !showComments || number === undefined) return '';
    const anchored = comments.filter(comment => comment.hunk === hunk.id && comment.side === side && comment.start === number);
    if (!anchored.length) return '';
    const label = anchored.length === 1 ? `Read ${anchored[0].label}: ${anchored[0].subject}` : `Read ${anchored.length} comments on ${side === 'new' ? 'after' : 'before'} line ${number}`;
    return `<button class="comment-trigger" type="button" data-notes="${anchored.map(comment => escape(comment.id)).join(' ')}" aria-label="${escape(label)}" title="${escape(label)}" aria-haspopup="dialog" aria-controls="comment-popover" aria-expanded="false">${icon('message-square')}</button>`;
  }

  function highlightComments(ids) {
    $('content').querySelectorAll('.range-selected').forEach(cell => cell.classList.remove('range-selected'));
    const selected = comments.filter(comment => ids.includes(comment.id));
    $('content').querySelectorAll('.gutter[data-line]').forEach(cell => {
      if (!selected.some(comment => comment.hunk === cell.dataset.hunk && comment.side === cell.dataset.side && Number(cell.dataset.line) >= comment.start && Number(cell.dataset.line) <= comment.end)) return;
      cell.classList.add('range-selected');
      const code = layout === 'split' ? cell.nextElementSibling : cell.parentElement.querySelector('.code');
      code?.classList.add('range-selected');
    });
  }

  function closeComments() {
    const popover = $('comment-popover');
    if (popover.matches(':popover-open')) popover.hidePopover();
    commentAnchor?.setAttribute('aria-expanded', 'false');
    commentAnchor = null;
    highlightComments([]);
  }

  function positionComment() {
    const popover = $('comment-popover');
    if (!commentAnchor?.isConnected || !popover.matches(':popover-open')) return;
    const anchor = commentAnchor.getBoundingClientRect();
    const content = $('content').getBoundingClientRect();
    if (anchor.bottom < content.top || anchor.top > Math.min(content.bottom, innerHeight) || anchor.right < content.left || anchor.left > innerWidth) { closeComments(); return; }
    const box = popover.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.right + 8, innerWidth - box.width - 12));
    const below = anchor.bottom + 8;
    const top = below + box.height <= innerHeight - 12 ? below : Math.max(12, anchor.top - box.height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function openComment(trigger) {
    const popover = $('comment-popover');
    if (trigger === commentAnchor && popover.matches(':popover-open')) { closeComments(); return; }
    commentAnchor?.setAttribute('aria-expanded', 'false');
    commentAnchor = trigger;
    const ids = trigger.dataset.notes.split(' ');
    const anchored = comments.filter(comment => ids.includes(comment.id));
    popover.innerHTML = `<header class="popover-heading"><strong id="comment-popover-title">${anchored.length === 1 ? 'Review comment' : `${anchored.length} review comments`}</strong><button type="button" class="btn btn-xs btn-circle btn-ghost" data-close-comment aria-label="Close comment">✕</button></header>${anchored.map(commentHTML).join('')}`;
    trigger.setAttribute('aria-expanded', 'true');
    highlightComments(ids);
    if (!popover.matches(':popover-open')) popover.showPopover();
    positionComment();
    popover.querySelector('[data-close-comment]').focus({preventScroll:true});
  }

  function rangeClasses(hunk, side, number, comment = null) {
    if (comment) return comment.side === side && number >= comment.start && number <= comment.end ? ' range-selected' : '';
    if (!showComments || number === undefined) return '';
    const matches = comments.filter(comment => comment.hunk === hunk.id && comment.side === side && number >= comment.start && number <= comment.end);
    if (!matches.length) return '';
    return ` annotated${matches.some(comment => comment.start === number) ? ' range-start' : ''}${matches.some(comment => comment.end === number) ? ' range-end' : ''}`;
  }

  function splitCells(hunk, line, side, colored, comment = null) {
    const divider = side === 'new' ? ' side-divider' : '';
    if (!line) return `<td class="gutter empty${divider}"></td><td class="code empty" aria-label="No corresponding line"></td>`;
    const number = line[side];
    const marked = rangeClasses(hunk, side, number, comment);
    const kind = line.kind === 'context' ? '' : line.kind;
    const sign = line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' ';
    return `<td class="gutter ${kind}${divider}${marked}" data-hunk="${hunk.id}" data-side="${side}" data-line="${number}">${commentTrigger(hunk, side, number, comment)}${lineButton(hunk, side, number, comment)}</td><td class="code ${kind}${marked}"><code><span class="sign" aria-hidden="true">${sign}</span>${colored[side].get(number) || ''}</code>${line.no_newline ? '<span class="newline-marker">No newline at end of file</span>' : ''}</td>`;
  }

  function renderHunk(hunk, summary, path, mode = layout, comment = null) {
    const columns = mode === 'split' ? 4 : 3;
    const colored = highlights(hunk, path);
    const range = (side) => hunk[`${side}_count`] === 0 ? '—' : `${hunk[`${side}_start`]}–${hunk[`${side}_start`] + hunk[`${side}_count`] - 1}`;
    const heading = `<tr class="range-heading" id="${comment ? 'expanded-' : ''}${hunk.id}"><td colspan="${columns}"><div class="range-label"><span>CHANGED RANGE</span><span>Before ${range('old')} &nbsp; / &nbsp; After ${range('new')}</span></div><p>${escape(summary)}</p></td></tr>`;
    return heading + hunk.rows[mode].map(row => {
      if (mode === 'split') return `<tr class="code-row">${splitCells(hunk, row.old, 'old', colored, comment)}${splitCells(hunk, row.new, 'new', colored, comment)}</tr>`;
      const side = row.kind === 'del' ? 'old' : 'new';
      const marked = rangeClasses(hunk, 'old', row.old, comment) + rangeClasses(hunk, 'new', row.new, comment);
      const kind = row.kind === 'context' ? '' : row.kind;
      const sign = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
      return `<tr class="code-row"><td class="gutter ${kind}${rangeClasses(hunk,'old',row.old,comment)}" data-hunk="${hunk.id}" data-side="old" ${row.old !== undefined ? `data-line="${row.old}"` : ''}>${commentTrigger(hunk, 'old', row.old, comment)}${lineButton(hunk, 'old', row.old, comment)}</td><td class="gutter ${kind}${rangeClasses(hunk,'new',row.new,comment)}" data-hunk="${hunk.id}" data-side="new" ${row.new !== undefined ? `data-line="${row.new}"` : ''}>${commentTrigger(hunk, 'new', row.new, comment)}${lineButton(hunk, 'new', row.new, comment)}</td><td class="code ${kind}${marked}"><code><span class="sign" aria-hidden="true">${sign}</span>${colored[side].get(row[side]) || ''}</code>${row.no_newline ? '<span class="newline-marker">No newline at end of file</span>' : ''}</td></tr>`;
    }).join('');
  }

  function renderDiffTable(file, hunks, summaries, mode = layout, comment = null) {
    return `<div class="diff-scroll"><table class="diff-table ${mode}" aria-label="${escape(file.path)} ${mode} diff"><colgroup><col class="gutter">${mode === 'split' ? '<col><col class="gutter"><col>' : '<col class="gutter"><col>'}</colgroup><thead><tr>${mode === 'split' ? `<th colspan="2">BEFORE · ${escape(snapshot.base.slice(0,8))}</th><th colspan="2" class="after">AFTER · ${escape(snapshot.mode === 'uncommitted' || snapshot.working_tree ? 'working tree' : snapshot.head.slice(0,8))}</th>` : '<th>OLD</th><th>NEW</th><th>CODE</th>'}</tr></thead><tbody>${hunks.map(hunk => renderHunk(hunk, summaries[hunk.id], file.path, mode, comment)).join('')}</tbody></table></div>`;
  }

  function renderFile(item) {
    const file = files.get(item.file);
    const hunks = file.hunks.filter(hunk => Object.hasOwn(item.summaries || {}, hunk.id));
    const changes = hunks.flatMap(hunk => hunk.rows.unified);
    const added = changes.filter(line => line.kind === 'add').length;
    const removed = changes.filter(line => line.kind === 'del').length;
    const table = renderDiffTable(file, hunks, item.summaries);
    return `<details class="file-card ${fileViewed(file) ? 'is-viewed' : ''}" data-file="${file.id}" ${fileOpen(file) ? 'open' : ''}><summary><span class="file-icon" aria-hidden="true">&lt;/&gt;</span><span class="filename">${escape(file.path)}</span><span class="badge success">+${added}</span><span class="badge blocking">−${removed}</span><label class="file-viewed"><input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-file-viewed="${file.id}" aria-label="${escape(`Mark ${file.path} as viewed`)}" ${fileViewed(file) ? 'checked' : ''}> Viewed</label></summary>${item.summary || file.note ? `<div class="file-summary">${escape(item.summary || '')}${file.note ? ` · ${escape(file.note)}` : ''}</div>` : ''}${hunks.length ? table : `<div class="file-summary"><pre>${escape(file.patch || 'No text diff available.')}</pre></div>`}</details>`;
  }

  const commentTypes = {
    note:['info', 'Note', 'Context worth knowing', 'blue'],
    praise:['thumbs-up', 'Praise', 'What works well', 'green'],
    question:['circle-help', 'Question', 'An answer would help', 'purple'],
    thought:['lightbulb', 'Thought', 'An idea to consider', 'amber'],
    issue:['circle-alert', 'Issue', 'A problem to address', 'red'],
    suggestion:['message-circle', 'Suggestion', 'A proposed improvement', 'teal'],
    todo:['list-todo', 'Todo', 'A follow-up task', 'amber'],
    chore:['wrench', 'Chore', 'Routine maintenance', 'blue'],
    nitpick:['scan-text', 'Nitpick', 'A small preference', 'slate'],
    typo:['spell-check', 'Typo', 'A spelling correction', 'slate'],
    polish:['sparkles', 'Polish', 'A finishing touch', 'teal'],
    quibble:['message-circle', 'Quibble', 'A minor concern', 'slate']
  };
  function threadBadges(comment) {
    const [symbol, title, hint, tone] = commentTypes[comment.label] || commentTypes.note;
    return `<span class="thread-type type-${tone}" title="${hint}"><span class="thread-type-icon">${icon(symbol)}</span>${title}</span><span class="thread-priority ${comment.decoration === 'blocking' ? 'is-blocking' : 'is-optional'}">${comment.decoration === 'blocking' ? `${icon('circle-alert')} Blocking` : 'Non-blocking'}</span>${comment.severity ? `<span class="thread-severity">${escape(comment.severity)}</span>` : ''}${comment.resolved ? `<span class="thread-resolved">${icon('check')} Resolved locally</span>` : ''}${comment.personal ? '<span class="thread-author">Your comment</span>' : ''}`;
  }
  function commentCard(comment) {
    const found = ReviewTools.anchor(snapshot, comment);
    if (!found && !comment.general) return '';
    const id = escape(comment.id);
    const range = found ? `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}` : '';
    return `<article class="review-thread ${comment.resolved ? 'is-resolved' : ''}" data-thread-id="${id}"><div class="thread-file"><span class="thread-file-path">${escape(found?.file.path || 'General comment')}</span><span class="thread-range">${found ? range : ''}</span></div><details class="thread-details" ${comment.resolved ? '' : 'open'}><summary class="thread-summary" aria-label="Comment: ${escape(comment.subject)}"><span class="thread-badges">${threadBadges(comment)}</span><strong>${escape(comment.subject)}</strong><span class="thread-chevron">${icon('chevron-down')}</span></summary><div class="thread-body">${comment.discussion ? `<p class="comment-discussion">${escape(comment.discussion)}</p>` : ''}${commentEvidence(comment)}</div>${found ? `<button class="thread-source btn btn-sm btn-ghost" type="button" data-open-code="${id}" aria-haspopup="dialog" aria-label="${escape(`View code for ${found.file.path}, ${range}: ${comment.subject}`)}">View code · ${found.lines.length} line${found.lines.length === 1 ? '' : 's'} ${icon('arrow-right')}</button>` : ''}</details><div class="thread-footer"><div class="comment-actions"><button class="btn btn-sm btn-soft" data-copy-comment="${id}">${icon('copy')} Copy for comment</button><button class="btn btn-sm btn-ghost" data-copy="${id}">${icon('copy')} Copy for LLMs</button>${found ? `<button class="btn btn-sm btn-ghost" data-comment="${id}">Open in diff ${icon('arrow-right')}</button>` : ''}${comment.personal ? `<button class="btn btn-sm btn-ghost" data-edit="${id}">${icon('pencil')} Edit</button><button class="btn btn-sm btn-ghost" data-delete="${id}">${icon('trash-2')} Delete</button>` : ''}</div><button class="btn btn-sm ${comment.resolved ? 'btn-ghost' : 'btn-soft'}" data-resolve="${id}">${comment.resolved ? `${icon('rotate-ccw')} Reopen` : `${icon('check')} Resolve`}</button></div></article>`;
  }
  function toggleResolved(id) {
    const comment = comments.find(comment => comment.id === id);
    if (!comment) return;
    const thread = [...document.querySelectorAll('[data-thread-id]')].find(card => card.dataset.threadId === id);
    const top = thread?.getBoundingClientRect().top;
    state.resolvedComments = state.resolvedComments.filter(value => value !== id);
    if (!comment.resolved) state.resolvedComments.push(id);
    refreshComments();
    const stored = persist();
    render();
    const updated = [...document.querySelectorAll('[data-thread-id]')].find(card => card.dataset.threadId === id);
    if (updated && top !== undefined) $('content').scrollTop += updated.getBoundingClientRect().top - top;
    updated?.querySelector('[data-resolve]')?.focus({preventScroll:true});
    toast(stored ? (comment.resolved ? 'Conversation reopened.' : 'Conversation resolved locally.') : 'Browser storage is unavailable. Export local notes to keep your resolution state.');
  }
  function personalNotes() {
    return layers.filter(layer => typeof state.notes[layer.id] === 'string' && state.notes[layer.id].trim()).map(layer => ({title:layer.title, paths:layer.items.map(item => files.get(item.file).path), text:state.notes[layer.id], id:layer.id}));
  }
  function renderMyReview() {
    const personal = comments.filter(comment => comment.personal);
    const notes = personalNotes();
    return `<section class="review-section" id="my-review"><div class="section-heading"><div><h2>User comments <span class="badge neutral">${personal.length + notes.length}</span></h2><p>Add a general comment here, or select code lines in the diff. Saved in this browser for this review revision.</p></div><div class="comment-actions"><button class="btn btn-sm btn-primary" data-add-general>Add comment</button><button class="btn btn-sm btn-soft" data-copy-all ${personal.length + notes.length ? '' : 'disabled'}>Copy all for LLMs</button></div></div>${personal.length + notes.length ? personal.map(commentCard).join('') + notes.map(note => `<article class="review-comment personal-comment"><span class="badge neutral">Your step note</span><h3>${escape(note.title)}</h3><p class="comment-discussion">${escape(note.text)}</p><button class="btn btn-sm btn-soft" data-copy-note="${note.id}">Copy for LLMs</button><button class="btn btn-sm btn-ghost" data-view="${note.id}">Open step →</button></article>`).join('') : '<p class="review-empty">No user comments yet.</p>'}</section>`;
  }
  function findingComment(finding) {
    const file = hunkFiles.get(finding.hunk);
    const hunk = file.hunks.find(hunk => hunk.id === finding.hunk);
    const side = hunk.new_count ? 'new' : 'old';
    const start = hunk[`${side}_start`];
    return {hunk:hunk.id, side, start, end:start + hunk[`${side}_count`] - 1, label:'issue', decoration:'blocking', subject:finding.title,
      discussion:`${finding.body}\n\nThe snippet covers the related diff hunk; the finding may concern only part of it.`};
  }
  function findingCard(finding, index) {
    return `<article class="review-comment"><span class="badge blocking">${escape(finding.severity)}</span><p class="comment-location">${escape(hunkFiles.get(finding.hunk).path)}</p><h3>${escape(finding.title)}</h3><p class="comment-discussion">${escape(finding.body)}</p><div class="comment-actions"><button class="btn btn-sm btn-ghost" data-hunk="${escape(finding.hunk)}">See changed code →</button><button class="btn btn-sm btn-soft" data-post-finding="${index}">${icon('copy')} Copy for comment</button><button class="btn btn-sm btn-ghost" data-copy-finding="${index}">${icon('copy')} Copy for LLMs</button></div></article>`;
  }
  function renderQAAsset(asset) {
    return `<figure class="qa-asset">${asset.data_uri.startsWith('data:video/') ? `<video controls preload="none" playsinline aria-label="${escape(asset.caption)}" src="${escape(asset.data_uri)}"></video>` : `<button class="qa-image-button" type="button" data-expand-image aria-label="${escape(`Expand screenshot: ${asset.caption}`)}" aria-haspopup="dialog"><img loading="lazy" alt="${escape(asset.caption)}" src="${escape(asset.data_uri)}"><span class="qa-image-hint">Click to expand</span></button>`}<figcaption>${escape(asset.caption)}</figcaption></figure>`;
  }
  let viewerAnchor;
  let viewerCode = null;
  let viewerLayout = 'auto';
  let viewerLabel = 'Screenshot viewer';
  const expandedViewer = GLightbox({
    selector:null, elements:[], openEffect:'none', closeEffect:'none', slideEffect:'none',
    autoplayVideos:false, preload:false, keyboardNavigation:false, svg:{close:icon('x')},
    onOpen:() => {
      const viewer = $('glightbox-body');
      viewer.setAttribute('aria-label', viewerLabel);
      viewer.setAttribute('aria-modal', 'true');
      viewer.querySelector('.gclose').focus({preventScroll:true});
    },
    onClose:() => {
      const anchor = viewerAnchor?.isConnected ? viewerAnchor : [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find(button => button.getAttribute('aria-label') === viewerAnchor?.getAttribute('aria-label'));
      anchor?.focus({preventScroll:true});
      viewerCode = null;
    }
  });
  function expandImage(button) {
    const image = button.querySelector('img');
    viewerAnchor = button;
    viewerLabel = 'Screenshot viewer';
    viewerCode = null;
    expandedViewer.setElements([{href:image.src, type:'image', alt:image.alt, title:escape(image.alt),
      description:'Click or pinch the image to zoom; drag to pan.'}]);
    expandedViewer.open();
  }
  function renderExpandedCode() {
    if (!viewerCode || !$('expanded-diff-body')) return;
    const {file, hunk, comment} = viewerCode;
    const autoMode = tabletLayout.matches ? 'unified' : 'split';
    const mode = viewerLayout === 'auto' ? autoMode : viewerLayout;
    const body = $('expanded-diff-body');
    const scroll = body.scrollTop;
    body.innerHTML = renderDiffTable(file, [hunk], {[hunk.id]:comment.subject}, mode, comment);
    body.scrollTop = scroll;
    document.querySelectorAll('[data-viewer-layout]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.viewerLayout === viewerLayout);
      if (button.dataset.viewerLayout === 'auto') button.textContent = `Auto (${autoMode})`;
    });
  }
  function expandCode(button) {
    const comment = comments.find(comment => comment.id === button.dataset.openCode);
    const found = comment && ReviewTools.anchor(snapshot, comment);
    if (!found) return;
    viewerAnchor = button;
    viewerLabel = 'Code diff viewer';
    viewerLayout = 'auto';
    viewerCode = {...found, comment};
    const content = document.createElement('section');
    content.className = 'expanded-diff';
    content.innerHTML = `<header class="expanded-diff-header"><p class="eyebrow">Comment context</p><h2>${escape(found.file.path)}</h2><p>${escape(comment.subject)} · ${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}</p><div class="join" role="group" aria-label="Expanded diff layout">${['auto','unified','split'].map(mode => `<button class="btn btn-sm join-item" type="button" data-viewer-layout="${mode}" aria-pressed="${mode === 'auto'}">${mode === 'auto' ? 'Auto' : mode === 'split' ? 'Split' : 'Unified'}</button>`).join('')}</div></header><div id="expanded-diff-body" class="expanded-diff-body" tabindex="0" role="region" aria-label="Comment context diff"></div>`;
    expandedViewer.setElements([{type:'inline', content, width:'96vw', height:'92vh', draggable:false}]);
    expandedViewer.open();
    renderExpandedCode();
  }
  const expandedTests = new Set();
  function renderWalkthroughFiles(layer) {
    return ReviewTools.walkthroughSections(layer).map(section => {
      if (section.item) return renderFile(section.item);
      const count = section.items.reduce((sum, item) => sum + Object.keys(item.summaries || {}).length, 0);
      const panel = `${layer.id}-tests-${layer.related_tests.indexOf(section.tests)}`;
      return `<details class="related-tests" data-test-panel="${panel}" ${expandedTests.has(panel) ? 'open' : ''}><summary><span class="related-tests-heading">${escape(section.tests.title)} <span class="badge neutral">${section.items.length} file${section.items.length === 1 ? '' : 's'} · ${count} changed range${count === 1 ? '' : 's'}</span></span><span class="related-tests-summary">${escape(section.tests.summary)}</span></summary><div class="related-tests-content">${section.items.map(renderFile).join('')}</div></details>`;
    }).join('');
  }
  function qaDetails(flow) {
    return `<details class="qa-steps"><summary>View steps${flow.assets?.length ? ' and screenshots' : ''}</summary><ol>${flow.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol>${(flow.assets || []).map(renderQAAsset).join('')}</details>`;
  }
  function qaFlow(flow, index, showTitle = true) {
    const labels = {passed:'Passed', failed:'Failed', blocked:'Blocked', 'not-run':'Not run'};
    return `<div class="qa-journey" id="qa-flow-${index}" tabindex="-1">${showTitle ? `<h3>${escape(flow.title)}</h3>` : ''}<p class="qa-route">${(flow.journey || []).map(escape).join(' → ')}</p><p class="qa-result ${escape(flow.result)}">${showTitle ? `<strong>${labels[flow.result]}:</strong> ` : '<strong>Actual:</strong> '}${escape(flow.observed)}</p><p class="qa-expected"><strong>Expected:</strong> ${escape(flow.expected)}</p>${qaDetails(flow)}</div>`;
  }
  function commentEvidence(comment) {
    const indices = ReviewTools.evidenceFlows(review.qa, comment);
    return indices.map(index => qaFlow(review.qa.flows[index], index, indices.length > 1)).join('');
  }
  function unlinkedFlows() {
    return (review.qa?.flows || []).map((flow,index) => ({flow,index})).filter(({flow}) => !generatedComments.some(comment => ReviewTools.flowOwner(flow) === comment.id));
  }
  function renderOtherChecks() {
    const other = unlinkedFlows().filter(({flow}) => flow.result !== 'failed');
    return other.length ? `<details class="other-checks"><summary>Other flows checked (${other.length})</summary>${other.map(({flow,index}) => qaFlow(flow,index)).join('')}</details>` : '';
  }
  function showQA(index) {
    if ($('details-dialog').open) $('details-dialog').close();
    select('overview');
    const target = $(`qa-flow-${index}`);
    if (!target) return;
    for (let node = target.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    target.querySelector('details').open = true;
    target.scrollIntoView({block:'center'});
    target.focus({preventScroll:true});
  }

  function renderSections() {
    return (review.sections || []).filter(section => !/^review standard/i.test(section.title)).map(section => `<section class="evidence-section"><h2>${escape(section.title)}</h2>${section.body ? `<p>${escape(section.body)}</p>` : ''}${bulletList(section.items)}${(section.links || []).filter(link => /^https?:\/\//.test(link.url)).map(link => `<p><a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${escape(link.label)} ↗</a></p>`).join('')}</section>`).join('');
  }

  function renderIncrement() {
    const revision = review.history;
    if (!revision) return '';
    const changed = (revision.files || []).filter(file => file.state !== 'unchanged');
    const states = revision.finding_states || [];
    return `<section class="section-card card increment-card"><div class="eyebrow">Revision ${escape(revision.revision)} · ${revision.revision === 1 ? 'Starting point' : 'Since your last review'}</div><h2>${revision.revision === 1 ? 'The first saved review' : 'What changed this time'}</h2><p>${escape(revision.summary)}</p>${revision.revision > 1 ? `<div class="metrics"><span class="badge">${changed.length} changed files</span><span class="badge neutral">${revision.reused_ranges || 0} range explanations reused</span><span class="badge neutral">${revision.inspected_ranges || 0} ranges required inspection</span></div><p class="muted">The walkthrough below shows the complete change since the series base. Reuse describes explanations, not a fresh test run or approval.</p>` : ''}${changed.length ? `<details><summary>Files changed since the previous revision</summary><ul>${changed.map(file => `<li><span class="badge neutral">${escape(file.state)}</span> <code>${escape(file.path)}</code></li>`).join('')}</ul></details>` : ''}${revision.changed_context?.length ? `<p>Dependency context changed: ${revision.changed_context.map(escape).join(', ')}. Previous explanations required rechecking.</p>` : ''}${states.length ? `<details open><summary>Finding history</summary>${states.map(item => `<div class="finding-state"><span class="badge ${item.status === 'resolved' ? 'success' : 'warning'}">${escape(item.id)} · ${escape(item.change || item.status)}</span><strong>${escape(item.title)}</strong><p>${escape(item.reason)}</p></div>`).join('')}</details>` : ''}<div class="history-links"><a href="${revision.preview ? '' : '../'}current.html">Latest review</a><a href="${revision.preview ? '' : '../'}index.html">All revisions</a><a href="${revision.preview ? 'revisions/' : ''}${String(revision.revision).padStart(3, '0')}.html">Original saved snapshot</a></div></section>`;
  }

  function renderOverview() {
    const generated = comments.filter(comment => !comment.personal);
    const pending = (review.history?.finding_states || []).filter(item => item.status === 'needs-rechecking').length;
    const revision = review.history;
    const qa = review.qa;
    const historyLinks = revision ? `<nav class="overview-history" aria-label="Review history"><a href="${revision.preview ? '' : '../'}current.html">Latest review</a><a href="${revision.preview ? '' : '../'}index.html">All revisions</a></nav>` : '';
    const empty = !generated.length && !feedback.findings.length && !pending && !unlinkedFlows().some(({flow}) => flow.result === 'failed') ? '<p class="review-empty">No issues found in this review.</p>' : '';
    return `<div class="overview-reading"><header class="overview-intro"><p class="eyebrow">Review overview</p><h1>${escape(review.title)}</h1><h2 class="what-changed-title">What changed</h2><p class="overview-scope">${escape(ReviewTools.comparisonText(snapshot, review))}</p><p class="lead">${escape(review.summary)}</p>${revision && revision.revision > 1 ? `<p class="overview-update"><strong>Review revision ${revision.revision}</strong> · ${escape(revision.summary)}</p>` : ''}${historyLinks}</header>${pending ? `<p class="overview-notice">${pending} previous finding${pending === 1 ? '' : 's'} still need checking. See Review details.</p>` : ''}${qa && !['complete','skipped'].includes(qa.status) ? `<p class="overview-notice">${escape(qa.summary)}</p>` : ''}<section class="overview-comments" aria-label="Review comments"><h2>Review comments</h2>${empty}${feedback.findings.map(finding => findingCard(finding, review.findings.indexOf(finding))).join('')}${generated.map(commentCard).join('')}${unlinkedFlows().filter(({flow}) => flow.result === 'failed').map(({flow,index}) => qaFlow(flow,index)).join('')}</section>${renderOtherChecks()}${renderMyReview()}</div>`;
  }

  function renderStep(layer) {
    return `<div class="step-overview"><div class="page-intro"><div class="eyebrow">${escape(titleWithoutNumber(layer.group.title))} / Step ${layers.indexOf(layer) + 1}</div><h1>${escape(layer.title)}</h1><p class="lead">${escape(layer.summary || layer.group.summary)}</p></div><span class="step-progress badge neutral">${progressText(progress(layer.items))}</span></div><details class="context-details"><summary>Why these files belong together & what to check</summary><p>${escape(layer.group.summary)}</p>${bulletList(layer.checks)}</details>${flow(layer.flow)}${renderWalkthroughFiles(layer)}<details class="local-notes"><summary>Your notes for this step</summary><textarea id="notes" aria-label="Notes for this step" placeholder="Anything to revisit…"></textarea><small>Stored in this browser when available. Export from Review details to keep a copy.</small></details>`;
  }

  function renderFiles() {
    const query = $('search').value.toLowerCase();
    const matching = snapshot.files.filter(file => file.path.toLowerCase().includes(query));
    const category = file => ReviewTools.category(file.path, review.file_categories || {});
    const present = ReviewTools.categories.filter(name => matching.some(file => category(file) === name));
    if (categoryFilter !== 'All' && !present.includes(categoryFilter)) categoryFilter = 'All';
    const descriptions = {'Design / UI':'Markup and styles. JavaScript and view-serving Ruby are reviewed under Frontend.', Frontend:'Browser behavior and view-supporting code, including JavaScript, helpers and presenters.', Backend:'Application behavior, business rules, database migrations and schemas.', Documentation:'Written guidance and reference material.', Tests:'Regression coverage, fixtures and test support.', Platform:'Deployment, CI, development configuration and build tooling.', Security:'Code explicitly concerned with access, trust or protection. Other categories can still affect security.', AI:'Agent instructions, skills and prompts.', Other:'Files outside the usual code categories.'};
    return `<div class="page-intro"><div class="eyebrow">Explore by responsibility</div><h1>All changes</h1><p class="lead">Review the complete diffs together, with files grouped by the work they do.</p><p class="muted">Select a line number to comment. These categories organize the code; they do not indicate that a change is safe to skip.</p></div><div class="category-filters" role="group" aria-label="Change category">${['All', ...present].map(name => `<button class="btn btn-sm ${categoryFilter === name ? 'btn-primary' : 'btn-ghost'}" data-category="${escape(name)}" aria-pressed="${categoryFilter === name}">${escape(name)} <span>${name === 'All' ? matching.length : matching.filter(file => category(file) === name).length}</span></button>`).join('')}</div>${present.filter(name => categoryFilter === 'All' || name === categoryFilter).map(name => `<section class="category-section"><div class="category-heading"><h2>${escape(name)}</h2><p>${descriptions[name]}</p></div>${matching.filter(file => category(file) === name).map(file => {
      const items = layers.flatMap(layer => layer.items).filter(item => item.file === file.id);
      const summaries = Object.assign({}, ...items.map(item => item.summaries || {}));
      return renderFile({file:file.id, summary:items.map(item => item.summary).filter(Boolean).join(' '), summaries});
    }).join('')}</section>`).join('') || '<p class="empty-state">No matching files.</p>'}`;
  }

  function render() {
    closeComments();
    renderNavigation();
    persist();
    const layer = layers.find(layer => layer.id === state.view);
    $('position').textContent = layer ? `Step ${layers.indexOf(layer) + 1} of ${layers.length}` : state.view === 'files' ? 'All changes' : 'Overview';
    $('prev').disabled = !layer;
    $('next').disabled = !!layer && layers.indexOf(layer) === layers.length - 1;
    ['unified','split'].forEach(mode => { $(mode).setAttribute('aria-pressed', layoutChoice === mode); });
    $('auto-layout').setAttribute('aria-pressed', layoutChoice === 'auto');
    $('auto-layout').textContent = layoutChoice === 'auto' ? `Auto · ${layout}` : 'Auto';
    $('content').innerHTML = layer ? renderStep(layer) : state.view === 'files' ? renderFiles() : renderOverview();
    paintSelection();
    if (layer) {
      $('notes').value = state.notes[layer.id] || '';
      $('notes').addEventListener('input', event => { state.notes[layer.id] = event.target.value; persist(); });
    }
  }

  function select(view, scroll = true) {
    clearSelection();
    document.body.classList.remove('navigation-open'); $('nav-toggle').setAttribute('aria-expanded', 'false');
    state.view = view;
    history.replaceState(null, '', `#${view}`);
    render();
    if (scroll) $('content').scrollTop = 0;
  }
  function step(delta) {
    const index = layers.findIndex(layer => layer.id === state.view);
    if (index === 0 && delta < 0) return select('overview');
    const target = layers[Math.max(0, Math.min(layers.length - 1, index + delta))];
    if (target) select(target.id);
  }
  function jump(hunk, commentID) {
    const layer = layers.find(layer => hunkIDs(layer).includes(hunk));
    if (!layer) return;
    if ($('details-dialog').open) $('details-dialog').close();
    showComments = true; $('comments-toggle').checked = true;
    if (state.view === 'files') { categoryFilter = 'All'; $('search').value = ''; render(); } else select(layer.id, false);
    const trigger = commentID ? [...document.querySelectorAll('.comment-trigger')].find(button => button.dataset.notes.split(' ').includes(commentID)) : null;
    const target = trigger || $(hunk);
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) { if (parent.tagName === 'DETAILS') parent.open = true; }
    target?.scrollIntoView({block:'center', behavior:'instant'});
    if (trigger) { trigger.focus({preventScroll:true}); openComment(trigger); }
  }
  function toast(message) { $('toast').hidden = false; $('toast').textContent = message; setTimeout(() => { $('toast').hidden = true; }, 3500); }
  function context() {
    $('review-details').innerHTML = `<div class="details-section"><span class="badge neutral">${escape(snapshot.mode)} snapshot</span><p class="muted">Captured ${escape(snapshot.created)}</p><h3>Scope and coverage</h3><p>${escape(review.coverage)}</p><small>Before → after</small><pre>${escape(snapshot.base)}\n${escape(snapshot.head)}</pre></div><div class="details-section"><h3>Verification</h3>${bulletList(review.validation)}</div><details class="details-extra"><summary>Review effort and history</summary><p>Effort ${review.effort.score} / 5 · ${escape(review.effort.reason)}</p>${renderIncrement()}</details>${review.qa ? `<details class="details-extra"><summary>Visual checks</summary><p>${escape(review.qa.summary)}</p><p class="muted">${escape(review.qa.environment || "")}</p></details>` : ''}${review.sections?.length ? `<details class="details-extra"><summary>Additional context</summary>${renderSections()}</details>` : ''}<p class="muted">Comments, conversation resolution and viewed marks stay in this browser for this snapshot. Resolving a conversation does not verify a code fix. Use Copy for LLMs or Export local notes to keep a portable copy.</p>`;
    $('details-dialog').showModal();
  }

  $('navigation').addEventListener('toggle', event => {
    if (!event.target.matches('[data-nav-group]') || !event.target.isConnected || $('search').value.trim()) return;
    state.groupOpen[event.target.dataset.navGroup] = event.target.open;
    persist();
  }, true);
  $('content').addEventListener('change', event => {
    const control = event.target.closest('[data-file-viewed]');
    if (!control) return;
    const file = files.get(control.dataset.fileViewed);
    state.viewedFiles = state.viewedFiles.filter(path => path !== file.path);
    if (control.checked) state.viewedFiles.push(file.path);
    state.fileOpen[file.path] = !control.checked;
    closeComments(); clearSelection();
    document.querySelectorAll('.file-card').forEach(card => {
      if (card.dataset.file !== file.id) return;
      card.open = !control.checked;
      card.classList.toggle('is-viewed', control.checked);
      card.querySelector('[data-file-viewed]').checked = control.checked;
    });
    const layer = layers.find(layer => layer.id === state.view);
    const count = document.querySelector('.step-progress');
    if (count && layer) count.textContent = progressText(progress(layer.items));
    if (!persist()) toast('Browser storage is unavailable. Export local notes to keep your file progress.');
    const scroll = $('navigation').parentElement.scrollTop;
    renderNavigation();
    $('navigation').parentElement.scrollTop = scroll;
  });
  $('content').addEventListener('toggle', event => {
    const panel = event.target;
    if (panel.matches('.file-card') && panel.isConnected) {
      state.fileOpen[files.get(panel.dataset.file).path] = panel.open;
      if (!panel.open) {
        if (panel.contains(commentAnchor)) closeComments();
        if (selection && panel.contains($(selection.hunk))) clearSelection();
      }
      persist();
      return;
    }
    if (!panel.matches('.related-tests') || !panel.isConnected) return;
    if (panel.open) { expandedTests.add(panel.dataset.testPanel); return; }
    expandedTests.delete(panel.dataset.testPanel);
    if (panel.contains(commentAnchor)) closeComments();
    if (selection && panel.contains($(selection.hunk))) clearSelection();
  }, true);
  document.addEventListener('click', async event => {
    // Keep the checkbox independent from the native disclosure summary.
    if (event.target.closest('.file-viewed')) { event.stopPropagation(); return; }
    const fileLink = event.target.closest('[data-file-link]');
    if (fileLink) {
      const file = files.get(fileLink.dataset.fileLink);
      state.fileOpen[file.path] = true;
      select(fileLink.dataset.fileLayer, false);
      const card = document.querySelector(`.file-card[data-file="${file.id}"]`);
      for (let parent = card?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      card?.scrollIntoView({block:'start', behavior:'instant'});
      card?.querySelector('summary').focus({preventScroll:true});
      return;
    }
    const image = event.target.closest('[data-expand-image]');
    if (image) { expandImage(image); return; }
    const code = event.target.closest('[data-open-code]');
    if (code) { expandCode(code); return; }
    const viewerMode = event.target.closest('[data-viewer-layout]');
    if (viewerMode) { viewerLayout = viewerMode.dataset.viewerLayout; renderExpandedCode(); return; }
    const navigation = event.target.closest('[data-view]');
    if (navigation) select(navigation.dataset.view);
    const evidence = event.target.closest('[data-evidence]');
    if (evidence) {
      const comment = comments.find(comment => comment.id === evidence.dataset.evidence);
      const index = comment && ReviewTools.evidenceFlows(review.qa, comment)[0];
      if (index !== undefined) showQA(index);
    }
    const finding = event.target.closest('button[data-hunk]');
    if (finding) jump(finding.dataset.hunk);
    const marker = event.target.closest('.comment-trigger');
    if (marker) openComment(marker);
    if (event.target.closest('[data-close-comment]')) { const anchor = commentAnchor; closeComments(); anchor?.focus({preventScroll:true}); }
    const commentLink = event.target.closest('[data-comment]');
    if (commentLink) {
      const comment = comments.find(comment => comment.id === commentLink.dataset.comment);
      if (comment) jump(comment.hunk, comment.id);
    }
    const category = event.target.closest('[data-category]');
    if (category) { categoryFilter = category.dataset.category; clearSelection(); render(); }
    const line = event.target.closest('[data-select-line]');
    if (line) selectLine(line);
    if (event.target.closest('[data-add-general]')) openEditor(null, true);
    const post = event.target.closest('[data-copy-comment]');
    if (post) { const comment = comments.find(comment => comment.id === post.dataset.copyComment); if (comment) await copyText(ReviewTools.postingText(snapshot, comment, review.qa)); }
    const noteCopy = event.target.closest('[data-copy-note]');
    if (noteCopy) { const note = personalNotes().find(note => note.id === noteCopy.dataset.copyNote); if (note) await copyText(ReviewTools.reviewText(snapshot, [], [note])); }
    const copy = event.target.closest('[data-copy]');
    if (copy) { const comment = comments.find(comment => comment.id === copy.dataset.copy); if (comment) await copyText(ReviewTools.commentText(snapshot, comment, review.qa)); }
    const postFinding = event.target.closest('[data-post-finding]');
    if (postFinding) { const finding = review.findings?.[Number(postFinding.dataset.postFinding)]; if (finding) await copyText(ReviewTools.postingText(snapshot, {...findingComment(finding), discussion:finding.body})); }
    const copyFinding = event.target.closest('[data-copy-finding]');
    if (copyFinding) { const finding = review.findings?.[Number(copyFinding.dataset.copyFinding)]; if (finding) await copyText(ReviewTools.commentText(snapshot, findingComment(finding))); }
    if (event.target.closest('[data-copy-all]')) await copyText(ReviewTools.reviewText(snapshot, comments.filter(comment => comment.personal), personalNotes(), review.qa));
    const edit = event.target.closest('[data-edit]');
    if (edit) { const comment = comments.find(comment => comment.personal && comment.id === edit.dataset.edit); if (comment) openEditor(comment); }
    const remove = event.target.closest('[data-delete]');
    if (remove) { state.personalComments = state.personalComments.filter(comment => comment.id !== remove.dataset.delete); state.resolvedComments = state.resolvedComments.filter(id => id !== remove.dataset.delete); refreshComments(); render(); toast('Comment removed.'); }
    const resolution = event.target.closest('[data-resolve]');
    if (resolution) toggleResolved(resolution.dataset.resolve);
  });
  $('comment-popover').addEventListener('toggle', event => {
    if (event.newState !== 'closed' || $('comment-popover').matches(':popover-open')) return;
    const anchor = commentAnchor;
    const restoreFocus = document.activeElement === document.body || $('comment-popover').contains(document.activeElement);
    closeComments();
    if (restoreFocus) anchor?.focus({preventScroll:true});
  });
  let positionFrame;
  const schedulePosition = () => { cancelAnimationFrame(positionFrame); positionFrame = requestAnimationFrame(positionComment); };
  document.addEventListener('scroll', schedulePosition, true);
  window.addEventListener('resize', schedulePosition);
  $('prev').onclick = () => step(-1);
  $('next').onclick = () => step(1);
  ['auto','unified','split'].forEach(mode => { $(mode === 'auto' ? 'auto-layout' : mode).onclick = () => { const scroll = $('content').scrollTop; layoutChoice = mode; layout = mode === 'auto' ? (tabletLayout.matches ? 'unified' : 'split') : mode; render(); $('content').scrollTop = scroll; }; });
  tabletLayout.addEventListener('change', () => { renderExpandedCode(); if (layoutChoice === 'auto') { const scroll = $('content').scrollTop; layout = tabletLayout.matches ? 'unified' : 'split'; render(); $('content').scrollTop = scroll; } });
  $('nav-toggle').onclick = () => { const open = document.body.classList.toggle('navigation-open'); $('nav-toggle').setAttribute('aria-expanded', open); };
  $('comments-toggle').onchange = event => { const scroll = $('content').scrollTop; showComments = event.target.checked; render(); $('content').scrollTop = scroll; };
  $('focus').onclick = () => { document.body.classList.toggle('focus'); $('focus').setAttribute('aria-pressed', document.body.classList.contains('focus')); schedulePosition(); };
  $('search').oninput = () => { renderNavigation(); if (state.view === 'files') render(); };
  $('context-toggle').onclick = context;
  $('write-comment').onclick = () => openEditor();
  $('clear-range').onclick = clearSelection;
  $('cancel-comment').onclick = () => $('comment-editor').close();
  $('close-copy').onclick = () => $('copy-dialog').close();
  $('comment-form').onsubmit = event => {
    event.preventDefault();
    const subject = $('editor-subject').value.trim();
    if (!subject || !editorRange) return;
    const comment = {...editorRange, id:editingID || `mine-${crypto.randomUUID()}`, label:$('editor-label').value,
      decoration:$('editor-blocking').checked ? 'blocking' : 'non-blocking', subject, discussion:$('editor-discussion').value.trim()};
    state.personalComments = state.personalComments.filter(existing => existing.id !== comment.id);
    state.personalComments.push(comment);
    state.resolvedComments = state.resolvedComments.filter(id => id !== comment.id);
    refreshComments();
    const stored = persist();
    $('comment-editor').close(); clearSelection();
    const scroll = $('content').scrollTop; render(); $('content').scrollTop = scroll;
    toast(stored ? 'Your comment is saved in this browser.' : 'Browser storage is unavailable. Copy or export your review before closing.');
  };
  $('comment-editor').addEventListener('close', () => {
    const button = [...document.querySelectorAll('[data-select-line]')].find(button => button.dataset.rangeHunk === editorRange?.hunk && button.dataset.rangeSide === editorRange?.side && Number(button.dataset.selectLine) === editorRange?.start);
    (button || document.querySelector('[data-add-general]'))?.focus({preventScroll:true});
  });
  $('close-details').onclick = $('done-details').onclick = () => $('details-dialog').close();
  $('export').onclick = () => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify({snapshot:snapshot.fingerprint, ...state}, null, 2)], {type:'application/json'}));
    link.href = url; link.download = 'review-notes.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.addEventListener('keydown', event => {
    if (expandedViewer.lightboxOpen) {
      if (event.key === 'Escape') { event.preventDefault(); expandedViewer.close(); }
      if (event.key === 'Tab') {
        const controls = [...$('glightbox-body').querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter(control => control.getClientRects().length);
        const index = controls.indexOf(document.activeElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus({preventScroll:true});
      }
      return;
    }
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey || $('details-dialog').open || $('comment-editor').open || $('copy-dialog').open || $('comment-popover').matches(':popover-open')) return;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') { event.preventDefault(); step(key === 'j' ? 1 : -1); }
    if (key === 'z') $('focus').click();
  });
  $('title').textContent = review.title;
  if (review.history) {
    const entries = (review.history.entries || []).filter(entry => Number.isInteger(entry.number) && entry.number > 0);
    $('revision-navigation').innerHTML = `<label class="revision-control"><span>Revision</span><select class="select select-sm select-bordered" aria-label="Review revision">${entries.map(entry => `<option value="${entry.number}" ${entry.number === review.history.revision ? 'selected' : ''}>Revision ${entry.number}</option>`).join('')}</select></label>`;
    $('revision-navigation').querySelector('select').onchange = event => {
      const number = Number(event.target.value);
      if (entries.some(entry => entry.number === number)) location.href = `${review.history.preview ? '' : '../'}revision-${String(number).padStart(3, '0')}.html`;
    };
  }
  document.title = `${review.title} · Dynamic Code Reviews`;
  $('repo-label').textContent = snapshot.repo.split('/').pop();
  $('scope').innerHTML = `<span class="badge neutral">${snapshot.mode === 'series' ? (snapshot.working_tree ? 'Series + working tree' : 'Committed series') : escape(snapshot.mode)} · ${escape(snapshot.head.slice(0,8))}</span>`;
  $('file-total').textContent = `${files.size} files`;
  const hash = location.hash.slice(1);
  if (['overview','files', ...layers.map(layer => layer.id)].includes(hash)) state.view = hash;
  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1);
    if (['overview','files', ...layers.map(layer => layer.id)].includes(view)) select(view);
  });
  render();
})();
