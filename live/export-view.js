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
  const decorate = () => {
    content.querySelectorAll('article.review-thread[data-thread-id]').forEach(card => {
      const id = card.dataset.threadId;
      const html = globalThis.LiveTools.messagesHTML(data.threads[id]);
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
  new MutationObserver(decorate).observe(content, {childList: true, subtree: true});
  decorate();
})();
