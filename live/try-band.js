'use strict';
// "Try the change" in a served review: what a reader can do with the change itself (the risk ranking,
// QA, the screenshots, the previews, the running app), in one panel (LiveTools.tryPanelHTML). On the
// Overview it is pinned beside the reading column while the review area has room for both (the
// stylesheet decides, with a container query); elsewhere, or without room, it waits in its icon and
// opens over the page as the file's ··· menu does, and on a phone as a sheet from the bottom.
(() => {
  const content = document.getElementById('content');
  const area = document.querySelector('.review-area');
  const tools = window.ReviewTools;
  const live = window.LiveTools;
  let data;
  try { data = JSON.parse(document.getElementById('data').textContent); } catch { return; }
  if (!content || !area || !live) return;
  const {snapshot, review} = data;
  const appMeta = document.querySelector('meta[name="dcr-app"]');
  const app = appMeta ? JSON.parse(appMeta.content) : null;
  // Served with --no-app: the agent judged the change has nothing to see in the app, and says why.
  const noApp = app ? null : document.querySelector('meta[name="dcr-no-app"]')?.content || null;
  if (noApp) document.body.classList.add('dcr-no-app');
  // Changed templates, one per component (its class and template together).
  const templates = new Set((snapshot.files || []).filter(file => tools?.previewEligible(file)).map(file => file.path.split('/').pop().replace(/\.html\.erb$|\.rb$/, ''))).size;
  // A served review with no app and no reason for none: QA needs the app, so the panel says how to add it.
  const recorder = () => !app && !noApp && !!document.getElementById('qa-panel');
  const icon = name => (window.ReviewIcons?.[name] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  let storage = null;
  try { storage = window.localStorage; } catch { /* this visit only */ }
  const memory = live.tryMemory(storage, live.progressKey(snapshot, review));

  const panel = document.createElement('aside');
  panel.id = 'dcr-try';
  panel.className = 'dcr-try';
  panel.popover = 'auto';
  panel.setAttribute('aria-label', 'Try the change');
  content.after(panel);
  // Its way in, on the Overview only, where each theme keeps such things: an icon on the top strip, a
  // labelled button in the header, and on a phone an icon in the bar. One state for all three.
  const trigger = (id, className, html, place) => {
    const button = Object.assign(document.createElement('button'), {type: 'button', id, className, innerHTML: html, hidden: true});
    button.setAttribute('aria-controls', 'dcr-try');
    button.setAttribute('aria-expanded', 'false');
    button.dataset.tryToggle = '';
    place(button);
    return button;
  };
  const header = document.querySelector('.header-actions');
  const triggers = [
    trigger('try-show', 'try-show', icon('flask-conical'), button => document.getElementById('ledger-show')?.before(button)),
    trigger('try-header', 'header-button try-header', `${icon('flask-conical')}<span>Try<span class="try-header-rest"> the change</span></span>`, button => header?.insertBefore(button, document.getElementById('dcr-update') || document.getElementById('revision-navigation'))),
    trigger('bar-try', 'bar-try', icon('flask-conical'), button => document.getElementById('bar-review')?.before(button))
  ].filter(button => button.isConnected);

  let hidden = memory.hidden();
  let riskOpen = false;
  let drawn = null;
  let opener = null, closedAt = 0;
  const overview = () => document.body.classList.contains('on-overview');
  const room = () => getComputedStyle(panel).getPropertyValue('--try-room').trim() === '1';
  const phone = () => matchMedia('(max-width: 740px)').matches;
  const marks = () => ({shots: window.ReviewScreenshots?.count?.() || 0, previews: window.ReviewPreviews?.ready?.() || 0});
  const set = (node, name, value) => { if (node[name] !== value) node[name] = value; };
  const draw = () => {
    const html = live.tryPanelHTML({risk: window.ReviewRisk?.brief?.() || null, app, noApp, recorder: recorder(), shots: marks().shots, templates,
      previewsShort: window.ReviewPreviews?.short?.() || '', qaRunning: !!window.DCRApp?.running?.()}, {icon, riskOpen});
    if (html !== drawn) {
      const focused = panel.contains(document.activeElement) && document.activeElement.matches('[data-try-risk]');
      drawn = html;
      panel.innerHTML = html;
      if (focused) panel.querySelector('[data-try-risk]')?.focus({preventScroll: true});
    }
    document.body.classList.toggle('dcr-has-try', !!html);
    document.body.classList.toggle('dcr-try-hidden', hidden);
    const pinned = !!html && live.tryPinned({overview: overview(), room: room(), hidden});
    // It belongs to the Overview: reading code, its way in is not there, and leaving closes it.
    if ((pinned || !overview()) && panel.matches(':popover-open')) panel.hidePopover();
    const shown = pinned || panel.matches(':popover-open');
    // Seen open, what is in it now is no longer news; closed, the icon has a dot while there is some.
    const now = marks();
    const seen = memory.seen();
    if (shown && live.tryNews(now, seen)) memory.setSeen(now);
    const news = !shown && live.tryNews(now, memory.seen());
    const label = shown ? 'Hide Try the change' : `Show Try the change${news ? ', something new' : ''}`;
    triggers.forEach(button => {
      set(button, 'hidden', !html || !overview());
      button.classList.toggle('has-news', news);
      if (button.getAttribute('aria-expanded') !== String(shown)) button.setAttribute('aria-expanded', String(shown));
      if (button.title !== label) { button.title = label; button.setAttribute('aria-label', label); }
    });
  };

  triggers.forEach(button => button.addEventListener('click', () => {
    // Its own button, pressed while it is open, only closes it (the popover closed on the press).
    if (button === opener && Date.now() - closedAt < 300) return;
    const action = live.tryPress({overview: overview(), room: room(), hidden, open: panel.matches(':popover-open')});
    if (action === 'hide' || action === 'pin') { hidden = action === 'hide'; memory.setHidden(hidden); draw(); return; }
    if (action === 'close') { panel.hidePopover(); return; }
    opener = button;
    draw();
    panel.showPopover();
  }));
  // Under its button, right edges aligned, as the ··· menu; on a phone the stylesheet sets it at the bottom.
  panel.addEventListener('toggle', event => {
    if (event.newState !== 'open') {
      closedAt = Date.now();
      panel.style.removeProperty('top'); panel.style.removeProperty('left'); panel.style.removeProperty('max-height');
      if (panel.contains(document.activeElement) || document.activeElement === document.body) opener?.focus({preventScroll: true});
      draw();
      return;
    }
    if (!phone() && opener) {
      panel.style.maxHeight = `${innerHeight - 24}px`;
      const {top, left} = tools.popoverPlace(opener.getBoundingClientRect(), {width: panel.offsetWidth, height: panel.offsetHeight}, {width: innerWidth, height: innerHeight});
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    }
    draw();
    panel.querySelector('button:not([disabled])')?.focus({preventScroll: true});
  });
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-try-risk]')) { riskOpen = !riskOpen; draw(); return; }
    const action = event.target.closest('[data-try]');
    if (action) window.DCRApp?.open(action.dataset.try);
    // The rest (a file, the screenshots, the previews, Rank again) is the page's own handler; over the
    // page, the panel makes way for what it opens.
    if (event.target.closest('button:not([disabled])') && panel.matches(':popover-open')) panel.hidePopover();
  });
  // Up and down move through it, as in any menu.
  panel.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...panel.querySelectorAll('button:not([disabled]):not([hidden])')].filter(item => item.offsetParent);
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });

  // The review redraws #content as the reader moves and as the agent's work arrives (the ranking, the
  // screenshots, the previews); the review area's width says whether it has room.
  new MutationObserver(draw).observe(content, {childList: true, subtree: true});
  new MutationObserver(draw).observe(document.body, {attributes: true, attributeFilter: ['class']});
  if (typeof ResizeObserver === 'function') new ResizeObserver(draw).observe(area);
  draw();
})();
