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
    await api('/api/send', {key, items: [{id, text: tools.sendText(snapshot, review, comment, note)}]});
    await refresh();
  };

  // --- thread cards ------------------------------------------------------------------------
  // The conversation under a comment is a plain thread: who, when, then the text. A line above it
  // says what is happening (sent, being worked on, replied). On an Overview card the one action
  // sits in the card's footer beside Copy and Resolve; in the diff popover it ends the thread.
  const cardBlock = (id, variant) => {
    const block = document.createElement('div');
    block.className = `dcr-thread dcr-${variant}`;
    block.dataset.dcr = id;
    block.innerHTML = `<div class="dcr-state" role="status" aria-live="polite"></div><div class="dcr-convo"></div><form class="dcr-reply" hidden><textarea rows="3" aria-label="Reply to your agent" placeholder="Reply to your agent"></textarea><div class="dcr-actions"><button type="submit" class="btn btn-sm btn-primary">Send reply</button><button type="button" class="btn btn-sm btn-ghost" data-dcr-cancel>Cancel</button></div></form>${variant === 'popover' ? `<div class="dcr-actions"><button type="button" class="btn btn-sm btn-primary" data-dcr-act data-dcr-for="${tools.escape(id)}"></button></div>` : ''}`;
    block.querySelector('textarea').value = drafts.get(id) || '';
    return block;
  };
  const actionButtons = id => document.querySelectorAll(`[data-dcr-act][data-dcr-for="${CSS.escape(id)}"]`);
  const stateHTML = (model, at) => model
    ? `<span class="dcr-dot dcr-tone-${model.tone}" aria-hidden="true"></span><span>${tools.escape(model.text)}</span>${model.typing ? '<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}${at ? `<time data-at="${tools.escape(at)}">${tools.escape(tools.relativeTime(at))}</time>` : ''}`
    : '';
  // Long answers start clamped; the button appears only when something is actually hidden.
  const clampLong = root => root.querySelectorAll('.dcr-body').forEach(body => {
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
    const thread = threads[id];
    const sent = !!thread && (thread.live || thread.delivery !== 'draft');
    // The DOM re-serialises markup (an escaped quote comes back as a quote), so compare the
    // string that was set, not innerHTML, or the observer would re-trigger itself forever.
    const convo = block.querySelector('.dcr-convo');
    const html = tools.messagesHTML(thread, {seen});
    // Keyed on the messages, not their text: "2 min ago" changes by itself and must not redraw.
    const signature = (thread?.messages || []).map(message => message.id + (message.author === 'agent' && !seen.has(message.id) ? '!' : '')).join('|');
    const model = online ? tools.statusModel(thread, listening) : {tone: 'off', text: 'The review server stopped. Restart `dcr serve` to send or receive.'};
    // The reply carries its own time; the status line only says that it came.
    const status = stateHTML(model, '');
    const statusSignature = model ? `${model.tone}|${model.text}` : '';
    const form = block.querySelector('.dcr-reply');
    if (!sent && !form.hidden) form.hidden = true;
    block.classList.toggle('has-content', !!(html || status || !form.hidden));
    if (convo.dataset.sig !== signature) { convo.innerHTML = html; convo.dataset.sig = signature; watchMessages(convo); }
    clampLong(convo);
    const stateEl = block.querySelector('.dcr-state');
    if (stateEl.dataset.sig !== statusSignature) { stateEl.innerHTML = status; stateEl.dataset.sig = statusSignature; }
    actionButtons(id).forEach(button => {
      set(button, 'textContent', sent ? 'Reply' : 'Send to agent');
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
    if (field) drafts.set(field.closest('.dcr-thread').dataset.dcr, field.value);
  });
  // The block that shows a comment's conversation: in its card, or in the popover.
  const blockFor = button => button.closest('.dcr-thread') || button.closest('article, .popover-comment')?.querySelector('.dcr-thread');
  document.addEventListener('click', async event => {
    const more = event.target.closest('.dcr-more');
    if (more) {
      const body = more.previousElementSibling;
      const open = body.classList.toggle('is-open');
      more.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    const cancel = event.target.closest('[data-dcr-cancel]');
    if (cancel) { const block = cancel.closest('.dcr-thread'); block.querySelector('.dcr-reply').hidden = true; refreshBlock(block); return; }
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
      await sendComment(id);
      flash(tools.statusModel(threads[id], listening)?.text || 'Sent to your agent.');
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
    form.querySelector('[type="submit"]').disabled = true;
    try {
      await api('/api/message', {key, id, body: text});
      drafts.delete(id);
      field.value = '';
      form.hidden = true;
      await refresh();
      flash(tools.statusModel(threads[id], listening)?.text || 'Reply sent to your agent.');
    } catch (error) { flash(error.message); }
    finally { form.querySelector('[type="submit"]').disabled = false; }
  });

  // --- the Overview panel ------------------------------------------------------------------
  const panel = document.createElement('section');
  panel.id = 'dcr-panel';
  panel.setAttribute('aria-label', 'Live review');
  const ico = name => (window.ReviewIcons?.[name] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  panel.innerHTML = `<p class="dcr-foot-status" role="status"><span class="dcr-dot" aria-hidden="true"></span><span class="dcr-summary"></span></p>
    <button type="button" class="act act-primary act-block" data-open-send>${ico('send')}<span>Review and send</span><b class="act-count"></b></button>
    <div class="dcr-foot-row"><button type="button" class="act act-secondary" data-dcr-export title="Download one offline file with your comments, the replies and any recordings">${ico('download')}Export</button><button type="button" class="act act-secondary" data-dcr-finish title="Send anything unsent and tell your agent this round is done">${ico('check-check')}Finish review</button></div>
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
    if (!online) parts.push('Server stopped');
    else if (!mine && !summary.waiting && !summary.answered) parts.push('No comments yet');
    else {
      parts.push(`${mine} comment${mine === 1 ? '' : 's'}`);
      if (summary.drafts) parts.push(`${summary.drafts} not sent`);
      if (summary.waiting) parts.push(`${summary.waiting} with your agent`);
      if (summary.answered) parts.push(`${summary.answered} answered`);
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
    finish.classList.toggle('act-primary', !summary.drafts);
    finish.classList.toggle('act-secondary', !!summary.drafts);
  };
  const sendDrafts = async () => {
    const pending = tools.drafts(comments(), threads, resolved());
    if (!pending.length) return;
    await api('/api/send', {key, items: pending.map(comment => ({id: comment.id, text: tools.sendText(snapshot, review, comment)}))});
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
      if (event.target.closest('[data-dcr-finish]')) {
        await sendDrafts(); await api('/api/finish', {key}); await refresh();
        flash('Finished. Your agent will pick this round up and reply here.');
      }
    } catch (error) { flash(error.message); }
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
  const STATE = {sent: 'sent', delivered: 'sent', answered: 'answered'};
  const plain = tools.snippet;
  const unseenIn = thread => (thread?.messages || []).some(message => message.author === 'agent' && !seen.has(message.id));
  const rowFor = (comment, thread) => {
    const found = globalThis.ReviewTools.anchor(snapshot, comment);
    const where = comment.general ? 'General comment' : `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`;
    const last = [...(thread.messages || [])].reverse().find(message => message.author === 'agent');
    return `<li class="ledger-item" data-ledger="${tools.escape(comment.id)}" data-state="${STATE[thread.delivery] || 'draft'}" data-conversation="1"><button type="button" class="ledger-jump" data-ledger-jump="${tools.escape(comment.id)}"><span class="ledger-where">${tools.escape(found?.file.path || 'General')} · ${tools.escape(where)}</span><span class="ledger-subject">${tools.escape(comment.subject)}</span></button><div class="ledger-meta"><span class="ledger-status">${tools.escape(tools.statusText(thread, listening))}</span>${unseenIn(thread) ? '<span class="dcr-new">New</span>' : ''}</div>${last ? `<p class="ledger-reply"><b>Agent</b> ${tools.escape(plain(last.body))}</p>` : ''}</li>`;
  };
  const decorateLedger = () => {
    const body = document.getElementById('ledger-body');
    if (!body) return;
    // Your own comments gain their delivery state and the agent's latest answer.
    body.querySelectorAll('.ledger-item[data-ledger]:not([data-conversation])').forEach(item => {
      const thread = threads[item.dataset.ledger];
      const state = item.dataset.state === 'resolved' ? 'resolved' : STATE[thread?.delivery] || 'draft';
      set(item.dataset, 'state', state);
      const meta = item.querySelector('.ledger-meta');
      let status = meta.querySelector('.ledger-status');
      if (!status) { status = document.createElement('span'); status.className = 'ledger-status'; meta.prepend(status); }
      // An unsent comment shows its Send button instead of saying it is unsent.
      set(status, 'textContent', state === 'resolved' || (state === 'draft' && online) ? '' : tools.statusText(thread, listening) || 'Not sent');
      let fresh = meta.querySelector('.dcr-new');
      if (unseenIn(thread) && !fresh) { fresh = Object.assign(document.createElement('span'), {className: 'dcr-new', textContent: 'New'}); status.after(fresh); }
      if (!unseenIn(thread) && fresh) fresh.remove();
      let send = meta.querySelector('.dcr-row-send');
      const canSend = state === 'draft' && online;
      if (canSend && !send) { send = Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-row-send', textContent: 'Send to agent'}); send.dataset.dcrRowSend = item.dataset.ledger; status.after(send); }
      if (!canSend && send) send.remove();
      const last = [...(thread?.messages || [])].reverse().find(message => message.author === 'agent');
      let reply = item.querySelector(':scope > .ledger-reply');
      if (last && !reply) { reply = document.createElement('p'); reply.className = 'ledger-reply'; item.append(reply); }
      if (reply) { if (last) { const text = plain(last.body); if (reply.dataset.text !== text) { reply.replaceChildren(Object.assign(document.createElement('b'), {textContent: 'Agent'}), ` ${text}`); reply.dataset.text = text; } } else reply.remove(); }
    });
    // Conversations about the agent's own findings that you have joined.
    const mine = new Set(comments().filter(comment => comment.personal).map(comment => comment.id));
    const rows = comments().filter(comment => !mine.has(comment.id) && threads[comment.id] && (threads[comment.id].delivery !== 'draft' || threads[comment.id].messages?.length))
      .map(comment => rowFor(comment, threads[comment.id])).join('');
    let section = body.querySelector(':scope > .dcr-convos');
    if (!rows) { section?.remove(); return; }
    if (!section) { section = document.createElement('section'); section.className = 'ledger-group dcr-convos'; body.prepend(section); }
    const html = `<h3>Conversations with your agent</h3><ul class="ledger-list">${rows}</ul>`;
    if (section.dataset.html !== html) { section.innerHTML = html; section.dataset.html = html; }
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

  // The composer in the code gets its "Comment and send" action: save, then hand the comment to your agent.
  window.ReviewComposer?.setSender(async id => {
    try { await sendComment(id); flash(tools.statusModel(threads[id], listening)?.text || 'Saved and sent to your agent.'); }
    catch (error) { flash(`Saved, but not sent: ${error.message}`); }
  });

  // 2. A quiet reminder wherever you are, until the comment is sent. Your review shows the same
  //    action itself, so the reminder steps aside while that panel is open.
  const unsent = document.createElement('div');
  unsent.id = 'dcr-unsent';
  unsent.hidden = true;
  unsent.innerHTML = '<span></span><button type="button" class="btn btn-sm btn-primary" data-open-send>Review and send</button>';
  document.body.append(unsent);
  const renderUnsent = () => {
    const count = tools.drafts(comments(), threads, resolved()).length;
    unsent.hidden = !count || !online || document.body.classList.contains('ledger-open');
    set(unsent.querySelector('span'), 'textContent', `${count} comment${count === 1 ? '' : 's'} not sent`);
  };
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
        const items = ids.map(id => ({id, text: tools.sendText(snapshot, review, comments().find(comment => comment.id === id))}));
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
      section.append(cardBlock(section.dataset.commentId, 'popover'));
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
    try { await sendComment(button.dataset.dcrRowSend); flash('Sent to your agent.'); }
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

  // The agent as a whole, in the reading bar: listening, working or not connected.
  const agentPill = document.createElement('span');
  agentPill.id = 'dcr-agent';
  agentPill.setAttribute('role', 'status');
  agentPill.hidden = true;
  agentPill.innerHTML = '<span class="dcr-dot" aria-hidden="true"></span><span class="dcr-agent-text"></span>';
  const optionsBar = document.querySelector('.toolbar-options');
  if (optionsBar) optionsBar.prepend(agentPill);
  // The agent's state lives on Your review, where its answers arrive: a dot on the button and the
  // words in its tooltip, so the reading bar keeps one control per job.
  const ledgerButton = document.getElementById('ledger-toggle');
  const agentDot = document.createElement('span');
  agentDot.className = 'dcr-dot dcr-agent-dot';
  agentDot.setAttribute('aria-hidden', 'true');
  if (ledgerButton) ledgerButton.prepend(agentDot);
  const renderAgent = () => {
    const model = online ? tools.agentModel(threads, listening, Date.now(), previews) : {tone: 'off', text: 'Server stopped', hint: 'Restart `dcr serve` to send or receive.'};
    if (ledgerButton) {
      agentPill.hidden = true;
      agentDot.hidden = !model;
      if (!model) return;
      agentDot.dataset.tone = model.tone;
      ledgerButton.title = `Your review (L). ${model.text}: ${model.hint}`;
      if (!ledgerButton.contains(agentDot)) ledgerButton.prepend(agentDot);
      return;
    }
    agentPill.hidden = !model;
    if (!model) return;
    agentPill.dataset.tone = model.tone;
    set(agentPill.querySelector('.dcr-agent-text'), 'textContent', model.text);
    agentPill.title = model.hint;
  };

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
    if (!items.length) return;
    const first = comments().find(comment => comment.id === items[0].thread);
    const many = new Set(items.map(item => item.thread)).size > 1;
    arrival.innerHTML = `<span class="dcr-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg></span><div><strong>${many ? 'Your agent replied to several comments' : 'Your agent replied'}</strong>${!many && first ? `<span>${tools.escape(first.subject)}</span>` : ''}</div>${first ? `<button type="button" class="btn btn-sm btn-primary" data-ledger-jump="${tools.escape(first.id)}">View</button>` : ''}<button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => { arrival.hidden = true; }, 12000);
  };
  arrival.addEventListener('click', event => { if (event.target.closest('[data-ledger-jump], .dcr-dismiss')) arrival.hidden = true; });

  // "5 min ago" stays true while the page is open.
  setInterval(() => document.querySelectorAll('time[data-at]').forEach(node => set(node, 'textContent', tools.relativeTime(node.dataset.at))), 30000);

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

  // --- sync ----------------------------------------------------------------------------------
  const apply = data => {
    threads = data.threads; rev = data.rev; latest = data.latest_revision; listening = data.listening; online = true; previews = data.previews || {};
    if (!seenKnown) { tools.unseen(threads, seen).forEach(item => seen.add(item.id)); saveSeen(); seenKnown = true; }
    const arrived = tools.unseen(threads, seen).filter(item => !announced.has(item.id));
    arrived.forEach(item => announced.add(item.id));
    decorate(); decorateLedger(); renderPanel(); renderUnsent(); renderAgent(); refreshUnread();
    announce(arrived);
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
})();
