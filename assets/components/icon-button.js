/* IconButton: an action shown as its icon alone, named for screen readers and in its tooltip. */
'use strict';
(root => {
  const UI = root.UI;
  UI.IconButton = ({icon, label, className = '', attrs = {}, html = null} = {}) =>
    `<button type="button" class="icon-button${className ? ` ${className}` : ''}"${UI.attrs({'data-ui': 'IconButton', 'aria-label': label, title: label, ...attrs})}>${html ?? UI.icon(icon)}</button>`;
})(globalThis);
