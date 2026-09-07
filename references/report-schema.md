# Review JSON

All prose is plain text, escaped by the renderer. Do not include HTML or duplicate patch text. IDs come from collector output. Every collected file must occur in `items`; each hunk ID must occur **exactly once** in `summaries` across all items. Files with no hunks still need an item, with an omission/metadata explanation. Empty snapshots use an empty groups list. Each group title should be unique.

```json
{
  "title": "Downloadable task lists",
  "headline": "Export the current task list as a CSV file",
  "summary": "Explain the before/after behavior in a few sentences.",
  "effort": {"score": 3, "reason": "Input validation and download behavior require cross-file reading."},
  "coverage": "All 5 files and 8 hunks inspected; export behavior checked against its specification.",
  "validation": ["git diff --check: passed", "Behavioral tests: not run; runtime unavailable"],
  "flow": ["Select tasks", "Validate selection", "Build CSV", "Download file"],
  "groups": [{
    "title": "Export the selected tasks",
    "summary": "Explain the shared outcome and why these files belong together.",
    "layers": [{
      "title": "Build the CSV content",
      "summary": "Explain this step in the group's reading order.",
      "checks": ["Only selected tasks appear in the export"],
      "flow": [],
      "items": [{"file": "f1", "summary": "Optional file-level context.", "summaries": {"f1h1": "Explain the behavioral effect of this exact range."}}]
    }]
  }],
  "findings": [{"severity": "P2", "confidence": "high", "title": "Short actionable title", "body": "Concrete trigger, consequence, evidence and suggested direction.", "hunk": "f1h1"}],
  "sections": [{"title": "Quality assessment", "body": "Evidence-based judgment.", "items": ["Optional parallel detail"], "links": [{"label": "Linked issue", "url": "https://example.com/issues/1"}]}]
}
```

Use an empty findings array when none are substantiated. Add sections for linked issue assessment, related PRs/reviewers/labels, verification boundaries, and activation actions as appropriate. Links only accept HTTP(S). The report supports offline navigation, ranges with old/new line numbers, unified/split diffs, J/K/Z keys, inline Conventional Comments, file search, browser-local notes and viewed layers. It does not implement whitespace-insensitive diff, semantic diff or live provider integration.

The HTML embeds `{snapshot, review}` as inert JSON in `<script id="data" type="application/json">`. This is also the portable snapshot for later comparison. A series has a small manifest and history index alongside immutable HTML revisions; prepared analysis files stay outside the repository. Browser notes are keyed by snapshot and series revision; they are not automatically carried to changed revisions. Export notes is a user-triggered download.

For a new series, optionally supply top-level `context_paths` listing repository-relative callers, tests or instructions actually inspected. The series helper records their fingerprints. Group/layer IDs and finding IDs are assigned on first save when missing; future updates use those stable IDs. `review.history` and `review.context` are helper-owned metadata. Use [incremental-reviews.md](incremental-reviews.md) for follow-up update JSON; do not author these metadata fields by hand.

## All changes categories

All changes displays full diffs in responsibility groups, independently from the
walkthrough's logical groups. Default routing is deterministic. Optional
`file_categories` maps **paths** to `Design / UI`, `Frontend`, `Backend`,
`Documentation`, `Tests`, `Platform`, `Security`, `AI`, or `Other`:

```json
{"file_categories": {"app/controllers/previews_controller.rb": "Frontend"}}
```

Use this only when inspection establishes a different responsibility. Controllers
default to Backend; a controller that only serves views can be Frontend. Mixed
business and presentation controllers stay Backend. Helpers and presenters are
Frontend. Database migrations, schemas and seeds belong to Backend. Platform is
deployment, CI, development/runtime configuration and build tooling; a YAML or
shell extension alone does not make a file Platform. Design/UI accepts only HTML/HTML ERB and CSS/SCSS/Sass; JavaScript cannot
be assigned there even by override. Security and AI roles can be explicitly
assigned where filenames do not reveal them. Categories are navigation aids,
not risk scores or permission to skip review. Each file appears once in this view.

Reviewer calibration (including business size) does not belong in report prose.
Legacy "Review standard" sections are excluded from new rendered payloads.

## Personal comments and copying

The browser UI owns personal comments; do not put them in model-authored review
JSON. Select a line number, optionally select a second line in the same hunk and
side, then choose Comment. Before and After are distinct sources. Ranges cannot
bridge omitted context or different files; use separate comments for those cases.
Users can edit/delete their comments, see them under Your review, and copy their
whole review including general step notes. Every generated/personal comment has
Copy for LLMs with path, source side, source revision/capture, numbered snippet
and Conventional Comment. Finding copies identify their snippet as the related
hunk rather than claiming a more precise range than was provided.

Personal comments and notes persist in browser storage when available, scoped to
this snapshot/revision. They do not sync or publish externally. Copy for LLMs and
Export local notes provide portable copies; moving the file/browser may not carry
browser storage. Clipboard failures show selectable text rather than pretending
the copy succeeded.

## Inline Conventional Comments

Add an optional top-level `comments` array. Every comment is attached to one
collected hunk and an inclusive range of **real source line numbers**, not diff
row indexes. Use `side: "old"` for removed code and `side: "new"` for added or
remaining code. The renderer rejects ranges outside the captured side.

```json
{
  "comments": [{
    "id": "csv-headers",
    "label": "note",
    "decoration": "non-blocking",
    "subject": "Empty exports retain their column headers",
    "discussion": "A header-only CSV still describes the exported fields.",
    "hunk": "f3h1",
    "side": "new",
    "start": 12,
    "end": 16
  }]
}
```

IDs must be unique letters/digits/hyphens. Supported labels follow
[Conventional Comments](https://conventionalcomments.org/): issue, suggestion,
question, note, praise, nitpick, todo, thought, chore, typo, polish, quibble.
Always choose `blocking` or `non-blocking` explicitly. Notes, praise, thoughts
and preference-level nitpicks should be non-blocking. Findings remain a separate
list for confirmed defects; do not inflate that list with explanatory notes.
A finding may have a corresponding comment when precise inline discussion helps.

The comment has a gutter marker beside its first source line on the specified
side. Clicking or keyboard-activating the marker opens a compact popover near
the code and highlights every covered line. Comments sharing the same anchor
use one marker and appear together. Escape, the close button or an outside click
dismisses the popover; it never inserts rows into the comparison. “Copy comment”
copies the conventional format without posting anywhere. Keep subjects short
and discussions to one concise paragraph when possible. No HTML or positioning
data belongs in the review JSON; the renderer owns this interaction.

## Presentation and snapshot data

The Ruby renderer derives `rows.unified` and `rows.split` for each hunk. Do not
write or edit these arrays yourself. Split rows pair removal/addition blocks;
pure additions and deletions have an empty opposite cell. Each side retains its
own line numbers, including when replacements have unequal lengths. Native table
columns stay side by side, with horizontal scrolling on narrow screens.

Prism highlights each hunk side as a block and distributes its tokens over source
lines. This preserves multiline strings/comments within the captured context;
a hunk starting midway through a token may lack context to highlight perfectly.
The bundled languages are Ruby, JavaScript, TypeScript, HTML/XML, CSS, SQL, JSON,
YAML and shell. No runtime language download occurs.

The report uses daisyUI precompiled CDN assets embedded inline, a 320–340px desktop
navigator, collapsible file cards, a details dialog, and local notes. `ruby
scripts/review.rb extract --report <file.html> --out <payload.json>` recovers a
previous report's captured snapshot and analysis for reuse. Use `--replace` when
refreshing an existing report's UI; otherwise filenames receive a timestamp.
