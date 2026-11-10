/* LedgerRow: a comment in Your review, the agent's and yours alike: its place in the code (a link),
   then the comment as a chat message (face, who and when, its short title, the way to its code),
   then what is left to do with it. The served page adds who answered under it.

     UI.LedgerRow({id, place, face, by, subject, subjectTitle, go, meta, data})
     place, by: their HTML (ReviewTools.ledgerPlace, ledgerBy). face: an Avatar. subject: the title's
     HTML. go: {path, where} for the way to the code, or null. data: the row's data-* attributes. */
'use strict';
(root => {
  const UI = root.UI;
  UI.LedgerRow = ({id, place = '', face, by = '', subject, subjectTitle = null, go = null, meta = '', data = {}} = {}) => {
    const way = go ? `<button type="button" class="ledger-at"${UI.attrs({'data-ledger-jump': id, title: `${go.path} · ${go.where}`, 'aria-label': `Show in the code: ${go.path}, ${go.where}`})}>${UI.icon('arrow-up-right')}</button>` : '';
    const attributes = Object.fromEntries(Object.entries(data).map(([name, value]) => [`data-${name}`, value]));
    return `<li class="ledger-item ui-ledger-row"${UI.attrs({'data-ui': 'LedgerRow', 'data-ledger': id, ...attributes})}>${place}<div class="ledger-msg">${face}${by}<span class="ledger-subject"${UI.attrs({title: subjectTitle})}>${subject}</span>${way}</div><div class="ledger-meta">${meta}</div></li>`;
  };
})(globalThis);
