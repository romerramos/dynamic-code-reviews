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
  // Published before the agent finished: the reader starts on the code while comments arrive.
  const inProgress = review.status === 'in_progress';
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
  // Display preferences are global to the reviewer, not to one review, so they live under
  // their own key. A served review mirrors the key to the server (see live/live.js).
  const settingsKey = 'dynamic-review:settings';
  const settings = {colorMode:'system', syntaxTheme:'classic', ignoreWhitespace:false};
  try { Object.assign(settings, JSON.parse(localStorage.getItem(settingsKey) || '{}')); } catch { /* defaults apply */ }
  if (!['system', 'light', 'dark'].includes(settings.colorMode)) settings.colorMode = 'system';
  if (!['classic', 'github', 'one', 'solarized', 'dracula'].includes(settings.syntaxTheme)) settings.syntaxTheme = 'classic';
  settings.ignoreWhitespace = settings.ignoreWhitespace === true;
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const shownRows = (hunk, mode) => ReviewTools.displayRows(hunk.rows[mode], mode, settings.ignoreWhitespace);
  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = settings.colorMode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : settings.colorMode;
    root.dataset.syntax = settings.syntaxTheme;
    document.querySelectorAll('[data-color-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.colorMode === settings.colorMode));
    $('syntax-theme').value = settings.syntaxTheme;
    $('whitespace-toggle').checked = settings.ignoreWhitespace;
  }
  function saveSettings() {
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* applies to this page only */ }
  }
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

  // Templates show where their preview stands, so rendered ones are easy to find again.
  function navPreviewMark(file) {
    if (!previewEligible(file)) return '';
    const status = previewState(file.path);
    const label = {fresh:'New preview ready', ready:'Preview ready', requested:'Preview requested', working:'Building preview', selected:'Selected for preview'}[status];
    return label ? `<span class="nav-preview is-${status}" title="${label}" aria-label="${label}">${icon(status === 'requested' ? 'clock' : 'scan-text')}</span>` : '';
  }
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
        return `<li><button class="nav-file ${fileViewed(file) ? 'is-viewed' : ''}" data-file-link="${id}" data-file-layer="${layer.id}" aria-current="${state.navFile === id && state.view === layer.id ? 'location' : 'false'}" title="${escape(file.path)}" aria-label="${escape(`Open ${file.path}${fileViewed(file) ? ', viewed' : ', not viewed'}`)}"><span class="file-status" aria-hidden="true">${fileViewed(file) ? icon('check') : ''}</span><span class="nav-file-label"><span class="nav-file-name">${escape(filename)}</span>${directory ? `<small class="nav-file-directory">${escape(directory)}</small>` : ''}</span>${navPreviewMark(file)}</button></li>`;
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
  let drag = null; // a drag over line numbers in progress

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
    removeComposer(true);
  }
  function paintSelection() {
    document.querySelectorAll('.user-range-selected').forEach(cell => cell.classList.remove('user-range-selected'));
    if (!selection) return removeComposer();
    document.querySelectorAll('.gutter[data-line]').forEach(cell => {
      if (![cell.dataset.hunk, cell.dataset.fullHunk].includes(selection.hunk) || cell.dataset.side !== selection.side || Number(cell.dataset.line) < selection.start || Number(cell.dataset.line) > selection.end) return;
      cell.classList.add('user-range-selected');
      (layout === 'split' ? cell.nextElementSibling : cell.parentElement.querySelector('.code'))?.classList.add('user-range-selected');
    });
    if (!drag?.moved) placeComposer(); // while dragging, wait for the release
  }
  function selectLine(button, extend = false) {
    closeComments();
    const number = Number(button.dataset.selectLine);
    const hunk = button.dataset.rangeHunk;
    const side = button.dataset.rangeSide;
    // A plain click starts a new selection (a typed draft moves with the composer); shift-click extends it.
    const origin = extend && selection?.hunk === hunk && selection.side === side ? selection.origin : number;
    selection = {hunk, side, origin, start:Math.min(origin, number), end:Math.max(origin, number)};
    if (!ReviewTools.anchor(snapshot, selection)) { clearSelection(); return; }
    paintSelection();
  }

  // --- Commenting where you read: the composer opens directly under the selected lines ----------------
  // Click a line number or drag over several; the composer grows out of the code, like a review on a pull
  // request. The text, type and blocking choice survive the page re-rendering, so nothing is lost.
  // In a served review it first asks who the comment is for: your agent (a question that stays in this
  // review and is sent at once) or the PR (a typed review comment, saved to post on GitHub).
  const composer = {text: '', label: 'note', blocking: false, mode: 'agent', node: null, shownFor: '', sender: null};
  const prLabel = snapshot.mode === 'pr' || review.history?.origin_mode === 'pr' ? 'PR comment' : 'Review comment';
  const composerModes = {
    agent: {placeholder: 'Ask your agent about these lines. It answers here; nothing goes to GitHub.', hint: 'to ask'},
    pr: {placeholder: 'Leave a comment. The first line is the headline; add detail below it.', hint: 'to save'}
  };
  const composerTypes = ['note', 'question', 'suggestion', 'issue'];
  function composerNode() {
    if (composer.node) return composer.node;
    const form = document.createElement('form');
    form.id = 'inline-composer';
    form.className = 'composer';
    form.noValidate = true;
    form.setAttribute('aria-label', 'Add a comment');
    form.innerHTML = `<header class="composer-head"><div class="composer-modes" role="radiogroup" aria-label="Who is this comment for?" hidden><label class="composer-mode"><input type="radio" name="composer-mode" value="agent"><span>${icon('sparkles')}Ask agent</span></label><label class="composer-mode"><input type="radio" name="composer-mode" value="pr"><span>${icon('message-square')}${prLabel}</span></label></div><span class="composer-where"></span><button type="button" class="act act-quiet act-icon" data-composer-cancel aria-label="Cancel comment" title="Cancel (Esc)">${icon('x')}</button></header>
      <div class="composer-types" role="radiogroup" aria-label="Type of comment">${composerTypes.map(type => `<label class="composer-type"><input type="radio" name="composer-label" value="${type}"><span>${icon(commentTypes[type][0])}${commentTypes[type][1]}</span></label>`).join('')}</div>
      <textarea class="composer-text" rows="3" aria-label="Your comment"></textarea>
      <footer class="composer-foot"><label class="composer-blocking"><input type="checkbox" name="composer-blocking"><span>Blocks approval</span></label><span class="composer-hint"><kbd>⌘</kbd><kbd>↵</kbd> <span data-composer-hint></span></span><div class="composer-actions"><button type="button" class="act act-quiet" data-composer-cancel>Cancel</button><button type="submit" class="act act-pr" data-composer-save>Save comment</button><button type="submit" class="act act-agent" data-composer-send hidden>${icon('send')}Ask agent</button></div></footer>`;
    const text = form.querySelector('.composer-text');
    const refresh = () => {
      composer.text = text.value;
      form.querySelectorAll('[data-composer-save], [data-composer-send]').forEach(button => { button.disabled = !text.value.trim(); });
    };
    text.addEventListener('input', refresh);
    text.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSelection(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('change', event => {
      if (event.target.name === 'composer-mode') { composer.mode = event.target.value; syncComposerMode(); }
      if (event.target.name === 'composer-label') composer.label = event.target.value;
      if (event.target.name === 'composer-blocking') composer.blocking = event.target.checked;
      form.querySelector('.composer-types').dataset.type = composer.label;
    });
    form.addEventListener('click', event => {
      if (event.target.closest('[data-composer-cancel]')) clearSelection();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const entered = splitComment(composer.text);
      if (!entered.subject || !selection) return;
      const ask = composerMode() === 'agent';
      const comment = {hunk: selection.hunk, side: selection.side, start: selection.start, end: selection.end, id: `mine-${crypto.randomUUID()}`,
        label: ask ? 'question' : composer.label, decoration: !ask && composer.blocking ? 'blocking' : 'non-blocking', audience: ask ? 'agent' : 'pr', subject: entered.subject, discussion: entered.discussion};
      commitComment(comment);
      if (ask) composer.sender(comment.id);
    });
    composer.node = form;
    syncComposerFields();
    return form;
  }
  const splitComment = ReviewTools.splitComment;
  // Asking the agent needs a served review; a saved page only drafts comments for the PR.
  const composerMode = () => composer.sender ? composer.mode : 'pr';
  function syncComposerMode() {
    const form = composer.node;
    const mode = composerMode();
    form.dataset.mode = mode;
    form.querySelector('.composer-modes').hidden = !composer.sender;
    form.querySelector(`input[name="composer-mode"][value="${mode}"]`).checked = true;
    form.querySelector('.composer-text').placeholder = composerModes[mode].placeholder;
    form.querySelector('[data-composer-hint]').textContent = composerModes[mode].hint;
    form.querySelector('[data-composer-save]').hidden = mode === 'agent';
    form.querySelector('[data-composer-send]').hidden = mode !== 'agent';
  }
  function syncComposerFields() {
    const form = composer.node;
    form.querySelector('.composer-text').value = composer.text;
    form.querySelector(`input[name="composer-label"][value="${composer.label}"]`).checked = true;
    form.querySelector('input[name="composer-blocking"]').checked = composer.blocking;
    form.querySelector('.composer-types').dataset.type = composer.label;
    form.querySelectorAll('[data-composer-save], [data-composer-send]').forEach(button => { button.disabled = !composer.text.trim(); });
    syncComposerMode();
  }
  function removeComposer(reset = false) {
    const row = composer.node?.closest('tr.inline-compose');
    row?.remove();
    if (reset) { composer.text = ''; composer.label = 'note'; composer.blocking = false; composer.shownFor = ''; if (composer.node) syncComposerFields(); }
  }
  // Put the composer in a row right under the last selected line, in whichever layout is showing.
  function placeComposer() {
    const form = composerNode();
    const cell = [...document.querySelectorAll('.gutter[data-line]')].find(candidate => [candidate.dataset.hunk, candidate.dataset.fullHunk].includes(selection.hunk) && candidate.dataset.side === selection.side && Number(candidate.dataset.line) === selection.end);
    const row = cell?.closest('tr');
    if (!row) return;
    document.querySelectorAll('tr.inline-compose').forEach(old => { if (old.previousElementSibling !== row) old.remove(); });
    if (!(row.nextElementSibling?.classList.contains('inline-compose'))) {
      const wrap = document.createElement('tr');
      wrap.className = 'inline-compose';
      const holder = document.createElement('td');
      holder.colSpan = row.children.length;
      wrap.append(holder);
      row.after(wrap);
      holder.append(form);
    }
    const where = `${selection.side === 'new' ? 'After' : 'Before'} ${selection.start === selection.end ? `line ${selection.start}` : `lines ${selection.start}–${selection.end}`}`;
    form.querySelector('.composer-where').textContent = where;
    const signature = `${selection.hunk}|${selection.side}|${selection.start}|${selection.end}`;
    if (composer.shownFor !== signature) {
      composer.shownFor = signature;
      setTimeout(() => { form.querySelector('.composer-text').focus({preventScroll: true}); form.scrollIntoView({block: 'nearest', behavior: 'instant'}); }); // a timer, not a frame: frames pause in a background tab
    }
  }
  // Save a comment you wrote: used by the composer and the dialog alike.
  function commitComment(comment) {
    state.personalComments = state.personalComments.filter(existing => existing.id !== comment.id);
    state.personalComments.push(comment);
    state.resolvedComments = state.resolvedComments.filter(id => id !== comment.id);
    refreshComments();
    const stored = persist();
    clearSelection();
    const scroll = $('content').scrollTop; render(); $('content').scrollTop = scroll;
    toast(stored ? 'Your comment is saved in this browser.' : 'Browser storage is unavailable. Copy or export your review before closing.');
  }
  window.ReviewComposer = {setSender(fn) { composer.sender = fn; composerNode(); syncComposerMode(); }};

  // Dragging over line numbers selects a range; the composer opens when the pointer is released.
  document.addEventListener('pointerdown', event => {
    const button = event.target.closest?.('[data-select-line]');
    if (!button || event.button !== 0 || event.shiftKey) return;
    drag = {hunk: button.dataset.rangeHunk, side: button.dataset.rangeSide, origin: Number(button.dataset.selectLine), moved: false};
  });
  document.addEventListener('pointerover', event => {
    const button = event.target.closest?.('[data-select-line]');
    if (!drag || !button || button.dataset.rangeHunk !== drag.hunk || button.dataset.rangeSide !== drag.side || Number(button.dataset.selectLine) === drag.origin && !drag.moved) return;
    drag.moved = true;
    selection = {hunk: drag.hunk, side: drag.side, origin: drag.origin, start: Math.min(drag.origin, Number(button.dataset.selectLine)), end: Math.max(drag.origin, Number(button.dataset.selectLine))};
    paintSelection();
  });
  document.addEventListener('pointerup', () => {
    const dragged = drag?.moved;
    drag = null;
    if (!dragged) return;
    composer.suppressClick = true; setTimeout(() => { composer.suppressClick = false; });
    paintSelection();
  });
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
  async function copyText(text, done = 'Copied to clipboard.') {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch {
      closeComments();
      $('copy-text').value = text;
      $('copy-dialog').showModal();
      $('copy-text').focus(); $('copy-text').select();
    }
  }

  function commentHTML(comment) {
    return `<section class="popover-comment" data-comment-id="${escape(comment.id)}"><p class="comment-location">${escape(ReviewTools.anchor(snapshot, comment)?.file.path || '')}</p><div class="thread-badges">${threadBadges(comment)}</div><p class="comment-location">${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}</p><h4>${escape(comment.subject)}</h4>${ReviewTools.commentBody(comment, review.qa) ? `<div class="comment-discussion">${ReviewTools.markdown(ReviewTools.commentBody(comment, review.qa))}</div>` : ''}${ReviewTools.evidenceFlows(review.qa, comment).length ? `<button class="btn btn-xs btn-soft" data-evidence="${escape(comment.id)}">See visual evidence</button>` : ''}<div class="comment-actions">${commentActions(comment, 'xs')}</div></section>`;
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
    const heading = hunk.contextOnly || inlineNote ? '' : `<tr class="range-heading" id="${comment ? 'expanded-' : ''}${hunk.id}"><td colspan="${columns}"><div class="range-label"><span>CHANGED RANGE</span><span>Before ${range('old')} &nbsp; / &nbsp; After ${range('new')}</span></div>${summary ? `<p>${escape(summary)}</p>` : ''}</td></tr>`;
    const rows = shownRows(hunk, mode).map(row => {
      if (mode === 'split') return `<tr class="code-row">${splitCells(hunk, row.old, 'old', colored, comment, path)}${splitCells(hunk, row.new, 'new', colored, comment, path)}</tr>`;
      const side = row.kind === 'del' ? 'old' : 'new';
      const marked = rangeClasses(hunk, 'old', row.old, comment, path) + rangeClasses(hunk, 'new', row.new, comment, path);
      const kind = row.kind === 'context' ? '' : row.kind;
      const sign = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
      return `<tr class="code-row"><td class="gutter ${kind}${rangeClasses(hunk,'old',row.old,comment,path)}" data-hunk="${hunk.id}" data-full-hunk="${fullAnchor(filesByPath.get(path))}" data-side="old" ${row.old !== undefined ? `data-line="${row.old}"` : ''}>${commentTrigger(hunk, 'old', row.old, comment, path)}${lineButton(hunk, 'old', row.old, comment, path)}</td><td class="gutter ${kind}${rangeClasses(hunk,'new',row.new,comment,path)}" data-hunk="${hunk.id}" data-full-hunk="${fullAnchor(filesByPath.get(path))}" data-side="new" ${row.new !== undefined ? `data-line="${row.new}"` : ''}>${commentTrigger(hunk, 'new', row.new, comment, path)}${lineButton(hunk, 'new', row.new, comment, path)}</td><td class="code ${kind}${marked}"><code><span class="sign" aria-hidden="true">${sign}</span>${colored[side].get(row[side]) || ''}</code>${row.no_newline ? '<span class="newline-marker">No newline at end of file</span>' : ''}</td></tr>`;
    });
    if (inlineNote) {
      const changed = row => mode === 'unified' ? row.kind !== 'context' : row.old?.kind === 'del' || row.new?.kind === 'add';
      const starts = shownRows(hunk, mode).flatMap((row, index, all) => changed(row) && (index === 0 || !changed(all[index - 1])) ? [index] : []);
      const firstChange = starts[0];
      starts.forEach((rowIndex, index) => {
        const id = index === 0 ? hunk.id : `${hunk.id}-change-${index + 1}`;
        rows[rowIndex] = rows[rowIndex].replace('<tr class="code-row">', `<tr class="code-row change-anchor" id="${id}">`);
      });
      const note = `<button class="review-note-trigger" aria-expanded="false" aria-haspopup="dialog" popovertarget="note-${hunk.id}" aria-label="Read review note for this change" title="Review note">${icon('sticky-note')}</button><aside id="note-${hunk.id}" class="review-note-popover comment-popover" popover="auto" role="dialog" aria-label="Review note"><header class="popover-heading"><strong>Review note</strong><button class="btn btn-xs btn-circle btn-ghost" popovertarget="note-${hunk.id}" popovertargetaction="hide" aria-label="Close review note">✕</button></header><section class="popover-comment"><p>${escape(summary || 'Changed section')}</p><small>Before ${range('old')} · After ${range('new')}</small></section></aside>`;
      if (summary && firstChange !== undefined) {
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
  const previewById = new Map();
  const previewsByPath = new Map();
  const notVisualByPath = new Map();
  // Previews your agent builds while you review (a served review only): ready ones join the list
  // above, the rest are shown as a request in progress.
  const live = {enabled: false, ready: new Map(), pending: new Map()};
  // A ViewComponent is one thing to preview: its class and its template share a preview and a state.
  const componentSibling = path => {
    const other = /_component\.rb$/.test(path) ? path.replace(/\.rb$/, '.html.erb') : /_component\.html\.erb$/.test(path) ? path.replace(/\.html\.erb$/, '.rb') : null;
    return other && filesByPath.has(other) ? other : null;
  };
  const pendingPreview = path => live.pending.get(path) || live.pending.get(componentSibling(path));
  function rebuildPreviews() {
    previewById.clear(); previewsByPath.clear(); notVisualByPath.clear();
    [...(review.previews || []), ...live.ready.values()].forEach(preview => {
      previewById.set(preview.id, preview);
      new Set(preview.files.flatMap(path => [path, componentSibling(path)]).filter(Boolean)).forEach(path => {
        const target = preview.status === 'not_visual' ? notVisualByPath : previewsByPath;
        if (!target.has(path)) target.set(path, []);
        target.get(path).push(preview);
      });
    });
  }
  rebuildPreviews();
  // Visual selections survive media-only revisions of the same code snapshot.
  const visualStorageKey = `dynamic-review:visuals:${snapshot.repo}:${review.history?.series || ''}:${snapshot.fingerprint}`;
  let visualState = {};
  try { visualState = JSON.parse(localStorage.getItem(visualStorageKey) || '{}') || {}; } catch { /* Session-only selection still works. */ }
  visualState = {previews:ReviewTools.pendingPreviews(snapshot, review, visualState.previews), requested:Array.isArray(visualState.requested) ? visualState.requested : []};
  const previewsPossible = snapshot.files.some(ReviewTools.previewEligible);
  const lifecycle = () => ReviewTools.previewLifecycle(snapshot, review, visualState);
  function persistVisuals() {
    try { localStorage.setItem(visualStorageKey, JSON.stringify(visualState)); return true; }
    catch { return false; }
  }
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const since = at => {
    const minutes = Math.round((Date.now() - Date.parse(at)) / 60000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
    return new Date(at).toLocaleDateString();
  };
  // A file's place in the preview lifecycle: ready, requested, selected or none.
  function previewState(path) {
    if (live.enabled && !previewsByPath.has(path) && pendingPreview(path)) return pendingPreview(path).status;
    const hub = lifecycle();
    if (hub.ready.some(item => item.path === path)) return hub.ready.find(item => item.path === path).fresh ? 'fresh' : 'ready';
    if (hub.requested.some(item => item.path === path)) return 'requested';
    return visualState.previews.includes(path) ? 'selected' : 'none';
  }
  function hubRow(path, meta, actions) {
    const slash = path.lastIndexOf('/');
    return `<li><div class="hub-file"><strong>${escape(path.slice(slash + 1))}</strong><small>${escape(slash < 0 ? '' : path.slice(0, slash))}</small>${meta ? `<span class="hub-meta">${meta}</span>` : ''}</div><div class="hub-actions">${actions}</div></li>`;
  }
  function renderPreviewHub() {
    const hub = lifecycle();
    const ready = hub.ready.length ? `<section class="hub-section"><h3>Ready to view <span>${hub.ready.length}</span></h3><ul class="hub-list">${hub.ready.map(item => hubRow(item.path, `${item.fresh ? '<b class="hub-new">New</b> ' : ''}${escape(plural(item.examples, 'example'))}${item.titles.length ? ` · ${escape(item.titles.join(' · '))}` : ''}`, `<button type="button" class="btn btn-sm btn-primary" data-open-preview="${escape(item.path)}">Open</button>`)).join('')}</ul></section>` : '';
    const requested = hub.requested.length ? `<section class="hub-section"><h3>Requested <span>${hub.requested.length}</span></h3><p class="hub-help">Waiting for your agent. They move to Ready when it publishes the next revision.</p><ul class="hub-list">${hub.requested.map(item => hubRow(item.path, `${icon('clock')} Asked ${escape(since(item.at))}${item.revision ? ` from revision ${item.revision}` : ''}`, `<button type="button" class="btn btn-sm btn-ghost" data-open-preview="${escape(item.path)}">Show code</button><button type="button" class="btn btn-sm btn-ghost" data-forget-preview="${escape(item.path)}" aria-label="${escape(`Forget the request for ${item.path}`)}">Forget</button>`)).join('')}</ul><button type="button" class="btn btn-sm btn-ghost hub-inline" data-copy-previews="requested">Copy the request again</button></section>` : '';
    const selected = `<section class="hub-section hub-selected"><h3>Selected <span>${hub.selected.length}</span></h3>${hub.selected.length ? `<ul class="hub-list">${hub.selected.map(path => hubRow(path, '', `<button type="button" class="btn btn-sm btn-ghost" data-remove-preview="${escape(path)}" aria-label="${escape(`Remove ${path} from previews`)}">Remove</button>`)).join('')}</ul>` : `<p class="hub-help">Nothing selected. While reading a template, use <strong>Select for preview</strong> in its header.</p>`}<div class="hub-footer"><button type="button" class="btn btn-sm btn-primary" data-copy-previews="selected" ${hub.selected.length ? '' : 'disabled'}>Copy prompt for ${hub.selected.length ? plural(hub.selected.length, 'template') : 'selected templates'}</button><small>Paste it into your coding agent. The selection then moves to Requested.</small></div></section>`;
    const unavailable = hub.unavailable.length ? `<details class="hub-section hub-unavailable"><summary>Not previewed <span>${hub.unavailable.length}</span></summary><ul class="hub-list">${hub.unavailable.map(item => hubRow(item.path, `${item.status === 'not_visual' ? 'Not visual' : 'Unavailable'}${item.note ? ` · ${escape(item.note)}` : ''}`, '')).join('')}</ul></details>` : '';
    const agentRows = [...live.ready.keys()].map(path => hubRow(path, 'Built by your agent', `<button type="button" class="btn btn-sm" data-show-live-preview="${escape(path)}">View</button>`))
      .concat([...live.pending].map(([path, request]) => hubRow(path, request.status === 'failed' ? `Not built: ${escape(request.error || 'no reason given')}` : request.status === 'requested' ? 'Waiting for your agent' : 'Your agent is building it', request.status === 'failed' ? `<button type="button" class="btn btn-sm" data-request-preview="${escape(path)}">Try again</button>` : '')));
    const byAgent = agentRows.length ? `<section class="hub-section"><h3>Your agent <span>${agentRows.length}</span></h3><ul class="hub-list">${agentRows.join('')}</ul></section>` : '';
    return live.enabled ? `${byAgent}${ready}${unavailable}` : `${byAgent}${ready}${requested}${selected}${unavailable}`;
  }
  function refreshVisualControls() {
    const hub = lifecycle();
    const toggle = $('preview-list-toggle');
    toggle.hidden = !previewsPossible;
    const waiting = hub.selected.length + hub.requested.length;
    toggle.innerHTML = `${icon('scan-text')}<span>Previews</span>${hub.fresh ? `<b class="header-count is-new">${hub.fresh} new</b>` : hub.ready.length + live.ready.size ? `<b class="header-count">${hub.ready.length + live.ready.size}</b>` : ''}${waiting ? `<b class="header-count is-pending" title="Selected or requested">${icon('clock')}${waiting}</b>` : ''}`;
    toggle.setAttribute('aria-label', `Template previews: ${hub.ready.length} ready${hub.fresh ? `, ${hub.fresh} new` : ''}, ${hub.requested.length} requested, ${hub.selected.length} selected`);
    document.querySelectorAll('[data-preview-summary]').forEach(node => { node.innerHTML = previewSummary(hub); });
    document.querySelectorAll('[data-preview-short]').forEach(node => { node.textContent = previewShort(hub); });
    document.querySelectorAll('.preview-toggle[data-request-preview]').forEach(button => {
      const status = previewState(button.dataset.requestPreview);
      button.setAttribute('aria-pressed', status === 'selected');
      button.dataset.status = status;
      button.querySelector('span').textContent = previewLabel(status);
      button.title = previewHint(status, button.dataset.requestPreview);
      button.classList.toggle('is-working', live.enabled && (status === 'requested' || status === 'working'));
    });
    if ($('previews-dialog').open) $('preview-hub').innerHTML = renderPreviewHub();
  }
  // The same state in as few words as fit on a button; empty when there is nothing to say.
  function previewShort(hub) {
    const building = [...live.pending.values()].filter(request => request.status === 'requested' || request.status === 'working').length;
    const ready = hub.ready.length + live.ready.size;
    return [ready && `${ready} ready${hub.fresh ? ` (${hub.fresh} new)` : ''}`, building && `${building} building`, hub.requested.length && `${hub.requested.length} requested`, hub.selected.length && `${hub.selected.length} selected`].filter(Boolean).join(' · ');
  }
  function previewSummary(hub) {
    const parts = previewShort(hub).split(' · ').filter(Boolean);
    return parts.length ? escape(parts.join(' · ')) : (live.enabled ? 'None yet. Use Preview this template in a template\'s header.' : 'None yet. Select templates while reading the diff.');
  }
  // --- The preview stage ---------------------------------------------------------------------------------
  // One place for every preview: a rail of the templates in this review and how each stands, and a canvas
  // that shows the chosen one scaled to fit, at the width of a phone, tablet or desktop.
  const stageEl = $('stage');
  // desktop by default; Fit uses the whole canvas. The preview cannot know its parent, so the reader
  // chooses: a parent that wraps the content, or one it fits, filling the height (a pane, a page).
  const stageState = {path: null, width: 1280, height: 'content', example: 0};
  const SCREEN_HEIGHTS = {390: 844, 768: 1024, 1280: 800};
  // Fitting fills both ways. The screen's height passes down: body, the preview wrapper (which otherwise
  // forces its root to its content height), then the component's root, whose growing part can use it. Its
  // width does too: the wrapper's and the root's own width limits give way; widths inside stay.
  const FILL_CSS = 'html.dcr-fill,html.dcr-fill body{height:100%}html.dcr-fill body{margin:0;box-sizing:border-box;display:flex;flex-direction:column}html.dcr-fill body>*{flex:none}html.dcr-fill body>:last-child,html.dcr-fill .review-preview-root>:last-child{flex:1 1 auto!important;height:auto!important;min-height:0!important;max-height:none!important}html.dcr-fill .review-preview-root{display:flex;flex-direction:column;width:auto!important;max-width:none!important}html.dcr-fill .review-preview-root>*{width:auto!important;max-width:none!important;align-self:stretch!important}';
  const stageTemplates = () => {
    const paths = new Set([...previewsByPath.keys(), ...notVisualByPath.keys(), ...live.pending.keys()]);
    snapshot.files.filter(previewEligible).forEach(file => paths.add(file.path));
    // One row per component: its template stands for its class.
    return [...paths].map(stagePath).filter((path, index, all) => all.indexOf(path) === index).map(path => filesByPath.get(path)).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
  };
  const stagePath = path => /_component\.rb$/.test(path) && componentSibling(path) ? componentSibling(path) : path;
  const stageStatus = path => previewsByPath.get(path)?.some(preview => preview.status === 'rendered') ? 'ready'
    : notVisualByPath.has(path) ? 'novisual' : live.enabled && pendingPreview(path)?.status || (visualState.previews.includes(path) ? 'selected' : visualState.requested.some(entry => entry.path === path) ? 'requested' : 'none');
  const stageStatusText = {ready: 'Ready', requested: 'Requested', working: 'Your agent is building it', failed: 'Could not be built', selected: 'Selected', none: 'Not previewed', novisual: 'Nothing to see'};
  function renderStageRail() {
    const rail = $('stage-rail');
    const rows = stageTemplates().map(file => {
      const status = stageStatus(file.path);
      const slash = file.path.lastIndexOf('/');
      // A component whose class changed but not its template is still one thing to preview: name it so.
      const classOnly = /_component\.rb$/.test(file.path) && !componentSibling(file.path);
      const name = classOnly ? file.path.slice(slash + 1).replace(/\.rb$/, '') : file.path.slice(slash + 1);
      return `<button type="button" class="stage-item" data-stage-path="${escape(file.path)}" aria-current="${file.path === stageState.path}" title="${escape(classOnly ? `${file.path}: the component's class changed, its template did not` : file.path)}"><span class="stage-dot is-${status}" aria-hidden="true"></span><span class="stage-item-text"><strong>${escape(name)}</strong><small>${escape(file.path.slice(0, slash))}</small></span><em>${classOnly ? 'Class changed · ' : ''}${stageStatusText[status]}</em></button>`;
    });
    rail.innerHTML = rows.length ? rows.join('') : '<p class="stage-empty-rail">No templates changed in this review.</p>';
  }
  function renderStageCanvas() {
    const path = stageState.path;
    const file = filesByPath.get(path);
    const view = $('stage-view');
    $('stage-examples').innerHTML = '';
    $('stage-caption').textContent = '';
    stageEl.querySelectorAll('[data-stage-width]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stageWidth) === String(stageState.width)));
    stageEl.querySelectorAll('[data-stage-height]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stageHeight === stageState.height)));
    $('stage-title').textContent = file ? file.path.slice(file.path.lastIndexOf('/') + 1) : 'Previews';
    $('stage-sub').textContent = file ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    stageEl.querySelector('[data-stage-code]').hidden = !file;
    const rebuild = stageEl.querySelector('[data-stage-rebuild]');
    rebuild.hidden = true;
    if (!file) { view.innerHTML = '<div class="stage-message"><p>Choose a template on the left.</p></div>'; return; }
    const list = (previewsByPath.get(path) || []).filter(preview => preview.status === 'rendered');
    const status = stageStatus(path);
    if (list.length) {
      stageState.example = Math.min(stageState.example, list.length - 1);
      const current = list[stageState.example];
      if (list.length > 1) $('stage-examples').innerHTML = list.map((preview, index) => `<button type="button" class="stage-chip" data-stage-example="${index}" aria-pressed="${index === stageState.example}">${escape(preview.title || `Example ${index + 1}`)}</button>`).join('');
      view.innerHTML = `<div class="stage-device"><iframe sandbox="allow-same-origin" title="${escape(`Preview: ${current.title || file.path}`)}" data-stage-frame></iframe></div>`;
      const frame = view.querySelector('iframe');
      frame.addEventListener('load', fitStage);
      frame.srcdoc = current.html;
      const byAgent = current.source === 'agent';
      $('stage-caption').textContent = `${current.title ? `${current.title}. ` : ''}${byAgent ? 'Drawn by your agent from this template and the pieces it renders: an approximation.' : 'Rendered by the app from the reviewed code with example data.'} Scripts are off; icons and images marked as stand-ins are mocked.`;
      if (byAgent && live.enabled) { rebuild.hidden = false; rebuild.innerHTML = `${icon('refresh-cw')}Rebuild`; }
      return;
    }
    if (status === 'requested' || status === 'working') {
      const waiting = status === 'requested';
      view.innerHTML = `<div class="stage-message" role="status"><div class="skeleton-frame" aria-hidden="true"><span class="skeleton-line w40"></span><span class="skeleton-block"></span><span class="skeleton-line w80"></span><span class="skeleton-line w60"></span><span class="skeleton-block short"></span></div><p><strong>${waiting ? 'Waiting for your agent to start' : 'Your agent is building this preview'}</strong><br>It reads the template and the pieces it renders, then draws an approximation. You can close this and keep reviewing; it appears here when it is ready.</p></div>`;
      return;
    }
    const failed = status === 'failed' ? pendingPreview(path) : null;
    const reason = notVisualByPath.get(path)?.map(preview => preview.note).filter(Boolean).join(' ');
    const action = status === 'novisual' ? '' : `<button type="button" class="act act-primary" data-request-preview="${escape(path)}">${icon('scan-text')}${failed ? 'Try again' : live.enabled ? 'Preview this template' : visualState.previews.includes(path) ? 'Selected for preview' : 'Select for preview'}</button>`;
    view.innerHTML = `<div class="stage-message"><p><strong>${failed ? 'Your agent could not build this preview' : status === 'novisual' ? 'Nothing to preview here' : 'No preview yet'}</strong><br>${escape(failed ? failed.error || 'It did not say why.' : status === 'novisual' ? reason || 'This template renders nothing visual.' : live.enabled ? 'Ask your agent to draw this template, including the pieces it renders. You can keep reviewing while it works.' : 'Select it, then copy one request for every template you want.')}</p>${action}</div>`;
  }
  function renderStageFoot() {
    const foot = $('stage-foot');
    foot.hidden = live.enabled;
    if (live.enabled) return;
    const hub = lifecycle();
    foot.innerHTML = `<span>${hub.selected.length ? `${plural(hub.selected.length, 'template')} selected` : 'Nothing selected yet'}</span><button type="button" class="act act-primary" data-copy-previews="selected" ${hub.selected.length ? '' : 'disabled'}>${icon('copy')}Copy request for ${hub.selected.length || 'selected'}</button>`;
  }
  function renderStage() { renderStageRail(); renderStageCanvas(); renderStageFoot(); }
  // The preview is drawn at the chosen width, then scaled down to fit the canvas instead of scrolling sideways.
  function fitStage() {
    const view = $('stage-view');
    const frame = view.querySelector('iframe');
    if (!frame) return;
    // On a tablet or phone the width choice is hidden: the preview uses the stage as it is.
    const width = matchMedia('(max-width: 900px)').matches ? 'fit' : stageState.width;
    const room = Math.max(280, view.clientWidth);
    const deviceWidth = Number(width === 'fit' ? room : width);
    frame.style.width = `${deviceWidth}px`;
    const doc = frame.contentDocument;
    const fill = stageState.height === 'fit';
    if (doc?.head) {
      if (!doc.getElementById('dcr-fill')) doc.head.append(Object.assign(doc.createElement('style'), {id: 'dcr-fill', textContent: FILL_CSS}));
      doc.documentElement.classList.toggle('dcr-fill', fill);
    }
    // Content wraps both ways. Laid out at the device width, the preview's own width is where its narrower
    // pieces end (a full-width block is only the page); when everything spans the page, the device width stays.
    let wanted = deviceWidth;
    const root = doc?.querySelector('.review-preview-root');
    if (!fill && root) {
      const full = root.getBoundingClientRect().width - 1;
      const ends = [...root.querySelectorAll('*')].map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.width < full).map(box => box.right);
      if (ends.length) {
        wanted = Math.min(deviceWidth, Math.max(120, Math.ceil(Math.max(...ends) + parseFloat(getComputedStyle(doc.body).paddingRight))));
        frame.style.width = `${wanted}px`;
      }
    }
    const scale = Math.min(1, room / wanted);
    // Fitting, the frame is one screen tall first, so the preview's 100% means that height.
    // At full width it fills the stage's own height: the canvas minus its padding, caption and example chips (the view
    // itself grows with what it shows, so it cannot be the measure).
    const canvas = view.parentElement;
    const padding = parseFloat(getComputedStyle(canvas).paddingTop) + parseFloat(getComputedStyle(canvas).paddingBottom);
    const stageHeight = canvas.clientHeight - padding - $('stage-caption').offsetHeight - $('stage-examples').offsetHeight - 16;
    const screen = SCREEN_HEIGHTS[width] || Math.max(240, Math.floor(stageHeight));
    // A document is never shorter than its frame, so measure the content in a frame that does not hold it open.
    frame.style.height = fill ? `${screen}px` : '1px';
    const content = doc ? Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0)) : 600;
    const height = fill ? Math.max(screen, content) : Math.max(40, content);
    frame.style.height = `${height}px`;
    frame.style.transform = `scale(${scale})`;
    const device = frame.parentElement;
    device.style.width = `${wanted * scale}px`;
    device.style.height = `${height * scale}px`;
  }
  function openStage(path = null) {
    const templates = stageTemplates();
    const ready = templates.find(file => stageStatus(file.path) === 'ready');
    path = path && stagePath(path);
    stageState.path = path && filesByPath.has(path) ? path : stageState.path && filesByPath.has(stageState.path) ? stageState.path : (ready || templates[0])?.path ?? null;
    stageState.example = 0;
    // Looking at a preview clears its New mark.
    if (stageState.path && previewsByPath.get(stageState.path)?.some(preview => preview.status === 'rendered')) {
      visualState.requested = visualState.requested.filter(entry => entry.path !== stageState.path);
      persistVisuals(); refreshVisualControls();
    }
    renderStage();
    if (!stageEl.open) stageEl.showModal();
    requestAnimationFrame(fitStage);
  }
  stageEl.addEventListener('click', event => {
    if (event.target === stageEl || event.target.closest('[data-stage-close]')) { stageEl.close(); return; }
    const item = event.target.closest('[data-stage-path]');
    if (item) { stageState.path = item.dataset.stagePath; stageState.example = 0; renderStage(); requestAnimationFrame(fitStage); return; }
    const width = event.target.closest('[data-stage-width]');
    if (width) { stageState.width = width.dataset.stageWidth; stageEl.querySelectorAll('[data-stage-width]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stageWidth) === String(stageState.width))); fitStage(); return; }
    const height = event.target.closest('[data-stage-height]');
    if (height) { stageState.height = height.dataset.stageHeight; stageEl.querySelectorAll('[data-stage-height]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stageHeight === stageState.height))); fitStage(); return; }
    const example = event.target.closest('[data-stage-example]');
    if (example) { stageState.example = Number(example.dataset.stageExample); renderStageCanvas(); return; }
    if (event.target.closest('[data-stage-rebuild]')) { document.dispatchEvent(new CustomEvent('review-preview-request', {detail: {path: stageState.path}})); return; }
    if (event.target.closest('[data-stage-code]')) { const path = stageState.path; stageEl.close(); const file = filesByPath.get(path); const layer = layers.find(candidate => candidate.items.some(entry => entry.file === file?.id)); if (layer) navigateFile(layer, file.id); }
  });
  window.addEventListener('resize', () => { if (stageEl.open) fitStage(); });
  const stageIcons = () => {
    const put = (selector, html) => { const node = stageEl.querySelector(selector); if (node) node.innerHTML = html; };
    put('[data-stage-width="390"]', icon('smartphone'));
    put('[data-stage-width="768"]', icon('tablet'));
    put('[data-stage-width="1280"]', icon('monitor'));
    put('[data-stage-close]', icon('x'));
  };
  stageIcons();
  function setLivePreviews({enabled, ready = [], pending = {}}) {
    live.enabled = !!enabled;
    live.ready = new Map(ready.map(item => [item.path, {id: `live:${item.path}`, files: [item.path], status: 'rendered', title: item.title || 'Built by your agent', source: 'agent', html: item.html, mocks: item.mocks || null}]));
    live.pending = new Map(Object.entries(pending));
    rebuildPreviews();
    const scroll = $('content').scrollTop;
    render(); $('content').scrollTop = scroll;
    if (stageEl.open) { renderStage(); requestAnimationFrame(fitStage); }
  }
  // Open the stage on a template's preview.
  function showPreview(path) { openStage(path); }
  window.ReviewPreviews = {set: setLivePreviews, show: showPreview};
  // A served review in progress receives the agent's comments as it writes them (live/live.js).
  function addLiveComments(list) {
    const known = new Set(generatedComments.map(comment => comment.id));
    const added = list.filter(comment => !known.has(comment.id) && ReviewTools.anchor(snapshot, comment)).map(comment => ({...comment}));
    if (!added.length) return [];
    generatedComments.push(...added);
    refreshComments();
    const scroll = $('content').scrollTop;
    render(); $('content').scrollTop = scroll;
    return added;
  }
  window.ReviewLive = {addComments: addLiveComments, inProgress};
  // Until the review is finished, QA and template previews wait: they build on its comments and
  // would compete with it for the agent. The controls stay visible, greyed, and say why.
  const LOCKED = '[data-open-previews], [data-copy-qa], [data-request-preview], [data-preview-toggle], [data-try="qa"], [data-try-preview], [data-try-all], [data-start-qa], [data-empty-qa], [data-view="previews"], #qa-connect';
  if (inProgress) {
    document.body.classList.add('review-in-progress');
    const lock = () => document.querySelectorAll(LOCKED).forEach(node => {
      if (node.getAttribute('aria-disabled') === 'true') return;
      node.setAttribute('aria-disabled', 'true');
      node.title = 'Available once your agent finishes the review';
    });
    new MutationObserver(lock).observe(document.body, {childList: true, subtree: true});
    lock();
    document.addEventListener('click', event => {
      if (!event.target.closest?.(LOCKED)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toast('Template previews and QA open once your agent finishes the review.');
    }, true);
  }
  function openPreviewHub() {
    $('preview-hub').innerHTML = renderPreviewHub();
    $('previews-dialog').showModal();
    // Land on the most useful action rather than the close button.
    $('preview-hub').querySelector('[data-open-preview], [data-copy-previews]:not(:disabled)')?.focus();
  }
  // Optional evidence requests stay one quiet strip; the review itself leads the page.
  function renderVisualOptions() {
    // One quiet line. Copying a prompt only prepares text; nothing runs until it is pasted.
    const qa = `<button type="button" class="btn btn-sm btn-ghost visual-qa-option" data-copy-qa title="Copies a prompt that asks your agent to record the changed flows. Nothing runs until you paste it.">${icon('video')}<span>Copy video QA prompt</span></button>`;
    const previews = previewsPossible ? `<button type="button" class="btn btn-sm btn-ghost" data-open-previews>${icon('scan-text')}<span>Template previews</span><small data-preview-short>${escape(previewShort(lifecycle()))}</small></button>` : '';
    return `<section class="evidence-strip" aria-label="Visual evidence"><span>Visual evidence</span>${qa}${previews}</section>`;
  }
  const previewSources = {lookbook: 'Lookbook example', example: 'Example data for this review', agent: 'Built by your agent, approximate'};
  const wideScreen = () => matchMedia('(min-width: 1200px)').matches;
  // The side pane takes width from the code, so it opens only when asked for (and never in
  // Focus). The choice is remembered.
  const previewPaneOpen = () => wideScreen() && state.previewPane === 'open' && !document.body.classList.contains('zen');

  // What the button says. Served, it asks your agent and tells you how that is going; offline, it only
  // selects the template for a request you copy yourself.
  const previewLabel = status => live.enabled
    ? {requested: 'Preview requested', working: 'Building preview…', failed: 'Preview failed. Try again'}[status] || 'Preview this template'
    : {selected: 'Selected for preview', requested: 'Preview requested'}[status] || 'Select for preview';
  const previewHint = (status, path) => live.enabled
    ? ({requested: 'Sent to your agent. You can keep reviewing.', working: 'Your agent is building this preview. You can keep reviewing.', failed: pendingPreview(path)?.error || 'Your agent could not build it.'}[status] || 'Ask your agent to build a preview of this template, including the pieces it renders')
    : 'Select this template for your next preview request';
  function previewToggle(file) {
    const list = previewsByPath.get(file.path);
    if (!list?.length) {
      if (!previewEligible(file) || notVisualByPath.has(file.path)) return '';
      const status = previewState(file.path);
      const busy = status === 'requested' || status === 'working';
      return `<button type="button" class="preview-toggle is-request${busy && live.enabled ? ' is-working' : ''}" data-request-preview="${escape(file.path)}" data-status="${status}" aria-pressed="${status === 'selected'}" ${busy && live.enabled ? 'aria-busy="true"' : ''} title="${escape(previewHint(status, file.path))}">${icon(status === 'requested' ? 'clock' : 'scan-text')}<span>${previewLabel(status)}</span></button>`;
    }
    return `<button type="button" class="preview-toggle" data-preview-toggle data-preview-path="${escape(file.path)}" title="See how this template renders">${icon('scan-text')}<span>Preview</span><span class="preview-count">${list.length}</span>${previewState(file.path) === 'fresh' ? '<b class="hub-new">New</b>' : ''}</button>`;
  }

  function previewEligible(file) {
    return ReviewTools.previewEligible(file);
  }

  function notVisualNote(file) {
    const reasons = (notVisualByPath.get(file.path) || []).map(preview => preview.note).filter(Boolean);
    return reasons.length && !previewsByPath.has(file.path) ? `<span class="preview-none">No preview · ${escape(reasons.join(' '))}</span>` : '';
  }

  // Icons and photos swapped in while building previews are never the app's assets.
  function standInNote(mocks) {
    if (!mocks) return '';
    const parts = [];
    if (mocks.icons || mocks.placeholders) parts.push(`icons are ${mocks.placeholders ? 'Lucide stand-ins or placeholders' : 'Lucide stand-ins'} for the app's icon font`);
    if (mocks.images) parts.push(`images are stand-in photos picked for this preview${mocks.credits?.length ? ` (${mocks.credits.join('; ')})` : ''}`);
    if (mocks.image_placeholders) parts.push('some images are placeholders');
    return parts.length ? `<small class="preview-stand-ins">Not final: ${escape(parts.join('; '))}.</small>` : '';
  }

  // While your agent builds a preview: what is happening, and a skeleton where it will appear.
  function livePreviewPlaceholder(file, placement) {
    const request = live.enabled && live.pending.get(file.path);
    if (!request) return '';
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const attributes = `class="preview-panel ${placement} is-generating" ${placement === 'side' ? 'id="preview-pane"' : ''} data-preview-panel data-open-state="true" open`;
    if (request.status === 'failed') {
      return `<details ${attributes}><summary>${icon('scan-text')}<span class="preview-heading">Preview</span><span class="badge warning">Not built</span></summary><div class="preview-body"><div class="preview-skeleton" role="status"><p><strong>Your agent could not build a preview of ${escape(name)}</strong><br><small>${escape(request.error || 'It did not say why.')}</small></p><button type="button" class="btn btn-sm btn-primary" data-request-preview="${escape(file.path)}">Try again</button></div></div></details>`;
    }
    const waiting = request.status === 'requested';
    return `<details ${attributes}><summary>${icon('scan-text')}<span class="preview-heading">Preview</span><span class="badge neutral">${waiting ? 'Requested' : 'Building'}</span></summary><div class="preview-body"><div class="preview-skeleton" role="status" aria-live="polite"><p><strong>${waiting ? 'Waiting for your agent to start' : 'Your agent is building a preview of'} ${escape(name)}</strong><br><small>It reads the template and the pieces it renders, then draws an approximation. You can keep reviewing; it appears here when it is ready.</small></p><div class="skeleton-frame" aria-hidden="true"><span class="skeleton-line w40"></span><span class="skeleton-block"></span><span class="skeleton-line w80"></span><span class="skeleton-line w60"></span><span class="skeleton-block short"></span></div></div></div></details>`;
  }

  function previewPanel(file, placement) {
    const list = previewsByPath.get(file.path);
    if (!list?.length) return livePreviewPlaceholder(file, placement);
    const rendered = list.filter(preview => preview.status === 'rendered').length;
    const open = placement === 'side' && previewPaneOpen();
    const examples = list.map(preview => `<figure class="preview-example"><figcaption><strong>${escape(preview.title || 'Preview')}</strong><span class="badge ${preview.source === 'lookbook' ? 'success' : 'neutral'}">${previewSources[preview.source] || previewSources.example}</span>${preview.mocks ? '<span class="badge warning">Stand-in assets</span>' : ''}${preview.note && preview.status === 'rendered' ? `<small>${escape(preview.note)}</small>` : ''}${standInNote(preview.mocks)}</figcaption>${preview.status === 'rendered' ? `<div class="preview-frame"><iframe sandbox="allow-same-origin" loading="lazy" title="${escape(`Preview: ${preview.title || file.path}`)}" data-preview-id="${escape(preview.id)}"${preview.width ? ` style="min-width:${Number(preview.width) + 32}px"` : ''}></iframe></div>` : `<p class="preview-unavailable">Preview unavailable. ${escape(preview.note || '')}</p>`}</figure>`).join('');
    const byAgent = list.every(preview => preview.source === 'agent');
    return `<details class="preview-panel ${placement}${byAgent ? ' is-agent' : ''}" ${placement === 'side' ? 'id="preview-pane"' : ''} data-preview-panel data-open-state="${open}" ${open ? 'open' : ''}><summary>${icon('scan-text')}<span class="preview-heading">Preview</span><span class="badge neutral">${rendered === list.length ? `${list.length} example${list.length === 1 ? '' : 's'}` : `${rendered} of ${list.length} rendered`}</span></summary><div class="preview-body"><p class="preview-caveat">${byAgent ? 'Drawn by your agent from this template and the pieces it renders, with made-up example data. An approximation: it can differ from the app. ' : 'Rendered by the app from the reviewed code with example data. '}Static: scripts are off, and icons or images marked as stand-ins are mocked for this preview.</p>${examples}</div></details>`;
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

  // What a reader actually sees in a preview: visible text, icons and images in order,
  // plus the rendered height. Hidden markup (a closed flyout) and widths do not count.
  function visualFingerprint(frame) {
    const doc = frame.contentDocument;
    const root = doc?.querySelector('.review-preview-root');
    if (!root) return null;
    const parts = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!element.getClientRects().length || doc.defaultView.getComputedStyle(element).visibility === 'hidden') continue;
      if (node.nodeType === Node.TEXT_NODE) { const text = node.textContent.trim(); if (text) parts.push(`t:${text}`); }
      else if (node.matches('svg, img')) parts.push(node.tagName.toLowerCase());
    }
    parts.push(`h:${Math.round(root.getBoundingClientRect().height / 4)}`);
    return parts.join('|');
  }

  // Examples of one template that look the same (desktop and mobile variants, say) are
  // folded under the first one instead of repeating an identical frame.
  function foldVisualTwins(panel) {
    const figures = [...panel.querySelectorAll('.preview-example')].filter(figure => figure.querySelector('iframe[data-preview-id]'));
    const prints = figures.map(figure => figure.querySelector('iframe').dataset.fingerprint);
    if (prints.some(print => !print)) return;
    figures.forEach((figure, index) => {
      const first = prints.indexOf(prints[index]);
      if (first === index || figure.classList.contains('is-visual-twin')) return;
      figure.classList.add('is-visual-twin');
      figure.hidden = true;
      const title = figure.querySelector('figcaption strong')?.textContent || 'Another example';
      const note = document.createElement('small');
      note.className = 'preview-twin-note';
      note.innerHTML = `${escape(`“${title}” looks the same, so it is folded here.`)} <button type="button" class="btn btn-xs btn-ghost">Show it</button>`;
      note.querySelector('button').addEventListener('click', () => { figure.hidden = false; note.remove(); fitPreview(figure.querySelector('iframe')); });
      figures[first].querySelector('figcaption').append(note);
    });
  }

  function hydratePreviews(root) {
    root.querySelectorAll('iframe[data-preview-id]').forEach(frame => {
      const preview = previewById.get(frame.dataset.previewId);
      if (!preview || frame.hasAttribute('srcdoc')) return;
      frame.addEventListener('load', () => measurePreview(frame));
      frame.srcdoc = preview.html;
    });
  }

  // Frames inside a closed pane have no layout; measure them once they are shown.
  function measurePreview(frame) {
    if (!frame.getClientRects().length) return;
    fitPreview(frame);
    frame.dataset.fingerprint = visualFingerprint(frame) || '';
    const panel = frame.closest('.preview-panel');
    if (panel) foldVisualTwins(panel);
  }

  function renderFile(item) {
    const file = files.get(item.file);
    const hunks = file.hunks.filter(hunk => Object.hasOwn(item.summaries || {}, hunk.id));
    const changes = hunks.flatMap(hunk => hunk.rows.unified);
    const added = changes.filter(line => line.kind === 'add').length;
    const removed = changes.filter(line => line.kind === 'del').length;
    const table = renderDiffTable(file, hunks, item.summaries);
    // The range heading already says it when a file has one summary for its only change.
    const repeated = hunks.length && hunks.every(hunk => (item.summaries || {})[hunk.id] === item.summary);
    const summary = [!repeated && item.summary, file.note].filter(Boolean).map(escape).join(' · ');
    // A rendered preview is its own disclosure; only the request control sits in the card.
    const request = previewToggle(file);
    return `<details class="file-card ${fileViewed(file) ? 'is-viewed' : ''}" data-file="${file.id}" ${fileOpen(file) ? 'open' : ''}><summary><span class="file-icon" aria-hidden="true">&lt;/&gt;</span><span class="filename">${escape(file.path)}</span><span class="badge success">+${added}</span><span class="badge blocking">−${removed}</span><label class="file-viewed"><input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-file-viewed="${file.id}" aria-label="${escape(`Mark ${file.path} as viewed`)}" ${fileViewed(file) ? 'checked' : ''}> Viewed</label></summary>${summary || request || notVisualNote(file) ? `<div class="file-summary">${summary ? `<span>${summary}</span>` : ''}${request}${notVisualNote(file)}</div>` : ''}${hunks.length ? table : `<div class="file-summary"><pre>${escape(file.patch || 'No text diff available.')}</pre></div>`}</details>`;
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
  // Where a comment can go. Ask agent stays in this review; GitHub leaves it, so it says so (↗) and
  // copies the comment on the way, ready to paste on the lines it opens. Without a GitHub PR the slot
  // copies the comment for pasting anywhere. Everything else waits behind the ⋯ menu.
  function githubAction(comment, data, size = 'sm') {
    const link = ReviewTools.githubLink(snapshot, review, comment);
    if (!link) return `<button class="btn btn-${size} btn-soft" ${data.copy}>${icon('copy')} Copy for comment</button>`;
    return `<a class="btn btn-${size} gh-act" href="${escape(link)}" target="_blank" rel="noopener noreferrer" ${data.github} title="Copies the comment and opens ${comment.general ? 'the pull request' : 'these lines'} on GitHub, ready to paste">Comment on GitHub ${icon('arrow-up-right')}</a>`;
  }
  const menuItem = (attrs, label, symbol = '') => `<button type="button" class="more-item" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
  const moreMenu = (items, size = 'sm') => `<details class="more-menu"><summary class="btn btn-${size} btn-ghost more-toggle" aria-label="More actions" title="More actions">${icon('ellipsis')}</summary><div class="more-list">${items.join('')}</div></details>`;
  // A comment's actions: GitHub (when it is a comment for the PR) and the menu.
  function commentActions(comment, size = 'sm') {
    const id = escape(comment.id);
    const found = ReviewTools.anchor(snapshot, comment);
    const forAgent = comment.audience === 'agent';
    const github = !forAgent && ReviewTools.githubLink(snapshot, review, comment);
    const items = [
      github ? menuItem(`data-copy-comment="${id}"`, 'Copy for comment', 'copy') : '',
      menuItem(`data-copy="${id}"`, 'Copy for LLMs', 'copy'),
      found && !found.fullFile ? menuItem(`data-comment="${id}"`, 'Open in diff', 'arrow-right') : '',
      comment.personal ? menuItem(`data-edit="${id}"`, 'Edit', 'pencil') + menuItem(`data-delete="${id}"`, 'Delete', 'trash-2') : ''
    ];
    return `${forAgent ? '' : githubAction(comment, {copy: `data-copy-comment="${id}"`, github: `data-github="${id}"`}, size)}${moreMenu(items, size)}`;
  }
  function threadBadges(comment) {
    if (comment.audience === 'agent') return `<span class="thread-type type-purple" title="A question for your agent. It stays in this review."><span class="thread-type-icon">${icon('sparkles')}</span>For your agent</span>${comment.resolved ? `<span class="thread-resolved">${icon('check')} Resolved locally</span>` : ''}`;
    const [symbol, title, hint, tone] = commentTypes[comment.label] || commentTypes.note;
    return `<span class="thread-type type-${tone}" title="${hint}"><span class="thread-type-icon">${icon(symbol)}</span>${title}</span><span class="thread-priority ${comment.decoration === 'blocking' ? 'is-blocking' : 'is-optional'}">${comment.decoration === 'blocking' ? `${icon('circle-alert')} Blocking` : 'Non-blocking'}</span>${comment.severity ? `<span class="thread-severity">${escape(comment.severity)}</span>` : ''}${comment.resolved ? `<span class="thread-resolved">${icon('check')} Resolved locally</span>` : ''}${comment.personal ? '<span class="thread-author">Your comment</span>' : ''}`;
  }
  function commentCard(comment) {
    const found = ReviewTools.anchor(snapshot, comment);
    if (!found && !comment.general) return '';
    const id = escape(comment.id);
    const range = found ? `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}` : '';
    return `<article class="review-thread ${comment.resolved ? 'is-resolved' : ''}" data-thread-id="${id}"><div class="thread-file"><span class="thread-file-path">${escape(found?.file.path || 'General comment')}</span><span class="thread-range">${found ? range : ''}</span></div><details class="thread-details" ${comment.resolved ? '' : 'open'}><summary class="thread-summary" aria-label="Comment: ${escape(comment.subject)}"><span class="thread-badges">${threadBadges(comment)}</span><strong>${escape(comment.subject)}</strong><span class="thread-chevron">${icon('chevron-down')}</span></summary><div class="thread-body">${comment.discussion ? `<div class="comment-discussion">${ReviewTools.markdown(comment.discussion)}</div>` : ''}${commentEvidence(comment)}</div>${found ? found.fullFile ? `<button class="thread-source btn btn-sm btn-ghost" type="button" data-comment="${id}">View in file · ${found.lines.length} line${found.lines.length === 1 ? '' : 's'} ${icon('arrow-right')}</button>` : `<button class="thread-source btn btn-sm btn-ghost" type="button" data-open-code="${id}" aria-haspopup="dialog" aria-label="${escape(`View code for ${found.file.path}, ${range}: ${comment.subject}`)}">View code · ${found.lines.length} line${found.lines.length === 1 ? '' : 's'} ${icon('arrow-right')}</button>` : ''}</details><div class="thread-footer"><div class="comment-actions">${commentActions(comment)}</div><button class="btn btn-sm ${comment.resolved ? 'btn-ghost' : 'btn-soft'}" data-resolve="${id}">${comment.resolved ? `${icon('rotate-ccw')} Reopen` : `${icon('check')} Resolve`}</button></div></article>`;
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
    return `<article class="review-comment"><span class="badge blocking">${escape(finding.severity)}</span><p class="comment-location">${escape(hunkFiles.get(finding.hunk).path)}</p><h3>${escape(finding.title)}</h3><div class="comment-discussion">${ReviewTools.markdown(finding.body)}</div><div class="comment-actions">${githubAction(findingComment(finding), {copy: `data-post-finding="${index}"`, github: `data-github-finding="${index}"`})}<button class="btn btn-sm btn-ghost" data-hunk="${escape(finding.hunk)}">See changed code →</button>${moreMenu([ReviewTools.githubLink(snapshot, review, findingComment(finding)) ? menuItem(`data-post-finding="${index}"`, 'Copy for comment', 'copy') : '', menuItem(`data-copy-finding="${index}"`, 'Copy for LLMs', 'copy')])}</div></article>`;
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
    const image = posterUri ? `<img loading="lazy" alt="" src="${escape(posterUri)}"${motion && !video ? ` data-poster-source="${escape(posterUri)}" data-motion-source="${escape(motion)}"` : ''}>` : video ? `<video class="qa-preview-frame" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true" src="${escape(motion)}#t=0.5"></video>` : motion ? `<span class="qa-preview-placeholder">GIF preview</span><img alt="" data-poster-source="" data-motion-source="${escape(motion)}">` : '<span class="qa-preview-placeholder">No image</span>';
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
    const empty = !generated.length && !feedback.findings.length && !pending && !unlinkedFlows().some(({flow}) => flow.result === 'failed') ? `<p class="review-empty">${inProgress ? 'No comments yet. They appear here as your agent writes them.' : 'No issues found in this review.'}</p>` : '';
    const progressBox = inProgress ? `<div class="review-progress" role="status"><span class="review-progress-dot" aria-hidden="true"></span><div><h3>Your review is in progress</h3><p>Start reading now. Your agent's comments appear here and beside the code as it writes them, with a notice when one arrives, even on a file you already read. Explanations, test results and the finished walkthrough follow. Template previews and QA open once it is done.</p><p class="review-progress-count">${generated.length ? `${generated.length} comment${generated.length === 1 ? '' : 's'} so far` : 'No comments yet'}</p></div><button type="button" class="btn btn-sm btn-primary" data-start-reading>Start reading ${icon('arrow-right')}</button></div>` : '';
    return `<div class="overview-reading"><header class="overview-intro"><p class="eyebrow">Review overview</p><h1>${escape(review.title)}</h1><h2 class="what-changed-title">What changed</h2><p class="overview-scope">${escape(ReviewTools.comparisonText(snapshot, review))}</p><p class="lead">${escape(review.summary)}</p>${revision && revision.revision > 1 ? `<p class="overview-update"><strong>Review revision ${revision.revision}</strong> · ${escape(revision.summary)}</p>` : ''}${historyLinks}${progressBox}</header>${inProgress ? '' : renderVisualOptions()}${pending ? `<p class="overview-notice">${pending} previous finding${pending === 1 ? '' : 's'} still need checking. See Review details.</p>` : ''}${qa && !['complete','skipped'].includes(qa.status) ? `<p class="overview-notice">${escape(qa.summary)}</p>` : ''}<section class="overview-comments" aria-label="Review comments"><h2>Review comments</h2>${empty}${feedback.findings.map(finding => findingCard(finding, review.findings.indexOf(finding))).join('')}${generated.map(commentCard).join('')}${unlinkedFlows().filter(({flow}) => flow.result === 'failed').map(({flow,index}) => qaFlow(flow,index)).join('')}</section>${renderOtherChecks()}${renderMyReview()}</div>`;
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
    const groupNumber = review.groups.indexOf(entry.layer.group) + 1;
    const stepTitle = entry.layer.title === entry.layer.group.title ? '' : `<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-step">${escape(entry.layer.title)}</span>`;
    return `<section class="focus-reader"><header class="focus-file-header"><div class="focus-meta"><span class="focus-group" title="${escape(`Group ${groupNumber} of ${review.groups.length}: ${entry.layer.group.title}`)}"><span class="crumb-number">${groupNumber}/${review.groups.length}</span>${escape(titleWithoutNumber(entry.layer.group.title))}${stepTitle}</span><div class="focus-file-actions" role="group" aria-label="Changed sections"><button class="icon-button" data-change-step="-1" disabled aria-label="Previous changed section" title="Previous changed section">${icon('chevron-left')}</button><span id="change-position">${file.hunks.length} changes</span><button class="icon-button" data-change-step="1" ${file.hunks.length ? '' : 'disabled'} aria-label="Next changed section" title="Next changed section">${icon('chevron-right')}</button></div></div><div class="focus-identity"><div class="current-file"><code>${escape(file.path)}</code><button class="icon-button copy-file-path" data-copy-file title="Copy the full relative file path" aria-label="Copy file path">${icon('copy')}</button></div>${componentLinks}${previewToggle(file)}${notVisualNote(file)}<details class="file-about"><summary>${icon('info')}<span>Why this file</span></summary><p>${escape(entry.layer.summary || entry.layer.group.summary)}</p>${items.map(item => item.summary ? `<p>${escape(item.summary)}</p>` : '').join('')}</details><div class="focus-progress-actions"><label class="file-viewed"><input type="checkbox" class="checkbox checkbox-sm checkbox-primary" data-file-viewed="${file.id}" ${fileViewed(file) ? 'checked' : ''}> <span>${fileViewed(file) ? 'Viewed' : 'Mark viewed'}</span></label><button class="btn btn-sm btn-ghost" data-focus-next ${focusIndex + 1 === focusOrder.length ? 'disabled' : ''}>Next file ${icon('arrow-right')}</button></div></div></header>${!full ? '<p class="focus-unavailable">Full source was not captured or exceeds the text limit. Showing the saved diff; no current working files have been substituted.</p>' : ''}${(() => { const code = file.hunks.length || full?.length ? renderDiffTable(file, full || file.hunks, summaries) : `<pre>${escape(file.note || file.patch || 'No text diff available.')}</pre>`; return code; })()}<footer class="focus-end"><span>${focusIndex + 1 === focusOrder.length ? 'End of the review' : `Next: ${escape(files.get(focusOrder[focusIndex + 1].file).path)}`}</span><button class="btn btn-sm btn-primary" data-focus-next ${focusIndex + 1 === focusOrder.length ? 'disabled' : ''}>Next file →</button></footer></section>`;
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
    clearSelection(); render(); $('content').scrollTo({top:0, behavior:'instant'}); revealFirstChange(); updateChangeNavigation();
  }
  // Full source can open with its first change below the fold; land on it like the Next section arrow does.
  function revealFirstChange() {
    if (!fileReadingActive()) return;
    const first = $('content').querySelector('.change-anchor');
    if (!first) return;
    const inner = getComputedStyle($('content')).overflowY !== 'visible';
    const visibleBottom = inner ? $('content').getBoundingClientRect().bottom : window.innerHeight;
    if (first.getBoundingClientRect().top > visibleBottom - 80) selectChangedSection(first);
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
  // --- Your review: what you have said so far, and focus mode -------------------------------
  const ledgerWide = () => matchMedia('(min-width: 1500px)').matches;
  function ledgerEntries() {
    return comments.filter(comment => comment.personal).map(comment => {
      const found = comment.general ? null : ReviewTools.anchor(snapshot, comment);
      return {id:comment.id, path:found?.file.path || 'General', resolved:comment.resolved, subject:comment.subject,
              where:comment.general ? 'General comment' : `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`};
    });
  }
  // Open by choice; until you choose, open on a wide screen once there is something to show.
  const ledgerOpen = () => typeof state.ledgerOpen === 'boolean' ? state.ledgerOpen : ledgerWide() && (ledgerEntries().length > 0 || personalNotes().length > 0);
  function renderLedger() {
    const entries = ledgerEntries();
    const notes = personalNotes();
    const open = ledgerOpen();
    document.body.classList.toggle('ledger-open', open);
    $('ledger').hidden = !open;
    $('ledger-toggle').setAttribute('aria-expanded', open);
    const waiting = entries.filter(entry => !entry.resolved).length + notes.length;
    $('ledger-count').hidden = !waiting;
    $('ledger-count').textContent = waiting;
    $('ledger-toggle').setAttribute('aria-label', open ? 'Hide your review' : `Show your review${waiting ? `, ${plural(waiting, 'item')}` : ''}`);
    if (!open) return;
    const groups = new Map();
    entries.forEach(entry => { if (!groups.has(entry.path)) groups.set(entry.path, []); groups.get(entry.path).push(entry); });
    const row = entry => `<li class="ledger-item" data-ledger="${escape(entry.id)}" data-state="${entry.resolved ? 'resolved' : 'draft'}"><button type="button" class="ledger-jump" data-ledger-jump="${escape(entry.id)}"><span class="ledger-where">${escape(entry.where)}</span><span class="ledger-subject">${escape(entry.subject)}</span></button><div class="ledger-meta"><button type="button" data-resolve="${escape(entry.id)}">${entry.resolved ? 'Reopen' : 'Resolve'}</button><button type="button" data-copy="${escape(entry.id)}">Copy for LLMs</button></div></li>`;
    const byFile = [...groups].map(([path, list]) => `<section class="ledger-group"><h3>${escape(path)}</h3><ul class="ledger-list">${list.map(row).join('')}</ul></section>`).join('');
    const stepNotes = notes.length ? `<section class="ledger-group"><h3>Step notes</h3><ul class="ledger-list">${notes.map(note => `<li class="ledger-item" data-state="draft"><button type="button" class="ledger-jump" data-ledger-step="${escape(note.id)}"><span class="ledger-where">${escape(note.title)}</span><span class="ledger-subject">${escape(note.text)}</span></button></li>`).join('')}</ul></section>` : '';
    const empty = !entries.length && !notes.length ? '<p class="ledger-note">Select lines in a diff and write a comment. What you say, and what your agent answers, collects here.</p>' : '';
    const previews = previewsPossible ? `<section class="ledger-previews"><strong>Template previews</strong><p data-preview-summary>${previewSummary(lifecycle())}</p><button type="button" class="btn btn-sm btn-soft" data-open-previews>Open previews</button></section>` : '';
    $('ledger-body').innerHTML = `${empty}${byFile}${stepNotes}${previews}`;
    $('ledger-footer').dataset.base = entries.length || notes.length ? '1' : '';
    if (!$('ledger-footer').querySelector('[data-live-footer]')) $('ledger-footer').innerHTML = entries.length || notes.length ? '<button type="button" class="btn btn-sm btn-soft" data-open-send>Review and copy</button>' : '';
  }
  // Review and send: look over what you wrote, tick what goes out, then copy it for an LLM or,
  // in a served review, send it to your agent.
  const sendRows = () => comments.filter(comment => comment.personal && !comment.resolved);
  const sendChecked = () => [...$('send-list').querySelectorAll('input:checked')].map(input => comments.find(comment => comment.id === input.value)).filter(Boolean);
  function updateSendCount() {
    const count = sendChecked().length;
    $('send-copy').textContent = count ? `Copy ${count === 1 ? '1 comment' : `${count} comments`} for LLMs` : 'Copy for LLMs';
    $('send-copy').disabled = !count;
    $('send-dialog').dispatchEvent(new CustomEvent('send-selection', {detail:{ids:sendChecked().map(comment => comment.id)}}));
  }
  function openSendDialog() {
    const rows = sendRows();
    $('send-list').innerHTML = rows.length ? rows.map(comment => {
      const found = comment.general ? null : ReviewTools.anchor(snapshot, comment);
      const where = comment.general ? 'General comment' : `${found?.file.path || ''} · ${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`;
      return `<li><label><input type="checkbox" value="${escape(comment.id)}" checked><span class="send-text"><span class="send-where">${escape(where)}</span><span class="send-subject">${escape(comment.subject)}</span></span></label></li>`;
    }).join('') : '<li class="send-empty">Nothing to send yet. Select lines in a diff and write a comment.</li>';
    $('send-dialog').showModal();
    $('send-dialog').dispatchEvent(new CustomEvent('send-open'));
    updateSendCount();
    $('send-list').querySelector('input')?.focus();
  }
  $('send-list').addEventListener('change', updateSendCount);
  $('close-send').onclick = () => $('send-dialog').close();
  $('send-copy').onclick = async () => {
    const chosen = sendChecked();
    if (!chosen.length) return;
    $('send-dialog').close();
    await copyText(ReviewTools.reviewText(snapshot, chosen, [], review.qa));
  };

  function setLedger(open) { state.ledgerOpen = open; persist(); renderLedger(); }
  $('ledger-toggle').onclick = () => setLedger(!ledgerOpen());
  $('ledger-close').onclick = () => setLedger(false);
  function ledgerClick(event) {
    const jumpTo = event.target.closest('[data-ledger-jump]');
    const stepTo = event.target.closest('[data-ledger-step]');
    if (!jumpTo && !stepTo) return;
    if (stepTo) select(stepTo.dataset.ledgerStep);
    else {
      const comment = comments.find(comment => comment.id === jumpTo.dataset.ledgerJump);
      if (!comment) return;
      if (comment.general) { select('overview'); $('my-review')?.scrollIntoView({block:'start', behavior:'instant'}); }
      else jump(comment.hunk, comment.id);
    }
    if (!ledgerWide() || document.body.classList.contains('zen')) setLedger(false);
  }

  function setZen(on) {
    if (on === document.body.classList.contains('zen')) return;
    if (on) {
      if (!focusMode) chooseReadingMode(true);
      if (!fileReadingActive()) focusFile(Math.max(0, focusIndex));
    }
    document.body.classList.toggle('zen', on);
    $('zen-exit').hidden = !on;
    if (on) $('zen-exit').focus({preventScroll:true}); else $('zen-toggle').focus({preventScroll:true});
    renderLedger();
  }
  $('zen-toggle').onclick = () => setZen(true);
  $('zen-exit').onclick = () => setZen(false);

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
    // The View button names the current setup, so nobody has to open it to know.
    $('view-summary').textContent = [layoutChoice === 'split' ? 'Split' : 'Unified', focusMode ? 'File by file' : 'Walkthrough', !showComments && 'comments hidden', settings.ignoreWhitespace && 'whitespace hidden'].filter(Boolean).join(' · ');
    $('reading-hint').textContent = focusMode ? 'One file at a time, in walkthrough order. J and K move between files.' : 'Each step shows its files together under its explanation. J and K move between steps.';
    if (fileReadingActive()) {
      $('position').textContent = `File ${focusIndex + 1} of ${focusOrder.length}`;
      $('prev').disabled = focusIndex === 0; $('next').disabled = focusIndex === focusOrder.length - 1;
    }
    $('prev').setAttribute('aria-label', fileReadingActive() ? 'Previous file' : 'Previous step');
    $('next').setAttribute('aria-label', fileReadingActive() ? 'Next file' : 'Next step');
    $('content').innerHTML = fileReadingActive() ? renderFocus() : layer ? renderStep(layer) : state.view === 'files' ? renderFiles() : renderOverview();
    refreshVisualControls();
    renderLedger();
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
    if (scroll) { $('content').scrollTop = 0; revealFirstChange(); }
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
      if (panel.open) requestAnimationFrame(() => panel.querySelectorAll('iframe[data-preview-id]').forEach(frame => frame.contentDocument?.readyState === 'complete' && frame.hasAttribute('srcdoc') ? measurePreview(frame) : null));
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
  // The ⋯ menus float over the page, since cards clip their overflow: above their button when it fits.
  const closeMenus = (except = null) => document.querySelectorAll('details.more-menu[open]').forEach(open => { if (open !== except) open.open = false; });
  document.addEventListener('toggle', event => {
    const menu = event.target;
    if (!menu.matches?.('details.more-menu') || !menu.open) return;
    const button = menu.querySelector('summary').getBoundingClientRect();
    const list = menu.querySelector('.more-list');
    const height = list.offsetHeight;
    list.style.left = `${Math.max(8, Math.min(button.left, innerWidth - list.offsetWidth - 8))}px`;
    list.style.top = `${button.top - height - 6 >= 8 ? button.top - height - 6 : Math.min(button.bottom + 6, innerHeight - height - 8)}px`;
  }, true);
  document.addEventListener('scroll', () => closeMenus(), true);
  document.addEventListener('click', async event => {
    // Comment on GitHub is a link, so the browser opens it; the copy starts first, while this page
    // still has focus, which is what the clipboard needs. Nothing may be awaited before it.
    const github = event.target.closest('[data-github], [data-github-finding]');
    if (github) {
      const finding = github.dataset.githubFinding !== undefined && review.findings?.[Number(github.dataset.githubFinding)];
      const comment = finding ? {...findingComment(finding), discussion: finding.body} : comments.find(comment => comment.id === github.dataset.github);
      if (comment) copyText(ReviewTools.postingText(snapshot, comment, finding ? undefined : review.qa, {placed: true}), 'Copied. Paste it into the comment box on GitHub.');
      return;
    }
    // The ⋯ menus: one open at a time, closed by a choice or a click elsewhere.
    const menu = event.target.closest('details.more-menu');
    closeMenus(menu);
    if (menu && event.target.closest('.more-item')) menu.open = false;
    // Keep the checkbox independent from the native disclosure summary.
    if (event.target.closest('.file-viewed')) { event.stopPropagation(); return; }
    ledgerClick(event);
    const previewRequest = event.target.closest('[data-request-preview]');
    if (previewRequest) {
      event.preventDefault(); event.stopPropagation();
      const file = previewRequest.dataset.requestPreview;
      if (live.enabled) {
        const status = previewState(file);
        // Ask once; after that the chip shows how it is going and opens the stage to watch it.
        if (status === 'requested' || status === 'working') openStage(file);
        else document.dispatchEvent(new CustomEvent('review-preview-request', {detail: {path: file}}));
        return;
      }
      const selected = visualState.previews.includes(file);
      visualState.previews = ReviewTools.pendingPreviews(snapshot, review, selected ? visualState.previews.filter(path => path !== file) : [...visualState.previews, file]);
      const stored = persistVisuals(); refreshVisualControls(); renderNavigation();
      toast(stored ? (selected ? 'Removed from previews.' : 'Selected. Ask for all your selected templates from Previews in the header.') : 'Browser storage is unavailable. Copy your preview prompt before closing.');
      return;
    }
    if (event.target.closest('[data-open-previews]')) { openStage(); return; }
    if (event.target.closest('[data-start-reading]')) { select(layers[0]?.id || 'files'); return; }
    const showLive = event.target.closest('[data-show-live-preview]');
    if (showLive) { $('previews-dialog').close(); showPreview(showLive.dataset.showLivePreview); return; }
    if (event.target.closest('[data-open-send]')) { openSendDialog(); return; }
    const removePreview = event.target.closest('[data-remove-preview]');
    if (removePreview) {
      visualState.previews = visualState.previews.filter(path => path !== removePreview.dataset.removePreview);
      persistVisuals(); refreshVisualControls(); $('close-previews').focus(); return;
    }
    const forgetPreview = event.target.closest('[data-forget-preview]');
    if (forgetPreview) {
      visualState.requested = visualState.requested.filter(entry => entry.path !== forgetPreview.dataset.forgetPreview);
      persistVisuals(); refreshVisualControls(); render(); $('close-previews').focus(); return;
    }
    const copyPreviews = event.target.closest('[data-copy-previews]');
    if (copyPreviews) {
      const hub = lifecycle();
      const again = copyPreviews.dataset.copyPreviews === 'requested';
      const paths = again ? hub.requested.map(item => item.path) : hub.selected;
      if (!paths.length) return;
      const prompt = ReviewTools.visualPrompt(snapshot, review, {kind:'previews', paths});
      if (!again) { visualState = ReviewTools.requestPreviews(visualState, review.history?.revision || null, new Date().toISOString()); persistVisuals(); }
      $('previews-dialog').close(); render();
      await copyText(prompt); return;
    }
    // Opening a preview from the list lands on its file with the preview showing,
    // and clears its New mark.
    const openPreview = event.target.closest('[data-open-preview]');
    if (openPreview) {
      const path = openPreview.dataset.openPreview;
      const file = filesByPath.get(path);
      visualState.requested = visualState.requested.filter(entry => entry.path !== path || !previewsByPath.get(path)?.some(preview => preview.status === 'rendered'));
      persistVisuals();
      $('previews-dialog').close();
      const layer = layers.find(layer => layer.items.some(item => item.file === file?.id));
      if (!file || !layer) return;
      if (previewsByPath.get(path)?.length) { state.previewPane = 'open'; persist(); }
      navigateFile(layer, file.id);
      const panel = focusMode ? document.getElementById('preview-pane') : document.querySelector(`.file-card[data-file="${file.id}"] .preview-panel`);
      if (panel) { panel.open = true; if (!focusMode || !wideScreen()) panel.scrollIntoView({block:'nearest', behavior:'instant'}); }
      refreshVisualControls(); return;
    }
    if (event.target.closest('[data-copy-qa]')) {
      await copyText(ReviewTools.visualPrompt(snapshot, review, {kind:'qa'})); return;
    }
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
    if (line && !composer.suppressClick) selectLine(line, event.shiftKey);
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
  document.addEventListener('keydown', event => {
    const menu = document.querySelector('details.more-menu[open]');
    if (event.key === 'Escape' && menu) { event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); }
  }, true);
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
    const toggle = event.target.closest('[data-preview-toggle]');
    if (toggle) openStage(toggle.dataset.previewPath);
  });
  document.querySelectorAll('[data-color-mode]').forEach(button => button.onclick = () => { settings.colorMode = button.dataset.colorMode; applySettings(); saveSettings(); });
  $('syntax-theme').onchange = event => { settings.syntaxTheme = event.target.value; applySettings(); saveSettings(); };
  darkQuery.addEventListener('change', () => { if (settings.colorMode === 'system') applySettings(); });
  $('whitespace-toggle').onchange = event => { const scroll = $('content').scrollTop; settings.ignoreWhitespace = event.target.checked; saveSettings(); render(); $('content').scrollTop = scroll; };
  applySettings();
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
  $('close-previews').onclick = () => $('previews-dialog').close();
  // Toolbar icons come from the bundled Lucide set; the static glyphs are only fallbacks.
  $('nav-toggle').innerHTML = icon('panel-left');
  $('prev').innerHTML = icon('chevron-left');
  $('next').innerHTML = icon('chevron-right');
  $('view-icon').innerHTML = icon('sliders-horizontal');
  $('ledger-toggle').innerHTML = `${icon('panel-right')}<span class="ledger-label">Your review</span><b id="ledger-count" class="ledger-count" hidden></b>`;
  $('ledger-close').innerHTML = icon('x');
  $('zen-toggle').innerHTML = icon('maximize-2');
  $('zen-exit').innerHTML = `${icon('minimize-2')}<span>Exit focus</span>`;
  // The View menu is a native popover placed under its button, clamped to the viewport.
  $('view-menu').addEventListener('toggle', event => {
    $('view-toggle').setAttribute('aria-expanded', event.newState === 'open');
    if (event.newState !== 'open') return;
    const anchor = $('view-toggle').getBoundingClientRect();
    const menu = $('view-menu');
    menu.style.top = `${Math.round(anchor.bottom + 8)}px`;
    menu.style.left = `${Math.round(Math.max(12, Math.min(anchor.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12)))}px`;
  });
  $('comment-form').onsubmit = event => {
    event.preventDefault();
    const subject = $('editor-subject').value.trim();
    if (!subject || !editorRange) return;
    const comment = {...editorRange, id:editingID || `mine-${crypto.randomUUID()}`, label:$('editor-label').value,
      decoration:$('editor-blocking').checked ? 'blocking' : 'non-blocking', subject, discussion:$('editor-discussion').value.trim()};
    const audience = state.personalComments.find(existing => existing.id === editingID)?.audience;
    if (audience) comment.audience = audience;
    $('comment-editor').close();
    commitComment(comment);
  };
  $('comment-editor').addEventListener('close', () => {
    const button = [...document.querySelectorAll('[data-select-line]')].find(button => button.dataset.rangeHunk === editorRange?.hunk && button.dataset.rangeSide === editorRange?.side && Number(button.dataset.selectLine) === editorRange?.start);
    (button || document.querySelector('[data-add-general]'))?.focus({preventScroll:true});
  });
  $('close-details').onclick = $('done-details').onclick = () => $('details-dialog').close();
  $('export').onclick = () => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify({snapshot:snapshot.fingerprint, ...state, visualSelections:visualState}, null, 2)], {type:'application/json'}));
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
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey || $('details-dialog').open || $('comment-editor').open || $('copy-dialog').open || $('previews-dialog').open || $('send-dialog').open || $('comment-popover').matches(':popover-open')) return;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') { event.preventDefault(); step(key === 'j' ? 1 : -1); }
    if (key === 'z') chooseReadingMode(!focusMode);
    if (key === 'f') setZen(!document.body.classList.contains('zen'));
    if (key === 'l') setLedger(!ledgerOpen());
    if (key === 'v' && document.body.classList.contains('zen')) document.querySelector('.focus-reader [data-file-viewed]')?.click();
    if (event.key === 'Escape' && document.body.classList.contains('zen')) setZen(false);
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
  const scope = ReviewTools.scopeLabel(snapshot, review);
  $('scope').innerHTML = `<span class="badge neutral" title="${escape(scope)}">${escape(scope)}</span>`;
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
