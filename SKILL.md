---
name: dynamic-code-reviews
description: Review local changes, a whole pull request, or a specific commit with grouped offline HTML walkthroughs and evidence-backed findings. Continue saved review series incrementally, reusing unchanged explanations and retaining revision history. Use for Dynamic Code Reviews or an incremental code review report.
---

# Dynamic Code Reviews

Produce self-contained HTML reviews in the target repository's git-ignored `.reviews/` directory. Save repeated reviews as revisions of one feature series, keeping each revision independently readable. The most important deliverable is a simple explanation of **why related changes belong together**, followed by the actual diff in a useful reading order. Personal scripts and templates live in this skill, never in the reviewed project.

## Portability

The reviewed project can use any language; Ruby runs only the deterministic helpers. Require Ruby 3.1+ and Git on PATH. Resolve `<skill>` to this skill's installed directory and `<root>` to the target repository; quote filesystem paths in actual commands. Assets resolve relative to the helper, not the working directory. No personal memories, provider account, project runtime or network connection is required for local collection/rendering. Read only relevant project instructions and adapt test advice to its stack. See [README.md](README.md) for installation, requirements, limitations and checks.

## UI contract: reuse the supplied renderer

For ordinary reviews, **author review JSON only and run `scripts/review.rb`**. Do not recreate the HTML, restyle the report, replace components, or write a new generator. The supplied assets deterministically provide the approved UI; model size must not change its layout. Do not read the large vendor assets or renderer source during a normal review. Read the JSON schema and inspect the collected code instead.

Preserve these rules when the user explicitly requests a UI change:

- Use the bundled daisyUI components, Prism syntax highlighting and Lucide SVG icons, embedded into the single offline HTML. Use Lucide for comment types and thread actions rather than improvised glyphs; retain the custom skill logo. Keep Ruby stdlib helpers; no project scripts, npm, gems or runtime CDN requests.
- Keep the 320–340px desktop sidebar with full-width, wrapping step buttons; its ☰ button collapses it in place on wide screens (remembered) and opens it as a drawer below 1200px. Give the remaining width to the code. Split mode has equal code columns, paired rows and independent real old/new source numbers; narrow screens scroll the comparison horizontally instead of stacking its sides.
- Comments use visible, keyboard-operable gutter markers on the correct side and first source line. Open a bounded 390px popover near that marker, highlight the exact inclusive range, and preserve code row alignment. Never insert screen-wide comment rows. Support grouped comments, Copy comment, Escape, outside-click dismissal and returning keyboard focus.
- File by file is a one-file reading mode using the existing walkthrough groups and steps, with tests last in each numbered step; File by file must use the exact sidebar file order while Walkthrough may show test panels after their owning code. Never introduce a second classification. Show full captured before/after source with diff colors and original comment anchors, the existing grouped sidebar and a selectable current file path, Previous/Next file and change navigation, and shared viewed progress. Font-size controls adjust code text and row spacing together and retain the preference locally. If complete source is unavailable, label the saved-hunk fallback honestly; never substitute current files for a historical snapshot.
- Use readable monospace code, restrained diff colors, clear selected/focus states and progressive disclosure. Keep navigation, details, and notes. Track viewed progress per unique file, shared across walkthrough and All changes: checking Viewed collapses that file outside File by file, unchecking reopens it, and manual disclosure state persists independently. Keep sidebar navigation shallow: one heading for a single-step group, a flat file/component list for the active step, and search revealing matching steps. Wrap names and path subtitles instead of cutting them off; retain full-path tooltips/accessibility labels. Represent each component once with compact Ruby/Template shortcuts; keep actual filenames in the diff tabs. Component navigation must reveal its header and tabs, which stay visible while scrolling its diff. Derive group completion from its files; do not replace partial file progress with a group checkbox. Never add a control that pretends to have a backend.
- Use the bundled GLightbox viewer for one-click visual-evidence previews and overview View code actions. Show media at its original pixel size inside a scrollable viewer rather than stretching it; code shows the complete related hunk with syntax highlighting, real source numbers and the comment range highlighted. Default code to split on wide screens and unified below 1200px, with Auto/Unified/Split overrides. Support keyboard activation, Escape/close and focus return; suppress review shortcuts while open. Embed the viewer CSS/JS and image data so a single HTML file works offline; keep videos in their native inline player.
- All changes renders full diffs grouped by responsibility. Keep Design/UI to markup and styles; JavaScript, helpers, presenters and view-only controllers belong in Frontend. Use `file_categories` only to correct ambiguous roles after inspecting the code. The logical walkthrough remains a separate reading order.
- Overview is a centered reading column up to 840px: What changed (explicit code comparison plus a short behavioral paragraph), review comments containing their QA evidence, compact Other flows checked previews, and a bottom User comments section. Keep report-revision updates separate and limited to one quiet sentence. Only while served by the capture helper, a Record visual QA evidence section follows What changed; the saved HTML never contains it. Do not repeat findings as outcome cards. Each failure appears once as a review comment: a short journey, expected/actual result, and one visible evidence thumbnail. Clicking it opens the media and numbered steps together. Show up to four successful checks as a compact preview list, with more checks behind one disclosure. Never hide an unmatched failed flow. Keep the grouped walkthrough in the sidebar and metadata in Review details. Comments use one-column threads: file/range header, subject, concise body and evidence preview, a View code action opening the related highlighted diff in the shared fullscreen viewer, then actions. Distinguish types with a named icon, color and short meaning; show blocking status separately. Resolve collapses a conversation; Reopen expands it. This is browser-local progress for the snapshot/revision, never proof a finding was fixed. Copy for LLMs retains captured source and local resolution status, including resolved personal comments in combined copying. Copy for comment produces paste-ready GitHub/Linear text with location and reproduction but without source-code dumps or local resolution metadata. User comments is always available at the bottom, with Add comment for general notes, code-line comments, edit/delete, individual copying and Copy all for LLMs. Auto layout uses unified below 1200px and split above; explicit layout choices override it until Auto is selected again.
- Open every report on Overview by default, including saved revisions and the report served with its recorder. Restore notes and reading progress without restoring the last visited page; honor an explicit section URL hash. Keep the recording action and existing video previews directly visible on Overview so readers can start a capture or play evidence from there.

