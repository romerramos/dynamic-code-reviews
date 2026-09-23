# Native tab video and PNG evidence

Use this helper for UI QA on any browser-capable harness. Browser interaction
stays with that harness; the helper only records the chosen tab and saves local
media. It requires the skill's existing Ruby 3.1+ runtime and desktop Chromium
with getDisplayMedia and MediaRecorder. No extension or media-tool installation.

## Start once, then capture short flows

```sh
ruby <skill>/scripts/qa_capture.rb --out <scratch-or-ignored-review-captures>
```

Keep the process running during capture. It prints a loopback URL with an
available port; never bind it publicly. Open that URL in a separate recorder tab
through the current harness. Open the actual test app in a dedicated QA tab.

1. Select the recorder tab once and click **Choose QA tab**. Follow the browser's
   share prompt and the harness's approval policy. Select only the known test
   application tab. The helper rejects desktop/window selections and disables
   audio. Browser permission and user activation are required; do not promise
   silent, permission-free setup. Do not install anything to skip the prompt.
2. The captured tab should become selected. Keep it selected in its Chrome
   window. The user can work in another app. Do not switch that Chrome window
   to the recorder or another tab during the flow. Use the harness's background
   DOM controls on the recorder tab, without activating it. If that harness
   cannot do this, state the limitation instead of stealing focus repeatedly.
3. Inspect **Capture ready · width × height**. The helper requests up to 3840 ×
   2160 at 30 fps; the actual dimensions are reported by the stream and may be
   lower. It never enlarges saved frames after capture. Use a short harmless
   click probe to check video, native agent pointer and sharp text. Inspect the
   pointer at the actual click, not just the user's physical cursor elsewhere.
4. Prepare the page before recording so setup and permission waits stay out of
   the clip. Fill **Evidence name**, then **Start clip** just before the relevant
   action. Use a human-readable pace: one meaningful action at a time, roughly
   0.7–1.5 seconds to see menus/intermediate states, and 1–2 seconds on the result.
   Rehearse unfamiliar navigation before recording. Once controls are known,
   group the supported actions with state checks and deliberate pacing in one
   tool invocation when possible; avoid long model/tool-planning gaps inside
   the clip. Wait for actual loading/animations, and never race through clicks
   or fabricate mouse motion. Aim for 5–20 useful seconds per flow.
   Operate the app through the existing harness; click **Stop and save clip** promptly
   after the result. Each clip has a 45-second safety limit. Names are sanitized
   and saved with collision-resistant suffixes; read the resulting absolute path
   from Saved evidence. A JSON sidecar records capture dimensions and timing for
   authoring; it does not need to be shared or attached to the report.
5. Use **Save PNG still** for important before/result states, even when no video
   is recording. PNG comes directly from the live tab stream at its actual
   pixel dimensions via canvas. There is no JPEG re-encoding or screenshot
   upscaling. Match each PNG to its flow and include an informative caption.
6. Finish with **End capture session**, then stop the helper process. Sessions
   also expire after 10 minutes. If setup fails, close the unused recorder tab
   and stop its helper; do not leave a pending capture indefinitely.

A share permission can cover multiple short clips and stills, including app
navigation, because the recorder lives in a separate tab. Verify capture survives
navigation for the flow under review; do not navigate/reload the recorder itself
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
