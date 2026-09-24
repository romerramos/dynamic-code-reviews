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
- Calm chrome: the app header holds the logo mark, the review title with repo and scope beneath, and only the rare actions Previews, Revision and Details. The reading bar holds the sidebar toggle, a pager showing the file or step position, and one **View** menu containing reading mode, diff layout, comments, code size and shortcuts; its button names the current settings. Reserve the accent colour for "where am I" and the one primary action in view. Add controls to these existing homes; never add a new toolbar row.
- Keep the 320–340px desktop sidebar with full-width, wrapping step buttons; its ☰ button collapses it in place on wide screens (remembered) and opens it as a drawer below 1200px. Give the remaining width to the code. Split mode has equal code columns, paired rows and independent real old/new source numbers; narrow screens scroll the comparison horizontally instead of stacking its sides.
- Comments use visible, keyboard-operable gutter markers on the correct side and first source line. Open a bounded 390px popover near that marker, highlight the exact inclusive range, and preserve code row alignment. Never insert screen-wide comment rows. Support grouped comments, Copy comment, Escape, outside-click dismissal and returning keyboard focus.
- File by file is a one-file reading mode using the existing walkthrough groups and steps, with tests last in each numbered step; File by file must use the exact sidebar file order while Walkthrough may show test panels after their owning code. Never introduce a second classification. Show full captured before/after source with diff colors and original comment anchors, the existing grouped sidebar and a selectable current file path, Previous/Next file and change navigation, and shared viewed progress. Font-size controls adjust code text and row spacing together and retain the preference locally. If complete source is unavailable, label the saved-hunk fallback honestly; never substitute current files for a historical snapshot.
- Use readable monospace code, restrained diff colors, clear selected/focus states and progressive disclosure. Keep navigation, details, and notes. Track viewed progress per unique file, shared across walkthrough and All changes: checking Viewed collapses that file outside File by file, unchecking reopens it, and manual disclosure state persists independently. Keep sidebar navigation shallow: one heading for a single-step group, a flat file/component list for the active step, and search revealing matching steps. Wrap names and path subtitles instead of cutting them off; retain full-path tooltips/accessibility labels. Represent each component once with compact Ruby/Template shortcuts; keep actual filenames in the diff tabs. Component navigation must reveal its header and tabs, which stay visible while scrolling its diff. Derive group completion from its files; do not replace partial file progress with a group checkbox. Never add a control that pretends to have a backend.
- Use the bundled GLightbox viewer for one-click visual-evidence previews and overview View code actions. Show media at its original pixel size inside a scrollable viewer rather than stretching it; code shows the complete related hunk with syntax highlighting, real source numbers and the comment range highlighted. Default code to split on wide screens and unified below 1200px, with Auto/Unified/Split overrides. Support keyboard activation, Escape/close and focus return; suppress review shortcuts while open. Embed the viewer CSS/JS and image data so a single HTML file works offline; keep videos in their native inline player.
- All changes renders full diffs grouped by responsibility. Keep Design/UI to markup and styles; JavaScript, helpers, presenters and view-only controllers belong in Frontend. Use `file_categories` only to correct ambiguous roles after inspecting the code. The logical walkthrough remains a separate reading order.
- Overview is a centered reading column up to 840px: What changed (explicit code comparison plus a short behavioral paragraph), review comments containing their QA evidence, compact Other flows checked previews, and a bottom User comments section. Keep report-revision updates separate and limited to one quiet sentence. The saved Overview always includes the Video QA prompt banner. During an active recording session, the served review replaces that banner with recording controls. Do not repeat findings as outcome cards. Each failure appears once as a review comment: a short journey, expected/actual result, and one visible evidence thumbnail. Clicking it opens the media and numbered steps together. Show up to four successful checks as a compact preview list, with more checks behind one disclosure. Never hide an unmatched failed flow. Keep the grouped walkthrough in the sidebar and metadata in Review details. Comments use one-column threads: file/range header, subject, concise body and evidence preview, a View code action opening the related highlighted diff in the shared fullscreen viewer, then actions. Distinguish types with a named icon, color and short meaning; show blocking status separately. Resolve collapses a conversation; Reopen expands it. This is browser-local progress for the snapshot/revision, never proof a finding was fixed. Copy for LLMs retains captured source and local resolution status, including resolved personal comments in combined copying. Copy for comment produces paste-ready GitHub/Linear text with location and reproduction but without source-code dumps or local resolution metadata. User comments is always available at the bottom, with Add comment for general notes, code-line comments, edit/delete, individual copying and Copy all for LLMs. Auto layout uses unified below 1200px and split above; explicit layout choices override it until Auto is selected again.
- Open every report on Overview by default, including saved revisions and the report served with its recorder. Restore notes and reading progress without restoring the last visited page; honor an explicit section URL hash. Keep the Video QA prompt card and existing video evidence directly visible on Overview. Show sharing controls only during a requested recording session.

