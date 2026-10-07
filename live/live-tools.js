/* Pure helpers for the served review's conversation layer. Loaded only by `dcr serve`. */
'use strict';
globalThis.LiveTools = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const PERSONAL = /^mine-/;
  const progressKey = (snapshot, review) => `dynamic-review:${snapshot.fingerprint}${review.history ? `:${review.history.series}:${review.history.revision}` : ''}`;

  // Every comment the reader can send: the agent's findings and the reader's own.
  function allComments(review, saved = {}) {
    const generated = globalThis.ReviewTools.overviewFeedback(review).comments.map(comment => ({...comment, personal: false}));
    const personal = (Array.isArray(saved.personalComments) ? saved.personalComments : []).filter(comment => PERSONAL.test(comment.id)).map(comment => ({...comment, personal: true}));
    return [...generated, ...personal];
  }

  // The text the agent receives for a first send: the same captured code and comment as
  // "Copy for LLMs", plus anything the reader wrote while composing.
  function sendText(snapshot, review, comment, note = '') {
    const text = globalThis.ReviewTools.commentText(snapshot, {...comment, resolved: false}, review.qa);
    return note.trim() ? `${text}\n\nReviewer's message:\n${note.trim()}` : text;
  }

  // Comments the reader wrote and has not sent. Resolved ones are skipped; findings are
  // the agent's own and are never "drafts".
  function drafts(comments, threads, resolved = []) {
    return comments.filter(comment => comment.personal && !resolved.includes(comment.id) && !threads[comment.id]?.live && threads[comment.id]?.delivery !== 'sent');
  }

  const actionLabel = thread => thread?.live ? 'Reply' : 'Send to agent';

  // --- reading an agent's answer -----------------------------------------------------------------
  // A small, safe subset of Markdown: paragraphs, lists, fenced code, `code`, **bold**, *italic*
  // and https links. Everything is escaped first, so nothing a message contains can become markup.
  const inline = text => {
    const parts = String(text).split(/(`[^`\n]+`)/);
    return parts.map(part => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
        .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, (match, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    }).join('');
  };
  function markdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      } else if (/^\s*[-*] +\S/.test(line) || /^\s*\d+[.)] +\S/.test(line)) {
        const ordered = /^\s*\d+[.)] /.test(line);
        const marker = ordered ? /^\s*\d+[.)] +/ : /^\s*[-*] +/;
        const items = [];
        while (i < lines.length && marker.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(marker, ''))}</li>`);
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      } else if (!line.trim()) {
        i++;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*[-*] +\S/.test(lines[i]) && !/^\s*\d+[.)] +\S/.test(lines[i])) para.push(inline(lines[i++]));
        out.push(`<p>${para.join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

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
  function statusModel(thread, listening, now = Date.now()) {
    if (!thread) return null;
    const last = [...(thread.messages || [])].reverse().find(message => message.author === 'agent');
    if (thread.delivery === 'sent') {
      return listening === false
        ? {tone: 'idle', text: 'Sent. No agent is listening yet; it will answer when your agent picks it up.'}
        : {tone: 'wait', text: 'Sent. Your agent will pick it up in a moment.'};
    }
    if (stale(thread, now)) return {tone: 'idle', text: `Your agent received this ${relativeTime(thread.delivered_at, now)} and has not answered. It may have been interrupted; reply to nudge it.`};
    if (thread.delivery === 'delivered') return {tone: 'work', text: 'Your agent is working on an answer', typing: true};
    if (thread.delivery === 'answered') return {tone: 'done', text: 'Your agent replied', at: last?.at};
    return null;
  }
  const statusText = (thread, listening) => statusModel(thread, listening)?.text || '';

  // The conversation under a comment: a plain thread, no boxes. Messages the reader has not
  // seen yet carry a New marker. The last long message starts clamped.
  function messagesHTML(thread, {seen = new Set(), now = Date.now()} = {}) {
    const messages = thread?.messages || [];
    if (!messages.length) return '';
    return messages.map(message => {
      const agent = message.author === 'agent';
      const fresh = agent && !seen.has(message.id);
      const avatar = agent ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>' : 'You'.slice(0, 1);
      return `<article class="dcr-msg ${agent ? 'dcr-agent' : 'dcr-you'}" data-msg="${escape(message.id)}"><span class="dcr-avatar" aria-hidden="true">${avatar}</span><div class="dcr-msg-main"><header class="dcr-msg-head"><strong>${agent ? 'Agent' : 'You'}</strong><time datetime="${escape(message.at || '')}" data-at="${escape(message.at || '')}">${escape(relativeTime(message.at, now))}</time>${fresh ? '<span class="dcr-new">New</span>' : ''}</header><div class="dcr-body">${markdown(message.body)}</div></div></article>`;
    }).join('');
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
  function agentModel(threads, listening, now = Date.now(), previews = {}) {
    if (listening === undefined) return null;
    const building = Object.values(previews || {}).some(preview => preview.status === 'working');
    const working = building || Object.values(threads || {}).some(thread => thread.delivery === 'delivered' && !stale(thread, now));
    if (working) return {tone: 'work', text: 'Agent working', hint: 'Your agent received a message and is preparing an answer.'};
    if (listening) return {tone: 'ok', text: 'Agent listening', hint: 'Your agent is waiting for your next message.'};
    return {tone: 'off', text: 'No agent connected', hint: 'Nothing is listening yet. Ask your agent to continue this review so it can answer here.'};
  }

  function summary(comments, threads, resolved = []) {
    const waiting = Object.values(threads).filter(thread => thread.delivery === 'sent').length;
    const answered = Object.values(threads).filter(thread => thread.delivery === 'answered').length;
    return {drafts: drafts(comments, threads, resolved).length, waiting, answered};
  }

  return {escape, progressKey, allComments, sendText, drafts, statusText, statusModel, actionLabel, markdown, snippet, relativeTime, messagesHTML, unseen, agentModel, summary};
})();