Read [references/ui-guidelines.md](references/ui-guidelines.md) **only when changing the UI**, for dimensions, interaction details and the browser verification checklist. Routine reviews inherit these rules through the renderer without redesign work.

Within a walkthrough step, the renderer pairs changed `app/components/**/*_component.rb` and matching `.html.erb` sidecars under their path-derived component name, with per-file tabs and progress. Keep both in their owning behavior step when appropriate; never invent a companion diff or move unrelated behavior merely to create tabs. Single changed files and All changes retain ordinary file cards.

## Select scope

First discover existing history with `ruby <skill>/scripts/series.rb list --repo <root>`. When the user asks for an increment, follow-up or continuation, use the matching series and state its cumulative scope. Ask only if the series is ambiguous. An explicit request for only uncommitted files, one commit or a particular PR still controls the scope; do not silently replace it with a cumulative series. When offering scope choices, mention the matching saved series as an additional option. Fresh reviews still default to uncommitted changes.

On invocation without an explicit scope, ask: “What should I review?” Offer **Uncommitted changes (default)**, **Whole PR**, and **Specific commit**. Use an available question tool; otherwise ask in plain text. For an optional unanswered scope prompt, allow reasonable reply time then state the uncommitted default. When the user already supplied a scope (including “try this on current uncommitted files”), use it without asking again. Confirm the target through the supplied path/current workspace; ask only if ambiguous. Read applicable repository instructions.

