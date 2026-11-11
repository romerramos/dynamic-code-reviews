/* Button: an action with words, and its icon when it has one. daisyUI's .btn draws it; the theme's
   tokens (--btn-*) give it its look: solid, quiet words, or a label between brackets.

     UI.Button({label: 'Resolve', icon: 'check', variant: 'soft', size: 'sm', attrs: {'data-resolve': id}})
     variant: soft (default), ghost, primary; size: xs, sm (default), md. html: markup in place of label. */
'use strict';
(root => {
  const UI = root.UI;
  UI.Button = ({label = '', html = null, icon = null, variant = 'soft', size = 'sm', className = '', attrs = {}, tag = 'button'} = {}) => {
    const classes = ['btn', size && size !== 'md' ? `btn-${size}` : '', variant ? `btn-${variant}` : '', className].filter(Boolean).join(' ');
    const type = tag === 'button' ? {type: 'button'} : {};
    return `<${tag} class="${classes}"${UI.attrs({...type, 'data-ui': 'Button', ...attrs})}>${icon ? UI.icon(icon) : ''}${html ?? UI.escape(label)}</${tag}>`;
  };
})(globalThis);
