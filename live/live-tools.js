/* Pure helpers for the served review's conversation layer. Loaded only by `dcr serve`. */
'use strict';
globalThis.LiveTools = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const PERSONAL = /^mine-/;

  // --- who wrote it ------------------------------------------------------------------------------
  // An agent is a slug (claude, codex, ...). Known ones show their company's mark; any other shows
  // its first letter. Messages from before agents were named stay "Agent".
  const AGENTS = {
    claude: {name: 'Claude', company: 'Anthropic'},
    codex: {name: 'Codex', company: 'OpenAI'},
    gemini: {name: 'Gemini', company: 'Google'},
    grok: {name: 'Grok', company: 'xAI'},
    antigravity: {name: 'Antigravity', company: 'Google'},
    cursor: {name: 'Cursor', company: 'Cursor'},
    opencode: {name: 'opencode', company: 'opencode'}
  };
  const SPARK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
  function agentInfo(slug) {
    const known = slug && AGENTS[slug];
    const name = known ? known.name : slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Agent';
    return {slug: slug || '', name, company: known?.company || '', mark: slug ? globalThis.ReviewBrands?.[slug] || '' : ''};
  }
  // The round mark beside a message: the company's logo, a letter, or the generic spark.
  function avatarHTML(slug, extra = '') {
    const agent = agentInfo(slug);
    const face = agent.mark || (slug ? `<b>${escape(agent.name.charAt(0))}</b>` : SPARK);
    return `<span class="dcr-avatar dcr-face${extra ? ` ${extra}` : ''}" data-agent="${escape(agent.slug)}" title="${escape(agent.company ? `${agent.name} · ${agent.company}` : agent.name)}" aria-hidden="true">${face}</span>`;
  }
  const VERDICTS = {
    agree: {label: 'Agrees', short: 'Agree', tone: 'agree'},
    partly: {label: 'Partly agrees', short: 'Partly', tone: 'partly'},
    disagree: {label: 'Disagrees', short: 'Disagree', tone: 'disagree'}
  };
  const VERDICT_ICON = {
    agree: '<path d="M20 6 9 17l-5-5"/>',
    partly: '<path d="M5 12h14"/>',
    disagree: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  const verdictIcon = verdict => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${VERDICT_ICON[verdict] || ''}</svg>`;
  const verdictHTML = verdict => VERDICTS[verdict] ? `<span class="dcr-verdict dcr-v-${verdict}">${verdictIcon(verdict)}${VERDICTS[verdict].label}</span>` : '';
  const names = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const progressKey = (snapshot, review) => `dynamic-review:${snapshot.fingerprint}${review.history ? `:${review.history.series}:${review.history.revision}` : ''}`;

  // Every comment the reader can send: the agent's findings and the reader's own.
  function allComments(review, saved = {}) {
    const generated = globalThis.ReviewTools.overviewFeedback(review).comments.map(comment => ({...comment, personal: false}));
    const personal = (Array.isArray(saved.personalComments) ? saved.personalComments : []).filter(comment => PERSONAL.test(comment.id)).map(comment => ({...comment, personal: true}));
    return [...generated, ...personal];
  }

  // The text the agent receives for a first send: the same captured code and comment as
  // "Copy for LLMs", plus anything the reader wrote while composing.
  // Second opinions other agents already gave on it come along, shortened.
  function sendText(snapshot, review, comment, note = '', thread = null) {
    let text = globalThis.ReviewTools.commentText(snapshot, {...comment, resolved: false}, review.qa, {conversation: false});
    const opinions = [
      ...(thread?.messages || []).filter(message => message.role === 'adversary').map(message => [message.agent, 'second reviewer', message.verdict, message.body]),
      ...Object.entries(thread?.opinions || {}).filter(([, opinion]) => opinion.body).map(([agent, opinion]) => [agent, null, opinion.verdict, opinion.body])
    ].map(([agent, role, verdict, body]) => {
      const said = [role, VERDICTS[verdict]?.label.toLowerCase()].filter(Boolean).join(', ');
      const short = body.length > 700 ? `${body.slice(0, 700)}…` : body;
      return `- ${agentInfo(agent).name}${said ? ` (${said})` : ''}: ${short.replace(/\s*\n\s*/g, ' ')}`;
    });
    if (opinions.length) text += `\n\nSecond opinions from other agents:\n${opinions.join('\n')}`;
    return note.trim() ? `${text}\n\nReviewer's message:\n${note.trim()}` : text;
  }

  // Comments the reader wrote for the agent and has not sent. Resolved ones are skipped; findings
  // are the agent's own, and a PR comment is meant for GitHub, so neither is a "draft".
  function drafts(comments, threads, resolved = []) {
    return comments.filter(comment => comment.personal && comment.audience !== 'pr' && !resolved.includes(comment.id) && !threads[comment.id]?.live && threads[comment.id]?.delivery !== 'sent');
  }

  const actionLabel = thread => thread?.live ? 'Reply' : 'Ask agent';

  // --- reading an agent's answer -----------------------------------------------------------------
  const markdown = text => globalThis.ReviewTools.markdown(text);

  // The start of an answer as plain text for a narrow list: its first paragraph with the Markdown marks
  // removed. Underscores stay; they are part of identifiers such as `to_params`.
  const snippet = text => String(text ?? '').replace(/```[\s\S]*?(```|$)/g, '\n\n').split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '').replace(/\*\*/g, '').replace(/(^|\s)[*>#-]+\s+/g, '$1').replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';

  function relativeTime(at, now = Date.now()) {
    const then = Date.parse(at);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(then).toLocaleDateString();
  }

  // What a thread is doing, in words and as a tone the page can style. `listening` is whether an
  // agent is waiting for messages right now; undefined means the server cannot say.
  const STALE_MS = 10 * 60 * 1000; // a handed-over message with no answer after this is probably dropped
  const stale = (thread, now) => thread?.delivery === 'delivered' && thread.delivered_at && now - Date.parse(thread.delivered_at) > STALE_MS;
  // Agents asked for a second opinion time out long before this, so a wait this old lost its asker.
  const lostOpinion = (thread, now) => !!thread?.asked_at && now - Date.parse(thread.asked_at) > STALE_MS;
  // The second reviewer is still checking the comment: asked, and not yet answered in the
  // conversation. Asked again later about a question, it answers beside it like the others.
  const checkingComment = thread => !!thread?.adversary && (thread.waiting_on || []).includes(thread.adversary)
    && !(thread.messages || []).some(message => message.role === 'adversary' && message.agent === thread.adversary);
  function statusModel(thread, listening, now = Date.now(), listener = null) {
    if (!thread) return null;
    const last = [...(thread.messages || [])].reverse().find(message => message.author === 'agent' && message.role !== 'adversary');
    // A second reviewer checking the comment shows in the conversation, like someone typing.
    if (checkingComment(thread) && thread.delivery !== 'sent' && thread.delivery !== 'delivered') {
      if (lostOpinion(thread, now)) return {tone: 'idle', text: `${agentInfo(thread.adversary).name} was asked to check this comment ${relativeTime(thread.asked_at, now)} and has not answered. The check may have been interrupted; ask your agent to run it again.`};
      return {tone: 'work', text: `${agentInfo(thread.adversary).name} is checking this comment`, typing: true, agent: thread.adversary};
    }
    if (thread.delivery === 'sent') {
      return listening === false
        ? {tone: 'idle', text: 'Sent. No agent is listening yet; it will answer when your agent picks it up.'}
        : {tone: 'wait', text: 'Sent. Your agent will pick it up in a moment.'};
    }
    if (stale(thread, now)) return {tone: 'idle', text: `Your agent received this ${relativeTime(thread.delivered_at, now)} and has not answered. It may have been interrupted; reply to nudge it.`};
    if (thread.delivery === 'delivered') return {tone: 'work', text: 'Your agent is working on an answer', typing: true};
    if (thread.delivery === 'answered') return {tone: 'done', text: `${last?.agent || listener ? agentInfo(last?.agent || listener).name : 'Your agent'} replied`, at: last?.at};
    return null;
  }
  const statusText = (thread, listening) => statusModel(thread, listening)?.text || '';

  // The conversation under a comment: a plain thread, no boxes. Messages the reader has not
  // seen yet carry a New marker. Each agent message names its agent; the second reviewer's says
  // what it thinks of the comment. `agent` names unnamed agent messages (the one listening).
  function messagesHTML(thread, {seen = new Set(), now = Date.now(), agent: fallback = null} = {}) {
    const messages = thread?.messages || [];
    if (!messages.length) return '';
    return messages.map(message => {
      const agent = message.author === 'agent';
      const fresh = agent && !seen.has(message.id);
      const slug = agent ? message.agent || fallback : null;
      const adversary = message.role === 'adversary';
      const who = agent ? escape(agentInfo(slug).name) : 'You';
      const role = adversary ? '<span class="dcr-role">second reviewer</span>' : '';
      const avatar = agent ? avatarHTML(slug) : '<span class="dcr-avatar" aria-hidden="true">Y</span>';
      return `<article class="dcr-msg ${agent ? 'dcr-agent' : 'dcr-you'}${adversary ? ` dcr-adversary dcr-v-${escape(message.verdict || 'none')}` : ''}" data-msg="${escape(message.id)}">${avatar}<div class="dcr-msg-main"><header class="dcr-msg-head"><strong>${who}</strong>${adversary ? verdictHTML(message.verdict) : ''}${role}<time datetime="${escape(message.at || '')}" data-at="${escape(message.at || '')}">${escape(relativeTime(message.at, now))}</time>${fresh ? '<span class="dcr-new">New</span>' : ''}</header><div class="dcr-body">${markdown(message.body)}</div></div></article>`;
    }).join('');
  }

  // What every agent asked about a comment thinks of it: the second reviewer's verdict and the others'.
  function verdicts(thread) {
    const out = [];
    (thread?.messages || []).forEach(message => { if (message.role === 'adversary' && message.verdict) out.push({agent: message.agent, verdict: message.verdict}); });
    Object.entries(thread?.opinions || {}).forEach(([agent, opinion]) => { if (opinion.verdict) out.push({agent, verdict: opinion.verdict}); });
    return out;
  }
  function tally(thread) {
    const list = verdicts(thread);
    const count = verdict => list.filter(entry => entry.verdict === verdict).length;
    return {total: list.length, agree: count('agree'), partly: count('partly'), disagree: count('disagree')};
  }
  const tallyText = counts => [counts.agree && `${counts.agree} agree${counts.agree === 1 ? 's' : ''}`, counts.partly && `${counts.partly} partly`, counts.disagree && `${counts.disagree} disagree${counts.disagree === 1 ? 's' : ''}`].filter(Boolean).join(' · ');

  // How the whole panel came out, in words: the second reviewer and the others together.
  function consensus(counts) {
    if (!counts.total) return '';
    if (counts.agree === counts.total) return counts.total === 1 ? 'Agrees' : 'Everyone agrees';
    if (counts.disagree === counts.total) return counts.total === 1 ? 'Disagrees' : 'Everyone disagrees';
    return tallyText(counts);
  }
  const consensusTone = counts => !counts.total ? '' : counts.agree === counts.total ? 'agree' : counts.disagree === counts.total ? 'disagree' : 'partly';

  // The other agents' opinions, under the conversation rather than in it: one row per agent with
  // its mark, name and verdict once, then the start of its answer. A row opens in place to the full
  // answer. `open`: the agents whose answers are open.
  function opinionsHTML(thread, {open = [], seen = new Set(), now = Date.now()} = {}) {
    const opinions = thread?.opinions || {};
    const adversary = thread?.adversary;
    const opened = new Set(typeof open === 'string' ? [open] : open || []);
    // The second reviewer answers in the conversation; it shows here only when it could not answer.
    const answered = Object.keys(opinions).filter(agent => opinions[agent].role !== 'adversary' || opinions[agent].error);
    const waiting = (thread?.waiting_on || []).filter(agent => agent !== adversary || !checkingComment(thread));
    const agents = [...new Set([...answered, ...waiting])];
    if (!agents.length) return '';
    const counts = tally(thread);
    const summary = consensus(counts);
    const rows = agents.map(agent => {
      const opinion = opinions[agent];
      const name = escape(agentInfo(agent).name);
      // Asked again, an agent shows as reading until its new answer replaces the old one.
      const asked = waiting.includes(agent);
      if (asked && lostOpinion(thread, now)) return `<li class="dcr-op is-failed" title="Asked ${escape(relativeTime(thread.asked_at, now))}; the check may have been interrupted">${avatarHTML(agent, 'dcr-face-sm')}<span class="dcr-op-line"><strong>${name}</strong><span class="dcr-op-note">did not answer</span></span></li>`;
      if (asked || !opinion) return `<li class="dcr-op is-waiting">${avatarHTML(agent, 'dcr-face-sm')}<span class="dcr-op-line"><strong>${name}</strong><span class="dcr-op-note">is reading the code</span><span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span></span></li>`;
      if (opinion.error) return `<li class="dcr-op is-failed" title="${escape(opinion.error)}">${avatarHTML(agent, 'dcr-face-sm')}<span class="dcr-op-line"><strong>${name}</strong><span class="dcr-op-note">did not answer</span></span></li>`;
      const isOpen = opened.has(agent);
      const fresh = opinion.id && !seen.has(opinion.id);
      const verdict = VERDICTS[opinion.verdict] ? `<span class="dcr-op-verdict dcr-v-${opinion.verdict}">${verdictIcon(opinion.verdict)}${VERDICTS[opinion.verdict].short}</span>` : '';
      const chevron = '<svg class="dcr-op-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
      return `<li class="dcr-op${isOpen ? ' is-open' : ''}"><button type="button" class="dcr-op-toggle" data-dcr-opinion="${escape(agent)}" aria-expanded="${isOpen}">${avatarHTML(agent, 'dcr-face-sm')}<span class="dcr-op-line"><strong>${name}</strong>${verdict}${fresh ? '<span class="dcr-op-new" aria-label="New"></span>' : ''}${isOpen ? `<time data-at="${escape(opinion.at || '')}">${escape(relativeTime(opinion.at))}</time>` : `<span class="dcr-op-snippet">${escape(snippet(opinion.body))}</span>`}</span>${chevron}</button>${isOpen ? `<div class="dcr-op-body dcr-body">${markdown(opinion.body)}</div>` : ''}</li>`;
    }).join('');
    return `<section class="dcr-opinions" aria-label="Other opinions"><header class="dcr-opinions-head"><span class="dcr-opinions-title">Other opinions</span>${summary ? `<span class="dcr-consensus dcr-v-${consensusTone(counts)}">${escape(summary)}</span>` : ''}</header><ul class="dcr-ops">${rows}</ul></section>`;
  }

  // Agent messages in a thread map that are not in `seen`.
  function unseen(threads, seen) {
    const out = [];
    Object.entries(threads || {}).forEach(([id, thread]) => (thread.messages || []).forEach(message => {
      if (message.author === 'agent' && !seen.has(message.id)) out.push({thread: id, id: message.id});
    }));
    return out;
  }

  // The agent as a whole: listening for messages, working on one, or not connected.
  function agentModel(threads, listening, now = Date.now(), previews = {}, listener = null) {
    if (listening === undefined) return null;
    const name = listener ? agentInfo(listener).name : 'Agent';
    const building = Object.values(previews || {}).some(preview => preview.status === 'working');
    const working = building || Object.values(threads || {}).some(thread => thread.delivery === 'delivered' && !stale(thread, now));
    if (working) return {tone: 'work', text: `${name} working`, hint: `${listener ? name : 'Your agent'} received a message and is preparing an answer.`, agent: listener};
    if (listening) return {tone: 'ok', text: `${name} listening`, hint: `${listener ? name : 'Your agent'} is waiting for your next message.`, agent: listener};
    return {tone: 'off', text: 'No agent connected', hint: 'Nothing is listening yet. Ask your agent to continue this review so it can answer here.'};
  }

  // --- adversaries ----------------------------------------------------------------------------
  // The agents the reviewer chose to check the review, in their order: the first answers in a
  // comment's conversation, the rest beside it. An agent checks the review it runs only on a model
  // the reviewer named (the server keeps the same rule), and only an installed one is asked.
  const activeAdversaries = (adversaries, author, catalog = null) => (adversaries || []).filter(entry =>
    (entry.agent !== author || entry.model) && (!catalog || catalog.some(agent => agent.slug === entry.agent && agent.installed)));

  // Overlapping marks, one per agent, however many; past `max` the rest is a count.
  function facesHTML(slugs, max = 4) {
    const shown = slugs.slice(0, slugs.length > max ? max - 1 : max);
    const rest = slugs.length - shown.length;
    return `<span class="dcr-stack">${shown.map(slug => avatarHTML(slug, 'dcr-face-xs')).join('')}${rest ? `<b class="dcr-stack-more">+${rest}</b>` : ''}</span>`;
  }

  // How an agent on this computer stands, in a word, with the detail as a hint. A CLI with no status
  // command cannot say whether it is signed in; its last real answer can.
  function agentStatus(agent, now = Date.now()) {
    const last = agent.last;
    const answered = last?.ok ? `Last answered ${relativeTime(last.at, now)}.` : '';
    if (agent.ready === false) return {tone: 'off', text: 'Signed out', hint: `Run \`${agent.bin || agent.slug}\` once in a terminal to sign in.`};
    if (agent.ready === true) return {tone: 'ok', text: 'Ready', hint: [`Signed in.`, answered, last && !last.ok ? `Last try failed: ${last.error}` : ''].filter(Boolean).join(' ')};
    if (last && !last.ok) return {tone: 'warn', text: 'Last try failed', hint: last.error || ''};
    if (last?.ok) return {tone: 'ok', text: 'Ready', hint: answered};
    return {tone: 'idle', text: 'Installed', hint: 'It cannot say whether it is signed in; its first answer will tell.'};
  }

  const optionHTML = (value, label, current) => `<option value="${escape(value)}"${value === (current || '') ? ' selected' : ''}>${escape(label)}</option>`;

  // A real choice rather than "default": the model the CLI runs when given none, when it says;
  // else the one suggested for it; else the first it lists. null only when it lists none.
  const chosenModel = agent => agent.default_model || (agent.models || []).find(model => model.default)?.id || agent.suggested || agent.models?.[0]?.id || null;

  // The efforts the chosen model takes (Codex says per model), else the agent's, else every effort its
  // models take; [] when it has none.
  function effortLevels(agent, model) {
    const listed = (agent.models || []).find(entry => entry.id === model)?.efforts;
    if (listed?.length) return listed;
    if (agent.efforts?.length) return agent.efforts;
    return [...new Set((agent.models || []).flatMap(entry => entry.efforts || []))];
  }
  // The effort the CLI would use with that model, when it says; else medium; else the first.
  function chosenEffort(agent, model) {
    const levels = effortLevels(agent, model);
    const said = [agent.default_effort, (agent.models || []).find(entry => entry.id === model)?.default_effort].find(level => levels.includes(level));
    return said || (levels.includes('medium') ? 'medium' : levels[0] || null);
  }
  // An adversary with every choice made: what was saved, or what the CLI would pick.
  function settle(agent, entry) {
    const model = entry.model || chosenModel(agent);
    const levels = effortLevels(agent, model);
    return {...entry, model, effort: levels.includes(entry.effort) ? entry.effort : chosenEffort(agent, model)};
  }


  // The models an agent lists, free ones first, the CLI's own default marked.
  function modelOptionsHTML(agent, current) {
    const models = [...(agent.models || [])];
    for (const id of [agent.suggested, current]) if (id && !models.some(model => model.id === id)) models.unshift({id});
    if (!models.length) return optionHTML('', 'Its default model', current);
    const pick = current ? '' : optionHTML('', 'Pick a model', '');
    const fallback = agent.default_model || models.find(model => model.default)?.id;
    const label = model => `${model.label || model.id}${model.id === fallback ? ' · default' : ''}`;
    const free = models.filter(model => model.free);
    const rest = models.filter(model => !model.free);
    const list = items => items.map(model => optionHTML(model.id, label(model), current)).join('');
    return pick + (free.length ? `<optgroup label="Free">${list(free)}</optgroup><optgroup label="Other models">${list(rest)}</optgroup>` : list(rest));
  }

  // The efforts the chosen model takes; '' when it has none.
  function effortOptionsHTML(agent, model, current) {
    const levels = effortLevels(agent, model);
    if (!levels.length) return '';
    return levels.map(level => optionHTML(level, level.charAt(0).toUpperCase() + level.slice(1), current)).join('');
  }

  // The Adversaries section of the agent card. catalog: the agent CLIs the server found (null while it looks).
  function adversaryPanelHTML({catalog, adversaries = [], author = null, error = '', now = Date.now()}) {
    const refresh = `<button type="button" class="icon-button dcr-adv-recheck" data-dcr-adv-recheck aria-label="Look for agents again" title="Look again"${catalog ? '' : ' disabled'}>${globalThis.ReviewIcons?.['refresh-cw']?.replace('<svg', '<svg aria-hidden="true" focusable="false"') || '↻'}</button>`;
    const active = activeAdversaries(adversaries, author, catalog);
    const head = `<header class="dcr-adv-head"><span class="dcr-adv-title" id="dcr-adv-title">Adversaries</span><span class="dcr-adv-count">${active.length ? `${active.length} on` : 'Off'}</span>${refresh}</header>`;
    if (error) return `${head}<p class="dcr-adv-msg">${escape(error)}</p>`;
    if (!catalog) return `${head}<p class="dcr-adv-msg">Looking for agents on this computer<span class="dcr-typing" aria-hidden="true"><i></i><i></i><i></i></span></p>`;
    const installed = catalog.filter(agent => agent.installed);
    const missing = catalog.filter(agent => !agent.installed).map(agent => agent.name);
    if (!installed.length) return `${head}<p class="dcr-adv-msg">No agent CLIs found on this computer. Install ${escape(names(missing))} to add an adversary.</p>`;
    const on = slug => adversaries.find(entry => entry.agent === slug);
    // Rows keep their place when switched, so nothing moves under the pointer; the line below says the order.
    const rows = installed.map(agent => {
      const saved = on(agent.slug);
      const self = agent.slug === author;
      // The agent running the review keeps "no model" until the reviewer picks one: it is what skips it.
      const entry = saved && (self && !saved.model ? saved : settle(agent, saved));
      const status = agentStatus(agent, now);
      const effort = entry ? effortOptionsHTML(agent, entry.model, entry.effort) : '';
      const note = self ? (entry && !entry.model ? '<p class="dcr-adv-note is-warn">Runs this review, so it is skipped until you pick a model.</p>' : '<p class="dcr-adv-note">Runs this review: it checks itself only on a model you pick.</p>') : '';
      const tune = entry ? `<div class="dcr-adv-tune"><select class="select select-xs" data-dcr-adv-model aria-label="${escape(agent.name)} model">${modelOptionsHTML(agent, entry.model)}</select>${effort ? `<select class="select select-xs" data-dcr-adv-effort aria-label="${escape(agent.name)} effort">${effort}</select>` : ''}</div>` : '';
      return `<li class="dcr-adv-row${entry ? ' is-on' : ''}" data-agent="${escape(agent.slug)}"><label class="dcr-adv-line">${avatarHTML(agent.slug, 'dcr-face-sm')}<span class="dcr-adv-who"><strong>${escape(agent.name)}</strong><span class="dcr-adv-status is-${status.tone}" title="${escape(status.hint)}">${escape(status.text)}</span></span><input type="checkbox" class="toggle toggle-sm" data-dcr-adv-switch${entry ? ' checked' : ''} aria-label="Use ${escape(agent.name)} as an adversary"></label>${tune}${note}</li>`;
    }).join('');
    const who = author ? agentInfo(author).name : 'your agent';
    const order = active.length ? `${agentInfo(active[0].agent).name} answers in each comment's conversation${active.length > 1 ? `; ${names(active.slice(1).map(entry => agentInfo(entry.agent).name))} weigh${active.length > 2 ? '' : 's'} in beside it` : ''}. On your own questions, tick ${facesHTML(active.map(entry => entry.agent), 3)} to ask them too.` : `Other agents on this computer can check ${escape(who)}'s comments. They spend your own accounts, so none is on until you choose.`;
    return `${head}<ul class="dcr-adv-list">${rows}</ul><p class="dcr-adv-foot">${order}</p>${missing.length ? `<p class="dcr-adv-missing">Not found here: ${escape(names(missing))}.</p>` : ''}`;
  }

  function summary(comments, threads, resolved = []) {
    const waiting = Object.values(threads).filter(thread => thread.delivery === 'sent').length;
    const answered = Object.values(threads).filter(thread => thread.delivery === 'answered').length;
    return {drafts: drafts(comments, threads, resolved).length, waiting, answered};
  }

  return {escape, progressKey, allComments, sendText, drafts, statusText, statusModel, actionLabel, markdown, snippet, relativeTime, messagesHTML, unseen, agentModel, summary,
    agentInfo, avatarHTML, verdictHTML, verdicts, tally, tallyText, consensus, opinionsHTML, names, VERDICTS,
    activeAdversaries, facesHTML, agentStatus, modelOptionsHTML, effortLevels, effortOptionsHTML, chosenModel, chosenEffort, settle, adversaryPanelHTML};
})();
