'use strict';
// Builds the Visual QA panel. In a served review it is a section of the Overview, right
// after "What changed"; on the standalone recorder page it is the page. recorder.js
// wires up the qa- elements through the panel node, so moving the panel is safe.
(() => {
  const standalone = document.body.classList.contains('qa-standalone');
  const panel = document.createElement(standalone ? 'main' : 'section');
  panel.id = 'qa-panel';
  panel.setAttribute('aria-labelledby', 'qa-heading');
  panel.innerHTML = `
    <header><p class="qa-eyebrow">Live review session</p><h2 id="qa-heading">Record visual QA evidence</h2></header>
    <p>Click <b>Choose QA tab</b>, pick the app tab whose title starts with <b>[QA]</b> in Chrome’s prompt and click <b>Share</b>. The agent records the checks and reloads this review with the videos when it is done.</p>
    <div class="qa-primary"><button type="button" id="qa-connect">Choose QA tab</button><p id="qa-status" role="status">No active capture</p></div>
    <p id="qa-notice" role="status"></p>
    <details>
      <summary>Manual controls and saved files</summary>
      <label for="qa-name">Evidence name</label><input id="qa-name" value="qa-flow" maxlength="80" autocomplete="off">
      <div class="qa-actions"><button type="button" id="qa-start" disabled>Start clip</button><button type="button" id="qa-stop" disabled>Stop and save clip</button><button type="button" id="qa-snapshot" disabled>Save PNG still</button><button type="button" id="qa-end" class="secondary" disabled>End capture session</button></div>
      <p class="qa-muted">Keep the app tab selected in its window so the browser’s interaction pointer is captured. Clips stop after 45 seconds and sessions after 10 minutes. Audio is disabled and only browser tabs can be shared.</p>
      <h3>Keep only the useful part</h3>
      <p class="qa-muted">The last clip appears here. Choose start and end times to save a shorter excerpt with the browser’s encoder; the original is unchanged.</p>
      <label for="qa-source">Or open a local recording</label><input id="qa-source" type="file" accept="video/webm,video/mp4">
      <video id="qa-editor" controls muted playsinline preload="metadata"></video>
      <div class="qa-range"><label>Start (seconds)<input id="qa-trim-start" type="number" min="0" step="0.1" value="0"></label><label>End (seconds)<input id="qa-trim-end" type="number" min="0" step="0.1"></label></div>
      <button type="button" id="qa-trim" disabled>Save excerpt</button><p id="qa-trim-status" role="status"></p>
      <h3>Saved evidence</h3><ul id="qa-artifacts"></ul>
    </details>`;
  if (standalone) { document.body.append(panel); return; }

  // The review re-renders #content on every navigation. Keep the panel in a hidden holder
  // off the Overview and move it back after the intro whenever the Overview renders.
  const holder = document.createElement('div');
  holder.hidden = true;
  holder.append(panel);
  document.body.append(holder);
  const mount = () => {
    const intro = document.querySelector('#content .overview-reading > .overview-intro');
    if (intro) { if (intro.nextElementSibling !== panel) intro.after(panel); }
    else if (panel.parentNode !== holder) holder.append(panel);
  };
  const content = document.getElementById('content');
  if (content) new MutationObserver(mount).observe(content, {childList: true, subtree: true});
  mount();
})();