Read [references/ui-guidelines.md](references/ui-guidelines.md) **only when changing the UI**, for dimensions, interaction details and the browser verification checklist. Routine reviews inherit these rules through the renderer without redesign work.

Within a walkthrough step, the renderer pairs changed `app/components/**/*_component.rb` and matching `.html.erb` sidecars under their path-derived component name, with per-file tabs and progress. Keep both in their owning behavior step when appropriate; never invent a companion diff or move unrelated behavior merely to create tabs. Single changed files and All changes retain ordinary file cards.

## Select scope

First discover existing history with `ruby <skill>/scripts/series.rb list --repo <root>`. When the user asks for an increment, follow-up or continuation, use the matching series and state its cumulative scope. Ask only if the series is ambiguous. An explicit request for only uncommitted files, one commit or a particular PR still controls the scope; do not silently replace it with a cumulative series. When offering scope choices, mention the matching saved series as an additional option. Fresh reviews still default to uncommitted changes.

On invocation without an explicit scope, inspect the workspace: review uncommitted changes when present; otherwise review the current branch's open PR when provider metadata identifies exactly one; otherwise ask whether to review a commit or another target. State the inferred scope before collecting. An explicit scope always wins. Confirm the target through the supplied path/current workspace; ask only if ambiguous. Read applicable repository instructions.

- **Uncommitted:** combined tracked working-tree state against HEAD (staged + unstaged), plus non-ignored untracked files. Explain that an edit staged and then reversed in the worktree is absent from the net diff; inspect `git diff --cached` separately if the user wants what will be committed.
- **Whole PR:** resolve live PR metadata with the authenticated provider CLI/connector. Use its actual base branch, including stacked PR bases; never assume main. Fetch exact base/head objects without checkout, then pass verified refs to the collector. Exclude uncommitted work. Record PR URL, base/head SHAs, checks and issue links. If provider access is unavailable, ask for the PR/base or offer a clearly labeled local comparison, not a claimed full PR review.
- **Specific commit:** resolve the requested SHA; compare to its parent. Root commits compare to the empty tree. For merges ask which parent unless specified. No checkout needed.

## Collect and inspect efficiently

Use `ruby <skill>/scripts/review.rb collect --repo <root> --mode uncommitted --brief --out <temporary-snapshot.json>`.
For other modes add `--mode commit --commit <sha>` (optionally `--base <parent>`), or `--mode pr --base <verified-base-ref> --head <verified-head-ref>`.

With `--brief`, the tool prints counts and omitted paths; the full snapshot stays in a temporary directory outside the project. Query its file/hunk manifest selectively while planning groups instead of pasting a large JSON listing into model context. It excludes `.reviews/`, marks likely secrets/binary/oversized patches as omitted, disables external diff helpers, and refuses unresolved conflicts. Renames are deliberately represented as deletion/addition to keep complete range coverage; explain moves together. Do not silently omit source files because they look generated. Inspect omissions separately when needed and accurately report coverage. The filename filter is not a secret scanner: check relevant content before embedding and redact exposed credentials, never copy secrets into a report.

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

