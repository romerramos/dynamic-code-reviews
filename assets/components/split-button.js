/* SplitButton: one control for everything that goes to the agent: its first action, and a menu
   with the rest that hangs from the arrow beside it. The served page fills both halves (live.js)
   as the comment's state changes; this is their frame.

     UI.SplitButton({id, size: 'sm'}) */
'use strict';
(root => {
  const UI = root.UI;
  UI.SplitButton = ({id, size = 'sm'} = {}) =>
    `<span class="dcr-split"${UI.attrs({'data-ui': 'SplitButton', 'data-dcr-split': id})}><span class="dcr-split-main"></span><details class="more-menu dcr-split-menu" data-menu-from="parent"><summary class="btn btn-${size} btn-ghost dcr-split-more" aria-label="More for your agent" title="More for your agent"></summary><div class="more-list"></div></details>${UI.Button({label: 'Cancel', variant: 'ghost', size, className: 'dcr-split-cancel', attrs: {'data-dcr-cancel': true, hidden: true}})}</span>`;
})(globalThis);
