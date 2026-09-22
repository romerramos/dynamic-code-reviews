# UI maintenance guide

This is the established UI contract, not a request to redesign each report.
Normal review runs use `scripts/review.rb` and author only the review JSON.
Modify the assets only for an explicitly requested UI improvement or a verified
renderer defect. Keep changes in this personal skill and regenerate the report
from its original snapshot and analysis when refreshing presentation only.

## Layout and components

- Use bundled daisyUI precompiled CSS and native HTML buttons, details, dialogs,
  checkboxes and popovers. Keep the approved light neutral palette, restrained
  purple navigation accents and amber comment markers. Do not introduce another
  component library, runtime compiler, font download or runtime icon service.
- Use the bundled Lucide SVG subset for comment types, markers and thread actions.
  Keep icons at 16px (17px inside type tiles), with a consistent 1.8px stroke and
  currentColor. Decorative SVGs are aria-hidden and non-focusable; actions retain
  text or an accessible label. Do not replace them with Unicode approximations or
  hand-drawn symbols. Add any new icons from the pinned upstream CDN release to
  `assets/vendor/lucide/`; normal reviews never download assets.
- Reuse `assets/icon.svg` for the skill identity. The renderer embeds this same
  code-and-checkmark mark in the header; keep it crisp at 38px, without a second
  background tile. Do not substitute emoji or regenerate the logo per review.
- Desktop sidebar: 320px, increasing to 340px on wide screens. Each step occupies
  the available sidebar width and wraps its title. Keep viewed-file counts and comment
  counts subordinate to the title. A single-step group has one heading, not duplicate
  group and step labels. Only the active step expands its flat file/component list;
  search reveals matching steps, including matches on component names. Ordinary
  files retain actual filenames and a smaller directory subtitle (omit for root
  files). Wrap names and subtitles without ellipsis. Expose full paths in tooltips
  and accessible labels. Component rows use one name, one namespace line, compact
  per-file Ruby/Template shortcuts and a viewed count; do not nest another file list
  or repeat the same namespace as a directory. File links reveal containing test
  disclosures. Component links and their file shortcuts focus and scroll to the
  component header above its tabs; ordinary files focus their summary. Indicate the
  selected destination. Reserve purple selected/hover treatment for review steps;
  distinguish component cards with slate text, monospace names, a selected side
  marker and neutral file shortcuts. Inset the title's hover/focus surface inside
  the card so it cannot cover the outer border or selected side marker.
  Keep shortcut containers transparent in hover,
  pressed and focus-within states: daisyUI's menu styles otherwise treat a direct
  `li > div` as an action and can paint it dark when a child is pressed. Check both
  pointer-down and keyboard focus, not only the final selected state. Do not shrink
  step buttons into narrow pills.
- Code is the main surface. Split tables use two equal code columns, separate
  60px line-number gutters and one shared row per pair. Empty opposite cells have
  no invented source numbers. Additions and deletions retain their source-side
  numbering. Keep `.side-divider` distinct from daisyUI's `.divider` component.
- Preserve approximately 13px monospace text and 24px line height, syntax colors,
  visible addition/removal signs and subdued diff backgrounds. Long lines wrap;
  narrow screens can scroll the minimum-width split table horizontally. Never
  convert Before and After into vertically stacked panels while calling it split.
- Keep descriptions readable with bounded prose widths and short paragraphs.
  Detailed metadata belongs in Review details; file/context panels can collapse.
  Preserve Overview, All changes, search, J/K/Z, viewed state and local notes.
- Keep company-size/reviewer calibration out of visible and embedded report
  content. Overview starts with What changed: the exact review type/comparison and a short behavioral paragraph. Then show review comments with their QA evidence, optional collapsed successful checks, and User comments. Report-revision updates are separate from code changes. Keep the walkthrough in the sidebar, supporting metadata in Review details, and omit routine assessment boilerplate. Show each
  observation as an individual entry with its path, range, readable subject and
  full discussion. Other evidence sections use
  clear headings, 14px text, generous line spacing and roughly 80ch prose widths.
  Avoid a single container filled with tiny comment buttons or muted text walls.
