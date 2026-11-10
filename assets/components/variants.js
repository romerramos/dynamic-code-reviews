/* Variants: the few choices a theme makes that are not a value but a way of drawing, declared as
   tokens in its theme block (see base.css) and mirrored here onto <html> as data attributes the
   components' CSS keys on. A theme never names a component; a component never names a theme.

     --avatar-style: brand | mono     an agent's face in its company colours, or its plain mark in ink

   Runs once the styles are in (the page calls it right after them, so nothing is drawn in the
   wrong style first) and again whenever the theme or the mode changes. */
'use strict';
(root => {
  const UI = root.UI;
  if (UI.VARIANTS) return; // the page's script runs it again; once is enough
  UI.VARIANTS = {'avatar-style': ['brand', 'mono']};
  UI.syncVariants = () => {
    const html = root.document?.documentElement;
    if (!html) return;
    const style = getComputedStyle(html);
    Object.entries(UI.VARIANTS).forEach(([name, allowed]) => {
      const value = style.getPropertyValue(`--${name}`).trim();
      const key = name.replace(/-(\w)/g, (all, letter) => letter.toUpperCase());
      const chosen = allowed.includes(value) ? value : allowed[0];
      if (html.dataset[key] !== chosen) html.dataset[key] = chosen;
    });
  };
  if (root.document?.documentElement && root.MutationObserver) {
    UI.syncVariants();
    new MutationObserver(UI.syncVariants).observe(root.document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-mode']});
  }
})(globalThis);
