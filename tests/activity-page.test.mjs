/* THE NOTIFICATION TAB, IN A REAL BROWSER.
 *
 * The badge is the whole feature: a number that is wrong, or that will not
 * clear, is worse than no badge — you either chase nothing or stop trusting
 * it. "Seen" lives in localStorage, so this drives two page loads and checks
 * the second one remembers the first.
 *
 * Run: node --experimental-sqlite tests/activity-page.test.mjs
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 240) : '')); } };

try { readFileSync(CHROME); } catch {
  console.log('Chromium not present — this test needs a real browser by design. Skipping.');
  process.exit(0);
}

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

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
           address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
           adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
           created_at TEXT, effective_price REAL);`);
db.prepare("INSERT INTO customers (id,name,email,created_at) VALUES (1,'Hank Ellis','h@r.test','2026-08-01')").run();
db.prepare("INSERT INTO customers (id,name,email,created_at) VALUES (2,'Dana Reed','d@r.test','2026-08-02')").run();

const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' };

/* Recent, so the page prints "x minutes ago" rather than a date. */
const mins = (n) => new Date(Date.now() - n * 60000).toISOString();

let page = readFileSync(path.join(here, '..', 'admin-activity.html'), 'utf8');
const helper = readFileSync(path.join(here, '..', 'admin-activity.js'), 'utf8');
let report = null;

