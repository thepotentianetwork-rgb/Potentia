/* THE DASHBOARD, IN A REAL BROWSER, AGAINST THE REAL WORKER.
 *
 * This is the screen the day starts on, so the ways it can be wrong are the
 * expensive ones:
 *
 *   THE DAY. It turns stored dates into "TODAY" and "TOMORROW". Getting that
 *   one day out looks completely normal — nobody double-checks a day a computer
 *   printed — and sends somebody to a job tomorrow. The fixture books stages at
 *   known offsets and the test reads back what the browser rendered.
 *
 *   THE SHOP'S COST. Every figure is derived from rows that carry the redline.
 *   The endpoint's tests check the JSON; this checks the DOM, which is a second
 *   place it could appear.
 *
 *   PHONE WIDTH. It is read standing in a yard. Headless Chrome will not take a
 *   viewport under 500px, so this drives it over CDP like the other layout
 *   tests, and checks nothing runs off the side.
 *
 * Nothing here touches production.
 *
 * Run: node --experimental-sqlite tests/dashboard-page.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { computePricing } from '../worker/pricing.js';
import { runAtWidth, CHROME } from './phone.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 300) : '')); } };

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

/* The browser's zone. Utah, because that is where the sheds are. */
const TZ = process.env.DASH_TEST_TZ || 'America/Denver';

/* AND ITS CLOCK, PINNED. Running against the real one made two assertions
   depend on the date the suite happened to run: the sparkline check could not
   tell a bar-per-day from a bar-per-event on the 1st of a month (both draw one
   bar), and the greeting could not tell "always good morning" from the right
   one before noon. 15:30 on the 15th gives a fortnight of bars and an afternoon.
   The browser gets this clock; the worker keeps the real one, which is also
   the honest shape — the two are never in step in production either. */
const FIXED_LOCAL = '2026-10-15T15:30:00';
const FIXED_MS = Date.parse('2026-10-15T21:30:00Z');   // 15:30 MDT
const FIXED_DAY = '2026-10-15';

function localDay(offset) {
  const p = (x) => (x < 10 ? '0' : '') + x;
  const d = new Date(Date.parse(FIXED_DAY + 'T12:00:00Z'));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/* Replaces the browser's clock before the page's own script runs. Only the
   no-argument forms are pinned — everything else must still parse dates. */
const PIN_CLOCK = `<script>(function(){
  var Real = Date, fixed = ${FIXED_MS};
  function Pinned(){
    if (!(this instanceof Pinned)) return new Real(fixed).toString();
    return arguments.length ? new Real(...arguments) : new Real(fixed);
  }
  Pinned.prototype = Real.prototype;
  Pinned.now = function(){ return fixed; };
  Pinned.parse = Real.parse;
  Pinned.UTC = Real.UTC;
  window.Date = Pinned;
})();</script>`;
function shortDow(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
}

const COST = computePricing({ style: 'barn', w: 10, l: 16, h: 9, foundation: 'pad',
                              foundationFinish: 'coated', siding: 'vertical' }).redline;

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
           address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
           adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
           created_at TEXT, effective_price REAL, won_at TEXT);
         CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);

db.prepare(`INSERT INTO customers (id,name,phone,city,state,created_at)
            VALUES (1,'Hank Ellis','4355550001','Lehi','UT','2026-08-01')`).run();
db.prepare(`INSERT INTO customers (id,name,phone,city,state,created_at)
            VALUES (2,'Dana Reed','4355550002','Provo','UT','2026-08-02')`).run();
db.prepare(`INSERT INTO customers (id,name,phone,city,state,created_at)
            VALUES (3,'Mo Patel',NULL,'Orem','UT','2026-08-03')`).run();

const cfg = { w: 10, l: 16, h: 9, style: 'barn', siding: 'vertical', foundation: 'pad' };
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at,effective_price,won_at)
            VALUES (1,1,?,'won','2026-09-20T10:00:00Z',12000,?)`)
  .run(JSON.stringify({ quotedPrice: 12000, config: cfg, redline: COST,
                        renders: { perspective: 'https://r2.test/one.jpg' } }),
       FIXED_DAY + 'T16:00:00Z');
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at,effective_price,won_at)
            VALUES (2,2,?,'won','2026-09-25T10:00:00Z',9400,?)`)
  .run(JSON.stringify({ quotedPrice: 9400, config: cfg, redline: COST }),
       FIXED_DAY + 'T16:00:00Z');