- All changes displays actual full-file diffs under responsibility headings and
  filter buttons. Use `ReviewTools.category` plus explicit `file_categories`
  overrides from the review. Design/UI excludes behavior code even when the
  behavior affects the UI. Keep diff cards collapsible, initially expanded for unread files;
  do not reduce this view to links back to walkthrough steps.
- Series revisions also show a compact revision selector, a one-sentence revision update. Detailed updated/reused group labels and finding lifecycle states belong in Review details. Unanchored concerns needing rechecking must not receive a
  green clean-review verdict. Original snapshot HTML stays immutable.
  Refreshable revision browsing pages
  offer every known revision, including newer ones when viewing an older review.
  Keep Latest review and All revisions links visible, and distinguish the original
  saved snapshot from the refreshed browsing view. Notes and viewed marks belong
  to one revision.

## Overview comment threads

- Use a centered reading column bounded to 840px, with 16–17px prose, generous line spacing and 24–28px card padding. Stack the file/range header, subject, concise comment body and embedded evidence, View code action, and action footer. Show each issue once: matched findings add severity to their issue comment; unmatched findings remain visible. No masonry or parallel metadata columns. Keep long file paths wrapping.
- Highlight code through the same bundled Prism grammar and whole-hunk
  tokenization as the diff, preserving multiline tokens and exact old/new source
  numbers. View code opens the complete related hunk in the shared fullscreen
  viewer, with a scrollable, keyboard-focusable diff body.
- Give each Conventional Comments type an explicit name, distinct icon and
  accent plus a short meaning: Note is context, Praise is what works well,
  Question asks for an answer, Thought offers an idea. Never rely on color alone.
  Blocking is a separate solid red badge; Non-blocking has a quiet outlined badge.
- Resolve collapses the whole conversation into a compact subject/type summary;
  keep its file/range, local resolved status, Copy and Reopen visible. A collapsed
  thread can be expanded to read without reopening. Reopen restores the expanded
  thread. Keep keyboard focus and scroll position near the changed thread.
- Save resolution with browser-local snapshot/revision state and export it with
  notes. This is conversation progress, independent of findings, verification and
  saved review history. Never infer code correctness from a resolved conversation.
  Retain resolved personal comments in combined copies, marking their local state.
  Editing a personal comment reopens it; deleting one removes its resolution mark.

## Comment popovers

- Put an always-visible speech-bubble button in the gutter at `start`, on the
  comment's actual old/new side. Each button has a descriptive accessible label,
  visible focus state, `aria-expanded` and a link to the popover it controls.
- Use one native `popover="auto"` in the top layer. Default width is 390px,
  limited to viewport width minus 24px. Height is at most 440px or viewport
  height minus 24px, with internal scrolling for longer or grouped discussions.
  Size must remain bounded on a 3840px-wide screen.
- Place it about 8px beside/below the marker, flip above when necessary, and
  clamp to 12px viewport margins. Track scrolling/resizing; close it if its
  anchor leaves the code viewport. Avoid clipping by file-card overflow.
- Never add full-width annotation rows, stretch a note across both diff columns,
  or change code row heights when opening a note. Keep range-start/end markers;
  opening emphasizes exactly the inclusive source range on the relevant side.
- Group comments sharing a hunk, side and starting line into one popover.
  Show label, blocking status, Before/After line range, Conventional Comments
  subject, discussion and Copy for LLMs. Escape, outside click, the close button
  and reactivating the marker dismiss it. Keyboard activation moves focus to
  the close button; Escape/close returns to the marker. Outside clicks should
  not steal focus from another control. Do not make hover the only interaction.
- Overview comment links navigate to the correct layer, reveal the marker and
  open the same popover. Changing layer/layout or disabling Comments closes it.
  Do not let comment markers trigger the separate finding-navigation handler.
- In unified mode keep the same real side/range mapping. Notes must not invent
  line numbers or change the underlying unified row order.

## Personal review and tablets

- Source line numbers are buttons. In File by file with captured full source,
  select any old/new line and another on the same side of that file to highlight
  a range, even across unchanged context and hunk boundaries. The selection bar
  offers Comment and Clear. Consecutive taps work on tablets; Shift is not
  required. Walkthrough and diff-only fallback remain hunk-bounded; never infer
  source text across omitted context.
