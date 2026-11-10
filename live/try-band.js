'use strict';
// "Try the change" on the Overview of a served review: what a reader can do with the change itself,
// one row each (a QA review and the running app, the changed templates and their previews).
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
  // Served with --no-app: the agent judged the change has nothing to see in the app, and says why.
  const noApp = app ? null : document.querySelector('meta[name="dcr-no-app"]')?.content || null;
  if (noApp) document.body.classList.add('dcr-no-app');
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
  if (!app && !noApp && !templates.length) return;
  const reviewed = new Set((review.previews || []).filter(preview => preview.status === 'rendered').flatMap(preview => preview.files || []));
  let livePreviews = {};

  const band = document.createElement('section');
  band.className = 'dcr-try';
  band.setAttribute('aria-labelledby', 'dcr-try-title');
  // Each thing a reader can do with the change is one row: what it is, a few words on it, the ways in.
  const appHTML = app ? `
    <li class="dcr-try-row dcr-try-app">
      <strong class="dcr-try-do">In the app</strong>
      <span class="dcr-try-about" data-try-seen>Nothing recorded yet.</span>
      <span class="dcr-try-more"><button type="button" data-try-shots hidden>View</button><button type="button" data-try="qa" title="Your agent records the flows behind the comments, in this tab">Start QA review</button><button type="button" data-try="browse" title="${esc(app.upstream)}">Open it <kbd>A</kbd></button><button type="button" data-try="comment">Comment on it</button></span>
    </li>` : noApp ? `
    <li class="dcr-try-row dcr-try-none">
      <strong class="dcr-try-do">No running app</strong>
      <span class="dcr-try-about">${esc(noApp.charAt(0).toUpperCase() + noApp.slice(1).replace(/[.\s]+$/, ''))}, so this review has no QA review and no screenshots.</span>
    </li>` : '';
  const previewsHTML = templates.length ? `
    <li class="dcr-try-row dcr-try-previews">
      <button type="button" class="dcr-try-do" data-try-all>Previews</button>
      <span class="dcr-try-about">${templates.length === 1 ? 'One changed template' : `${templates.length} changed templates`}, rendered with example data.</span>
      <ul class="dcr-try-templates"></ul>
    </li>` : '';
  band.innerHTML = `<h2 id="dcr-try-title">Try the change</h2><ul class="dcr-try-rows">${appHTML}${previewsHTML}</ul>`;

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
    if (event.target.closest('[data-try-shots]')) { document.querySelector('.ui-changes [data-open-shots]')?.click(); return; }
    const trigger = event.target.closest('[data-try]');
    if (trigger) { window.DCRApp?.open(trigger.dataset.try); return; }
    const preview = event.target.closest('[data-try-preview]');
    if (preview) { window.ReviewPreviews?.show(preview.dataset.tryPreview); return; }
    if (event.target.closest('[data-try-all]')) document.querySelector('[data-open-previews], #previews-toggle, .previews-button')?.click();
  });

  // The band sits after the summary whenever the Overview is drawn; the review redraws #content.
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
    // What the review already shows of the app (screenshots, QA recordings) is said in the app's row.
    const seen = content?.querySelector('.ui-changes .shot-stack-text span')?.textContent.split('.')[0].trim() || '';
    const about = band.querySelector('[data-try-seen]'), view = band.querySelector('[data-try-shots]');
    if (about && about.textContent !== (seen || 'Nothing recorded yet.')) about.textContent = seen || 'Nothing recorded yet.';
    if (view && view.hidden !== !seen) view.hidden = !seen;
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
