# Incremental review workflow

A series belongs to one checkout, branch and fixed comparison base. Each revision
stores the complete cumulative diff and analysis in one standalone HTML file.
The index and manifest track history; `current.html` is a refreshable view of the
latest saved review. Each HTML embeds its captured data. Rebuilding HTML is cheap. Reusing supported
explanations is what saves model tokens.

## Continue a series

```sh
ruby <skill>/scripts/series.rb list --repo <root>
ruby <skill>/scripts/series.rb prepare --repo <root> --name <feature> --out <scratch>
```

Use a temporary directory outside the repository. This writes:

- `plan.json`: file classifications, reusable old→new range mappings, patches
  requiring inspection, unmatched previous ranges, changed recorded context,
  previous findings and comments whose anchors need rechecking.
- `snapshot.json`: the full current cumulative snapshot for the renderer.
- `draft.json`: previous group/layer explanations and uniquely matched summaries
  with current IDs. Unsafe comments are removed; matching ranges are remapped.
  Previous test results, findings, quality and issue conclusions are cleared.

Read the compact printed manifest and relevant plan fields first. Do not dump
all three files into model context. Use Ruby/`rg` to read selected sections of
the draft when needed. Inspect changed ranges, changed file metadata (including
executable bits in `metadata_before`/`metadata_after`), and relevant dependencies;
reuse unchanged prose only after considering those relationships. Unmatched
previous ranges may have been edited, merged, split or removed, not just fixed.

The original base remains pinned. Working series include committed changes
since that base plus current staged/unstaged state and nonignored untracked
files. This deliberately differs from a fresh uncommitted-only review. State
that scope when continuing. A commit with identical reviewed content needs no
new revision. A changed branch or rewritten history requires selecting the
correct series or creating a new baseline; do not reset/rebase Git to make a
review fit.

For a PR-origin series, resolve live provider metadata again and pass both
`--base <verified-base-ref> --head <verified-head-ref>`. Working edits are then
excluded. If the effective merge base changed, start a new baseline series;
never present an old-base cumulative review as a current full PR review.

## Write only the increment

`draft.json` uses stable group and layer IDs. New snapshots still use local file
and hunk IDs; always take current IDs from the prepared plan. A small update:

```json
{
  "since_previous": "CSV export now handles an empty selection. The download group is unchanged.",
  "review": {
    "coverage": "Inspected the two changed ranges and the export caller; reused unchanged download explanations.",
    "validation": ["Focused regression test passed on this revision."],
    "sections": [{"title": "Quality assessment", "body": "No new concrete quality concerns found in the inspected increment."}]
  },
  "items": [{
    "group": "group-2",
    "layer": "group-2-step-1",
    "file": "f3",
    "summaries": {"f3h1": "Return a header-only CSV when no tasks are selected."}
  }],
  "comments": [{
    "id": "empty-selection",
    "hunk": "f3h1", "side": "new", "start": 42, "end": 45,
    "label": "note", "decoration": "non-blocking",
    "subject": "An empty selection still produces a valid file",
    "discussion": "The exported file retains its column headers even without task rows."
  }],
  "finding_updates": [{
    "id": "F1", "status": "resolved",
    "reason": "The new empty-selection branch returns valid CSV; the focused regression covers that outcome."
  }],
  "context_paths": ["src/export_tasks.js"]
}
```

Only use assertions supported by the actual code and verification. The example
IDs and outcomes are illustrative.

Update operations:

- `review`: replace supplied top-level title, headline, summary, effort, coverage,
  validation, sections, flow or `file_categories` path overrides. Refresh any overall description made stale by
  the increment. **Current coverage and validation are mandatory**; explicitly
  say when tests were not run. Refresh linked-issue and quality assessments as
  appropriate; the draft does not carry them forward as current conclusions.
- `items`: merge new hunk summaries into an existing group/layer/file item, or
  create that file item. Unchanged mapped summaries stay intact. Empty-hunk
  files need an item and an accurate omission/metadata explanation too.