- The comment editor shows the exact path/range/snippet, type, subject, optional
  details and blocking choice. Saving adds a personal gutter marker and an entry
  in User comments. Edit and Delete affect only personal comments. Keep modal text
  intact while resizing; suppress review-navigation shortcuts inside dialogs.
- Copy for LLMs includes the file, old/new side, source revision or capture,
  numbered source snippet and full comment. Copy all for LLMs collects personal
  comments and general step notes. Use safe fences for snippets containing fence
  characters. Clipboard failure opens selectable text; do not silently fail.
- Store personal comments with the snapshot/revision, alongside existing notes.
  No server or provider submission. Explain storage failure only when it occurs,
  and retain Copy/Export so a user can preserve their work.
- Auto layout: unified below 1200px, split otherwise. A manual Unified/Split
  choice persists for the page session until Auto is selected. The Auto label
  names the effective mode. Under 1200px, navigation becomes a toggleable rail
  and the code gets the full width. Keep controls usable at 768px and avoid
  document-wide horizontal scrolling; a deliberately selected split diff may
  scroll within its own container.

## Verification when changing the UI

Use one small synthetic fixture with unequal replacement lengths, comments on
both sides, and two comments sharing a starting line. Browser-check at 1440×900
and 3840×2160, plus a shorter viewport for edge placement:

1. Inspect a screenshot and actual column/sidebar geometry. Confirm equal split
   code widths, real line numbers, syntax colors and no full-width comment rows.
2. Open each marker. Confirm bounded width, proximity, exact side/range highlight
   and unchanged code row geometry. Test grouped and overlapping ranges.
3. Test Enter/Space, Tab, Escape, close, outside click and focus return. Exercise
   Copy for LLMs, overview links, scrolling, viewport edges and unified mode.
4. Check Comments toggle, step navigation and focus mode while a note is open;
   there must be no orphaned popover or JavaScript errors.
5. Run `node --check assets/report.js` and `ruby scripts/test_review.rb`.
   Regenerate the requested HTML, validate its embedded data and unchanged
   fingerprint/analysis, and confirm it is ignored and source status unchanged.
6. Test category filters with markup, CSS, JS, helpers and backend Ruby; each file
   appears once and its diff stays in the view. Test a personal multi-line comment,
   edit/delete, reload persistence, combined copying and clipboard fallback.
   Validate exact copy content with `node scripts/test_ui.js`. At 768×1024,
   check automatic unified mode, navigation, range selection and editor sizing.
7. For a UI refresh, rebuild the series' current view with `series.rb refresh`.
   Original snapshots remain unchanged; a UI refresh is not a new review.
   Navigate newest → oldest → newest through the selector. Check revision text
   clears the native caret and the search input retains at least 40px height in
   a crowded sidebar at 1024×768 and 768×1024.
8. For thread changes, check View code actions, highlighted diffs when opened, readable
   type/blocking differences, Resolve/collapse, reload persistence, manual
   expansion and Reopen. Check personal threads and combined copying, and verify
   the original review findings/history remain unchanged.

Respect browser access blocks. A synthetic fixture can verify the renderer but
does not prove the private report itself was visually inspected; state that
limit accurately. Do not route blocked private content through another URL.

Native behavior reference (consult only when needed for maintenance):
[HTML popover attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/popover).

## Optional QA media

Each failed flow belongs inside its issue comment, not in a separate QA section.
Show its short journey and expected/actual results once; native details disclose
numbered steps and captioned media. Put useful successful checks in one collapsed
Other flows checked disclosure. Unmatched failures remain visible under Review
comments. A flow has one owner (flow comment_id, falling back to the first asset
comment_id) so multiple associations never render the same flow twice. Gutter
See visual evidence opens the owning thread and its steps without resolving it.
Preserve distinct comment discussion, but do not author a second copy of the QA
reproduction there. Keep capture provenance in Review details.

User comments is always available at the bottom. Add comment opens a general
comment editor without requiring a source selection. Code-line comments retain
their exact anchors. General and anchored comments support edit/delete, individual
Copy for LLMs, and combined Copy all for LLMs including resolved comments and step
notes. Keep all user data browser-local and exportable. Copy for comment gives
plain GitHub/Linear-ready text with file/range, finding and reproduction, without
source dumps, local resolution status, data URIs or broken local image links.
Clipboard failure must expose selectable text. Test copying actual text as well
as adding, editing, deleting, reloading and combining both kinds of user comment.