## Fast report and optional visual evidence

Publish the complete code review as soon as the analysis and focused validation
are ready. Do not delay it for browser setup, video, or template examples. A
visual finding still needs the evidence required to support its claim: use the
smallest decisive browser check and attach a readable still when the behavior is
visible in one state. Capture a short video when timing, motion, or a sequence of
states is essential, or when the user requests video. Full template previews and
demonstration videos are optional enrichments; run them when the user requests
them, without a prerequisite question. A review with no optional media remains a
complete review. Do not set a pending QA status for work that was not requested or
planned.

For UI work requiring a browser, discover the local app and access path yourself
using [local app discovery](references/local-app-discovery.md). A supplied URL or
session takes priority. Ask one precise question only when multiple plausible
servers or an unresolved access boundary remain after inspection. Never ask the
user for a URL or test login before trying the project's documented setup,
running processes, routes, fixtures and safe development data.

For a plain review request, finish after publication and the normal report check.
Do not start the recorder, wait for optional requests, or create preview examples.
If the user also requested QA or previews, publish the code review first and
continue with those additions in the same turn. The Overview always offers a visible **Video QA** card with **Copy QA
prompt**. Changed templates offer **Add to previews**; the header **Previews**
list shows every template's state: Ready (rendered, with a New mark until opened),
Requested (copied, waiting for the next revision), Selected, and Not previewed.
Copying the prompt moves the selection to Requested, so the selection count returns
to zero. These controls work offline and only prepare text for the developer to
paste into a coding agent. Keep previews and QA separate; copying does not start work.

When the user pastes a visual prompt, continue the saved series. Read its latest
revision, verify the requested snapshot and checkout, and generate only the
requested additions. Preserve existing findings and evidence. If the code has
changed, review the delta before attaching new evidence. Batch finished additions
into one revision; skip a full code re-review when the snapshot is unchanged.

For QA requests, read [visual QA](references/visual-qa.md). The copied QA prompt
requests video. Choose the checks yourself from findings and changed user flows;
the developer does not need to write a QA plan. Link finding evidence to its
comment and keep other relevant walkthrough/flow checks compact. Honor an
explicit request for a different medium. Video uses the existing [tab recorder](references/tab-capture.md) and the
harness's visible computer-use pointer. Prepare the app, access and controllable
tab before opening the recorder; sharing needs no typed confirmation. Capture
the actual flow directly. No routine cursor probe, rehearsal video, synthetic
cursor, or per-session capability audit. Investigate recording only when the
requested capture actually fails. After attaching the batch, open the completed standalone report, then stop the helper.

For template previews, read [previews](references/previews.md). Validate the
selected files against the snapshot, render them in rolled-back savepoints and
attach with `series.rb previews --targeted`. Reuse project examples and assets.
Validate output and expected content before publication; use browser inspection
only to resolve a concrete rendering uncertainty, not to polish every example.

When both are requested together, use `series.rb enrich --targeted` with a JSON
object containing `qa` and `previews`. A full preview pass omits `--targeted` and
retains the full coverage gate. Publish one completed enhancement revision;
avoid pending and cosmetic correction revisions. Update validation statements
when new evidence changes them, and reassess findings only when warranted.

## Render and verify

For a fresh series, write review JSON in the same temporary directory as the snapshot, then:
`ruby <skill>/scripts/series.rb start --repo <root> --name <short-feature-slug> --snapshot <snapshot.json> --review <review.json>`.

