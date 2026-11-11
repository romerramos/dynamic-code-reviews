/* PresenceDot: whether the agent is there, as a chat app says it: a small dot, green when it is
   listening (ok), amber while it works (work), a hollow ring when nobody is (off). */
'use strict';
(root => {
  const UI = root.UI;
  UI.PresenceDot = (tone = 'off', className = '') => `<span class="ui-presence-dot${className ? ` ${className}` : ''}"${UI.attrs({'data-ui': 'PresenceDot', 'data-tone': tone, 'aria-hidden': 'true'})}></span>`;
})(globalThis);
