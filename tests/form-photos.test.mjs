/* THE REQUEST THAT CARRIES THE PHOTOS, IN A REAL BROWSER.
 *
 * This one fetch has now broken twice, and neither break was visible to Node.
 *
 *   1. The photos were left on the body when the worker built its payload.
 *      payload is capped at 60,000 characters and one base64 photo is bigger
 *      than that alone, so the JSON was cut mid-string and every answer on
 *      the sheet came back null. A worker test caught that one.
 *
 *   2. The fetch used `keepalive: true`, which caps a request body at 64 KiB.
 *      A sheet WITH photos did not merely lose the pictures — the fetch threw
 *      TypeError, the catch swallowed it, and NO SHEET reached the CRM at
 *      all. Nothing caught it. It shipped, and a real contractor's submission
 *      is how it was found.
 *
 * Two checks. The first is the regression guard; the second is why, shown
 * against a real browser rather than asserted from memory of the spec.
 *
 * Chromium is driven with execFile and AWAITED, not execFileSync. The sync
 * form blocks the event loop this file's own stub server runs on, so the
 * browser waits for a page that can never be served and the run hangs. That
 * deadlock was hit and written down once already in this project, in the
 * ShedPro repo's scripts/ai/dryrun.mjs, and then walked into again here.
 *
 * Run: node tests/form-photos.test.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 200) : '')); } };

// ---- 1. the shipped page must not put keepalive on that request ----------
console.log('\n-- the form source --');
const form = readFileSync(path.join(here, '..', 'contractorform.html'), 'utf8');
const m = /function sendToCrm[\s\S]*?\n  }/.exec(form);
check('sendToCrm is still there', !!m);
if (m) {
  const src = m[0];
  check('it does NOT use keepalive — 64 KiB cap, and one photo exceeds it',
    !/keepalive/.test(src));
  check('it returns its promise, so the caller can wait for it', /return fetch\(/.test(src));
  check('and it still attaches the photos', /project_photos/.test(src));
}
check('the submit handler waits for it before showing success', /await sendToCrm\(/.test(form));

// ---- 2. why, demonstrated against a real browser -------------------------
console.log('\n-- what keepalive does to a photo-sized body --');
let haveChrome = true;
try { readFileSync(CHROME); } catch { haveChrome = false; }
if (!haveChrome) {
  console.log('  (Chromium not present — skipping the live half)');
} else {
  const got = [];
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'POST') {
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => { got.push({ url: req.url, bytes: n }); res.writeHead(200, cors); res.end('{}'); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body><pre id="o"></pre><script>' +
      'function post(u,l,k){var b=JSON.stringify({blob:"x".repeat(l)});' +
      'return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:b,keepalive:k})' +
      '.then(function(){return "SENT";}).catch(function(e){return "FAILED "+e.name;});}' +
      '(async function(){var L=[];' +
      'L.push("keepalive "+await post("/ka",1500000,true));' +
      'L.push("plain "+await post("/plain",1500000,false));' +
      'document.getElementById("o").textContent=L.join("|");document.title="DONE";})();' +
      '</script></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;

  const dom = await new Promise((resolve) => {
    execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
      '--virtual-time-budget=10000', '--dump-dom', 'http://127.0.0.1:' + PORT + '/'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
      (err, stdout) => {
        if (err) console.log('  (chromium: ' + String(err.message).slice(0, 90) + ')');
        resolve(stdout || '');
      });
  });
  server.close();

  const out = (/<pre id="o">([^<]*)<\/pre>/.exec(dom) || [])[1] || '';
  check('a 1.5MB body with keepalive is REFUSED by the browser', /keepalive FAILED/.test(out), out);
  check('the same body without keepalive is sent', /plain SENT/.test(out), out);
  check('and only the plain one reached the server',
    got.some((g) => g.url === '/plain') && !got.some((g) => g.url === '/ka'),
    got.map((g) => g.url + ' ' + g.bytes));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
