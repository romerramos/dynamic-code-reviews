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
3. Use the available browser skill and its supported harness. Work in a dedicated
   tab/session, avoid the user's tabs, and verify capture/actions work without
   focus or stealing the user's interaction. Do not use OS desktop/window
   recording, macOS screencapture, an ffmpeg screen-input device, raw CDP, or a
   second automation connection as a substitute for an unsupported harness API.
   Respect access blocks; do not relay blocked private content through localhost.
4. Start with the active browser tool’s ordinary screenshots: save the returned
   image bytes or supported artifact path, inspect the image, then attach it.
   Reuse screenshots already taken while checking the same flow and build. This
   is the default walkthrough, whether the available tool is a GPT Chrome
   extension or another supported agent browser harness; follow that tool’s
   instructions instead of assuming identical APIs. A screenshot displayed in
   the conversation is not automatically embedded in the report. If a session
   is stale or a dialog blocks it, try supported recovery or a fresh review tab
   before declaring capture blocked. Reuse the browser connection, obtain a fresh
   review tab if needed, and perform authentication actions separately so failures
   can be localized. Use known local test credentials through the normal login UI.
   If the expected flow is missing, check documented feature flags and fixture
   prerequisites in the authorized workspace; a reachable login page is not proof
   the flow is ready. Restore any temporary fixture edits after capture.
   If supported recovery fails, ask for the specific missing access or user action
   and offer to skip; do not repeatedly retry the same failing operation.

   Check recording capability once, using documented tool/capability discovery.
   Video discovery must not hold up ordinary screenshots.
   If isolated recording is available, probe a few seconds on a harmless test
   page. Confirm playback, framing, cursor/click visibility and background operation.
   Prefer native pointer indicators; never fabricate a cursor path. If unavailable
   or the probe fails, proceed with a **screenshot walkthrough** and briefly state
   that background video is unavailable. Do not install extensions/dependencies or
   build a recording service to finish an ordinary review.
5. Exercise the actual relevant page on the reviewed build with test data. Use
   semantic actions and cheap state checks; capture only key states such as before
   the action, the resulting layout, and a meaningful edge case. Verify viewport
   size. Screenshots of the report or a synthetic mockup do not prove app behavior.
   For supported browser-client sessions, `tab.screenshot(...)` returns bytes that
   can be saved to a scratch file using node:fs/promises through the same Node tool.
   The attachment helper detects the actual image type; do not assume the harness
   returns PNG. Inspect captions/element geometry instead of dumping media URLs.
   Do not put images/base64/video frames in model-authored JSON or reread them as
   text; save bytes and reference the files. Inspect selected images before use.
6. Write a small QA JSON in scratch storage and attach it with the command below.
   Captions describe the action and visible result, plus timestamps for clips when
   useful. A screenshot sequence is not a continuous recording. Videos need native
   controls, no autoplay, and a text walkthrough for accessibility. Cropping is
   fine if labelled; never fabricate an app state or silently hide a failed result.
7. Verify attachment before announcing success: extract the saved current report
   with `DynamicReviews.extract`, check the QA status, expected asset count and
   embedded data URIs without printing their contents. Check that comment links
   point to existing comments. Where the browser permits report access, inspect
   image rendering; otherwise state that limitation and rely on the inspected
   source images plus the renderer checks. Do not work around browser access blocks.
   The helper rejects `complete` without any media. Use `partial` or `blocked`
   when screenshots could not be attached, even if DOM checks succeeded.
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

```json
{
  "status": "partial",
  "fingerprint": "<exact snapshot fingerprint>",
  "summary": "Checked the last-row dropdown. Background video is unavailable; screenshots show the key states.",
  "environment": "Local test app; build SHA verified against the reviewed head; Chrome, 1280 x 800; synthetic account.",
  "flows": [{
    "title": "Open the assignment menu on the last row",
    "steps": ["Open templates", "Click the last row's assignment count"],
    "expected": "All menu items remain readable beyond the table boundary.",
    "observed": "The menu clears the footer; a long name requires horizontal scrolling.",
    "result": "failed",
    "assets": [{
      "path": "last-row.png",
      "caption": "After opening the menu: the long unit-type name extends past its visible width.",
      "comment_id": "wrap-assignment-names"
    }]
  }]
}
```

Paths resolve relative to the QA JSON, not the current directory. `comment_id` is
optional; it displays the evidence beside that existing generated comment in the
overview as well as in Visual QA. Keep gutter popovers compact. New comments and
changed findings belong in a normal review update, then attach media to that
revision. Use a short factual caption instead of repeating the image in prose.
Text-only copy does not carry image bytes; share the offline report for evidence.

```sh
ruby <skill>/scripts/series.rb qa --repo <root> --name <series> \
  --revision <latest-number> --update <scratch>/qa.json
```

The helper checks the expected revision, snapshot, unchanged code/context, media
type and total size; embeds media; saves a new revision; and refreshes the current
report. PNG/JPEG/WebP and MP4/WebM are accepted, with a 24 MiB total input budget.
Shorten/compress clips using an already-installed offline encoder if necessary;
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

At implementation time, the available browser-client harness exposes tab
screenshots and interactions, but no recording capability. The built-in Mac
computer-use interface likewise does not expose isolated video capture. This is
an observed capability limit, not a permanent provider restriction: future runs
should inspect their current tool docs once. Do not claim that Codex, Claude Code
or an extension records video just because it can click and take screenshots.
An already configured harness with isolated recording or a user-supplied recording
can provide MP4/WebM evidence later without changing the renderer.
