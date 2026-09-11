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
- Keep the 320–340px desktop sidebar with full-width, wrapping step buttons. Give the remaining width to the code. Split mode has equal code columns, paired rows and independent real old/new source numbers; narrow screens scroll the comparison horizontally instead of stacking its sides.
- Comments use visible, keyboard-operable gutter markers on the correct side and first source line. Open a bounded 390px popover near that marker, highlight the exact inclusive range, and preserve code row alignment. Never insert screen-wide comment rows. Support grouped comments, Copy comment, Escape, outside-click dismissal and returning keyboard focus.
- Use readable monospace code, restrained diff colors, clear selected/focus states and progressive disclosure. Keep the existing navigation, details dialog, notes and viewed-state behavior. Never add a control that pretends to have a backend.
- All changes renders full diffs grouped by responsibility. Keep Design/UI to markup and styles; JavaScript, helpers, presenters and view-only controllers belong in Frontend. Use `file_categories` only to correct ambiguous roles after inspecting the code. The logical walkthrough remains a separate reading order.
- Overview comments use one-column threads: file/range header, initially visible syntax-highlighted source, then the comment body and actions. Distinguish types with a named icon, color and short meaning; show blocking status separately. Resolve collapses a conversation; Reopen expands it. This is browser-local progress for the snapshot/revision, never proof a finding was fixed. Copy for LLMs retains captured source and local resolution status, including resolved personal comments in combined copying. Personal comments appear under Your review. Auto layout uses unified below 1200px and split above; explicit layout choices override it until Auto is selected again.

Read [references/ui-guidelines.md](references/ui-guidelines.md) **only when changing the UI**, for dimensions, interaction details and the browser verification checklist. Routine reviews inherit these rules through the renderer without redesign work.

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

Group by **user outcome or domain responsibility**, not top-level directory or file extension. A group can contain data model, service, UI and test files if they jointly deliver one behavior. Separate independent outcomes. Order layers by dependencies: storage/contracts → behavior/integration → verification where appropriate. Keep tests next to the behavior they establish when it improves comprehension. A file spanning multiple concerns can appear in multiple layers, with each hunk assigned exactly once. Use as few layers as the change warrants.

For each group explain, in 2–4 plain sentences: what changes for the user/system, why these files belong together, and the boundary that stays elsewhere. Each diff range needs a short behavioral summary rather than restating syntax. Add a flow diagram only for meaningful interactions; the template renders `flow` steps offline. For branching/sequence/state/ER diagrams that genuinely add information, extend the personal renderer with inert SVG or pre-render SVG into the HTML; do not depend on CDN Mermaid or leave unrendered diagram text as the sole visual.

