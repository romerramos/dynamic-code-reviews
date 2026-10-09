'use strict';
// Injected by the review's app proxy into every HTML page of the app under review. It talks only
// to the review that frames it (checked origin both ways): reports the route, and in comment mode
// lets the reader pick an element, answering with a selector that survives small layout changes.
(() => {
  if (window.__dcrAgent) return;
  window.__dcrAgent = true;
  const REVIEW = '__DCR_REVIEW_ORIGIN__';
  const UPSTREAM_SECURE = __DCR_UPSTREAM_SECURE__;

  // The app is really served over https but reaches the browser over the proxy's http, so code
  // that derives a scheme from the page (Vite's dev client, Action Cable URLs built from
  // location) would open ws:// or http:// to its own other hosts. The original https page could
  // never make those insecure requests (mixed content), so upgrading them restores what the app
  // actually does. Requests to the proxy itself stay as they are.
  if (UPSTREAM_SECURE) {
    const upgrade = (url, from, to) => {
      try {
        const parsed = new URL(url, location.href);
        if (parsed.protocol === from && parsed.host !== location.host) { parsed.protocol = to; return parsed.toString(); }
      } catch { /* not a URL; leave it */ }
      return url;
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {construct: (Target, [url, ...rest]) => new Target(upgrade(String(url), 'ws:', 'wss:'), ...rest)});
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      return nativeFetch.call(this, typeof input === 'string' || input instanceof URL ? upgrade(String(input), 'http:', 'https:') : input, init);
    };
    if (window.EventSource) {
      const NativeEventSource = window.EventSource;
      window.EventSource = new Proxy(NativeEventSource, {construct: (Target, [url, ...rest]) => new Target(upgrade(String(url), 'http:', 'https:'), ...rest)});
    }
  }

  // A service worker registered through the proxy would outlive the review and serve stale pages.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new Error('Service workers are disabled inside the review'));
      navigator.serviceWorker.getRegistrations?.().then(list => list.forEach(item => item.unregister())).catch(() => {});
    }
  } catch { /* not available on this page */ }

  if (window.parent === window) return; // opened directly, not inside the review
  const post = (type, data = {}) => window.parent.postMessage({source: 'dcr-app', type, ...data}, REVIEW);
  const here = () => location.pathname + location.search + location.hash;

  let lastRoute = null;
  const route = () => {
    const path = here();
    if (path === lastRoute) return;
    lastRoute = path;
    post('route', {path, title: document.title});
  };
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) { const result = original.apply(this, args); setTimeout(route); return result; };
  }
  addEventListener('popstate', route);
  addEventListener('hashchange', route);
  document.addEventListener('turbo:load', route);
  // The review's Back and Forward act on this frame's own entries; the Navigation API in a frame
  // sees only those, so they can never take the review page itself back.
  const ownHistory = () => ({back: !!window.navigation?.canGoBack, forward: !!window.navigation?.canGoForward});
  window.navigation?.addEventListener('currententrychange', () => post('history', ownHistory()));

  // --- the agent's pointer, while the agent records ---------------------------------------------
  // An agent driving the app through the DevTools protocol sends real input events but never moves
  // the system pointer, so a recording would show the app changing by itself. While the agent
  // records (the review says so), the page draws a pointer at the coordinates of those same events,
  // live, inside the recorded frames: it can only be where the app was actually pointed at.
  let pointer = null;
  const pointerOn = on => {
    if (!on) { pointer?.remove(); pointer = null; return; }
    if (pointer) return;
    pointer = document.createElement('div');
    pointer.setAttribute('data-dcr-overlay', '');
    pointer.setAttribute('aria-hidden', 'true');
    pointer.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;transform:translate(-200px,-200px);transition:transform .18s cubic-bezier(.2,.7,.3,1);will-change:transform';
    pointer.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))"><path d="M4 2.5 4 19.5 8.6 15.4 11.5 21.6 14.3 20.3 11.4 14.2 17.6 14.2Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.append(pointer);
  };
  const pointAt = (x, y) => { if (pointer) pointer.style.transform = `translate(${x - 4}px, ${y - 2.5}px)`; };
  const ripple = (x, y) => {
    if (!pointer) return;
    const ring = document.createElement('div');
    ring.setAttribute('data-dcr-overlay', '');
    ring.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;z-index:2147483646;pointer-events:none;width:28px;height:28px;border-radius:50%;border:2px solid rgba(79,75,196,.9);background:rgba(79,75,196,.18);transform:scale(.4);opacity:1;transition:transform .35s ease-out,opacity .45s ease-out`;
    document.documentElement.append(ring);
    requestAnimationFrame(() => { ring.style.transform = 'scale(1.3)'; ring.style.opacity = '0'; });
    setTimeout(() => ring.remove(), 500);
  };
  addEventListener('mousemove', event => pointAt(event.clientX, event.clientY), true);
  addEventListener('mousedown', event => { pointAt(event.clientX, event.clientY); ripple(event.clientX, event.clientY); }, true);

  // --- picking an element ------------------------------------------------------------------------
  const css = value => (window.CSS?.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&'));
  const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  // Generated ids (React, Rails dom_id with numbers are fine; long hex or ":r1:" are not) change between renders.
  const stableId = id => id && !/^(?::|ember|react|radix|headlessui)|[0-9a-f]{8,}|\d{6,}/i.test(id);
  const attributeSelector = element => {
    for (const name of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
      const value = element.getAttribute(name);
      if (value && value.length <= 80) {
        const selector = `${element.localName}[${name}="${value.replace(/"/g, '\\"')}"]`;
        if (unique(selector)) return selector;
      }
    }
    return null;
  };
  // A stable handle for one element on its own: an id that is not generated, or a test/name/label attribute.
  const handle = element => {
    if (stableId(element.id) && unique(`#${css(element.id)}`)) return `${element.localName}#${css(element.id)}`;
    return attributeSelector(element);
  };
  const selectorFor = element => {
    const direct = handle(element);
    if (direct) return direct;
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      // Anchor the path at the nearest ancestor that has a stable handle of its own.
      const anchor = node !== element && handle(node);
      if (anchor) { parts.unshift(anchor); if (unique(parts.join(' > '))) break; parts.shift(); }
      let part = node.localName;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      if (parts.length > 1 && unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };

  let mode = 'browse';
  let box, label, hovered;
  const ensureBox = () => {
    if (box) return;
    box = document.createElement('div');
    label = document.createElement('div');
    for (const node of [box, label]) node.setAttribute('data-dcr-overlay', '');
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4f4bc4;background:rgba(79,75,196,.08);border-radius:3px;transition:all .06s ease-out;display:none';
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;background:#4f4bc4;color:#fff;font:600 11px/1.5 ui-monospace,Menlo,monospace;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    document.documentElement.append(box, label);
  };
  const outline = element => {
    ensureBox();
    if (!element) { box.style.display = label.style.display = 'none'; return; }
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {display: 'block', left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px`});
    label.textContent = element.localName + (element.id ? `#${element.id}` : element.classList[0] ? `.${element.classList[0]}` : '');
    Object.assign(label.style, {display: 'block', left: `${Math.max(rect.left, 0)}px`, top: `${rect.top > 22 ? rect.top - 22 : rect.bottom + 4}px`});
  };
  // Clicking an icon or label inside a control means the control.
  const CONTROL = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="option"]';
  const target = event => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.hasAttribute('data-dcr-overlay')) return null;
    const control = element.closest(CONTROL);
    return control && control !== element && /^(i|svg|path|use|span|img|b|strong|em|small)$/.test(element.localName) ? control : element;
  };
  const onMove = event => { hovered = target(event); outline(hovered || tracked); };
  const swallow = event => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  const onClick = event => {
    const element = target(event);
    swallow(event);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    post('pick', {
      selector: selectorFor(element), path: here(), title: document.title,
      tag: element.localName, text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, viewport: {width: innerWidth, height: innerHeight}
    });
  };
  const onKey = event => { if (event.key === 'Escape') { swallow(event); post('mode-exit'); } };
  const setMode = next => {
    if (next === mode) return;
    mode = next;
    const on = mode === 'comment';
    for (const [type, handler] of [['mousemove', onMove], ['click', onClick], ['mousedown', swallow], ['mouseup', swallow], ['submit', swallow], ['keydown', onKey]]) {
      (on ? addEventListener : removeEventListener)(type, handler, true);
    }
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on && !tracked) outline(null);
  };
  // The highlighted element's box follows the app's scrolling, so the review can keep its
  // comment box next to it.
  let tracked = null, frame = 0;
  const rectOf = element => { const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; };
  const report = () => { frame = 0; if (tracked?.isConnected) { outline(tracked); post('rect', {rect: rectOf(tracked), viewport: {width: innerWidth, height: innerHeight}}); } };
  const follow = () => { if (tracked && !frame) frame = requestAnimationFrame(report); };
  addEventListener('scroll', follow, true);
  addEventListener('resize', follow);
  const highlight = (selector, scroll = true) => {
    let element = null;
    try { element = selector ? document.querySelector(selector) : null; } catch { /* invalid selector */ }
    tracked = element;
    if (element && scroll) element.scrollIntoView({block: 'center', behavior: 'smooth'});
    setTimeout(() => { outline(element); if (element) report(); }, element && scroll ? 350 : 0);
    post('highlight-result', {selector, found: !!element});
  };

  addEventListener('message', event => {
    if (event.origin !== REVIEW || event.source !== window.parent || event.data?.source !== 'dcr-review') return;
    const message = event.data;
    if (message.type === 'mode') setMode(message.mode === 'comment' ? 'comment' : 'browse');
    else if (message.type === 'highlight') highlight(message.selector, message.scroll !== false);
    else if (message.type === 'pointer') pointerOn(!!message.on);
    else if (message.type === 'hello') post('ready', {path: here(), title: document.title, left: document.querySelector('meta[name="dcr-left"]')?.content || null, ...ownHistory()});
    else if (message.type === 'back' && window.navigation?.canGoBack) window.navigation.back();
    else if (message.type === 'forward' && window.navigation?.canGoForward) window.navigation.forward();
  });
  addEventListener('scroll', () => { if (mode === 'comment' && hovered) outline(hovered); }, true);

  const ready = () => { lastRoute = here(); post('ready', {path: lastRoute, title: document.title, left: document.querySelector('meta[name="dcr-left"]')?.content || null, ...ownHistory()}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true});
  else ready();
})();
