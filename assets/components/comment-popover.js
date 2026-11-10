/* CommentPopover: a comment opened beside its lines in the code: where it is (path:lines), its kind
   and weight, then the same line as on the Overview (face, title, place), a quiet line about it,
   its words, and its actions. Yours and the agent's are the same popover; the served page adds
   the conversation before the actions.

     UI.CommentPopover({id, own, where, tags, face, title, place, meta, body, evidence, footer}) */
'use strict';
(root => {
  const UI = root.UI;
  UI.CommentPopover = ({id, own = false, where = '', tags = '', face, title, place = '', meta = '', body = '', evidence = '', footer = ''} = {}) =>
    `<section class="popover-comment ui-popover-comment${own ? ' is-own' : ''}"${UI.attrs({'data-ui': 'CommentPopover', 'data-comment-id': id})}>`
    + `<p class="comment-location">${where}</p><div class="thread-badges">${tags}</div>`
    + `<div class="popover-title"><span class="ui-comment-face">${face}</span><h4>${title}</h4><span class="thread-at">${place}</span></div>`
    + `${meta}${body}${evidence}<div class="thread-footer">${footer}</div></section>`;
})(globalThis);