/* A lead nobody has called, so the Follow Ups panel has something real in it. */
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at,effective_price)
            VALUES (3,3,?,'new',?,5200)`)
  .run(JSON.stringify({ quotedPrice: 5200, config: cfg, redline: COST }),
       FIXED_DAY + 'T14:00:00Z');

const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' };

async function call(method, p, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + p, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ADMIN = (await call('POST', '/admin/login', { password: 'pw' })).data.token;

/* Today, tomorrow and later this week — so "TODAY" and "TOMORROW" both have
   something to label and the plain weekday has something too. */
const D0 = localDay(0), D1 = localDay(1), D3 = localDay(3), FAR = localDay(40);
for (const [sub, item, day] of [[1, 'prep', D0], [1, 'pour', D1], [2, 'shop', D3],
                                [2, 'shed', FAR]]) {
  await call('POST', '/admin/submissions/' + sub + '/installs',
    { item, install_date: day, days: 1 }, ADMIN);
}
/* An unpaid invoice, for the Payments Due panel. */
db.prepare(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER, submission_id INTEGER, kind TEXT, stripe_invoice_id TEXT,
  hosted_url TEXT, amount REAL, status TEXT, lines TEXT, created_at TEXT,
  created_by TEXT, paid_at TEXT)`).run();
db.prepare(`INSERT INTO invoices (id,customer_id,submission_id,kind,amount,status,created_at,hosted_url)
            VALUES (1,1,1,'deposit',3600,'open',?,'https://pay.test/1')`)
  .run(localDay(-9) + 'T10:00:00Z');

/* Served because production serves it. Letting it fall through to the HTML
   handler hands the page itself back as a script, AdminNav comes out undefined
   and the menu silently never exists — the same trap the schedule page test
   documents. */
const FILES = {
  '/admin-nav.js': { type: 'text/javascript',
                     body: readFileSync(path.join(here, '..', 'admin-nav.js'), 'utf8') },
  '/admin-voice.js': { type: 'text/javascript',
                       body: readFileSync(path.join(here, '..', 'admin-voice.js'), 'utf8') }
};

