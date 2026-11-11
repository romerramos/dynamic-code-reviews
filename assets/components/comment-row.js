/* CommentRow: a comment as one line, the same line whether the comment is open or closed, so
   opening it moves nothing: its face, its title with the way to its code right after the last
   word, its kind (Tag) or its place, and a chevron. It is the <summary> of its CommentCard; the
   theme says which of the kind and the place it shows (--comment-tags, --comment-place).

     UI.CommentRow({id, subject, title, face, go, tags, place, state, priority})
     title: the title's HTML. priority: the finding's P0–P3, said first in the title, in every theme. face: an Avatar. go: {path, range} for the way to the code, or null.
     tags: Tags. place: where it is in a few characters (file:line). state: a word for the place
     (yours, resolved, revision 2), said before it where the theme shows the place. */
'use strict';
(root => {
  const UI = root.UI;
  // The way to the code stays with the title's last word, so a wrapped title never leaves it alone
  // on a line of its own. (The last space that is not inside a tag splits the title.)
  const withTail = (title, way) => {
    let open = 0, cut = -1;
    for (let at = 0; at < title.length; at++) {
      if (title[at] === '<') { open += title[at + 1] === '/' ? -1 : 1; at = title.indexOf('>', at); if (at < 0) break; }
      else if (title[at] === ' ' && open === 0) cut = at;
    }
    return `${title.slice(0, cut + 1)}<span class="ui-comment-tail">${title.slice(cut + 1)}${way}</span>`;
  };
  UI.CommentRow = ({id, subject, title, face, go = null, tags = '', place = '', state = '', priority = ''} = {}) => {
    const way = go ? `<button type="button" class="thread-go"${UI.attrs({'data-comment': id, title: `${go.path} · ${go.range}`, 'aria-label': `Show in the code: ${go.path}, ${go.range}`})}>${UI.icon('arrow-up-right')}</button>` : '';
    return `<summary class="thread-summary ui-comment-line"${UI.attrs({'data-ui': 'CommentRow', 'aria-label': `Comment: ${subject}`})}>`
      + `<span class="ui-comment-face">${face}</span>`
      + `<strong class="ui-comment-title"${UI.attrs({title: subject})}>${priority ? `<span class="ui-comment-priority"${UI.attrs({'data-priority': priority, title: `Priority ${priority}`})}>${UI.escape(priority)}</span>` : ''}${way ? withTail(title, way) : title}</strong>`
      + `<span class="ui-comment-tags">${tags}</span>`
      + `<span class="ui-comment-place"${UI.attrs({'data-state': state || null, 'data-go': go ? '' : null})}>${place}</span>`
      + `<span class="ui-comment-chevron thread-chevron">${UI.icon('chevron-down')}</span></summary>`;
  };
})(globalThis);
