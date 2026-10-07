'use strict';
// Runs on the standalone recorder page or inside a served review, so it keeps its names local
// and only touches the qa- prefixed elements that qa-panel.js creates.
(() => {
// Look elements up through the panel so they stay reachable while the review moves it.
const panel = document.getElementById('qa-panel');
const $ = id => panel.querySelector(`#qa-${id}`);
const token = document.querySelector('meta[name="qa-token"]').content;
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
let stream, recorder, recorderFinished, chunks = [], clip, clipTimer, sessionTimer, stopping, ending, busy = false;
let editSource, editUrl, trimming = false, offline = false, paneCapture = null;
// Who drives the recorder: 'agent' once a terminal command (dcr record) arrives, 'reader' once
// the reader uses the buttons. The App view draws the agent's pointer only while the agent drives.
let driver = 'reader';
const editor = $('editor');
const safeName = value => (value || 'qa-evidence').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80) || 'qa-evidence';
const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
function render() {
  $('connect').disabled = busy || !!stream || offline;
  $('start').disabled = busy || !stream || !!recorder || !!stopping;
  $('stop').disabled = busy || !recorder;
  $('snapshot').disabled = busy || !stream || video.readyState < 2;
  $('end').disabled = busy || !stream;
  $('trim').disabled = busy || trimming || !!recorder || !editSource;
  window.dispatchEvent(new CustomEvent('qa-recorder-state', {detail: status()}));
  setText('status', recorder ? `Recording · ${Math.floor((Date.now() - clip.startedAt) / 1000)} s · ${video.videoWidth} × ${video.videoHeight}` : stream ? `Capture ready · ${video.videoWidth} × ${video.videoHeight} · native browser capture` : offline ? 'The QA session has ended. Ask the agent to start a new one to record again.' : 'No active capture');
}
// Every saved clip or still, whoever asked for it (a button or `dcr record`), is announced to the page.
const announce = saved => { window.dispatchEvent(new CustomEvent('qa-recorder-saved', {detail: saved})); return saved; };
async function save(blob, name, extra = {}) {
  const response = await fetch(`/save/${name}`, {method: 'POST', headers: {'Content-Type': blob.type || 'application/octet-stream', 'X-QA-Token': token}, body: blob});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save capture');
  const artifact = {...result, ...extra};
  const li = document.createElement('li');
  li.textContent = `${artifact.path} · ${Math.round(blob.size / 1024)} KiB${extra.width ? ` · ${extra.width} × ${extra.height}` : ''}`;
  $('artifacts').append(li);
  return artifact;
}
// pane: an element of this page (the app inside the review). Then the reader shares this tab,
// and the capture is cut down to that element, so there is no other tab to find.
async function restrictTo(track, pane) {
  if (typeof RestrictionTarget !== 'undefined' && track.restrictTo) {
    try { await track.restrictTo(await RestrictionTarget.fromElement(pane)); return 'element'; } catch { /* fall back to cropping */ }
  }
  if (typeof CropTarget !== 'undefined' && track.cropTo) { await track.cropTo(await CropTarget.fromElement(pane)); return 'region'; }
  throw new Error('This browser cannot limit a capture to the app. Use a recent desktop Chrome.');
}
async function connect(pane) {
  const options = {audio: false, video: {displaySurface: 'browser', width: {ideal: 3840}, height: {ideal: 2160}, frameRate: {ideal: 30, max: 30}, cursor: 'always'}, selfBrowserSurface: pane ? 'include' : 'exclude', preferCurrentTab: !!pane};
  if (typeof CaptureController !== 'undefined' && !pane) options.controller = new CaptureController();
  const selected = await navigator.mediaDevices.getDisplayMedia(options);
  const track = selected.getVideoTracks()[0];
  if (track.getSettings().displaySurface !== 'browser') {
    selected.getTracks().forEach(item => item.stop());
    throw new Error('Select a browser tab. Window and desktop capture are not used for review evidence.');
  }
  if (pane) {
    try { paneCapture = await restrictTo(track, pane); }
    catch (error) { selected.getTracks().forEach(item => item.stop()); throw new Error(`${error.message} Share this tab, the one showing the review.`); }
  }
  stream = selected;
  try {
    options.controller?.setFocusBehavior('focus-captured-surface');
    video.srcObject = stream; await video.play();
    if (video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, {once: true}));
  } catch (error) { stream.getTracks().forEach(item => item.stop()); stream = null; throw error; }
  track.addEventListener('ended', () => run(end), {once: true});
  sessionTimer = setTimeout(() => run(end), 600000);
  if (document.body.classList.contains('qa-live')) {
    const response = await fetch('/request', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-QA-Token': token}, body: JSON.stringify({kind: 'qa'})});
    if (!response.ok) throw new Error('The recording session has ended. Use Copy QA prompt in Video QA to request another session.');
  }
  $('notice').textContent = 'QA requested. Keep this page open while the agent records the checks and reloads it with the evidence.';
}
function start() {
  if (!stream || recorder || stopping) throw new Error('Start capture and finish the current clip first.');
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This browser does not offer a WebM encoder.');
  chunks = [];
  clip = {name: safeName($('name').value), startedAt: Date.now(), width: video.videoWidth, height: video.videoHeight, mimeType, capture: stream.getVideoTracks()[0].getSettings(), pane: paneCapture, pointer: 'native browser capture; no added cursor'};
  recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 12000000});
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorderFinished = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = event => { reject(new Error(event.error?.message || 'Video encoding failed')); run(end); };
  });
  recorderFinished.catch(() => {});
  recorder.start(500);
  clipTimer = setTimeout(() => run(stop), 45000);
  $('notice').textContent = 'Recording. Interact with the QA tab.';
  return {name: clip.name};
}
async function frameBlob() {
  if (!stream || video.readyState < 2) throw new Error('No ready capture stream.');
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
async function snapshot() {
  if (!stream || video.readyState < 2) throw new Error('No ready capture stream.');
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG capture failed.');
  const saved = await save(blob, `${safeName($('name').value)}.png`, {width: canvas.width, height: canvas.height});
  $('notice').textContent = 'PNG saved at the capture stream’s actual pixel dimensions.';
  return announce({...saved, kind: 'still', url: URL.createObjectURL(blob)});
}
async function stop() {
  if (stopping) return stopping;
  if (!recorder) return;
  stopping = (async () => {
    clearTimeout(clipTimer);
    const current = recorder, metadata = {...clip, durationMs: Date.now() - clip.startedAt};
    // The last frame on screen is the result of the flow: it becomes the clip's poster.
    const poster = await frameBlob().catch(() => null);
    if (current.state !== 'inactive') current.stop();
    try { await recorderFinished; } finally { recorder = null; clip = null; recorderFinished = null; }
    const blob = new Blob(chunks, {type: current.mimeType}); chunks = [];
    loadEditor(blob, metadata);
    try {
      const saved = await save(blob, `${metadata.name}.webm`, {width: metadata.width, height: metadata.height});
      await save(new Blob([JSON.stringify(metadata, null, 2)], {type: 'application/json'}), `${metadata.name}.json`);
      if (poster) {
        const clipName = saved.path.split('/').pop().replace(/\.webm$/, '');
        await fetch(`/save-poster/${clipName}.png`, {method: 'POST', headers: {'Content-Type': 'image/png', 'X-QA-Token': token}, body: poster}).catch(() => {});
      }
      $('notice').textContent = `Saved ${saved.path}`;
      return announce({...saved, kind: 'clip', durationMs: metadata.durationMs, url: URL.createObjectURL(blob)});
    } catch (error) {
      // Keep a local recovery download if the helper stops or rejects the file.
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${metadata.name}.webm`; link.textContent = 'Download unsaved clip'; $('artifacts').append(link);
      throw error;
    }
  })();
  try { return await stopping; } finally { stopping = null; }
}
async function end() {
  if (ending) return ending;
  ending = (async () => {
    clearTimeout(sessionTimer);
    try { await stop(); } finally { const previous = stream; stream = null; paneCapture = null; video.srcObject = null; previous?.getTracks().forEach(track => track.stop()); }
  })();
  try { await ending; } finally { ending = null; }
}
// Actions run one at a time, so a Stop sent while a PNG is still saving waits instead of being dropped.
let queue = Promise.resolve();
function run(action) {
  const task = queue.then(async () => {
    busy = true; render();
    try { return await action(); } finally { busy = false; render(); }
  });
  queue = task.catch(() => {});
  task.catch(error => { $('notice').textContent = error.message; });
  return task;
}
const commands = {
  start: name => { if (name) $('name').value = name; return start(); },
  still: name => { if (name) $('name').value = name; return snapshot(); },
  stop: async () => (await stop()) || {stopped: false},
  end: async () => { await end(); return {ended: true}; },
  // Ends any capture, then reloads so a served review shows its newly attached evidence.
  reload: async () => { await end(); setTimeout(() => { location.hash = 'overview'; location.reload(); }, 300); return {reloading: true}; }
};
const status = () => ({ready: !!stream && video.readyState >= 2, recording: !!recorder, startedAt: clip?.startedAt || null, busy, pane: paneCapture, driver, width: video.videoWidth, height: video.videoHeight});
// The App view drives the same recorder, so terminal commands and buttons share one queue.
window.QARecorder = {
  connectPane: pane => { driver = 'reader'; return run(() => connect(pane)); },
  start: name => { driver = 'reader'; return run(() => commands.start(name)); },
  stop: () => { driver = 'reader'; return run(stop); },
  still: name => { driver = 'reader'; return run(() => commands.still(name)); },
  end: () => run(end),
  status
};
// Terminal commands arrive through the helper's long poll; results go back for the waiting client.
async function poll() {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch('/next', {headers: {'X-QA-Token': token, 'X-QA-Sharing': stream ? '1' : '0'}, cache: 'no-store'});
      offline = ![200, 204].includes(response.status);
      if (!offline) failures = 0;
      if (response.status === 200) {
        const command = await response.json();
        let result;
        try {
          if (command.action !== 'status') driver = 'agent';
          const value = command.action === 'status' ? status() : await run(() => commands[command.action](command.name));
          result = {ok: true, value: value ?? null};
        } catch (error) { result = {ok: false, error: error.message}; }
        await fetch(`/result/${command.id}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-QA-Token': token}, body: JSON.stringify(result)});
        continue;
      }
      if (response.status === 204) continue;
    } catch { offline = true; }
    if (++failures >= 3) {
      try { await run(end); } catch { /* stop() preserves unsaved clips for download. */ }
      clearInterval(renderTimer);
      window.dispatchEvent(new CustomEvent('qa-session-ended', {detail: {recoverable: !!editSource || !!$('artifacts').children.length}}));
      render();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
poll();
$('connect').onclick = () => run(connect);
$('start').onclick = () => run(start);
$('stop').onclick = () => run(stop);
$('snapshot').onclick = () => run(snapshot);
$('end').onclick = () => run(end);
const renderTimer = setInterval(() => { if (stream || recorder) render(); }, 1000);

function loadEditor(blob, metadata) {
  if (trimming) return;
  if (editUrl) URL.revokeObjectURL(editUrl);
  editSource = metadata;
  editUrl = URL.createObjectURL(blob);
  editor.src = editUrl;
  $('trim-start').value = '0';
  $('trim-end').value = metadata.durationMs ? (metadata.durationMs / 1000).toFixed(2) : '';
  $('trim').disabled = false;
  $('trim-status').textContent = 'Use the native player to find the useful action, then enter the excerpt bounds.';
}
$('source').onchange = () => {
  const file = $('source').files[0];
  if (file) loadEditor(file, {name: safeName(file.name.replace(/\.[^.]+$/, '')), durationMs: null});
};
editor.addEventListener('loadedmetadata', () => {
  if (!editSource?.durationMs && Number.isFinite(editor.duration)) {
    editSource.durationMs = editor.duration * 1000;
    $('trim-end').value = editor.duration.toFixed(2);
  }
});
$('trim').onclick = async () => {
  const from = Number($('trim-start').value), to = Number($('trim-end').value);
  if (!editSource || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || (editSource.durationMs && to > editSource.durationMs / 1000 + 0.1)) {
    $('trim-status').textContent = 'Enter valid start and end times within the clip.'; return;
  }
  if (typeof editor.captureStream !== 'function') { $('trim-status').textContent = 'This browser cannot encode an excerpt; record a shorter clip instead.'; return; }
  trimming = true; $('trim').disabled = true; $('source').disabled = true;
  let output, encoder;
  try {
    editor.pause(); editor.playbackRate = 1;
    if (Math.abs(editor.currentTime - from) > 0.001) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Could not seek to the excerpt start')), 10000);
        editor.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, {once: true});
        editor.currentTime = from;
      });
    }
    output = editor.captureStream();
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    encoder = new MediaRecorder(output, {mimeType, videoBitsPerSecond: 12000000});
    const parts = [];
    encoder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
    const finished = new Promise((resolve, reject) => {
      encoder.onstop = resolve;
      encoder.onerror = event => reject(new Error(event.error?.message || 'Excerpt encoding failed'));
    });
    encoder.start(250);
    editor.controls = false;
    await editor.play();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Excerpt playback stalled')); }, (to - from + 15) * 1000);
      const poll = setInterval(() => {
        $('trim-status').textContent = `Saving excerpt · ${Math.min(editor.currentTime, to).toFixed(1)} / ${to.toFixed(1)} s`;
        if (editor.currentTime >= to || editor.ended) { clearInterval(poll); clearTimeout(deadline); resolve(); }
      }, 33);
    });
    editor.pause(); encoder.stop(); await finished;
    const saved = await save(new Blob(parts, {type: mimeType}), `${safeName(editSource.name).slice(0, 70)}-excerpt.webm`, {width: editor.videoWidth, height: editor.videoHeight});
    $('trim-status').textContent = `Saved ${saved.path}. Browser-encoded excerpt, approximately ${from.toFixed(1)}–${to.toFixed(1)} seconds of the original.`;
  } catch (error) { $('trim-status').textContent = error.message; }
  finally {
    editor.pause(); editor.controls = true;
    if (encoder?.state === 'recording') encoder.stop();
    output?.getTracks().forEach(track => track.stop());
    trimming = false; $('trim').disabled = false; $('source').disabled = false;
  }
};
})();