Screenshots and controls must fit narrow widths. No autoplay, remote media or
simulated background worker. Test evidence navigation from the diff, collapsed
steps, unmatched failed flows, text-only evidence, loaded media, and narrow layouts
using synthetic captures without implying they validate the reviewed application.

Screenshot thumbnails and overview View code actions open the same bundled
GLightbox viewer. Code uses the shared diff renderer for the complete related
hunk, highlighting the precise comment range. Auto uses split above 1200px and
unified below, with explicit Auto/Unified/Split controls; split can scroll
horizontally on phones. Check old/new numbers, paired replacement rows, syntax
colors, range highlighting, breakpoint changes and manual overrides. Embed
the library CSS/JS and reuse the embedded image source; do not load a CDN or
separate image file at runtime. Preserve captions as escaped plain text. Check
click and Enter/Space activation, image zoom/pan, Escape and close-button dismissal,
focus return, and narrow viewport sizing. Review shortcuts must not change the
underlying step while the viewer is open. Videos retain their inline controls.

## Related tests in the walkthrough

Keep tests in their concept's layer, inside native details panels collapsed by
default and inserted immediately after the last associated entity. The closed
summary names the concept and the important outcomes verified, with quiet file
and changed-range counts. Do not enumerate paths or imply a test run. Opening
reveals the usual initially expanded file cards, real unified/split diffs,
comments and line selection. All changes shows test files directly. Hunk/comment
navigation must open closed ancestors before scrolling/focusing its target.
Check keyboard disclosure, a panel shared by multiple entities, comment links,
source-range selection inside tests and responsive layout.

## Per-file review progress

### ViewComponent sidecars

Pair conventional changed Ruby/HTML ERB sidecars only within the same walkthrough layer. The component link restores its selected file (Ruby initially); compact Ruby/Template shortcuts select that file. Both actions land on the component header, never its inner file summary. The diff card shows its full directory and actual filenames in keyboard-operable tabs. Keep this header and tabs sticky within the component while its diff scrolls; remember selection and per-file scroll position. Finding navigation selects the containing tab before revealing the range. Keep progress and disclosure per file, and derive component completion from both files. Search includes both paths and the component name. Related tests keep their own disclosures; All changes retains responsibility categories. A lone changed sidecar stays a normal file. Do not infer custom acronyms, sidecar directories or other template engines in this first convention-based implementation.

Scroll the non-sticky component section within the code pane, accounting for the pane's computed top padding plus a small gap, then focus its sticky header with `preventScroll`. A bare section `scrollIntoView` with a smaller fixed margin can leave its header pinned over the first file toolbar; scrolling the sticky header itself can leave the reviewer mid-file. Repeated clicks from the middle or end must return to the section's real start while preserving the selected file. Verify that the header, tabs, and entire first file toolbar are visible without overlap at desktop and narrow widths; DOM doubles alone do not verify sticky layout.

Verify paired and lone files, same-named components in different namespaces, keyboard tab navigation, findings targeting an inactive tab, partial viewed progress, reload and narrow layouts. Print both files even when a tab is inactive.

Each file header has a labelled Viewed checkbox. Checking it collapses the file;
unchecking reopens it. Manual expansion/collapse does not change viewed status
and survives navigation and reload. Progress counts unique file paths across the
whole snapshot, including files without text hunks, and stays shared between
walkthrough steps and All changes. Step/group counts derive from those file
marks, with no whole-step checkbox. Existing step marks migrate only when every
step containing a file was marked reviewed. Notes and comments remain intact.

Verify partial group completion, mark/unmark, manual disclosure, reload, layout
switching, All changes and search. Check a file shared by multiple steps counts
once overall; related tests remain reachable through sidebar file links. Finding
navigation must reveal collapsed files without clearing their viewed mark. Use
keyboard controls and check narrow-width wrapping and checkbox focus.

`series.rb refresh --record` creates an explicitly requested presentation revision
without collecting source or altering conclusions or QA evidence. The default
refresh still updates browsing pages only; original snapshots stay immutable.

## File-by-file reading