Include:
- High-level outcome, grouped walkthrough and review effort **1–5** with a reason (not a fake time prediction).
- Inline feedback in [Conventional Comments](https://conventionalcomments.org/) format: `label (blocking/non-blocking): subject`, with a short explanation when useful. Use `note` for behavior worth understanding, `question` for unresolved context, `suggestion` for an improvement, and `issue` for a substantiated defect. No artificial quota. Each comment must identify its hunk, old/new side, and exact inclusive line range; prefer a small coherent block. The UI shows a gutter marker at the range's first line and opens its comment in a compact popover, marking every covered line. Keep subjects short and discussions to one concise paragraph when possible. Do not restate every hunk summary as a comment.
- Actionable findings ordered P0–P3, with a concrete trigger, consequence, precise changed hunk, confidence and minimal suggested direction. Verify against surrounding code. Distinguish introduced defects from pre-existing architecture and optional improvements. No minimum finding quota.
- Quality / “slop” assessment: evidence of redundant abstractions, duplicate logic, misleading comments, invented requirements, empty tests or unrelated churn. Do not infer authorship or label code defective for being verbose. Say when no concrete signal was found.
- Tests actually run with outcomes, tests inspected, tests not run and why; include uncovered material risks. Follow repository test workflow. Avoid creating tests that merely repeat implementation.
- Related/linked issue assessment when available: met/partial/unmet/unknown with evidence, evaluated only within selected scope. Local uncommitted review is not whole-issue sign-off. Issue-tracker connectors can provide issue/spec context when configured; provider-specific guide/diff tools are optional, never prerequisites. Read linked sources only as needed. Bound optional enrichment to linked issues and a few precise history lookups; do not scan the organization's backlog.
- Related PRs, suggested labels and reviewers when supported by live metadata, CODEOWNERS (last matching rule wins), or focused history. They are suggestions only; do not assign, comment, push or mutate external services. Mark unavailable or skipped context explicitly.
- Snapshot/coverage limitations and genuine before-merge/deployment actions, separate from code findings. No simulated live CI, chat, native review submission, semantic symbol lookup or remote progress sync. Omit poems/fortunes by default because this is a focused review artifact; add only if requested.

## Optional visual QA: publish the review first

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

Use an isolated browser tab/session through the available harness. Save its native
screenshot output directly as report evidence; screenshots do not require video
recording support or a separate capture system. Capture a few
important states with short action captions, and attach relevant evidence to
UI/UX comments. Prefer these pictures over long descriptions of visible defects.
Never record the user's desktop or require them to keep a window foregrounded.
Background video is optional: use it only if the tool explicitly supports
isolated recording. Otherwise deliver an honestly labelled screenshot walkthrough,
not a simulated screencast. Finish with complete, partial, blocked or skipped
status; never leave pending as the final status of an attempted QA pass. A completed
visual QA pass must contain embedded media. Verify the current HTML includes the
expected assets, then link it again and remind the user to reload an open report.

## Render and verify

For a fresh series, write review JSON in the same temporary directory as the snapshot, then:
`ruby <skill>/scripts/series.rb start --repo <root> --name <short-feature-slug> --snapshot <snapshot.json> --review <review.json>`.

This creates `.reviews/<slug>/index.html`, a compact `manifest.json`, `revisions/001.html`, and `current.html`. Subsequent publishes add immutable numbered HTML files and refresh the current view and index. A series slug represents a feature or phase, not a commit SHA; its original base remains fixed across commits. The implementation's local `.lock` coordinates concurrent writes. No database, watcher, project script or per-revision asset folders are needed. Optional QA media is embedded in the offline HTML. Import an existing standalone report with `series.rb start --repo <root> --name <slug> --report <previous.html>`; preserve the old file and link.

For a requested UI refresh, use `ruby <skill>/scripts/series.rb refresh --repo <root> --name <slug>`. It rebuilds `current.html` from the latest saved review using the new assets, without inspecting new source or changing any saved revision. Link this current view for the updated UI, and keep historical snapshots immutable.

For a standalone report or an explicitly requested presentation refresh, the original command remains available:
`ruby <skill>/scripts/review.rb render --snapshot <snapshot.json> --review <review.json> --name <short-related-slug>`.

The Ruby standard-library renderer enforces complete file/hunk and comment-range coverage, pairs replacement lines in split view, escapes code/data, embeds all CSS/JS, records snapshot metadata, and adds `/.reviews/` to Git's **local info/exclude** only if needed. It leaves tracked `.gitignore` unchanged and refuses tracked `.reviews` contents or a symlinked output directory. Standalone filename collisions receive a timestamp suffix; `--replace` is for an explicitly requested standalone presentation refresh. Never overwrite a saved series revision. The rendering uses bundled daisyUI 5.7.28 prebuilt CDN CSS and Prism 1.30.0; no npm, Python, gems, Tailwind browser compiler, CDN connection or build step is required at review time. Assets and licenses live in the personal skill; see [assets/vendor/SOURCES.md](assets/vendor/SOURCES.md) when updating them. Prepared snapshots, plans and update JSON stay in a temporary directory outside the project; each saved HTML contains its own complete snapshot and analysis.

Recollect just before delivery and compare fingerprints; if the changes moved, refresh affected analysis and regenerate. Test the resulting navigation, unified/split diffs, J/K/Z, search, finding anchors, notes and viewed state with an available browser. Validate helper behavior with `ruby <skill>/scripts/test_review.rb` when changing helpers. Check split replacement pairing, old/new line numbers, syntax token colors, comment placement and range highlighting, and actual sidebar/code widths—not just the presence of buttons. If browser access is blocked, do not claim visual verification. At minimum validate embedded JSON, assignment coverage and JavaScript syntax; state if browser testing was unavailable. Confirm `git check-ignore <report>` and source status unchanged. Clean up only scratch files created by this run.

For ordinary increments, reuse the already verified renderer; do not repeat its whole browser suite. Validate the merged data and scope, and perform a short navigation/comment smoke check when practical. When changing helpers, run `ruby scripts/test_review.rb` and `ruby scripts/test_series.rb`; the pure UI helper checks use `node scripts/test_ui.js` with no npm dependencies. When changing UI follow its maintenance guide. If `prepare` reports unchanged code/context, return the existing revision rather than creating another or claiming a fresh review. Use `publish --record` only for a requested reassessment with fresh conclusions, context or verification.

Return links to the saved revision and series history, the changes/findings since the previous run, and material validation limits. In this skill, `publish` only saves local ignored files; it never posts externally. Report generation never implies permission to fix code or publish a remote review.

Design references (read once when evolving the skill, not every review): [CodeRabbit documentation index](https://docs.coderabbit.ai/llms.txt), [Walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), [Change Stack](https://docs.coderabbit.ai/pr-reviews/change-stack), [Slop Detection](https://docs.coderabbit.ai/pr-reviews/slop-detection).
