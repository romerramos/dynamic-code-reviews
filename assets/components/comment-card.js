/* CommentCard: a comment on the Overview. Closed it is its CommentRow; open, the same row heads a
   card with the comment's words, the way to its code (View in file), its conversation (the served
   page adds it before the footer) and its footer of actions, all on the title's column. Yours and
   the agent's are the same card. The theme says whether an open comment is a card or a row set
   apart by rules (--comment-card-*), never how it is built.

     UI.CommentCard({id, open, resolved, earlier, own, row, meta, body, source, footer})
     row: the CommentRow's options. meta: one quiet line about it. body: its words and what came
     with them. source: the button to its code. footer: its actions. */
'use strict';
(root => {
  const UI = root.UI;
  UI.CommentCard = ({id, open = false, resolved = false, earlier = false, own = false, row, meta = '', body = '', source = '', footer = ''} = {}) => {
    const classes = ['review-thread', 'ui-comment', resolved && 'is-resolved', earlier && 'is-earlier', own && 'is-own'].filter(Boolean).join(' ');
    return `<article class="${classes}"${UI.attrs({'data-ui': 'CommentCard', 'data-thread-id': id})}>`
      + `<details class="thread-details"${UI.attrs({'data-thread-fold': id, open})}>${UI.CommentRow({id, ...row})}`
      + `<div class="thread-body ui-comment-body">${meta}${body}</div>${source}</details>`
      + `<div class="thread-footer ui-comment-footer">${footer}</div></article>`;
  };
})(globalThis);