- `groups`: add or replace complete groups by stable `id`, with the normal group
  schema plus unique IDs on every layer. Use this when new work changes the
  explanation or reading order. `remove_groups` removes IDs explicitly.
  To move already-mapped ranges between groups, replace the affected groups so
  each hunk still appears exactly once. Empty layers/groups are pruned.
- `comments`: add or replace by stable comment ID; `remove_comments` removes
  IDs. Matching comments were only mechanically remapped: reassess their meaning
  if connected behavior changed. Inspect `comments_to_recheck`; re-anchor or
  explicitly account for relevant comments in the increment summary.
- `finding_updates`: every previously open anchored finding requires a decision.
  `open` requires the full current finding object (`hunk`, severity, title,
  body, confidence where available); `resolved` requires concrete evidence in
  `reason`; `needs-rechecking` retains an unanchored concern without claiming
  resolution. Each decision has a stable `id` and `reason`. New findings use
  unused IDs with `status: "open"` and a current finding object. Reopen an old
  finding with its existing ID. Historical resolved/unanchored states persist.
- `context_paths`: additional repository-relative files actually consulted as
  evidence. Prior tracked paths remain tracked automatically. Hashes are saved
  without source content. A changed recorded path conservatively invalidates
  all range reuse for the next increment; a future optimization may narrow this
  to dependencies with explicit evidence. Unrecorded dependencies, external
  issue changes and runtime conditions still require reviewer judgment.

Unique path plus exact hunk content is required for automatic reuse. Matching
ignores hunk header offsets and sequential IDs; comment lines move by the verified
old/new offsets. Ambiguous duplicate content, changed context, split/merged
hunks and renames receive fresh inspection rather than guessed anchors.

## Save and verify

```sh
ruby <skill>/scripts/series.rb publish --prepared <scratch> --update <update.json>
```

The command merges the update, validates complete coverage and comment ranges,
checks current source/context against preparation, and refuses a stale parent
revision. `publish` is a local filesystem operation. It saves the next immutable
`revisions/NNN.html`, refreshes `current.html`, updates `index.html` and atomically advances `manifest.json`.
If interrupted after creating a revision but before the manifest advances,
preserve the orphaned report and inspect the files; never overwrite it blindly.

No changes: return the existing latest report. If the user requested an explicit
reassessment (new test evidence or refreshed external context, for example),
provide fresh conclusions and use `--record`. Never manufacture a code increment
just to demonstrate history. Browser notes and viewed marks are revision-local;
they are not silently copied as approval of changed code.

The revision selector opens refreshable `revision-NNN.html` browsing pages.
Every publish or refresh rebuilds these pages with all known revisions, so an
older review can navigate forward again. Its captured code, analysis, and local
notes identity remain tied to that revision. `revisions/NNN.html` preserves the
immutable original HTML, available through Original saved snapshot. Older
original snapshots may have the old UI; use the index or current view to browse.
The whole series folder preserves navigation when copied; an individual HTML
still renders independently, but sibling history links then need those files.

For UI-only changes, `series.rb refresh --repo <root> --name <feature>` rebuilds
`current.html` and every revision browsing page from their saved snapshots and
analysis, with the complete revision selector. This does not create
a revision, change historical HTML, or claim to review current working files.
The index's Latest review link uses the refreshed current view; Saved snapshot
opens the immutable original rendering.

## Start or import

For a fresh review, use the normal collector and authoring schema, then:

```sh
ruby <skill>/scripts/series.rb start --repo <root> --name <feature> --snapshot <snapshot.json> --review <review.json>
```

Include `context_paths` in the initial review JSON for consulted dependencies.
An existing report can be imported with `--report <existing.html>` instead of
snapshot/review. It remains untouched. The first revision is explicitly labeled
an imported starting point, with its original capture and validation history.
Legacy reports have no dependency hashes; treat that as a coverage limitation,
not proof that surrounding context has stayed unchanged.
