/* A REAL PHONE VIEWPORT, for tests that are about layout.
 *
 * Headless Chrome will not take a window narrower than 500px — pass
 * --window-size=390,844 and document.documentElement.clientWidth still comes
 * back 500. Every phone-width layout bug is therefore invisible to the
 * --dump-dom harness the other browser tests use, which is why the admin menu
 * could run 90px off the left edge of a phone with every test green.
 *
 * So this drives Chrome over the DevTools protocol and sets the device
 * metrics before navigating. The page then really is 390px wide, and
 * getBoundingClientRect means what it says.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function cdp(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(method + ' timed out')), 15000);
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(to); ws.removeEventListener('message', on); resolve(m.result);
    };
    ws.addEventListener('message', on);
  });
}

/* Serves `html` at /, runs it at the given viewport, and returns whatever the
   page assigned to window.__R. */
export async function runAtWidth({ width = 390, height = 844, html, files = {} }) {
  const srv = http.createServer((req, res) => {
    const f = files[req.url];
    if (f) { res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.body); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const dbg = 9500 + Math.floor(Math.random() * 400);
  const child = execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--remote-debugging-port=' + dbg, '--user-data-dir=' + profile, 'about:blank'], () => {});
  try {
    let targets = null;
    for (let i = 0; i < 100 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const r = await fetch('http://127.0.0.1:' + dbg + '/json/list');
        const list = await r.json();
        targets = list.filter((t) => t.type === 'page')[0] || null;
      } catch { /* not up yet */ }
    }
    if (!targets) throw new Error('Chrome never exposed a debugging target');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    let id = 0;
    await cdp(ws, ++id, 'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: true });
    await cdp(ws, ++id, 'Page.enable');
    await cdp(ws, ++id, 'Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });

    // Poll for the page to finish and publish its result.
    let out = null;
    for (let i = 0; i < 100 && out === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await cdp(ws, ++id, 'Runtime.evaluate',
        { expression: 'JSON.stringify(window.__R || null)', returnByValue: true });
      const v = r && r.result && r.result.value;
      if (v && v !== 'null') out = JSON.parse(v);
    }
    ws.close();
    if (out === null) throw new Error('the page never published a result');
    return out;
  } finally {
    child.kill();
    srv.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
