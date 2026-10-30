import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { once } from 'node:events';

const appScript = "document.querySelector('#go').addEventListener('click',function mark(){document.querySelector('#state').textContent='clicked';});";
async function closeBrowser(endpoint, browser) {
  const exited = browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : once(browser, 'exit');
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const deadline = setTimeout(() => { socket.close(); reject(new Error('Owned browser close transport did not settle')); }, 10000);
    const closed = () => { clearTimeout(deadline); resolve(); };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    socket.onclose = closed;
    // Browser.close can tear down CDP without a WebSocket close frame.
    // This is not success unless the owned OS process also exits below.
    socket.onerror = closed;
  });
  let deadline;
  try {
    await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Owned browser process termination not confirmed')), 10000); })]);
  } finally { clearTimeout(deadline); }
  assert(browser.exitCode !== null || browser.signalCode !== null);
}
export async function validate(h) {
  const candidates = [process.env.REA_LITE_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  let executable;
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) { executable = candidate; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!executable) { await h.record({ name: 'Browser capabilities', status: 'blocked', reason: 'No existing browser found in configured/local candidate paths; set REA_LITE_CHROME to an existing Chrome/Edge executable; no download attempted.' }); return; }
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/app.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/app.js' ? appScript : "<!doctype html><title>REA Lite Browser Fixture</title><button id='go'>Validate</button><p id='state'>ready</p><script src='/app.js'></script>");
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + path.join(h.work, 'browser-profile'), origin], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let endpoint;
  try {
    endpoint = await new Promise((resolve, reject) => {
      let startup = '';
      const deadline = setTimeout(() => reject(new Error('Owned browser readiness timeout')), 20000);
      browser.once('error', error => { clearTimeout(deadline); reject(error); });
      browser.stderr.on('data', chunk => {
        startup += chunk.toString();
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(startup);
        if (match) { clearTimeout(deadline); resolve(match[1]); }
      });
      browser.once('exit', code => { clearTimeout(deadline); reject(new Error(`Owned browser exited before readiness: ${code}`)); });
    });
    const httpEndpoint = endpoint.replace(/^ws:/, 'http:').split('/devtools/')[0];
    const targets = await h.check('Browser isolated page discovery', ['list-browser-targets', httpEndpoint, '--allowed-origins', origin, '--format', 'json'], data => {
      assert(data.normalized_result.targets.some(target => target.origin === origin && target.type === 'page'));
      return { origin, browser: data.normalized_result.browser.product, isolated_profile: true };
    });
    const target = targets.data.normalized_result.targets.find(target => target.origin === origin);
    await h.check('Browser accessibility and script observation', ['inspect-web-page', httpEndpoint, target.target_id, '--allowed-origins', origin, '--observation-ms', '100', '--include-accessibility-text', '--include-script-sources', '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.target.origin, origin);
      assert.equal(result.target.title, 'REA Lite Browser Fixture');
      assert(result.accessibility.nodes.some(node => node.role === 'button' && node.name === 'Validate'));
      assert(result.accessibility.nodes.some(node => node.role === 'StaticText' && node.name === 'ready'));
      return { title: result.target.title, known_button: 'Validate', initial_state: 'ready' };
    });
    await h.check('Browser direct click listener provenance', ['inspect-web-event-listeners', httpEndpoint, target.target_id, '#go', '--allowed-origins', origin, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.selected_node.match, 'found');
      assert(result.listeners.some(listener => listener.type === 'click' && listener.location.url === origin + '/app.js'));
      const source = result.sources.find(source => source.url === origin + '/app.js');
      assert.equal(source.source.text, appScript);
      assert.equal(source.source.sha256, createHash('sha256').update(appScript).digest('hex'));
      return { callback: 'click', source_sha256: source.source.sha256, execution: 'unknown; listener registration is not invocation' };
    });
    await h.check('Browser PNG screenshot integrity', ['capture-web-screenshot', httpEndpoint, target.target_id, '--allowed-origins', origin, '--format', 'json'], async data => {
      const result = data.normalized_result;
      const bytes = Buffer.from(result.artifact.data_base64, 'base64');
      assert.equal(result.artifact.media_type, 'image/png');
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.length, result.artifact.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.artifact.sha256);
      const screenshot = path.join(h.work, 'browser.png');
      await writeFile(screenshot, bytes, { flag: 'wx' });
      return { screenshot, sha256: result.artifact.sha256, viewport: result.viewport };
    });
    const scenario = await h.input('browser-click', { browser: { mode: 'connect', cdp_endpoint: httpEndpoint, target_id: target.target_id }, start_url: { url: origin }, actions: [{ action: 'click', step_id: 'click-known-button', locator: { kind: 'css', selector: '#go' } }] });
    await h.check('Browser declared click scenario', ['capture-browser-scenario', scenario, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.browser.mode, 'connect');
      assert(result.steps.some(step => step.step_id === 'click-known-button' && step.status === 'completed' && step.action === 'click'));
      return { steps: result.steps.map(step => ({ step_id: step.step_id, status: step.status })), browser_cleanup: result.browser.cleanup };
    });
    await h.check('Browser click state transition observed', ['inspect-web-page', httpEndpoint, target.target_id, '--allowed-origins', origin, '--observation-ms', '100', '--include-accessibility-text', '--format', 'json'], data => {
      assert(data.normalized_result.accessibility.nodes.some(node => node.role === 'StaticText' && node.name === 'clicked'));
      assert(!data.normalized_result.accessibility.nodes.some(node => node.role === 'StaticText' && node.name === 'ready'));
      return { before: 'ready', after: 'clicked', performed_by: 'REA declared click scenario on owned fixture' };
    });
    await h.record({ name: 'Electron-specific runtime', status: 'not_tested', reason: 'Browser and Node Inspector are verified separately, not proof of Electron IPC, preload isolation, fuse behavior or Electron-owned lifecycle. No Electron fixture runtime was selected.' });
  } finally {
    try {
      if (endpoint) await closeBrowser(endpoint, browser);
      else browser.kill();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}