- **Uncommitted:** combined tracked working-tree state against HEAD (staged + unstaged), plus non-ignored untracked files. Explain that an edit staged and then reversed in the worktree is absent from the net diff; inspect `git diff --cached` separately if the user wants what will be committed.
- **Whole PR:** resolve live PR metadata with the authenticated provider CLI/connector. Use its actual base branch, including stacked PR bases; never assume main. Fetch exact base/head objects without checkout, then pass verified refs to the collector. Exclude uncommitted work. Record PR URL, base/head SHAs, checks and issue links. If provider access is unavailable, ask for the PR/base or offer a clearly labeled local comparison, not a claimed full PR review.
- **Specific commit:** resolve the requested SHA; compare to its parent. Root commits compare to the empty tree. For merges ask which parent unless specified. No checkout needed.

## Collect and inspect efficiently

Use `ruby <skill>/scripts/review.rb collect --repo <root> --mode uncommitted --out <temporary-snapshot.json>`.
For other modes add `--mode commit --commit <sha>` (optionally `--base <parent>`), or `--mode pr --base <verified-base-ref> --head <verified-head-ref>`.

The tool prints a compact file/hunk manifest; the full snapshot stays in a temporary directory outside the project. It excludes `.reviews/`, marks likely secrets/binary/oversized patches as omitted, disables external diff helpers, and refuses unresolved conflicts. Renames are deliberately represented as deletion/addition to keep complete range coverage; explain moves together. Do not silently omit source files because they look generated. Inspect omissions separately when needed and accurately report coverage. The filename filter is not a secret scanner: check relevant content before embedding and redact exposed credentials, never copy secrets into a report.

Read each changed hunk once, then inspect its enclosing function and direct callers/tests where needed to prove behavior. Use focused `rg` searches rather than whole-repository dumps. Scale effort to risk: ordinary small changes need one focused pass; concurrency, tenancy, external I/O and migrations need their actual failure/ownership paths traced. Stop widening once the conclusion is supported. Never install dependencies or start expensive broad suites just to decorate a report.

For an incremental run, follow [references/incremental-reviews.md](references/incremental-reviews.md). `series.rb prepare` collects the cumulative snapshot, remaps uniquely matching ranges, writes a reusable draft and lists the inspection gaps. Inspect `plan.json` first, then read only the relevant portions of `draft.json` and source context. Author a small update JSON and let `series.rb publish` merge and validate it. Do not rewrite the entire analysis, match sequential IDs across snapshots, or read previous HTML/vendor assets into model context. HTML regeneration is deterministic and does not consume model reasoning tokens. No agents are required.

Record repository-relative `context_paths` for surrounding callers, contracts, repository instructions and tests actually used to support the review. The helper fingerprints these files without copying their content into history. Changed recorded context invalidates explanation reuse; unrecorded dependencies still need judgment. Reassess every prior finding explicitly, and refresh quality/issue conclusions and validation statements. A matching diff never proves the previous review remains correct.

## Review at the scale of the business

Infer the project’s purpose, language, framework, workload and risk from the selected changes, repository instructions and user context. When scale is unknown, favor straightforward solutions suitable for a small or medium project. Prefer idioms of the actual stack, understandable control flow, and the smallest maintainable change that solves the problem. Do not demand hyperscale architecture, broad abstractions, speculative caching, new background infrastructure, or elaborate micro-optimizations. A performance finding needs evidence of a bottleneck, unbounded work, expensive database access, or a plausible hot path at the current/near-term workload; state the trigger and practical impact.

Keep reviewer calibration in these instructions. Do not repeat assumed business context, review philosophy, or internal prompting instructions in report prose, Review details, comments or a "Review standard" section. Report concrete observations, outcomes and validation limits instead.

Scale does not excuse broken access control, exposed credentials, financial errors, data loss, or missing legally required controls. Evaluate only boundaries relevant to the project. Trace those real boundaries carefully. Flag a specific compliance obligation only when it is established by the task or authoritative context, not an imagined enterprise checklist. Separate introduced defects from existing architectural debt. Prefer a small fix over a redesign; mark worthwhile follow-ups non-blocking. No quota for findings, praise, optimization, or test suggestions.

### Testing judgment

