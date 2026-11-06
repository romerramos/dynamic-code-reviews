# Superpowers lens

The code reviewer from Jesse Vincent's [obra/superpowers](https://github.com/obra/superpowers) `requesting-code-review` skill, MIT (see `LICENSE`). A senior reviewer's pass against the plan: plan alignment, code quality, architecture, testing and production readiness.

Read `upstream/code-reviewer.md`, the prompt inside its fenced block. Take from it: "The spec is a vision document", "Declined to judge", What to Check, Calibration and the Critical Rules. You are the reviewer it describes; the plan is the one you read, and the range is the collected diff.

Put the "Declined to judge" list in Review details as a section with that title. Its read-only rule already holds here. Its output format becomes this review's: Strengths go in `praise` comments only where they are specific (no quota), Critical is `issue (blocking)`, Important is `issue` or `suggestion (blocking)`, Minor is `suggestion` or `nitpick (non-blocking)`, and the Assessment's verdict goes in the review's one-sentence summary.
