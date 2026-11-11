/* Avatar: who said something, as a round face. An agent's is its mark (AgentMark) on a face in its
   brand colours, or in plain ink, as the theme's --avatar-style says; a person's is their photo,
   round and alone, else their initial; the reader's own is theirs (their GitHub face, else Y).

     UI.Avatar({agent: 'claude'})            an agent (null: an agent that gave no name)
     UI.Avatar({person: {login, avatar}})    someone on GitHub
     UI.Avatar({you: me})                    the reader; me is {login, avatar} or null
     size: xs 16, sm 20, md 28 (default), lg 32, xl 36; a context may set --avatar-size instead.
     mark: another mark on an agent's face (the page's own notices). className: a hook for its
     context; title: its tooltip (each kind has one by default). */
'use strict';
(root => {
  const UI = root.UI;
  UI.Avatar = ({agent, person, you, mark = null, size = 'md', className = '', title} = {}) => {
    const kind = you !== undefined ? 'you' : person ? 'person' : 'agent';
    const face = kind === 'you' ? you : person;
    let inner, label;
    if (kind === 'agent') {
      const info = UI.agentInfo(agent);
      inner = mark ?? UI.AgentMark(agent);
      label = info.company ? `${info.name} · ${info.company}` : info.name;
    } else {
      const login = face?.login || (kind === 'you' ? '' : 'someone');
      inner = UI.FACE.test(face?.avatar || '') ? `<img src="${face.avatar}" alt="">` : `<b>${UI.escape(kind === 'you' ? 'Y' : login.charAt(0).toUpperCase() || '?')}</b>`;
      label = kind === 'you' ? (login ? `@${login}` : 'You') : `@${login} on GitHub`;
    }
    const photo = inner.startsWith('<img');
    return `<span class="ui-avatar${className ? ` ${className}` : ''}"${UI.attrs({'data-ui': 'Avatar', 'data-kind': kind, 'data-agent': kind === 'agent' ? agent || '' : null, 'data-size': size, 'data-photo': photo || null, title: title ?? label, 'aria-hidden': 'true'})}>${inner}</span>`;
  };
  // Overlapping faces, one per agent; past max the rest is a count.
  UI.AvatarStack = (slugs, {max = 4, size = 'xs'} = {}) => {
    const shown = slugs.slice(0, slugs.length > max ? max - 1 : max);
    const rest = slugs.length - shown.length;
    return `<span class="ui-avatar-stack" data-ui="AvatarStack">${shown.map(slug => UI.Avatar({agent: slug, size})).join('')}${rest ? `<b class="ui-avatar-more">+${rest}</b>` : ''}</span>`;
  };
})(globalThis);