- Assert durable observable outcomes or a real regression boundary, not patch history, private implementation shape or invented requirements.
- Put detailed encoding/header/format checks at the narrowest responsible unit boundary. Integration tests cover their own outcome without repeating those checks.
- Reuse existing coverage when it already protects the behavior. Avoid more database/factory setup for the same assertion at multiple layers; test count and line ratios are not quality targets.
- Suggest a test only when you can name the real behavior that would fail and why current coverage would miss it. Security, financial integrity, concurrency and data-loss boundaries can justify targeted extra coverage. A complicated concurrency harness needs a real concurrency invariant, not a hypothetical race.
- If unnecessary implementation introduced an artificial scenario, consider removing that implementation instead of cementing it with tests.
- Discover and use the repository's documented runtime and test commands; do not assume a language, framework, container setup or package manager. If a required runtime is unavailable, report that limitation. Do not start a paused environment or a broad suite just to decorate a walkthrough; distinguish inspected tests, actual runs and their limits.

## Author the walkthrough


Read [references/report-schema.md](references/report-schema.md) for the small review JSON format. Let the collector and template handle code and layout; author only analysis.

Group by **user outcome or domain responsibility**, not top-level directory or file extension. A group can contain data model, service, UI and test files if they jointly deliver one behavior. Separate independent outcomes.

Order groups by **ease of understanding the changed behavior**, not by a fixed file-type priority. Choose the starting point that explains why the change exists and gives the remaining code its meaning: this may be a public operation, event producer, route/controller, or central entity/resource. When the change introduces event production, prefer the producing operations and their success/failure boundaries before persistence and downstream rendering. If the new behavior is confined to a consumer, start there instead; start at a request when that request owns the behavior. A route or display controller is not automatically the best entry just because it is visible. Follow the causal flow from the chosen starting point into supporting contracts and consumers. Briefly explain this choice in the first step’s summary. When no entry point is changed, start with the changed contract that provides the most useful orientation and describe the unchanged entry point without adding unrelated diffs.

Apply the same reading order within each group: orienting operation/entity first, then related implementation. Keep related models, services, UI and tests in the same concept group. Put test items in layer `related_tests` panels linked to one or more owning entities, inserted after their last related entity and collapsed by default. Write a concise summary of the important behaviors/regressions those tests establish, not a path list or a claim that they passed. Expanded panels reuse the ordinary file cards, diffs, comments and line controls; All changes continues to show every file directly. A file spanning multiple concerns can appear in multiple layers, with each hunk assigned exactly once. Use as few layers as the change warrants.

On a follow-up that explicitly changes the reading order or authoring rules, reassess and rewrite the saved walkthrough rather than relying on a UI refresh. A refresh retains existing analysis and order. Use a recorded revision for the requested reassessment, supply `group_order` when changing existing group order, and preserve unchanged test/QA evidence with its original run/capture qualifications.

For each group explain, in 2–4 plain sentences: what changes for the user/system, why these files belong together, and the boundary that stays elsewhere. Each diff range needs a short behavioral summary rather than restating syntax. Add a flow diagram only for meaningful interactions; the template renders `flow` steps offline. For branching/sequence/state/ER diagrams that genuinely add information, extend the personal renderer with inert SVG or pre-render SVG into the HTML; do not depend on CDN Mermaid or leave unrendered diagram text as the sole visual.

Keep the overview useful and brief: What changed → review comments with evidence → optional Other flows checked → User comments. What changed describes the full selected code scope, never report revisions: identify PR head/base branches, uncommitted edits versus HEAD, a commit versus its selected parent, or the pinned cumulative series base. Use a short behavioral paragraph instead of duplicate summaries. For PR labels, resolve live names and supply comparison metadata bound to the snapshot endpoints; do not guess branch names. Report revisions get their own quiet update sentence. Avoid duplicate outcomes, long revision narratives, and routine issue/quality/PR/deployment assessment sections. Do the underlying assessment, but surface only conclusions that change a decision. Optional supporting context belongs in Review details.

