'use strict';
// "Try the change" on the Overview of a served review: the running app as a live miniature that
// opens the App view, and the changed templates with their preview state. Both are things a reader
// can do with the change itself, so they come right after What changed instead of in a quiet line.
(() => {
  const content = document.getElementById('content');
  const tools = window.ReviewTools;
  const live = window.LiveTools;
  let data;
  try { data = JSON.parse(document.getElementById('data').textContent); } catch { return; }
  const {snapshot, review} = data;
  const key = live ? live.progressKey(snapshot, review) : null;
  const token = document.querySelector('meta[name="qa-token"]')?.content;
  const appMeta = document.querySelector('meta[name="dcr-app"]');
  const app = appMeta ? JSON.parse(appMeta.content) : null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

  // Changed templates, one entry per component (its class and template together).
  const templates = [];
  const seenNames = new Set();
  (snapshot.files || []).filter(file => tools?.previewEligible(file)).forEach(file => {
    const name = file.path.split('/').pop().replace(/\.html\.erb$|\.rb$/, '');
    if (seenNames.has(name)) return;
    seenNames.add(name);
    templates.push({name, path: file.path});
  });
  if (!app && !templates.length) return;
  const reviewed = new Set((review.previews || []).filter(preview => preview.status === 'rendered').flatMap(preview => preview.files || []));
  let livePreviews = {};

  const band = document.createElement('section');
  band.className = 'dcr-try';
  band.setAttribute('aria-labelledby', 'dcr-try-title');
  const appHTML = app ? `
    <div class="dcr-try-app">
      <button type="button" class="dcr-try-mini" data-try="browse" aria-label="Open the running app">
        <span class="dcr-try-frame"><iframe tabindex="-1" aria-hidden="true" loading="lazy" title="Preview of the running app"></iframe></span>
        <span class="dcr-try-addr"><span class="dcr-try-dot" aria-hidden="true"></span>${esc(app.upstream.replace(/^https?:\/\//, ''))}${esc(app.start === '/' ? '' : app.start)}</span>
      </button>
      <div class="dcr-try-copy">
        <h3>Check it in the running app</h3>
        <p><strong>Start QA review</strong> and your agent records the flows behind the comments in this tab, with its pointer, and puts each clip on its comment. You share this tab once; then watch, or keep reading.</p>
        <div class="dcr-try-actions">
          <button type="button" class="act act-primary" data-try="qa">Start QA review</button>
          <button type="button" class="act act-quiet" data-try="browse">Open the app <kbd>A</kbd></button>
          <button type="button" class="act act-quiet" data-try="comment">Comment on it</button>
        </div>
      </div>
    </div>` : '';
  const previewsHTML = templates.length ? `
    <div class="dcr-try-previews">
      <h3>${templates.length === 1 ? 'One changed template' : `${templates.length} changed templates`}</h3>
      <p>See them rendered with example data, at phone, tablet or desktop width.</p>
      <ul class="dcr-try-templates"></ul>
      ${templates.length > 4 ? `<button type="button" class="dcr-try-link" data-try-all>All ${templates.length} in Previews</button>` : ''}
    </div>` : '';
  band.innerHTML = `<h2 id="dcr-try-title">Try the change</h2><div class="dcr-try-body${app && templates.length ? ' has-both' : ''}">${appHTML}${previewsHTML}</div>`;

  const stateOf = template => {
    const preview = livePreviews[template.path];
    if (preview?.status === 'ready' || reviewed.has(template.path)) return {tone: 'ready', text: 'Ready', action: 'View'};
    if (preview?.status === 'working') return {tone: 'working', text: 'Being built', action: 'Open'};
    if (preview?.status === 'requested') return {tone: 'requested', text: 'Asked for', action: 'Open'};
    if (preview?.status === 'failed') return {tone: 'failed', text: 'Could not be built', action: 'Open'};
    return {tone: 'none', text: 'Not previewed', action: 'Preview'};
  };
  const renderTemplates = () => {
    const list = band.querySelector('.dcr-try-templates');
    if (!list) return;
    list.innerHTML = templates.slice(0, 4).map(template => {
      const state = stateOf(template);
      return `<li><span class="stage-dot is-${state.tone === 'none' ? 'idle' : state.tone}" aria-hidden="true"></span><code title="${esc(template.path)}">${esc(template.name)}</code><span class="dcr-try-state">${esc(state.text)}</span><button type="button" data-try-preview="${esc(template.path)}">${esc(state.action)}</button></li>`;
    }).join('');
  };
  renderTemplates();

  band.addEventListener('click', event => {
    const trigger = event.target.closest('[data-try]');
    if (trigger) { window.DCRApp?.open(trigger.dataset.try); return; }
    const preview = event.target.closest('[data-try-preview]');
    if (preview) { window.ReviewPreviews?.show(preview.dataset.tryPreview); return; }
    if (event.target.closest('[data-try-all]')) document.querySelector('[data-open-previews], #previews-toggle, .previews-button')?.click();
  });

  // The miniature is the real app, shrunk and inert; it loads only when the band is on screen.
  const frame = band.querySelector('.dcr-try-frame iframe');
  const holder = band.querySelector('.dcr-try-frame');
  if (frame) {
    const size = () => { const scale = holder.clientWidth / 1280; frame.style.transform = `scale(${scale})`; };
    new ResizeObserver(size).observe(holder);
    new IntersectionObserver((entries, observer) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      frame.src = app.origin + app.start;
      observer.disconnect();
    }).observe(holder);
    frame.addEventListener('load', () => band.classList.add('is-running'));
  }

  // The band sits after What changed whenever the Overview is drawn; the review redraws #content.
  const holderOff = document.createElement('div');
  holderOff.hidden = true;
  holderOff.append(band);
  document.body.append(holderOff);
  const mount = () => {
    const intro = content?.querySelector('.overview-reading > .overview-intro');
    // The recorder card also keeps itself right after What changed; going after it (not racing it
    // for the same spot) keeps the two observers from moving each other forever.
    const anchor = intro?.nextElementSibling?.id === 'qa-panel' ? intro.nextElementSibling : intro;
    if (anchor) { if (anchor.nextElementSibling !== band) anchor.after(band); document.body.classList.add('dcr-has-try'); }
    else if (band.parentNode !== holderOff) { holderOff.append(band); document.body.classList.remove('dcr-has-try'); }
  };
  if (content) new MutationObserver(mount).observe(content, {childList: true, subtree: true});
  mount();

  // Preview states change while the agent builds them.
  const refresh = async () => {
    if (!key || !token || !templates.length || !band.isConnected || band.closest('[hidden]')) return;
    try {
      const response = await fetch(`/api/state?key=${encodeURIComponent(key)}`, {headers: {'X-QA-Token': token}});
      if (!response.ok) return;
      const state = await response.json();
      const next = JSON.stringify(state.previews || {});
      if (next === refresh.last) return;
      refresh.last = next;
      livePreviews = state.previews || {};
      renderTemplates();
    } catch { /* the server may be restarting */ }
  };
  refresh();
  setInterval(refresh, 4000);
})();
