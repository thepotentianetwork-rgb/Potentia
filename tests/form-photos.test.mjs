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
import { execFile, spawn } from 'node:child_process';
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

// ---- 3. the picker itself, driven in the browser -------------------------
/* The check that was missing when a contractor reported "the form wouldn't
   let me submit photos". The picker was fine and the script was fine; his
   pictures would not DECODE, and the code dropped them behind an alert. So
   this feeds real files through the shipped addProjectPhotos and looks at
   what comes out — including a file that cannot be decoded, which is the case
   that actually happened.

   The page POSTs its result back rather than writing it into the DOM for
   --dump-dom to collect. Image encoding (toBlob, createImageBitmap) runs off
   the main thread and does not finish under --virtual-time-budget, so the
   driver never reached its last line and the dump came back empty — which
   read as "nothing was added" rather than "the test never ran". Reporting
   over HTTP takes the timing question off the table entirely. */
if (haveChrome) {
  console.log('\n-- the photo picker, with real files --');
  const DRIVER = `<script>
  function jpegFile(px, name) {
    var cv = document.createElement('canvas'); cv.width = px; cv.height = px;
    var g = cv.getContext('2d');
    for (var i = 0; i < 40; i++) {
      g.fillStyle = 'rgb(' + (i*37%256) + ',' + (i*61%256) + ',' + (i*97%256) + ')';
      g.fillRect(Math.random()*px, Math.random()*px, px/4, px/4);
    }
    return new Promise(function (res) {
      cv.toBlob(function (b) { res(new File([b], name, { type: 'image/jpeg' })); }, 'image/jpeg', 0.9);
    });
  }
  function pick(files) {
    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    var inp = document.getElementById('f_photos');
    inp.files = dt.files;
    return window.addProjectPhotos(inp);
  }
  function note() { var n = document.getElementById('photoNote'); return n && n.style.display !== 'none' ? n.textContent : ''; }
  function thumbs() { return document.querySelectorAll('#photoGrid img').length; }
  function report(r) { fetch('/result', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(r) }); }
  window.addEventListener('load', function () {
    (async function () {
      var r = {};
      try {
        await pick([await jpegFile(240, 'a.jpg'), await jpegFile(240, 'b.jpg')]);
        r.afterTwoGood = thumbs();
        r.noteAfterGood = note();
        r.countText = document.getElementById('photoCount').textContent;
        var first = document.querySelector('#photoGrid img');
        r.firstIsJpegDataUrl = !!first && /^data:image\\/jpeg;base64,/.test(first.src);

        /* Named and typed as a JPEG and not one — what a HEIC looks like to a
           decoder that cannot read it. */
        await pick([new File([new Uint8Array([1,2,3,4,5,6,7,8])], 'broken.jpg', { type: 'image/jpeg' })]);
        r.afterBad = thumbs();
        r.noteAfterBad = note();

        var many = [];
        for (var i = 0; i < 12; i++) many.push(await jpegFile(200, 'm' + i + '.jpg'));
        await pick(many);
        r.afterMany = thumbs();
        r.noteAfterMany = note();
      } catch (e) { r.threw = String((e && e.stack) || e); }
      report(r);
    })();
  });
  </script>`;
  const page = form.replace('</body>', DRIVER + '</body>');

  let result = null;
  const srv = http.createServer((q, s) => {
    if (q.method === 'POST') {
      const c = [];
      q.on('data', (x) => c.push(x));
      q.on('end', () => {
        try { result = JSON.parse(Buffer.concat(c).toString()); } catch {}
        s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{}');
      });
      return;
    }
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(page);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const P2 = srv.address().port;

  /* No --virtual-time-budget and no --dump-dom: let it run in real time and
     stop as soon as the page has reported. */
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--disable-dev-shm-usage', 'http://127.0.0.1:' + P2 + '/'], { stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  while (!result && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  child.kill('SIGKILL');
  srv.close();

  const r = result || {};
  check('the page reported back at all', !!result, '(no report within 60s)');
  check('the driver ran without throwing', !r.threw, r.threw);
  check('two good photos are added', r.afterTwoGood === 2, r.afterTwoGood);
  check('and nothing is reported as wrong', !r.noteAfterGood, r.noteAfterGood);
  check('the count is written out', /2 of 10/.test(r.countText || ''), r.countText);
  check('each is stored as a JPEG data URL', r.firstIsJpegDataUrl === true, r.firstIsJpegDataUrl);

  /* The reported failure. It must not be silent, and it must not pretend it
     worked. */
  check('an undecodable file does NOT get added', r.afterBad === 2, r.afterBad);
  check('and the page says so, naming the usual cause',
    /couldn.t be opened/i.test(r.noteAfterBad || '') && /HEIC/i.test(r.noteAfterBad || ''),
    r.noteAfterBad);

  check('twelve more stop at the ten cap', r.afterMany === 10, r.afterMany);
  check('and the cap is explained', /Only 10 photos/i.test(r.noteAfterMany || ''), r.noteAfterMany);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
