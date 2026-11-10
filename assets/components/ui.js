/* The page's components. Each file under assets/components defines one, as a plain function that
   returns HTML, on the shared UI namespace; its CSS is the file of the same name. A component is
   the one place its markup is written: every view that shows one calls it. This file holds what
   they share. Loaded before the page's own scripts, and by Node for the tests. */
'use strict';
(root => {
  const UI = root.UI = root.UI || {};
  UI.escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  // Attributes from an object: false, null and undefined leave one out, true writes it bare.
  UI.attrs = (attrs = {}) => Object.entries(attrs).filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${UI.escape(value)}"`).join('');
  // A Lucide icon from the page's set, sized by its context.
  UI.icon = name => (root.ReviewIcons?.[name] || '').replace('class="lucide', 'class="review-icon lucide').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  // A data: image the page may show as someone's face.
  UI.FACE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  if (typeof module === 'object' && module.exports) module.exports = UI;
})(globalThis);
