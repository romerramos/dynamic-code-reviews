# Native tab video and PNG evidence

Use this helper for UI QA on any browser-capable harness. Browser interaction
stays with that harness; the helper only records the chosen tab and saves local
media. It requires the skill's existing Ruby 3.1+ runtime and desktop Chromium
with getDisplayMedia and MediaRecorder. No extension or media-tool installation.

## Review first, then capture from the review

Publish the review without QA first. Then serve that review with the QA panel:

```sh
ruby <skill>/scripts/qa_capture.rb --out <scratch-captures> --report <root>/.reviews/<series>/current.html
```

Keep the process running during capture (a background shell task). It prints a
loopback URL ending in `#overview`, with an available port; never bind it
publicly. Open that exact URL so the review lands on its Overview, where a
**Record visual QA evidence** section follows What changed, above the review
comments and their videos. Its revision links keep working.
The saved HTML file is not modified and stays a single shareable offline file.
Without `--report` the helper serves a standalone recorder page with the same panel.

Use one browser window (or tab group) holding only the QA tabs: the app under
review and the served review. A harness session group, such as Claude in
Chrome's, qualifies. Open the app first, then the served review.

Drive the recorder from the terminal, not through the browser harness. The
recorder page polls the helper, runs each command in order and returns its result:

```sh
ruby <skill>/scripts/qa_capture.rb control --out <same-dir> <action> [--name NAME] [--timeout S]
```

Actions: `wait-ready` (block until a tab is shared; default 180 s), `status`,
`start --name`, `still --name`, `stop`, `end` and `reload` (ends capture, then
reloads the served review so it shows attached evidence). Each prints one JSON line
(`{"ok":true,"value":…}`) and exits non-zero on failure; `stop` and `still`
return the saved absolute path. A Stop sent while a PNG is still saving waits
for it instead of being dropped. If no recorder page is polling, the command
fails within a few seconds with "The recorder page is not open".

1. Chrome's share prompt lists every open tab from every window by title, so a
   user with several tabs of the same app cannot tell them apart. Just before
   asking, mark the QA app tab through the harness:
   `document.title = '[QA] ' + document.title.replace(/^\[QA\] /, '')`. A full
   page load resets the title; set it again if the app tab navigated since.
   Then tell the user, in one message, that the review is open in the QA window
   and ask them to click **Choose QA tab** in the Overview's Record visual QA evidence section, pick the tab
   titled `[QA] …` (give the full title) and click **Share**. Run `wait-ready`. Chrome shows the
   share prompt only for a real click on a visible tab. A harness that clicks
   background tabs (Claude in Chrome does) cannot open it; a harness whose tab is
   in the foreground (as in Codex) may click Choose QA tab itself so the user
   only answers the prompt. Do not promise silent, permission-free setup, launch
   browsers with capture auto-approval flags, or install anything to skip it.
   The helper rejects desktop/window selections and disables audio.
2. Chrome focuses the captured app tab after sharing. Keep it selected in its
   window; the user can return to other apps and must leave the review tab open.
   Do not operate or reload the review tab through the harness while capturing.
3. Check the `wait-ready` dimensions. The helper requests up to 3840 ×
   2160 at 30 fps; the actual dimensions are reported by the stream and may be
   lower. It never enlarges saved frames after capture. Use a short harmless
   click probe to check video, native agent pointer and sharp text. Inspect the
   pointer at the actual click, not just the user's physical cursor elsewhere.
4. Prepare the page before recording so setup and permission waits stay out of
   the clip. Run `control start --name <flow>` just before the relevant
   action. Use a human-readable pace: one meaningful action at a time, roughly
   0.7–1.5 seconds to see menus/intermediate states, and 1–2 seconds on the result.
   Rehearse unfamiliar navigation before recording. Once controls are known,
   group the supported actions with state checks and deliberate pacing in one
   tool invocation when possible; avoid long model/tool-planning gaps inside
   the clip. Wait for actual loading/animations, and never race through clicks
   or fabricate mouse motion. Aim for 5–20 useful seconds per flow.
   Operate the app through the existing harness; run `control stop` promptly
   after the result. Each clip has a 45-second safety limit. Names are sanitized
   and saved with collision-resistant suffixes; read the resulting absolute path
   from the command's JSON and check `durationMs` against the intended flow. A JSON sidecar records capture dimensions and timing for
   authoring; it does not need to be shared or attached to the report.
