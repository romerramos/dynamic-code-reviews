# Matt Pocock lens

Matt Pocock's `code-review` from [mattpocock/skills](https://github.com/mattpocock/skills), MIT (see `LICENSE`). Two axes kept apart: **Standards** (the repository's documented coding standards, plus a fixed baseline of Fowler code smells) and **Spec** (the originating issue).

Read `upstream/code-review.md`. Take from it: step 2's order for finding the spec (you already read the plan; use what it found), step 3's standards sources and the whole smell baseline with its two rules (the repository overrides it; every smell is a judgement call), and both sub-agent briefs as the questions you ask of the diff.

Do the two axes yourself, one after the other, without sub-agents and without `/setup-matt-pocock-skills`: the diff and the issue are already collected. Keep them apart the way the skill asks: start each comment's subject with `Standards:` or `Spec:`, and do not let a pass on one axis soften a failure on the other. A documented-standard breach can be `issue`; a smell is at most `suggestion (non-blocking)` named as "possible <smell>". A missing or wrong requirement is `issue`; behaviour nobody asked for is `question` unless it causes harm. When there is no spec, say so in Review details and review Standards only.
