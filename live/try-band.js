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
  // A served review with no app and no reason for none: QA needs the app, so the row says how to add it.
  const recorder = () => !app && !noApp && document.getElementById('qa-panel');
  if (!app && !noApp && !templates.length && !recorder() && !document.querySelector('.risk-fold')) return;
  const reviewed = new Set((review.previews || []).filter(preview => preview.status === 'rendered').flatMap(preview => preview.files || []));
  let livePreviews = {};

  const icon = name => (window.ReviewIcons?.[name] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  const band = document.createElement('section');
  band.className = 'dcr-try';
  band.setAttribute('aria-labelledby', 'dcr-try-title');
  // Each thing a reader can do with the change is one row: what it is, a few words on it, the ways in.
  const appHTML = app ? `
    <li class="dcr-try-row dcr-try-app">
      <span class="dcr-try-icon">${icon('video')}</span><strong class="dcr-try-do">In the app</strong>
      <span class="dcr-try-about"><span data-try-seen>Nothing recorded yet.</span><button type="button" data-try-shots title="The screenshots and recordings from the app" hidden>See them</button></span>
      <span class="dcr-try-more"><button type="button" data-try="qa" title="Your agent records the flows behind the comments, in this tab">Start QA review</button><button type="button" data-try="browse" title="${esc(app.upstream)} (A). Comment on it from there.">Open the app</button></span>
    </li>` : noApp ? `
    <li class="dcr-try-row dcr-try-none">
      <strong class="dcr-try-do">No running app</strong>
      <span class="dcr-try-about">${esc(noApp.charAt(0).toUpperCase() + noApp.slice(1).replace(/[.\s]+$/, ''))}, so this review has no QA review and no screenshots.</span>
    </li>` : '';
  const previewsHTML = templates.length ? `
    <li class="dcr-try-row dcr-try-previews">
      <span class="dcr-try-icon">${icon('layout-template')}</span><strong class="dcr-try-do">Previews</strong>
      <span class="dcr-try-about">${templates.length === 1 ? 'One changed template' : `${templates.length} changed templates`}</span>
      <span class="dcr-try-more"><button type="button" data-try-all>Open previews</button></span>
      <ul class="dcr-try-templates"></ul>
    </li>` : '';
  // For a theme that keeps the risk ranking as a row here rather than a card of its own: the ranking's
  // one line, unfolding its files under it; and QA, which needs the app in the review.
  const riskHTML = `
    <li class="dcr-try-line dcr-try-risk" hidden>
      <span class="dcr-try-icon">${icon('gauge')}</span><strong class="dcr-try-do">Risk ranking</strong>
      <span class="dcr-try-about" data-try-risk-line></span>
      <span class="dcr-try-more"><button type="button" data-try-risk aria-expanded="false">Show</button></span>
    </li>`;
  // Without the app in the review there is no QA review to start, and the row says how to get one.
  // (The older tab recorder stays one ⌘K away, as Record the app yourself.)
  const recordHTML = `
    <li class="dcr-try-line dcr-try-record" hidden>
      <span class="dcr-try-icon">${icon('video')}</span><strong class="dcr-try-do">QA review</strong>
      <span class="dcr-try-about">No app in this review. Serve it with <code>--app</code> to start one</span>
      <span class="dcr-try-more"></span>
    </li>`;
  band.innerHTML = `<h2 id="dcr-try-title">Try the change</h2><ul class="dcr-try-rows"><li class="dcr-try-head" aria-hidden="true"><span>item</span><span>now</span><span>next</span></li><li class="dcr-try-rule" aria-hidden="true"><span></span><span></span><span></span></li>${riskHTML}${appHTML}${recordHTML}${previewsHTML}</ul>`;

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

  let riskShown = false;
  band.addEventListener('click', event => {
    if (event.target.closest('[data-try-risk]')) { riskShown = !riskShown; mount(); return; }
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
    // The risk ranking's line, and its files under the row while shown.
    const fold = content?.querySelector('.overview-reading .risk-fold');
    const riskRow = band.querySelector('.dcr-try-risk');
    const line = fold?.querySelector('summary .risk-fold-line, summary span:not(.risk-fold-title)')?.textContent.trim() || '';
    if (riskRow.hidden !== !fold) riskRow.hidden = !fold;
    const riskLine = band.querySelector('[data-try-risk-line]');
    if (riskLine.textContent !== line) riskLine.textContent = line;
    const brief = content?.querySelector('.overview-reading .risk-brief');
    if (brief && brief.parentNode !== riskRow) { riskRow.querySelectorAll('.risk-brief').forEach(old => old.remove()); riskRow.append(brief); }
    // With only those two rows, a theme that keeps its own cards for them has nothing to show here.
    band.classList.toggle('dcr-try-theme-only', !app && !noApp && !templates.length);
    riskRow.classList.toggle('is-open', riskShown);
    const toggle = band.querySelector('[data-try-risk]');
    if (toggle.textContent !== (riskShown ? 'Hide' : 'Show')) { toggle.textContent = riskShown ? 'Hide' : 'Show'; toggle.setAttribute('aria-expanded', String(riskShown)); }
    const recordRow = band.querySelector('.dcr-try-record');
    if (recordRow.hidden !== !recorder()) recordRow.hidden = !recorder();
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