This creates `.reviews/<slug>/index.html`, a compact `manifest.json`, `revisions/001.html`, and `current.html`. Subsequent publishes add immutable numbered HTML files and refresh the current view, revision browsing pages, and index. The dropdown opens `revision-NNN.html` browsing pages with all known revisions; `revisions/NNN.html` remains the immutable original snapshot. A series slug represents a feature or phase, not a commit SHA; its original base remains fixed across commits. The implementation's local `.lock` coordinates concurrent writes. No database, watcher, project script or per-revision asset folders are needed. Optional QA media is embedded in the offline HTML. Import an existing standalone report with `series.rb start --repo <root> --name <slug> --report <previous.html>`; preserve the old file and link.

For a requested UI refresh, use `ruby <skill>/scripts/series.rb refresh --repo <root> --name <slug>`. It rebuilds `current.html` and the revision browsing pages from saved reviews using the new assets and complete history, without inspecting new source or changing any original saved snapshot. When the user explicitly requests a new presentation revision, add `--record`: it saves the same captured code, analysis, and qualified QA evidence with a presentation-only revision note. Otherwise refresh creates no revision. Link this current view for the updated UI, and keep historical snapshots immutable.

For a standalone report or an explicitly requested presentation refresh, the original command remains available:
`ruby <skill>/scripts/review.rb render --snapshot <snapshot.json> --review <review.json> --name <short-related-slug>`.

The Ruby standard-library renderer enforces complete file/hunk and comment-range coverage, pairs replacement lines in split view, escapes code/data, embeds all CSS/JS, records snapshot metadata, and adds `/.reviews/` to Git's **local info/exclude** only if needed. It leaves tracked `.gitignore` unchanged and refuses tracked `.reviews` contents or a symlinked output directory. Standalone filename collisions receive a timestamp suffix; `--replace` is for an explicitly requested standalone presentation refresh. Never overwrite a saved series revision. The rendering uses bundled daisyUI 5.7.28 prebuilt CDN CSS and Prism 1.30.0; no npm, Python, gems, Tailwind browser compiler, CDN connection or build step is required at review time. Assets and licenses live in the personal skill; see [assets/vendor/SOURCES.md](assets/vendor/SOURCES.md) when updating them. Prepared snapshots, plans and update JSON stay in a temporary directory outside the project; each saved HTML contains its own complete snapshot and analysis.

Recollect just before delivery and compare fingerprints; if the changes moved, refresh affected analysis and regenerate. For an ordinary review, validate embedded JSON, assignment coverage, finding anchors and JavaScript syntax, then do one short browser smoke check of Overview, a representative diff and its comment when a browser is available. Run the full navigation, layout, keyboard and source-number checklist only when changing the renderer or investigating a concrete UI problem. If browser access is blocked, state that limit. Confirm `git check-ignore <report>` and source status unchanged. Clean up only scratch files created by this run.

For ordinary increments, reuse the already verified renderer; do not repeat its whole browser suite. Validate the merged data and scope, and perform a short navigation/comment smoke check when practical. When changing helpers, run `ruby scripts/test_review.rb` and `ruby scripts/test_series.rb`; the pure UI helper checks use `node scripts/test_ui.js` with no npm dependencies. When changing UI follow its maintenance guide. If `prepare` reports unchanged code/context, return the existing revision rather than creating another or claiming a fresh review. Use `publish --record` only for a requested reassessment with fresh conclusions, context or verification.

After final rendering and verification, open `current.html` or the standalone HTML path in the user's default browser. The saved file contains the report, previews and attached media and works without a server. Use the helper URL only during an active recording session; opening it and managing its lifecycle are the agent's responsibility. Before stopping it, open the final saved report so the user has a durable, reloadable result. If reusing an unchanged review with the legacy helper-only request controls, run `series.rb refresh` once to update its current presentation without adding a revision; otherwise open its existing HTML. Historical snapshots remain immutable. On macOS use `open <shell-quoted-path-or-URL>`; on other platforms use the available equivalent. If opening fails, deliver the file link and state the limit. Opening the report alone does not count as visual verification.