async function api(req, res) {
  if (!/^\/admin\//.test(req.url)) return false;
  const chunks = []; for await (const c of req) chunks.push(c);
  const out = await worker.fetch(new Request('https://local' + req.url, {
    method: req.method, headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  const text = await out.text();
  res.writeHead(out.status, { 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json' });
  res.end(text);
  return true;
}

function pageWith(probe) {
  return readFileSync(path.join(here, '..', 'admin-dashboard.html'), 'utf8')
    .replace(/var API_BASE = "[^"]*";/, 'var API_BASE = "";')
    .replace('<head>', `<head>${PIN_CLOCK}<script>localStorage.setItem('potentia_admin_token', ${JSON.stringify(ADMIN)});</script>`)
    .replace('</body>', `<script>
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function until(fn,ms){var t=Date.now();while(Date.now()-t<(ms||8000)){var v=fn();if(v)return v;await sleep(60)}return null}
function txt(e){return (e&&e.textContent||'').replace(/\\s+/g,' ').trim()}
function all(sel){return [].slice.call(document.querySelectorAll(sel))}
(async function(){var R={};try{ ${probe} }catch(e){R.threw=String((e&&e.stack)||e)}
window.__R=R;})();
</script></body>`);
}

const PROBE = `
  await until(function(){return document.querySelector('.kpi')||document.querySelector('.state')});
  await sleep(300);
  R.state = txt(document.getElementById('state'));
  R.greeting = txt(document.getElementById('greeting'));
  R.kpis = all('.kpi').map(function(k){
    return { label: txt(k.querySelector('.kl')), value: txt(k.querySelector('.kv')),
             note: txt(k.querySelector('.kn')), bars: k.querySelectorAll('.spark i').length,
             href: k.getAttribute('href') };
  });
  /* An <img> for a host that does not resolve errors asynchronously, so read it
     only once every picture has either loaded or given up — otherwise this
     races and the hidden check fails at random. */
  await until(function(){
    return all('.day-shot').every(function(i){ return i.complete || i.getAttribute('data-failed'); });
  }, 6000);
  R.days = all('.day').map(function(d){
    return { when: txt(d.querySelector('.day-when b')), date: txt(d.querySelector('.day-when')),
             name: txt(d.querySelector('.day-name')), tag: txt(d.querySelector('.day-tag')),
             shot: (d.querySelector('.day-shot')||{}).getAttribute
                   ? d.querySelector('.day-shot').getAttribute('src') : null,
             shotHidden: !!(d.querySelector('.day-shot')
                            && d.querySelector('.day-shot').getAttribute('data-failed')),
             href: d.getAttribute('href') };
  });
  R.panels = all('.ptitle').map(txt);
  var cols = all('.cols > .panel');
  R.cols = cols.map(function(p){
    return { title: txt(p.querySelector('.ptitle')),
             rows: all('.row').filter(function(r){return p.contains(r)}).map(function(r){
               return { name: txt(r.querySelector('.row-name')), sub: txt(r.querySelector('.row-sub')),
                        when: txt(r.querySelector('.row-when')), chip: txt(r.querySelector('.chip')),
                        act: txt(r.querySelector('.row-act')),
                        actHref: (r.querySelector('.row-act')||{}).getAttribute
                                 ? r.querySelector('.row-act').getAttribute('href') : null };
             }),
             empty: txt(p.querySelector('.empty')) };
  });
  R.html = document.body.innerHTML;
  /* The WORDS on the screen. innerHTML carries this page's own script, so a
     search for "overdue" over it found a comment in the source and the
     assertion failed on code nobody can read. */
  R.text = document.body.innerText || '';
  R.navBtn = !!document.getElementById('nav-btn');
  R.navMenu = !!document.getElementById('nav-menu');
  var navBtn = document.getElementById('nav-btn');
  if (navBtn) { navBtn.click(); await sleep(250); }
  R.navItems = all('.nav-item').length;
  R.navLabels = all('.nav-item').map(txt);
  R.vw = document.documentElement.clientWidth;
  R.scrollW = document.documentElement.scrollWidth;
  R.widest = Math.max.apply(null, all('.kpi,.panel,.day,.row,.ptitle')
    .map(function(e){return Math.round(e.getBoundingClientRect().right)}));
`;

console.log('\n-- the dashboard on a desktop --');
const D = await runAtWidth({ width: 1440, height: 900, html: pageWith(PROBE), files: FILES, api, tz: TZ });
check('nothing threw', !D.threw, D.threw);
check('it loaded', !D.state, D.state);
/* 15:30 on the pinned clock, so this is the one right answer rather than any
   of three — which is what makes "always good morning" fail. */
check('it greets you by the time of day it actually is',
  D.greeting === 'Good afternoon.', D.greeting);

console.log('\n-- the four figures --');
check('four tiles', (D.kpis || []).length === 4, (D.kpis || []).map((k) => k.label));
check('named for what they are',
  JSON.stringify((D.kpis || []).map((k) => k.label)) ===
  JSON.stringify(['New Leads', 'Jobs Won', 'Awaiting Schedule', 'Unpaid Invoices']),
  (D.kpis || []).map((k) => k.label));
check('jobs won counts the two won today', (D.kpis[1] || {}).value === '2', D.kpis[1]);
check('and totals them', (D.kpis[1] || {}).note === '$21,400', D.kpis[1]);
check('unpaid shows the invoice', (D.kpis[3] || {}).value === '1' &&
  D.kpis[3].note === '$3,600', D.kpis[3]);
/* Both bookings are in the future, so nothing is awaiting a date. */
check('awaiting schedule is empty, because both jobs are booked',
  (D.kpis[2] || {}).value === '0', D.kpis[2]);
/* A BAR PER DAY OF THE MONTH, INCLUDING THE EMPTY ONES. Comparing the two
   tiles to each other did not catch this: a version that dropped the empty days
   gave both of them one bar, and one equals one. The count is pinned to the
   calendar instead. (+1 allowed because the window runs to whichever of the
   shop's day and the worker's day is further ahead.) */
const dayOfMonth = Number(FIXED_DAY.slice(8, 10));
check('the sparkline has a bar per day of the month so far, not per event',
  (D.kpis[0] || {}).bars === dayOfMonth || (D.kpis[0] || {}).bars === dayOfMonth + 1,
  { bars: (D.kpis[0] || {}).bars, dayOfMonth });
check('and every tile with a sparkline draws the same number of days',
  (D.kpis[0] || {}).bars === (D.kpis[1] || {}).bars,
  { leads: (D.kpis[0] || {}).bars, won: (D.kpis[1] || {}).bars });
check('each tile goes somewhere', (D.kpis || []).every((k) => !!k.href),
  (D.kpis || []).map((k) => k.href));

console.log('\n-- the week --');
check('three jobs this week, the far one left off', (D.days || []).length === 3,
  (D.days || []).map((d) => d.name + ' ' + d.when));
/* THE DAY. A UTC-parsed date prints the day before. */
check('today is called TODAY', (D.days[0] || {}).when === 'TODAY', D.days[0]);
check('tomorrow is called TOMORROW', (D.days[1] || {}).when === 'TOMORROW', D.days[1]);
check('and the one after is its own weekday',
  (D.days[2] || {}).when === shortDow(D3), { got: (D.days[2] || {}).when, want: shortDow(D3) });
check('the stage is named in words', (D.days[0] || {}).tag === 'Site prep', D.days[0]);
check('each job opens its customer',
  (D.days || []).every((d) => /^admin-customer\.html\?id=\d+$/.test(d.href || '')),
  (D.days || []).map((d) => d.href));
check('the order with a render shows that render',
  (D.days[0] || {}).shot === 'https://r2.test/one.jpg', D.days[0]);
check('the order without one shows no picture at all',
  (D.days[2] || {}).shot === null, D.days[2]);
/* The fixture's R2 host does not resolve from the browser, which makes this
   the dead-link case too: the element must hide itself rather than leave a
   broken-image icon on a job somebody is about to drive to. */
check('a picture that fails to load hides itself',
  (D.days[0] || {}).shotHidden === true, D.days[0]);

console.log('\n-- the three lists --');
check('all three are there',
  JSON.stringify((D.cols || []).map((c) => c.title)) ===
  JSON.stringify(['Follow Ups', 'Ready to Schedule', 'Payments Due']),
  (D.cols || []).map((c) => c.title));

const follow = (D.cols || [])[0] || {};
check('the uncalled lead is on the call list',
  (follow.rows || []).some((r) => r.name === 'Mo Patel'), follow.rows);
check('a customer with no number says so rather than offering a dead button',
  (follow.rows || []).some((r) => r.name === 'Mo Patel' && r.act === 'No #'), follow.rows);

const ready = (D.cols || [])[1] || {};
check('nothing is waiting on a date, and it says so plainly',
  (ready.rows || []).length === 0 && /date on it/i.test(ready.empty || ''), ready);

const pay = (D.cols || [])[2] || {};
check('the unpaid invoice is listed',
  (pay.rows || []).length === 1 && /Hank/.test(pay.rows[0].name), pay.rows);
check('it says what kind and how much', /Deposit/.test((pay.rows[0] || {}).sub || '') &&
  /\$3,600/.test((pay.rows[0] || {}).sub || ''), pay.rows[0]);
/* SENT, not overdue — nothing in this CRM records payment terms. */
check('it says how long it has been out, not that it is overdue',
  /9d out/.test((pay.rows[0] || {}).chip || ''), pay.rows[0]);
check('and nothing claims it is overdue', !/overdue/i.test(D.text || ''), D.text);
check('it links to the Stripe page',
  (pay.rows[0] || {}).actHref === 'https://pay.test/1', pay.rows[0]);

console.log('\n-- what must never be on it --');
const secret = { trueTotalCost: COST.trueTotalCost, grandBase: COST.grandBase,
                 marginDollars: COST.marginDollars, framing: COST.framing };
Object.keys(secret).forEach((k) => {
  const n = String(Math.round(secret[k]));
  check('the shop’s ' + k + ' (' + n + ') is not in the page',
    Number(secret[k]) > 0 && (D.html || '').indexOf(n) === -1, n);
});
check('no redline in the DOM', !/redline/i.test(D.html || ''));

console.log('\n-- the same screen on a phone --');
const P = await runAtWidth({ width: 390, height: 844, html: pageWith(PROBE), files: FILES, api, tz: TZ });
check('nothing threw', !P.threw, P.threw);
check('it really is a phone viewport', P.vw === 390, P.vw);
check('all four figures are still there', (P.kpis || []).length === 4);
check('and the week', (P.days || []).length === 3);
check('and all three lists', (P.cols || []).length === 3);
check('nothing overflows sideways', P.scrollW <= P.vw, { scrollW: P.scrollW, vw: P.vw });
check('and nothing reaches past the gutter', P.widest <= 390 - 16 + 1, { widest: P.widest });
check('the menu offers every page', P.navItems === 6, { labels: P.navLabels, btn: P.navBtn, menu: P.navMenu });
check('with the dashboard first', /Dashboard/.test((P.navLabels || [])[0] || ''), P.navLabels);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
