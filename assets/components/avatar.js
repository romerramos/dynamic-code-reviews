/* Avatar: who said something, as a round face. An agent's is its mark (AgentMark) on a face in its
   brand colours, or in plain ink, as the theme's --avatar-style says; a person's is their photo,
   round and alone, else their initial; the reader's own is theirs (their GitHub face, else Y).

     UI.Avatar({agent: 'claude'})            an agent (null: an agent that gave no name)
     UI.Avatar({person: {login, avatar}})    someone on GitHub
     UI.Avatar({you: me})                    the reader; me is {login, avatar} or null
     size: xs 16, sm 20, md 28 (default), lg 32, xl 36; a context may set --avatar-size instead.
     mark: another mark on an agent's face (the page's own notices). className: a hook for its
     context; title: its tooltip (each kind has one by default). model, effort: what an agent ran
     on; its face then says so in a tip (Claude · Fable 5.2 · max) on hover, or on a tap. */
'use strict';
(root => {
  const UI = root.UI;
  UI.Avatar = ({agent, person, you, mark = null, size = 'md', className = '', title, model = null, effort = null} = {}) => {
    const kind = you !== undefined ? 'you' : person ? 'person' : 'agent';
    const face = kind === 'you' ? you : person;
    let inner, label, tip = null;
    if (kind === 'agent') {
      const info = UI.agentInfo(agent);
      inner = mark ?? UI.AgentMark(agent);
      label = info.company ? `${info.name} · ${info.company}` : info.name;
      const ran = model ? root.ReviewTools?.modelText(model, effort) : '';
      if (ran) { tip = `${info.name} · ${ran}`; label = tip; }
    } else {
      const login = face?.login || (kind === 'you' ? '' : 'someone');
      inner = UI.FACE.test(face?.avatar || '') ? `<img src="${face.avatar}" alt="">` : `<b>${UI.escape(kind === 'you' ? 'Y' : login.charAt(0).toUpperCase() || '?')}</b>`;
      label = kind === 'you' ? (login ? `@${login}` : 'You') : `@${login} on GitHub`;
    }
    const photo = inner.startsWith('<img');
    return `<span class="ui-avatar${className ? ` ${className}` : ''}"${UI.attrs({'data-ui': 'Avatar', 'data-kind': kind, 'data-agent': kind === 'agent' ? agent || '' : null, 'data-size': size, 'data-photo': photo || null, 'data-tip': tip, title: tip ? null : title ?? label, 'aria-hidden': 'true'})}>${inner}</span>`;
  };
  // Where nothing hovers (a phone), a tap on a face with a tip opens it, and does only that (a face in a
  // comment's summary does not also open the comment); the next tap anywhere closes it.
  if (root.document && root.matchMedia) root.document.addEventListener('click', event => {
    if (!root.matchMedia('(hover: none)').matches) return;
    const face = event.target.closest?.('.ui-avatar[data-tip]');
    const open = root.document.querySelector('.ui-avatar.is-tip-open');
    if (open && open !== face) open.classList.remove('is-tip-open');
    if (!face) return;
    event.preventDefault(); event.stopPropagation();
    face.classList.toggle('is-tip-open');
  }, true);
  // Overlapping faces, one per agent; past max the rest is a count.
  UI.AvatarStack = (slugs, {max = 4, size = 'xs'} = {}) => {
    const shown = slugs.slice(0, slugs.length > max ? max - 1 : max);
    const rest = slugs.length - shown.length;
    return `<span class="ui-avatar-stack" data-ui="AvatarStack">${shown.map(slug => UI.Avatar({agent: slug, size})).join('')}${rest ? `<b class="ui-avatar-more">+${rest}</b>` : ''}</span>`;
  };
})(globalThis);
