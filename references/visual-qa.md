# Report-first visual evidence

Use only when the diff suggests a specific visual state or user interaction worth
checking: clipping, layout, validation, focus, navigation, loading, or error states.
Backend-only work needs no decorative browser captures. Choose a few high-value
states and a short flow; avoid exhaustive screenshots or full-session recordings.

The Video QA banner copies a complete request. Derive the QA plan from saved
findings, walkthroughs and changed user flows. Attach finding evidence with its
comment_id; retain relevant successful flows in Other flows checked.

## Publish first; capture only useful evidence

1. Complete the code review and identify the specific visual behavior, expected
   result and relevant source/comment anchor. For a visible finding, run the
   smallest check that proves or falsifies it. For optional demonstration media,
   publish and link the report immediately; a missing runtime must not hold up
   the code conclusions. Do not create an `awaiting-environment` task merely
   because UI files changed.
2. Discover the app and login path with
   [local-app-discovery.md](local-app-discovery.md). Use a supplied URL/session
   first, then project configuration, listeners, safe HTTP probes, routes,
   fixtures and synthetic development data. Ask only about a specific remaining
   ambiguity or access boundary. Verify the runtime matches the reviewed head;
   otherwise qualify the evidence.
3. Choose the lightest medium that shows the behavior. A sharp PNG is enough for
   a static result. Use a continuous WebM/MP4 clip for timing, transitions or a
   user-requested video. The saved report may be `complete` with a PNG-only flow.
   Use [tab-capture.md](tab-capture.md) for the native recorder when video or
   capture-stream PNGs are needed. A supported browser's original PNG screenshot
   may also serve as static evidence; inspect its saved pixels and dimensions.
4. For requested tab recording, prepare access and open the app tab with the
   supported browser before serving the recorder. Identify the tab's actual
   title. The reader clicks **Choose QA tab** and **Share**; `control wait-ready`
   detects sharing without a typed reply. An initial review needs no recorder
   or background wait. The Overview's **Copy QA prompt** starts a later agent
   turn when the developer is ready.
5. Capture the planned state or short flow with safe test data. Record the
   meaningful actions directly, without a routine pointer probe or rehearsal
   video. Use the pointer the harness renders; never synthesize cursor movement
   or click overlays. Inspect the requested evidence once, and investigate only
   an actual failure. Avoid trimming by recording a short clip initially.
   Restore temporary data, including failed setup attempts.
6. Preserve existing flows for the same snapshot when composing the QA update.
   Attach one QA update with the command below. Check the saved report's status,
   media count, embedded data URIs and comment links without printing media data.
   Open the media once in the browser when available. Keep failed flows associated
   with their finding and keep passed flows compact. Finish with `complete`,
   `partial`, `blocked` or `skipped` only for an attempted or explicitly chosen QA
   pass. `complete` means the planned checks finished, not that they passed.

The report remains readable during optional capture. Once evidence is attached,
link `current.html` again; an already-open report needs a reload. A later user
request starts a new agent turn and can enrich the saved review. No local process
silently restarts Codex after handoff.

## Media input and attachment

For a timed flow, save a continuous WebM clip and PNG stills with the bundled
helper in [tab-capture.md](tab-capture.md); recording and encoding happen in the
browser. Attach the short clip as `motion_preview` and its decisive stills as
assets. For static evidence, attach one original PNG and omit `motion_preview`.
Existing GIFs and legacy sequences remain supported for history.

```json
{
  "status": "partial",
  "fingerprint": "<exact snapshot fingerprint>",
  "summary": "Checked the last-row dropdown with a continuous tab recording and native PNG stills.",
  "environment": "Local test app; build SHA verified against the reviewed head; Chrome, 1280 x 800; synthetic account.",
  "flows": [{
    "title": "Open the assignment menu on the last row",
    "journey": ["Templates", "Last row", "Assignment menu"],
    "steps": ["Open templates", "Click the last row's assignment count"],
    "expected": "All menu items remain readable beyond the table boundary.",
    "observed": "The menu clears the footer; a long name requires horizontal scrolling.",
    "result": "failed",
    "comment_id": "wrap-assignment-names",
    "motion_preview": {"path": "menu.webm", "caption": "Open the assignment menu; the long unit-type name extends past the visible boundary."},
    "assets": [
      {"path": "before.png", "caption": "Step 1: the last row is visible above the footer."},
      {"path": "last-row.png", "caption": "Step 2: the long unit-type name extends past its visible width."}
    ]
  }]
}
```

Paths resolve relative to the QA JSON, not the current directory. `comment_id` is
optional; it associates that generated comment with the evidence flow.
Prefer flow comment_id to assign the evidence to one comment, including text-only
flows. Legacy asset associations use the first linked comment as owner. The
owning comment shows one compact preview; its viewer contains media and steps. Keep discussion empty
when the flow already supplies the explanation; use journey and expected/observed
for its concise visible summary. Unmatched failures remain visible; useful passed
checks go in Other flows checked. Keep gutter popovers compact. New comments and
changed findings belong in a normal review update, then attach media to that
revision. Use a short factual caption instead of repeating the image in prose.
Text-only copy does not carry image bytes; share the offline report for evidence.

```sh
ruby <skill>/scripts/series.rb qa --repo <root> --name <series> \
  --revision <latest-number> --update <scratch>/qa.json
```

The helper checks the expected revision, snapshot, unchanged code/context, media
type and total size; embeds media; saves a new revision; and refreshes the current
report. PNG/JPEG/WebP/GIF and MP4/WebM are accepted, with a 24 MiB total input budget.
Prefer shorter clips and fewer duplicate stills to stay within the budget;
do not add external media URLs, SVG/HTML images or unbounded full-session video.
The helper does not prove the runtime build identity: record how it was verified,
or state uncertainty and do not present a different build as reviewed-head QA.
Treat all captures as potentially containing sensitive data; use test fixtures,
inspect framing, and exclude credentials or unrelated screens before embedding.

Use `pending` only for an optional capture already agreed and underway. Use
`blocked` for an attempted capture that failed and `skipped` for an explicit user
choice. Omit QA entirely when no visual pass was planned. For a new code revision,
old media is not automatically reused: `prepare` drops it, leaving the evidence
accessible in historical HTML.

## Capability limits

The capture helper is independent of Codex, Claude, Grok, OpenCode and Pi. Each
harness still controls its browser using its own supported tools. Native pointer
rendering is a property of that browser/automation arrangement; it is not
implemented by this skill. Do not promise pointer visibility for an untested harness. Use the actual
requested recording to identify a missing pointer; no extra per-session probe. The helper
uses standard tab-sharing and media recording APIs in desktop Chromium; macOS
is exercised, Linux/Omarchy and Windows Chrome with WSL still need live validation.
See the capture reference for WSL paths and the one-time share interaction.
