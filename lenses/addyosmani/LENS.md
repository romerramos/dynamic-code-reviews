# Addy Osmani lens

Addy Osmani's `code-review-and-quality` from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), MIT (see `LICENSE`). A five-axis review: correctness, readability and simplicity, architecture, security, performance.

Read `upstream/code-review-and-quality.md`. Take from it: the five axes, Structural Remedies, Step 1 (context), Step 2 (tests first), Step 4's rule to check each finding against callers, guards and tests before reporting it, "Lead with what matters", Honesty in Review, Red Flags and the presumptive blockers. Read `upstream/security-checklist.md` only when the change touches a security boundary and `upstream/performance-checklist.md` only when it touches a hot path or a growing table.

Leave out what is not about judging this diff: Change Sizing and Change Descriptions (unless the size or the description is itself the problem), Review Speed, Multi-Model Review Pattern (the reviewer's adversaries already do that), Dead Code Hygiene's "ask before deleting", Dependency Discipline unless a dependency changed, and the checklist and verdict format. Step 2's mutation experiment edits files: reason about whether a test would fail instead.

Its severity prefixes map to Conventional Comments: **Critical** is `issue (blocking)`, no prefix (required) is `issue (blocking)` or `suggestion (blocking)`, **Optional** / **Consider** is `suggestion (non-blocking)`, **Nit** is `nitpick (non-blocking)`, **FYI** is `note`.