Include:
- High-level outcome, grouped walkthrough and review effort **1–5** with a reason (not a fake time prediction).
- Inline feedback in [Conventional Comments](https://conventionalcomments.org/) format: `label (blocking/non-blocking): subject`, with a short explanation when useful. Use `note` for behavior worth understanding, `question` for unresolved context, `suggestion` for an improvement, and `issue` for a substantiated defect. No artificial quota. Each comment must identify its hunk, old/new side, and exact inclusive line range; prefer a small coherent block. The UI shows a gutter marker at the range's first line and opens its comment in a compact popover, marking every covered line. Keep subjects short and discussions concise; use separate lines for reproduction steps and expected/actual results when useful. Do not restate every hunk summary as a comment.
- Explain defects in terms of what the user does and sees. Lead with the visible problem, then give clear reproduction steps using actual screen/control labels, followed by expected and actual results. Stop once the problem is clear. Add a technical cause or fix direction only when it adds information the reproduction does not already establish; never append obvious advice to fix the demonstrated failure. Explain code terms instead of using method names as user actions. For non-UI defects, use equally concrete inputs, commands, or events. Include any prerequisite data or state needed to reproduce, and distinguish observed behavior from an untested inference. A short finding needs only a short sequence; do not bury multiple distinct sequences in one dense paragraph.
- Actionable findings ordered P0–P3, with a concrete trigger, consequence, precise changed hunk, confidence and, only when useful, a minimal suggested direction. Verify against surrounding code. Distinguish introduced defects from pre-existing architecture and optional improvements. No minimum finding quota.
- Quality / “slop” assessment: evidence of redundant abstractions, duplicate logic, misleading comments, invented requirements, empty tests or unrelated churn. Do not infer authorship or label code defective for being verbose. Report only concrete concerns; omit a clean-bill-of-health paragraph.
- In Review details, record actual validation outcomes and only material limits that affect confidence; do not inventory every test or scenario not exercised. Follow repository test workflow. Avoid creating tests that merely repeat implementation.
- Consult related/linked issues when available: met/partial/unmet/unknown with evidence, evaluated only within selected scope. Local uncommitted review is not whole-issue sign-off. Issue-tracker connectors can provide issue/spec context when configured; provider-specific guide/diff tools are optional, never prerequisites. Read linked sources only as needed. Bound optional enrichment to linked issues and a few precise history lookups; do not scan the organization's backlog.
- Include related PRs, suggested labels and reviewers only when they change a review decision and are supported by live metadata, CODEOWNERS (last matching rule wins), or focused history. They are suggestions only; do not assign, comment, push or mutate external services. Omit routine metadata and unavailable optional enrichment.
- Keep snapshot/coverage metadata in Review details. Mention before-merge/deployment actions only when they require a concrete decision not already covered by a finding. No simulated live CI, chat, native review submission, semantic symbol lookup or remote progress sync. Omit poems/fortunes by default because this is a focused review artifact; add only if requested.

## Template previews for Rails partials and ViewComponents

When the scope changes `.html.erb` partials or ViewComponent templates/classes and
the app's development environment is available (reuse the visual QA environment
answer), read [references/previews.md](references/previews.md) after publishing the
review. Render every changed visual template with the app itself, reusing an
existing Lookbook/ViewComponent preview's example when one exists and otherwise
writing realistic example data. Mark stream-only or other non-visual templates
`not_visual`. `scripts/previews.rb render` runs the examples through the app's
runner in rolled-back savepoints, keeps only the CSS each preview uses, and
`series.rb previews` attaches them to the latest revision. Every changed template must be accounted for: rendered, unavailable with its
error, or `not_visual` with a reason the report shows. File by file opens a sticky
side pane by itself only from 1600px; on laptop widths a Visual preview button in
the file header opens it, and narrow screens and file cards show a collapsed Preview
section above the code. Each example is a sandboxed, script-less frame. App icon fonts and URL images become labelled stand-ins (Lucide icons chosen by
name or by the agent, photos the agent finds with its own tools, or placeholders);
look-alike examples
are folded by the report. Inspect them in a browser before delivery and fix clipped or
broken examples.

## Visual QA for UI changes: publish the review first

