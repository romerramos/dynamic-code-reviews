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
  let latest = null, latestSave = 0;
  // The saved review is ahead of this page: a later revision, or this one saved into since (the
  // full review, QA, previews). mark names what is saved now.
  const newer = () => { const shown = review.history || {}; return !!latest && !!shown.revision && (latest > shown.revision || (latest === shown.revision && latestSave > (shown.save || 0))); };
  const mark = () => `${latest || 0}.${latestSave}`;
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
  // Reply text survives the review re-rendering its cards, and, kept by the page as it is typed, a reload.
  const kept = globalThis.ReviewDrafts;
  let me = null; // who the GitHub CLI is signed in as, for the reader's own avatar
  const drafts = {get: id => kept.get(`reply:${id}`), set: (id, text) => kept.set(`reply:${id}`, text), delete: id => kept.set(`reply:${id}`, '')};
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
  let progressChanged = () => {}; // this review's progress was saved: Publish counts again
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    realSetItem.call(this, name, value);
    if (this !== localStorage) return;
    if (pushable(name)) push(name);
    else if (name === settingsKey) pushSettings();
    if (name === key) progressChanged();
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
  // the whole comment (long ones start folded). The place is already in the bar above, and an agent's
  // title too; the reader's own comment is their message, every word of it, as in a chat.
  const quoteHTML = comment => {
    if (!comment) return '';
    const text = (comment.personal ? [comment.subject, comment.discussion] : [comment.discussion]).filter(Boolean).join('\n\n').trim();
    const avatar = comment.personal ? tools.youHTML(me) : tools.avatarHTML(comment.agent || null);
    const who = comment.personal ? `<span class="you-name">${tools.escape(tools.youName(me))}</span>` : comment.agent ? tools.escape(tools.agentInfo(comment.agent).name) : 'Review';
    // Asking your own agent needs no label: the conversation is with it.
    const kind = (comment.audience === 'agent' ? '' : [comment.label, comment.decoration].filter(Boolean).join(' · ')).replace(/^./, letter => letter.toUpperCase());
    const long = text.length > 320 || text.split(/\n\s*\n/).length > 2;
    const body = text ? `<div class="dcr-body${long ? ' is-clamped' : ''}">${tools.markdown(text)}</div>${long ? '<button type="button" class="dcr-more">Show more</button>' : ''}` : '';
    return `<article class="dcr-msg dcr-origin${comment.personal ? ' dcr-you' : ' dcr-agent'}">${avatar}<div class="dcr-msg-main"><header class="dcr-msg-head"><strong>${who}</strong>${comment.personal ? '' : tools.modelHTML(comment)}${kind ? `<span class="dcr-role">${tools.escape(kind)}</span>` : ''}</header>${body}</div></article>`;
  };
  const advToggleHTML = '<button type="button" class="dcr-adv-toggle" data-dcr-adv hidden aria-pressed="false"></button>';
  const composeHTML = () => `<form class="dcr-reply dcr-compose" hidden><textarea rows="1" aria-label="Reply to your agent" placeholder="Reply to your agent"></textarea>${advToggleHTML}<button type="button" class="dcr-change dcr-gh" data-dcr-github hidden aria-label="Sum this conversation up for GitHub" title="Sum this conversation up as a comment for GitHub">${window.ReviewGitHub?.mark || ''}</button><button type="button" class="dcr-change" data-dcr-change hidden aria-label="Make this change">${ico('wrench')}</button><button type="submit" class="dcr-send" aria-label="Send reply" title="Send reply (⌘ Enter)">${ico('send')}</button></form>`;
  const cardBlock = (id, variant, comment) => {
    const block = document.createElement('div');
    block.className = `dcr-thread dcr-${variant}`;
    block.dataset.dcr = id;
    block.innerHTML = variant === 'ledger'
      ? `<div class="dcr-scroll">${quoteHTML(comment)}<div class="dcr-convo"></div><div class="dcr-state" role="status" aria-live="polite"></div><div class="dcr-opinions-slot"></div></div>${composeHTML()}`
      : `<div class="dcr-state" role="status" aria-live="polite"></div><details class="dcr-stage" open><summary class="dcr-stage-head" hidden></summary><div class="dcr-convo"></div><div class="dcr-opinions-slot"></div></details><form class="dcr-reply" hidden><textarea rows="3" aria-label="Reply to your agent" placeholder="Reply to your agent"></textarea><div class="dcr-actions"><span class="dcr-send-hint"><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd> <kbd>Enter</kbd> sends</span>${advToggleHTML}<button type="button" class="btn btn-sm btn-ghost" data-dcr-cancel>Cancel</button><button type="button" class="btn btn-sm btn-ghost" data-dcr-change hidden>${ico('wrench')}Make this change</button><button type="submit" class="btn btn-sm btn-primary">Send reply</button></div></form>${variant === 'popover' ? `<div class="dcr-actions"><button type="button" class="btn btn-sm btn-primary" data-dcr-act data-dcr-for="${tools.escape(id)}"></button></div>` : ''}`;
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
    const html = tools.messagesHTML(thread, {seen, agent: listener, me});
    const opinions = tools.opinionsHTML(thread);
    // Keyed on the messages, not their text: "2 min ago" changes by itself and must not redraw.
    const signature = [...(thread?.messages || []), ...tools.opinionMessages(thread)].map(message => message.id + (message.author === 'agent' && !seen.has(message.id) ? '!' : '')).join('|');
    const model = online ? tools.statusModel(thread, listening, Date.now(), listener) : {tone: 'off', text: 'The review server stopped. Restart `dcr serve` to send or receive.'};
    // Under a thread the status line only says what is still happening; an answer is shown, not announced.
    // What became of the comment once its code changed: each agent's word, and the reader's closing buttons.
    const comment = comments().find(entry => entry.id === id);
    const outcome = tools.closureHTML(thread, {plain: ledger, resolve: resolved().includes(id) ? null : id, still: !!comment && !comment.personal && online && !fixingId(), open: [...(openOpinions.get(id) || [])]});
    const action = actionOf(id);
    // A request that was not taken says why here, and stays until it is read: a toast is gone too soon.
    const refused = refusals.has(id) ? `<p class="dcr-refusal" role="alert">${ico('circle-alert')}<span>${tools.escape(refusals.get(id))}</span><button type="button" class="btn btn-xs btn-ghost" data-dcr-refusal="${tools.escape(id)}">Dismiss</button></p>` : '';
    // An answer is its own message, signed by who wrote it: no line above it says that it came.
    const status = refused + outcome + (model?.tone === 'done' ? '' : stateHTML(model, ''));
    const statusSignature = status ? `${model?.tone}|${model?.text}|${outcome}|${refused}` : '';
    const form = block.querySelector('.dcr-reply');
    if (ledger) {
      set(form, 'hidden', !sent);
      const field = form.querySelector('textarea');
      set(field, 'disabled', !online);
      set(field, 'placeholder', online ? 'Reply to your agent' : 'The review server stopped');
      set(form.querySelector('.dcr-send'), 'disabled', !online);
      const github = form.querySelector('[data-dcr-github]');
      const entry = comments().find(found => found.id === id);
      set(github, 'hidden', !(ghStatus.phase === 'ready' && ghProvider.talked(id) && entry && globalThis.ReviewTools.githubLink(snapshot, review, entry) && !['posted', 'posting'].includes(ghProvider.stateOf(id).state)));
    } else if (!sent && !form.hidden && !form.dataset.mode) form.hidden = true;
    const change = form.querySelector('[data-dcr-change]');
    if (change) {
      const busy = fixingId();
      set(change, 'hidden', !sent || !!form.dataset.mode || !changeOf(id));
      set(change, 'disabled', !online || !!busy);
      set(change, 'title', busy ? 'Your agent is changing the code for a comment. One at a time, so each shows as its own change.' : 'Have your agent make the change your message asks for, in your checkout. The next revision shows that change and nothing else.');
    }
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
    // With a closing block, the discussion before it folds under one line, unless it went on since.
    const stage = block.querySelector('.dcr-stage');
    if (stage) {
      const closing = tools.closure(thread);
      const head = stage.querySelector('.dcr-stage-head');
      const earlier = (thread?.messages || []).filter(message => !(message.about === 'outcome' || (message.author === 'agent' && !message.role && message.outcome)));
      const went = closing && earlier.some(message => message.at > (thread.outcome.at || ''));
      const fold = closing && (html || opinions) ? (went ? 'open' : 'folded') : 'none';
      set(head, 'hidden', fold === 'none');
      if (fold !== 'none') {
        const count = earlier.length || tools.verdicts(thread, 'comment').length;
        const label = `<span>Earlier discussion</span><span class="dcr-stage-note">${tools.escape([count && `${count} ${earlier.length ? 'message' : 'opinion'}${count === 1 ? '' : 's'}`, comment?.outdated?.revision && `revision ${comment.outdated.revision}`].filter(Boolean).join(' · '))}</span>${ico('chevron-down')}`;
        if (head.dataset.html !== label) { head.innerHTML = label; head.dataset.html = label; }
      }
      // Set when what it should be changes, so the reader's own opening or closing is kept.
      if (stage.dataset.fold !== fold) { stage.dataset.fold = fold; stage.open = fold !== 'folded'; }
    }
    const stateEl = block.querySelector('.dcr-state');
    if (stateEl.dataset.sig !== statusSignature) { stateEl.innerHTML = status; stateEl.dataset.sig = statusSignature; }
    // The adversaries only ever give opinions: they can be asked along with a question, an answer
    // or a reply, never with a request that changes code.
    syncAdvToggles(block.querySelectorAll('.dcr-reply .dcr-adv-toggle'), id, form.dataset.mode !== 'act');
    // Everything that goes to the agent is one control: its mark and the first action, which
    // follows what the comment is, and a menu with the rest. Where there is no room for the
    // words, or the comment asks for nothing (the agent's note or praise), the mark alone opens
    // the menu. What the agent wrote is replied to with words of the reader's own; sending it
    // back as it is would only have the agent confirm itself.
    // While the text box is open its own send button, right under it, says what it sends; this
    // control is hidden then (.is-writing), so the action is named once.
    (ledger ? null : block.closest('article, .popover-comment'))?.querySelectorAll('[data-dcr-split]').forEach(split => {
      const main = split.querySelector('.dcr-split-main');
      const menu = split.querySelector('.dcr-split-menu');
      const list = menu.querySelector('.more-list');
      const act = split.querySelector('[data-dcr-act]');
      const fix = split.querySelector('[data-dcr-fix]');
      const noted = split.querySelector('[data-dcr-fix-note]');
      const writing = !form.hidden;
      const mode = writing ? form.dataset.mode || 'reply' : null;
      const narrow = !writing && (narrowCards.matches || (!sent && action?.kind === 'none'));
      const fixing = thread?.fix?.state === 'requested';
      const other = !fixing && fixingId();
      // While its change runs, the control says so (Fixing…), whatever was said in the thread since.
      const first = writing ? (mode === 'act' ? fix : act) : action?.act && (fixing || (!sent && action.kind !== 'answer')) ? fix : act;
      if (narrow) { if (list.firstElementChild !== first) list.prepend(first); }
      else if (first.parentElement !== main) main.replaceChildren(first);
      const second = first === fix ? act : fix;
      if (second.parentElement !== list || second.nextElementSibling) list.append(second);
      // Fix this and Apply this go at once; the same with something to add is one step down.
      if (noted.parentElement !== list || noted.nextElementSibling !== second) second.before(noted);
      // Behind Fix this or Apply this, replying is the way to say something without a change.
      paint(act, writing ? (mode === 'answer' && action?.kind === 'answer' ? 'Send answer' : 'Send reply') : !sent && mine(id) ? 'Ask agent' : !sent && action?.kind === 'answer' ? 'Answer' : first === fix ? 'Just reply' : 'Reply', first === act && !narrow);
      set(act, 'disabled', !online);
      act.classList.toggle('dcr-act-reply', sent && !writing);
      set(fix, 'hidden', !action?.act);
      const direct = !!action?.act && action.kind !== 'answer';
      set(noted, 'hidden', !direct || fixing || writing);
      if (action?.act) {
        paint(fix, fixing ? action.busy : action.act, first === fix && !narrow);
        if (direct) paint(noted, `${action.act.replace(' this', '')} with a note…`);
        [fix, noted].forEach(button => {
          set(button, 'disabled', !online || fixing || !!other);
          set(button, 'title', fixing ? 'Your agent is working on it. The next revision shows what it changed.' : other ? 'Your agent is changing the code for another comment. One at a time, so each shows as its own change.' : 'Have your agent change the code in your checkout. The next revision shows that change and nothing else.');
        });
      }
      [act, fix].forEach(button => { button.classList.toggle('btn-primary', button === first && (writing || (!sent && !!action?.act))); button.classList.toggle('btn-ghost', button !== first); });
      split.classList.toggle('is-narrow', narrow);
      split.classList.toggle('is-writing', writing);
      const more = menu.querySelector('summary');
      const face = `${narrow ? agentMark() : ''}${ico('chevron-down')}`;
      if (more.dataset.html !== face) { more.innerHTML = face; more.dataset.html = face; }
      set(menu, 'hidden', writing || (!narrow && second.hidden && noted.hidden));
      set(split.querySelector('.dcr-split-cancel'), 'hidden', !writing);
    });
    if (block.classList.contains('dcr-popover')) widenPopover();
  };
  // Fix this: on a comment the agent wrote, asking it again only has it confirm itself; what
  // helps is having it act. Not on a comment whose lines already changed.
  const fixable = id => { const comment = comments().find(entry => entry.id === id); return !!comment && !comment.personal && !comment.outdated && !resolved().includes(id); };
  // Its first action, by what the comment is (tools.commentAction); null on one that is not the agent's to act on.
  const actionOf = id => fixable(id) ? tools.commentAction(comments().find(entry => entry.id === id).label) : null;
  const mine = id => comments().find(entry => entry.id === id)?.personal !== false;
  // A reply sent as a change, on your own comment too: the agent does what the message asks, in
  // the light of the conversation. On the agent's own issue or suggestion the message is a note
  // to its Fix this or Apply this.
  const CHANGE = {kind: 'answer', act: 'Make this change', busy: 'Working on it…'};
  const changeOf = id => {
    const comment = comments().find(entry => entry.id === id);
    if (!comment || comment.outdated || resolved().includes(id)) return null;
    const action = comment.personal ? null : actionOf(id);
    return action && (action.kind === 'fix' || action.kind === 'apply') ? action : CHANGE;
  };
  // The card's one text box, for a reply, an answer to the agent's question, or what to add to a fix.
  const openForm = (block, mode, action = null) => {
    const form = block?.querySelector('.dcr-reply');
    if (!form) return;
    const field = form.querySelector('textarea');
    mode ? form.dataset.mode = mode : delete form.dataset.mode;
    form.hidden = false;
    refreshBlock(block);
    const answering = action?.kind === 'answer';
    field.placeholder = mode === 'act' ? (answering ? 'Your answer, for your agent to act on' : 'Anything to add? (optional)') : mode === 'answer' && answering ? 'Your answer' : 'Reply to your agent';
    if (!form.classList.contains('dcr-compose')) form.querySelector('[type="submit"]').textContent = mode === 'act' ? action.act : mode === 'answer' && answering ? 'Send answer' : 'Send reply';
    field.focus();
  };
  // Fix this, Apply this, Act on this. The server first brings the review to the code as it is (a
  // pull request's review goes on to follow the checkout), so the fix shows as its own revision;
  // when that saved a revision the page opens it, where the reader was.
  const refusals = new Map();
  const refuse = (id, message) => { refusals.set(id, message); document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"]`).forEach(refreshBlock); };
  const askFix = async (id, action, comment, note) => {
    refusals.delete(id);
    const result = await api('/api/fix', {key, id, ask: action.kind, ...(note === null ? {} : {note}), text: tools.sendText(snapshot, review, comment, note || '', threads[id])});
    const unheard = listening === false ? ' No agent is listening yet; it starts when your agent picks it up.' : '';
    const said = result.outdated ? 'This comment\'s code had already changed in your checkout. The review is updated; nothing was sent.'
      : `Your agent is on it.${result.followed ? ' This review now shows your checkout.' : result.revision ? ' The review was updated to your checkout first.' : ''}${unheard}`;
    if (result.revision) {
      try { sessionStorage.setItem(updatedKey, said); } catch { /* the Overview says it too */ }
      history.replaceState(null, '', `/${location.hash}`);
      location.reload();
      return false;
    }
    await refresh();
    staleAt = 0; checkStale();
    flash(said);
    return true;
  };
  const fixingId = () => Object.keys(threads).find(id => threads[id].fix?.state === 'requested' && Date.now() - Date.parse(threads[id].fix.at) < 3600000);
  // The listening agent's mark, on the control that sends to it.
  const agentMark = () => listener ? tools.avatarHTML(listener, 'dcr-face-sm') : ico('sparkles');
  // The control carries the agent's mark once, on its button; what is in its menu goes to the
  // same agent and does not repeat it.
  const paint = (button, text, marked = false) => {
    const html = `${marked ? agentMark() : ''}<span>${tools.escape(text)}</span>`;
    if (button.dataset.html !== html) { button.innerHTML = html; button.dataset.html = html; }
  };
  const narrowCards = matchMedia('(max-width: 640px)');
  narrowCards.addEventListener('change', () => document.querySelectorAll('.dcr-thread').forEach(refreshBlock));
  const addSplit = (actions, id, size) => {
    actions.insertAdjacentHTML('afterbegin', `<span class="dcr-split"><span class="dcr-split-main"></span><details class="more-menu dcr-split-menu" data-menu-from="parent"><summary class="btn btn-${size} btn-ghost dcr-split-more" aria-label="More for your agent" title="More for your agent"></summary><div class="more-list"></div></details><button type="button" class="btn btn-${size} btn-ghost dcr-split-cancel" data-dcr-cancel hidden>Cancel</button></span>`);
    const split = actions.firstElementChild;
    split.dataset.dcrSplit = id;
    const act = Object.assign(document.createElement('button'), {type: 'button', className: `btn btn-${size} dcr-card-act`});
    Object.assign(act.dataset, {dcrAct: '1', dcrFor: id});
    const fix = Object.assign(document.createElement('button'), {type: 'button', className: `btn btn-${size} dcr-card-fix`, hidden: true});
    fix.dataset.dcrFix = id;
    split.querySelector('.dcr-split-main').append(act);
    const noted = Object.assign(document.createElement('button'), {type: 'button', className: `btn btn-${size} btn-ghost dcr-card-fix`, hidden: true});
    noted.dataset.dcrFixNote = id;
    split.querySelector('.more-list').append(noted, fix);
  };
  // What became of a comment whose code changed, in a word: the tag on its folded card in the
  // Overview and on its row in Your review.
  const becameOf = id => {
    const closing = tools.closure(threads[id]);
    return {state: closing?.state || 'none', label: !closing ? 'Not checked yet' : closing.state === 'waiting' ? 'Being checked' : closing.state === 'applies' ? 'Still applies' : resolved().includes(id) ? 'Resolved' : 'No longer a problem'};
  };
  // A comment the agents differ on, or one sent back to be fixed, is the reader's to close: it
  // stays with the current comments until then.
  const undecided = id => (tools.closure(threads[id])?.state === 'differ' || threads[id]?.fix?.state === 'requested') && !resolved().includes(id);
  const putAway = id => { const comment = comments().find(entry => entry.id === id); return !!comment?.outdated && !comment.personal && !undecided(id); };
  const decorate = () => {
    document.querySelectorAll('#content article.review-thread[data-thread-id]').forEach(card => {
      const id = card.dataset.threadId;
      if (!card.querySelector(':scope > .dcr-thread')) {
        const block = cardBlock(id, 'card');
        const footer = card.querySelector(':scope > .thread-footer');
        footer ? footer.before(block) : card.append(block);
      }
      const actions = card.querySelector('.comment-actions');
      if (actions && !actions.querySelector('[data-dcr-split]')) addSplit(actions, id, 'sm');
    });
    document.querySelectorAll('.dcr-thread').forEach(refreshBlock);
    // From earlier revisions holds what is settled. A comment the agents differ on is the
    // reader's to close, so it goes back up, first in the list. Each folded card says what
    // became of it, and the section adds them up and closes the settled ones in one click.
    const section = document.querySelector('#content details.overview-earlier');
    if (!section) return;
    const said = {};
    section.querySelectorAll('article.review-thread.is-earlier').forEach(card => {
      const id = card.dataset.threadId;
      if (undecided(id)) {
        card.classList.remove('is-earlier');
        card.classList.add('is-undecided');
        (section.parentElement.querySelector(':scope > article.review-thread:not(.is-undecided), :scope > details.overview-resolved') || section).before(card);
        return;
      }
      const {label, state} = becameOf(id);
      said[label] = (said[label] || 0) + 1;
      const head = card.querySelector('.thread-range');
      let chip = head?.querySelector('.dcr-earlier-outcome');
      if (head && !chip) { chip = document.createElement('span'); head.prepend(chip); }
      if (chip && chip.textContent !== label) { chip.className = `dcr-earlier-outcome dcr-c-${state}`; chip.textContent = label; }
    });
    // One the reader has to close went back up: then something is waiting.
    const quiet = section.parentElement.querySelector('[data-overview-status]');
    if (quiet) set(quiet, 'hidden', !!section.parentElement.querySelector(':scope > article.is-undecided'));
    const left = section.querySelectorAll('article.review-thread.is-earlier').length;
    set(section, 'hidden', !left);
    const badge = section.querySelector('summary .badge');
    if (badge && badge.textContent !== String(left)) badge.textContent = left;
    const sum = section.querySelector('[data-earlier-outcomes]');
    const text = Object.entries(said).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(' · ');
    const open = settledIds().length;
    const html = `${tools.escape(text)}${open ? `<button type="button" class="btn btn-xs" data-dcr-settle>Resolve ${open === 1 ? 'it' : `those ${open}`}</button>` : ''}`;
    if (sum && sum.dataset.html !== html) { sum.innerHTML = html; sum.dataset.html = html; }
  };
  // A comment on changed code that every agent agrees is dealt with resolves itself, once: the
  // reader who reopens it keeps it open.
  const autoKey = `dcr-auto:${key}`;
  let autoResolved = new Set();
  try { autoResolved = new Set(JSON.parse(localStorage.getItem(autoKey) || '[]')); } catch { /* resolved again at worst */ }
  const autoResolve = () => {
    const due = comments().filter(comment => comment.outdated && !comment.personal && !autoResolved.has(comment.id) && !resolved().includes(comment.id) && tools.confirmed(threads[comment.id]));
    if (!due.length) return;
    due.forEach(comment => autoResolved.add(comment.id));
    try { localStorage.setItem(autoKey, JSON.stringify([...autoResolved])); } catch { /* this session only */ }
    due.forEach(comment => document.querySelector(`#content .thread-footer > [data-resolve="${CSS.escape(comment.id)}"]`)?.click());
  };
  // The outdated comments every agent says are dealt with, and the reader has not resolved yet.
  const settledIds = () => comments().filter(comment => comment.outdated && !comment.personal && !resolved().includes(comment.id) && tools.closure(threads[comment.id])?.state === 'settled').map(comment => comment.id);

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
    if (cancel) { const block = blockFor(cancel); const form = block.querySelector('.dcr-reply'); form.hidden = true; delete form.dataset.mode; refreshBlock(block); return; }
    const advToggle = event.target.closest('.dcr-adv-toggle');
    if (advToggle) {
      const id = advToggle.dataset.dcrAdvFor;
      if (!withAdversaries.delete(id)) withAdversaries.add(id);
      if (id === COMPOSER) syncComposerAdv();
      else document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"]`).forEach(refreshBlock);
      return;
    }
    // The reader closes a comment whose code changed: which side they took is kept beside what
    // each agent said, and Still a problem sends it back to the agent as a fix.
    const side = event.target.closest('.dcr-closure [data-dcr-side]');
    if (side) {
      const id = side.dataset.resolve || side.dataset.dcrStill;
      api('/api/closure', {key, id, side: side.dataset.dcrSide}).catch(() => {});
      if (side.dataset.dcrStill) {
        const comment = comments().find(entry => entry.id === id);
        side.disabled = true;
        try { if (comment) await askFix(id, {kind: 'fix'}, comment, 'This is still a problem in the code as it is now. Fix it.'); } catch (error) { refuse(id, error.message); }
        decorate();
        return;
      }
    }
    const settle = event.target.closest('[data-dcr-settle]');
    if (settle) {
      event.preventDefault();
      settledIds().forEach(id => document.querySelector(`#content .thread-footer > [data-resolve="${CSS.escape(id)}"]`)?.click());
      return;
    }
    // The card's own Resolve closes it on the side the agents took.
    const closed = event.target.closest('.thread-footer > [data-resolve].btn-soft');
    const closedOn = closed && tools.closure(threads[closed.dataset.resolve]);
    if (closedOn) api('/api/closure', {key, id: closed.dataset.resolve, side: closedOn.side}).catch(() => {});
    const changing = event.target.closest('[data-dcr-change]');
    if (changing) {
      const form = changing.closest('.dcr-reply');
      const action = changeOf(form.closest('.dcr-thread').dataset.dcr);
      const field = form.querySelector('textarea');
      // Acting on the conversation needs to know what to do.
      if (!action || (action.kind === 'answer' && !field.value.trim())) { field.focus(); field.placeholder = 'Say what to change, then Make this change'; return; }
      if (form.querySelector('[type="submit"]').disabled) return; // the last reply is still sending
      form.dataset.mode = 'act';
      form.dataset.change = '1';
      form.requestSubmit();
      return;
    }
    const dismissed = event.target.closest('[data-dcr-refusal]');
    if (dismissed) { refusals.delete(dismissed.dataset.dcrRefusal); document.querySelectorAll('.dcr-thread').forEach(refreshBlock); return; }
    // Fix this, Apply this, Act on this: the box opens for what to add, and sends from there.
    const noted = event.target.closest('[data-dcr-fix-note]');
    const fix = event.target.closest('[data-dcr-fix]');
    const button = event.target.closest('[data-dcr-act]');
    (noted || fix || button)?.closest('details.dcr-split-menu')?.removeAttribute('open');
    if (noted) { openForm(blockFor(noted), 'act', actionOf(noted.dataset.dcrFixNote)); return; }
    // With the text box open, the control is its send button.
    const pressed = fix || button;
    const writing = pressed?.closest('.dcr-split') && blockFor(pressed)?.querySelector('.dcr-reply:not([hidden])');
    if (writing) { writing.requestSubmit(); return; }
    if (fix) {
      const id = fix.dataset.dcrFix, action = actionOf(id), comment = comments().find(entry => entry.id === id);
      if (!action || !comment) return;
      // Acting on the agent's question needs the answer; a fix or a suggestion goes as it is.
      if (action.kind === 'answer') { openForm(blockFor(fix), 'act', action); return; }
      fix.disabled = true;
      try { await askFix(id, action, comment, null); } catch (error) { refuse(id, error.message); }
      decorate();
      return;
    }
    if (!button) return;
    const id = button.dataset.dcrFor;
    const thread = threads[id];
    const block = blockFor(button);
    const sent = thread && (thread.live || thread.delivery !== 'draft');
    // The first word on something the agent wrote is the reader's: the box opens for it.
    if (!sent && !mine(id)) { openForm(block, 'answer', actionOf(id)); return; }
    if (thread && (thread.live || thread.delivery !== 'draft')) {
      // Already with the agent: open the reply box.
      const form = block?.querySelector('.dcr-reply');
      if (!form) return;
      if (form.hidden || form.dataset.mode) openForm(block, null);
      else { form.hidden = true; refreshBlock(block); }
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
    const mode = form.dataset.mode;
    const change = !!form.dataset.change;
    const action = mode === 'act' ? (change ? changeOf(id) : actionOf(id)) : null;
    // A fix needs nothing added; an answer, and acting on a question, need the answer.
    if (!text && !(action && action.kind !== 'answer')) { field.focus(); return; }
    if (form.querySelector('[type="submit"]').disabled) return; // ⌘ Enter while the last reply is still sending
    form.querySelector('[type="submit"]').disabled = true;
    const ledger = block.classList.contains('dcr-ledger');
    if (mode) {
      const comment = comments().find(entry => entry.id === id);
      try {
        if (!comment || (mode === 'act' && !action)) throw new Error('This comment can no longer be acted on.');
        if (mode === 'answer') await sendComment(id, text);
        else if (!await askFix(id, action, comment, text)) return; // the page is opening the updated review
        drafts.delete(id);
        document.querySelectorAll(`.dcr-thread[data-dcr="${CSS.escape(id)}"] textarea`).forEach(other => { other.value = ''; });
        form.hidden = true;
        delete form.dataset.mode;
        if (mode === 'answer') { await refresh(); flash(`Sent to your agent.${listening === false ? ' No agent is listening yet; it starts when your agent picks it up.' : ''}`); }
      } catch (error) { mode === 'act' ? refuse(id, error.message) : flash(error.message); }
      finally {
        if (change) { delete form.dataset.mode; delete form.dataset.change; }
        form.querySelector('[type="submit"]').disabled = !online;
        decorate();
      }
      return;
    }
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
    // Conversations put away under From earlier revisions are not waiting on anyone.
    const summary = tools.summary(comments(), Object.fromEntries(Object.entries(threads).filter(([id]) => !putAway(id))), resolved());
    const mine = comments().filter(comment => comment.personal).length;
    const parts = [];
    const onGitHub = Object.keys(ghData.posted || {}).length;
    if (!online) parts.push('Server stopped');
    else if (!mine && !summary.waiting && !summary.answered && !ghPendingIds().length && !onGitHub) parts.push(comments().some(comment => putAway(comment.id)) ? 'Nothing waiting' : 'No comments yet');
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
    if (newer()) set(note, 'innerHTML', latest > current ? `A newer revision (${latest}) was saved. <a href="/">Open it</a>` : 'This revision was saved again. <a href="/">Open it</a>');
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
  const ghRefresh = () => { decorateLedger(); document.querySelectorAll('.dcr-ledger').forEach(refreshBlock); window.ReviewGitHub?.refresh(); renderPanel(); renderUnsent(); };
  const ghProvider = {
    status: () => !online ? {phase: 'offline', text: 'The review server stopped. Restart `dcr serve` to post to GitHub.'} : ghStatus,
    stateOf: id => ghData.posted?.[id] ? {state: 'posted', ...ghData.posted[id]} : ghPosting.has(id) ? {state: 'posting'}
      : ghFailed.has(id) ? {state: 'failed', error: ghFailed.get(id)} : ghData.pending?.[id] ? {state: 'pending'} : {state: 'note'},
    pendingCount: () => ghPendingIds().length,
    // Your question to the agent becomes a comment for the PR once the agent has answered: the conversation is what it sums up.
    talked: id => !!threads[id] && ((threads[id].messages || []).some(message => message.author === 'agent') || tools.opinionMessages(threads[id]).length > 0),
    // What the agent wrote is read, in the reader's voice, before it goes: the preview. What the
    // reader wrote themselves goes as they wrote it; the box they typed it in was the preview.
    post(id) { if (own(id)) ghSend.post(id, written(id)); else openPreview(id); },
    // The agent's comment in the reader's words, with both ways to send it.
    open(id) { openPreview(id); },
    // Takes a posted comment back from GitHub; true when it is gone there (also when it already was).
    async remove(id) {
      ghNotice('busy', 'Deleting it on GitHub…');
      try {
        const result = await api('/api/github/delete', {key, id});
        ghData = {...ghData, pending: result.pending, posted: result.posted, bodies: result.bodies};
        ghFailed.delete(id); ghRefresh();
        ghNotice('done', result.gone ? 'It was already gone from GitHub.' : 'Deleted on GitHub.');
        return true;
      } catch (error) {
        ghNotice('error', `Not deleted. ${error.message === 'Not found' ? 'This review\'s server is older than its page: restart `dcr serve`.' : error.message}`);
        return false;
      }
    },
    async pend(id, on) {
      if (on) return own(id) ? ghSend.pend(id) : openPreview(id);
      try {
        const entry = await api('/api/github/pending', {key, id, pending: false});
        ghData = {...ghData, ...entry}; ghFailed.delete(id); ghRefresh();
      } catch (error) { ghNotice('error', error.message); }
    }
  };
  // What the reader wrote for the PR goes as written. A question for the agent goes summed up, like what the agent wrote.
  const own = id => { const comment = comments().find(entry => entry.id === id); return !!comment?.personal && comment.audience !== 'agent'; };
  const written = id => globalThis.ReviewTools.githubItem(snapshot, comments().find(entry => entry.id === id), review.qa).body;
  const ghSend = {
    async post(id, body) {
      const comment = comments().find(entry => entry.id === id);
      if (!comment || ghPosting.has(id)) return;
      ghPosting.add(id); ghFailed.delete(id); ghRefresh();
      ghNotice('busy', 'Posting your comment to GitHub…');
      try {
        const result = await api('/api/github/comment', {key, item: {...globalThis.ReviewTools.githubItem(snapshot, comment, review.qa), body}});
        const posted = result.posted[id];
        ghData.posted = {...ghData.posted, [id]: posted};
        ghNotice('done', {lines: `Posted on ${where(comment)}.`, file: 'Posted on the file: those lines are not in the pull request\'s diff.', conversation: 'Posted in the pull request\'s conversation.'}[posted.where] || 'Posted on GitHub.', posted.url);
      } catch (error) {
        ghFailed.set(id, error.message);
        ghNotice('error', `Not posted. ${error.message}`);
      } finally { ghPosting.delete(id); ghRefresh(); }
    },
    async pend(id, body) {
      try {
        const entry = await api('/api/github/pending', {key, id, pending: true, body});
        ghData = {...ghData, ...entry}; ghFailed.delete(id); ghRefresh();
        ghNotice('done', 'Added to your review. It is posted when you finish it.', null, 'finish');
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
  // The reader's face is the same on every review, so it is asked once, with or without a pull request.
  api('/api/github/me').then(found => {
    me = found;
    window.ReviewMe = me; // the page draws the reader's face with it too
    // What was drawn before it came takes the reader's face and name now.
    if (me?.avatar) document.querySelectorAll('.dcr-you > .dcr-avatar').forEach(node => { node.outerHTML = tools.youHTML(me); });
    if (me?.avatar) document.querySelectorAll('.comment-avatar').forEach(node => { node.innerHTML = `<img src="${me.avatar}" alt="">`; });
    document.querySelectorAll('.you-name').forEach(node => { node.textContent = tools.youName(me); });
  }).catch(() => {});
  if (window.ReviewGitHub && globalThis.ReviewTools.githubLink(snapshot, review, {general: true})) { window.ReviewGitHub.connect(ghProvider); loadGitHub(); }

  // --- Comment on GitHub: read it first ---------------------------------------------------------
  // Nothing goes to GitHub unread. A click opens one box at once, for that one comment, and an
  // agent on this computer rewrites the comment the way the reader talks (from the comment, its
  // code and what was said about it). While it writes, the box says so where the text will be and
  // nothing can be sent; then the text is there to change or send. Rewrite does the same in place.
  // When it fails the comment as written (or the text that was there) is shown, with the reason.
  // A text they already approved is shown at once. The reader's own comments never come here.
  const previewDialog = document.createElement('dialog');
  previewDialog.id = 'dcr-gh-preview';
  previewDialog.className = 'modal dcr-gh-finish';
  previewDialog.setAttribute('aria-labelledby', 'dcr-gh-preview-title');
  document.body.append(previewDialog);
  let preview = null; // the open box: {id, mode, waiting, before, kept, failed, since}
  const WAIT_WORDS = ['Humanizing…', 'Finding your words…', 'Adding breathing room…', 'Leaving the door open…', 'Softening the edges…', 'Saying it like you would…'];
  const STALE_WRITING = 150000; // a rewrite still "writing" after this was lost with its server
  // A rewrite that can be shown: finished, and written under the voice as it is now.
  const usableDraft = id => { const draft = ghData.drafts?.[id]; return draft?.status === 'ready' && draft.voice === ghData.voice ? draft : null; };
  const startRewrite = async ask => {
    const {id} = preview;
    const comment = comments().find(entry => entry.id === id);
    // What is there now comes back if this fails; the rewrite that arrives must be a newer one.
    Object.assign(preview, {waiting: true, failed: null, since: Date.now(), before: ghData.drafts?.[id]?.at, kept: previewDialog.querySelector('.gh-preview-text').value});
    renderPreview();
    if (!ask) return; // one is already being written
    ghData = {...ghData, drafts: {...ghData.drafts, [id]: {status: 'writing', at: preview.before}}};
    try { await api('/api/github/draft', {key, id, author: comment.agent || listener || undefined, context: globalThis.ReviewTools.commentText(snapshot, comment, review.qa)}); }
    catch (error) {
      // A page newer than its server: the route is not there until the server restarts.
      const why = error.message === 'Not found' ? 'This review\'s server is older than its page: restart `dcr serve`.' : error.message;
      ghData = {...ghData, drafts: {...ghData.drafts, [id]: {status: 'failed', error: why, at: `failed-${Date.now()}`}}};
      settleDraft();
    }
  };
  // The rewrite the open box waits for arrived, or failed.
  function settleDraft() {
    const draft = preview?.waiting && ghData.drafts?.[preview.id];
    if (!draft || draft.status === 'writing' || draft.at === preview.before) return;
    const text = previewDialog.querySelector('.gh-preview-text');
    preview.waiting = false;
    if (draft.status === 'ready') text.value = draft.body;
    else { preview.failed = draft.error || 'It failed.'; text.value = preview.kept; }
    renderPreview();
    previewDialog.querySelector('form').focus({preventScroll: true});
  }
  // The box chooses where the text goes: its main button adds it to the reader's GitHub review
  // (sent with the rest on Finish your review), the quiet one posts it now.
  const openPreview = id => {
    const comment = comments().find(entry => entry.id === id);
    if (!comment || ghPosting.has(id)) return;
    const approved = ghData.bodies?.[id] || null;
    const ready = usableDraft(id);
    preview = {id, waiting: false, failed: null};
    const target = `${tools.escape(where(comment))}${ghStatus.repo ? ` · ${tools.escape(ghStatus.repo)} #${tools.escape(ghStatus.number)}` : ''}${ghStatus.login ? ` · as <b>@${tools.escape(ghStatus.login)}</b>` : ''}`;
    previewDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box dcr-gh-preview" tabindex="-1">
      <header><div><h2 id="dcr-gh-preview-title">Your comment for GitHub</h2><p class="muted">${target}</p></div><div class="gh-preview-tools"><button type="button" class="act act-quiet act-icon" data-gh-voice-open aria-label="How I write" title="How I write on GitHub">${ico('sliders-horizontal')}</button><button type="button" class="act act-quiet act-icon" data-gh-close aria-label="Close" title="Close (Q)">${ico('x')}</button></div></header>
      <div class="gh-preview-field"><textarea class="gh-summary gh-preview-text" rows="9" aria-label="The comment as it will be posted"></textarea><div class="gh-preview-wait" role="status" hidden><span class="gh-spinner" aria-hidden="true"></span><strong></strong><small></small></div></div>
      <p class="gh-preview-failed" role="status" hidden>${ico('circle-alert')}<span></span></p>
      <footer class="dcr-gh-actions gh-preview-actions"><button type="button" class="act act-quiet gh-preview-again" data-gh-again title="Have it written again">${ico('refresh-cw')}<span></span></button><span class="gh-preview-from"></span><button type="button" class="act act-quiet" data-gh-close>Cancel</button><button type="button" class="act act-secondary" data-gh-send="post" title="Post it on the pull request now">${ico('send')}<span>Comment now</span></button><button type="button" class="act act-gh" data-gh-send="pend" title="Keep it with your other comments, and send them together with Finish your review (⌘ Enter)">${ico('plus')}<span>Add to my GitHub review</span></button></footer></form>`;
    previewDialog.querySelector('.gh-preview-text').value = approved || ready?.body || globalThis.ReviewTools.githubItem(snapshot, comment, review.qa).body;
    preview.source = approved ? 'approved' : ready ? 'rewritten' : 'written';
    previewDialog.showModal();
    // On the box, not in the text and not on Send: the keys choose (I the text, Q closes, Space the rest).
    previewDialog.querySelector('form').focus({preventScroll: true});
    const draft = ghData.drafts?.[id];
    const writing = draft?.status === 'writing' && Date.now() - Date.parse(draft.at || 0) < STALE_WRITING;
    if (!approved && !ready) startRewrite(!writing);
    else renderPreview();
  };
  let waitTimer = null;
  function renderPreview() {
    clearInterval(waitTimer);
    if (!preview || !previewDialog.open) return;
    const draft = usableDraft(preview.id);
    const text = previewDialog.querySelector('.gh-preview-text');
    const wait = previewDialog.querySelector('.gh-preview-wait');
    const {waiting} = preview;
    text.hidden = waiting;
    wait.hidden = !waiting;
    if (waiting) {
      const [words, longer] = [wait.querySelector('strong'), wait.querySelector('small')];
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let turn = Math.floor(Math.random() * WAIT_WORDS.length);
      const say = () => {
        words.textContent = calm ? 'Writing it in your voice…' : WAIT_WORDS[turn++ % WAIT_WORDS.length];
        longer.textContent = Date.now() - preview.since > 20000 ? 'Still writing. It can take a minute.' : '';
      };
      say();
      waitTimer = setInterval(() => (preview?.waiting ? say() : clearInterval(waitTimer)), 2200);
    } else if (!preview.failed && draft && text.value === draft.body) preview.source = 'rewritten';
    const failed = previewDialog.querySelector('.gh-preview-failed');
    failed.hidden = !preview.failed || waiting;
    failed.querySelector('span').textContent = preview.failed ? `It could not be rewritten, so this is ${preview.source === 'written' ? 'the comment as written' : 'the text you had'}. ${preview.failed}` : '';
    previewDialog.querySelector('.gh-preview-again span').textContent = preview.failed ? 'Try again' : 'Rewrite';
    previewDialog.querySelector('.gh-preview-from').textContent = waiting || preview.failed ? '' : preview.source === 'approved' ? 'The text you approved' : preview.source === 'rewritten' ? `In your voice${draft?.agent ? `, by ${tools.agentInfo(draft.agent).name}` : ''}` : '';
    previewDialog.querySelector('[data-gh-again]').disabled = waiting;
    previewDialog.querySelectorAll('[data-gh-send]').forEach(button => { button.disabled = waiting || !text.value.trim(); });
  }
  previewDialog.addEventListener('input', event => {
    if (event.target.matches('.gh-preview-text')) previewDialog.querySelectorAll('[data-gh-send]').forEach(button => { button.disabled = !event.target.value.trim(); });
  });
  // Ctrl or Cmd with Enter sends from the text, as on GitHub.
  previewDialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && preview) { event.preventDefault(); previewDialog.querySelector('[data-gh-send="pend"]').click(); }
  });
  previewDialog.addEventListener('click', event => {
    if (!preview) return;
    if (event.target.closest('[data-gh-close]')) { previewDialog.close(); return; }
    if (event.target.closest('[data-gh-again]')) { if (!preview.waiting) startRewrite(true); return; }
    const send = event.target.closest('[data-gh-send]');
    if (send) {
      const {id} = preview, mode = send.dataset.ghSend;
      const body = previewDialog.querySelector('.gh-preview-text').value.trim();
      if (!body || preview.waiting) return;
      previewDialog.close();
      if (mode === 'pend') ghSend.pend(id, body); else ghSend.post(id, body);
    }
  });
  // Closing while it writes loses nothing: the rewrite is kept for the next look.
  previewDialog.addEventListener('close', () => { preview = null; clearInterval(waitTimer); });

  // How I write on GitHub: the reader's own description of their voice, which the rewrite follows
  // in every review on this computer. Reached from the preview and from the agent's card.
  const voiceDialog = document.createElement('dialog');
  voiceDialog.id = 'dcr-gh-voice';
  voiceDialog.className = 'modal dcr-gh-finish';
  voiceDialog.setAttribute('aria-labelledby', 'dcr-gh-voice-title');
  document.body.append(voiceDialog);
  const openVoice = async () => {
    let saved;
    try { saved = await api('/api/github/voice'); } catch (error) { flash(error.message === 'Not found' ? 'This review\'s server is older than its page. Restart `dcr serve`.' : error.message); return; }
    voiceDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box dcr-gh-preview">
      <header><div><h2 id="dcr-gh-voice-title">How I write on GitHub</h2><p class="muted">In your own words. Every comment is rewritten this way before you send it.</p></div><div class="gh-preview-tools"><button type="button" class="act act-quiet act-icon" data-voice-close aria-label="Close" title="Close (Q)">${ico('x')}</button></div></header>
      <div class="gh-preview-field"><textarea class="gh-summary gh-preview-text" rows="10" aria-label="How I write on GitHub"></textarea></div>
      <label class="gh-voice-emojis"><span>Emojis I use</span><span class="gh-preview-field"><input type="text" class="gh-summary" data-voice-emojis maxlength="120" placeholder="None" autocomplete="off"></span><small>Only these are used, one now and then. Leave it empty for no emojis.</small></label>
      <footer class="dcr-gh-actions gh-preview-actions"><button type="button" class="act act-quiet gh-preview-again" data-voice-default>${ico('rotate-ccw')}<span>Use the default</span></button><span class="gh-preview-from"></span><button type="button" class="act act-quiet" data-voice-close>Cancel</button><button type="button" class="act act-gh" data-voice-save>${ico('check')}<span>Save</span></button></footer></form>`;
    voiceDialog.querySelector('form').tabIndex = -1;
    voiceDialog.querySelector('textarea').value = saved.voice;
    voiceDialog.querySelector('[data-voice-emojis]').value = saved.emojis;
    voiceDialog.showModal();
    voiceDialog.querySelector('form').focus({preventScroll: true});
  };
  voiceDialog.addEventListener('click', async event => {
    if (event.target.closest('[data-voice-close]')) { voiceDialog.close(); return; }
    const reset = event.target.closest('[data-voice-default]');
    if (!reset && !event.target.closest('[data-voice-save]')) return;
    try {
      await api('/api/github/voice', {voice: reset ? '' : voiceDialog.querySelector('textarea').value, emojis: voiceDialog.querySelector('[data-voice-emojis]').value});
      voiceDialog.close();
      flash(preview ? 'Saved. Press Rewrite to hear the difference.' : 'Saved. Your next comments on GitHub are written this way.');
    } catch (error) { flash(error.message); }
  });
  document.addEventListener('click', event => { if (event.target.closest('[data-gh-voice-open]')) openVoice(); });

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
    const summary = finishDialog.querySelector('.gh-summary');
    summary.value = kept.get('summary');
    summary.addEventListener('input', () => kept.set('summary', summary.value));
    finishDialog.showModal();
    summary.focus();
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
    const items = ids.map(id => comments().find(comment => comment.id === id)).filter(Boolean).map(comment => ({...globalThis.ReviewTools.githubItem(snapshot, comment, review.qa), ...(ghData.bodies?.[comment.id] ? {body: ghData.bodies[comment.id]} : {})})); // the text approved in the preview
    form.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = true; });
    submit.innerHTML = '<span class="gh-spinner" aria-hidden="true"></span>Submitting…';
    finishState('busy', `Posting ${items.length} comment${items.length === 1 ? '' : 's'} as one review on GitHub…`);
    ids.forEach(id => ghPosting.add(id)); ghRefresh();
    try {
      const result = await api('/api/github/review', {key, event: event_, body: form.elements.body.value, items});
      ghData.posted = {...ghData.posted, ...result.posted};
      kept.set('summary', '');
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
  // saved into this revision, so your comments and threads stay where they are.
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
    const submit = Object.assign(document.createElement('button'), {type: 'submit', textContent: 'Attach and open it'});
    const status = Object.assign(document.createElement('span'), {className: 'dcr-status'});
    form.append(field('Title', title), field('Result', result), field('What you saw', observed), field('Expected', expected), field('About comment', owner), submit, status);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = 'Attaching…';
      try {
        const saved = await api('/api/evidence', {path, title: title.value, result: result.value, observed: observed.value, expected: expected.value, comment_id: owner.value});
        status.textContent = 'Saved to the review. Opening it…';
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
  // Your review is a list. A row is its place in the code (a link there), then the comment as a chat
  // message, and with a conversation a line of who replied, how often and when last. A click on the
  // row opens that one conversation in place of the list, as a chat: a back button, the comment it
  // started from and every message, scrolling, and one reply field pinned to the bottom.
  const STATE = {sent: 'sent', delivered: 'sent', answered: 'answered'};
  const unseenIn = thread => (thread?.messages || []).some(message => message.author === 'agent' && !seen.has(message.id));
  const weighedIn = thread => !!thread && ((thread.waiting_on || []).length > 0 || Object.keys(thread.opinions || {}).length > 0);
  const hasConversation = thread => !!thread && (thread.live || thread.delivery !== 'draft' || thread.messages?.length > 0 || weighedIn(thread));
  const whereOf = comment => {
    const found = globalThis.ReviewTools.anchor(snapshot, comment);
    const was = globalThis.ReviewTools.outdatedWhere(comment);
    const lines = was ? `Outdated · ${was.lines}` : comment.general ? 'General comment' : `${comment.side === 'new' ? 'After' : 'Before'} L${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ''}`;
    return globalThis.ReviewTools.pathFit(found?.file.path || was?.path || 'General', ` · ${lines}`);
  };
  // A row from an earlier revision says where the comment was, as its folded card does.
  const wasWhere = comment => { const was = globalThis.ReviewTools.outdatedWhere(comment); return globalThis.ReviewTools.pathFit(was.path, ` · ${was.lines}${was.revision ? ` in revision ${was.revision}` : ''}`); };
  const rowFor = (comment, earlier = false) => `<li class="ledger-item" data-ledger="${tools.escape(comment.id)}" data-conversation="1"${earlier ? ' data-earlier="1"' : ''}><button type="button" class="ledger-place" data-ledger-jump="${tools.escape(comment.id)}" title="Show in the code">${earlier ? wasWhere(comment) : whereOf(comment)}${ico('arrow-up-right')}</button><div class="ledger-msg">${tools.avatarHTML(comment.agent || null)}<b class="ledger-name">${comment.agent ? tools.escape(tools.agentInfo(comment.agent).name) : 'Review'}</b><span class="ledger-subject">${tools.escape(comment.subject)}</span></div><div class="ledger-meta"></div></li>`;
  const chevron = '<svg class="dcr-peek-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  // Under the row, the replies in a line (who, how many, when last).
  // A comment whose code changed says what became of it, as its card does. What an agent thought
  // of the comment back then is not the news, and its chip beside today's outcome misleads.
  const peekHTML = (thread, id, earlier) => {
    const closing = tools.closure(thread);
    if (earlier || closing) {
      const {label, state} = closing?.state === 'differ' ? {label: 'Not settled', state: 'differ'} : becameOf(id);
      const against = (closing?.rows || []).slice(1).filter(row => closing.state === 'differ' && tools.outcomeSide(row.word) && tools.outcomeSide(row.word) !== closing.side);
      const note = against.length ? `${tools.names(against.map(row => tools.agentInfo(row.agent).name))} ${against.length === 1 ? 'says' : 'say'} ${closing.side === 'dealt' ? 'it still applies' : 'it is dealt with'}. You decide.` : '';
      return `<span class="dcr-peek-who"><span class="dcr-earlier-outcome dcr-c-${state}">${tools.escape(label)}</span><span class="dcr-peek-end">${chevron}</span></span>${note ? `<span class="dcr-peek-text">${tools.escape(note)}</span>` : ''}`;
    }
    // As a chat app's thread: who replied, how many replies, and when the last came. The replies
    // themselves are in the conversation it opens; the row does not repeat any of them.
    const replies = [...(thread.messages || []), ...tools.opinionMessages(thread)].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    if (!replies.length) return `<span class="dcr-peek-who"><span class="dcr-peek-note">Open conversation</span><span class="dcr-peek-end">${chevron}</span></span>`;
    const voices = [...new Set(replies.map(reply => reply.author === 'agent' ? reply.agent || listener || 'agent' : 'you'))].slice(-3);
    const faces = voices.map(voice => voice === 'you' ? tools.youHTML(me) : tools.avatarHTML(voice === 'agent' ? null : voice, 'dcr-face-xs')).join('');
    const last = replies.at(-1);
    return `<span class="dcr-peek-who"><span class="dcr-peek-faces">${faces}</span><b>${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</b><span class="dcr-peek-when">last <time data-at="${tools.escape(last.at || '')}">${tools.escape(tools.relativeTime(last.at))}</time></span><span class="dcr-peek-end">${chevron}</span></span>`;
  };
  const decoratePeek = (item, comment, thread) => {
    let peek = item.querySelector(':scope > .dcr-peek');
    if (!hasConversation(thread) && !item.dataset.earlier) { peek?.remove(); return; }
    if (!peek) {
      peek = Object.assign(document.createElement('button'), {type: 'button', className: 'dcr-peek'});
      peek.dataset.dcrOpen = item.dataset.ledger;
      peek.setAttribute('aria-label', `Open the conversation about ${comment?.subject || 'this comment'}`);
      // The answer follows what it answers; the row's actions come after both.
      const meta = item.querySelector(':scope > .ledger-meta');
      meta ? meta.before(peek) : item.append(peek);
    }
    const html = peekHTML(thread, item.dataset.ledger, !!item.dataset.earlier);
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
    view.querySelector('.dcr-detail-title .ledger-where').innerHTML = whereOf(comment);
    view.querySelector('.dcr-detail-title strong').textContent = comment.subject;
    view.querySelector('.dcr-detail-title strong').hidden = !!comment.personal; // it is the first message below
    view.querySelector('[data-ledger-jump]').dataset.ledgerJump = id;
    const block = cardBlock(id, 'ledger', comment);
    view.querySelector('.dcr-detail-slot').replaceChildren(block);
    view.hidden = false;
    ledgerPanel.classList.add('dcr-in-convo');
    refreshBlock(block);
    const scroller = block.querySelector('.dcr-scroll');
    scroller.scrollTop = scroller.scrollHeight; // a conversation opens on its newest message
    if (focus) block.querySelector('textarea:not([disabled])')?.focus({preventScroll: true});
    else if (focus === false) view.querySelector('[data-dcr-back]').focus({preventScroll: true});
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
    if (event.target.closest('[data-dcr-github]')) ghProvider.open(current);
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
  let ledgerEarlierOpen = false; // the reader opened From earlier revisions in Your review; a redraw keeps it so
  const decorateLedger = () => {
    const body = document.getElementById('ledger-body');
    if (!body) return;
    // Conversations about the agent's own findings that you have joined, above your own comments.
    const mine = new Set(comments().filter(comment => comment.personal).map(comment => comment.id));
    const joined = comments().filter(comment => !mine.has(comment.id) && hasConversation(threads[comment.id]) && (threads[comment.id].delivery !== 'draft' || threads[comment.id].messages?.length || weighedIn(threads[comment.id])));
    let section = body.querySelector(':scope > .dcr-convos');
    // What changed since sits last, under everything that is about the code as it is.
    let earlierGroup = body.querySelector(':scope > .dcr-earlier-group');
    if (!joined.length) { section?.remove(); earlierGroup?.remove(); }
    else {
      if (!section) { section = document.createElement('section'); section.className = 'ledger-group dcr-convos'; body.prepend(section); }
      // Only the list of rows decides the markup; states and answers are filled in below.
      // As in the Overview: what is read first is about the code as it is. Comments on code
      // that changed since are folded under it, each with what became of it.
      const before = joined.filter(comment => putAway(comment.id));
      const now = joined.filter(comment => !before.includes(comment));
      // The same words as the Overview when nothing is open, so the two never disagree.
      const idle = !now.length && !comments().some(comment => comment.personal && !resolved().includes(comment.id));
      const html = `${idle ? '<p class="dcr-idle">Nothing is waiting on you.</p>' : ''}${now.length ? `<h3 class="ledger-title">Conversations with your agent</h3><ul class="ledger-list">${now.map(comment => rowFor(comment)).join('')}</ul>` : ''}`;
      if (section.dataset.html !== html) { section.innerHTML = html; section.dataset.html = html; }
      if (!before.length) earlierGroup?.remove();
      else {
        if (!earlierGroup) { earlierGroup = document.createElement('section'); earlierGroup.className = 'ledger-group dcr-earlier-group'; }
        const previews = body.querySelector(':scope > .ledger-previews');
        if (earlierGroup.nextElementSibling !== previews || earlierGroup.parentElement !== body) previews ? previews.before(earlierGroup) : body.append(earlierGroup);
        const fold = `<details class="dcr-convos-earlier"${ledgerEarlierOpen ? ' open' : ''}><summary>From earlier revisions <span class="badge neutral">${before.length}</span>${ico('chevron-down')}</summary><ul class="ledger-list">${before.map(comment => rowFor(comment, true)).join('')}</ul></details>`;
        if (earlierGroup.dataset.html !== fold) {
          earlierGroup.innerHTML = fold; earlierGroup.dataset.html = fold;
          earlierGroup.querySelector('.dcr-convos-earlier').addEventListener('toggle', event => { ledgerEarlierOpen = event.target.open; });
        }
      }
    }
    // The agent's comments you put on GitHub (pending or posted), so the panel shows your whole GitHub review.
    const onGitHub = comments().filter(comment => !mine.has(comment.id) && (ghData.pending?.[comment.id] || ghData.posted?.[comment.id]));
    let ghGroup = body.querySelector(':scope > .dcr-gh-group');
    if (!onGitHub.length) ghGroup?.remove();
    else {
      if (!ghGroup) { ghGroup = document.createElement('section'); ghGroup.className = 'ledger-group dcr-gh-group'; section ? section.after(ghGroup) : body.prepend(ghGroup); }
      const html = `<h3>On GitHub</h3><ul class="ledger-list">${onGitHub.map(comment => `<li class="ledger-item" data-gh-row data-state="${ghData.posted?.[comment.id] ? 'posted' : 'pending'}"><button type="button" class="ledger-jump" data-ledger-jump="${tools.escape(comment.id)}"><span class="ledger-where">${whereOf(comment)}</span><span class="ledger-subject">${tools.escape(comment.subject)}</span></button><div class="ledger-meta"><span class="gh-slot" data-gh-badge="${tools.escape(comment.id)}"></span></div></li>`).join('')}</ul>`;
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
  // A change goes as a fix of what the comment says, as Fix this does; the adversaries only give opinions, so not to them.
  const composerForm = window.ReviewComposer?.setSender(async (id, kind) => {
    if (kind === 'change') {
      const comment = comments().find(entry => entry.id === id);
      try { if (comment) await askFix(id, {kind: 'fix'}, comment, null); } catch (error) { flash(`Saved, but not sent: ${error.message}`); }
      decorate();
      return;
    }
    if (withAdversaries.delete(COMPOSER)) withAdversaries.add(id);
    syncComposerAdv();
    try { const asked = await sendComment(id); flash(sentWith(tools.statusModel(threads[id], listening)?.text || 'Saved and sent to your agent.', asked)); }
    catch (error) { flash(`Saved, but not sent: ${error.message}`); }
  });
  const composerSend = composerForm?.querySelector?.('[data-composer-send]');
  const composerSplit = composerSend?.closest('[data-composer-agent]');
  composerSplit?.insertAdjacentHTML('beforebegin', advToggleHTML);
  const syncComposerAdv = () => { if (composerSplit) syncAdvToggles([composerSplit.previousElementSibling], COMPOSER, true); };

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
      if (actions && act) { act.remove(); addSplit(actions, section.dataset.commentId, 'xs'); section.append(actions); }
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
  const presence = document.createElement('button');
  presence.type = 'button';
  presence.id = 'dcr-presence';
  presence.hidden = true;
  presence.setAttribute('aria-haspopup', 'dialog');
  presence.setAttribute('aria-expanded', 'false');
  presence.innerHTML = '<span class="dcr-presence-face"></span><span class="dcr-presence-text" role="status"></span><span class="dcr-presence-adv" hidden></span>';
  const optionsBar = document.querySelector('.toolbar-options');
  // The bar's right side reads outwards: who is listening, then how the page is read (focus, View),
  // then your review at the edge, where its panel opens.
  optionsBar?.prepend(presence);
  const presenceCard = document.createElement('div');
  presenceCard.id = 'dcr-presence-card';
  presenceCard.hidden = true;
  presenceCard.setAttribute('role', 'dialog');
  presenceCard.setAttribute('aria-label', 'Your agent');
  // On a phone the card is a whole screen, as the menu and your review are, so it has their heading and their way out.
  presenceCard.innerHTML = `<div class="dcr-presence-bar"><h2>Your agent</h2><button type="button" class="act act-quiet act-icon" data-presence-close aria-label="Close" title="Close">${ico('x')}</button></div>` + '<div class="dcr-presence-main"></div><section class="dcr-adv" aria-labelledby="dcr-adv-title"></section><button type="button" class="dcr-voice-link" data-gh-voice-open>How I write on GitHub</button>';
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
    if (advPanel.dataset.html !== html) { advPanel.innerHTML = html; advPanel.dataset.html = html; if (!presenceCard.hidden) placePresenceCard(); }
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
    // Under the chip, or over it when the chip is at the bottom of the screen, as on a phone.
    presenceCard.style.maxHeight = `${window.innerHeight - 24}px`;
    const height = presenceCard.offsetHeight;
    const below = box.bottom + 8 + height <= window.innerHeight - 8;
    presenceCard.style.top = `${Math.round(below ? box.bottom + 8 : Math.max(8, box.top - 8 - height))}px`;
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
    if (event.target.closest('[data-presence-close]')) { togglePresenceCard(false); presence.focus(); return; }
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
    // An answer on one comment opens its conversation in Your review, with the keyboard left where it
    // is. Not while you are writing, in a dialog, or reading another conversation: then it is announced.
    const busy = document.activeElement?.matches?.('textarea, input, select') || document.querySelector('dialog[open]');
    const reading = current && document.body.classList.contains('ledger-open');
    if (new Set(items.map(item => item.thread)).size === 1 && !busy && !reading && openConversation(items[0].thread, {focus: null})) { arrival.hidden = true; return; }
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
    if (event.target.closest('[data-ledger-jump], [data-view], .dcr-dismiss')) arrival.hidden = true;
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
  // Screenshots the agent posts while it reviews: their images are fetched once each, then the
  // review shows them in Seen in the app or on their comment. Those there when the page opens are not news.
  const shotImages = new Map();
  let shotsMark = '[""]', shotsKnown = false;
  const receiveScreenshots = async (list, none) => {
    const mark = JSON.stringify([...list.map(shot => [shot.id, shot.posted_at]), none || '']);
    if (mark === shotsMark) { shotsKnown = true; return; }
    const before = shotsMark;
    shotsMark = mark;
    try {
      const loaded = await Promise.all(list.map(async shot => {
        const name = `${shot.id}:${shot.posted_at}`;
        if (!shotImages.has(name)) shotImages.set(name, (await api(`/api/screenshot?key=${encodeURIComponent(key)}&id=${encodeURIComponent(shot.id)}`)).data_uri);
        return {...shot, data_uri: shotImages.get(name)};
      }));
      if (shotsMark !== mark) return; // a newer list is on its way
      window.ReviewScreenshots?.set(loaded, none);
      const had = new Set(JSON.parse(before).filter(Array.isArray).map(entry => entry.join(':')));
      const fresh = list.filter(shot => !had.has(`${shot.id}:${shot.posted_at}`));
      if (shotsKnown && fresh.length) {
        const name = fresh[0].agent ? tools.agentInfo(fresh[0].agent).name : 'Your agent';
        arrival.innerHTML = `${tools.avatarHTML(fresh[0].agent || null)}<div><strong>${tools.escape(name)} added ${fresh.length === 1 ? 'a screenshot' : `${fresh.length} screenshots`}</strong><span>${tools.escape(fresh[0].title)}</span></div>${fresh[0].comment_id ? `<button type="button" class="btn btn-sm btn-primary" data-ledger-jump="${tools.escape(fresh[0].comment_id)}">View</button>` : '<button type="button" class="btn btn-sm btn-primary" data-view="overview">View</button>'}<button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
        arrival.hidden = false;
        clearTimeout(arrivalTimer);
        arrivalTimer = setTimeout(() => { arrival.hidden = true; }, 12000);
      }
      shotsKnown = true;
    } catch { shotsMark = before; } // asked again with the next state
  };
  // The review saved again while this page is open: the finished review or a QA review's recordings
  // in this revision, or a newer revision. Progress and conversations are kept, so the page opens it by
  // itself when that takes nothing from the reader: nothing typed, no dialog open, and either away
  // from the tab or on Overview. Otherwise a notice says so, and a button in the header stays
  // until they take it, however the notice went.
  // A newer revision opens on what it changed; a save into this one, on the Overview.
  const openLatest = () => { history.replaceState(null, '', latest > (review.history?.revision || 0) ? '/#since' : '/#overview'); location.reload(); };
  const newerButton = Object.assign(document.createElement('button'), {type: 'button', id: 'dcr-newer', className: 'header-button', hidden: true, onclick: openLatest});
  document.querySelector('.header-actions')?.prepend(newerButton);
  const shownRevision = review.history?.revision || 0;
  const inHand = () => 'editing' in document.body.dataset || document.querySelector('dialog[open]') || [...document.querySelectorAll('textarea')].some(field => field.value.trim() && field.offsetParent);
  const openedKey = 'dynamic-review:opened-latest';
  let latestAtOpen = null, finishedAnnounced = false;
  const announceFinished = () => {
    latestAtOpen ??= mark();
    // An older revision opened on purpose is not news; the review finishing always is.
    if (!newer() || !(review.status || mark() !== latestAtOpen)) return;
    let opened = null;
    try { opened = sessionStorage.getItem(openedKey); } catch { /* open it once more at worst */ }
    // Once per save, so a page that still shows an older one is never reloaded in a loop.
    if (opened !== mark() && !inHand() && (document.hidden || /^(#overview)?$/.test(location.hash))) {
      try { sessionStorage.setItem(openedKey, mark()); } catch { /* as above */ }
      openLatest();
      return;
    }
    const headline = review.status ? 'Your review is ready' : latest > shownRevision ? `Revision ${latest} is ready` : 'This revision was saved again';
    newerButton.textContent = headline;
    newerButton.title = 'Open it. Your progress is kept.';
    newerButton.hidden = false;
    if (finishedAnnounced) return;
    finishedAnnounced = true;
    clearTimeout(arrivalTimer);
    arrival.innerHTML = `<span class="dcr-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span><div><strong>${headline}</strong><span>Your progress is kept.</span></div><button type="button" class="btn btn-sm btn-primary" data-dcr-open-latest>Open it</button><button type="button" class="dcr-dismiss" aria-label="Dismiss">✕</button>`;
    arrival.hidden = false;
  };
  arrival.addEventListener('click', event => { if (event.target.closest('[data-dcr-open-latest]')) openLatest(); });

  // --- Update: the review follows the code -------------------------------------------------
  // The code keeps changing while a review is open. Update saves the next revision from the
  // checkout as it is: comments follow their lines or become outdated, and progress comes along.
  // The server compares the checkout with this revision when the reader comes back to the tab,
  // never on a timer, so the button can say how many files moved.
  const updateButton = Object.assign(document.createElement('button'), {type: 'button', id: 'dcr-update', className: 'header-button', hidden: true});
  document.getElementById('revision-navigation')?.before(updateButton);
  // Update takes what the review shows: a pull request's review asks GitHub, and one the reader
  // has following the checkout reads the checkout. The menu holds only the other one; on a review
  // of the checkout whose branch has a pull request now, switching to it.
  const updateMore = document.createElement('details');
  updateMore.className = 'more-menu dcr-update-more';
  updateMore.hidden = true;
  updateMore.dataset.menuFrom = 'previous';
  updateMore.innerHTML = `<summary class="header-button" aria-label="Where to update from" title="Where to update from">${ico('chevron-down')}</summary><div class="more-list"><button type="button" class="more-item" data-update-other><span class="dcr-update-ico"></span><span></span></button></div>`;
  updateButton.after(updateMore);
  const updatedKey = 'dynamic-review:updated';
  let stale = null, updating = false, staleAt = 0;
  const renderUpdate = () => {
    // A newer save of the review has its own button.
    set(updateButton, 'hidden', !stale || newer());
    set(updateMore, 'hidden', updateButton.hidden || !(stale.pr || stale.pull) || !!stale.unavailable || updating);
    if (updateButton.hidden) return;
    // A review that cannot be updated right now says why, rather than losing its button.
    if (stale.unavailable) {
      const html = `${ico('refresh-cw')}<span>Update</span>`;
      if (updateButton.innerHTML !== html) updateButton.innerHTML = html;
      set(updateButton, 'title', stale.unavailable);
      updateButton.setAttribute('aria-label', `Update is not available: ${stale.unavailable}`);
      set(updateButton, 'disabled', true);
      updateButton.classList.remove('is-stale', 'is-busy');
      return;
    }
    // On a pull request's review the count is what a newer push changes; the checkout's own
    // differences count only once the reader has the review follow it.
    const pushed = stale.pr ? stale.remote : null;
    const count = updating ? 0 : pushed ? pushed.changed || 0 : stale.pinned ? 0 : stale.changed || 0;
    const other = updateMore.querySelector('[data-update-other]');
    const differs = stale.changed ? ` · ${stale.changed} ${stale.changed === 1 ? 'file' : 'files'}` : '';
    const face = !stale.pr && stale.pull ? ['git-pull-request', `Switch to pull request #${stale.pull.number}`, `This branch has pull request #${stale.pull.number}${stale.pull.title ? `, ${stale.pull.title}` : ''}. Switch the review to it, and GitHub takes your comments.`]
      : stale.pinned ? ['folder-git-2', `Update from my checkout${differs}`, stale.behind || 'Show your files as they are, pushed or not'] : ['git-pull-request', 'Update from the pull request', 'Take the review back to the pull request as pushed'];
    if (other.dataset.face !== face.join('|')) { other.dataset.face = face.join('|'); other.firstElementChild.innerHTML = ico(face[0]); other.lastElementChild.textContent = face[1]; }
    set(other, 'disabled', !!stale.pinned && !!stale.behind);
    set(other, 'title', face[2]);
    const files = `${count} ${count === 1 ? 'file' : 'files'}`;
    const html = `${ico('refresh-cw')}<span>${updating ? 'Updating…' : count ? `Update · ${files}` : 'Update'}</span>`;
    if (updateButton.innerHTML !== html) updateButton.innerHTML = html;
    const hint = pushed && !updating ? `The pull request has a newer push${count ? `: ${files} changed` : ''}. Update the review to it: your comments and progress are kept.` : stale.pinned && !updating ? 'Ask GitHub whether the pull request has a newer push, and update this review to it' : updating ? 'Updating this review to the code as it is now' : count ? `${files} changed since this review. Update it: your comments and progress are kept.` : 'Check the code again and update this review';
    set(updateButton, 'title', hint);
    updateButton.setAttribute('aria-label', hint);
    set(updateButton, 'disabled', updating);
    updateButton.classList.toggle('is-stale', count > 0 || (!!pushed && !updating));
    updateButton.classList.toggle('is-busy', updating);
  };
  const checkStale = async () => {
    if (updating || document.hidden || Date.now() - staleAt < 5000) return;
    staleAt = Date.now();
    try { stale = await api('/api/sync'); } catch { return; }
    renderUpdate();
  };
  // A pull request's review shows the pull request's head. The first Update says so and lets the
  // reader have it follow the checkout instead; after that Update works as on any review.
  const followDialog = document.createElement('dialog');
  followDialog.id = 'dcr-follow';
  followDialog.className = 'modal';
  followDialog.setAttribute('aria-labelledby', 'dcr-follow-title');
  document.body.append(followDialog);
  // said: what the update just found (nothing new on the pull request), when that is why the
  // checkout is offered.
  const askFollow = (said = '') => {
    const count = stale.changed || 0;
    const differs = count ? `Your checkout differs in ${count} ${count === 1 ? 'file' : 'files'}.` : 'Your checkout has the same code right now.';
    const body = stale.pr
      ? `<p>${said ? `${tools.escape(said)} ` : ''}${differs}</p><p><b>Update from my checkout</b> shows your files as they are, pushed or not. Comments and progress are kept; GitHub comments then go only on files that match the pull request.</p><p class="muted">Update takes the review back to the pull request as pushed.</p>`
      : '<p>Update shows your checkout as it is. Comments and progress are kept.</p>';
    followDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box">
      <header><div><h2 id="dcr-follow-title">${stale.pr ? (said ? 'Nothing new on the pull request' : 'Update from my checkout') : 'Update this review'}</h2></div><button type="button" class="act act-quiet act-icon" data-follow-close aria-label="Close" title="Close (Esc)">${ico('x')}</button></header>
      <div class="dcr-follow-text">${body}${stale.warning ? `<p class="dcr-follow-warning" role="alert">${tools.escape(stale.warning)}</p>` : ''}</div>
      <footer class="dcr-gh-actions"><button type="button" class="act act-quiet" data-follow-close>Cancel</button><button type="button" class="act act-primary" data-follow-go>${stale.pr ? 'Update from my checkout' : 'Update anyway'}</button></footer></form>`;
    followDialog.showModal();
    followDialog.querySelector('[data-follow-close]:not(.act-icon)').focus();
  };
  // Switch to the pull request: the review of the checkout becomes the branch's pull request's.
  const askSwitch = () => {
    const pull = stale.pull;
    followDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box">
      <header><div><h2 id="dcr-follow-title">Switch to pull request #${pull.number}</h2></div><button type="button" class="act act-quiet act-icon" data-follow-close aria-label="Close" title="Close (Esc)">${ico('x')}</button></header>
      <div class="dcr-follow-text">${pull.title ? `<p><b>${tools.escape(pull.title)}</b></p>` : ''}<p>The review becomes the pull request's, so GitHub takes your comments. Your comments, conversations and progress are kept.</p><p class="muted">When your checkout has more than the pull request, the review goes on showing it, and GitHub takes comments on the files that match the pull request.</p></div>
      <footer class="dcr-gh-actions"><button type="button" class="act act-quiet" data-follow-close>Cancel</button><button type="button" class="act act-primary" data-switch-go>Switch to the pull request</button></footer></form>`;
    followDialog.showModal();
    followDialog.querySelector('[data-follow-close]:not(.act-icon)').focus();
  };
  followDialog.addEventListener('click', event => {
    if (event.target.closest('[data-follow-close]')) followDialog.close();
    else if (event.target.closest('[data-follow-go]')) { followDialog.close(); runUpdate('checkout', !!stale?.pinned); }
    else if (event.target.closest('[data-switch-go]')) { followDialog.close(); runUpdate('switch'); }
  });
  // Update on a pull request's review asks GitHub; the checkout is what it shows only when the
  // reader says so, here or in the menu. A review that already follows the checkout goes on doing so.
  updateButton.addEventListener('click', () => {
    // A review the reader has following the checkout goes on doing so until the pull request has a newer push.
    if (stale?.pr && (stale.pinned || stale.remote)) runUpdate('pr');
    else if (stale?.warning) askFollow();
    else runUpdate('checkout');
  });
  updateMore.addEventListener('click', event => {
    if (!event.target.closest('[data-update-other]:not(:disabled)')) return;
    updateMore.open = false;
    if (!stale?.pr && stale?.pull) askSwitch();
    else if (stale?.pinned) askFollow();
    else runUpdate('pr');
  });
  // from 'pr': the pull request as pushed. 'checkout': the files as they are; follow says the
  // reader chose that for a pull request's review. 'switch': to the branch's pull request.
  const runUpdate = async (from, follow = false) => {
    updating = true;
    renderUpdate();
    try {
      const result = from === 'switch' ? await api('/api/switch', {}) : await api('/api/sync', from === 'pr' ? {from: 'pr'} : {follow});
      if (result.status === 'updated') {
        try { sessionStorage.setItem(updatedKey, result.summary); } catch { /* the Overview says it too */ }
        history.replaceState(null, '', `/${location.hash}`); // the new revision, on the page the reader was on
        location.reload();
        return;
      }
      updating = false;
      staleAt = 0;
      await checkStale();
      // Nothing new where it looked. From the pull request, a checkout that differs is offered.
      if (from === 'pr' && stale?.pinned && stale.changed) askFollow('The pull request has no new commits.');
      else flash(from === 'pr' ? 'The pull request has no new commits. This review shows it as pushed.' : follow ? 'This review now follows your checkout, which has the same code right now.' : 'This review already shows the code as it is.');
    } catch (error) { flash(error.message); }
    updating = false;
    renderUpdate();
  };
  document.addEventListener('visibilitychange', checkStale);
  window.addEventListener('focus', checkStale);
  checkStale();
  try {
    const said = sessionStorage.getItem(updatedKey);
    sessionStorage.removeItem(updatedKey);
    if (said) flash(said);
  } catch { /* nothing to say */ }
  document.addEventListener('visibilitychange', () => { if (document.hidden && latestAtOpen !== null) announceFinished(); });

  // --- emojis by name ---------------------------------------------------------------------------
  // In any text field of the review, a colon and two letters open a short list of the emojis whose
  // name fits (GitHub's names, which the server fetches): the arrows move, Enter or Tab takes one,
  // Esc puts the list away and leaves the text. Typing the second colon of a whole name takes it
  // without the list. The list hangs from the field's edge, not from the caret, and while it is
  // open its keys are its own; once it is gone they are the field's again. It is inserted as
  // typing is, so undo gives the name back.
  const emojiList = document.createElement('ul');
  emojiList.id = 'dcr-emoji';
  emojiList.setAttribute('role', 'listbox');
  emojiList.setAttribute('aria-label', 'Emojis');
  emojiList.popover = 'manual'; // above an open dialog, which a plain element would sit behind
  document.body.append(emojiList);
  let emojis = null, emojisAsked = false, emojiPick = null; // emojiPick: {field, start, items, at}
  const textual = node => node?.matches?.('textarea, input[type="text"], input:not([type])') && !node.readOnly && !node.disabled;
  const closeEmojis = () => { if (emojiPick) { emojiPick = null; emojiList.hidePopover(); } };
  const putEmoji = (field, start, emoji) => {
    field.setSelectionRange(start, field.selectionStart);
    // As typing, so the field's own undo holds it; setRangeText for a browser without it.
    if (!document.execCommand('insertText', false, emoji)) { field.setRangeText(emoji, start, field.selectionEnd, 'end'); field.dispatchEvent(new Event('input', {bubbles: true})); }
  };
  const showEmojis = () => {
    const {field, items, at} = emojiPick;
    emojiList.innerHTML = items.map((item, index) => `<li role="option" data-emoji="${index}" aria-selected="${index === at}"><span aria-hidden="true">${item.emoji}</span>:${tools.escape(item.name)}:</li>`).join('');
    // Inside the dialog the field is in: everything outside a modal dialog takes no clicks.
    const home = field.closest('dialog') || document.body;
    if (emojiList.parentNode !== home) { if (emojiList.matches(':popover-open')) emojiList.hidePopover(); home.append(emojiList); }
    if (!emojiList.matches(':popover-open')) emojiList.showPopover();
    const box = field.getBoundingClientRect(), height = emojiList.offsetHeight;
    const below = box.bottom + 4 + height <= innerHeight || box.top - 4 - height < 0;
    emojiList.style.left = `${Math.max(8, Math.min(box.left, innerWidth - emojiList.offsetWidth - 8))}px`;
    emojiList.style.top = `${below ? box.bottom + 4 : box.top - 4 - height}px`;
  };
  document.addEventListener('input', async event => {
    const field = event.target;
    // Only what is typed or deleted by hand: an undo brings a name back to stay, and pasted text is left as it is.
    const typed = event.inputType === 'insertText' || event.inputType === 'deleteContentBackward';
    // An undo leaves the name selected, where the next key would wipe it: the caret goes after it.
    if (event.inputType === 'historyUndo' && textual(field) && /^:[a-z0-9_+-]+:$/.test(field.value.slice(field.selectionStart, field.selectionEnd))) field.setSelectionRange(field.selectionEnd, field.selectionEnd);
    if (!typed || !textual(field) || field.selectionStart !== field.selectionEnd) return closeEmojis();
    const token = tools.emojiToken(field.value, field.selectionStart);
    if (!token) return closeEmojis();
    if (!emojis && !emojisAsked) { emojisAsked = true; try { emojis = (await api('/api/emojis')).emojis; } catch { emojis = {}; } }
    if (!emojis || document.activeElement !== field) return;
    const now = tools.emojiToken(field.value, field.selectionStart); // the list may have arrived a few letters later
    if (!now) return closeEmojis();
    if (now.closed) {
      closeEmojis();
      // After this keystroke has finished, as a step of its own: put in from inside it, the
      // browser's undo would not know of it.
      if (event.data === ':' && emojis[now.query]) setTimeout(() => { const still = tools.emojiToken(field.value, field.selectionStart); if (document.activeElement === field && still?.closed && still.query === now.query) putEmoji(field, still.start, emojis[now.query]); }, 0);
      return;
    }
    const items = tools.emojiMatches(emojis, now.query);
    if (!items.length) return closeEmojis();
    emojiPick = {field, start: now.start, items, at: 0};
    showEmojis();
  });
  // Before every other key handler: while the list is open these four keys are its own.
  window.addEventListener('keydown', event => {
    if (!emojiPick) return;
    const {items} = emojiPick;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') emojiPick.at = (emojiPick.at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey) { const {field, start, at} = emojiPick; closeEmojis(); putEmoji(field, start, items[at].emoji); }
    else if (event.key === 'Escape') closeEmojis();
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (emojiPick) showEmojis();
  }, true);
  emojiList.addEventListener('mousedown', event => {
    const row = event.target.closest('[data-emoji]');
    event.preventDefault(); // the field keeps the focus
    if (!row || !emojiPick) return;
    const {field, start, items} = emojiPick;
    closeEmojis();
    putEmoji(field, start, items[Number(row.dataset.emoji)].emoji);
  });
  document.addEventListener('focusout', event => { if (emojiPick?.field === event.target) closeEmojis(); });
  window.addEventListener('scroll', closeEmojis, true);
  window.addEventListener('resize', closeEmojis);

  // Copy for LLMs carries the conversation, and where to read the rest of it.
  globalThis.ReviewTools.setConversationSource(id => threads[id]?.messages?.length ? {messages: threads[id].messages, series: review.history?.series} : null);

  // --- JevMyPR's verdict ---------------------------------------------------------------------
  // A strip between the toolbar and the review. The server sends the diff only once the reviewer
  // turned it on for this repository; the answer arrives with the poll, like everything else.
  const jevStrip = document.createElement('aside');
  jevStrip.id = 'dcr-jev';
  jevStrip.className = 'dcr-jev';
  jevStrip.setAttribute('aria-label', 'JevMyPR verdict');
  jevStrip.hidden = true;
  content.before(jevStrip);
  const jevSwitch = document.createElement('section');
  jevSwitch.className = 'view-row';
  jevSwitch.innerHTML = '<label class="view-switch"><input id="dcr-jev-toggle" class="toggle toggle-sm toggle-primary" type="checkbox"><span>JevMyPR verdict <small>sends this diff out</small></span></label>';
  document.querySelector('#settings-dialog .view-keys')?.before(jevSwitch);
  let jev = null; // {enabled, host, verdict}, once the server has said
  // The files that need the reviewer, listed under the strip's count; choosing one opens it.
  const jevList = document.createElement('div');
  jevList.id = 'dcr-jev-list';
  jevList.className = 'dcr-jev-list';
  jevList.setAttribute('popover', 'auto');
  jevList.setAttribute('aria-label', 'Files that need a human review');
  document.body.append(jevList);
  jevList.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    jevList.innerHTML = `<h2>Need a human review</h2><ul>${window.ReviewVerdict?.yoursHTML() || ''}</ul>`;
    const at = jevStrip.querySelector('.dcr-jev-yours')?.getBoundingClientRect();
    if (!at) return;
    jevList.style.left = `${Math.max(8, Math.min(at.left, innerWidth - jevList.offsetWidth - 8))}px`;
    jevList.style.top = `${at.bottom + 6}px`;
  });
  jevList.addEventListener('click', event => { if (event.target.closest('[data-file-link]')) jevList.hidePopover(); });
  const renderVerdict = () => {
    if (!jev) return;
    window.ReviewVerdict?.set(jev.enabled === true ? jev.verdict : null);
    const html = tools.jevBannerHTML(jev);
    if (jevStrip.innerHTML !== html) jevStrip.innerHTML = html;
    set(jevStrip, 'hidden', !html);
    set(jevSwitch.querySelector('input'), 'checked', jev.enabled === true);
    renderPublish();
  };
  const showVerdict = verdict => { if (jev) { jev.verdict = verdict || null; renderVerdict(); } };
  const askVerdict = async extra => {
    try { jev = await api('/api/verdict', {key, ...extra}); renderVerdict(); }
    catch { /* the review works without it */ }
  };
  jevStrip.addEventListener('click', event => {
    const action = event.target.closest('[data-dcr-jev]')?.dataset.dcrJev;
    if (action) askVerdict(action === 'again' ? {again: true} : {enabled: action === 'on'});
  });
  jevSwitch.addEventListener('change', event => askVerdict({enabled: event.target.checked}));

  // --- Publish: the review, on its pull request -----------------------------------------------
  // One button at the header's end says what is left before the review can go to GitHub, and
  // counts down while the reader works: the files that need them, then the open comments, then
  // the code being the pull request's as pushed. Done, it publishes a short report as one comment
  // (updated in place later) and a check on the reviewed commit. The server checks it all again.
  const publishButton = Object.assign(document.createElement('button'), {type: 'button', id: 'dcr-publish', className: 'header-button'});
  document.querySelector('.header-actions')?.append(publishButton);
  let publishCheck = null, publishAsked = 0, publishTimer = null, publishing = false, wasLeft = null;
  const ring = (done, total) => {
    const around = 2 * Math.PI * 7, part = total ? Math.min(1, done / total) : 1;
    return `<svg class="dcr-ring" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7"/><circle class="dcr-ring-fill" cx="9" cy="9" r="7" stroke-dasharray="${(around * part).toFixed(2)} ${around.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`;
  };
  // The files that need the reader, as the page has them now: those JevMyPR wants a person on, or all.
  const filesNeed = () => {
    const said = jev?.enabled === true && jev.verdict?.status === 'ready' ? jev.verdict.files || {} : null;
    const yours = snapshot.files.map(file => file.path).filter(path => !said || said[path] === 'human');
    const viewed = saved().viewedFiles || [];
    return {yours, left: yours.filter(path => !viewed.includes(path)), verdict: !!said};
  };
  const stepOf = id => publishCheck?.steps?.find(step => step.id === id);
  const PUBLISH_NEXT = {switch: 'Switch to the PR', open: 'Open a PR', update: 'Update first', push: 'Push to publish', error: 'Publish'};
  const publishFace = () => {
    const need = filesNeed();
    const plural = (number, one) => `${number} ${one}${number === 1 ? '' : 's'}`;
    if (need.left.length) return {tone: 'todo', icon: ring(need.yours.length - need.left.length, need.yours.length), text: `${plural(need.left.length, 'file')} left`, hint: `${plural(need.left.length, 'file')} still ${need.left.length === 1 ? 'needs' : 'need'} you. Read ${need.left.length === 1 ? 'it' : 'them'}, then publish your review to GitHub.`};
    // Until the server has checked the comments and the code, nothing says ready.
    if (!publishCheck) return {tone: 'idle', icon: window.ReviewGitHub?.mark || ico('send'), text: 'Publish', hint: 'Checking whether your review can be published…'};
    const open = stepOf('comments')?.open?.length || 0;
    if (open) return {tone: 'todo', icon: ico('message-square'), text: `${plural(open, 'comment')} open`, hint: `Resolve ${open === 1 ? 'it' : 'them'}, or have ${open === 1 ? 'it' : 'them'} fixed, then publish your review to GitHub.`};
    const code = stepOf('code');
    if (code && !code.done) return {tone: 'todo', icon: ico('git-pull-request'), text: PUBLISH_NEXT[code.kind] || 'Publish', hint: code.text};
    const published = publishCheck?.published;
    if (published && published.body === publishCheck.markdown) return {tone: 'done', icon: ico('check'), text: 'Published', hint: 'Your review is on the pull request. Open to see it.'};
    return {tone: 'ready', icon: window.ReviewGitHub?.mark || ico('send'), text: published ? 'Publish again' : 'Publish', hint: publishCheck ? 'Publish your review to the pull request' : 'Checking whether your review can be published…'};
  };
  const renderPublish = () => {
    const face = publishFace();
    const html = `${face.icon}<span>${tools.escape(face.text)}</span>`;
    if (publishButton.innerHTML !== html) publishButton.innerHTML = html;
    publishButton.dataset.tone = face.tone;
    set(publishButton, 'title', face.hint);
    publishButton.setAttribute('aria-label', `${face.text}. ${face.hint}`);
    // The last file read is worth a word: what comes next.
    const left = filesNeed().left.length;
    if (wasLeft && !left) flash('Every file that needs you is reviewed. Publish your review to GitHub from the top right.');
    wasLeft = left;
    if (publishDialog.open && !publishing) renderPublishDialog();
  };
  // Asked again a moment after anything changes (a file marked, a comment resolved), and on coming back to the tab.
  const askPublish = async (fresh = false) => {
    const asked = ++publishAsked;
    try {
      const check = await api(`/api/publish?key=${encodeURIComponent(key)}${fresh ? '&fresh=1' : ''}`);
      if (asked === publishAsked) publishCheck = check;
    } catch (error) {
      if (asked === publishAsked) publishCheck = {steps: [{id: 'code', done: false, kind: 'error', text: error.message === 'Not found' ? 'This review\'s server is older than its page: restart `dcr serve`.' : error.message}]};
    }
    renderPublish();
  };
  const laterPublish = () => { clearTimeout(publishTimer); publishTimer = setTimeout(() => { if (!document.hidden) askPublish(); }, 1500); };

  const publishDialog = document.createElement('dialog');
  publishDialog.id = 'dcr-publish-dialog';
  publishDialog.className = 'modal dcr-gh-finish';
  publishDialog.setAttribute('aria-labelledby', 'dcr-publish-title');
  document.body.append(publishDialog);
  const publishStepsHTML = () => {
    const need = filesNeed();
    const comments = stepOf('comments'), code = stepOf('code');
    const total = publishCheck?.facts?.comments?.total || 0;
    const next = window.ReviewVerdict?.order?.(need.left)?.[0] || need.left[0];
    const open = comments?.open?.[0];
    const fix = {switch: '<button type="button" class="act act-secondary" data-publish-do="switch">Switch</button>', update: '<button type="button" class="act act-secondary" data-publish-do="update">Update</button>'}[code?.kind] || (code && !code.done ? '<button type="button" class="act act-quiet" data-publish-do="again">Check again</button>' : '');
    const files = need.left.length
      ? `${need.verdict ? `JevMyPR says ${need.yours.length} ${need.yours.length === 1 ? 'needs' : 'need'} a person. ` : ''}${need.left.length} left.`
      : need.verdict ? (need.yours.length ? `JevMyPR said ${need.yours.length} needed a person: all read.` : 'JevMyPR says none needs a person.') : `All ${need.yours.length} read.`;
    const rows = [
      {done: !need.left.length, title: 'Read the files that need you', text: files, action: next ? `<button type="button" class="act act-secondary" ${window.ReviewVerdict?.openAttributes?.(next) || ''} data-publish-close>Open next</button>` : ''},
      {done: !!comments?.done, title: 'Settle every comment', text: !comments ? 'Checking…' : comments.open.length ? `${comments.open.length} still open: resolve each, or have it fixed.` : total ? `All ${total} settled.` : 'No comments to settle.', action: open ? `<button type="button" class="act act-secondary" data-ledger-jump="${tools.escape(open)}" data-publish-close>Show</button>` : ''},
      {done: !!code?.done, title: 'Review the code that is on the pull request', text: !code ? 'Checking…' : code.done ? `${tools.escape(code.repo)} #${tools.escape(code.number)}, as pushed.` : tools.escape(code.text), action: fix}
    ];
    return rows.map((row, index) => `<li class="${row.done ? 'is-done' : ''}"><span class="dcr-step-mark" aria-hidden="true">${row.done ? ico('check') : index + 1}</span><span class="dcr-step-text"><b>${row.title}</b><small>${row.text}</small></span>${row.done ? '' : row.action}</li>`).join('');
  };
  const renderPublishDialog = () => {
    const ready = !!publishCheck?.ready && !filesNeed().left.length;
    const published = publishCheck?.published;
    const code = stepOf('code');
    const where = code?.done ? `${tools.escape(code.repo)} #${tools.escape(code.number)}${me?.login ? ` · as <b>@${tools.escape(me.login)}</b>` : ''}` : 'The pull request gets a short report: counts and outcomes, never what anyone wrote.';
    const preview = publishCheck?.markdown ? tools.markdown(publishCheck.markdown.replace(/^<!--.*?-->\n/, '')) : '';
    publishDialog.innerHTML = `<form method="dialog" class="modal-box dcr-gh-box dcr-publish-box">
      <header><div><h2 id="dcr-publish-title">Publish your review</h2><p class="muted">${where}</p></div><button type="button" class="act act-quiet act-icon" data-publish-close aria-label="Close" title="Close (Esc)">${ico('x')}</button></header>
      <ol class="dcr-publish-steps">${publishStepsHTML()}</ol>
      ${preview ? `<section class="dcr-publish-preview" aria-label="What the pull request shows"><h3>On the pull request</h3><div class="dcr-body">${preview}</div></section>` : ''}
      <p class="gh-finish-state" role="status" aria-live="polite" hidden></p>
      <footer class="dcr-gh-actions">${published?.url ? `<a class="act act-quiet" href="${tools.escape(published.url)}" target="_blank" rel="noopener noreferrer">Last published ${ico('arrow-up-right')}</a>` : ''}<button type="button" class="act act-quiet" data-publish-close>Cancel</button><button type="button" class="act act-gh" data-publish-go ${ready ? '' : 'disabled'} title="${ready ? 'Post the report and mark the commit as reviewed' : 'Finish the steps above first'}">${window.ReviewGitHub?.mark || ''}<span>${published ? 'Publish again' : 'Publish to GitHub'}</span></button></footer></form>`;
  };
  const publishState = (tone, html) => {
    const line = publishDialog.querySelector('.gh-finish-state');
    line.dataset.tone = tone;
    line.innerHTML = html;
    line.hidden = !html;
  };
  publishButton.addEventListener('click', () => {
    renderPublishDialog();
    publishDialog.showModal();
    publishDialog.querySelector('form').focus({preventScroll: true});
    askPublish(true);
  });
  publishDialog.addEventListener('click', async event => {
    if (event.target.closest('[data-publish-close]')) { publishDialog.close(); return; }
    const action = event.target.closest('[data-publish-do]')?.dataset.publishDo;
    if (action === 'again') { event.target.closest('button').disabled = true; await askPublish(true); return; }
    if (action === 'switch' || action === 'update') { publishDialog.close(); runUpdate(action === 'switch' ? 'switch' : 'pr'); return; }
    const go = event.target.closest('[data-publish-go]');
    if (!go || go.disabled) return;
    publishing = true;
    publishDialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    go.innerHTML = '<span class="gh-spinner" aria-hidden="true"></span>Publishing…';
    publishState('busy', '');
    try {
      publishCheck = await api('/api/publish', {key});
      const posted = publishCheck.published;
      publishDialog.querySelector('.dcr-gh-actions').innerHTML = `<button type="button" class="act act-quiet" data-publish-close>Close</button><a class="act act-secondary" href="${tools.escape(posted.url)}" target="_blank" rel="noopener noreferrer">View on GitHub ${ico('arrow-up-right')}</a>`;
      publishState('done', `<span class="gh-mark">${ico('check')}</span><span><b>Published.</b> The report is on the pull request${posted.status_error ? `, but the check on the commit was not set: ${tools.escape(posted.status_error)}` : ', and the commit is marked as reviewed'}.</span>`);
    } catch (error) {
      publishDialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
      go.innerHTML = `${window.ReviewGitHub?.mark || ''}<span>Try again</span>`;
      publishState('error', `<span class="gh-mark">${ico('circle-alert')}</span><span>Not published. ${tools.escape(error.message)}</span>`);
    } finally { publishing = false; renderPublish(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) askPublish(); });
  progressChanged = () => { renderPublish(); laterPublish(); };
  renderPublish();

  // --- sync ----------------------------------------------------------------------------------
  const apply = data => {
    if (data.rev !== rev) laterPublish();
    threads = data.threads; rev = data.rev; latest = data.latest_revision; latestSave = data.latest_save || 0; listening = data.listening; listener = data.agent || listener; listenerModel = data.agent_model || (data.agent ? null : listenerModel); online = true; previews = data.previews || {};
    const ghNext = {pending: data.github?.pending || {}, posted: data.github?.posted || {}, bodies: data.github?.bodies || {}, drafts: data.github?.drafts || {}, voice: data.github?.voice};
    if (JSON.stringify(ghNext) !== JSON.stringify({pending: ghData.pending, posted: ghData.posted, bodies: ghData.bodies, drafts: ghData.drafts, voice: ghData.voice})) { ghData = ghNext; settleDraft(); }
    receiveComments(data.comments || []);
    receiveScreenshots(data.screenshots || [], data.no_screenshots);
    // The Risk ranking the agent posts while the reader is already on the diff; until then, a placeholder.
    if ('risk_ranking' in data) window.ReviewRisk?.set(data.risk_ranking);
    if ('verdict' in data) showVerdict(data.verdict);
    window.ReviewRisk?.allowRedo(online);
    if (!seenKnown) { tools.unseen(threads, seen).forEach(item => seen.add(item.id)); saveSeen(); seenKnown = true; }
    // What the agents said became of a comment is its closing block, not a message to read: it
    // is never announced, and never opens Your review. A disagreement is, since the reader decides.
    Object.values(threads).forEach(thread => {
      if (!thread.outcome || tools.closure(thread)?.state === 'differ') return;
      (thread.messages || []).forEach(message => { if (message.author === 'agent' && (message.about === 'outcome' || (!message.role && message.outcome)) && !seen.has(message.id)) { seen.add(message.id); saveSeen(); } });
    });
    const arrived = tools.unseen(threads, seen).filter(item => !announced.has(item.id));
    arrived.forEach(item => announced.add(item.id));
    decorate(); autoResolve(); decorateLedger(); window.ReviewGitHub?.refresh(); renderPanel(); renderUnsent(); renderAgent(); refreshUnread();
    announce(arrived);
    announceFinished();
    renderUpdate();
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
  askVerdict();
  askPublish();
  api('/api/adversaries').then(data => { adversaries = data.adversaries; decorate(); renderAgent(); if (data.decided === false) openIntro(); }).catch(() => { /* none until the card lists them */ });
})();
