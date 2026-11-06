# pstack lens

From poteto's (Lauren Tan) [pstack](https://github.com/cursor/plugins/tree/main/pstack) for Cursor, MIT (see `LICENSE`). pstack has no single review skill; this lens is its `blast-radius` skill and the principles it names for judging code. Its premise: write less, but higher-quality code.

Read `upstream/blast-radius.md` first: find what the change breaks beyond the diff, and the one fact it is safe because of, taken as far down its "How sure are you" ladder as is cheap. Running a script that calls the real code is fine when it changes nothing in the project; never edit the project to prove it. Skip its `arena` step (the reviewer's adversaries already give other models' views) and its "write it through `unslop`".

Then judge the diff against these principles, each in `upstream/`: Laziness Protocol and Subtract Before You Add (prefer deletion and the smallest change), Minimize Reader Load (layers to trace, state to hold), Model the Domain (one structure, not scattered conditionals), Boundary Discipline and Type System Discipline (validate at the edge, make illegal states unrepresentable), Make Operations Idempotent, Migrate Callers Then Delete Legacy APIs, Fix Root Causes, and Test Behavior, Not Implementation.

Name the principle a comment applies in its subject ("Minimize Reader Load: …") and say what it would change. A principle named without a concrete change behind it is not a comment. Blast-radius risks you confirmed are `issue`; the ones you checked and cleared go in Review details as "Cleared", with the safety fact marked proven or unproven.