When the inspected change has a concrete UI or user flow that can usefully be
exercised, read [references/visual-qa.md](references/visual-qa.md). Publish and
link the initial HTML before attempting capture so the user can read the review
while QA continues. After publishing, ask “Do you have this environment
provisioned?” with options to supply a local URL, discover a provisioning skill,
or skip screenshots for this review. Reuse an environment or skip decision
already supplied in the conversation; do not ask again. Missing runtime alone
is not a reason to stop without offering these paths. Use `awaiting-environment`
while waiting for that choice, and “QA assets are being generated” only once
capture is actually planned. Omit QA for changes with no meaningful visual flow.

Use a dedicated QA tab through the available browser harness. For UI interactions,
**continuous tab video is the default**. Use the bundled, harness-independent
[tab capture helper](references/tab-capture.md), or an already available native
recorder with equivalent output. Save lossless PNG stills from that same capture
stream for decisive states and evidence thumbnails. Prepare before recording,
show actions at a normal human-readable pace, pause briefly on the result, and
keep clips focused (usually 5–20 seconds). Trim idle portions with the browser
helper when needed; never accelerate a clip just to meet a duration target. Do not use compressed tool
screenshots as the default published evidence, sampled GIFs, frame slideshows,
or hand-positioned cursors. Existing GIF reports remain readable.

The helper uses browser APIs for video and PNG capture, plus the existing Ruby
runtime to save files locally. It needs no extension, FFmpeg, package install,
provider SDK or second automation connection. Serve the published review with
`qa_capture.rb --report <current.html>` and open it next to the app in one QA
window or tab group (the harness session group qualifies), opened on its Overview. Its Record visual QA evidence section
replaces a separate recorder app: ask once for Choose QA tab → the app tab →
Share, drive recording from the terminal with `qa_capture.rb control`, attach the
evidence, then `control reload` so the same tab shows the final report. Follow
the harness's permission policy. Record only the QA tab, never the desktop.
Verify pointer visibility with a short real interaction. A selected QA tab in a
background Chrome window can retain the automation pointer while the user works
in another app; an unselected tab may lose it. Do not confuse the user's system
cursor with the agent's interaction, or generalize one harness/OS probe to others.
Never add a synthetic pointer or require the user to babysit the recording.
If capture or pointer visibility cannot be established, report the specific limit
and use readable still evidence where useful; do not quietly substitute an animation.

Keep the approved evidence UI: one visible thumbnail per flow, one click to open
its media and numbered steps, compact Other flows checked previews, and native
video controls/fullscreen. Video playback follows the reader's explicit click,
never overview autoplay. Embed every WebM/MP4 and PNG in the single offline HTML;
source capture files and a running capture helper are not needed to share it.
Present a few useful flows with a short journey, explicit result, and concise
expected/observed outcome. Assign each failed flow to its issue using comment_id;
do not duplicate its reproduction in comment discussion or a separate QA section.
Keep stills at their real pixel dimensions in the viewer. Inspect small text and
clicks before attaching; format conversion or upscaling cannot restore detail.

Finish an attempted QA pass with complete, partial, blocked or skipped; complete
requires embedded media and means checks finished, not that they all passed.
Verify the current HTML contains the expected playable video and sharp stills,
then link it again and remind the user to reload an already-open report.

## Render and verify

For a fresh series, write review JSON in the same temporary directory as the snapshot, then:
`ruby <skill>/scripts/series.rb start --repo <root> --name <short-feature-slug> --snapshot <snapshot.json> --review <review.json>`.

This creates `.reviews/<slug>/index.html`, a compact `manifest.json`, `revisions/001.html`, and `current.html`. Subsequent publishes add immutable numbered HTML files and refresh the current view, revision browsing pages, and index. The dropdown opens `revision-NNN.html` browsing pages with all known revisions; `revisions/NNN.html` remains the immutable original snapshot. A series slug represents a feature or phase, not a commit SHA; its original base remains fixed across commits. The implementation's local `.lock` coordinates concurrent writes. No database, watcher, project script or per-revision asset folders are needed. Optional QA media is embedded in the offline HTML. Import an existing standalone report with `series.rb start --repo <root> --name <slug> --report <previous.html>`; preserve the old file and link.

