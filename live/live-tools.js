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

  const STATUS = {draft: '', sent: 'Sent, waiting for your agent', delivered: 'Your agent has this', answered: 'Your agent replied'};
  const statusText = thread => (thread && STATUS[thread.delivery]) || '';
  const actionLabel = thread => thread?.live ? 'Reply' : 'Send to agent';

  function messagesHTML(thread) {
    const messages = thread?.messages || [];
    if (!messages.length) return '';
    return messages.map(message => `<div class="dcr-message dcr-${message.author === 'agent' ? 'agent' : 'user'}"><span class="dcr-author">${message.author === 'agent' ? 'Agent' : 'You'}</span><p>${escape(message.body)}</p></div>`).join('');
  }

  function summary(comments, threads, resolved = []) {
    const waiting = Object.values(threads).filter(thread => thread.delivery === 'sent').length;
    const answered = Object.values(threads).filter(thread => thread.delivery === 'answered').length;
    return {drafts: drafts(comments, threads, resolved).length, waiting, answered};
  }

  return {escape, progressKey, allComments, sendText, drafts, statusText, actionLabel, messagesHTML, summary};
})();
