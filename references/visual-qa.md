# Report-first visual evidence

Use only when the diff suggests a specific visual state or user interaction worth
checking: clipping, layout, validation, focus, navigation, loading, or error states.
Backend-only work needs no decorative browser captures. Choose a few high-value
states and a short flow; avoid exhaustive screenshots or full-session recordings.

## First publish, then capture

1. Inspect the code and author the normal review. Identify the flow, expected
   outcome and relevant source/comment anchors. Apply this flow on every review
   with useful visual checks, unless the user has opted out. Do only cheap environment
   discovery before publishing; do not delay the code review for setup or capture.
2. Publish with `qa.status: awaiting-environment`, the snapshot `fingerprint`,
   a short summary and `flows: []`. **Immediately link current.html in commentary.**
   Then ask using the available question tool:

   “Do you have this environment provisioned?”
   - “Yes — use a local URL”: ask them to paste the URL (free text in the question
     tool). Validate reachability, safe test data and the running source revision.
     Reuse known authentication; ask for missing access only when necessary.
   - “Find a provisioning skill”: inspect the available skills for the repository
     and framework, read the relevant skill, and follow its setup workflow. This
     choice authorizes setup discovery; apply that skill's concrete execution and
     approval rules, respecting authorization already supplied by the user. If no
     suitable skill exists, inspect the documented local setup and propose the
     smallest concrete route. Do not silently install tools or copy another DB.
   - “No screenshots for this review”: save `skipped`, end QA for this review and
     keep the code review complete. Do not ask again during the same review.

   If the user already supplied the environment or authorized provisioning in
   this conversation, reuse that choice instead of repeating the question. If they provide a URL for another
   build, explain the mismatch rather than treating it as reviewed-head evidence.
   With an asynchronous question, continue independent review/report work while
   awaiting the reply. No answer is not permission to provision and not a skip:
   retain `awaiting-environment` and clearly state the next choice needed. Do not
   leave a running-worker message when no capture is underway. After a usable
   environment is selected, attach `pending` with the planned checks and continue
   capture in this turn. On a setup failure, record the actual blocker and the
   practical next step; do not label a merely unprovisioned environment as an
   unexplained dead end.
3. Use a dedicated QA tab through the active browser harness. Read
   [tab-capture.md](tab-capture.md) and start the bundled capture helper with
   `--report` pointing at the just-published `current.html`, unless an equivalent
   native recorder is already available. Open the served review beside the app
   in the same QA window or tab group; its Visual QA panel is where the user
   starts capture, and the same tab later shows the final report. The helper captures a
   selected browser tab through standard Web APIs; it does not automate Chrome,
   require an extension, or record the desktop. Respect browser access blocks
   and the harness's permission policy. Do not relay blocked content through a
   server or connect an alternate browser automation client to bypass a limit.
4. Probe a short interaction before the real flow. Confirm the intended tab is
   captured, native agent input is visible, video continues while the user works
   elsewhere, and PNG text is readable at its saved dimensions. Keep the QA tab
   selected in its browser window when native pointer capture needs that; do not
   claim the same behavior for an unselected tab. Never paint a pointer into the
   page or reconstruct clicks after capture. Stop after one supported recovery
   if recording is blocked, explain the missing permission/capability, and offer
   readable still evidence instead. Do not silently fall back to a sampled GIF.
5. Exercise the relevant page on the reviewed build with safe test data. Record
   short continuous clips around the actual actions. Save PNG stills from the
   same capture stream for the before state, decisive result and thumbnail.
   Use semantic browser actions and cheap state checks. A synthetic test or a
   screenshot of the report does not prove application behavior. Verify the
   runtime build, feature flags and fixtures; restore temporary fixture changes.
   Supported harness screenshots remain useful for agent navigation, but do not
   attach blurry tool images when the native capture stream is available.
   Save returned bytes/files and reference their paths; do not put base64 in
   model-authored JSON or dump it into tool output. Inspect the real saved pixels.
6. Write small QA JSON and attach it with the command below. Use WebM/MP4 as the
   flow's motion_preview and PNG stills as assets. Omit presentation: sequence.
   Captions explain the action and visible result; steps provide the accessible
   text equivalent. A single decisive static state may use PNG only. Use a PNG
   poster from the same flow, not an unrelated image. The overview stays quiet;
   one evidence click opens and plays the video with controls and fullscreen.
7. Verify attachment before announcing success: extract the saved current report
   with `DynamicReviews.extract`, check the QA status, expected asset count and
   embedded data URIs without printing their contents. Check that comment links
   point to existing comments. Where the browser permits report access, inspect
   image rendering; otherwise state that limitation and rely on the inspected
   source images plus the renderer checks. Do not work around browser access blocks.
   The helper rejects `complete` without any media. Use `partial` or `blocked`
   when no visual capture could be attached, even if DOM checks succeeded.
8. Finish the pass with `complete`, `partial`, `blocked` or `skipped` and report
   actual limitations. `complete` means planned checks finished, not that they
   passed: failed flows retain `result: failed`. If QA changes a finding, use
   `prepare` / `publish --record` to reassess the finding as well; the QA-only
   command deliberately preserves code conclusions. Never infer a fix from media.

The ordinary report remains available while the environment question is pending and during steps 3–6. Publishing creates a new
immutable revision and refreshes `current.html` and history. The already-open
page does not silently poll or reload, which could disturb reading and notes.
Link the current view again when ready. Old revisions correctly retain their
historical pending status. No background task is promised after the agent stops.

## Media input and attachment

Save continuous WebM clips and PNG stills with the bundled helper described in
[tab-capture.md](tab-capture.md). Recording and encoding happen in the browser;
no FFmpeg or image decoder package is needed. Attach a short clip as
motion_preview and its readable stills as assets. For static evidence, omit
motion_preview. Existing GIFs and legacy sequences remain supported for history,
but are not the default capture workflow.

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

For first publication, pending QA needs only status, summary, fingerprint and an
empty flows array. If the runtime is unknown or absent, publish awaiting-environment and offer the
three choices above. Use blocked for an attempted setup/capture that failed, and
skipped for an explicit user choice or a flow unsuitable for visual QA. For a new code revision, old media is not automatically
reused: `prepare` drops it, leaving the evidence accessible in historical HTML.

## Capability limits

The capture helper is independent of Codex, Claude, Grok, OpenCode and Pi. Each
harness still controls its browser using its own supported tools. Native pointer
rendering is a property of that browser/automation arrangement; it is not
implemented by this skill. Verify it instead of assuming it exists. The helper
uses standard tab-sharing and media recording APIs in desktop Chromium; macOS
is exercised, Linux/Omarchy and Windows Chrome with WSL still need live validation.
See the capture reference for WSL paths and the one-time share interaction.
