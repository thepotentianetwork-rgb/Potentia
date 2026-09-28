/* THE CALL AND TEXT BUTTONS, BUILT IN A REAL BROWSER.
 *
 * Both CRM pages put these on a lead. The one that can go badly wrong is Text:
 * voice.google.com/calls WITH a number opens the DIALER, so a Text button that
 * carries the number is a button that silently places a call. The number goes
 * to the clipboard instead. That is the assertion this file exists for; the
 * rest guard the things around it.
 *
 * Run in a browser rather than a DOM stub because the interesting parts are
 * what the browser resolves — the href it builds from a relative-looking
 * string, and whether the anchor really carries no target.
 *
 * Run: node tests/call-text.test.mjs
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

// ---- 1. the pages use the shared code, not their own copy ---------------
console.log('\n-- one implementation, two pages --');
const lead = readFileSync(path.join(here, '..', 'crm-lead.js'), 'utf8');
const list = readFileSync(path.join(here, '..', 'crm.html'), 'utf8');
const client = readFileSync(path.join(here, '..', 'crm-client.html'), 'utf8');

check('crm-lead.js exports the buttons', /phoneActions: phoneActions/.test(lead));
check('the list asks it for them', /LeadDetail\.phoneActions\(/.test(list));
check('the client page asks it for them', /LeadDetail\.phoneActions\(/.test(client));
/* A second copy of the URLs is how the Text button quietly grows a number. */
check('the client page keeps no second copy of the URLs',
  !/voice\.google\.com/.test(client));
check('and no second copy of the E.164 rule', !/function toE164/.test(client));

// ---- 2. what the browser actually builds --------------------------------
let haveChrome = true;
try { readFileSync(CHROME); } catch { haveChrome = false; }
if (!haveChrome) {
  console.log('  (Chromium not present — skipping the live half)');
} else {
  console.log('\n-- the buttons, built and resolved by a browser --');
  const HARNESS = `<!doctype html><meta charset="utf-8"><body>
<div id="out"></div>
<script src="/crm-lead.js"></script>
<script>
var r = {};
function anchors(phone, opts) {
  var box = document.createElement('div');
  var f = LeadDetail.phoneActions(phone, opts);
  if (f) box.appendChild(f);
  return [].slice.call(box.querySelectorAll('a'));
}
try {
  r.e164 = ['5551234567', '(435) 291-0979', '1-435-291-0979', '+44 20 7123 4567', '', '12', 'abc']
    .map(function (v) { return v + ' => ' + LeadDetail.toE164(v); });

  var a = anchors('435-291-0979');
  r.count = a.length;
  r.labels = a.map(function (x) { return x.textContent; });
  r.hrefs = a.map(function (x) { return x.href; });
  r.targets = a.map(function (x) { return x.target || '(none)'; });
  r.rels = a.map(function (x) { return x.rel; });
  r.svgs = a.map(function (x) { return x.querySelectorAll('svg').length; });
  r.titles = a.map(function (x) { return x.title; });

  r.noNumber = anchors(null).length;
  r.tooShort = anchors('12').length;
  r.classed = anchors('4352910979', { className: 'qa-sm' }).map(function (x) { return x.className; });
} catch (e) { r.threw = String((e && e.stack) || e); }
fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
</script></body>`;

  let result = null;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/result') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => { try { result = JSON.parse(b); } catch {} res.writeHead(204).end(); });
      return;
    }
    if (req.url === '/crm-lead.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(lead);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HARNESS);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;

  await new Promise((resolve) => {
    execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
      '--virtual-time-budget=10000', '--dump-dom', 'http://127.0.0.1:' + PORT + '/'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 }, () => resolve());
  });
  srv.close();

  const r = result || {};
  check('the page reported back', !!result, '(nothing)');
  check('nothing threw', !r.threw, r.threw);

  check('E.164 handles the shapes a lead arrives in',
    JSON.stringify(r.e164) === JSON.stringify([
      '5551234567 => +15551234567',
      '(435) 291-0979 => +14352910979',
      '1-435-291-0979 => +14352910979',
      '+44 20 7123 4567 => +442071234567',
      ' => null',
      '12 => null',
      'abc => null']), r.e164);

  check('two buttons', r.count === 2, r.count);
  check('labelled Call and Text', JSON.stringify(r.labels) === '["Call","Text"]', r.labels);
  check('each has its icon', JSON.stringify(r.svgs) === '[1,1]', r.svgs);

  const [callHref, textHref] = r.hrefs || [];
  check('Call dials the number',
    callHref === 'https://voice.google.com/calls?a=nc,%2B14352910979', callHref);
  /* THE ONE THAT MATTERS. */
  check('Text carries NO number — that path opens the dialer',
    textHref === 'https://voice.google.com/calls' && !/4352910979/.test(textHref || ''), textHref);
  check('Call has no /u/0/ account index — iOS gives the app the link without it',
    !/\/u\/\d/.test(callHref || ''), callHref);

  check('both open in the current tab, so iOS hands them to the app',
    JSON.stringify(r.targets) === '["(none)","(none)"]', r.targets);
  check('both are rel=noopener', JSON.stringify(r.rels) === '["noopener","noopener"]', r.rels);
  check('the Text button says the number is copied', /copies \+14352910979/.test((r.titles || [])[1] || ''),
    (r.titles || [])[1]);

  check('no number means no buttons at all', r.noNumber === 0, r.noNumber);
  check('and neither does a number too short to dial', r.tooShort === 0, r.tooShort);
  check('the list can size them down', JSON.stringify(r.classed) === '["qa-sm","qa-sm"]', r.classed);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
