/* ThreadMessage: one message in a comment's conversation: the face of who said it, a line with
   their name and what goes with it (model, verdict, when, New), then the words. The comment a
   conversation starts from is its first message (origin), drawn the same way.

     UI.ThreadMessage({id, from, face, who, head, body, more, origin, classes})
     from: agent, you or person. face: an Avatar. who: the name's HTML. head: what follows it.
     body: the words' HTML, already rendered. more: a Show more button under clamped words. */
'use strict';
(root => {
  const UI = root.UI;
  UI.ThreadMessage = ({id = null, from = 'agent', face, who, head = '', body = '', clamped = false, more = false, origin = false, classes = ''} = {}) => {
    const kind = from === 'you' ? 'dcr-you' : 'dcr-agent';
    const cls = ['dcr-msg', 'ui-message', origin && 'dcr-origin', kind, classes].filter(Boolean).join(' ');
    const words = body ? `<div class="dcr-body${clamped ? ' is-clamped' : ''}">${body}</div>${more ? '<button type="button" class="dcr-more">Show more</button>' : ''}` : '';
    return `<article class="${cls}"${UI.attrs({'data-ui': 'ThreadMessage', 'data-from': from, 'data-msg': id})}>${face}<div class="dcr-msg-main"><header class="dcr-msg-head"><strong>${who}</strong>${head}</header>${words}</div></article>`;
  };
})(globalThis);