Return links to the saved revision and series history, the changes/findings since the previous run, and material validation limits. Point out the report's Copy QA prompt button and template preview selections when relevant. Keep helper setup out of user-facing instructions: the pasted prompt lets the agent prepare recording. In this skill, `publish` only saves local ignored files; it never posts externally. Report generation never implies permission to fix code or publish a remote review.

Design references (read once when evolving the skill, not every review): [CodeRabbit documentation index](https://docs.coderabbit.ai/llms.txt), [Walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), [Change Stack](https://docs.coderabbit.ai/pr-reviews/change-stack), [Slop Detection](https://docs.coderabbit.ai/pr-reviews/slop-detection).

File by file and Unified are the main review defaults. Place explicit File by file / Walkthrough reading controls beside Unified/Split inside the View menu; the main diff has no Auto option. Walkthrough retains the existing group steps; do not imply it is one infinite list. Keep the existing grouped sidebar visible on desktop, the file or step position in the reading-bar pager, and the current group and step in the sticky file header. Keep hunk explanations out of the source flow: a small note marker beside the line-number gutter on the first changed line opens a clearly labeled Review note popover. Use only the grouped sidebar for file selection; show a selectable current file path with Copy path in the reading header, without a competing file dropdown. Hide the unified table header visually while retaining accessible before/after line-number labels. Changed-section buttons navigate contiguous changed blocks separated by unchanged lines, including multiple blocks inside one Git hunk. Track the selected block explicitly across clicks, including when scrolling is clamped at the file bottom; resynchronize after manual scrolling. Use instant scrolling corrected for the sticky header, without wrapping, show the current section count and disable at boundaries. Viewed records progress without advancing or hiding the focused file; Next file remains a separate action. Explicit Overview/All changes links still open their respective screens.

In File by file, paired ViewComponents expose compact Ruby / Template navigation beside the current path, using the same component pairing within the existing review layer. Indicate the current file and preserve group order, viewed state and full-path copying. Show shortcuts only when both files exist in the reviewed scope; do not invent or load an unchanged companion.

Keep the file-reader header to two rows. The orientation row holds the group/step breadcrumb and the changed-section stepper. The file row holds the selectable full path with an icon-only copy button, component shortcuts, the preview chip, a quiet Why this file disclosure, and Viewed plus Next file at its end. Do not repeat the file position the pager already shows. Preserve full names by wrapping, and keep change navigation correct when the sticky header height changes.

Keep header controls clustered rather than stretching them across the available width. Make Mark viewed a visibly clickable checkbox action, with a separate Next file button; checking it must not advance automatically. Wrap these clusters naturally on mobile.

Reading mode is a browser preference separate from the current destination. Overview and All changes must not change File by file / Walkthrough. Persist explicit mode choices in local storage and apply them when returning to a review group or file; default to File by file when no preference is saved.

Position File by file review notes beside their own changed-line marker, flipping above or to the left when space is tight and clamping to the viewport. Reposition on scroll and resize, and close when the marker leaves the code viewport. Do not park notes in a screen corner.

Place the File by file Review note marker at the left of the first changed line's line-number gutter, beside the current-section stripe and aligned with comment markers. If that gutter has a comment marker, use the other line-number gutter; never overlap a comment or line number.

Review notes use the same bounded popover shell and below/right placement as review comments, with the same close affordance and viewport behavior. Use a distinct note icon and a subtle popover tint drawn from the current-section gutter color. Keep the comment-only source-range highlight out of review notes.

Inside each numbered review step, show implementation files first, then one quiet Tests divider and that step’s test files. Keep File by file navigation in the same order. Extend the current-section gutter stripe through every changed row in the selected contiguous block, stopping at unchanged context.

With complete captured source, File by file lets personal comments select any old/new line or same-side range across the full file, including unchanged context between hunks. The diff-only fallback keeps hunk-bounded selection. Clicking a Review note selects and scrolls to its changed section. Give an active user selection visual priority over the current-section stripe and diff colors.
