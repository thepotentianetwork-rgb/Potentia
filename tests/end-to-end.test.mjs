/* THE WHOLE JOURNEY, END TO END, WITHOUT TOUCHING PRODUCTION.
 *
 * A contractor opens the form on a phone and submits it. Someone opens him in
 * the CRM, reads his sheet, and marks his deposit as received.
 *
 * The form no longer takes photos — those come in by text now — but both real
 * bugs this file was written for lived in the request itself, not the picker:
 *
 *   - the payload was truncated, so the ANSWERS came back null
 *   - keepalive capped the request at 64 KiB, so nothing arrived at all
 *
 * Both are still reachable by anything that grows the body, so this still runs
 * the real page in a real browser against the real worker code, with SQLite
 * standing in for D1. Nothing is stubbed between the submit button and the
 * database row.
 *
 * Run: node --experimental-sqlite tests/end-to-end.test.mjs
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 220) : '')); } };

try { readFileSync(CHROME); } catch {
  console.log('Chromium not present — this test needs a real browser by design. Skipping.');
  process.exit(0);
}

// ---- D1 stand-ins --------------------------------------------------------
function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() {
        const s = db.prepare(sql);
        if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}
const env = { DB: makeD1(new DatabaseSync(':memory:')), CRM_DB: makeD1(new DatabaseSync(':memory:')),
              ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'cpw', ADMIN_SESSION_SECRET: 'k' };

// ---- the real worker, over real HTTP, plus the real page -----------------
/* --live fetches the DEPLOYED page instead of the working copy, so a green
   run says the thing customers actually load works — not just the file on
   this machine. The CRM call is still redirected to the worker running here:
   a test that writes a junk client into the live CRM is not a test anyone
   wants to run twice. */
const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://www.potentianetwork.com/contractorform.html';
let page;
if (LIVE) {
  const r = await fetch(LIVE_URL);
  if (!r.ok) { console.log('could not fetch ' + LIVE_URL + ' (' + r.status + ')'); process.exit(1); }
  page = await r.text();
  console.log('page under test: ' + LIVE_URL + ' (' + page.length + ' bytes)');
} else {
  page = readFileSync(path.join(here, '..', 'contractorform.html'), 'utf8');
  console.log('page under test: working copy');
}
const formspree = [];

const srv = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (req.url === '/formspree') {                      // stand in for the email side
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => { formspree.push(Buffer.concat(c).length); res.writeHead(200, cors); res.end('{}'); });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  /* Everything else goes to the actual Worker, exactly as Cloudflare would
     hand it over. */
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = new Request('https://local' + req.url, {
    method: req.method, headers: req.headers, body,
  });
  const out = await worker.fetch(r, env);
  const text = await out.text();
  res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
  res.end(text);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

page = page
  .replace(/var CRM_INTAKE_URL = '[^']*';/, `var CRM_INTAKE_URL = '${BASE}/crm/intake';`)
  .replace(/action="[^"]*"/, `action="${BASE}/formspree"`)
  .replace('</body>', `<script>
  window.addEventListener('load', function () {
    (async function () {
      var out = {};
      try {
        /* The uploader is gone on purpose. Left behind, it would keep taking
           photos the CRM no longer expects on this path. */
        out.uploaders = document.querySelectorAll('input[type=file]').length;
        out.tellsThemWhere = /435-277-0764/.test(document.body.textContent);

        var f = document.getElementById('onboardingForm');
        f.querySelectorAll('[required]').forEach(function (el) {
          if (el.type === 'checkbox' || el.type === 'radio') el.checked = true;
          else if (el.tagName === 'SELECT') { if (el.options.length > 1) el.selectedIndex = 1; }
          else if (!el.value) el.value = 'Test value';
        });
        f.querySelector('[name=email]').value = 'hank@roofing.test';
        var bn = f.querySelector('[name=business_name]'); if (bn) bn.value = 'Hank Roofing';
        var pd = document.getElementById('f_project_description');
        if (pd) pd.value = 'Full tear-off and re-roof, cedar shake, 1920s bungalow.';
        f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise(function (r) { setTimeout(r, 3000); });
        out.successShown = document.getElementById('successScreen').classList.contains('visible');
      } catch (e) { out.threw = String((e && e.stack) || e); }
      fetch('${BASE}/formspree', { method: 'POST', headers: { 'X-Report': '1' }, body: JSON.stringify(out) });
      await fetch('${BASE}/__done?r=' + encodeURIComponent(JSON.stringify(out)));
    })();
  });
  </script></body>`);

// capture the browser's own report
let report = null;
const origHandler = srv.listeners('request')[0];
srv.removeAllListeners('request');
srv.on('request', (req, res) => {
  if (req.url.startsWith('/__done')) {
    try { report = JSON.parse(decodeURIComponent(req.url.split('r=')[1] || '{}')); } catch {}
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end('ok');
  }
  return origHandler(req, res);
});

console.log('\n-- a contractor fills the form in --');
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--disable-dev-shm-usage', BASE + '/'], { stdio: 'ignore' });
const deadline = Date.now() + 90000;
while (!report && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
child.kill('SIGKILL');

const rep = report || {};
check('the browser got through it', !!report && !rep.threw, rep.threw || '(no report in 90s)');
check('the file picker is gone from the page', rep.uploaders === 0, rep.uploaders);
check('and it says where to text them instead', rep.tellsThemWhere === true, rep.tellsThemWhere);
check('and the form showed its success screen', rep.successShown === true, rep.successShown);
check('Formspree got the sheet too', formspree.length >= 1, formspree.length);

// ---- now the CRM side ----------------------------------------------------
console.log('\n-- and it is all there in the CRM --');
const api = async (m, p, body, tok) => {
  const h = { 'Content-Type': 'application/json', Origin: 'https://potentianetwork.com' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
};
const tok = (await api('POST', '/crm/login', { password: 'cpw' })).data.token;
const list = await api('GET', '/crm/clients', null, tok);
const client = (list.data.clients || list.data || []).find((c) => (c.email || '') === 'hank@roofing.test');
check('the contractor became a client', !!client, list.data);

if (client) {
  const sheets = await api('GET', '/crm/clients/' + client.id + '/intake', null, tok);
  const sheet = (sheets.data.sheets || [])[0];
  check('his onboarding sheet is readable', !!sheet, sheets.data);
  if (sheet) {
    check('his answers came through', sheet.answers && sheet.answers.email === 'hank@roofing.test',
      sheet.answers && Object.keys(sheet.answers).length);
    check('the project description is there',
      /cedar shake/.test((sheet.answers || {}).project_description || ''),
      (sheet.answers || {}).project_description);
    check('and no photos rode along', (sheet.photos || []).length === 0, (sheet.photos || []).length);

    console.log('\n-- and the deposit can be marked --');
    check('it starts unmarked', sheet.deposit.received === false, sheet.deposit);
    await api('POST', '/crm/intake/deposit', { intake_id: sheet.id, received: true, amount: 1500, by: 'Nando' }, tok);
    const after = await api('GET', '/crm/clients/' + client.id + '/intake', null, tok);
    const d = after.data.sheets[0].deposit;
    check('marking it sticks', d.received === true && d.amount === 1500, d);
    check('with a date and who marked it', !!d.at && d.marked_by === 'Nando', d);
  }
}
srv.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
