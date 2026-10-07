'use strict';
// The running app inside the served review (`dcr serve --app <url>`). The app is loaded through
// the review's proxy, whose injected agent reports the route and, in Comment mode, the element the
// reader picks. A comment is written in a box next to that element; recording shares this tab cut
// down to the app. "On this app" lists everything said about the app, like Your review does for code.
(() => {
  const meta = document.querySelector('meta[name="dcr-app"]');
  if (!meta) return;
  const app = JSON.parse(meta.content);
  const tools = window.LiveTools;
  const recentKey = 'dcr-app:recent';
  const widthKey = 'dcr-app:width';
  const railKey = 'dcr-app:rail';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const read = (name, fallback) => { try { return JSON.parse(localStorage.getItem(name)) ?? fallback; } catch { return fallback; } };
  const write = (name, value) => { try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* this session only */ } };
  const svg = paths => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    monitor: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    reload: svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    phone: svg('<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>'),
    tablet: svg('<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>'),
    desktop: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    panel: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'),
    camera: svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
    send: svg('<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>')
  };

  const dialog = document.createElement('dialog');
  dialog.id = 'dcr-app';
  dialog.className = 'stage dcr-app';
  dialog.setAttribute('aria-labelledby', 'dcr-app-title');
  // Opening lands on the dialog itself, not in the address field.
  dialog.tabIndex = -1;
  dialog.autofocus = true;
  dialog.innerHTML = `
    <header class="stage-bar">
      <div class="dcr-qa-banner" role="status" aria-live="polite" hidden>
        <span class="dcr-qa-pulse" aria-hidden="true"></span>
        <div class="dcr-qa-text"><strong data-qa-title>Your agent is running the QA review in this tab</strong><span data-qa-detail>Please don't click or type here until it finishes. The results will appear here.</span></div>
        <span class="dcr-qa-progress" data-qa-progress></span>
        <button type="button" class="act act-secondary" data-qa-share hidden>Share this tab</button>
        <button type="button" class="act act-quiet" data-qa-stop>Stop QA review</button>
      </div>
      <div class="dcr-app-lead">
        <h2 id="dcr-app-title" class="dcr-visually-hidden">The running app</h2>
        <nav class="dcr-views" aria-label="Look at the change" data-views></nav>
        <form class="dcr-app-address" autocomplete="off">
          <span class="dcr-app-host" title="${esc(app.upstream)}">${esc(app.upstream.replace(/^https?:\/\//, ''))}</span>
          <input name="path" list="dcr-app-recent" spellcheck="false" aria-label="Page in the app" value="${esc(app.start)}">
          <datalist id="dcr-app-recent"></datalist>
          <button type="button" class="dcr-app-icon" data-app-reload aria-label="Reload the app" title="Reload">${icons.reload}</button>
          <a class="dcr-app-icon" data-app-open target="_blank" rel="noopener" aria-label="Open this page in a new tab" title="Open in a new tab">${icons.external}</a>
        </form>
      </div>
      <div class="stage-tools">
        <div class="stage-sizes dcr-app-modes" role="group" aria-label="Mode"><button type="button" data-app-mode="browse" aria-pressed="true" title="Use the app (B)">Browse</button><button type="button" data-app-mode="comment" aria-pressed="false" title="Click something in the app to comment on it (C)" disabled>Comment</button></div>
        <div class="stage-sizes" role="group" aria-label="App width"><button type="button" data-app-width="390" title="Phone, 390 px">${icons.phone}</button><button type="button" data-app-width="768" title="Tablet, 768 px">${icons.tablet}</button><button type="button" data-app-width="1280" title="Desktop, 1280 px">${icons.desktop}</button><button type="button" data-app-width="fit" title="Fill the window">Fit</button></div>
        <button type="button" class="dcr-app-record" data-app-record><span class="dcr-app-rec-dot" aria-hidden="true"></span><span data-app-record-label>Record</span></button>
        <button type="button" class="dcr-app-icon dcr-app-still" data-app-still hidden aria-label="Save a still of the app" title="Save a still">${icons.camera}</button>
        <button type="button" class="dcr-app-rail-toggle" data-app-rail aria-expanded="false" aria-controls="dcr-app-rail" title="What you said about this app">${icons.panel}<span>On this app</span><b class="dcr-app-count" hidden></b></button>
        <button type="button" class="dcr-app-icon" data-app-close aria-label="Close the app" title="Close (Esc)">${icons.close}</button>
      </div>
    </header>
    <div class="dcr-app-body">
      <div class="dcr-app-canvas">
        <div class="dcr-app-pane"><iframe title="The app under review" name="dcr-app-frame"></iframe></div>
        <form class="dcr-app-compose" data-app-compose hidden aria-label="Comment on this element">
          <p class="dcr-app-target"></p>
          <textarea name="body" rows="3" placeholder="What should change here?" aria-label="Your comment"></textarea>
          <div class="dcr-app-compose-actions"><button type="button" class="act act-quiet" data-app-copy>Copy</button><span></span><button type="button" class="act act-quiet" data-app-cancel>Cancel</button><button type="submit" class="act act-primary">Send to agent</button></div>
        </form>
      </div>
      <aside class="dcr-app-rail" id="dcr-app-rail" aria-labelledby="dcr-app-rail-title" hidden>
        <header class="dcr-app-rail-head"><h3 id="dcr-app-rail-title">On this app</h3><button type="button" class="act act-quiet" data-start-qa title="Your agent records the flows behind the comments in this tab and attaches the clips">Start QA review</button><button type="button" class="act act-primary" data-rec-save hidden></button></header>
        <ol class="dcr-app-list"></ol>
      </aside>
    </div>
    <footer class="stage-foot dcr-app-foot">
      <p class="dcr-app-status" role="status"><span class="dcr-dot" aria-hidden="true"></span><span data-app-status>Loading the app</span></p>
      <p class="dcr-app-sharing" hidden><span class="dcr-app-rec-dot" aria-hidden="true"></span>Sharing this tab<button type="button" data-app-unshare>Stop sharing</button></p>
    </footer>`;
  document.body.append(dialog);
  // The end of a QA review: what came out of it, where it went, and that the tab is free again.
  const done = document.createElement('dialog');
  done.className = 'modal dcr-qa-done';
  done.setAttribute('aria-labelledby', 'dcr-qa-done-title');
  done.innerHTML = `<div class="modal-box"><header><span class="dcr-qa-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span><div><h2 id="dcr-qa-done-title">QA review ready</h2><p data-done-summary></p></div></header>
    <div class="dcr-qa-report" data-done-report></div>
    <p class="dcr-qa-free">Sharing has stopped. This tab is yours again.</p>
    <footer><button type="button" class="act act-quiet" data-done-close>Close</button><button type="button" class="act act-primary" data-done-open></button></footer></div>`;
  document.body.append(done);
  const $ = selector => dialog.querySelector(selector);
  const frame = $('iframe');
  const pane = $('.dcr-app-pane');
  const canvas = $('.dcr-app-canvas');
  const address = $('.dcr-app-address');
  const input = address.elements.path;
  const compose = $('[data-app-compose]');
  const rail = $('.dcr-app-rail');
  const list = $('.dcr-app-list');
  $('[data-views]').innerHTML = '';

  // --- Code | App | Previews: three ways to look at the change, side by side in the header -----
  // The reading bar below stays about reading code. The same switch heads the App view, so the
  // reader can move between the three without hunting for buttons.
  const previewButton = document.getElementById('preview-list-toggle');
  const templateCount = new Set((() => { try { return JSON.parse(document.getElementById('data').textContent).snapshot.files; } catch { return []; } })()
    .filter(file => window.ReviewTools?.previewEligible(file)).map(file => file.path.split('/').pop().replace(/\.html\.erb$|\.rb$/, ''))).size;
  const viewsHTML = current => `<button type="button" data-view="code" aria-pressed="${current === 'code'}">Code</button><button type="button" data-view="app" aria-pressed="${current === 'app'}" title="Use the running app, ${esc(app.upstream)} (A)" aria-keyshortcuts="A"><span class="dcr-app-live" aria-hidden="true"></span>App</button>${templateCount ? `<button type="button" data-view="previews" aria-pressed="false" title="Changed templates, rendered">Previews<b>${templateCount}</b></button>` : ''}`;
  const headerViews = document.createElement('nav');
  headerViews.className = 'dcr-views';
  headerViews.setAttribute('aria-label', 'Look at the change');
  headerViews.innerHTML = viewsHTML('code');
  const headerActions = document.querySelector('.header-actions');
  if (headerActions) { headerActions.prepend(headerViews); document.body.classList.add('dcr-has-views'); }
  else document.querySelector('.toolbar-options')?.prepend(headerViews);
  const openButton = headerViews.querySelector('[data-view="app"]');
  const showView = view => {
    if (view === 'app') return open();
    if (dialog.open) dialog.close();
    if (view === 'previews') previewButton?.click();
  };
  headerViews.addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) showView(button.dataset.view); });

  // The Overview's "Try the change" band is the way in; the two-tab recorder card would be a
  // second, harder way to do the same thing. The recorder itself stays in the page.
  document.body.classList.add('dcr-has-app');

  // --- the app and where it is ---------------------------------------------------------------------
  let pendingMode = null;
  let ready = false, mode = 'browse', route = app.start, left = null, readyTimer, picked = null, pendingHighlight = null;
  const post = message => frame.contentWindow?.postMessage({source: 'dcr-review', ...message}, app.origin);
  const status = (tone, text) => { $('.dcr-app-status .dcr-dot').dataset.tone = tone; $('[data-app-status]').textContent = text; };
  const connected = () => `Connected to ${route}`;
  const remember = path => {
    const recent = [path, ...read(recentKey, []).filter(item => item !== path)].slice(0, 12);
    write(recentKey, recent);
    $('#dcr-app-recent').innerHTML = recent.map(item => `<option value="${esc(item)}"></option>`).join('');
  };
  const setRoute = path => {
    route = path;
    // Follow the app unless the reader is typing an address of their own.
    if (!(document.activeElement === input && input.dataset.edited)) input.value = path;
    $('[data-app-open]').href = app.upstream + path;
    remember(path);
  };
  const setMode = next => {
    mode = ready && !left ? next : 'browse';
    dialog.querySelectorAll('[data-app-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appMode === mode)));
    dialog.classList.toggle('is-commenting', mode === 'comment');
    post({type: 'mode', mode});
    if (ready && !left) status('ok', mode === 'comment' ? 'Click anything in the app to comment on it. Esc to stop.' : connected());
  };
  const navigate = path => {
    ready = false;
    closeCompose();
    frame.src = app.origin + (path.startsWith('/') ? path : `/${path}`);
  };
  const setWidth = width => {
    write(widthKey, width);
    dialog.querySelectorAll('[data-app-width]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appWidth === String(width))));
    pane.style.width = width === 'fit' ? '' : `${width}px`;
    dialog.classList.toggle('is-fit', width === 'fit');
    placeCompose();
  };

  window.addEventListener('message', event => {
    if (event.origin !== app.origin || event.source !== frame.contentWindow || event.data?.source !== 'dcr-app') return;
    const message = event.data;
    if (message.type === 'ready') {
      ready = true; clearTimeout(readyTimer);
      dialog.querySelectorAll('[data-view="app"]').forEach(button => button.classList.add('is-live'));
      openButton.classList.add('is-live');
      left = message.left;
      $('[data-app-mode="comment"]').disabled = !!left;
      setRoute(message.path);
      if (left) status('work', `The app went to ${left}, outside ${app.upstream}. Open it in a new tab, or go back.`);
      setMode(pendingMode || mode);
      pendingMode = null;
      if (pendingHighlight) { post({type: 'highlight', selector: pendingHighlight}); pendingHighlight = null; }
      if (agentPointer) post({type: 'pointer', on: true});
    } else if (message.type === 'route') {
      setRoute(message.path);
      if (mode === 'browse') status('ok', connected());
    } else if (message.type === 'pick') {
      openCompose(message);
    } else if (message.type === 'rect' && picked) {
      picked.rect = message.rect;
      placeCompose();
    } else if (message.type === 'mode-exit') {
      if (picked) closeCompose(); else setMode('browse');
    }
  });
  frame.addEventListener('load', () => {
    ready = false;
    clearTimeout(readyTimer);
    post({type: 'hello'});
    // The agent answers within a moment on any page the proxy could inject into.
    readyTimer = setTimeout(() => {
      if (ready) return;
      $('[data-app-mode="comment"]').disabled = true;
      setMode('browse');
      status('off', 'Commenting is unavailable on this page: the review could not connect to it. Browsing still works.');
    }, 2500);
  });

  // --- talking to the review server ----------------------------------------------------------------
  const token = document.querySelector('meta[name="qa-token"]')?.content;
  const data = (() => { try { return JSON.parse(document.getElementById('data').textContent); } catch { return null; } })();
  const key = tools && data ? tools.progressKey(data.snapshot, data.review) : null;
  const api = async (path, body) => {
    const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'X-QA-Token': token, ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  };
  let threads = {}, listening;
  const newId = () => Math.random().toString(16).slice(2, 10);
  // Agent messages already read, shared with the conversation layer so the tab title count agrees.
  const seenKey = key ? `dcr-seen:${key}` : null;
  const seen = () => new Set(seenKey ? read(seenKey, []) : []);
  const markSeen = ids => { if (!seenKey || !ids.length) return; const all = seen(); ids.forEach(id => all.add(id)); write(seenKey, [...all].slice(-500)); };

  // --- what an element is called, in words ---------------------------------------------------------
  const KINDS = {a: 'link', button: 'button', input: 'field', textarea: 'field', select: 'menu', img: 'image', label: 'label', summary: 'toggle', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', table: 'table', tr: 'row', li: 'item', form: 'form', nav: 'navigation', svg: 'icon', i: 'icon'};
  const elementName = anchor => {
    const kind = KINDS[anchor.tag] || 'element';
    const text = (anchor.text || '').trim();
    return text ? {name: text.length > 48 ? `${text.slice(0, 47)}…` : text, kind} : {name: kind[0].toUpperCase() + kind.slice(1), kind: ''};
  };

  // --- writing a comment, next to the element ------------------------------------------------------
  const agentText = (anchor, body) => [
    'Comment on the running app (not on a line of code)',
    `Page: ${app.upstream}${anchor.path}`,
    `Element: ${anchor.selector}${anchor.text ? ` (“${anchor.text}”)` : ''}`,
    anchor.still ? `Still of the app: ${anchor.still}` : null,
    '', body
  ].filter(line => line !== null).join('\n');
  // The box sits under the element (or above it when there is no room), inside the app's area,
  // and follows it as the app scrolls.
  const placeCompose = () => {
    if (!picked || compose.hidden) return;
    const frameBox = frame.getBoundingClientRect(), canvasBox = canvas.getBoundingClientRect();
    const r = picked.rect, width = compose.offsetWidth, height = compose.offsetHeight, gap = 10;
    const top = frameBox.top - canvasBox.top + canvas.scrollTop;
    const leftEdge = frameBox.left - canvasBox.left + canvas.scrollLeft;
    let y = top + r.y + r.height + gap;
    if (r.y + r.height + gap + height > frameBox.height && r.y - gap - height > 0) y = top + r.y - gap - height;
    y = Math.max(top + 8, Math.min(y, top + frameBox.height - height - 8));
    const x = Math.max(leftEdge + 8, Math.min(leftEdge + r.x, leftEdge + frameBox.width - width - 8));
    compose.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const outside = r.y + r.height < 0 || r.y > frameBox.height;
    compose.classList.toggle('is-detached', outside);
  };
  function openCompose(message) {
    picked = {...message};
    const {name, kind} = elementName(message);
    $('.dcr-app-target').innerHTML = `<strong>${esc(name)}</strong>${kind ? `<span>${esc(kind)}</span>` : ''}<code title="${esc(message.selector)}">${esc(message.selector)}</code>`;
    compose.hidden = false;
    dialog.classList.add('is-composing');
    post({type: 'highlight', selector: message.selector, scroll: false});
    placeCompose();
    compose.elements.body.focus({preventScroll: true});
  }
  function closeCompose() {
    if (!picked) return;
    picked = null;
    compose.hidden = true;
    compose.reset();
    dialog.classList.remove('is-composing');
    post({type: 'highlight', selector: null});
  }
  $('[data-app-cancel]').addEventListener('click', closeCompose);
  $('[data-app-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(agentText(picked, compose.elements.body.value.trim() || '(no comment yet)')); status('ok', 'Copied the page, the element and your comment.'); }
    catch { status('off', 'Copying is blocked here. Select the text instead.'); }
  });
  compose.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCompose(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); compose.requestSubmit(); }
  });
  compose.addEventListener('submit', async event => {
    event.preventDefault();
    const body = compose.elements.body.value.trim();
    if (!body) { compose.elements.body.focus(); return; }
    if (!key) { status('off', 'This review cannot send comments. Use Copy.'); return; }
    const anchor = {selector: picked.selector, path: picked.path, text: picked.text || '', tag: picked.tag || '', kind: 'element'};
    // While this tab is shared, the comment carries a still of the app as you saw it.
    const rec = window.QARecorder?.status();
    if (rec?.ready && rec.pane) { try { const saved = await window.QARecorder.still(`comment-${clipName()}`); if (saved?.path) anchor.still = saved.path; } catch { /* the comment still goes */ } }
    const id = `app-${newId()}`;
    try {
      await api('/api/send', {key, items: [{id, text: agentText(anchor, body), message: body, anchor}]});
      closeCompose();
      setMode('browse');
      expanded = id;
      status('ok', listening === false ? 'Sent. No agent is listening yet; it gets this when it continues the review.' : 'Sent to your agent.');
      openRail(true);
      refresh();
    } catch (error) { status('off', error.message); }
  });

  // --- On this app: comments and recordings, newest first ------------------------------------------
  const recs = []; // this session's clips and stills; a sent one is joined to its thread
  let expanded = null;
  const time = at => tools ? tools.relativeTime(at) : '';
  const clock = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  const reviewComments = (data?.review?.comments || []).map(comment => ({id: comment.id, subject: comment.subject}));
  // A QA review is one row holding its clips and the agent's report; the latest one leads the list
  // and earlier ones fold into a single row, since each new run replaces the last one's clips.
  const rows = () => {
    const sent = new Map(recs.filter(item => item.thread).map(item => [item.thread, item]));
    const all = Object.entries(threads).filter(([id]) => id.startsWith('app-'));
    const qa = all.filter(([, thread]) => thread.anchor?.kind === 'request')
      .map(([id, thread]) => ({id, kind: 'qa', thread, at: thread.messages[0]?.at || ''}))
      .sort((a, b) => b.at.localeCompare(a.at));
    if (qa[0]) qa[0].clips = recs.filter(item => item.driver === 'agent' && !item.thread && item.at >= qa[0].at);
    const lead = qa.slice(0, 1);
    const older = qa.length > 1 ? [{id: 'qa-older', kind: 'qa-older', list: qa.slice(1), at: qa[1].at}] : [];
    const fromThreads = all.filter(([, thread]) => thread.anchor?.kind !== 'request').map(([id, thread]) => {
      const rec = sent.get(id);
      return {id, thread, rec, at: rec?.at || thread.messages[0]?.at || ''};
    });
    const unsent = recs.filter(item => !item.thread && item.driver !== 'agent').map(item => ({id: `rec-${item.id}`, rec: item, at: item.at}));
    return [...lead, ...older, ...[...fromThreads, ...unsent].sort((a, b) => b.at.localeCompare(a.at))];
  };
  const reportOf = thread => [...(thread?.messages || [])].reverse().find(message => message.author === 'agent');
  const firstLine = text => String(text || '').replace(/[*_`#>]/g, '').split('\n').map(line => line.trim()).find(Boolean) || '';
  const qaRowHTML = row => {
    const open = expanded === row.id;
    const model = tools?.statusModel(row.thread, listening);
    const report = reportOf(row.thread);
    const clips = row.clips || [];
    const counted = clips.length ? `${clips.length} ${clips.length === 1 ? 'recording' : 'recordings'}` : '';
    let body = '';
    if (open) {
      body += clips.length ? `<div class="dcr-qa-clips">${clips.map(item => `<figure>${recordingHTML(item)}<figcaption>${esc(item.page)}</figcaption></figure>`).join('')}</div>` : '';
      body += report ? `<div class="dcr-app-msg-body dcr-qa-report-inline">${tools ? tools.markdown(report.body) : esc(report.body)}</div>` : `<p class="dcr-app-row-tools">Your agent's report appears here when it finishes.</p>`;
      if (report) markSeen([report.id]);
    }
    return `<li class="dcr-app-row dcr-qa-row${open ? ' is-open' : ''}" data-row="${esc(row.id)}" data-stroke="agent">
      <button type="button" class="dcr-app-row-head" data-row-toggle aria-expanded="${open}">
        <span class="dcr-app-row-title"><strong>QA review</strong><span>by your agent</span></span>
        <span class="dcr-app-row-where"><time data-at="${esc(row.at)}">${esc(time(row.at))}</time>${counted ? `<span>${counted}</span>` : ''}</span>
        ${!open && report ? `<span class="dcr-app-row-text">${esc(firstLine(report.body))}</span>` : ''}
      </button>
      <p class="dcr-app-row-state"><span class="dcr-dot dcr-tone-${model?.tone || 'done'}" aria-hidden="true"></span>${esc(qaActive === row.id ? 'Running in this tab' : (model?.text || 'Finished'))}${model?.typing && qaActive === row.id ? '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</p>
      ${body}</li>`;
  };
  const olderRowHTML = row => {
    const open = expanded === row.id;
    return `<li class="dcr-app-row${open ? ' is-open' : ''}" data-row="qa-older" data-stroke="settled">
      <button type="button" class="dcr-app-row-head" data-row-toggle aria-expanded="${open}">
        <span class="dcr-app-row-title"><strong>Earlier QA reviews</strong><span>${row.list.length}</span></span>
        <span class="dcr-app-row-where"><span>Their clips were replaced by the latest QA review</span></span>
      </button>
      ${open ? `<ol class="dcr-qa-older">${row.list.map(item => `<li><time data-at="${esc(item.at)}">${esc(time(item.at))}</time><span>${esc(firstLine(reportOf(item.thread)?.body) || 'No report')}</span></li>`).join('')}</ol>` : ''}
    </li>`;
  };
  // One state per row, drawn as the left stroke: amber is yours and not sent, indigo is with your
  // agent, grey is settled (saved into the review).
  const rowState = row => {
    if (row.thread) {
      const model = tools?.statusModel(row.thread, listening);
      return {stroke: 'agent', tone: model?.tone || 'done', text: model?.text || 'Sent to your agent', typing: model?.typing};
    }
    const rec = row.rec;
    if (rec.driver === 'agent') return {stroke: 'agent', tone: qaActive ? 'work' : 'done', text: qaActive ? 'Recorded by your agent for the QA review' : 'Recorded by your agent; the QA review attaches it'};
    if (rec.state === 'saved') return {stroke: 'settled', tone: 'done', text: `In the review, revision ${rec.revision}`};
    if (rec.state === 'queued') return {stroke: 'yours', tone: 'wait', text: 'Ready to save to the review'};
    return {stroke: 'yours', tone: 'wait', text: 'Not sent'};
  };
  const rowTitle = row => {
    const anchor = row.thread?.anchor || {};
    if (anchor.kind === 'request') return {name: 'QA review', kind: 'by your agent', path: 'Clips arrive in this list and on their comments'};
    if (row.rec || anchor.kind === 'clip' || anchor.kind === 'still') {
      const rec = row.rec;
      const kind = rec ? rec.kind : anchor.kind;
      return {name: kind === 'clip' ? `Clip${rec?.durationMs ? ` ${clock(rec.durationMs)}` : ''}` : 'Still', kind: '', path: rec?.page || anchor.path};
    }
    return {...elementName(anchor), path: anchor.path || ''};
  };
  const messagesHTML = (thread, unread) => thread.messages.map(message => {
    const agent = message.author === 'agent';
    return `<li class="dcr-app-msg${agent ? ' is-agent' : ''}"><p class="dcr-app-msg-head"><strong>${agent ? 'Your agent' : 'You'}</strong><time datetime="${esc(message.at)}" data-at="${esc(message.at)}">${esc(time(message.at))}</time>${agent && unread.has(message.id) ? '<span class="dcr-app-new">New</span>' : ''}</p>
      <div class="dcr-app-msg-body">${agent && tools ? tools.markdown(message.body) : `<p>${esc(message.body).replace(/\n/g, '<br>')}</p>`}</div></li>`;
  }).join('');
  const recordingHTML = rec => rec?.url ? (rec.kind === 'clip' ? `<video src="${rec.url}" controls muted playsinline preload="metadata"></video>` : `<img src="${rec.url}" alt="Still of ${esc(rec.page)}">`) : '';
  const recFormHTML = rec => `<form class="dcr-app-rec-form" data-rec-form>
      <label>Title<input name="title" maxlength="200" value="${esc(rec.draft.title)}"></label>
      <fieldset class="dcr-app-result"><legend>Result</legend><label><input type="radio" name="result" value="passed" ${rec.draft.result === 'passed' ? 'checked' : ''}> Passed</label><label><input type="radio" name="result" value="failed" ${rec.draft.result === 'failed' ? 'checked' : ''}> Failed</label></fieldset>
      <label>What you saw<textarea name="observed" rows="2">${esc(rec.draft.observed)}</textarea></label>
      ${reviewComments.length ? `<label>About<select name="comment_id"><option value="">No particular review comment</option>${reviewComments.map(comment => `<option value="${esc(comment.id)}" ${rec.draft.comment_id === comment.id ? 'selected' : ''}>${esc(comment.subject)}</option>`).join('')}</select></label>` : ''}
      <div class="dcr-app-row-actions"><button type="button" class="act act-quiet" data-rec-cancel>Cancel</button><button type="submit" class="act act-secondary">Add to the review</button></div></form>`;
  const rowHTML = row => {
    if (row.kind === 'qa') return qaRowHTML(row);
    if (row.kind === 'qa-older') return olderRowHTML(row);
    const state = rowState(row);
    const title = rowTitle(row);
    const open = expanded === row.id;
    const first = row.thread?.messages.find(message => message.author === 'user')?.body || row.rec?.draft.note || '';
    const unread = new Set(row.thread ? row.thread.messages.filter(message => message.author === 'agent').map(message => message.id).filter(id => !seen().has(id)) : []);
    const head = `<button type="button" class="dcr-app-row-head" data-row-toggle aria-expanded="${open}">
        <span class="dcr-app-row-title"><strong>${esc(title.name)}</strong>${title.kind ? `<span>${esc(title.kind)}</span>` : ''}${unread.size ? '<span class="dcr-app-new">New</span>' : ''}</span>
        <span class="dcr-app-row-where"><span>${esc(title.path)}</span><time data-at="${esc(row.at)}">${esc(time(row.at))}</time></span>
        ${!open && first ? `<span class="dcr-app-row-text">${esc(first)}</span>` : ''}
        ${!open && row.rec?.url ? `<span class="dcr-app-thumb">${recordingHTML(row.rec).replace(' controls', '')}</span>` : ''}
      </button>
      <p class="dcr-app-row-state"><span class="dcr-dot dcr-tone-${state.tone}" aria-hidden="true"></span>${esc(state.text)}${state.typing ? '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</p>`;
    let body = '';
    if (open) {
      const anchor = row.thread?.anchor;
      body += row.rec?.url ? `<div class="dcr-app-media">${recordingHTML(row.rec)}</div>` : '';
      if (anchor?.selector) body += `<p class="dcr-app-row-tools"><button type="button" data-row-show>Show in the app</button><code title="${esc(anchor.selector)}">${esc(anchor.selector)}</code></p>`;
      if (row.thread) {
        body += `<ol class="dcr-app-thread">${messagesHTML(row.thread, unread)}</ol>
          <form class="dcr-app-reply" data-row-reply><textarea name="body" rows="1" placeholder="Reply to your agent" aria-label="Reply"></textarea><button type="submit" class="dcr-app-icon" aria-label="Send reply" title="Send reply (⌘ Enter)">${icons.send}</button></form>`;
        markSeen([...unread]);
      } else if (row.rec.form === 'agent') {
        body += `<form class="dcr-app-rec-form" data-rec-agent><label>Note for your agent<textarea name="note" rows="2" placeholder="What should it look at?">${esc(row.rec.draft.note)}</textarea></label>
          <div class="dcr-app-row-actions"><button type="button" class="act act-quiet" data-rec-cancel>Cancel</button><button type="submit" class="act act-secondary">Send to agent</button></div></form>`;
      } else if (row.rec.form === 'review') {
        body += recFormHTML(row.rec);
      } else if (row.rec.driver !== 'agent' && (row.rec.state === 'new' || row.rec.state === 'queued')) {
        body += `<div class="dcr-app-row-actions">${row.rec.state === 'queued' ? '<button type="button" class="act act-quiet" data-rec-unqueue>Keep out of the review</button>' : `<button type="button" class="act act-quiet" data-rec-open="agent">Send to agent</button><button type="button" class="act act-secondary" data-rec-open="review">Add to the review</button>`}</div>`;
      }
    }
    return `<li class="dcr-app-row${open ? ' is-open' : ''}" data-row="${esc(row.id)}" data-stroke="${state.stroke}">${head}${body}</li>`;
  };
  const renderList = () => {
    const all = rows();
    const count = all.length;
    $('.dcr-app-count').hidden = !count;
    $('.dcr-app-count').textContent = count;
    const queued = recs.filter(item => item.state === 'queued').length;
    const save = $('[data-rec-save]');
    save.hidden = !queued;
    save.textContent = `Save ${queued === 1 ? 'it' : queued} to the review`;
    if (rail.hidden) return;
    // A half-typed reply or note survives the list redrawing.
    const typing = new Map([...list.querySelectorAll('[data-row]')].map(node => [node.dataset.row, node.querySelector('[data-row-reply] textarea')?.value]).filter(([, value]) => value));
    const focused = document.activeElement?.closest?.('[data-row]')?.dataset.row;
    list.innerHTML = count ? all.map(rowHTML).join('') : `<li class="dcr-app-empty"><p>Nothing yet.</p><p>Choose <button type="button" data-empty-comment>Comment</button> and click anything in the app to say what should change there, <button type="button" data-empty-record>record a clip</button> of what you see, or <button type="button" data-empty-qa>start a QA review</button> and let your agent record the flows behind the comments.</p></li>`;
    typing.forEach((value, id) => { const area = list.querySelector(`[data-row="${CSS.escape(id)}"] [data-row-reply] textarea`); if (area) area.value = value; });
    if (focused) list.querySelector(`[data-row="${CSS.escape(focused)}"] [data-row-reply] textarea`)?.focus();
  };
  const openRail = open => {
    rail.hidden = !open;
    $('[data-app-rail]').setAttribute('aria-expanded', String(open));
    dialog.classList.toggle('has-rail', open);
    write(railKey, open);
    renderList();
    requestAnimationFrame(placeCompose);
  };
  const rowOf = node => rows().find(row => row.id === node.closest('[data-row]')?.dataset.row);
  const showAnchor = anchor => {
    if (!anchor?.path) return;
    if (anchor.path === route && ready) post({type: 'highlight', selector: anchor.selector || null});
    else { pendingHighlight = anchor.selector || null; navigate(anchor.path); }
  };
  list.addEventListener('click', async event => {
    const row = rowOf(event.target);
    if (event.target.closest('[data-empty-comment]')) { setMode('comment'); return; }
    if (event.target.closest('[data-empty-record]')) { record.click(); return; }
    if (event.target.closest('[data-empty-qa]')) { startQA(); return; }
    if (!row) return;
    if (event.target.closest('[data-row-toggle]')) {
      expanded = expanded === row.id ? null : row.id;
      renderList();
      if (expanded && row.thread?.anchor?.selector) showAnchor(row.thread.anchor);
    } else if (event.target.closest('[data-row-show]')) showAnchor(row.thread?.anchor);
    else if (event.target.closest('[data-rec-open]')) { row.rec.form = event.target.closest('[data-rec-open]').dataset.recOpen; renderList(); list.querySelector(`[data-row="${CSS.escape(row.id)}"] textarea`)?.focus(); }
    else if (event.target.closest('[data-rec-cancel]')) { row.rec.form = null; renderList(); }
    else if (event.target.closest('[data-rec-unqueue]')) { row.rec.state = 'new'; renderList(); }
  });
  list.addEventListener('input', event => {
    const row = rowOf(event.target);
    if (row?.rec && event.target.name && event.target.name in row.rec.draft) row.rec.draft[event.target.name] = event.target.value;
  });
  list.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target.closest('form')) { event.preventDefault(); event.target.closest('form').requestSubmit(); }
  });
  list.addEventListener('submit', async event => {
    event.preventDefault();
    const row = rowOf(event.target);
    if (!row) return;
    const form = event.target;
    if (form.matches('[data-row-reply]')) {
      const body = form.elements.body.value.trim();
      if (!body) return;
      try { await api('/api/message', {key, id: row.id, body}); form.reset(); refresh(); } catch (error) { status('off', error.message); }
    } else if (form.matches('[data-rec-form]')) {
      if (!row.rec.draft.title.trim() || !row.rec.draft.observed.trim()) { status('off', 'Give it a title and say what you saw, then add it.'); return; }
      row.rec.state = 'queued'; row.rec.form = null; renderList();
      status('ok', 'Ready to save. Save to the review when you have everything for this session.');
    } else if (form.matches('[data-rec-agent]')) {
      const rec = row.rec, note = rec.draft.note.trim(), id = `app-${rec.id}`;
      const anchor = {selector: '', path: rec.page, text: '', kind: rec.kind, still: rec.path};
      const text = [`${rec.kind === 'clip' ? 'A clip' : 'A still'} recorded in the running app`, `Page: ${app.upstream}${rec.page}`, `File: ${rec.path}`, '', note || '(no note)'].join('\n');
      try {
        await api('/api/send', {key, items: [{id, text, message: note || `Sent a ${rec.kind} of ${rec.page}.`, anchor}]});
        rec.thread = id; rec.form = null; expanded = id;
        status('ok', listening === false ? 'Sent. No agent is listening yet; it gets this when it continues the review.' : 'Sent to your agent.');
        refresh();
      } catch (error) { status('off', error.message); }
    }
  });
  $('[data-rec-save]').addEventListener('click', async () => {
    const queued = recs.filter(entry => entry.state === 'queued');
    try {
      const saved = await api('/api/evidence', {items: queued.map(entry => ({path: entry.path, page: entry.page, title: entry.draft.title, result: entry.draft.result, observed: entry.draft.observed, comment_id: entry.draft.comment_id}))});
      queued.forEach(entry => { entry.state = 'saved'; entry.revision = saved.revision; });
      status('ok', `Saved ${queued.length === 1 ? 'the recording' : `${queued.length} recordings`} to the review as revision ${saved.revision}.`);
      renderList();
    } catch (error) { status('off', error.message); }
  });
  $('[data-app-rail]').addEventListener('click', () => openRail(rail.hidden));
  const refresh = async () => {
    if (!key) return;
    try {
      const state = await api(`/api/state?key=${encodeURIComponent(key)}`);
      latestRevision = state.latest_revision || latestRevision;
      const signature = JSON.stringify([state.threads, state.listening]);
      if (signature !== refresh.last) {
        refresh.last = signature;
        threads = state.threads; listening = state.listening;
        renderList();
      }
      evaluateQA();
    } catch { /* the server may be restarting; try again on the next tick */ }
  };
  // A QA review can be running whether or not the App view is open, so this keeps checking.
  setInterval(refresh, 2500);
  setInterval(() => dialog.open && dialog.querySelectorAll('time[data-at]').forEach(node => { const text = time(node.dataset.at); if (node.textContent !== text) node.textContent = text; }), 30000);

  // --- a QA review in progress: the agent drives this tab --------------------------------------------
  // The QA conversation says where things are: sent (waiting for the agent), delivered (the agent is
  // working) and answered (done). While it runs, a banner says so and the view's own controls are
  // locked; the app stays usable, because the agent's input lands there too. When the agent's report
  // arrives, sharing stops, the app closes and the finish window gives the tab back.
  const qaDoneKey = key ? `dcr-qa-done:${key}` : null;
  const qaDone = () => new Set(read(qaDoneKey, []));
  const markQaDone = id => write(qaDoneKey, [...qaDone(), id].slice(-50));
  const banner = $('.dcr-qa-banner');
  let qaFirstLook = true, qaActive = null, latestRevision = null;
  const currentRevision = data?.review?.history?.revision || null;
  const qaRequests = () => Object.entries(threads).filter(([, thread]) => thread.anchor?.kind === 'request');
  const clipsSince = at => recs.filter(item => item.at >= at && item.driver === 'agent').length;
  const setDriving = entry => {
    qaActive = entry ? entry[0] : null;
    dialog.classList.toggle('is-agent-driving', !!entry);
    banner.hidden = !entry;
    if (!entry) return;
    if (!dialog.open) open();
    const [, thread] = entry;
    const sharing = recorder()?.status()?.ready;
    const started = thread.messages[0]?.at || '';
    const clips = clipsSince(started);
    $('[data-qa-share]').hidden = !!sharing;
    if (!sharing) {
      $('[data-qa-title]').textContent = 'Sharing stopped, so your agent cannot record';
      $('[data-qa-detail]').textContent = 'This happens when the page reloads. Share this tab again and your agent carries on.';
    } else if (thread.delivery === 'sent') {
      $('[data-qa-title]').textContent = 'Waiting for your agent to start the QA review';
      $('[data-qa-detail]').textContent = listening === false ? 'No agent is listening yet; it starts when your agent continues the review. Keep this tab open.' : 'It starts in a moment. Please leave this tab to it.';
    } else {
      $('[data-qa-title]').textContent = 'Your agent is running the QA review in this tab';
      $('[data-qa-detail]').textContent = "Please don't click or type here until it finishes. The results will appear here.";
    }
    $('[data-qa-progress]').textContent = clips ? `${clips} ${clips === 1 ? 'recording' : 'recordings'} so far` : '';
  };
  const finishQA = async ([id, thread]) => {
    markQaDone(id);
    setDriving(null);
    const started = thread.messages[0]?.at || '';
    const clips = clipsSince(started);
    try { if (recorder()?.status()?.ready) await recorder().end(); } catch { /* already stopped */ }
    if (dialog.open) dialog.close();
    const report = [...thread.messages].reverse().find(message => message.author === 'agent');
    const newer = latestRevision && currentRevision && latestRevision > currentRevision;
    done.querySelector('[data-done-summary]').textContent = newer
      ? `Your agent recorded ${clips || 'its'} ${clips === 1 ? 'recording' : 'recordings'} and saved them as revision ${latestRevision}, each on the comment it shows. They replace the previous QA review's recordings.`
      : 'Your agent finished. Its report is below; no new revision was saved.';
    done.querySelector('[data-done-report]').innerHTML = report && tools ? tools.markdown(report.body) : '';
    const openButtonDone = done.querySelector('[data-done-open]');
    openButtonDone.textContent = newer ? `See the clips in revision ${latestRevision}` : 'Back to the review';
    // The address is often already /#overview here, where assigning it would not load anything.
    openButtonDone.onclick = () => { if (newer) { history.replaceState(null, '', '/#overview'); location.reload(); } else done.close(); };
    done.showModal();
  };
  const evaluateQA = () => {
    // Requests already answered before this page loaded are history, not news.
    if (qaFirstLook) {
      qaFirstLook = false;
      qaRequests().filter(([, thread]) => thread.delivery === 'answered').forEach(([id]) => { if (!qaDone().has(id)) markQaDone(id); });
    }
    const finished = qaDone();
    const open = qaRequests().filter(([id]) => !finished.has(id));
    const live = open.find(([, thread]) => thread.delivery === 'sent' || thread.delivery === 'delivered');
    const answered = open.find(([, thread]) => thread.delivery === 'answered');
    if (live) setDriving(live);
    else if (answered) finishQA(answered);
    else setDriving(null);
  };
  $('[data-qa-stop]').addEventListener('click', async () => {
    const id = qaActive;
    if (!id) return;
    markQaDone(id);
    setDriving(null);
    try { await api('/api/message', {key, id, body: 'I stopped the QA review. Do not record anything more; reply with what you recorded so far.'}); } catch { /* the agent sees it on its next round */ }
    try { if (recorder()?.status()?.ready) await recorder().end(); } catch { /* already stopped */ }
    status('ok', 'QA review stopped. This tab is yours again.');
  });
  $('[data-qa-share]').addEventListener('click', async () => {
    try { await recorder().connectPane(pane); evaluateQA(); } catch (error) { status('off', shareError(error)); }
  });
  done.querySelector('[data-done-close]').addEventListener('click', () => done.close());

  // --- recording: this tab, cut down to the app ----------------------------------------------------
  // Record shares this tab the first time and starts at once; Stop puts the clip at the top of
  // On this app. Clips the agent records with `dcr record` land there too.
  const recorder = () => window.QARecorder;
  const record = $('[data-app-record]');
  const still = $('[data-app-still]');
  const renderRecorder = (state = recorder()?.status()) => {
    if (!state) { record.hidden = true; return; }
    const sharing = state.ready && state.pane;
    record.disabled = !!state.busy && !state.recording;
    $('[data-app-record-label]').textContent = state.recording ? `Stop ${clock(Date.now() - (state.startedAt || Date.now()))}` : 'Record';
    record.classList.toggle('is-recording', !!state.recording);
    record.title = state.recording ? 'Stop and keep this clip' : sharing ? 'Record a clip of the app' : 'Share this tab to record the app, with your pointer';
    still.hidden = !sharing;
    still.disabled = !!state.busy;
    $('.dcr-app-sharing').hidden = !sharing;
  };
  window.addEventListener('qa-recorder-state', event => renderRecorder(event.detail));
  // The agent's pointer is drawn in the app while the agent drives a shared recording.
  let agentPointer = false;
  const syncPointer = (state = recorder()?.status()) => {
    const on = !!(state && state.ready && state.pane && state.driver === 'agent');
    if (on !== agentPointer) { agentPointer = on; post({type: 'pointer', on}); }
  };
  window.addEventListener('qa-recorder-state', event => syncPointer(event.detail));
  const clipName = () => (route.replace(/[?#].*$/, '').split('/').filter(Boolean).join('-') || 'home').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);
  record.addEventListener('click', async () => {
    const rec = recorder(); if (!rec) return;
    const state = rec.status();
    try {
      if (state.recording) { await rec.stop(); return; }
      if (!(state.ready && state.pane)) {
        status('work', 'Choose this tab and Share. Recording starts right away and shows only the app.');
        await rec.connectPane(pane);
      }
      await rec.start(clipName());
      status('ok', 'Recording. Use the app, then press Stop.');
    } catch (error) { status('off', shareError(error)); }
  });
  still.addEventListener('click', async () => { try { await recorder().still(clipName()); } catch (error) { status('off', error.message); } });
  $('[data-app-unshare]').addEventListener('click', async () => { try { await recorder().end(); status('ok', 'Stopped sharing this tab.'); } catch (error) { status('off', error.message); } });
  // Chrome opens its share prompt only for the reader's own click on a visible tab; a click sent
  // by a tool, a refused prompt and anything else each get a sentence that says what to do.
  const shareError = error => {
    if (error?.name === 'InvalidStateError') return 'Chrome asks to share a tab only after your own click in this tab. Click Start QA review yourself, then Share.';
    if (error?.name === 'NotAllowedError') return 'Sharing was cancelled. Start QA review again and choose Share to let your agent record.';
    return error?.message || 'Could not share this tab.';
  };
  // Start QA review: the share prompt must come from the reader's own click, so it is asked here;
  // with this tab shared, the agent can record through `dcr record` without asking again.
  const startQA = async () => {
    const rec = recorder();
    if (!rec || !key) { status('off', 'This review cannot record. Serve it with dcr serve.'); return; }
    try {
      const state = rec.status();
      if (!(state.ready && state.pane)) {
        status('work', 'Choose this tab and Share, so your agent can record the app here.');
        await rec.connectPane(pane);
      }
      await api('/api/qa', {key, route});
      expanded = null;
      openRail(true);
      await refresh();
      status('ok', listening === false
        ? 'QA review requested. No agent is listening yet; it starts when your agent continues the review. Keep this tab open.'
        : 'Your agent is recording the review in this tab. Keep it in front and leave the pointer to it.');
    } catch (error) { status('off', shareError(error)); }
  };
  $('[data-start-qa]').addEventListener('click', startQA);

  window.addEventListener('qa-recorder-saved', event => {
    const saved = event.detail;
    if (!saved?.path || !/\.(webm|png)$/.test(saved.path) || /\/comment-[^/]*$/.test(saved.path)) return;
    const id = newId();
    recs.push({...saved, id, page: route, at: new Date().toISOString(), driver: recorder()?.status()?.driver || 'reader', state: 'new', form: null,
      draft: {title: `${saved.kind === 'clip' ? 'Clip' : 'Still'} of ${route.replace(/[?#].*$/, '')}`, result: 'passed', observed: '', comment_id: '', note: ''}});
    // The agent's recordings belong to the QA review; the banner tells that story.
    if (recs.at(-1).driver === 'agent') { renderList(); evaluateQA(); return; }
    expanded = `rec-${id}`;
    status('ok', saved.kind === 'clip' ? `Clip saved (${clock(saved.durationMs || 0)}). Send it to your agent or add it to the review.` : 'Still saved. Send it to your agent or add it to the review.');
    openRail(true);
  });

  // --- controls --------------------------------------------------------------------------------------
  input.addEventListener('input', () => { input.dataset.edited = '1'; });
  input.addEventListener('blur', () => { delete input.dataset.edited; input.value = route; });
  address.addEventListener('submit', event => { event.preventDefault(); delete input.dataset.edited; navigate(input.value.trim() || '/'); });
  $('[data-app-reload]').addEventListener('click', () => navigate(route));
  $('[data-app-close]').addEventListener('click', () => dialog.close());
  dialog.querySelectorAll('[data-app-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.appMode)));
  dialog.querySelectorAll('[data-app-width]').forEach(button => button.addEventListener('click', () => setWidth(button.dataset.appWidth)));
  dialog.addEventListener('keydown', event => {
    if (event.target.closest('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'c' && ready && !left) setMode('comment');
    else if (event.key === 'b') setMode('browse');
  });
  // Esc first closes a comment box, then leaves Comment mode, and only then closes the app.
  dialog.addEventListener('cancel', event => {
    if (qaActive) { event.preventDefault(); return; }
    if (picked) { event.preventDefault(); closeCompose(); }
    else if (mode === 'comment') { event.preventDefault(); setMode('browse'); }
  });
  dialog.addEventListener('close', () => { closeCompose(); setMode('browse'); history.replaceState(null, '', location.pathname + location.hash); });
  canvas.addEventListener('scroll', placeCompose);
  window.addEventListener('resize', placeCompose);
  const open = () => {
    if (!frame.src) { status('work', 'Loading the app'); navigate(app.start); }
    dialog.showModal();
    if (document.activeElement === input) dialog.focus();
    openRail(read(railKey, false));
    refresh();
  };
  $('[data-views]').innerHTML = viewsHTML('app');
  $('[data-views]').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) showView(button.dataset.view); });
  // For the Overview band: open the app, optionally straight into Comment or recording. Record must
  // run inside the reader's click, which still counts as their gesture for the share prompt.
  window.DCRApp = {
    app,
    open: (intent = 'browse') => {
      open();
      if (intent === 'comment') { if (ready && !left) setMode('comment'); else pendingMode = 'comment'; }
      if (intent === 'record') record.click();
      if (intent === 'qa') startQA();
    }
  };
  window.dispatchEvent(new Event('dcr-app-ready'));
  // A opens the app from anywhere in the review, Focus included, where the toolbar is hidden.
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'a' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    open();
  });

  setWidth(read(widthKey, 'fit'));
  setRoute(app.start);
  renderRecorder();
  // `dcr serve --app` prints a link with ?app, which opens straight into the app.
  if (new URLSearchParams(location.search).has('app')) open();
})();