For a requested UI refresh, use `ruby <skill>/scripts/series.rb refresh --repo <root> --name <slug>`. It rebuilds `current.html` and the revision browsing pages from saved reviews using the new assets and complete history, without inspecting new source or changing any original saved snapshot. When the user explicitly requests a new presentation revision, add `--record`: it saves the same captured code, analysis, and qualified QA evidence with a presentation-only revision note. Otherwise refresh creates no revision. Link this current view for the updated UI, and keep historical snapshots immutable.

For a standalone report or an explicitly requested presentation refresh, the original command remains available:
`ruby <skill>/scripts/review.rb render --snapshot <snapshot.json> --review <review.json> --name <short-related-slug>`.

The Ruby standard-library renderer enforces complete file/hunk and comment-range coverage, pairs replacement lines in split view, escapes code/data, embeds all CSS/JS, records snapshot metadata, and adds `/.reviews/` to Git's **local info/exclude** only if needed. It leaves tracked `.gitignore` unchanged and refuses tracked `.reviews` contents or a symlinked output directory. Standalone filename collisions receive a timestamp suffix; `--replace` is for an explicitly requested standalone presentation refresh. Never overwrite a saved series revision. The rendering uses bundled daisyUI 5.7.28 prebuilt CDN CSS and Prism 1.30.0; no npm, Python, gems, Tailwind browser compiler, CDN connection or build step is required at review time. Assets and licenses live in the personal skill; see [assets/vendor/SOURCES.md](assets/vendor/SOURCES.md) when updating them. Prepared snapshots, plans and update JSON stay in a temporary directory outside the project; each saved HTML contains its own complete snapshot and analysis.

Recollect just before delivery and compare fingerprints; if the changes moved, refresh affected analysis and regenerate. Test the resulting navigation, unified/split diffs, J/K/Z, search, finding anchors, notes and viewed state with an available browser. Validate helper behavior with `ruby <skill>/scripts/test_review.rb` when changing helpers. Check split replacement pairing, old/new line numbers, syntax token colors, comment placement and range highlighting, and actual sidebar/code widths—not just the presence of buttons. If browser access is blocked, do not claim visual verification. At minimum validate embedded JSON, assignment coverage and JavaScript syntax; state if browser testing was unavailable. Confirm `git check-ignore <report>` and source status unchanged. Clean up only scratch files created by this run.

For ordinary increments, reuse the already verified renderer; do not repeat its whole browser suite. Validate the merged data and scope, and perform a short navigation/comment smoke check when practical. When changing helpers, run `ruby scripts/test_review.rb` and `ruby scripts/test_series.rb`; the pure UI helper checks use `node scripts/test_ui.js` with no npm dependencies. When changing UI follow its maintenance guide. If `prepare` reports unchanged code/context, return the existing revision rather than creating another or claiming a fresh review. Use `publish --record` only for a requested reassessment with fresh conclusions, context or verification.

After final rendering and verification (including any requested QA updates), open the delivered HTML in the user's default browser before returning the final response. For a series, open `current.html`; for a standalone report, open the exact HTML path returned by the renderer. If reusing an unchanged review, open its existing HTML. On macOS use `open <absolute-html-path>` with the path shell-quoted; on other platforms use the available equivalent. This is part of the review handoff and requires no additional confirmation. If opening fails or no browser is available, still deliver the file link and briefly report the limitation; do not claim it opened. Opening the report alone does not count as visual verification.

Return links to the saved revision and series history, the changes/findings since the previous run, and material validation limits. In this skill, `publish` only saves local ignored files; it never posts externally. Report generation never implies permission to fix code or publish a remote review.

Design references (read once when evolving the skill, not every review): [CodeRabbit documentation index](https://docs.coderabbit.ai/llms.txt), [Walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), [Change Stack](https://docs.coderabbit.ai/pr-reviews/change-stack), [Slop Detection](https://docs.coderabbit.ai/pr-reviews/slop-detection).

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
