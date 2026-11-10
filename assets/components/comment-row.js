/* CommentRow: a comment as one line, the same line whether the comment is open or closed, so
   opening it moves nothing: its face, its title with the way to its code right after the last
   word, its kind (Tag) or its place, and a chevron. It is the <summary> of its CommentCard; the
   theme says which of the kind and the place it shows (--comment-tags, --comment-place).

     UI.CommentRow({id, subject, title, face, go, tags, place, state})
     title: the title's HTML. face: an Avatar. go: {path, range} for the way to the code, or null.
     tags: Tags. place: where it is in a few characters (file:line). state: a word for the place
     (yours, resolved, revision 2), said before it where the theme shows the place. */
'use strict';
(root => {
  const UI = root.UI;
  UI.CommentRow = ({id, subject, title, face, go = null, tags = '', place = '', state = ''} = {}) => {
    const way = go ? `<button type="button" class="thread-go"${UI.attrs({'data-comment': id, title: `${go.path} · ${go.range}`, 'aria-label': `Show in the code: ${go.path}, ${go.range}`})}>${UI.icon('arrow-up-right')}</button>` : '';
    return `<summary class="thread-summary ui-comment-line"${UI.attrs({'data-ui': 'CommentRow', 'aria-label': `Comment: ${subject}`})}>`
      + `<span class="ui-comment-face">${face}</span>`
      + `<strong class="ui-comment-title"${UI.attrs({title: subject})}>${title}${way ? ` ${way}` : ''}</strong>`
      + `<span class="ui-comment-tags">${tags}</span>`
      + `<span class="ui-comment-place"${UI.attrs({'data-state': state || null, 'data-go': go ? '' : null})}>${place}</span>`
      + `<span class="ui-comment-chevron thread-chevron">${UI.icon('chevron-down')}</span></summary>`;
  };
})(globalThis);
