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
  the available sidebar width and wraps its title. Keep file counts and comment
  counts subordinate to the title. Do not shrink step buttons into narrow pills.
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
  content. Overview starts with the change summary and review order. Show each
  observation as an individual entry with its path, range, readable subject and
  full discussion. Other evidence sections use
  clear headings, 14px text, generous line spacing and roughly 80ch prose widths.
  Avoid a single container filled with tiny comment buttons or muted text walls.
- All changes displays actual full-file diffs under responsibility headings and
  filter buttons. Use `ReviewTools.category` plus explicit `file_categories`
  overrides from the review. Design/UI excludes behavior code even when the
  behavior affects the UI. Keep diff cards collapsible, but initially expanded;
  do not reduce this view to links back to walkthrough steps.
- Series revisions also show a compact revision selector, an overview of changes
  since the previous revision, updated/reused group labels and explicit finding
  lifecycle states. Unanchored concerns needing rechecking must not receive a
  green clean-review verdict. Historical HTML stays immutable; the History link
  reaches the current index. Notes and viewed marks belong to one revision.

## Overview comment threads

- Use a single reading column, bounded to 960px. Stack the file/range header,
  expanded source snippet, comment body and action footer. No masonry, parallel
  metadata columns or code hidden by default. Keep long file paths wrapping.
- Highlight snippets through the same bundled Prism grammar and whole-hunk
  tokenization as the diff, preserving multiline tokens and exact old/new source
  numbers. Bound long snippets to 260px with scrolling and keyboard focus.
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

- Source line numbers are buttons. Select one, then optionally another in the
  same hunk/side, to highlight a range. The selection bar offers Comment and
  Clear. Consecutive taps work on tablets; Shift is not required. Never infer
  source text across omitted context. Different hunks or sides start a new range.
- The comment editor shows the exact path/range/snippet, type, subject, optional
  details and blocking choice. Saving adds a personal gutter marker and an entry
  in Your review. Edit and Delete affect only personal comments. Keep modal text
  intact while resizing; suppress review-navigation shortcuts inside dialogs.
- Copy for LLMs includes the file, old/new side, source revision or capture,
  numbered source snippet and full comment. Copy my review collects personal
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
   Saved historical revisions remain unchanged; a UI refresh is not a new review.
8. For thread changes, check initially expanded highlighted snippets, readable
   type/blocking differences, Resolve/collapse, reload persistence, manual
   expansion and Reopen. Check personal threads and combined copying, and verify
   the original review findings/history remain unchanged.

Respect browser access blocks. A synthetic fixture can verify the renderer but
does not prove the private report itself was visually inspected; state that
limit accurately. Do not route blocked private content through another URL.

Native behavior reference (consult only when needed for maintenance):
[HTML popover attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/popover).

## Optional QA media

Visual QA belongs in the Overview, after findings. Show status, environment,
expected/observed outcome, short steps and captioned media. Screenshots and
controls must fit the content column at narrow widths. Associate media with
generated comments through comment_id; the overview thread shows it directly
and the compact gutter popover links to it with See visual evidence. Preserve
resolved state when opening evidence. No autoplay, remote media, automatic
refresh or simulated background worker. Verify pending/completed states, loaded
images, video playback when supported, comment navigation and a narrow viewport
using synthetic captures, never implying they validate the reviewed application.