5. Use `control still --name <state>` for important before/result states, even when no video
   is recording. PNG comes directly from the live tab stream at its actual
   pixel dimensions via canvas. There is no JPEG re-encoding or screenshot
   upscaling. Match each PNG to its flow and include an informative caption.
6. Finish with `control end`, attach the evidence with `series.rb qa`, then run
   `control reload` so the review tab shows the final report with its evidence.
   Stop the helper afterwards; the reloaded page stays readable, and the shareable
   result is the saved `current.html`. Sessions also expire after 10 minutes. If
   setup fails, stop the helper; do not leave a pending capture indefinitely. The
   panel's Manual controls remain available for manual use and trimming.

A share permission can cover multiple short clips and stills, including app
navigation, because the review lives in a separate tab. Verify capture survives
navigation for the flow under review; do not navigate/reload the review tab
while its stream is active. If a clip cannot be saved, the helper exposes a local
recovery download; do not discard a useful capture silently.

## Trim without FFmpeg

The helper's **Keep only the useful part** section accepts the most recent clip
or a local WebM/MP4. Set start/end seconds and click **Save excerpt**. The browser
plays that segment at normal speed and re-encodes it with MediaRecorder; no media
binary or package is installed. It takes approximately the excerpt duration,
retains the decoded frame dimensions, and leaves the original unchanged. This
is an approximate time cut, not a frame-exact or lossless container edit. Inspect
the saved excerpt before attaching it, and use only its path in motion_preview.
For best quality, record a well-paced short clip initially and avoid re-encoding.

## Native pointer behavior

No cursor, click ring, movement path or intermediate state is synthesized by this
skill. The recorded pointer is whatever the browser/harness actually renders.
A selected Chrome QA tab retained the Codex interaction pointer while the user
worked in the terminal in the macOS probe. Moving to another tab in the same
Chrome window lost that pointer. Other harnesses and platforms can differ.
If a verified arrangement cannot show the agent's clicks, state that limitation;
do not imply a no-pointer video meets a request for visible interactions.

Use a separate QA window when the harness supports one and verify that it can
stay selected without interfering with the user's other Chrome windows. Do not
assume minimized or fully occluded windows behave like an unfocused window.

## Portable operation and privacy

The UI contains ordinary named buttons; it has no Codex, Claude, Grok, OpenCode
or Pi integration. Use whichever supported browser controls the harness offers.
On Linux/Omarchy use desktop Chromium. With a WSL skill process and Windows
Chrome, use the printed localhost URL through WSL's configured localhost
forwarding; saved paths are WSL paths and the Ruby renderer runs in WSL. If that
URL is unreachable, fix the local forwarding/setup with the user's authorization;
do not expose the capture server on the network. Cross-platform code is supplied,
but only claim an OS/harness combination was tested after exercising it there.

Capture only authorized test data. No data is uploaded to a third party. The
Ruby helper binds 127.0.0.1, serves only its own three UI files, checks Host,
Origin and a per-run token for writes, limits individual uploads to 24 MiB,
and accepts only safe capture filenames. It does not serve the repository,
private report, or arbitrary local files. End the session to release sharing.

## One-file review

Use the normal `series.rb qa` command with paths to the generated files:

```json
{
  "motion_preview": {"path": "filter-flow-1234.webm", "caption": "Apply Unassigned; the sidebar highlight follows the filter."},
  "assets": [{"path": "filter-result-5678.png", "caption": "The Unassigned filter is active and the open thread remains visible."}]
}
```

The renderer packs both files into the HTML. A recipient needs only that HTML;
no recorder, local server, extension, sidecar, or internet connection is needed
for its evidence playback. The existing compact thumbnail and one-click viewer
are retained. All QA media together must fit the 24 MiB report input budget;
keep clips short and stills purposeful rather than lowering readability blindly.
