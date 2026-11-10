/* Tag: what kind of comment it is (Conventional Comments), in the kind's own colour, with its icon
   for a theme that shows one. The theme decides its shape (--tag-*), never what it says.

     UI.Tag('question')                      a kind; an unknown one reads as a note
     UI.Tag(null, {agent: true})             the reader's question for their agent */
'use strict';
(root => {
  const UI = root.UI;
  // kind: [icon, title, hint, tone]
  UI.COMMENT_TYPES = {
    note: ['info', 'Note', 'Context worth knowing', 'blue'],
    praise: ['thumbs-up', 'Praise', 'What works well', 'green'],
    question: ['circle-help', 'Question', 'An answer would help', 'purple'],
    thought: ['lightbulb', 'Thought', 'An idea to consider', 'amber'],
    issue: ['circle-alert', 'Issue', 'A problem to address', 'red'],
    suggestion: ['message-circle', 'Suggestion', 'A proposed improvement', 'teal'],
    todo: ['list-todo', 'Todo', 'A follow-up task', 'amber'],
    chore: ['wrench', 'Chore', 'Routine maintenance', 'blue'],
    nitpick: ['scan-text', 'Nitpick', 'A small preference', 'slate'],
    typo: ['spell-check', 'Typo', 'A spelling correction', 'slate'],
    polish: ['sparkles', 'Polish', 'A finishing touch', 'teal'],
    quibble: ['message-circle', 'Quibble', 'A minor concern', 'slate']
  };
  const AGENT = ['sparkles', 'For your agent', 'A question for your agent. It stays in this review until you send its conversation to GitHub.', 'purple'];
  UI.Tag = (kind, {agent = false} = {}) => {
    const [symbol, title, hint, tone] = agent ? AGENT : UI.COMMENT_TYPES[kind] || UI.COMMENT_TYPES.note;
    return `<span class="ui-tag type-${tone}"${UI.attrs({'data-ui': 'Tag', 'data-kind': agent ? 'agent' : kind || 'note', title: hint})}><span class="ui-tag-icon">${UI.icon(symbol)}</span>${title}</span>`;
  };
})(globalThis);
