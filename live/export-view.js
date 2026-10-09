'use strict';
// Read-only conversation view for an exported review. It shows the agent's replies and your
// messages under their comments; sending and replying need the live server.
(() => {
  const data = window.__DCR_EXPORT;
  const content = document.getElementById('content');
  if (!data || !content || !globalThis.LiveTools) return;
  // Copy for LLMs carries the replies here too; `dcr comments` reads the saved series, no server needed.
  let series;
  try { series = JSON.parse(document.getElementById('data').textContent).review.history?.series; } catch { /* no command line then */ }
  globalThis.ReviewTools?.setConversationSource(id => data.threads[id]?.messages?.length ? {messages: data.threads[id].messages, series} : null);
  const tools = globalThis.LiveTools;
  const open = new Map(); // comment id -> the agents whose opinions are open
  const decorate = () => {
    content.querySelectorAll('article.review-thread[data-thread-id]').forEach(card => {
      const id = card.dataset.threadId;
      const thread = data.threads[id];
      const all = new Set(Object.values(thread?.opinions || {}).map(opinion => opinion.id)); // nothing is new in a copy
      const messages = tools.messagesHTML(thread, {seen: new Set((thread?.messages || []).map(message => message.id))});
      const opinions = tools.opinionsHTML(thread, {open: [...(open.get(id) || [])], seen: all});
      const html = messages || opinions ? `<div class="dcr-convo">${messages}</div>${opinions}` : '';
      let block = card.querySelector(':scope > .dcr-thread');
      if (!html) { block?.remove(); return; }
      if (!block) {
        block = document.createElement('div');
        block.className = 'dcr-thread dcr-readonly';
        const footer = card.querySelector(':scope > .thread-footer');
        footer ? footer.before(block) : card.append(block);
      }
      if (block.dataset.html !== html) { block.innerHTML = html; block.dataset.html = html; } // not innerHTML: the DOM re-serialises quotes
    });
  };
  // Previews your agent built are part of the review; without a server they are only shown.
  if (data.previews?.length && window.ReviewPreviews) window.ReviewPreviews.set({enabled: false, ready: data.previews});
  content.addEventListener('click', event => {
    const chip = event.target.closest('[data-dcr-opinion]');
    if (!chip) return;
    const id = chip.closest('article.review-thread').dataset.threadId;
    const agents = open.get(id) || new Set();
    agents.has(chip.dataset.dcrOpinion) ? agents.delete(chip.dataset.dcrOpinion) : agents.add(chip.dataset.dcrOpinion);
    open.set(id, agents);
    decorate();
  });
  new MutationObserver(decorate).observe(content, {childList: true, subtree: true});
  decorate();
})();