File by file follows the existing walkthrough groups and steps, with each unique
file at its first occurrence in the sidebar order, including related tests at the sidebar position.
It is a reading mode, not a new grouping strategy. Preserve group labels in the
sidebar, show the file position and explanation, and offer Previous/Next file,
Previous/Next changed section and a separate Viewed checkbox. Keep navigation keyboard accessible and
use J/K for files while File by file is active. Existing comment anchors remain stable.

Render all captured source lines, including context before, between and after
hunks. Capture bounded text at collection; legacy committed snapshots may recover
context only from their immutable Git objects. Historical working-tree snapshots
must never read today's working files. Label unavailable/oversized context clearly.
Context outside saved hunks has plain line numbers rather than misleading comment
controls that would create invalid anchors.

A−/A+ changes code font size from 10–20px (13px default), updating row spacing
without changing the surrounding UI. Persist this with revision-local preferences.
Verify complete old/new line coverage, additions/deletions, no-final-newline files,
existing comment navigation, file boundaries, viewed state, font limits/reload,
group order, and desktop/tablet geometry. A UI refresh preserves analysis and QA.

File by file and Unified are the main review defaults. Place explicit File by file / Walkthrough reading controls beside Unified/Split; the main diff has no Auto option. Walkthrough retains the existing group steps; do not imply it is one infinite list. Keep the existing grouped sidebar visible on desktop and the current group, step and file position in the sticky file header. Keep hunk explanations out of the source flow: a small note marker beside the line-number gutter on the first changed line opens a clearly labeled Review note popover. Use only the grouped sidebar for file selection; show a selectable current file path with Copy path in the reading header, without a competing file dropdown. Hide the unified table header visually while retaining accessible before/after line-number labels. Changed-section buttons navigate contiguous changed blocks separated by unchanged lines, including multiple blocks inside one Git hunk. Track the selected block explicitly across clicks, including when scrolling is clamped at the file bottom; resynchronize after manual scrolling. Use instant scrolling corrected for the sticky header, without wrapping, show the current section count and disable at boundaries. Viewed records progress without advancing or hiding the focused file; Next file remains a separate action. Explicit Overview/All changes links still open their respective screens.

In File by file, paired ViewComponents expose compact Ruby / Template navigation beside the current path, using the same component pairing within the existing review layer. Indicate the current file and preserve group order, viewed state and full-path copying. Show shortcuts only when both files exist in the reviewed scope; do not invent or load an unchanged companion.

Keep the file-reader header compact: group, file position, changed-section arrows/count and Viewed share an orientation row; show the selectable full path below with an accessible copy icon. Mobile puts the group on its own row and keeps position/navigation/Viewed together. Component shortcuts and a quiet About this file disclosure follow without reserving empty space. Preserve full names by wrapping, and keep change navigation correct when the sticky header height changes.

Keep header controls clustered rather than stretching them across the available width. Copy path and About this file sit directly beside the path. Make Mark viewed a visibly clickable checkbox action, with a separate Next file button; checking it must not advance automatically. Wrap these clusters naturally on mobile.

Reading mode is a browser preference separate from the current destination. Overview and All changes must not change File by file / Walkthrough. Persist explicit mode choices in local storage and apply them when returning to a review group or file; default to File by file when no preference is saved.

Position File by file review notes beside their own changed-line marker, flipping above or to the left when space is tight and clamping to the viewport. Reposition on scroll and resize, and close when the marker leaves the code viewport. Do not park notes in a screen corner.

Place the File by file Review note marker at the left of the first changed line's line-number gutter, beside the current-section stripe and aligned with comment markers. If that gutter has a comment marker, use the other line-number gutter; never overlap a comment or line number.

Review notes use the same bounded popover shell and below/right placement as review comments, with the same close affordance and viewport behavior. Use a distinct note icon and a subtle popover tint drawn from the current-section gutter color. Keep the comment-only source-range highlight out of review notes.

Inside each numbered review step, show implementation files first, then one quiet Tests divider and that step’s test files. Keep File by file navigation in the same order. Extend the current-section gutter stripe through every changed row in the selected contiguous block, stopping at unchanged context.

With complete captured source, File by file lets personal comments select any old/new line or same-side range across the full file, including unchanged context between hunks. The diff-only fallback keeps hunk-bounded selection. Clicking a Review note selects and scrolls to its changed section. Give an active user selection visual priority over the current-section stripe and diff colors.
