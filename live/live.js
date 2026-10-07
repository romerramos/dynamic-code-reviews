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

  // --- thread cards ------------------------------------------------------------------------
  const cardBlock = id => {
    const thread = threads[id];
    const block = document.createElement('div');
    block.className = 'dcr-thread';
    block.dataset.dcr = id;
    block.innerHTML = `<div class="dcr-messages"></div><div class="dcr-compose"><textarea rows="2" aria-label="Message for your agent" placeholder="${thread?.live ? 'Reply to your agent' : 'Add a note for your agent (optional)'}"></textarea><div class="dcr-actions"><span class="dcr-status" role="status"></span><button type="button" class="btn btn-sm btn-soft" data-dcr-send></button></div></div>`;
    block.querySelector('textarea').value = drafts.get(id) || '';
    return block;
  };
  const refreshBlock = block => {
    const id = block.dataset.dcr;
    const thread = threads[id];
    // The DOM re-serialises markup (an escaped quote comes back as a quote), so compare the
    // string that was set, not innerHTML, or the observer would re-trigger itself forever.
    const box = block.querySelector('.dcr-messages');
    const html = tools.messagesHTML(thread);
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    set(block.querySelector('.dcr-status'), 'textContent', online ? tools.statusText(thread) : 'Server stopped. Restart `dcr serve` to send.');
    const button = block.querySelector('[data-dcr-send]');
    set(button, 'textContent', tools.actionLabel(thread));
    set(button, 'disabled', !online);
    set(block.querySelector('textarea'), 'placeholder', thread?.live ? 'Reply to your agent' : 'Add a note for your agent (optional)');
  };
  const decorate = () => {
    document.querySelectorAll('#content article.review-thread[data-thread-id]').forEach(card => {
      const id = card.dataset.threadId;
      if (!card.querySelector(':scope > .dcr-thread')) {
        const block = cardBlock(id);
        const footer = card.querySelector(':scope > .thread-footer');
        footer ? footer.before(block) : card.append(block);
      }
    });
    document.querySelectorAll('.dcr-thread').forEach(refreshBlock);
  };

  document.addEventListener('input', event => {
    const field = event.target.closest('.dcr-thread textarea');
    if (field) drafts.set(field.closest('.dcr-thread').dataset.dcr, field.value);
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-dcr-send]');
    if (!button) return;
    const block = button.closest('.dcr-thread');
    const id = block.dataset.dcr;
    const field = block.querySelector('textarea');
    const note = field.value.trim();
    button.disabled = true;
    try {
      if (threads[id]?.live) {
        if (!note) { field.focus(); return; }
        await api('/api/message', {key, id, body: note});
      } else {
        const comment = comments().find(comment => comment.id === id);
        if (!comment) throw new Error('This comment is not part of the review.');
        if (note) await api('/api/message', {key, id, body: note});
        await api('/api/send', {key, items: [{id, text: tools.sendText(snapshot, review, comment, note)}]});
      }
      drafts.delete(id);
      field.value = '';
      await refresh();
    } catch (error) { block.querySelector('.dcr-status').textContent = error.message; }
    finally { button.disabled = !online; }
  });

  // --- the Overview panel ------------------------------------------------------------------
  const panel = document.createElement('section');
  panel.id = 'dcr-panel';
  panel.setAttribute('aria-label', 'Live review');
  panel.innerHTML = '<div><strong>Live review</strong><span class="dcr-summary" role="status"></span></div><div class="dcr-actions"><button type="button" class="btn btn-sm btn-soft" data-dcr-send-all></button><button type="button" class="btn btn-sm btn-ghost" data-dcr-export>Export HTML</button><button type="button" class="btn btn-sm btn-primary" data-dcr-finish>Finish review</button></div><p class="dcr-note"></p>';
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
    const parts = [];
    if (!online) parts.push('server stopped');
    else {
      if (summary.waiting) parts.push(`${summary.waiting} waiting for your agent`);
      if (summary.answered) parts.push(`${summary.answered} answered`);
      if (!summary.waiting && !summary.answered) parts.push('connected');
    }
    set(panel.querySelector('.dcr-summary'), 'textContent', ` · ${parts.join(' · ')}`);
    const current = review.history?.revision;
    const note = panel.querySelector('.dcr-note');
    if (latest && current && latest > current) {
      set(note, 'innerHTML', `A newer revision (${latest}) was saved. <a href="/">Open it</a>`);
    }
    const send = panel.querySelector('[data-dcr-send-all]');
    set(send, 'textContent', summary.drafts ? `Send ${summary.drafts} comment${summary.drafts === 1 ? '' : 's'}` : 'Nothing to send');
    set(send, 'disabled', !online || !summary.drafts);
    set(panel.querySelector('[data-dcr-finish]'), 'disabled', !online);
  };
  const sendDrafts = async () => {
    const pending = tools.drafts(comments(), threads, resolved());
    if (!pending.length) return;
    await api('/api/send', {key, items: pending.map(comment => ({id: comment.id, text: tools.sendText(snapshot, review, comment)}))});
  };
  panel.addEventListener('click', async event => {
    const note = panel.querySelector('.dcr-note');
    try {
      if (event.target.closest('[data-dcr-send-all]')) { await sendDrafts(); note.textContent = 'Sent. Your agent will pick these up.'; }
      if (event.target.closest('[data-dcr-export]')) {
        // A plain link cannot send the token, so fetch the file and save it from a blob.
        const response = await fetch('/api/export', {headers: {'X-QA-Token': token}});
        if (!response.ok) throw new Error((await response.json()).error || 'Export failed');
        const link = Object.assign(document.createElement('a'), {href: URL.createObjectURL(await response.blob()), download: `${review.history?.series || 'review'}-review.html`});
        document.body.append(link); link.click(); link.remove();
        note.textContent = 'Exported. The file opens offline with your comments and the agent\'s replies.';
        return;
      }
      if (event.target.closest('[data-dcr-finish]')) { await sendDrafts(); await api('/api/finish', {key}); note.textContent = 'Finish sent. Your agent will pick this round up and reply here.'; }
      await refresh();
    } catch (error) { note.textContent = error.message; }
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
  const rowFor = (comment, thread) => {
    const found = globalThis.ReviewTools.anchor(snapshot, comment);
    const where = comment.general ? 'General comment' : `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`;
    const last = [...(thread.messages || [])].reverse().find(message => message.author === 'agent');
    return `<li class="ledger-item" data-ledger="${tools.escape(comment.id)}" data-state="${STATE[thread.delivery] || 'draft'}" data-conversation="1"><button type="button" class="ledger-jump" data-ledger-jump="${tools.escape(comment.id)}"><span class="ledger-where">${tools.escape(found?.file.path || 'General')} · ${tools.escape(where)}</span><span class="ledger-subject">${tools.escape(comment.subject)}</span></button><div class="ledger-meta"><span class="ledger-status">${tools.escape(tools.statusText(thread))}</span></div>${last ? `<p class="ledger-reply"><b>Agent</b> ${tools.escape(last.body)}</p>` : ''}</li>`;
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
      set(status, 'textContent', state === 'resolved' ? '' : tools.statusText(thread) || 'Not sent');
      const last = [...(thread?.messages || [])].reverse().find(message => message.author === 'agent');
      let reply = item.querySelector(':scope > .ledger-reply');
      if (last && !reply) { reply = document.createElement('p'); reply.className = 'ledger-reply'; item.append(reply); }
      if (reply) { if (last) { const text = last.body; if (reply.dataset.text !== text) { reply.replaceChildren(Object.assign(document.createElement('b'), {textContent: 'Agent'}), ` ${text}`); reply.dataset.text = text; } } else reply.remove(); }
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

  // --- sync ----------------------------------------------------------------------------------
  const apply = data => { threads = data.threads; rev = data.rev; latest = data.latest_revision; online = true; decorate(); decorateLedger(); renderPanel(); };
  const refresh = async () => apply(await api(`/api/state?key=${encodeURIComponent(key)}`));
  const poll = async () => {
    try { apply(await api(`/api/poll?key=${encodeURIComponent(key)}&since=${rev}`)); }
    catch { online = false; decorate(); renderPanel(); await new Promise(resolve => setTimeout(resolve, 2000)); }
    poll();
  };
  new MutationObserver(() => { decorate(); renderPanel(); }).observe(content, {childList: true, subtree: true});
  const ledger = document.getElementById('ledger');
  if (ledger) new MutationObserver(() => { mount(); decorateLedger(); renderPanel(); }).observe(ledger, {childList: true, subtree: true});
  mount();
  poll();
})();
