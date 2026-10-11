'use strict';
// Conversation layer for a review served by `dcr serve`. It never touches the review's own
// script: it saves the review's progress to the server, decorates the comment cards the
// review already renders, and fills the footer of the review's right-hand "Your review" panel. The saved offline
// report does not load this file.
(() => {
  const {snapshot, review} = JSON.parse(document.getElementById('data').textContent);
  const token = document.querySelector('meta[name="qa-token"]').content;
  const tools = globalThis.LiveTools;
  const key = tools.progressKey(snapshot, review);
  const content = document.getElementById('content');
  let threads = {};
  let rev = -1;
  let online = true;
  let latest = null;
  let listening; // is an agent waiting for messages? undefined: an older server that cannot say
  let listener = null; // which agent is listening (claude, codex, ...), when it said
  let listenerModel = null; // {model, effort} it said it runs on
  const openOpinions = new Map(); // comment id -> the agents whose opinions are open
  const baseTitle = document.title;
  // Agent messages the reader has been shown. First visit to a review marks the history as seen,
  // so only what arrives after that is announced.
  const seenKey = `dcr-seen:${key}`;
  let seen = new Set();
  let seenKnown = false;
  try { const stored = localStorage.getItem(seenKey); if (stored) { seen = new Set(JSON.parse(stored)); seenKnown = true; } } catch { /* announce nothing twice this session instead */ }
  const saveSeen = () => { try { localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500))); } catch { /* session only */ } };
  const announced = new Set();
  let previews = {};          // path -> status (requested, working, ready, failed)
  const previewHtml = new Map(); // path -> {ready_at, html}, fetched once per build
  const previewsAnnounced = new Set();
  const drafts = new Map(); // reply text survives the review re-rendering its cards
  // Adversaries: other agents that check the review. Chosen in the agent card, kept by the server
  // for every review on this computer. A question asks them only when its + is ticked, and every
  // message starts unticked, so nothing spends the reviewer's accounts by accident.
  let adversaries = [];
  let catalog = null; // the agent CLIs on this computer, fetched when the agent card opens
  let catalogError = '';
  const withAdversaries = new Set(); // thread ids whose next message asks the adversaries too
  const askable = () => tools.activeAdversaries(adversaries, listener, catalog);
  const COMPOSER = 'composer'; // the + in the code's composer, before its comment has an id
  // Everything here lives inside the observed #content, so write only real changes or the
  // observer would re-trigger itself.
  const set = (node, property, value) => { if (node[property] !== value) node[property] = value; };

  const api = async (path, body) => {
    const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'X-QA-Token': token, ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const saved = () => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
  const comments = () => tools.allComments(review, saved());
  const resolved = () => saved().resolvedComments || [];

  // --- progress is kept by the server, so it survives a restart and a cleared browser -----
  // Display settings belong to the reviewer, not to this review, so they have their own route.
  const settingsKey = 'dynamic-review:settings';
  const pushable = name => name !== settingsKey && /^dynamic-review:[A-Za-z0-9_.:-]{1,300}$/.test(name);
  const timers = new Map();
  const push = name => {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      let blob;
      try { blob = JSON.parse(localStorage.getItem(name)); } catch { return; }
      if (blob && typeof blob === 'object' && !Array.isArray(blob)) api('/api/state', {key: name, blob}).catch(() => {});
    }, 400));
  };
  let settingsTimer;
  const pushSettings = () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      try { api('/api/settings', JSON.parse(localStorage.getItem(settingsKey))).catch(() => {}); } catch { /* nothing valid to save */ }
    }, 400);
  };
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    realSetItem.call(this, name, value);
    if (this !== localStorage) return;
    if (pushable(name)) push(name);
    else if (name === settingsKey) pushSettings();
  };
  try { Object.keys(localStorage).filter(pushable).forEach(push); } catch { /* storage unavailable */ }

  // A short confirmation, in the review's own toast.
  const flash = message => {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.hidden = false;
    toast.textContent = message;
    setTimeout(() => { toast.hidden = true; }, 3500);
  };
  // The one way a comment reaches the agent: its captured code, the comment and an optional note.
  const sendComment = async (id, note = '') => {
    const comment = comments().find(entry => entry.id === id);
    if (!comment) throw new Error('This comment is not part of the review.');
    if (note) await api('/api/message', {key, id, body: note});
    const also = takeAdversaries(id);
    await api('/api/send', {key, items: [{id, text: tools.sendText(snapshot, review, comment, note, threads[id])}], adversaries: also.length > 0});
    await refresh();
    return also;
  };
  // The adversaries a message to this thread asks too, if its + is ticked; unticks it either way.
  const takeAdversaries = id => {
    const asked = withAdversaries.has(id) ? askable() : [];
    withAdversaries.delete(id);
    return asked;
  };
  const sentWith = (text, asked) => asked.length ? `${text.replace(/\.$/, '')}; ${tools.names(asked.map(entry => tools.agentInfo(entry.agent).name))} answer${asked.length > 1 ? '' : 's'} beside it.` : text;

  // --- thread cards ------------------------------------------------------------------------
  // The conversation under a comment is a plain thread: who, when, then the text. A line above it
  // says what is happening (sent, being worked on, replied). On an Overview card the one action
  // sits in the card's footer beside Copy and Resolve; in the diff popover it ends the thread.
  // In Your review the thread is narrow and always ready to answer: the comment it started from,
  // then the messages, then a reply field that grows as you type (⌘/Ctrl Enter sends).
  // The comment a conversation is about, as its first message: who wrote it, what kind it is, and
  // the whole comment (long ones start folded). The title and place are already in the bar above.
  const quoteHTML = comment => {
    if (!comment) return '';
    const text = (comment.discussion || '').trim();
    const avatar = comment.personal ? '<span class="dcr-avatar" aria-hidden="true">Y</span>' : tools.avatarHTML(comment.agent || null);
    const who = comment.personal ? 'You' : comment.agent ? tools.escape(tools.agentInfo(comment.agent).name) : 'Review';
    const kind = (comment.audience === 'agent' ? 'question for your agent' : [comment.label, comment.decoration].filter(Boolean).join(' · ')).replace(/^./, letter => letter.toUpperCase());
    const long = text.length > 320 || text.split(/\n\s*\n/).length > 2;
    const body = text ? `<div class="dcr-body${long ? ' is-clamped' : ''}">${tools.markdown(text)}</div>${long ? '<button type="button" class="dcr-more">Show more</button>' : ''}` : '';
    return `<article class="dcr-msg dcr-origin${comment.personal ? ' dcr-you' : ' dcr-agent'}">${avatar}<div class="dcr-msg-main"><header class="dcr-msg-head"><strong>${who}</strong>${comment.personal ? '' : tools.modelHTML(comment)}<span class="dcr-role">${tools.escape(kind)}</span></header>${body}</div></article>`;
  };
  const advToggleHTML = '<button type="button" class="dcr-adv-toggle" data-dcr-adv hidden aria-pressed="false"></button>';
  const composeHTML = () => `<form class="dcr-reply dcr-compose" hidden><textarea rows="1" aria-label="Reply to your agent" placeholder="Reply to your agent"></textarea>${advToggleHTML}<button type="submit" class="dcr-send" aria-label="Send reply" title="Send reply (⌘ Enter)">${ico('send')}</button></form>`;
  const cardBlock = (id, variant, comment) => {
    const block = document.createElement('div');
    block.className = `dcr-thread dcr-${variant}`;
    block.dataset.dcr = id;
    block.innerHTML = variant === 'ledger'
      ? `<div class="dcr-scroll">${quoteHTML(comment)}<div class="dcr-convo"></div><div class="dcr-state" role="status" aria-live="polite"></div><div class="dcr-opinions-slot"></div></div>${composeHTML()}`
      : `<div class="dcr-state" role="status" aria-live="polite"></div><div class="dcr-convo"></div><div class="dcr-opinions-slot"></div><form class="dcr-reply" hidden><textarea rows="3" aria-label="Reply to your agent" placeholder="Reply to your agent"></textarea><div class="dcr-actions"><button type="submit" class="btn btn-sm btn-primary">Send reply</button><button type="button" class="btn btn-sm btn-ghost" data-dcr-cancel>Cancel</button>${advToggleHTML}</div></form>${variant === 'popover' ? `<div class="dcr-actions"><button type="button" class="btn btn-sm btn-primary" data-dcr-act data-dcr-for="${tools.escape(id)}"></button></div>` : ''}`;
    block.querySelector('textarea').value = drafts.get(id) || '';
    return block;
  };
  const actionButtons = id => document.querySelectorAll(`[data-dcr-act][data-dcr-for="${CSS.escape(id)}"]`);
  // The + that asks the adversaries too: their marks, grey until ticked. Shown only when some can answer.
  const syncAdvToggles = (toggles, id, show) => {
    const asked = askable();
    const on = withAdversaries.has(id);
    const who = tools.names(asked.map(entry => tools.agentInfo(entry.agent).name));
    const html = `<span class="dcr-adv-plus" aria-hidden="true">+</span>${tools.facesHTML(asked.map(entry => entry.agent), 3)}`;
    toggles.forEach(toggle => {
      set(toggle, 'hidden', !show || !online || !asked.length);
      if (toggle.dataset.html !== html) { toggle.innerHTML = html; toggle.dataset.html = html; }
      toggle.dataset.dcrAdvFor = id;
      if (toggle.getAttribute('aria-pressed') !== String(on)) toggle.setAttribute('aria-pressed', String(on));
      const label = on ? `${who} will answer too. Click to ask only your agent.` : `Also ask ${who}`;
      if (toggle.title !== label) { toggle.title = label; toggle.setAttribute('aria-label', label); }
    });
  };
  const stateHTML = (model, at) => model
    ? `${model.agent ? tools.avatarHTML(model.agent, 'dcr-face-sm dcr-thinking') : `<span class="dcr-dot dcr-tone-${model.tone}" aria-hidden="true"></span>`}<span>${tools.escape(model.text)}</span>${model.typing ? '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}${at ? `<time data-at="${tools.escape(at)}">${tools.escape(tools.relativeTime(at))}</time>` : ''}`
    : '';
  // Long answers start clamped; the button appears only when something is actually hidden.
  const clampLong = root => root.closest('.dcr-ledger') || root.querySelectorAll('.dcr-body').forEach(body => {
    if (body.dataset.clamped || !body.offsetParent) return; // measure only what is on screen
    body.dataset.clamped = '1';
    const line = parseFloat(getComputedStyle(body).lineHeight) || 24;
    if (body.scrollHeight > line * 9) {
      body.classList.add('is-clamped');
      body.after(Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-more', textContent: 'Show more'}));
    }
  });
  const refreshBlock = block => {
    const id = block.dataset.dcr;
    const ledger = block.classList.contains('dcr-ledger');
    const thread = threads[id];
    const sent = !!thread && (thread.live || thread.delivery !== 'draft');
    // The DOM re-serialises markup (an escaped quote comes back as a quote), so compare the
    // string that was set, not innerHTML, or the observer would re-trigger itself forever.
    const convo = block.querySelector('.dcr-convo');
    const html = tools.messagesHTML(thread, {seen, agent: listener});
    const opinions = tools.opinionsHTML(thread, {open: [...(openOpinions.get(id) || [])], seen});
    // Keyed on the messages, not their text: "2 min ago" changes by itself and must not redraw.
    const signature = (thread?.messages || []).map(message => message.id + (message.author === 'agent' && !seen.has(message.id) ? '!' : '')).join('|');
    const model = online ? tools.statusModel(thread, listening, Date.now(), listener) : {tone: 'off', text: 'The review server stopped. Restart `dcr serve` to send or receive.'};
    // The reply carries its own time; the status line only says that it came.
    // In Your review the row already says it replied; under the thread only work in progress shows.
    const status = ledger && model?.tone === 'done' ? '' : stateHTML(model, '');
    const statusSignature = status ? `${model.tone}|${model.text}` : '';
    const form = block.querySelector('.dcr-reply');
    if (ledger) {
      set(form, 'hidden', !sent);
      const field = form.querySelector('textarea');
      set(field, 'disabled', !online);
      set(field, 'placeholder', online ? 'Reply to your agent' : 'The review server stopped');
      set(form.querySelector('.dcr-send'), 'disabled', !online);
    } else if (!sent && !form.hidden) form.hidden = true;
    block.classList.toggle('has-content', !!(html || status || opinions || !form.hidden));
    const slot = block.querySelector('.dcr-opinions-slot');
    if (slot.dataset.html !== opinions) { slot.innerHTML = opinions; slot.dataset.html = opinions; }
    if (convo.dataset.sig !== signature) {
      // A chat follows new messages, unless you have scrolled up to read.
      const scroller = ledger && block.querySelector('.dcr-scroll');
      const following = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      convo.innerHTML = html; convo.dataset.sig = signature; watchMessages(convo);
      if (following) scroller.scrollTop = scroller.scrollHeight;
    }
    clampLong(convo);
    const stateEl = block.querySelector('.dcr-state');
    if (stateEl.dataset.sig !== statusSignature) { stateEl.innerHTML = status; stateEl.dataset.sig = statusSignature; }
    syncAdvToggles(block.querySelectorAll('.dcr-reply .dcr-adv-toggle'), id, true);
    actionButtons(id).forEach(button => {
      // Before the first ask, its + sits beside Ask agent; after it, in the reply field.
      if (!button.nextElementSibling?.matches('.dcr-adv-toggle')) button.insertAdjacentHTML('afterend', advToggleHTML);
      syncAdvToggles([button.nextElementSibling], id, !sent);
      set(button, 'textContent', sent ? 'Reply' : 'Ask agent');
      set(button, 'disabled', !online);
      button.classList.toggle('btn-primary', !sent);
      button.classList.toggle('dcr-act-reply', sent);
      button.classList.remove('btn-soft');
    });
    if (block.classList.contains('dcr-popover')) widenPopover();
  };
  const decorate = () => {
    document.querySelectorAll('#content article.review-thread[data-thread-id]').forEach(card => {
      const id = card.dataset.threadId;
      if (!card.querySelector(':scope > .dcr-thread')) {
        const block = cardBlock(id, 'card');
        const footer = card.querySelector(':scope > .thread-footer');
        footer ? footer.before(block) : card.append(block);
      }
      const actions = card.querySelector('.comment-actions');
      if (actions && !actions.querySelector('[data-dcr-act]')) {
        actions.prepend(Object.assign(document.createElement('button'), {type: 'button', className: 'btn btn-sm btn-primary dcr-card-act'}));
        actions.firstChild.dataset.dcrAct = '1';
        actions.firstChild.dataset.dcrFor = id;
      }
    });
    document.querySelectorAll('.dcr-thread').forEach(refreshBlock);
  };

  // --- marking what you have read -------------------------------------------------------------------
  // An agent message counts as read once it has been on screen for a moment.
  const dwell = new WeakMap();
  const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => entries.forEach(entry => {
    const node = entry.target;
    clearTimeout(dwell.get(node));
    if (!entry.isIntersecting || document.hidden) return;
    dwell.set(node, setTimeout(() => {
      const id = node.dataset.msg;
      if (id && !seen.has(id)) { seen.add(id); saveSeen(); refreshUnread(); node.querySelector('.dcr-new')?.remove(); }
    }, 1200));
  }), {threshold: 0.6}) : null;
  const watchMessages = root => { if (watcher) root.querySelectorAll('.dcr-msg.dcr-agent').forEach(node => watcher.observe(node)); };

  document.addEventListener('input', event => {
    const field = event.target.closest('.dcr-thread textarea');
    if (!field) return;
    const id = field.closest('.dcr-thread').dataset.dcr;
    drafts.set(id, field.value);
    // The same reply may be open on the card and in Your review: keep them one draft.
    document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"] textarea`).forEach(other => { if (other !== field) other.value = field.value; });
  });
  // The block that shows a comment's conversation: in its card, or in the popover.
  const blockFor = button => button.closest('.dcr-thread') || button.closest('article, .popover-comment')?.querySelector('.dcr-thread');
  document.addEventListener('click', async event => {
    const chip = event.target.closest('[data-dcr-opinion]');
    if (chip) {
      const id = chip.closest('.dcr-thread').dataset.dcr;
      const agent = chip.dataset.dcrOpinion;
      const open = openOpinions.get(id) || new Set();
      if (open.has(agent)) open.delete(agent);
      else {
        open.add(agent);
        const opinion = threads[id]?.opinions?.[agent];
        if (opinion?.id && !seen.has(opinion.id)) { seen.add(opinion.id); saveSeen(); }
      }
      openOpinions.set(id, open);
      document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"]`).forEach(refreshBlock);
      return;
    }
    const more = event.target.closest('.dcr-more');
    if (more) {
      const body = more.previousElementSibling;
      const open = body.classList.toggle('is-open');
      more.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    const cancel = event.target.closest('[data-dcr-cancel]');
    if (cancel) { const block = cancel.closest('.dcr-thread'); block.querySelector('.dcr-reply').hidden = true; refreshBlock(block); return; }
    const advToggle = event.target.closest('.dcr-adv-toggle');
    if (advToggle) {
      const id = advToggle.dataset.dcrAdvFor;
      if (!withAdversaries.delete(id)) withAdversaries.add(id);
      if (id === COMPOSER) syncComposerAdv();
      else document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"]`).forEach(refreshBlock);
      return;
    }
    const button = event.target.closest('[data-dcr-act]');
    if (!button) return;
    const id = button.dataset.dcrFor;
    const thread = threads[id];
    const block = blockFor(button);
    if (thread && (thread.live || thread.delivery !== 'draft')) {
      // Already with the agent: open the reply box.
      const form = block?.querySelector('.dcr-reply');
      if (!form) return;
      form.hidden = !form.hidden;
      refreshBlock(block);
      if (!form.hidden) form.querySelector('textarea').focus();
      return;
    }
    button.disabled = true;
    try {
      const asked = await sendComment(id);
      flash(sentWith(tools.statusModel(threads[id], listening)?.text || 'Sent to your agent.', asked));
    } catch (error) { flash(error.message); }
    finally { button.disabled = !online; }
  });
  document.addEventListener('submit', async event => {
    const form = event.target.closest('.dcr-reply');
    if (!form) return;
    event.preventDefault();
    const block = form.closest('.dcr-thread');
    const id = block.dataset.dcr;
    const field = form.querySelector('textarea');
    const text = field.value.trim();
    if (!text) { field.focus(); return; }
    if (form.querySelector('[type="submit"]').disabled) return; // ⌘ Enter while the last reply is still sending
    form.querySelector('[type="submit"]').disabled = true;
    const ledger = block.classList.contains('dcr-ledger');
    try {
      const asked = takeAdversaries(id);
      await api('/api/message', {key, id, body: text, adversaries: asked.length > 0});
      drafts.delete(id);
      document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"] textarea`).forEach(other => { other.value = ''; });
      if (!ledger) form.hidden = true;
      await refresh();
      // In Your review the conversation itself shows the reply and what happens next.
      if (!ledger) flash(sentWith(tools.statusModel(threads[id], listening)?.text || 'Reply sent to your agent.', asked));
      else if (field.isConnected) { field.focus(); const scroller = block.querySelector('.dcr-scroll'); scroller.scrollTop = scroller.scrollHeight; }
    } catch (error) { flash(error.message); }
    finally { form.querySelector('[type="submit"]').disabled = !online; }
  });
  document.addEventListener('keydown', event => {
    const field = event.target.closest?.('.dcr-reply textarea');
    if (field && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); field.form.requestSubmit(); }
  });

  // Rank again: the agent redoes the Risk ranking; the page shows it ranking until the new one arrives.
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-risk-redo]');
    if (!button) return;
    button.disabled = true;
    try {
      await api('/api/risk-ranking', {key});
      window.ReviewRisk?.set({requested: true});
      flash(listening === false ? 'Asked for a new risk ranking. Your agent ranks the files when it continues the review.' : 'Asked your agent to rank the risky files again.');
    } catch (error) { flash(error.message); button.disabled = false; }
  });

  // --- the Overview panel ------------------------------------------------------------------
  const panel = document.createElement('section');
  panel.id = 'dcr-panel';
  panel.setAttribute('aria-label', 'Live review');
  const ico = name => (window.ReviewIcons?.[name] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  panel.innerHTML = `<p class="dcr-foot-status" role="status"><span class="dcr-dot" aria-hidden="true"></span><span class="dcr-summary"></span></p>
    <button type="button" class="act act-gh act-block" data-gh-finish hidden>${ico('check')}<span>Finish your review</span><b class="act-count"></b></button>
    <button type="button" class="act act-primary act-block" data-open-send>${ico('send')}<span>Review and send</span><b class="act-count"></b></button>
    <div class="dcr-foot-row"><button type="button" class="act act-secondary" data-dcr-export title="Download one offline file with your comments, the replies and any recordings">${ico('download')}Export</button><button type="button" class="act act-secondary" data-dcr-finish title="Send anything unsent and tell your agent this round is done">${ico('check-check')}Finish with agent</button></div>
    <p class="dcr-note" aria-live="polite"></p>`;
  panel.dataset.liveFooter = '1';
  const holder = document.createElement('div');
  holder.hidden = true;
  holder.append(panel);
  document.body.append(holder);
  // The ledger rewrites its footer when it renders, so re-attach after every change to it.
  const mount = () => {
    const footer = document.getElementById('ledger-footer');
    if (footer && panel.parentNode !== footer) footer.replaceChildren(panel);
    else if (!footer && panel.parentNode !== holder) holder.append(panel);
  };
  const renderPanel = () => {
    const summary = tools.summary(comments(), threads, resolved());
    const mine = comments().filter(comment => comment.personal).length;
    const parts = [];
    const onGitHub = Object.keys(ghData.posted || {}).length;
    if (!online) parts.push('Server stopped');
    else if (!mine && !summary.waiting && !summary.answered && !ghPendingIds().length && !onGitHub) parts.push('No comments yet');
    else {
      if (mine) parts.push(`${mine} comment${mine === 1 ? '' : 's'}`);
      if (onGitHub) parts.push(`${onGitHub} posted on GitHub`);
      if (summary.drafts) parts.push(`${summary.drafts} not sent`);
      if (summary.waiting) parts.push(`${summary.waiting} with your agent`);
      if (summary.answered) parts.push(`${summary.answered} answered`);
      if (ghPendingIds().length) parts.push(`${ghPendingIds().length} pending`);
    }
    set(panel.querySelector('.dcr-summary'), 'textContent', parts.join(' · '));
    panel.querySelector('.dcr-foot-status .dcr-dot').dataset.tone = !online ? 'off' : summary.drafts ? 'work' : 'ok';
    const current = review.history?.revision;
    const note = panel.querySelector('.dcr-note');
    if (latest && current && latest > current) set(note, 'innerHTML', `A newer revision (${latest}) was saved. <a href="/">Open it</a>`);
    // One main action at a time: send what is unsent; with nothing to send, finishing is the next step.
    const send = panel.querySelector('[data-open-send]');
    const finish = panel.querySelector('[data-dcr-finish]');
    send.hidden = !summary.drafts;
    set(send.querySelector('.act-count'), 'textContent', String(summary.drafts));
    set(send, 'disabled', !online);
    set(finish, 'disabled', !online);
    // Pending GitHub comments make finishing that review the main action, as on GitHub.
    const ghFinish = panel.querySelector('[data-gh-finish]');
    const pendingCount = ghPendingIds().length;
    ghFinish.hidden = !pendingCount;
    set(ghFinish.querySelector('.act-count'), 'textContent', String(pendingCount));
    set(ghFinish, 'disabled', !online);
    finish.classList.toggle('act-primary', !summary.drafts && !pendingCount);
    finish.classList.toggle('act-secondary', !!summary.drafts || !!pendingCount);
  };
  const sendDrafts = async () => {
    const pending = tools.drafts(comments(), threads, resolved());
    if (!pending.length) return;
    await api('/api/send', {key, items: pending.map(comment => ({id: comment.id, text: tools.sendText(snapshot, review, comment, '', threads[comment.id])}))});
  };
  panel.addEventListener('click', async event => {
    try {
      if (event.target.closest('[data-dcr-export]')) {
        // A plain link cannot send the token, so fetch the file and save it from a blob.
        const response = await fetch('/api/export', {headers: {'X-QA-Token': token}});
        if (!response.ok) throw new Error((await response.json()).error || 'Export failed');
        const link = Object.assign(document.createElement('a'), {href: URL.createObjectURL(await response.blob()), download: `${review.history?.series || 'review'}-review.html`});
        document.body.append(link); link.click(); link.remove();
        flash('Exported. The file opens offline with your comments and your agent\'s replies.');
        return;
      }
      if (event.target.closest('[data-gh-finish]')) { openFinish(); return; }
      if (event.target.closest('[data-dcr-finish]')) {
        await sendDrafts(); await api('/api/finish', {key}); await refresh();
        flash('Finished. Your agent will pick this round up and reply here.');
      }
    } catch (error) { flash(error.message); }
  });

  // --- GitHub ---------------------------------------------------------------------------------
  // The review posts to the pull request through this server, which runs `gh` signed in on this
  // computer: one click, one request, no agent involved. A comment can be posted now (Add single
  // comment) or kept pending and posted with the others when you finish your review, as on GitHub.
  // Every step is visible: connecting, posting, posted with its link, or why it did not post.
  let ghStatus = {phase: 'checking', text: 'Connecting to GitHub…'};
  let ghData = {pending: {}, posted: {}};
  const ghPosting = new Set();
  const ghFailed = new Map();
  const ghPendingIds = () => { const known = new Set(comments().map(comment => comment.id)); return Object.keys(ghData.pending || {}).filter(id => known.has(id) && !ghData.posted?.[id]); };
  const ghRefresh = () => { decorateLedger(); window.ReviewGitHub?.refresh(); renderPanel(); renderUnsent(); };
  const ghProvider = {
    status: () => !online ? {phase: 'offline', text: 'The review server stopped. Restart `dcr serve` to post to GitHub.'} : ghStatus,
    stateOf: id => ghData.posted?.[id] ? {state: 'posted', ...ghData.posted[id]} : ghPosting.has(id) ? {state: 'posting'}
      : ghFailed.has(id) ? {state: 'failed', error: ghFailed.get(id)} : ghData.pending?.[id] ? {state: 'pending'} : {state: 'note'},
    pendingCount: () => ghPendingIds().length,
    async post(id) {
      const comment = comments().find(entry => entry.id === id);
      if (!comment || ghPosting.has(id)) return;
      ghPosting.add(id); ghFailed.delete(id); ghRefresh();
      ghNotice('busy', 'Posting your comment to GitHub…');
      try {
        const result = await api('/api/github/comment', {key, item: globalThis.ReviewTools.githubItem(snapshot, comment, review.qa)});
        const posted = result.posted[id];
        ghData.posted = {...ghData.posted, [id]: posted};
        ghNotice('done', {lines: `Posted on ${where(comment)}.`, file: 'Posted on the file: those lines are not in the pull request\'s diff.', conversation: 'Posted in the pull request\'s conversation.'}[posted.where] || 'Posted on GitHub.', posted.url);
      } catch (error) {
        ghFailed.set(id, error.message);
        ghNotice('error', `Not posted. ${error.message}`);
      } finally { ghPosting.delete(id); ghRefresh(); }
    },
    async pend(id, on) {
      try {
        const entry = await api('/api/github/pending', {key, id, pending: on});
        ghData = {...ghData, ...entry}; ghFailed.delete(id); ghRefresh();
      } catch (error) { ghNotice('error', error.message); }
    }
  };
  const where = comment => {
    const found = globalThis.ReviewTools.anchor(snapshot, comment);
    return found ? `${found.file.path.split('/').pop()}, ${comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}–${comment.end}`}` : 'the pull request';
  };
  const loadGitHub = async () => {
    try {
      const status = await api(`/api/github?key=${encodeURIComponent(key)}`);
      ghStatus = status.ready ? {phase: 'ready', ...status} : {phase: 'unavailable', text: status.reason};
    } catch (error) { ghStatus = {phase: 'unavailable', text: error.message}; }
    ghRefresh();
  };
  if (window.ReviewGitHub && globalThis.ReviewTools.githubLink(snapshot, review, {general: true})) { window.ReviewGitHub.connect(ghProvider); loadGitHub(); }

  // One notice for GitHub work, bottom right: a spinner while it runs, then the result with its link.
  const ghNote = document.createElement('div');
  ghNote.id = 'dcr-gh-note';
  ghNote.hidden = true;
  ghNote.setAttribute('role', 'status');
  ghNote.setAttribute('aria-live', 'polite');
  document.body.append(ghNote);
  let ghNoteTimer;
  const ghNotice = (tone, text, url = null, action = null) => {
    clearTimeout(ghNoteTimer);
    ghNote.dataset.tone = tone;
    const mark = tone === 'busy' ? '<span class="gh-spinner" aria-hidden="true"></span>' : tone === 'done' ? `<span class="gh-mark">${ico('check')}</span>` : `<span class="gh-mark">${ico('circle-alert')}</span>`;
    ghNote.innerHTML = `${mark}<span class="gh-note-text">${tools.escape(text)}</span>${url ? `<a class="gh-note-link" href="${tools.escape(url)}" target="_blank" rel="noopener noreferrer">View on GitHub ${ico('arrow-up-right')}</a>` : ''}${action === 'finish' ? '<button type="button" class="gh-note-link" data-gh-finish>Finish your review</button>' : ''}${tone === 'busy' ? '' : '<button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>'}`;
    ghNote.hidden = false;
    if (tone !== 'busy') ghNoteTimer = setTimeout(() => { ghNote.hidden = true; }, tone === 'error' ? 15000 : 8000);
  };
  ghNote.addEventListener('click', event => {
    if (event.target.closest('[data-gh-finish]')) { ghNote.hidden = true; openFinish(); }
    else if (event.target.closest('.dcr-dismiss, .gh-note-link')) ghNote.hidden = true;
  });

  // Finish your review: GitHub's own choice of a summary and Comment, Approve or Request changes,
  // with the pending comments listed. It reports progress in place and ends on the review's link.
  const finishDialog = document.createElement('dialog');
  finishDialog.id = 'dcr-gh-finish';
  finishDialog.className = 'modal dcr-gh-finish';
  finishDialog.setAttribute('aria-labelledby', 'dcr-gh-finish-title');
  document.body.append(finishDialog);
  const EVENTS = [
    ['COMMENT', 'Comment', 'Submit general feedback without explicit approval.'],
    ['APPROVE', 'Approve', 'Give your approval to merge these changes.'],
    ['REQUEST_CHANGES', 'Request changes', 'Submit feedback that must be addressed before merging.']
  ];
  const openFinish = () => {
    const ids = ghPendingIds();
    if (!ids.length) return;
    const own = ghStatus.phase === 'ready' && ghStatus.author && ghStatus.author === ghStatus.login;
    const rows = ids.map(id => comments().find(comment => comment.id === id)).map(comment => `<li><span class="send-text"><span class="send-where">${tools.escape(where(comment))}</span><span class="send-subject">${tools.escape(comment.subject)}</span></span><button type="button" class="act act-quiet act-icon" data-gh-drop="${tools.escape(comment.id)}" aria-label="Remove from review" title="Remove from review">${ico('x')}</button></li>`).join('');
    finishDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box">
      <header><div><h2 id="dcr-gh-finish-title">Finish your review</h2><p class="muted">${ids.length} pending comment${ids.length === 1 ? '' : 's'} on ${tools.escape(ghStatus.repo || '')} #${tools.escape(ghStatus.number || '')}${ghStatus.login ? `, as <b>@${tools.escape(ghStatus.login)}</b>` : ''}</p></div><button type="button" class="act act-quiet act-icon" data-gh-close aria-label="Close" title="Close (Esc)">${ico('x')}</button></header>
      <textarea class="gh-summary" name="body" rows="4" placeholder="Leave a comment" aria-label="Review summary"></textarea>
      <fieldset class="gh-events"><legend class="sr-only">Review outcome</legend>${EVENTS.map(([value, label, hint], index) => {
        const blocked = own && value !== 'COMMENT';
        return `<label class="gh-event${blocked ? ' is-off' : ''}"><input type="radio" name="event" value="${value}" ${index === 0 ? 'checked' : ''} ${blocked ? 'disabled' : ''}><span><b>${label}</b><small>${blocked ? 'Pull request authors can\'t approve or request changes on their own pull request.' : hint}</small></span></label>`;
      }).join('')}</fieldset>
      <details class="gh-pending-list" ${ids.length <= 4 ? 'open' : ''}><summary>${ids.length} pending comment${ids.length === 1 ? '' : 's'}</summary><ul class="send-list">${rows}</ul></details>
      <p class="gh-finish-state" role="status" aria-live="polite" hidden></p>
      <footer class="dcr-gh-actions"><button type="button" class="act act-quiet" data-gh-close>Cancel</button><button type="button" class="act act-gh" data-gh-submit>Submit review</button></footer></form>`;
    finishDialog.showModal();
    finishDialog.querySelector('.gh-summary').focus();
    const status = ghProvider.status();
    if (status.phase !== 'ready') {
      finishDialog.querySelector('[data-gh-submit]').disabled = true;
      finishState(status.phase === 'checking' ? 'busy' : 'error', `${status.phase === 'checking' ? '<span class="gh-spinner" aria-hidden="true"></span>' : `<span class="gh-mark">${ico('circle-alert')}</span>`}<span>${tools.escape(status.text || '')}</span>`);
    }
  };
  const finishState = (tone, html) => {
    const line = finishDialog.querySelector('.gh-finish-state');
    line.dataset.tone = tone;
    line.innerHTML = html;
    line.hidden = !html;
  };
  finishDialog.addEventListener('click', async event => {
    if (event.target.closest('[data-gh-close]')) { finishDialog.close(); return; }
    const drop = event.target.closest('[data-gh-drop]');
    if (drop) { await ghProvider.pend(drop.dataset.ghDrop, false); if (ghPendingIds().length) openFinish(); else finishDialog.close(); return; }
    const submit = event.target.closest('[data-gh-submit]');
    if (!submit) return;
    const form = finishDialog.querySelector('form');
    const event_ = form.elements.event.value;
    const ids = ghPendingIds();
    const items = ids.map(id => comments().find(comment => comment.id === id)).filter(Boolean).map(comment => globalThis.ReviewTools.githubItem(snapshot, comment, review.qa));
    form.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = true; });
    submit.innerHTML = '<span class="gh-spinner" aria-hidden="true"></span>Submitting…';
    finishState('busy', `Posting ${items.length} comment${items.length === 1 ? '' : 's'} as one review on GitHub…`);
    ids.forEach(id => ghPosting.add(id)); ghRefresh();
    try {
      const result = await api('/api/github/review', {key, event: event_, body: form.elements.body.value, items});
      ghData.posted = {...ghData.posted, ...result.posted};
      ids.forEach(id => { delete ghData.pending[id]; });
      const loose = Object.values(result.posted).filter(posted => posted.where === 'review').length;
      const label = {COMMENT: 'Review submitted', APPROVE: 'Approved', REQUEST_CHANGES: 'Changes requested'}[event_];
      finishDialog.querySelector('.gh-events').hidden = true;
      finishDialog.querySelector('.gh-summary').hidden = true;
      finishDialog.querySelector('.gh-pending-list').hidden = true;
      finishDialog.querySelector('header p').textContent = `Posted on ${ghStatus.repo} #${ghStatus.number} as @${ghStatus.login}.`;
      finishState('done', `<span class="gh-mark">${ico('check')}</span><span><b>${label}.</b> ${items.length} comment${items.length === 1 ? '' : 's'} posted on GitHub${loose ? `; ${loose} in the review's summary because ${loose === 1 ? 'its lines are' : 'their lines are'} not in the diff` : ''}.</span>`);
      finishDialog.querySelector('.dcr-gh-actions').innerHTML = `<button type="button" class="act act-quiet" data-gh-close>Close</button><a class="act act-secondary" href="${tools.escape(result.review)}" target="_blank" rel="noopener noreferrer">View on GitHub ${ico('arrow-up-right')}</a>`;
    } catch (error) {
      form.querySelectorAll('button, textarea, input:not([data-off])').forEach(control => { control.disabled = false; });
      form.querySelectorAll('.gh-event.is-off input').forEach(input => { input.disabled = true; });
      submit.textContent = 'Try again';
      finishState('error', `<span class="gh-mark">${ico('circle-alert')}</span><span>Not submitted. ${tools.escape(error.message)}</span>`);
    } finally { ids.forEach(id => ghPosting.delete(id)); ghRefresh(); }
  });

  // --- recordings -----------------------------------------------------------------------------
  // The recorder lists what it saved. Each PNG or WebM can be attached to the review here, as
  // a new revision of the same code that keeps your comments and threads.
  const field = (label, control) => { const wrap = document.createElement('label'); wrap.textContent = label; wrap.append(control); return wrap; };
  const attachForm = (item, path) => {
    const form = document.createElement('form');
    form.className = 'dcr-attach';
    const title = Object.assign(document.createElement('input'), {required: true, maxLength: 200, placeholder: 'What did you record?'});
    const result = Object.assign(document.createElement('select'), {innerHTML: '<option value="passed">Works as intended</option><option value="failed">Problem</option>'});
    const observed = Object.assign(document.createElement('textarea'), {required: true, rows: 2, maxLength: 2000, placeholder: 'What did you see?'});
    const expected = Object.assign(document.createElement('input'), {maxLength: 2000, placeholder: 'What should happen? (optional)'});
    const owner = document.createElement('select');
    owner.innerHTML = '<option value="">Not tied to a comment</option>';
    comments().filter(comment => !comment.general).forEach(comment => owner.append(Object.assign(document.createElement('option'), {value: comment.id, textContent: comment.subject})));
    const submit = Object.assign(document.createElement('button'), {type: 'submit', textContent: 'Attach and open revision'});
    const status = Object.assign(document.createElement('span'), {className: 'dcr-status'});
    form.append(field('Title', title), field('Result', result), field('What you saw', observed), field('Expected', expected), field('About comment', owner), submit, status);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = 'Attaching…';
      try {
        const saved = await api('/api/evidence', {path, title: title.value, result: result.value, observed: observed.value, expected: expected.value, comment_id: owner.value});
        status.textContent = `Saved as revision ${saved.revision}. Opening it…`;
        setTimeout(() => location.reload(), 600);
      } catch (error) { status.textContent = error.message; submit.disabled = false; }
    });
    item.append(form);
    title.focus();
  };
  const decorateRecordings = () => {
    document.querySelectorAll('#qa-artifacts li:not([data-dcr-attach])').forEach(item => {
      item.dataset.dcrAttach = '1';
      const path = item.textContent.split(' · ')[0];
      if (!/\.(png|webm)$/.test(path)) return;
      const button = Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-attach-open', textContent: 'Attach to review'});
      button.addEventListener('click', () => { button.hidden = true; attachForm(item, path); });
      item.append(' ', button);
    });
  };
  const artifacts = document.getElementById('qa-artifacts');
  if (artifacts) { new MutationObserver(decorateRecordings).observe(artifacts, {childList: true}); decorateRecordings(); }

  // --- rows in "Your review" ---------------------------------------------------------------------
  // Your review is a list. A row with a conversation shows who answered last and how the answer
  // starts; opening it shows that one conversation in place of the list, as a chat: a back button,
  // the comment it started from and every message, scrolling, and one reply field pinned to the
  // bottom. The row's title still jumps to the code.
  const STATE = {sent: 'sent', delivered: 'sent', answered: 'answered'};
  const plain = tools.snippet;
  const unseenIn = thread => (thread?.messages || []).some(message => message.author === 'agent' && !seen.has(message.id));
  const weighedIn = thread => !!thread && ((thread.waiting_on || []).length > 0 || Object.keys(thread.opinions || {}).length > 0);
  const hasConversation = thread => !!thread && (thread.live || thread.delivery !== 'draft' || thread.messages?.length > 0 || weighedIn(thread));
  const whereOf = comment => {
    const found = globalThis.ReviewTools.anchor(snapshot, comment);
    const lines = comment.general ? 'General comment' : `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`;
    return `${found?.file.path || 'General'} · ${lines}`;
  };
  const rowFor = comment => `<li class="ledger-item" data-ledger="${tools.escape(comment.id)}" data-conversation="1"><button type="button" class="ledger-jump" data-ledger-jump="${tools.escape(comment.id)}"><span class="ledger-where">${tools.escape(whereOf(comment))}</span><span class="ledger-subject">${tools.escape(comment.subject)}</span></button><div class="ledger-meta"></div></li>`;
  // The faces of every agent that weighed in, each ringed with what it thinks.
  // The other agents that weighed in, beside the one already named: small marks, the tally on hover.
  const facesHTML = (thread, named) => {
    const others = tools.verdicts(thread).filter(entry => entry.agent !== named);
    if (!others.length) return '';
    const counts = tools.tally(thread);
    return `<span class="dcr-faces" title="${tools.escape(`${tools.consensus(counts)}: ${tools.verdicts(thread).map(entry => `${tools.agentInfo(entry.agent).name} ${tools.VERDICTS[entry.verdict].label.toLowerCase()}`).join(', ')}`)}"><span class="dcr-faces-plus">+</span>${others.map(entry => tools.avatarHTML(entry.agent, 'dcr-face-xs')).join('')}</span>`;
  };
  const chevron = '<svg class="dcr-peek-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  // The latest answer, flat under the row: who said it (and what they think), then its first lines.
  // The faces of the others who weighed in show only when there is more than one voice.
  const peekHTML = thread => {
    const last = [...(thread.messages || [])].reverse().find(message => message.author === 'agent');
    const faces = facesHTML(thread, last?.agent || listener);
    if (!last) return `<span class="dcr-peek-who"><span class="dcr-peek-note">Open conversation</span><span class="dcr-peek-end">${faces}${chevron}</span></span>`;
    const who = tools.escape(tools.agentInfo(last.agent || listener).name);
    return `<span class="dcr-peek-who">${tools.avatarHTML(last.agent || listener, 'dcr-face-xs')}<b>${who}</b>${last.role === 'adversary' ? tools.verdictHTML(last.verdict) : ''}<time data-at="${tools.escape(last.at || '')}">${tools.escape(tools.relativeTime(last.at))}</time><span class="dcr-peek-end">${faces}${chevron}</span></span><span class="dcr-peek-text">${tools.escape(plain(last.body))}</span>`;
  };
  const decoratePeek = (item, comment, thread) => {
    let peek = item.querySelector(':scope > .dcr-peek');
    if (!hasConversation(thread)) { peek?.remove(); return; }
    if (!peek) {
      peek = Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-peek'});
      peek.dataset.dcrOpen = item.dataset.ledger;
      peek.setAttribute('aria-label', `Open the conversation about ${comment?.subject || 'this comment'}`);
      item.append(peek);
    }
    const html = peekHTML(thread);
    if (peek.dataset.html !== html) { peek.innerHTML = html; peek.dataset.html = html; }
  };

  // The open conversation: it takes the panel's place until Back (or Escape).
  const ledgerPanel = document.getElementById('ledger');
  const view = document.createElement('section');
  view.className = 'dcr-detail';
  view.hidden = true;
  view.setAttribute('aria-label', 'Conversation with your agent');
  view.innerHTML = `<header class="dcr-detail-bar"><button type="button" class="dcr-back" data-dcr-back>${ico('chevron-left')}<span>Your review</span></button><button type="button" class="icon-button" data-dcr-close aria-label="Close your review" title="Close">${ico('x')}</button></header>
    <div class="dcr-detail-title"><span class="ledger-where"></span><strong></strong><button type="button" class="dcr-detail-code" data-ledger-jump>${ico('arrow-up-right')}<span>Show in the code</span></button></div><div class="dcr-detail-slot"></div>`;
  ledgerPanel?.append(view);
  let current = null;
  const openConversation = (id, {focus = true} = {}) => {
    const comment = comments().find(entry => entry.id === id);
    if (!comment || !hasConversation(threads[id]) || !ledgerPanel) return false;
    if (!document.body.classList.contains('ledger-open')) document.getElementById('ledger-toggle')?.click();
    current = id;
    view.querySelector('.dcr-detail-title .ledger-where').textContent = whereOf(comment);
    view.querySelector('.dcr-detail-title strong').textContent = comment.subject;
    view.querySelector('[data-ledger-jump]').dataset.ledgerJump = id;
    const block = cardBlock(id, 'ledger', comment);
    view.querySelector('.dcr-detail-slot').replaceChildren(block);
    view.hidden = false;
    ledgerPanel.classList.add('dcr-in-convo');
    refreshBlock(block);
    const scroller = block.querySelector('.dcr-scroll');
    scroller.scrollTop = scroller.scrollHeight; // a conversation opens on its newest message
    if (focus) block.querySelector('textarea:not([disabled])')?.focus({preventScroll: true});
    else view.querySelector('[data-dcr-back]').focus({preventScroll: true});
    return true;
  };
  const closeConversation = () => {
    const id = current;
    current = null;
    view.hidden = true;
    view.querySelector('.dcr-detail-slot').replaceChildren();
    ledgerPanel?.classList.remove('dcr-in-convo');
    return id;
  };
  view.addEventListener('click', event => {
    if (event.target.closest('[data-dcr-back]')) {
      const id = closeConversation();
      decorateLedger();
      document.querySelector(`#ledger-body .ledger-item[data-ledger="${CSS.escape(id || '')}"] .dcr-peek`)?.focus({preventScroll: false});
    }
    if (event.target.closest('[data-dcr-close]')) { closeConversation(); document.getElementById('ledger-close')?.click(); }
  });
  ledgerPanel?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !current) return;
    event.preventDefault();
    event.stopPropagation();
    view.querySelector('[data-dcr-back]').click();
  });
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-dcr-open]');
    // Opened with the keyboard, the conversation is for reading first: J and K scroll it, I replies.
    if (open) openConversation(open.dataset.dcrOpen, {focus: event.detail !== 0});
  });
  // From an announced answer: open that conversation in Your review, rather than leaving the page.
  const showConversation = id => openConversation(id);
  const decorateLedger = () => {
    const body = document.getElementById('ledger-body');
    if (!body) return;
    // Conversations about the agent's own findings that you have joined, above your own comments.
    const mine = new Set(comments().filter(comment => comment.personal).map(comment => comment.id));
    const joined = comments().filter(comment => !mine.has(comment.id) && hasConversation(threads[comment.id]) && (threads[comment.id].delivery !== 'draft' || threads[comment.id].messages?.length || weighedIn(threads[comment.id])));
    let section = body.querySelector(':scope > .dcr-convos');
    if (!joined.length) section?.remove();
    else {
      if (!section) { section = document.createElement('section'); section.className = 'ledger-group dcr-convos'; body.prepend(section); }
      // Only the list of rows decides the markup; states and answers are filled in below.
      const html = `<h3>Conversations with your agent</h3><ul class="ledger-list">${joined.map(rowFor).join('')}</ul>`;
      if (section.dataset.html !== html) { section.innerHTML = html; section.dataset.html = html; }
    }
    // The agent's comments you put on GitHub (pending or posted), so the panel shows your whole GitHub review.
    const onGitHub = comments().filter(comment => !mine.has(comment.id) && (ghData.pending?.[comment.id] || ghData.posted?.[comment.id]));
    let ghGroup = body.querySelector(':scope > .dcr-gh-group');
    if (!onGitHub.length) ghGroup?.remove();
    else {
      if (!ghGroup) { ghGroup = document.createElement('section'); ghGroup.className = 'ledger-group dcr-gh-group'; section ? section.after(ghGroup) : body.prepend(ghGroup); }
      const html = `<h3>On GitHub</h3><ul class="ledger-list">${onGitHub.map(comment => `<li class="ledger-item" data-gh-row data-state="${ghData.posted?.[comment.id] ? 'posted' : 'pending'}"><button type="button" class="ledger-jump" data-ledger-jump="${tools.escape(comment.id)}"><span class="ledger-where">${tools.escape(whereOf(comment))}</span><span class="ledger-subject">${tools.escape(comment.subject)}</span></button><div class="ledger-meta"><span class="gh-slot" data-gh-badge="${tools.escape(comment.id)}"></span></div></li>`).join('')}</ul>`;
      if (ghGroup.dataset.html !== html) { ghGroup.innerHTML = html; ghGroup.dataset.html = html; window.ReviewGitHub?.refresh(); }
    }
    const byId = new Map(comments().map(comment => [comment.id, comment]));
    if (current && !hasConversation(threads[current])) closeConversation();
    body.querySelectorAll('.ledger-item[data-ledger]').forEach(item => {
      const thread = threads[item.dataset.ledger];
      const own = !item.dataset.conversation;
      // A comment for the PR is about GitHub, not the agent: its stroke follows its GitHub state.
      // Anything not written for the agent and not sent to it is for the PR once the review can post there.
      const audience = byId.get(item.dataset.ledger)?.audience;
      const sentToAgent = thread && (thread.live || thread.delivery !== 'draft');
      const forPR = !sentToAgent && (audience === 'pr' || (audience !== 'agent' && ghProvider.status().phase === 'ready'));
      const ghRow = ghData.posted?.[item.dataset.ledger] ? 'posted' : ghData.pending?.[item.dataset.ledger] ? 'pending' : 'draft';
      if (item.dataset.ghRow === undefined && forPR) item.dataset.ghRow = '';
      const state = item.dataset.state === 'resolved' && own ? 'resolved' : forPR ? ghRow : STATE[thread?.delivery] || 'draft';
      set(item.dataset, 'state', state);
      const meta = item.querySelector('.ledger-meta');
      let status = meta.querySelector('.ledger-status');
      if (!status) { status = document.createElement('span'); status.className = 'ledger-status'; meta.prepend(status); }
      // An unsent comment shows its Send button instead of saying it is unsent.
      const model = online ? tools.statusModel(thread, listening) : null;
      // An answer shows itself in the preview below, so the row does not also say "Replied".
      const text = state === 'resolved' || forPR || (state === 'draft' && online) || (model?.tone === 'done' && hasConversation(thread)) ? '' : model?.text || 'Not sent';
      const tone = model?.tone || 'off';
      // A narrow row says it in a few words; the whole sentence is its tooltip.
      const short = !model ? text : {done: 'Replied', work: 'Agent is answering', wait: 'Sent', idle: thread?.delivery === 'delivered' ? 'No answer yet' : 'Sent · no agent listening'}[tone] || text;
      const statusHTML = text ? `<span class="dcr-dot dcr-tone-${tone}" aria-hidden="true"></span>${tools.escape(short)}${model?.typing ? '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}` : '';
      if (status.dataset.html !== statusHTML) { status.innerHTML = statusHTML; status.dataset.html = statusHTML; status.title = text; }
      let fresh = meta.querySelector('.dcr-new');
      if (unseenIn(thread) && !fresh) { fresh = Object.assign(document.createElement('span'), {className: 'dcr-new', textContent: 'New'}); status.after(fresh); }
      if (!unseenIn(thread) && fresh) fresh.remove();
      let send = meta.querySelector('.dcr-row-send');
      const canSend = own && !forPR && state === 'draft' && online;
      if (canSend && !send) { send = Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-row-send', textContent: 'Send to agent'}); send.dataset.dcrRowSend = item.dataset.ledger; status.after(send); }
      if (!canSend && send) send.remove();
      item.querySelector(':scope > .ledger-reply')?.remove(); // the peek replaces the old one-line answer
      // With the server connected the agent is one click away, so Copy for LLMs stays in the card's ⋯ menu.
      const copy = meta.querySelector('[data-copy]');
      if (copy) set(copy, 'hidden', online);
      decoratePeek(item, byId.get(item.dataset.ledger), thread);
    });
  };

  // --- send from where you write ---------------------------------------------------------------
  // 1. The comment editor: save and send in one step.
  const editor = document.getElementById('comment-form');
  const editorFooter = editor?.querySelector('footer');
  if (editorFooter) {
    const hint = editorFooter.querySelector('.muted');
    if (hint) hint.textContent = 'Saved to this review.';
    editorFooter.querySelector('button[type="submit"]')?.classList.replace('btn-primary', 'btn-soft');
    const sendButton = Object.assign(document.createElement('button'), {type: 'button', className: 'btn btn-sm btn-primary', textContent: 'Save and send to agent'});
    editorFooter.append(sendButton);
    sendButton.addEventListener('click', async () => {
      const snapshotOf = () => new Map((saved().personalComments || []).map(comment => [comment.id, JSON.stringify(comment)]));
      const before = snapshotOf();
      editor.requestSubmit(); // runs the review's own validation and save
      const after = snapshotOf();
      const changed = [...after].filter(([id, json]) => before.get(id) !== json).map(([id]) => id).filter(id => !threads[id]?.live);
      if (!changed.length) return;
      try {
        for (const id of changed) await sendComment(id);
        flash(changed.length === 1 ? 'Saved and sent to your agent.' : `Saved and sent ${changed.length} comments.`);
      } catch (error) { flash(`Saved, but not sent: ${error.message}`); }
    });
  }

  // The composer in the code gets its Ask agent mode: save, then hand the comment to your agent.
  // Its + belongs to the comment it is about to make, so a tick moves to that comment when it is sent.
  const composerForm = window.ReviewComposer?.setSender(async id => {
    if (withAdversaries.delete(COMPOSER)) withAdversaries.add(id);
    syncComposerAdv();
    try { const asked = await sendComment(id); flash(sentWith(tools.statusModel(threads[id], listening)?.text || 'Saved and sent to your agent.', asked)); }
    catch (error) { flash(`Saved, but not sent: ${error.message}`); }
  });
  const composerSend = composerForm?.querySelector?.('[data-composer-send]');
  composerSend?.insertAdjacentHTML('beforebegin', advToggleHTML);
  const syncComposerAdv = () => { if (composerSend) syncAdvToggles([composerSend.previousElementSibling], COMPOSER, true); };

  // 2. A quiet reminder wherever you are, until the comment is sent. Your review shows the same
  //    action itself, so the reminder steps aside while that panel is open.
  const unsent = document.createElement('div');
  unsent.id = 'dcr-unsent';
  unsent.hidden = true;
  unsent.innerHTML = '<span></span><button type="button" class="btn btn-sm btn-primary" data-open-send>Review and send</button>';
  document.body.append(unsent);
  const renderUnsent = () => {
    const pending = ghPendingIds().length;
    const count = pending || tools.drafts(comments(), threads, resolved()).length;
    unsent.hidden = !count || !online || document.body.classList.contains('ledger-open');
    unsent.classList.toggle('is-github', !!pending);
    set(unsent.querySelector('span'), 'textContent', pending ? `${pending} comment${pending === 1 ? '' : 's'} pending in your GitHub review` : `${count} comment${count === 1 ? '' : 's'} not sent`);
    const button = unsent.querySelector('button');
    set(button, 'textContent', pending ? 'Finish your review' : 'Review and send');
    button.toggleAttribute('data-open-send', !pending);
    button.toggleAttribute('data-gh-finish', !!pending);
  };
  unsent.addEventListener('click', event => { if (event.target.closest('[data-gh-finish]')) openFinish(); });
  new MutationObserver(renderUnsent).observe(document.body, {attributes: true, attributeFilter: ['class']});

  // The send dialog gains its second action. Comments already with the agent are shown but not selectable.
  const sendDialog = document.getElementById('send-dialog');
  const sendActions = document.getElementById('send-actions');
  if (sendDialog && sendActions) {
    const sendAll = Object.assign(document.createElement('button'), {type: 'button', className: 'btn btn-sm btn-primary', textContent: 'Send to agent'});
    sendActions.append(sendAll);
    const chosen = () => [...sendDialog.querySelectorAll('#send-list input:checked')].map(input => input.value);
    const refreshSend = () => {
      sendDialog.querySelectorAll('#send-list li').forEach(item => {
        const input = item.querySelector('input');
        if (!input) return;
        const thread = threads[input.value];
        const already = thread && (thread.live || thread.delivery !== 'draft');
        if (already && !input.disabled) {
          input.checked = false; input.disabled = true;
          item.querySelector('.send-where')?.append(Object.assign(document.createElement('span'), {className: 'send-tag', textContent: 'already sent'}));
        }
      });
      const count = chosen().length;
      sendAll.textContent = count ? `Send ${count === 1 ? '1 comment' : `${count} comments`} to agent` : 'Send to agent';
      sendAll.disabled = !online || !count;
      const copy = document.getElementById('send-copy');
      if (copy) copy.disabled = !count;
    };
    sendDialog.addEventListener('send-open', refreshSend);
    sendDialog.addEventListener('send-selection', refreshSend);
    sendDialog.addEventListener('change', refreshSend);
    sendAll.addEventListener('click', async () => {
      const ids = chosen();
      if (!ids.length) return;
      sendAll.disabled = true;
      try {
        const items = ids.map(id => ({id, text: tools.sendText(snapshot, review, comments().find(comment => comment.id === id), '', threads[id])}));
        await api('/api/send', {key, items});
        sendDialog.close();
        await refresh();
        flash(ids.length === 1 ? 'Sent to your agent.' : `Sent ${ids.length} comments to your agent.`);
      } catch (error) { flash(error.message); sendAll.disabled = false; }
    });
  }

  // 3. The comment's own popover in the diff, so a reply or a send never needs the Overview.
  const popover = document.getElementById('comment-popover');
  const decoratePopover = () => {
    let added = false;
    popover?.querySelectorAll('.popover-comment[data-comment-id]').forEach(section => {
      if (section.querySelector(':scope > .dcr-thread')) return;
      const block = cardBlock(section.dataset.commentId, 'popover');
      section.append(block);
      // One row of actions, after the conversation, led by Ask agent as on the cards.
      const actions = section.querySelector(':scope > .comment-actions');
      const act = block.querySelector(':scope > .dcr-actions');
      if (actions && act) { act.firstElementChild.classList.replace('btn-sm', 'btn-xs'); actions.prepend(act.firstElementChild); act.remove(); section.append(actions); }
      added = true;
    });
    if (!added) return;
    document.querySelectorAll('.dcr-thread').forEach(refreshBlock);
    window.dispatchEvent(new Event('resize')); // the review repositions the popover for its new height
  };
  if (popover) new MutationObserver(decoratePopover).observe(popover, {childList: true});

  // 4. Each of your rows in Your review.
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-dcr-row-send]');
    if (!button) return;
    button.disabled = true;
    try { flash(sentWith('Sent to your agent.', await sendComment(button.dataset.dcrRowSend))); }
    catch (error) { flash(error.message); button.disabled = false; }
  });

  // --- telling you what is happening ---------------------------------------------------------------
  // A conversation in the diff popover needs room to be read.
  const widenPopover = () => {
    const wide = !!popover?.querySelector('.dcr-popover.has-content .dcr-msg');
    if (popover && popover.classList.contains('dcr-wide') !== wide) {
      popover.classList.toggle('dcr-wide', wide);
      window.dispatchEvent(new Event('resize'));
    }
  };

  // Who is here: a chip before Your review with the agent's mark (a presence dot on its corner, as
  // chat apps show someone online) and what it is doing in words. On a narrow screen only the mark
  // and its dot remain. A click opens a small card: who, what, and how to connect one when none is.
  const ledgerButton = document.getElementById('ledger-toggle');
  const presence = document.createElement('button');
  presence.type = 'button';
  presence.id = 'dcr-presence';
  presence.hidden = true;
  presence.setAttribute('aria-haspopup', 'dialog');
  presence.setAttribute('aria-expanded', 'false');
  presence.innerHTML = '<span class="dcr-presence-face"></span><span class="dcr-presence-text" role="status"></span><span class="dcr-presence-adv" hidden></span>';
  const optionsBar = document.querySelector('.toolbar-options');
  if (ledgerButton) ledgerButton.before(presence);
  else optionsBar?.prepend(presence);
  const presenceCard = document.createElement('div');
  presenceCard.id = 'dcr-presence-card';
  presenceCard.hidden = true;
  presenceCard.setAttribute('role', 'dialog');
  presenceCard.setAttribute('aria-label', 'Your agent');
  presenceCard.innerHTML = '<div class="dcr-presence-main"></div><section class="dcr-adv" aria-labelledby="dcr-adv-title"></section>';
  const presenceMain = presenceCard.querySelector('.dcr-presence-main');
  const advPanel = presenceCard.querySelector('.dcr-adv');
  document.body.append(presenceCard);
  const typing = '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>';
  const connectCommand = () => `dcr wait --repo ${snapshot.repo || '<repo>'} --name ${review.history?.series || '<series>'} --agent <you>`;
  // What the chip and its card say, from the agent model.
  const presenceModel = () => {
    if (!online) return {tone: 'off', label: 'Review server stopped', hint: 'Restart `dcr serve` to send or receive.', face: null};
    const model = tools.agentModel(threads, listening, Date.now(), previews, listener);
    if (!model) return null;
    const name = tools.escape(listener ? tools.agentInfo(listener).name : 'Your agent');
    if (model.tone === 'ok') return {tone: 'ok', label: `${name} <span class="dcr-presence-state">listening</span>`, hint: model.hint, face: listener};
    if (model.tone === 'work') return {tone: 'work', label: `${name} is answering${typing}`, hint: model.hint, face: listener};
    return {tone: 'off', label: 'No agent connected', hint: 'Nothing is listening, so comments you send wait until an agent picks them up.', face: null};
  };
  const renderPresenceCard = model => {
    const agent = model.face ? tools.agentInfo(model.face) : null;
    const runs = agent && listenerModel ? tools.modelHTML(listenerModel) : '';
    const who = agent ? `<strong>${tools.escape(agent.name)}</strong>${agent.company || runs ? `<span>${tools.escape(agent.company)}${agent.company && runs ? ' · ' : ''}${runs}</span>` : ''}` : `<strong>${model.tone === 'off' ? 'No agent connected' : 'Your agent'}</strong>`;
    const connect = model.tone === 'off' && online ? `<p class="dcr-presence-help">Ask your agent to continue this review, or run this where it works:</p><div class="dcr-presence-cmd"><code>${tools.escape(connectCommand())}</code><button type="button" class="icon-button" data-dcr-copy-wait aria-label="Copy the command" title="Copy">${ico('copy')}</button></div>` : '';
    const html = `<header>${tools.avatarHTML(model.face, '')}<div class="dcr-presence-who">${who}</div></header><p class="dcr-presence-line dcr-presence-${model.tone}"><span class="dcr-presence-dot" aria-hidden="true"></span>${tools.escape(model.hint)}</p>${connect}`;
    if (presenceMain.dataset.html !== html) { presenceMain.innerHTML = html; presenceMain.dataset.html = html; }
  };
  // The Adversaries section: every agent CLI here, a switch each, and the model and effort of those on.
  const renderAdversaries = () => {
    const html = tools.adversaryPanelHTML({catalog, adversaries, author: listener, error: catalogError});
    if (advPanel.dataset.html !== html) { advPanel.innerHTML = html; advPanel.dataset.html = html; }
    renderIntro();
  };
  // Lists the agents when the card opens. The server keeps the list a few minutes, so reopening is
  // quick; "Look again" asks the CLIs afresh, after a sign-in or an install.
  const loadCatalog = async (fresh = false) => {
    if (fresh) catalog = null;
    catalogError = '';
    renderAdversaries();
    try {
      const data = await api(`/api/agents${fresh ? '?fresh=1' : ''}`);
      catalog = data.agents;
      adversaries = data.adversaries;
      // Choices left as "the CLI's default" become the model and effort it would use, so the card and
      // the runs say the same thing (the agent running the review keeps its own, unpicked model).
      const settled = adversaries.map(entry => settleEntry(entry));
      if (JSON.stringify(settled) !== JSON.stringify(adversaries)) { await saveAdversaries(settled); return; }
    } catch (error) { if (!catalog) catalogError = `Could not list the agents: ${error.message}`; }
    renderAdversaries(); decorate(); renderAgent();
  };
  const settleEntry = entry => {
    const agent = catalog?.find(candidate => candidate.slug === entry.agent);
    return !agent || (entry.agent === listener && !entry.model) ? entry : tools.settle(agent, entry);
  };
  const saveAdversaries = async next => {
    const before = adversaries;
    adversaries = next; // shown at once; the server's answer is what stays
    renderAdversaries(); decorate(); renderAgent();
    try { adversaries = (await api('/api/agents', {adversaries: next})).adversaries; }
    catch (error) { adversaries = before; flash(error.message); }
    renderAdversaries(); decorate(); renderAgent();
  };
  // What a switch or a select in the list makes of the chosen adversaries; null when it changed nothing.
  const changedAdversaries = (list, event) => {
    const slug = event.target.closest('[data-agent]')?.dataset.agent;
    const agent = catalog?.find(entry => entry.slug === slug);
    if (!agent) return null;
    if (event.target.matches('[data-dcr-adv-switch]')) {
      return event.target.checked
        ? [...list.filter(entry => entry.agent !== slug), settleEntry({agent: slug, model: null, effort: null})]
        : list.filter(entry => entry.agent !== slug);
    }
    const model = event.target.matches('[data-dcr-adv-model]');
    if (!model && !event.target.matches('[data-dcr-adv-effort]')) return null;
    const value = event.target.value || null;
    return list.map(entry => {
      if (entry.agent !== slug) return entry;
      if (!model) return {...entry, effort: value};
      // An effort the new model does not take becomes the one it would use.
      return tools.settle(agent, {...entry, model: value});
    });
  };
  advPanel.addEventListener('change', event => { const next = changedAdversaries(adversaries, event); if (next) saveAdversaries(next); });
  advPanel.addEventListener('click', event => { if (event.target.closest('[data-dcr-adv-recheck]')) loadCatalog(true); });
  // The introduction: shown when the reviewer has never chosen adversaries, nor chosen none. What
  // they tick is kept here until they decide; the decision is saved with their settings, so no
  // review on this computer asks again. Closing it with Esc decides nothing.
  const intro = document.createElement('dialog');
  intro.id = 'dcr-adv-intro';
  intro.className = 'modal';
  intro.setAttribute('aria-labelledby', 'dcr-intro-title');
  document.body.append(intro);
  let introChosen = [];
  let introShown = false;
  function renderIntro() {
    if (!introShown) return;
    const html = tools.adversaryIntroHTML({catalog, adversaries: introChosen, author: listener, error: catalogError});
    if (intro.dataset.html !== html) { intro.innerHTML = html; intro.dataset.html = html; }
  }
  const openIntro = () => {
    if (intro.open || document.querySelector('dialog[open]')) return;
    introChosen = [];
    introShown = true;
    renderIntro(); // before it opens, so the title takes the focus and not a button
    intro.showModal();
    loadCatalog();
  };
  intro.addEventListener('close', () => { introShown = false; });
  intro.addEventListener('change', event => { const next = changedAdversaries(introChosen, event); if (next) { introChosen = next; renderIntro(); } });
  intro.addEventListener('click', async event => {
    if (event.target.closest('[data-dcr-adv-recheck]')) return loadCatalog(true);
    const use = event.target.closest('[data-dcr-intro-use]');
    if (!use && !event.target.closest('[data-dcr-intro-skip]')) return;
    intro.close();
    await saveAdversaries(use ? introChosen : []);
    if (use && adversaries.length) flash(`${tools.names(adversaries.map(entry => tools.agentInfo(entry.agent).name))} will check this review.`);
  });
  const renderAgent = () => {
    const model = presenceModel();
    presence.hidden = !model;
    if (!model) { presenceCard.hidden = true; return; }
    presence.dataset.tone = model.tone;
    const face = `${tools.avatarHTML(model.face, 'dcr-face-sm')}<span class="dcr-presence-dot" aria-hidden="true"></span>`;
    const faceSlot = presence.querySelector('.dcr-presence-face');
    if (faceSlot.dataset.html !== face) { faceSlot.innerHTML = face; faceSlot.dataset.html = face; }
    const text = presence.querySelector('.dcr-presence-text');
    if (text.dataset.html !== model.label) { text.innerHTML = model.label; text.dataset.html = model.label; }
    // Who checks the review beside it, as small marks after a plus, like a row in Your review.
    const asked = askable();
    const advSlot = presence.querySelector('.dcr-presence-adv');
    const advHTML = asked.length ? `<span class="dcr-adv-plus" aria-hidden="true">+</span>${tools.facesHTML(asked.map(entry => entry.agent), 3)}` : '';
    set(advSlot, 'hidden', !asked.length);
    if (advSlot.dataset.html !== advHTML) { advSlot.innerHTML = advHTML; advSlot.dataset.html = advHTML; }
    const checkedBy = asked.length ? ` Checked by ${tools.names(asked.map(entry => tools.agentInfo(entry.agent).name))}.` : '';
    presence.title = model.hint + checkedBy;
    presence.setAttribute('aria-label', `${text.textContent}. ${model.hint}${checkedBy}`);
    renderPresenceCard(model);
    renderAdversaries();
    syncComposerAdv();
  };
  const placePresenceCard = () => {
    const box = presence.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    presenceCard.style.width = `${width}px`;
    presenceCard.style.top = `${Math.round(box.bottom + 8)}px`;
    presenceCard.style.left = `${Math.round(Math.max(12, Math.min(box.left, window.innerWidth - width - 12)))}px`;
  };
  const togglePresenceCard = open => {
    presenceCard.hidden = !open;
    presence.setAttribute('aria-expanded', String(open));
    if (open) { placePresenceCard(); loadCatalog(); }
  };
  presence.addEventListener('click', () => togglePresenceCard(presenceCard.hidden));
  document.addEventListener('click', event => {
    if (!presenceCard.hidden && !presenceCard.contains(event.target) && !presence.contains(event.target)) togglePresenceCard(false);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !presenceCard.hidden) { togglePresenceCard(false); presence.focus(); } });
  window.addEventListener('resize', () => { if (!presenceCard.hidden) placePresenceCard(); });
  presenceCard.addEventListener('click', async event => {
    if (!event.target.closest('[data-dcr-copy-wait]')) return;
    try { await navigator.clipboard.writeText(connectCommand()); flash('Copied. Run it where your agent works.'); }
    catch { getSelection().selectAllChildren(presenceCard.querySelector('code')); flash('Select and copy the command.'); }
  });

  // Unread answers: a count in the tab title and a dot on Your review, until they have been seen.
  const refreshUnread = () => {
    const count = tools.unseen(threads, seen).length;
    document.title = `${count ? `(${count}) ` : ''}${baseTitle}`;
    document.getElementById('ledger-toggle')?.classList.toggle('has-unread', count > 0);
    document.querySelectorAll('.dcr-thread').forEach(block => {
      if (!unseenIn(threads[block.dataset.dcr])) block.querySelectorAll('.dcr-new').forEach(tag => tag.remove());
    });
  };

  // When an answer arrives while you are reading something else: say so, once, with a way to it.
  const arrival = document.createElement('div');
  arrival.id = 'dcr-arrival';
  arrival.hidden = true;
  arrival.setAttribute('role', 'status');
  document.body.append(arrival);
  let arrivalTimer;
  const announce = items => {
    // An answer in the conversation open in Your review is already in front of you.
    items = items.filter(item => !(item.thread === current && document.body.classList.contains('ledger-open')));
    if (!items.length) return;
    const first = comments().find(comment => comment.id === items[0].thread);
    const many = new Set(items.map(item => item.thread)).size > 1;
    const message = (threads[items[0].thread]?.messages || []).find(entry => entry.id === items[0].id);
    const name = tools.agentInfo(message?.agent || listener).name;
    const author = first?.agent ? tools.agentInfo(first.agent).name : null;
    const verdict = message?.role === 'adversary' && tools.VERDICTS[message.verdict];
    const repliers = [...new Set(items.map(item => (threads[item.thread]?.messages || []).find(entry => entry.id === item.id)?.agent || listener).map(slug => tools.agentInfo(slug).name))];
    const headline = many ? `${tools.names(repliers)} replied on ${new Set(items.map(item => item.thread)).size} comments`
      : verdict ? `${name} ${verdict.label.toLowerCase()} with ${author ? `${author}'s comment` : 'a comment'}`
      : message?.role === 'adversary' ? `${name} checked ${author ? `${author}'s comment` : 'a comment'}` : `${name} replied`;
    arrival.innerHTML = `${tools.avatarHTML(message?.agent || listener)}<div><strong>${tools.escape(headline)}</strong>${!many && first ? `<span>${tools.escape(first.subject)}</span>` : ''}</div>${first ? `<button type="button" class="btn btn-sm btn-primary" data-dcr-show-convo="${tools.escape(first.id)}">View</button>` : ''}<button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => { arrival.hidden = true; }, 12000);
  };
  arrival.addEventListener('click', event => {
    const show = event.target.closest('[data-dcr-show-convo]');
    if (show) { arrival.hidden = true; showConversation(show.dataset.dcrShowConvo); return; }
    if (event.target.closest('[data-ledger-jump], .dcr-dismiss')) arrival.hidden = true;
  });

  // "5 min ago" stays true while the page is open, and so does a wait that has since gone quiet.
  setInterval(() => {
    document.querySelectorAll('time[data-at]').forEach(node => set(node, 'textContent', tools.relativeTime(node.dataset.at)));
    document.querySelectorAll('.dcr-thread').forEach(refreshBlock);
  }, 30000);

  // --- template previews built by your agent --------------------------------------------------------
  // The report asks; this asks your agent, then shows how it is going and puts the result in the
  // report's own preview pane when it arrives.
  document.addEventListener('review-preview-request', async event => {
    const path = event.detail.path;
    try {
      await api('/api/preview', {key, path});
      await refresh();
      const name = path.slice(path.lastIndexOf('/') + 1);
      flash(listening === false ? `Asked your agent to preview ${name}. No agent is listening yet; it will start when your agent picks it up.` : `Asked your agent to preview ${name}. You can keep reviewing.`);
    } catch (error) { flash(error.message); }
  });
  const syncPreviews = async () => {
    const ready = [];
    for (const [path, preview] of Object.entries(previews)) {
      if (preview.status !== 'ready') continue;
      const cached = previewHtml.get(path);
      if (!cached || cached.ready_at !== preview.ready_at) {
        try { previewHtml.set(path, await api(`/api/preview?key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`)); }
        catch { continue; }
      }
      ready.push({path, title: preview.title, mocks: preview.mocks, html: previewHtml.get(path).html});
    }
    const pending = Object.fromEntries(Object.entries(previews).filter(([, preview]) => preview.status !== 'ready').map(([path, preview]) => [path, {status: preview.status, error: preview.error}]));
    const signature = JSON.stringify([ready.map(item => [item.path, previewHtml.get(item.path).ready_at]), pending]);
    if (window.ReviewPreviews && syncPreviews.last !== signature) {
      syncPreviews.last = signature;
      window.ReviewPreviews.set({enabled: true, ready, pending});
    }
    // A preview that finished while you were elsewhere: say so, once, with a way to it.
    ready.filter(item => !previewsAnnounced.has(`${item.path}@${previewHtml.get(item.path).ready_at}`)).forEach(item => {
      previewsAnnounced.add(`${item.path}@${previewHtml.get(item.path).ready_at}`);
      if (syncPreviews.first) announcePreview(item.path);
    });
    syncPreviews.first = true;
  };
  const announcePreview = path => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    arrival.innerHTML = `<span class="dcr-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg></span><div><strong>Preview ready</strong><span>${tools.escape(name)}</span></div><button type="button" class="btn btn-sm btn-primary" data-dcr-show-preview="${tools.escape(path)}">View</button><button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => { arrival.hidden = true; }, 12000);
  };
  arrival.addEventListener('click', event => {
    const show = event.target.closest('[data-dcr-show-preview]');
    if (show) { arrival.hidden = true; window.ReviewPreviews?.show(show.dataset.dcrShowPreview); }
  });

  // --- comments posted while the review is in progress -------------------------------------------
  // They join the review where they belong (Overview, the code, Your review) and announce
  // themselves, wherever the reader is. Those already there when the page opens are not news.
  let postedKnown = false;
  const receiveComments = list => {
    const known = new Set((review.comments ||= []).map(comment => comment.id));
    const fresh = list.filter(comment => !known.has(comment.id));
    if (!fresh.length) { postedKnown = true; return; }
    review.comments.push(...fresh);
    window.ReviewLive?.addComments(fresh);
    if (postedKnown) announceComments(fresh);
    postedKnown = true;
  };
  const announceComments = list => {
    const first = list[0];
    const name = first.agent ? tools.agentInfo(first.agent).name : 'Your agent';
    arrival.innerHTML = `${tools.avatarHTML(first.agent || null)}<div><strong>${list.length === 1 ? `${tools.escape(name)} left a comment` : `${tools.escape(name)} left ${list.length} comments`}</strong><span>${tools.escape(first.subject)}</span></div><button type="button" class="btn btn-sm btn-primary" data-ledger-jump="${tools.escape(first.id)}">View</button><button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => { arrival.hidden = true; }, 12000);
  };
  // The finished review is a new revision of the same code: progress and conversations come along.
  let finishedAnnounced = false;
  const announceFinished = () => {
    if (finishedAnnounced || !review.status || !latest || latest <= (review.history?.revision || 0)) return;
    finishedAnnounced = true;
    clearTimeout(arrivalTimer);
    arrival.innerHTML = `<span class="dcr-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span><div><strong>Your review is ready</strong><span>Your progress is kept.</span></div><button type="button" class="btn btn-sm btn-primary" data-dcr-open-latest>Open it</button><button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
  };
  arrival.addEventListener('click', event => { if (event.target.closest('[data-dcr-open-latest]')) { history.replaceState(null, '', '/#overview'); location.reload(); } });

  // Copy for LLMs carries the conversation, and where to read the rest of it.
  globalThis.ReviewTools.setConversationSource(id => threads[id]?.messages?.length ? {messages: threads[id].messages, series: review.history?.series} : null);

  // --- sync ----------------------------------------------------------------------------------
  const apply = data => {
    threads = data.threads; rev = data.rev; latest = data.latest_revision; listening = data.listening; listener = data.agent || listener; listenerModel = data.agent_model || (data.agent ? null : listenerModel); online = true; previews = data.previews || {};
    const ghNext = {pending: data.github?.pending || {}, posted: data.github?.posted || {}};
    if (JSON.stringify(ghNext) !== JSON.stringify({pending: ghData.pending, posted: ghData.posted})) ghData = ghNext;
    receiveComments(data.comments || []);
    // The Risk ranking the agent posts while the reader is already on the diff; until then, a placeholder.
    if ('risk_ranking' in data) window.ReviewRisk?.set(data.risk_ranking);
    window.ReviewRisk?.allowRedo(online);
    if (!seenKnown) { tools.unseen(threads, seen).forEach(item => seen.add(item.id)); saveSeen(); seenKnown = true; }
    const arrived = tools.unseen(threads, seen).filter(item => !announced.has(item.id));
    arrived.forEach(item => announced.add(item.id));
    decorate(); decorateLedger(); window.ReviewGitHub?.refresh(); renderPanel(); renderUnsent(); renderAgent(); refreshUnread();
    announce(arrived);
    announceFinished();
    syncPreviews();
  };
  const refresh = async () => apply(await api(`/api/state?key=${encodeURIComponent(key)}`));
  const poll = async () => {
    try { apply(await api(`/api/poll?key=${encodeURIComponent(key)}&since=${rev}`)); }
    catch { online = false; decorate(); renderPanel(); renderAgent(); await new Promise(resolve => setTimeout(resolve, 2000)); }
    poll();
  };
  new MutationObserver(() => { decorate(); renderPanel(); renderUnsent(); }).observe(content, {childList: true, subtree: true});
  const ledger = document.getElementById('ledger');
  if (ledger) new MutationObserver(() => { mount(); decorateLedger(); renderPanel(); }).observe(ledger, {childList: true, subtree: true});
  mount();
  poll();
  api('/api/adversaries').then(data => { adversaries = data.adversaries; decorate(); renderAgent(); if (data.decided === false) openIntro(); }).catch(() => { /* none until the card lists them */ });
})();
