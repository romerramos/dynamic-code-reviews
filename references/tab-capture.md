# Native tab video and PNG evidence

Use this helper for UI QA on any browser-capable harness. Browser interaction
stays with that harness; the helper only records the chosen tab and saves local
media. It requires the skill's existing Ruby 3.1+ runtime and desktop Chromium
with getDisplayMedia and MediaRecorder. No extension or media-tool installation.

## Review first, then capture from the review

Start only for requested video or finding-critical capture. First prepare app access
and open a tab the harness can control. Then serve the saved review with the QA panel:

```sh
<skill>/bin/dcr serve --out <scratch-captures> --report <root>/.reviews/<series>/current.html
```

Keep the process running during capture (a background shell task). It prints a
loopback URL ending in `#overview`, with an available port; never bind it
publicly. Open that exact URL so the review lands on its Overview, where a
**Record visual QA evidence** section follows What changed, above the review
comments and their videos. Its revision links keep working.
The saved HTML file is not modified and stays a single shareable offline file.
Without `--report` the helper serves a standalone recorder page with the same panel.

### The app inside the review (one tab)

Add `--app <url>` to `dcr serve` to show the running app inside the review through a
loopback proxy (any `http` or `https` URL; see
[local-app-discovery.md](local-app-discovery.md)). The command prints a link ending in
`/?app#overview` that opens straight into the **App** view: Browse or Comment, device
widths, **Record** and a side panel with Recordings and Comments on the app.

- **Comment**: click an element and write what should change. **Send to agent** makes a
  review thread that `dcr wait` prints with the page, element and its text; answer it
  with `dcr reply` like any other thread.
- **Record**: the first click shares this tab (the reader chooses it and **Share**) and
  recording starts at once; the button becomes **Stop** with a timer. Only the app pane
  is recorded, with the real pointer, because the shared tab is the review the reader
  has in front. **Still** saves a PNG; **Stop sharing** ends the share.
- **Recordings**: every clip or still lands there, also ones started with `dcr record`.
  **Send to agent** sends it with a note as an app thread; **Add to review** takes a
  title, Passed or Failed and what you saw (optionally a review comment), and
  **Save N to the review** saves all of them as one revision.

- **Start QA review** (on the Overview and in the panel header): the reader shares this
  tab once, and the agent gets a QA request through `dcr wait` naming the recorder
  folder, the comments and the rules. It records each flow with `dcr record`, attaches
  them with `dcr evidence attach` (one revision, each clip on its comment) and reports
  in the QA thread. While it runs, a banner in the App view tells the reader to leave the
  tab alone; the agent's reply ends it, stops sharing and shows **QA review ready**. Each
  QA review replaces the previous one's recordings; the reader's own recordings stay.

When you record QA yourself in the App view, open the served review through your own
browser tool (so you can act in the tab the reader shares), keep that tab in front, and
drive the recorder only with `dcr record start|still|stop`. While those commands drive
it, the review draws your pointer and a ring on each click inside the app, at the
coordinates of the input events you send: tools that click through the DevTools
protocol (Claude in Chrome, Chrome DevTools MCP, Playwright) never move the system
pointer, and this is how their clips stay readable. Hover before you click. A
computer-use harness that moves the system pointer is recorded as it is. Never add a
cursor after recording. With several review pages open, recorder commands go to the
one sharing its tab. Log in through the proxy. A redirect to another host is reported in the footer,
not followed. The two-tab flow below remains for apps the proxy cannot show.

Use one browser window (or tab group) holding only the QA tabs: the app under
review and the served review. A harness session group, such as Claude in
Chrome's, qualifies. Open the app first, then the served review.

Drive the recorder from the terminal, not through the browser harness. The
recorder page polls the helper, runs each command in order and returns its result:

```sh
<skill>/bin/dcr record --out <same-dir> <action> [--name NAME] [--timeout S]
```

Actions: `wait-ready` (block until a tab is shared; default 180 s), `status`,
`start --name`, `still --name`, `stop`, `end` and `reload` (ends capture, then
reloads the served review so it shows attached evidence). Each prints one JSON line
(`{"ok":true,"value":…}`) and exits non-zero on failure; `stop` and `still`
return the saved absolute path. A Stop sent while a PNG is still saving waits
for it instead of being dropped. If no recorder page is polling, the command
fails within a few seconds with "The recorder page is not open".

Use `control wait-ready --timeout 180` after opening the prepared recorder.
Sharing is the confirmation; no typed reply is needed. This wait belongs only to
a requested capture session. Initial reviews and template previews need no helper
or active agent wait. The legacy `wait-request` command remains available for
older reports; new reports collect template selections locally and copy prompts.

1. Chrome's share prompt lists every open tab from every window by title, so a
   user with several tabs of the same app cannot tell them apart. Just before
   sharing, identify the prepared app tab by its actual title. Add a `[QA]`
   title prefix only if the harness permits that operation. The user clicks
   **Choose QA tab**, picks the identified app tab and clicks **Share**.
   `wait-ready` detects this; do not ask the user to type “shared.” Chrome shows the
   share prompt only for a real click on a visible tab. A harness that clicks
   background tabs (Claude in Chrome does) cannot open it; a harness whose tab is
   in the foreground (as in Codex) may click Choose QA tab itself so the user
   only answers the prompt. Do not promise silent, permission-free setup, launch
   browsers with capture auto-approval flags, or install anything to skip it.
   The helper rejects desktop/window selections and disables audio.
2. Chrome focuses the captured app tab after sharing. Keep it selected in its
   window; the user can return to other apps and must leave the review tab open.
   Do not operate or reload the review tab through the harness while capturing.
3. Check the `status` dimensions after the QA request. The helper requests up to 3840 ×
   2160 at 30 fps; the actual dimensions are reported by the stream and may be
   lower. It never enlarges saved frames after capture. Record the requested
   flow directly; do not add a cursor probe or rehearsal clip each session.
4. Prepare the page before recording so setup and permission waits stay out of
   the clip. Run `control start --name <flow>` just before the relevant
   action. Use a human-readable pace: one meaningful action at a time, roughly
   0.7–1.5 seconds to see menus/intermediate states, and 1–2 seconds on the result.
   Locate the needed controls before recording. Once controls are known,
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
6. Finish with `control end`, attach the evidence with `dcr series qa`, then run
   `control reload` so the review tab shows the final report with its evidence.
   Open the saved `current.html` in the default browser before stopping the helper.
   This is the final shareable result, including all attached media and previews.
   If the served tab remains open after shutdown, it restores the normal Copy video QA
   prompt button and stops polling; any unsaved clip stays available for download.
   Sessions also expire after 10 minutes. If
   setup fails, stop the helper; do not leave a pending capture indefinitely. The
   panel's Manual controls remain available for manual use and trimming.

A share permission can cover multiple short clips and stills, including app
navigation, because the review lives in a separate tab. Do not navigate/reload the review tab
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
If the actual recording shows no agent pointer, state that limitation;
do not imply a no-pointer video meets a request for visible interactions.

Use a separate QA window when the harness supports one so the app can stay
selected while the user works elsewhere. Do not
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

Use the normal `dcr series qa` command with paths to the generated files:

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
