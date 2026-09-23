/* Offline review UI. No framework, build step, network requests or code execution. */
'use strict';
(() => {
  const {snapshot, review} = JSON.parse(document.getElementById('data').textContent);
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => (window.ReviewIcons[name] || '').replace('class="lucide', 'class="review-icon lucide').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  const files = new Map(snapshot.files.map(file => [file.id, file]));
  const filesByPath = new Map(snapshot.files.map(file => [file.path, file]));
  const hunkFiles = new Map(snapshot.files.flatMap(file => file.hunks.map(hunk => [hunk.id, file])));
  const fullAnchor = file => file ? `full:${file.id}` : '';
  snapshot.files.forEach(file => hunkFiles.set(fullAnchor(file), file));
  const layers = review.groups.flatMap((group, groupIndex) => group.layers.map((layer, layerIndex) => ({...layer, group, id:`g${groupIndex}l${layerIndex}`})));
  const feedback = ReviewTools.overviewFeedback(review);
  const generatedComments = feedback.comments;
  let comments = [];
  const storageKey = `dynamic-review:${snapshot.fingerprint}${review.history ? `:${review.history.series}:${review.history.revision}` : ""}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { /* file:// storage may be disabled */ }
  // Each opening starts at the review summary. Persist reading progress, not the last page;
  // an explicit hash remains available for links directly to a walkthrough or All changes.
  const state = {notes:{}, personalComments:[], resolvedComments:[], fileOpen:{}, groupOpen:{}, componentFiles:{}, ...saved, view:'overview'};
  const focusOrder = ReviewTools.focusFiles(layers, files);
  let focusMode = true;
  try { focusMode = localStorage.getItem('dynamic-review:reading-mode') !== 'walkthrough'; } catch { /* Keep the default when storage is unavailable. */ }
  const fileReadingActive = () => focusMode && layers.some(layer => layer.id === state.view);
  let focusIndex = 0;
  let selectedChange = null;
  const fullContextCache = new Map();
  const components = layer => ReviewTools.componentGroups(layer.items, files);
  const componentKey = (layer, component) => `${layer.id}:${component.key}`;
  const activeComponentFile = (layer, component) => component.items.find(item => item.file === state.componentFiles[componentKey(layer, component)])?.file || component.items[0].file;
  function activateComponentFile(layer, file) {
    const component = components(layer).find(component => component.items.some(item => item.file === file));
    if (component) state.componentFiles[componentKey(layer, component)] = file;
  }
  const componentScroll = new Map();
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
  let layoutChoice = 'unified';
  let layout = 'unified';
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
  const layerComments = layer => comments.filter(comment => hunkIDs(layer).includes(comment.hunk) || layer.items.some(item => comment.hunk === fullAnchor(files.get(item.file))));
  const titleWithoutNumber = title => title.replace(/^\d+\s*[·.]\s*/, '');

  function renderNavigation() {
    const query = $('search').value.trim().toLowerCase();
    let html = `<ul class="menu"><li><button data-view="overview" aria-current="${state.view === 'overview' ? 'page' : 'false'}"><span class="step-number">☷</span><span class="step-body"><strong>Overview</strong><small>Comments & evidence</small></span></button></li><li><button data-view="files" aria-current="${state.view === 'files' ? 'page' : 'false'}"><span class="step-number">⌘</span><span class="step-body"><strong>All changes</strong><small>Diffs by responsibility · ${files.size} files</small></span></button></li></ul>`;
    review.groups.forEach(group => {
      const matching = layers.filter(layer => layer.group === group && `${group.title} ${layer.title} ${layer.items.map(item => files.get(item.file).path).join(' ')} ${components(layer).map(pair => pair.name).join(' ')}`.toLowerCase().includes(query));
      if (!matching.length) return;
      // A single-step group needs one heading, not the same title twice.
      html += `<section class="nav-section">${group.layers.length > 1 ? `<h3 class="nav-group-title">${escape(titleWithoutNumber(group.title))}</h3>` : ''}<ul class="menu">`;
      const fileLink = (id, layer) => {
        const file = files.get(id);
        const slash = file.path.lastIndexOf('/');
        const filename = file.path.slice(slash + 1);
        const directory = slash < 0 ? '' : file.path.slice(0, slash);
        return `<li><button class="nav-file ${fileViewed(file) ? 'is-viewed' : ''}" data-file-link="${id}" data-file-layer="${layer.id}" aria-current="${state.navFile === id && state.view === layer.id ? 'location' : 'false'}" title="${escape(file.path)}" aria-label="${escape(`Open ${file.path}${fileViewed(file) ? ', viewed' : ', not viewed'}`)}"><span class="file-status" aria-hidden="true">${fileViewed(file) ? icon('check') : ''}</span><span class="nav-file-label"><span class="nav-file-name">${escape(filename)}</span>${directory ? `<small class="nav-file-directory">${escape(directory)}</small>` : ''}</span></button></li>`;
      };
      matching.forEach(layer => {
        const count = layerComments(layer).length;
        const completed = progress(layer.items);
        const pairs = components(layer);
        const ordered = ReviewTools.layerFiles(layer, files);
        const links = ordered.code.map(id => {
          const component = pairs.find(pair => pair.items.some(item => item.file === id));
          if (!component) return fileLink(id, layer);
          if (id !== component.items[0].file) return '';
          const current = state.view === layer.id && component.items.some(item => item.file === state.navFile);
          const viewed = progress(component.items);
          return `<li class="nav-component ${current ? 'is-current' : ''}"><button class="nav-component-title" data-component-link="${escape(component.key)}" data-file-layer="${layer.id}" aria-current="${current ? 'location' : 'false'}" title="${escape(component.directory)}" aria-label="${escape(`Open ${component.namespace}::${component.name}, ${component.directory}`)}"><span class="nav-file-label"><strong>${escape(component.name)}</strong>${component.namespace ? `<small class="nav-file-directory">${escape(component.namespace)}</small>` : ''}</span><small class="nav-component-count" aria-label="${progressText(viewed)}">${viewed.viewed}/${viewed.total}</small></button><div class="nav-component-files" role="group" aria-label="${escape(component.name)} files">${component.items.map(item => {
            const file = files.get(item.file);
            return `<button data-file-link="${item.file}" data-file-layer="${layer.id}" title="${escape(file.path)}" aria-label="${escape(`Open ${file.path}${fileViewed(file) ? ', viewed' : ', not viewed'}`)}" aria-current="${current && activeComponentFile(layer, component) === item.file ? 'location' : 'false'}"><span class="file-status ${fileViewed(file) ? 'is-viewed' : ''}" aria-hidden="true">${fileViewed(file) ? icon('check') : ''}</span>${file.path.endsWith('.rb') ? 'Ruby' : 'Template'}</button>`;
          }).join('')}</div></li>`;
        }).join('');
        const tests = ordered.tests.length ? `<li class="nav-tests-label" role="presentation">Tests</li>${ordered.tests.map(id => fileLink(id, layer)).join('')}` : '';
        const expanded = state.view === layer.id || !!query;
        html += `<li><button data-view="${layer.id}" aria-current="${state.view === layer.id ? 'page' : 'false'}" aria-expanded="${expanded}" aria-controls="nav-files-${layer.id}"><span class="step-number">${completed.total && completed.viewed === completed.total ? icon('check') : layers.indexOf(layer) + 1}</span><span class="step-body"><strong>${escape(titleWithoutNumber(group.layers.length === 1 ? group.title : layer.title))}</strong><small>${progressText(completed)}${count ? ` · ${count} comments` : ''}</small></span></button>${expanded ? `<ul id="nav-files-${layer.id}" class="nav-files">${links}${tests}</ul>` : `<ul id="nav-files-${layer.id}" hidden></ul>`}</li>`;
      });
      html += '</ul></section>';
    });
    $('navigation').innerHTML = html;
  }

  function language(path) {
    if (/\.erb$/i.test(path)) return 'erb';
    if (/\.(scss|sass)$/i.test(path)) return 'css';
    const extension = path.split('.').pop().toLowerCase();
    return ({rb:'ruby',rake:'ruby',gemspec:'ruby',js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',json:'json',yml:'yaml',yaml:'yaml',sql:'sql',html:'markup',xml:'markup',svg:'markup',css:'css',sh:'bash',bash:'bash'})[extension] || (/\b(Gemfile|Rakefile)$/.test(path) ? 'ruby' : 'none');
  }

  // Tokenize a whole side of a hunk, then distribute escaped tokens across its
  // physical lines. This preserves multiline strings/comments and exact text.
  // ERB: swap each <% %> tag for a placeholder so markup still sees whole HTML tags
  // (including attributes holding ERB), then put the tags back as Ruby tokens.
  function erbTokens(source) {
    const tags = [];
    const masked = source.replace(/<%[\s\S]*?%>/g, tag => `___ERB${tags.push(tag) - 1}___`);
    const tag = text => {
      const [, open, code, close] = text.match(/^(<%[=#-]?)([\s\S]*?)(-?%>)$/);
      if (open === '<%#') return new Prism.Token('comment', text);
      return new Prism.Token('erb', [new Prism.Token('erb-delimiter', open), ...Prism.tokenize(code, Prism.languages.ruby), new Prism.Token('erb-delimiter', close)]);
    };
    const restore = tokens => tokens.flatMap(token => {
      if (typeof token === 'string') {
        return token.split(/(___ERB\d+___)/).filter(Boolean).map(part => /^___ERB\d+___$/.test(part) ? tag(tags[part.slice(6, -3)]) : part);
      }
      token.content = restore(Array.isArray(token.content) ? token.content : [token.content]);
      return [token];
    });
    return restore(Prism.tokenize(masked, Prism.languages.markup));
  }

  function highlightedLines(lines, lang) {
    if (!lines.length) return [];
    const source = lines.map(line => line.text).join('\n');
    const tokens = lang === 'erb' ? erbTokens(source) : Prism.languages[lang] ? Prism.tokenize(source, Prism.languages[lang]) : [source];
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

  function lineButton(hunk, side, number, comment = null, path) {
    if (number === undefined) return '';
    const file = filesByPath.get(path);
    const rangeHunk = fileReadingActive() && fullContextCache.get(file?.id) ? fullAnchor(file) : hunk.id;
    if (comment || (hunk.contextOnly && rangeHunk === hunk.id)) return `<span class="line-number">${number}</span>`;
    return `<button class="line-number" type="button" data-select-line="${number}" data-range-hunk="${rangeHunk}" data-range-side="${side}" aria-label="Select ${side === 'new' ? 'after' : 'before'} line ${number} in ${escape(path)}" title="Select line to comment">${number}</button>`;
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
      if (![cell.dataset.hunk, cell.dataset.fullHunk].includes(selection.hunk) || cell.dataset.side !== selection.side || Number(cell.dataset.line) < selection.start || Number(cell.dataset.line) > selection.end) return;
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

  function commentTrigger(hunk, side, number, comment = null, path) {
    if (comment || !showComments || number === undefined) return '';
    const file = filesByPath.get(path);
    const anchored = comments.filter(comment => [hunk.id, fullAnchor(file)].includes(comment.hunk) && comment.side === side && comment.start === number);
    if (!anchored.length) return '';
    const label = anchored.length === 1 ? `Read ${anchored[0].label}: ${anchored[0].subject}` : `Read ${anchored.length} comments on ${side === 'new' ? 'after' : 'before'} line ${number}`;
    return `<button class="comment-trigger" type="button" data-notes="${anchored.map(comment => escape(comment.id)).join(' ')}" aria-label="${escape(label)}" title="${escape(label)}" aria-haspopup="dialog" aria-controls="comment-popover" aria-expanded="false">${icon('message-square')}</button>`;
  }

  function highlightComments(ids) {
    $('content').querySelectorAll('.range-selected').forEach(cell => cell.classList.remove('range-selected'));
    const selected = comments.filter(comment => ids.includes(comment.id));
    $('content').querySelectorAll('.gutter[data-line]').forEach(cell => {
      if (!selected.some(comment => [cell.dataset.hunk, cell.dataset.fullHunk].includes(comment.hunk) && comment.side === cell.dataset.side && Number(cell.dataset.line) >= comment.start && Number(cell.dataset.line) <= comment.end)) return;
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

  function positionAnnotation(popover, trigger, close) {
    if (!trigger?.isConnected || !popover.matches(':popover-open')) return;
    const anchor = trigger.getBoundingClientRect();
    const content = $('content').getBoundingClientRect();
    if (anchor.bottom < content.top || anchor.top > Math.min(content.bottom, innerHeight) || anchor.right < content.left || anchor.left > innerWidth) { close(); return; }
    const box = popover.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.right + 8, innerWidth - box.width - 12));
    const below = anchor.bottom + 8;
    const top = below + box.height <= innerHeight - 12 ? below : Math.max(12, anchor.top - box.height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }
  function positionComment() {
    positionAnnotation($('comment-popover'), commentAnchor, closeComments);
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

  function rangeClasses(hunk, side, number, comment = null, path) {
    const file = filesByPath.get(path);
    if (comment) return [hunk.id, fullAnchor(file)].includes(comment.hunk) && comment.side === side && number >= comment.start && number <= comment.end ? ' range-selected' : '';
    if (!showComments || number === undefined) return '';
    const matches = comments.filter(comment => [hunk.id, fullAnchor(file)].includes(comment.hunk) && comment.side === side && number >= comment.start && number <= comment.end);
    if (!matches.length) return '';
    return ` annotated${matches.some(comment => comment.start === number) ? ' range-start' : ''}${matches.some(comment => comment.end === number) ? ' range-end' : ''}`;
  }

  function splitCells(hunk, line, side, colored, comment = null, path) {
    const divider = side === 'new' ? ' side-divider' : '';
    if (!line) return `<td class="gutter empty${divider}"></td><td class="code empty" aria-label="No corresponding line"></td>`;
    const number = line[side];
    const marked = rangeClasses(hunk, side, number, comment, path);
    const kind = line.kind === 'context' ? '' : line.kind;
    const sign = line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' ';
    return `<td class="gutter ${kind}${divider}${marked}" data-hunk="${hunk.id}" data-full-hunk="${fullAnchor(filesByPath.get(path))}" data-side="${side}" data-line="${number}">${commentTrigger(hunk, side, number, comment, path)}${lineButton(hunk, side, number, comment, path)}</td><td class="code ${kind}${marked}"><code><span class="sign" aria-hidden="true">${sign}</span>${colored[side].get(number) || ''}</code>${line.no_newline ? '<span class="newline-marker">No newline at end of file</span>' : ''}</td>`;
  }

  function renderHunk(hunk, summary, path, mode = layout, comment = null) {
    const columns = mode === 'split' ? 4 : 3;
    const colored = highlights(hunk, path);
    const range = (side) => hunk[`${side}_count`] === 0 ? '—' : `${hunk[`${side}_start`]}–${hunk[`${side}_start`] + hunk[`${side}_count`] - 1}`;
    const inlineNote = fileReadingActive() && !comment && !hunk.contextOnly;
    const heading = hunk.contextOnly || inlineNote ? '' : `<tr class="range-heading" id="${comment ? 'expanded-' : ''}${hunk.id}"><td colspan="${columns}"><div class="range-label"><span>CHANGED RANGE</span><span>Before ${range('old')} &nbsp; / &nbsp; After ${range('new')}</span></div><p>${escape(summary)}</p></td></tr>`;
    const rows = hunk.rows[mode].map(row => {
      if (mode === 'split') return `<tr class="code-row">${splitCells(hunk, row.old, 'old', colored, comment, path)}${splitCells(hunk, row.new, 'new', colored, comment, path)}</tr>`;
      const side = row.kind === 'del' ? 'old' : 'new';
      const marked = rangeClasses(hunk, 'old', row.old, comment, path) + rangeClasses(hunk, 'new', row.new, comment, path);
      const kind = row.kind === 'context' ? '' : row.kind;
      const sign = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
      return `<tr class="code-row"><td class="gutter ${kind}${rangeClasses(hunk,'old',row.old,comment,path)}" data-hunk="${hunk.id}" data-full-hunk="${fullAnchor(filesByPath.get(path))}" data-side="old" ${row.old !== undefined ? `data-line="${row.old}"` : ''}>${commentTrigger(hunk, 'old', row.old, comment, path)}${lineButton(hunk, 'old', row.old, comment, path)}</td><td class="gutter ${kind}${rangeClasses(hunk,'new',row.new,comment,path)}" data-hunk="${hunk.id}" data-full-hunk="${fullAnchor(filesByPath.get(path))}" data-side="new" ${row.new !== undefined ? `data-line="${row.new}"` : ''}>${commentTrigger(hunk, 'new', row.new, comment, path)}${lineButton(hunk, 'new', row.new, comment, path)}</td><td class="code ${kind}${marked}"><code><span class="sign" aria-hidden="true">${sign}</span>${colored[side].get(row[side]) || ''}</code>${row.no_newline ? '<span class="newline-marker">No newline at end of file</span>' : ''}</td></tr>`;
    });
    if (inlineNote) {
      const changed = row => mode === 'unified' ? row.kind !== 'context' : row.old?.kind === 'del' || row.new?.kind === 'add';
      const starts = hunk.rows[mode].flatMap((row, index, all) => changed(row) && (index === 0 || !changed(all[index - 1])) ? [index] : []);
      const firstChange = starts[0];
      starts.forEach((rowIndex, index) => {
        const id = index === 0 ? hunk.id : `${hunk.id}-change-${index + 1}`;
        rows[rowIndex] = rows[rowIndex].replace('<tr class="code-row">', `<tr class="code-row change-anchor" id="${id}">`);
      });
      const note = `<button class="review-note-trigger" aria-expanded="false" aria-haspopup="dialog" popovertarget="note-${hunk.id}" aria-label="Read review note for this change" title="Review note">${icon('sticky-note')}</button><aside id="note-${hunk.id}" class="review-note-popover comment-popover" popover="auto" role="dialog" aria-label="Review note"><header class="popover-heading"><strong>Review note</strong><button class="btn btn-xs btn-circle btn-ghost" popovertarget="note-${hunk.id}" popovertargetaction="hide" aria-label="Close review note">✕</button></header><section class="popover-comment"><p>${escape(summary || 'Changed section')}</p><small>Before ${range('old')} · After ${range('new')}</small></section></aside>`;
      if (firstChange !== undefined) {
        const row = rows[firstChange];
        const gutters = [...row.matchAll(/<td class="gutter[^>]*>[\s\S]*?<\/td>/g)];
        const available = gutters.find(cell => !cell[0].includes('comment-trigger'));
        rows[firstChange] = available
          ? row.replace(available[0], available[0].replace(/(<td class="gutter[^>]*>)/, `$1${note}`))
          : row.replace(/(<td class="code[^>]*>)/, `$1${note}`);
      }
    }
    return heading + rows.join('');
  }

  function renderDiffTable(file, hunks, summaries, mode = layout, comment = null) {
    return `<div class="diff-scroll"><table class="diff-table ${mode}" aria-label="${escape(file.path)} ${mode} diff"><colgroup><col class="gutter">${mode === 'split' ? '<col><col class="gutter"><col>' : '<col class="gutter"><col>'}</colgroup><thead class="${mode === 'unified' ? 'line-number-headings' : ''}"><tr>${mode === 'split' ? `<th colspan="2">BEFORE · ${escape(snapshot.base.slice(0,8))}</th><th colspan="2" class="after">AFTER · ${escape(snapshot.mode === 'uncommitted' || snapshot.working_tree ? 'working tree' : snapshot.head.slice(0,8))}</th>` : '<th scope="col"><span>Before line number</span></th><th scope="col"><span>After line number</span></th><th scope="col"><span>Code</span></th>'}</tr></thead><tbody>${hunks.map(hunk => renderHunk(hunk, summaries[hunk.id], file.path, mode, comment)).join('')}</tbody></table></div>`;
  }

  // Template previews: static HTML the app rendered for this snapshot, shown in sandboxed,
  // script-less frames so the app's CSS never touches the review and vice versa.
  const previewById = new Map((review.previews || []).map(preview => [preview.id, preview]));
  const previewsByPath = new Map();
  const notVisualByPath = new Map();
  (review.previews || []).forEach(preview => preview.files.forEach(path => {
    const target = preview.status === 'not_visual' ? notVisualByPath : previewsByPath;
    if (!target.has(path)) target.set(path, []);
    target.get(path).push(preview);
  }));
  const previewSources = {lookbook: 'Lookbook example', example: 'Example data for this review'};
  const wideScreen = () => matchMedia('(min-width: 1200px)').matches;
  // The side pane opens by itself only on big screens; laptops keep the code wide and
  // show the Preview button instead. An explicit open/close choice is remembered.
  const previewPaneOpen = () => wideScreen() && (state.previewPane ? state.previewPane === 'open' : matchMedia('(min-width: 1600px)').matches);

  function previewToggle(file) {
    const list = previewsByPath.get(file.path);
    if (!list?.length) return '';
    return `<button type="button" class="preview-toggle" data-preview-toggle aria-controls="preview-pane" aria-expanded="${previewPaneOpen()}" title="Show how this template renders">${icon('scan-text')}<span>Visual preview</span><span class="preview-count">${list.length}</span></button>`;
  }

  function notVisualNote(file) {
    const reasons = (notVisualByPath.get(file.path) || []).map(preview => preview.note).filter(Boolean);
    return reasons.length && !previewsByPath.has(file.path) ? `<span class="preview-none">No preview · ${escape(reasons.join(' '))}</span>` : '';
  }

  function previewPanel(file, placement) {
    const list = previewsByPath.get(file.path);
    if (!list?.length) return '';
    const rendered = list.filter(preview => preview.status === 'rendered').length;
    const open = placement === 'side' && previewPaneOpen();
    const examples = list.map(preview => `<figure class="preview-example"><figcaption><strong>${escape(preview.title || 'Preview')}</strong><span class="badge ${preview.source === 'lookbook' ? 'success' : 'neutral'}">${previewSources[preview.source] || previewSources.example}</span>${preview.note && preview.status === 'rendered' ? `<small>${escape(preview.note)}</small>` : ''}</figcaption>${preview.status === 'rendered' ? `<div class="preview-frame"><iframe sandbox="allow-same-origin" loading="lazy" title="${escape(`Preview: ${preview.title || file.path}`)}" data-preview-id="${escape(preview.id)}"${preview.width ? ` style="min-width:${Number(preview.width) + 32}px"` : ''}></iframe></div>` : `<p class="preview-unavailable">Preview unavailable. ${escape(preview.note || '')}</p>`}</figure>`).join('');
    return `<details class="preview-panel ${placement}" ${placement === 'side' ? 'id="preview-pane"' : ''} data-preview-panel data-open-state="${open}" ${open ? 'open' : ''}><summary>${icon('scan-text')}<span class="preview-heading">Preview</span><span class="badge neutral">${rendered === list.length ? `${list.length} example${list.length === 1 ? '' : 's'}` : `${rendered} of ${list.length} rendered`}</span></summary><div class="preview-body"><p class="preview-caveat">Rendered by the app from the reviewed code with example data. Static: scripts, remote images and icon fonts are left out.</p>${examples}</div></details>`;
  }

  function fitPreview(frame) {
    const root = frame.contentDocument?.documentElement;
    if (root) frame.style.height = `${Math.ceil(root.scrollHeight)}px`;
  }

  let previewResize;
  window.addEventListener('resize', () => {
    clearTimeout(previewResize);
    previewResize = setTimeout(() => document.querySelectorAll('iframe[data-preview-id]').forEach(fitPreview), 150);
  });

  function hydratePreviews(root) {
    root.querySelectorAll('iframe[data-preview-id]').forEach(frame => {
      const preview = previewById.get(frame.dataset.previewId);
      if (!preview || frame.hasAttribute('srcdoc')) return;
      frame.addEventListener('load', () => fitPreview(frame));
      frame.srcdoc = preview.html;
    });
  }

  function renderFile(item) {
    const file = files.get(item.file);
    const hunks = file.hunks.filter(hunk => Object.hasOwn(item.summaries || {}, hunk.id));
    const changes = hunks.flatMap(hunk => hunk.rows.unified);
    const added = changes.filter(line => line.kind === 'add').length;
    const removed = changes.filter(line => line.kind === 'del').length;
    const table = renderDiffTable(file, hunks, item.summaries);
    return `<details class="file-card ${fileViewed(file) ? 'is-viewed' : ''}" data-file="${file.id}" ${fileOpen(file) ? 'open' : ''}><summary><span class="file-icon" aria-hidden="true">&lt;/&gt;</span><span class="filename">${escape(file.path)}</span><span class="badge success">+${added}</span><span class="badge blocking">−${removed}</span><label class="file-viewed"><input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-file-viewed="${file.id}" aria-label="${escape(`Mark ${file.path} as viewed`)}" ${fileViewed(file) ? 'checked' : ''}> Viewed</label></summary>${item.summary || file.note ? `<div class="file-summary">${escape(item.summary || '')}${file.note ? ` · ${escape(file.note)}` : ''}</div>` : ''}${previewPanel(file, 'inline')}${notVisualNote(file) ? `<div class="file-summary">${notVisualNote(file)}</div>` : ''}${hunks.length ? table : `<div class="file-summary"><pre>${escape(file.patch || 'No text diff available.')}</pre></div>`}</details>`;
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
    return `<article class="review-thread ${comment.resolved ? 'is-resolved' : ''}" data-thread-id="${id}"><div class="thread-file"><span class="thread-file-path">${escape(found?.file.path || 'General comment')}</span><span class="thread-range">${found ? range : ''}</span></div><details class="thread-details" ${comment.resolved ? '' : 'open'}><summary class="thread-summary" aria-label="Comment: ${escape(comment.subject)}"><span class="thread-badges">${threadBadges(comment)}</span><strong>${escape(comment.subject)}</strong><span class="thread-chevron">${icon('chevron-down')}</span></summary><div class="thread-body">${comment.discussion ? `<p class="comment-discussion">${escape(comment.discussion)}</p>` : ''}${commentEvidence(comment)}</div>${found ? found.fullFile ? `<button class="thread-source btn btn-sm btn-ghost" type="button" data-comment="${id}">View in file · ${found.lines.length} line${found.lines.length === 1 ? '' : 's'} ${icon('arrow-right')}</button>` : `<button class="thread-source btn btn-sm btn-ghost" type="button" data-open-code="${id}" aria-haspopup="dialog" aria-label="${escape(`View code for ${found.file.path}, ${range}: ${comment.subject}`)}">View code · ${found.lines.length} line${found.lines.length === 1 ? '' : 's'} ${icon('arrow-right')}</button>` : ''}</details><div class="thread-footer"><div class="comment-actions"><button class="btn btn-sm btn-soft" data-copy-comment="${id}">${icon('copy')} Copy for comment</button><button class="btn btn-sm btn-ghost" data-copy="${id}">${icon('copy')} Copy for LLMs</button>${found && !found.fullFile ? `<button class="btn btn-sm btn-ghost" data-comment="${id}">Open in diff ${icon('arrow-right')}</button>` : ''}${comment.personal ? `<button class="btn btn-sm btn-ghost" data-edit="${id}">${icon('pencil')} Edit</button><button class="btn btn-sm btn-ghost" data-delete="${id}">${icon('trash-2')} Delete</button>` : ''}</div><button class="btn btn-sm ${comment.resolved ? 'btn-ghost' : 'btn-soft'}" data-resolve="${id}">${comment.resolved ? `${icon('rotate-ccw')} Reopen` : `${icon('check')} Resolve`}</button></div></article>`;
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
  function renderQAAsset(asset, poster = null) {
    const media = asset.data_uri.startsWith('data:video/')
      ? `<video controls preload="metadata" playsinline${poster?.data_uri?.startsWith('data:image/') ? ` poster="${escape(poster.data_uri)}"` : ''} aria-label="${escape(asset.caption)}" src="${escape(asset.data_uri)}"></video>`
      : `<img loading="lazy" alt="${escape(asset.caption)}" src="${escape(asset.data_uri)}">`;
    return `<figure class="qa-asset${asset.data_uri.startsWith('data:video/') ? ' qa-video' : ''}">${media}<figcaption>${escape(asset.caption)}</figcaption></figure>`;
  }
  function renderQASequence(flow, index) {
    const first = flow.assets[0];
    return `<figure class="qa-asset qa-sequence" data-qa-sequence="${index}" data-frame="0"><div class="qa-sequence-controls"><button type="button" data-sequence-prev aria-label="Previous evidence frame">← Previous</button><button type="button" data-sequence-play aria-pressed="false">Play again</button><button type="button" data-sequence-next aria-label="Next evidence frame">Next →</button><span data-sequence-count aria-live="polite">1 / ${flow.assets.length}</span></div><img alt="${escape(first.caption)}" src="${escape(first.data_uri)}"><figcaption data-sequence-caption>${escape(first.caption)}</figcaption></figure>`;
  }
  function qaPreview(flow, index, compact = false) {
    const assets = flow.assets || [];
    const poster = assets.filter(asset => asset.data_uri.startsWith('data:image/')).at(-1) || null;
    const isGif = poster?.data_uri.startsWith('data:image/gif;');
    const motion = flow.motion_preview?.data_uri || assets.find(asset => asset.data_uri.startsWith('data:video/'))?.data_uri || (isGif ? poster.data_uri : null);
    const video = motion?.startsWith('data:video/');
    const posterUri = isGif ? null : poster?.data_uri.startsWith('data:image/') ? poster.data_uri : null;
    const image = posterUri ? `<img loading="lazy" alt="" src="${escape(posterUri)}"${motion && !video ? ` data-poster-source="${escape(posterUri)}" data-motion-source="${escape(motion)}"` : ''}>` : video ? '<span class="qa-preview-placeholder">Video preview</span>' : motion ? `<span class="qa-preview-placeholder">GIF preview</span><img alt="" data-poster-source="" data-motion-source="${escape(motion)}">` : '<span class="qa-preview-placeholder">No image</span>';
    const action = video ? 'Watch video' : motion ? 'Watch GIF' : flow.presentation === 'sequence' ? `Watch ${assets.length} steps` : poster?.data_uri.startsWith('data:video/') ? 'Watch video' : assets.length ? `View ${assets.length} image${assets.length === 1 ? '' : 's'}` : 'Read check';
    return `<button type="button" class="qa-preview ${compact ? 'qa-preview-compact' : ''}" data-open-evidence="${index}" aria-haspopup="dialog" aria-label="${escape(`${action}: ${flow.title}`)}"><span class="qa-preview-image">${image}<span class="qa-preview-play" aria-hidden="true">▶</span></span><span class="qa-preview-copy">${compact ? `<strong>${escape(flow.title)}</strong><span class="qa-preview-status ${escape(flow.result)}">${escape(flow.result)}</span>` : '<strong>Visual evidence</strong>'}<span class="qa-preview-action">${escape(action)} →</span>${compact ? `<small>${escape(flow.observed)}</small>` : ''}</span></button>`;
  }
  let playingSequence = null;
  function stopQASequence() {
    if (!playingSequence) return;
    clearInterval(playingSequence.timer);
    const button = playingSequence.container.querySelector('[data-sequence-play]');
    if (button) { button.textContent = 'Play again'; button.setAttribute('aria-pressed', 'false'); }
    playingSequence = null;
  }
  function setQASequenceFrame(container, position) {
    const frames = review.qa.flows[Number(container.dataset.qaSequence)].assets;
    const next = (position + frames.length) % frames.length;
    const frame = frames[next];
    container.dataset.frame = String(next);
    const image = container.querySelector('img');
    image.src = frame.data_uri;
    image.alt = frame.caption;
    container.querySelector('[data-sequence-caption]').textContent = frame.caption;
    container.querySelector('[data-sequence-count]').textContent = `${next + 1} / ${frames.length}`;
  }
  function playQASequence(container) {
    stopQASequence();
    const frames = review.qa.flows[Number(container.dataset.qaSequence)].assets;
    if (Number(container.dataset.frame) === frames.length - 1) setQASequenceFrame(container, 0);
    const button = container.querySelector('[data-sequence-play]');
    button.textContent = 'Pause'; button.setAttribute('aria-pressed', 'true');
    const timer = setInterval(() => {
      if (!container.isConnected || document.hidden) { stopQASequence(); return; }
      const next = Number(container.dataset.frame) + 1;
      setQASequenceFrame(container, next);
      if (next === frames.length - 1) stopQASequence();
    }, 1500);
    playingSequence = {container, timer};
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
      document.querySelectorAll('.qa-evidence-modal video').forEach(video => video.pause());
      stopQASequence();
      const anchor = viewerAnchor?.isConnected ? viewerAnchor : [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find(button => button.getAttribute('aria-label') === viewerAnchor?.getAttribute('aria-label'));
      anchor?.focus({preventScroll:true});
      viewerCode = null;
    }
  });
  function expandImage(button) {
    const image = button.querySelector('img');
    viewerAnchor = button;
    viewerLabel = image.dataset.gifSource ? 'Animation viewer' : 'Screenshot viewer';
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
  function renderComponent(layer, component) {
    const active = activeComponentFile(layer, component);
    return `<section class="component-card" data-component="${escape(component.key)}"><header class="component-header" tabindex="-1"><strong>${escape([component.namespace, component.name].filter(Boolean).join('::'))}</strong><small>${escape(component.directory)}</small><small class="component-progress">${progressText(progress(component.items))}</small><div class="component-tabs" role="tablist" aria-label="${escape(component.name)} files">${component.items.map(item => `<button role="tab" id="tab-${layer.id}-${item.file}" aria-controls="panel-${layer.id}-${item.file}" aria-selected="${item.file === active}" tabindex="${item.file === active ? 0 : -1}" data-component-tab="${item.file}" title="${escape(files.get(item.file).path)}">${escape(files.get(item.file).path.split('/').pop())}</button>`).join('')}</div></header>${component.items.map(item => `<div role="tabpanel" id="panel-${layer.id}-${item.file}" aria-labelledby="tab-${layer.id}-${item.file}" ${item.file === active ? '' : 'hidden'}>${renderFile(item)}</div>`).join('')}</section>`;
  }
  function renderWalkthroughFiles(layer) {
    const pairs = components(layer);
    return ReviewTools.walkthroughSections(layer).map(section => {
      if (section.item) {
        const component = pairs.find(pair => pair.items.includes(section.item));
        if (!component) return renderFile(section.item);
        return section.item === layer.items.find(item => component.items.includes(item)) ? renderComponent(layer, component) : '';
      }
      const count = section.items.reduce((sum, item) => sum + Object.keys(item.summaries || {}).length, 0);
      const panel = `${layer.id}-tests-${layer.related_tests.indexOf(section.tests)}`;
      return `<details class="related-tests" data-test-panel="${panel}" ${expandedTests.has(panel) ? 'open' : ''}><summary><span class="related-tests-heading">${escape(section.tests.title)} <span class="badge neutral">${section.items.length} file${section.items.length === 1 ? '' : 's'} · ${count} changed range${count === 1 ? '' : 's'}</span></span><span class="related-tests-summary">${escape(section.tests.summary)}</span></summary><div class="related-tests-content">${section.items.map(renderFile).join('')}</div></details>`;
    }).join('');
  }
  function qaFlow(flow, index, showTitle = true) {
    const labels = {passed:'Passed', failed:'Failed', blocked:'Blocked', 'not-run':'Not run'};
    return `<div class="qa-journey" id="qa-flow-${index}" tabindex="-1">${showTitle ? `<h3>${escape(flow.title)}</h3>` : ''}<p class="qa-route">${(flow.journey || []).map(escape).join(' → ')}</p><p class="qa-result ${escape(flow.result)}">${showTitle ? `<strong>${labels[flow.result]}:</strong> ` : '<strong>Actual:</strong> '}${escape(flow.observed)}</p><p class="qa-expected"><strong>Expected:</strong> ${escape(flow.expected)}</p>${qaPreview(flow, index)}</div>`;
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
    const visible = other.slice(0, 4);
    const more = other.slice(4);
    return other.length ? `<section class="other-checks" aria-label="Other flows checked"><h2>Other flows checked <span class="badge neutral">${other.length}</span></h2><div class="qa-check-list">${visible.map(({flow,index}) => qaPreview(flow,index,true)).join('')}</div>${more.length ? `<details class="qa-more-checks"><summary>Show ${more.length} more check${more.length === 1 ? '' : 's'}</summary><div class="qa-check-list">${more.map(({flow,index}) => qaPreview(flow,index,true)).join('')}</div></details>` : ''}</section>` : '';
  }
  function showQA(index) {
    if ($('details-dialog').open) $('details-dialog').close();
    select('overview');
    const preview = document.querySelector(`[data-open-evidence="${index}"]`);
    if (preview) {
      for (let node = preview.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
      preview.scrollIntoView({block:'center'});
      openEvidence(index, preview);
    }
  }
  function openEvidence(index, anchor) {
    const flow = review.qa?.flows[index];
    if (!flow) return;
    stopQASequence();
    const previewImage = anchor?.querySelector?.('img[data-motion-source]');
    if (previewImage) {
      if (previewImage.dataset.posterSource) previewImage.src = previewImage.dataset.posterSource;
      else previewImage.removeAttribute('src');
    }
    viewerAnchor = anchor;
    viewerCode = null;
    viewerLabel = `Visual evidence: ${flow.title}`;
    const content = document.createElement('section');
    content.className = 'qa-evidence-modal';
    const media = flow.motion_preview ? `${renderQAAsset(flow.motion_preview, (flow.assets || []).filter(asset => asset.data_uri.startsWith('data:image/')).at(-1))}${flow.assets?.length ? `<details class="qa-original-frames"><summary>Inspect ${flow.assets.length} original frame${flow.assets.length === 1 ? '' : 's'}</summary>${flow.assets.map(renderQAAsset).join('')}</details>` : ''}` : flow.presentation === 'sequence' ? renderQASequence(flow,index) : (flow.assets || []).map(renderQAAsset).join('');
    content.innerHTML = `<header><span class="qa-preview-status ${escape(flow.result)}">${escape(flow.result)}</span><h2>${escape(flow.title)}</h2><p>${(flow.journey || []).map(escape).join(' → ')}</p></header><div class="qa-evidence-scroll">${media}<div class="qa-evidence-explanation"><p><strong>Actual:</strong> ${escape(flow.observed)}</p><p><strong>Expected:</strong> ${escape(flow.expected)}</p><h3>Steps checked</h3><ol>${flow.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol></div></div>`;
    expandedViewer.setElements([{type:'inline', content, width:'min(96vw, 1080px)', height:'92vh', draggable:false}]);
    expandedViewer.open();
    // Playback follows the explicit evidence click, never overview hover/load.
    const clip = document.querySelector('.gslide.current .qa-video video');
    if (clip) clip.play().catch(() => {});
    if (flow.presentation === 'sequence' && !flow.motion_preview) requestAnimationFrame(() => {
      const sequence = document.querySelector('.gslide.current .qa-sequence');
      if (sequence) playQASequence(sequence);
    });
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

  function renderFocus() {
    const entry = focusOrder[focusIndex];
    if (!entry) return '<p>No files in this review.</p>';
    const file = files.get(entry.file);
    const component = components(entry.layer).find(pair => pair.items.some(item => item.file === file.id));
    const componentLinks = component ? `<div class="focus-component"><span>${escape(component.name)}</span><div class="join" role="group" aria-label="${escape(component.name)} files">${component.items.map(item => {
      const sibling = files.get(item.file);
      return `<button class="btn btn-sm join-item" data-focus-component-file="${sibling.id}" aria-pressed="${sibling.id === file.id}" title="${escape(sibling.path)}" aria-label="Open ${escape(sibling.path)}">${sibling.path.endsWith('.rb') ? 'Ruby' : 'Template'}</button>`;
    }).join('')}</div></div>` : '';
    const items = layers.flatMap(layer => layer.items).filter(item => item.file === file.id);
    const summaries = Object.assign({}, ...items.map(item => item.summaries || {}));
    if (!fullContextCache.has(file.id)) {
      try { fullContextCache.set(file.id, ReviewTools.fullFileHunks(file)); }
      catch { fullContextCache.set(file.id, null); }
    }
    const full = fullContextCache.get(file.id);
    if (full && !fullContextCache.has(`${file.id}:highlighted`)) {
      const colored = {};
      ['old', 'new'].forEach(side => {
        const lines = file.source[side] === '' ? [] : file.source[side].replace(/\n$/, '').split('\n').map(text => ({text}));
        colored[side] = new Map(highlightedLines(lines, language(file.path)).map((text, i) => [i + 1, text]));
      });
      full.forEach(hunk => highlightCache.set(hunk.id, colored));
      fullContextCache.set(`${file.id}:highlighted`, true);
    }
    return `<section class="focus-reader"><header class="focus-file-header"><div class="focus-meta"><span class="focus-group" title="${escape(entry.layer.group.title)}">Group ${review.groups.indexOf(entry.layer.group) + 1} of ${review.groups.length} · ${escape(entry.layer.group.title)}${entry.layer.title === entry.layer.group.title ? '' : ` · ${escape(entry.layer.title)}`}</span><span class="focus-file-position">File ${focusIndex + 1} of ${focusOrder.length}</span><div class="focus-file-actions"><button class="btn btn-sm btn-ghost" data-change-step="-1" disabled aria-label="Previous changed section" title="Previous changed section">←</button><span id="change-position" class="muted">${file.hunks.length} changes</span><button class="btn btn-sm btn-ghost" data-change-step="1" ${file.hunks.length ? '' : 'disabled'} aria-label="Next changed section" title="Next changed section">→</button></div><div class="focus-progress-actions"><label class="file-viewed"><input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-file-viewed="${file.id}" ${fileViewed(file) ? 'checked' : ''}> <span>${fileViewed(file) ? 'Viewed' : 'Mark viewed'}</span></label><button class="btn btn-sm btn-ghost" data-focus-next ${focusIndex + 1 === focusOrder.length ? 'disabled' : ''}>Next file →</button></div></div><div class="focus-identity"><div class="current-file"><code>${escape(file.path)}</code><button class="btn btn-sm btn-ghost copy-file-path" data-copy-file title="Copy the full relative file path" aria-label="Copy file path">${icon('copy')}<span>Copy path</span></button></div>${componentLinks}${previewToggle(file)}${notVisualNote(file)}<details class="file-about"><summary>About this file</summary><p>${escape(entry.layer.summary || entry.layer.group.summary)}</p>${items.map(item => item.summary ? `<p>${escape(item.summary)}</p>` : '').join('')}</details></div></header>${!full ? '<p class="focus-unavailable">Full source was not captured or exceeds the text limit. Showing the saved diff; no current working files have been substituted.</p>' : ''}${(() => { const code = file.hunks.length || full?.length ? renderDiffTable(file, full || file.hunks, summaries) : `<pre>${escape(file.note || file.patch || 'No text diff available.')}</pre>`; const preview = previewPanel(file, 'side'); return preview ? `<div class="focus-body has-preview"><div class="focus-code">${code}</div>${preview}</div>` : code; })()}<footer class="focus-end"><span>${focusIndex + 1 === focusOrder.length ? 'End of the review' : `Next: ${escape(files.get(focusOrder[focusIndex + 1].file).path)}`}</span><button class="btn btn-sm btn-primary" data-focus-next ${focusIndex + 1 === focusOrder.length ? 'disabled' : ''}>Next file →</button></footer></section>`;
  }
  function focusFile(index) {
    document.body.classList.remove('navigation-open'); $('nav-toggle').setAttribute('aria-expanded', 'false');
    focusIndex = Math.max(0, Math.min(focusOrder.length - 1, index));
    state.navFile = focusOrder[focusIndex]?.file;
    if (focusOrder[focusIndex]) {
      state.view = focusOrder[focusIndex].layer.id;
      activateComponentFile(focusOrder[focusIndex].layer, focusOrder[focusIndex].file);
    }
    selectedChange = null;
    clearSelection(); render(); $('content').scrollTo({top:0, behavior:'instant'}); updateChangeNavigation();
  }
  function changedSectionPosition() {
    const headings = [...$('content').querySelectorAll('.change-anchor')];
    const top = document.querySelector('.focus-file-header')?.getBoundingClientRect().bottom + 8;
    let current = headings.length ? 0 : -1;
    headings.forEach((node, index) => { if (node.getBoundingClientRect().top <= top + 4) current = index; });
    if (selectedChange?.file === focusOrder[focusIndex]?.file && Math.abs(reviewScrollTop() - selectedChange.scrollTop) < 2) {
      const selected = headings.findIndex(node => node.id === selectedChange.id);
      if (selected >= 0) current = selected;
    } else selectedChange = null;
    return {headings, top, current};
  }
  function jumpChangedSection(delta) {
    const {headings, current} = changedSectionPosition();
    selectChangedSection(headings[current + delta]);
  }
  function reviewScrollTop() {
    return getComputedStyle($('content')).overflowY === 'visible' ? window.scrollY : $('content').scrollTop;
  }
  function selectChangedSection(target) {
    if (!target) return;
    // First pin the header, then correct for its final position. Use instant
    // scrolling so a second click never observes an unfinished animation.
    for (let pass = 0; pass < 2; pass++) {
      const top = document.querySelector('.focus-file-header').getBoundingClientRect().bottom + 8;
      const delta = target.getBoundingClientRect().top - top;
      if (getComputedStyle($('content')).overflowY === 'visible') window.scrollTo({top:window.scrollY + delta, behavior:'instant'});
      else $('content').scrollTo({top:$('content').scrollTop + delta, behavior:'instant'});
    }
    selectedChange = {file:focusOrder[focusIndex]?.file, id:target.id, scrollTop:reviewScrollTop()};
    updateChangeNavigation();
  }
  function updateChangeNavigation() {
    if (!fileReadingActive()) return;
    const {headings, current} = changedSectionPosition();
    $('content').querySelectorAll('.code-row.is-current-change').forEach(row => row.classList.remove('is-current-change'));
    for (let row = headings[current]; row?.classList.contains('code-row') && row.querySelector('td.code.add, td.code.del'); row = row.nextElementSibling) {
      row.classList.add('is-current-change');
    }
    const label = $('change-position');
    if (!label) return;
    label.textContent = current < 0 ? `${headings.length} changed sections` : `Section ${current + 1} of ${headings.length}`;
    const previous = document.querySelector('[data-change-step="-1"]');
    const next = document.querySelector('[data-change-step="1"]');
    if (previous) previous.disabled = current <= 0;
    if (next) next.disabled = current >= headings.length - 1;
  }
  $('content').addEventListener('scroll', updateChangeNavigation, {passive:true});
  window.addEventListener('scroll', updateChangeNavigation, {passive:true});
  function setFontSize(size) {
    state.codeFontSize = Math.max(10, Math.min(20, Number(size) || 13));
    document.body.style.setProperty('--code-font-size', `${state.codeFontSize}px`);
    document.body.style.setProperty('--code-line-height', `${Math.round(state.codeFontSize * 1.8)}px`);
    $('font-size').textContent = `${state.codeFontSize}px`;
    $('font-smaller').disabled = state.codeFontSize === 10;
    $('font-larger').disabled = state.codeFontSize === 20;
    persist(); schedulePosition();
  }
  function render() {
    stopQASequence();
    closeComments();
    document.body.classList.toggle('reading-focus', fileReadingActive());
    $('focus').textContent = 'File by file';
    $('walkthrough').setAttribute('aria-pressed', !focusMode);
    $('focus').setAttribute('aria-pressed', focusMode);
    if (fileReadingActive() && focusOrder[focusIndex]) { state.navFile = focusOrder[focusIndex].file; state.view = focusOrder[focusIndex].layer.id; }
    renderNavigation();
    persist();
    const layer = layers.find(layer => layer.id === state.view);
    $('position').textContent = layer ? `Step ${layers.indexOf(layer) + 1} of ${layers.length}` : state.view === 'files' ? 'All changes' : 'Overview';
    $('prev').disabled = !layer;
    $('next').disabled = !!layer && layers.indexOf(layer) === layers.length - 1;
    ['unified','split'].forEach(mode => { $(mode).setAttribute('aria-pressed', layoutChoice === mode); });
    if (fileReadingActive()) {
      $('position').textContent = `File ${focusIndex + 1} of ${focusOrder.length}`;
      $('prev').disabled = focusIndex === 0; $('next').disabled = focusIndex === focusOrder.length - 1;
    }
    $('prev').setAttribute('aria-label', fileReadingActive() ? 'Previous file' : 'Previous step');
    $('next').setAttribute('aria-label', fileReadingActive() ? 'Next file' : 'Next step');
    $('content').innerHTML = fileReadingActive() ? renderFocus() : layer ? renderStep(layer) : state.view === 'files' ? renderFiles() : renderOverview();
    hydratePreviews($('content'));
    paintSelection();
    requestAnimationFrame(updateChangeNavigation);
    if (layer && !fileReadingActive()) {
      $('notes').value = state.notes[layer.id] || '';
      $('notes').addEventListener('input', event => { state.notes[layer.id] = event.target.value; persist(); });
    }
  }

  function select(view, scroll = true) {
    if (focusMode) { const index = focusOrder.findIndex(entry => entry.layer.id === view); if (index >= 0) focusIndex = index; }
    clearSelection();
    document.body.classList.remove('navigation-open'); $('nav-toggle').setAttribute('aria-expanded', 'false');
    if (state.view !== view || scroll) state.navFile = null;
    state.view = view;
    history.replaceState(null, '', `#${view}`);
    render();
    if (scroll) $('content').scrollTop = 0;
  }
  function navigateFile(layer, id) {
    if (focusMode) { focusFile(focusOrder.findIndex(entry => entry.file === id)); return; }
    const file = files.get(id);
    activateComponentFile(layer, id);
    state.fileOpen[file.path] = true;
    select(layer.id, false);
    state.navFile = id;
    renderNavigation(); persist();
    const card = document.querySelector(`.file-card[data-file="${id}"]`);
    for (let parent = card?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    // The sticky header may already be pinned at the viewport top. Scroll its
    // non-sticky section to return to the real beginning, then focus the header.
    const component = card?.closest('[data-component]');
    const target = component?.querySelector('.component-header') || card?.querySelector('summary');
    if (component) {
      const content = $('content');
      // Keep the section below the padded scrollport's sticky boundary. A bare
      // scrollIntoView can pin the header over the first file's toolbar.
      const inset = (parseFloat(getComputedStyle(content).paddingTop) || 0) + 8;
      const top = content.scrollTop + component.getBoundingClientRect().top
        - content.getBoundingClientRect().top - content.clientTop - inset;
      content.scrollTo({top: Math.max(0, top), behavior:'instant'});
    } else target?.scrollIntoView({block:'start', behavior:'instant'});
    target?.focus({preventScroll:true});
  }
  function step(delta) {
    if (fileReadingActive()) { focusFile(focusIndex + delta); return; }
    const index = layers.findIndex(layer => layer.id === state.view);
    if (index === 0 && delta < 0) return select('overview');
    const target = layers[Math.max(0, Math.min(layers.length - 1, index + delta))];
    if (target) select(target.id);
  }
  function jump(hunk, commentID) {
    const file = hunkFiles.get(hunk);
    const fullFile = hunk === fullAnchor(file);
    const layer = layers.find(layer => fullFile ? layer.items.some(item => item.file === file.id) : hunkIDs(layer).includes(hunk));
    if (!layer) return;
    activateComponentFile(layer, file.id);
    if ($('details-dialog').open) $('details-dialog').close();
    showComments = true; $('comments-toggle').checked = true;
    if (fullFile && !focusMode) chooseReadingMode(true);
    if (focusMode) { focusFile(focusOrder.findIndex(entry => entry.file === file.id)); } else if (state.view === 'files') { categoryFilter = 'All'; $('search').value = ''; render(); } else select(layer.id, false);
    state.navFile = file.id;
    renderNavigation(); persist();
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

  $('content').addEventListener('change', event => {
    const control = event.target.closest('[data-file-viewed]');
    if (!control) return;
    const file = files.get(control.dataset.fileViewed);
    state.viewedFiles = state.viewedFiles.filter(path => path !== file.path);
    if (control.checked) state.viewedFiles.push(file.path);
    state.fileOpen[file.path] = !control.checked;
    if (fileReadingActive()) control.parentElement.querySelector('span').textContent = control.checked ? 'Viewed' : 'Mark viewed';
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
    if (layer) document.querySelectorAll('[data-component]').forEach(card => {
      const component = components(layer).find(pair => pair.key === card.dataset.component);
      card.querySelector('.component-progress').textContent = progressText(progress(component.items));
    });
    if (!persist()) toast('Browser storage is unavailable. Export local notes to keep your file progress.');
    const scroll = $('navigation').parentElement.scrollTop;
    renderNavigation();
    $('navigation').parentElement.scrollTop = scroll;
  });
  $('content').addEventListener('toggle', event => {
    const panel = event.target;
    if (panel.matches('.preview-panel') && panel.isConnected) {
      // A details element rendered open fires toggle on insertion; remember only real
      // user changes, on wide screens. Frames size themselves once visible.
      const changed = String(panel.open) !== panel.dataset.openState;
      panel.dataset.openState = String(panel.open);
      if (changed && panel.matches('.side') && wideScreen()) { state.previewPane = panel.open ? 'open' : 'closed'; persist(); }
      if (panel.matches('.side')) document.querySelectorAll('[data-preview-toggle]').forEach(button => button.setAttribute('aria-expanded', panel.open));
      if (panel.open) requestAnimationFrame(() => panel.querySelectorAll('iframe[data-preview-id]').forEach(fitPreview));
      return;
    }
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
  document.addEventListener('keydown', event => {
    if (!event.target.matches('[data-component-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...event.target.parentElement.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus({preventScroll:true});
  });
  document.addEventListener('click', async event => {
    // Keep the checkbox independent from the native disclosure summary.
    if (event.target.closest('.file-viewed')) { event.stopPropagation(); return; }
    const evidencePreview = event.target.closest('[data-open-evidence]');
    if (evidencePreview) { openEvidence(Number(evidencePreview.dataset.openEvidence), evidencePreview); return; }
    const sequenceControl = event.target.closest('[data-sequence-prev], [data-sequence-play], [data-sequence-next]');
    if (sequenceControl) {
      const container = sequenceControl.closest('[data-qa-sequence]');
      if (sequenceControl.hasAttribute('data-sequence-play')) {
        if (playingSequence?.container === container) stopQASequence();
        else playQASequence(container);
      } else {
        stopQASequence();
        setQASequenceFrame(container, Number(container.dataset.frame) + (sequenceControl.hasAttribute('data-sequence-next') ? 1 : -1));
      }
      return;
    }
    const componentLink = event.target.closest('[data-component-link]');
    if (componentLink) {
      const layer = layers.find(layer => layer.id === componentLink.dataset.fileLayer);
      const component = components(layer).find(pair => pair.key === componentLink.dataset.componentLink);
      navigateFile(layer, activeComponentFile(layer, component));
      return;
    }
    const fileLink = event.target.closest('[data-file-link]');
    if (fileLink) {
      navigateFile(layers.find(layer => layer.id === fileLink.dataset.fileLayer), fileLink.dataset.fileLink);
      return;
    }
    const componentTab = event.target.closest('[data-component-tab]');
    if (componentTab) {
      const layer = layers.find(layer => layer.id === state.view);
      const card = componentTab.closest('[data-component]');
      const active = card.querySelector('[role="tab"][aria-selected="true"]');
      const scrollKey = id => `${layer.id}:${id}`;
      componentScroll.set(scrollKey(active.dataset.componentTab), $('content').scrollTop);
      activateComponentFile(layer, componentTab.dataset.componentTab);
      state.navFile = componentTab.dataset.componentTab;
      clearSelection(); closeComments();
      card.querySelectorAll('[role="tab"]').forEach(tab => {
        const selected = tab === componentTab;
        tab.setAttribute('aria-selected', selected); tab.tabIndex = selected ? 0 : -1;
        $(tab.getAttribute('aria-controls')).hidden = !selected;
      });
      renderNavigation(); persist();
      $('content').scrollTop = componentScroll.get(scrollKey(componentTab.dataset.componentTab)) ?? $('content').scrollTop;
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
    const reviewNote = event.target.closest('.review-note-trigger');
    if (reviewNote) selectChangedSection(reviewNote.closest('.change-anchor'));
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
  let activeReviewNote = null;
  function positionReviewNote() {
    if (!activeReviewNote) return;
    positionAnnotation(activeReviewNote.panel, activeReviewNote.trigger, () => activeReviewNote?.panel.hidePopover());
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopQASequence(); });
  function setPreviewMotion(event, active) {
    const preview = event.target.closest?.('[data-open-evidence]');
    if (!preview || (event.relatedTarget && preview.contains(event.relatedTarget))) return;
    const image = preview.querySelector('img[data-motion-source]');
    if (image) {
      if (active || image.dataset.posterSource) image.src = active ? image.dataset.motionSource : image.dataset.posterSource;
      else image.removeAttribute('src');
    }
  }
  document.addEventListener('pointerover', event => setPreviewMotion(event, true));
  document.addEventListener('pointerout', event => setPreviewMotion(event, false));
  document.addEventListener('focusin', event => setPreviewMotion(event, true));
  document.addEventListener('focusout', event => setPreviewMotion(event, false));
  document.addEventListener('toggle', event => {
    const panel = event.target;
    if (!panel.matches?.('.review-note-popover')) return;
    const trigger = document.querySelector(`[popovertarget="${panel.id}"]`);
    if (event.newState === 'open') {
      activeReviewNote = {panel, trigger};
      trigger?.setAttribute('aria-expanded', 'true');
      positionReviewNote();
    } else {
      trigger?.setAttribute('aria-expanded', 'false');
      if (activeReviewNote?.panel === panel) activeReviewNote = null;
    }
  }, true);
  document.addEventListener('scroll', () => requestAnimationFrame(positionReviewNote), true);
  window.addEventListener('resize', positionReviewNote);
  let positionFrame;
  const schedulePosition = () => { cancelAnimationFrame(positionFrame); positionFrame = requestAnimationFrame(positionComment); };
  document.addEventListener('scroll', schedulePosition, true);
  window.addEventListener('resize', schedulePosition);
  $('prev').onclick = () => step(-1);
  $('next').onclick = () => step(1);
  ['unified','split'].forEach(mode => { $(mode).onclick = () => { const scroll = $('content').scrollTop; layoutChoice = layout = mode; render(); $('content').scrollTop = scroll; }; });
  tabletLayout.addEventListener('change', renderExpandedCode);
  // Wide screens collapse the sidebar in place (remembered); narrow screens keep the drawer.
  function applySidebar() {
    const collapsed = wideScreen() && !!state.sidebarCollapsed;
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (!wideScreen()) return;
    const label = collapsed ? 'Show review navigation' : 'Hide review navigation';
    $('nav-toggle').setAttribute('aria-expanded', !collapsed);
    $('nav-toggle').setAttribute('aria-label', label);
    $('nav-toggle').title = label;
  }
  $('nav-toggle').onclick = () => {
    if (wideScreen()) { state.sidebarCollapsed = !state.sidebarCollapsed; persist(); applySidebar(); return; }
    const open = document.body.classList.toggle('navigation-open');
    $('nav-toggle').setAttribute('aria-expanded', open);
  };
  window.addEventListener('resize', applySidebar);
  applySidebar();
  $('content').addEventListener('click', event => {
    const pane = event.target.closest('[data-preview-toggle]') && document.getElementById('preview-pane');
    if (!pane) return;
    pane.open = !pane.open;
    if (pane.open && !wideScreen()) pane.scrollIntoView({block: 'nearest'});
  });
  $('comments-toggle').onchange = event => { const scroll = $('content').scrollTop; showComments = event.target.checked; render(); $('content').scrollTop = scroll; };
  function chooseReadingMode(enabled) {
    focusMode = enabled;
    try { localStorage.setItem('dynamic-review:reading-mode', enabled ? 'file' : 'walkthrough'); } catch { /* Choice still applies to this page session. */ }
    if (focusMode) { const index = focusOrder.findIndex(entry => state.navFile ? entry.file === state.navFile : entry.layer.id === state.view); if (index >= 0) focusIndex = index; }
    document.body.classList.toggle('reading-focus', fileReadingActive());
    $('focus').setAttribute('aria-pressed', focusMode);
    $('focus').textContent = 'File by file';
    $('walkthrough').setAttribute('aria-pressed', !focusMode);
    $('focus').setAttribute('aria-pressed', focusMode);
    clearSelection(); render(); $('content').scrollTop = 0;
  };
  $('focus').onclick = () => chooseReadingMode(true);
  $('walkthrough').onclick = () => chooseReadingMode(false);
  $('font-smaller').onclick = () => setFontSize(state.codeFontSize - 1);
  $('font-larger').onclick = () => setFontSize(state.codeFontSize + 1);
  $('content').addEventListener('click', event => {
    const sibling = event.target.closest('[data-focus-component-file]');
    if (sibling) {
      const id = sibling.dataset.focusComponentFile;
      focusFile(focusOrder.findIndex(entry => entry.file === id));
      document.querySelector(`[data-focus-component-file="${id}"]`)?.focus({preventScroll:true});
    }
    if (event.target.closest('[data-focus-next]')) step(1);
    if (event.target.closest('[data-copy-file]')) copyText(files.get(focusOrder[focusIndex].file).path);
    const button = event.target.closest('[data-change-step]');
    if (button) {
      jumpChangedSection(Number(button.dataset.changeStep));
    }
  });
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
    if (key === 'z') chooseReadingMode(!focusMode);
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
  if (state.view !== saved.view) state.navFile = null;
  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1);
    if (['overview','files', ...layers.map(layer => layer.id)].includes(view)) select(view);
  });
  const initialFile = focusOrder.findIndex(entry => entry.layer.id === state.view && (!state.navFile || entry.file === state.navFile));
  if (initialFile >= 0) focusIndex = initialFile;
  setFontSize(state.codeFontSize);
  render();
})();