const srv = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*',
                 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'POST' && req.url === '/__result') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { report = JSON.parse(b); } catch {} res.writeHead(204).end(); });
    return;
  }
  if (req.url === '/admin-activity.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(helper);
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const out = await worker.fetch(new Request('https://local' + req.url, {
    method: req.method, headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  const text = await out.text();
  res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
  res.end(text);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

const login = await worker.fetch(new Request('https://local/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'pw' }) }), env);
const TOKEN = (await login.json()).token;

/* Warm the lazily-created tables through the worker, then seed. */
await worker.fetch(new Request('https://local/admin/activity',
  { headers: { Authorization: 'Bearer ' + TOKEN } }), env);

db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,'won',?)`)
  .run(JSON.stringify({ quotedPrice: 9000, config: { w: 10, l: 16, style: 'barn' } }), mins(300));
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (8,2,?,'new',?)`)
  .run(JSON.stringify({ consult: true, bestTime: 'mornings' }), mins(200));
db.prepare(`INSERT INTO invoices (customer_id,submission_id,kind,stripe_invoice_id,hosted_url,
            amount,status,lines,created_at,created_by) VALUES (1,7,'deposit','in_1','https://pay/x',2700,'open','[]',?,null)`)
  .run(mins(120));
db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
            VALUES (1,2700,'stripe','Deposit paid on Stripe',?,?,7)`).run(mins(30), mins(30));

page = page
  .replace(/var API_BASE = "[^"]*";/, `var API_BASE = "${BASE}";`)
  .replace('<head>', `<head><script>localStorage.setItem('potentia_admin_token', ${JSON.stringify(TOKEN)});</script>`)
  .replace('</body>', `<script>
var R = {};
/* Read SYNCHRONOUSLY, before the page's fetch resolves — the first load sets
   the baseline itself, so reading this after the feed has rendered would
   always find it set and prove nothing. */
R.seenBefore = localStorage.getItem('shedpro_admin_activity_seen');
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function until(fn,ms){var t=Date.now();while(Date.now()-t<(ms||6000)){var v=fn();if(v)return v;await sleep(60)}return null}
function txt(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim()}
function rows(){return [].slice.call(document.querySelectorAll('.ev'))}
function snap(){
  return rows().map(function(r){
    return { tag: txt(r.querySelector('.ev-tag')), text: txt(r.querySelector('.ev-text')),
             sub: txt(r.querySelector('.ev-sub')), when: txt(r.querySelector('.ev-when')),
             cls: r.className, dot: !!r.querySelector('.ev-dot'),
             acts: [].slice.call(r.querySelectorAll('.act')).map(txt) };
  });
}
function press(label){
  var b=[].slice.call(document.querySelectorAll('.filter-btn'))
    .filter(function(x){return txt(x)===label})[0];
  if(b) b.click();
  return !!b;
}
(async function(){
  try{
    await until(function(){return rows().length});
    R.first = snap();
    R.count = txt(document.getElementById('count'));
    R.badge = txt(document.getElementById('hdr-badge'));
    R.badgeShown = document.getElementById('hdr-badge').style.display !== 'none';

    R.pressedPayments = press('Payments');
    await sleep(200);
    R.payments = snap();
    press('Everything');
    await sleep(200);

    document.getElementById('mark-read').click();
    await sleep(300);
    R.afterMark = snap();
    R.badgeAfter = document.getElementById('hdr-badge').style.display === 'none';
    R.markDisabled = document.getElementById('mark-read').disabled;
    R.seenAfter = localStorage.getItem('shedpro_admin_activity_seen');
  }catch(e){R.threw=String((e&&e.stack)||e)}
  fetch('${BASE}/__result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(R)});
})();
</script></body>`);

async function run(url) {
  report = null;
  await new Promise((resolve) => {
    execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
      '--user-data-dir=/tmp/claude-0/act-profile',
      '--virtual-time-budget=25000', '--dump-dom', url],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 }, () => resolve());
  });
  return report || {};
}

const A = await run(BASE + '/');

console.log('\n-- the feed --');
check('the browser reported back', !!A.first, '(nothing)');
check('nothing threw', !A.threw, A.threw);
check('four things happened', (A.first || []).length === 4,
  (A.first || []).map((r) => r.tag));
check('newest first — the payment leads',
  JSON.stringify((A.first || []).map((r) => r.tag)) ===
  JSON.stringify(['Paid', 'Invoiced', 'Call back', 'New design']),
  (A.first || []).map((r) => r.tag));
check('a payment reads like a sentence',
  (A.first[0] || {}).text === 'Hank Ellis paid $2,700.00', (A.first[0] || {}).text);
check('an invoice says which kind and to whom',
  (A.first[1] || {}).text === 'Deposit invoice sent to Hank Ellis — $2,700.00',
  (A.first[1] || {}).text);
check('a consult says they want a call', /asked for a call back/.test((A.first[2] || {}).text || ''),
  (A.first[2] || {}).text);
check('and it carries the best time to ring',
  /mornings/.test((A.first[2] || {}).sub || ''), (A.first[2] || {}).sub);
check('times are relative, which is the question being asked',
  /minutes ago|hours ago/.test((A.first[0] || {}).when || ''), (A.first[0] || {}).when);
check('every row opens the customer',
  (A.first || []).every((r) => r.acts.indexOf('Open customer') !== -1),
  (A.first || []).map((r) => r.acts));
check('and the invoice row links to the invoice',
  ((A.first[1] || {}).acts || []).indexOf('Invoice ↗') !== -1, (A.first[1] || {}).acts);

console.log('\n-- the badge, which is the whole point --');
/* FIRST EVER VISIT sets the baseline. Flagging sixty rows of existing history
   as new is noise on day one and teaches you to ignore the dot; leaving the
   badge dark until someone presses "mark all as seen" is a notification that
   only works once you have acknowledged the ones you never got. So: nothing
   new, and a line drawn under where things stood. */
check('nothing was marked seen before this visit', !A.seenBefore, A.seenBefore);
check('the first visit flags nothing as new', A.badge === '' || A.badgeShown === false,
  { badge: A.badge, shown: A.badgeShown });
check('no row is highlighted', (A.first || []).every((r) => !r.dot),
  (A.first || []).map((r) => r.cls));
check('but it draws the line, so the next thing counts', !!A.seenAfter, A.seenAfter);

console.log('\n-- filtering --');
check('Payments shows only the payment',
  A.pressedPayments === true && (A.payments || []).length === 1 &&
  (A.payments[0] || {}).tag === 'Paid', A.payments);

/* THE ONE THAT MATTERS: a payment arriving after that line must light it up. */
db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
            VALUES (2,4500,'stripe','Balance paid on Stripe',?,?,null)`)
  .run(new Date().toISOString(), new Date().toISOString());

const B = await run(BASE + '/');
console.log('\n-- and when a customer pays --');
check('the badge appears, showing one', B.badge === '1', B.badge);
check('and is visible', B.badgeShown === true);
check('the new payment is at the top and flagged',
  (B.first[0] || {}).dot === true && /Dana Reed paid \$4,500\.00/.test((B.first[0] || {}).text || ''),
  B.first && B.first[0]);
check('the older four stay quiet',
  ((B.first || []).slice(1)).every((r) => !r.dot), (B.first || []).map((r) => r.dot));
check('the count says one is new', /1 new/.test(B.count || ''), B.count);

console.log('\n-- marking it seen --');
check('the highlight clears', (B.afterMark || []).every((r) => !r.dot && !/ new/.test(r.cls)),
  (B.afterMark || []).map((r) => r.cls));
check('the badge goes away', B.badgeAfter === true);
check('and the button disables itself', B.markDisabled === true);

/* A badge that comes back after being cleared is the failure that makes
   people stop looking at it. Same browser profile, so localStorage carries. */
const C = await run(BASE + '/');
console.log('\n-- coming back later --');
check('it stays cleared', C.badge === '' || C.badgeShown === false,
  { badge: C.badge, shown: C.badgeShown });
check('the history is all still there', (C.first || []).length === 5, (C.first || []).length);
check('and none of it is highlighted', (C.first || []).every((r) => !r.dot),
  (C.first || []).map((r) => r.dot));

srv.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
