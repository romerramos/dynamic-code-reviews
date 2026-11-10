/* A headless Chrome driven through its DevTools protocol, with Node built-ins only (Node 22+ has
   WebSocket). For scripts/qa_visual.js; nothing that ships loads it. */
'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find(file => fs.existsSync(file));

const sleep = ms => new Promise(done => setTimeout(done, ms));

async function launch() {
  if (!CHROME) throw new Error('No Chrome found: set CHROME to its executable');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-qa-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--allow-file-access-from-files', 'about:blank'], {stdio: 'ignore'});
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let seq = 0;
  const waiting = new Map(), listeners = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const {done, fail} = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? fail(new Error(`${message.error.message}`)) : done(message.result);
    } else listeners.forEach(fn => fn(message));
  };
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++seq;
    waiting.set(id, {done, fail});
    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
  async function page({width, height}) {
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    const call = (method, params) => send(method, params, sessionId);
    const errors = [], handlers = [];
    listeners.push(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      handlers.forEach(fn => fn(message));
    });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    const evaluate = async (expression, awaitPromise = true) => {
      const result = await call('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description || result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
      return result.result.value;
    };
    return {
      errors,
      call,
      onEvent(fn) { handlers.push(fn); },
      evaluate,
      async beforeLoad(source) { await call('Page.addScriptToEvaluateOnNewDocument', {source}); },
      async goto(url) {
        await call('Page.navigate', {url});
        for (let i = 0; i < 200; i++) {
          if (await evaluate('document.readyState === "complete"').catch(() => false)) break;
          await sleep(50);
        }
      },
      async emulateDark(dark) { await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: dark ? 'dark' : 'light'}, {name: 'prefers-reduced-motion', value: 'reduce'}]}); },
      async screenshot(file) {
        const {data} = await call('Page.captureScreenshot', {format: 'png'});
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      },
      async click(x, y) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
      },
      async close() { await send('Target.closeTarget', {targetId}); }
    };
  }
  return {page, async close() { try { await send('Browser.close'); } catch { /* gone */ } chrome.kill(); await sleep(200); try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 5}); } catch { /* Chrome still writing; the OS cleans its temp dir */ } }};
}

module.exports = {launch, sleep};
