# Dynamic Code Reviews lens

The default lens: this skill's own calibration, with the parts of four review skills that catch what a plain read of the diff misses. Addy Osmani's code-review-and-quality gives the axes and the structural checks, Matt Pocock's code-review the spec axis and the smell baseline, obra's Superpowers reviewer the "declined to judge" list, and poteto's pstack the blast radius and reader load. Each is in this folder's siblings, with its license, when you want it whole.

## Calibrate to the project

Infer the project's purpose, language, framework, workload and risk from the change, repository instructions and user context. When scale is unknown, favor straightforward solutions suited to a small or medium project: the idioms of the actual stack, plain control flow, the smallest maintainable change. Do not demand hyperscale architecture, broad abstractions, speculative caching, new background infrastructure or micro-optimizations. A performance finding needs evidence of a bottleneck, unbounded work, expensive database access or a plausible hot path at the current workload; state the trigger and the practical impact.

Scale never excuses broken access control, exposed credentials, financial errors, data loss or missing legally required controls. Trace those boundaries where the project has them. Flag a compliance obligation only when the task or an authoritative source establishes it. Prefer a small fix over a redesign; mark worthwhile follow-ups non-blocking.

## What to look for

Read each changed hunk with these questions, in this order of weight. One structural problem outweighs ten nits.

1. **Correctness.** Edge cases (empty, nil, boundary), error paths, state that can go out of sync, ordering and retries. What happens on the second run, the failed run, the concurrent run?
2. **Spec.** From the plan you read: what was asked and is missing or partial; behaviour nobody asked for (scope creep); what looks implemented but is wrong. The spec is a vision document: where it is silent, what a reasonable user would expect is still a requirement.
3. **Blast radius.** What this breaks outside the diff: callers, serialized payloads, database columns, flags, other services. Find the one fact the change is safe because of and check it at the line that proves it; say plainly when you could not.
4. **Structure.** Does a refactor reduce complexity, or only move it? Count what a reader must hold: layers between the question and the answer, and hidden or mutable state. Look for a conditional bolted onto an unrelated flow, feature logic in a shared module, a near-duplicate of a helper the codebase already has, a wrapper with one caller, a silent fallback that hides an unclear invariant, a file pushed well past a healthy size. Name the move that fixes it (inline the wrapper, reuse the helper, move the logic to its owner), not just the problem.
5. **Smells**, always as a labelled judgement call ("possible Feature Envy"), never a hard violation, and only where the repository's own standards do not say otherwise: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.
6. **Quality and slop.** Redundant abstractions, duplicate logic, misleading comments, invented requirements, empty tests, dead code left behind, unrelated churn. Do not infer authorship or call code defective for being verbose. Report only concrete concerns.

Skip anything a linter or formatter the project runs already enforces. A documented repository standard always wins over this lens.

## Before you post

- Check the finding against the callers, guards and tests that reach the changed code; drop it if they rule it out.
- Separate defects this change introduces from debt that was already there.
- No quota for findings, praise, optimization or test suggestions. Zero findings is a valid review.
- Keep a short list of what you considered and set aside as outside the plan or the scope, one line each with the reason, and put it in Review details as a section titled "Declined to judge", so nothing is dropped silently. Leave it out when it is empty.

## Tests

- A test should assert a durable, observable outcome or a real regression boundary, not patch history, private implementation shape or invented requirements.
- Detailed encoding, header or format checks belong at the narrowest unit that owns them; integration tests cover their own outcome without repeating them.
- Reuse coverage that already protects the behaviour. More factories for the same assertion at several layers is not quality; test count and line ratios are not targets.
- Suggest a test only when you can name the behaviour that would break and why current coverage would miss it. Ask of each new condition: would any test fail if it were flipped? Reason it out from the tests; do not edit files to find out. Security, money, concurrency and data-loss boundaries can justify targeted extra coverage; a concurrency harness needs a real invariant, not a hypothetical race.
- When unneeded implementation created an artificial scenario, suggest removing it rather than cementing it with tests.
