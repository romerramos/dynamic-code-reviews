/* AgentMark: an agent's logo, its first letter when it has none, or a spark for an unnamed agent.
   Only the mark: Avatar puts it on its round face and decides its colours (the theme's
   --avatar-style). Also the one list of the agents the page knows by name. */
'use strict';
(root => {
  const UI = root.UI;
  UI.AGENTS = {
    claude: {name: 'Claude', company: 'Anthropic'},
    codex: {name: 'Codex', company: 'OpenAI'},
    gemini: {name: 'Gemini', company: 'Google'},
    grok: {name: 'Grok', company: 'xAI'},
    antigravity: {name: 'Antigravity', company: 'Google'},
    cursor: {name: 'Cursor', company: 'Cursor'},
    opencode: {name: 'opencode', company: 'opencode'}
  };
  // {slug, name, company, mark}: a slug the page does not know is named by its own first letter.
  UI.agentInfo = slug => {
    const known = slug && UI.AGENTS[slug];
    const name = known ? known.name : slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Agent';
    return {slug: slug || '', name, company: known?.company || '', mark: slug ? root.ReviewBrands?.[slug] || '' : ''};
  };
  const SPARK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
  UI.AgentMark = slug => {
    const agent = UI.agentInfo(slug);
    return agent.mark || (slug ? `<b>${UI.escape(agent.name.charAt(0))}</b>` : SPARK);
  };
})(globalThis);
