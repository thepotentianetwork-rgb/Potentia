/* THE SCHEDULE PAGE, IN A REAL BROWSER, AGAINST THE REAL WORKER.
 *
 * The page's whole job is turning stored dates into "Today", "Tomorrow" and
 * the right headings. That arithmetic fails silently: a page that heads every
 * job one day early looks completely normal, and nobody double-checks a date
 * a computer printed. So the fixture books jobs at known offsets from today
 * and the test reads back what the browser actually rendered.
 *
 * Stripe is not involved. Nothing here touches production.
 *
 * Run: node --experimental-sqlite tests/schedule-page.test.mjs
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { computePricing } from '../worker/pricing.js';

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

/* Local calendar days, the same way the page computes them — if this drifted
   the test would agree with a broken page. */
const TEST_TZ = process.env.SCHEDULE_TEST_TZ || 'America/Denver';
function localDay(offset) {
  /* Today in the BROWSER's timezone. Computing it in node's zone instead
     would make the fixture disagree with the page for the hours where the two
     are on different calendar days — which is exactly the window this test
     exists to cover, and it would fail for reasons that look like a bug in
     the page. */
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TEST_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + offset);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const { redline } = computePricing({ style: 'barn', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', siding: 'vertical' });

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
           address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
           adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
           created_at TEXT, effective_price REAL);
         CREATE TABLE installs (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL,
           item TEXT NOT NULL, install_date TEXT NOT NULL, days REAL, note TEXT, created_at TEXT NOT NULL);`);
db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,created_at)
            VALUES (1,'Hank Ellis','hank@roof.test','4355550000','123 Main St','Eagle Mountain','UT','2026-08-01')`).run();
db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,created_at)
            VALUES (2,'Dana Reed','dana@reed.test','4355551111','9 Oak Ave','Lehi','UT','2026-08-02')`).run();
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,'won','2026-09-01')`)
  .run(JSON.stringify({ redline, config: { w: 10, l: 16, style: 'barn', siding: 'vertical' } }));
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (9,2,?,'won','2026-09-02')`)
  .run(JSON.stringify({ redline, config: { w: 12, l: 20, style: 'gable' } }));

/* Known offsets from today, so the labels are predictable whenever this runs. */
const BOOKED = [
  [7, 'shed', 0, 2, 'gate code 1234'],
  [9, 'concrete', 1, 1, null],
  [7, 'shed', 5, 1, null],
  [9, 'shed', 40, 1, null],      // outside the 30-day range
  [7, 'concrete', -6, 1, null],  // in the past
];
for (const [sub, item, offset, days, note] of BOOKED) {
  db.prepare(`INSERT INTO installs (submission_id,item,install_date,days,note,created_at)
              VALUES (?,?,?,?,?,?)`).run(sub, item, localDay(offset), days, note, '2026-09-25');
}

const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k',
              INSTALL_CALENDAR_GUESTS: 'crew@shedpro.test' };

let page = readFileSync(path.join(here, '..', 'admin-schedule.html'), 'utf8');
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
  /* Served because production serves it. Letting this 404 made AdminNav
     undefined, the page script threw, and every assertion failed for one
     reason that had nothing to do with what was being tested. */
  if (req.url === '/admin-nav.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(readFileSync(path.join(here, '..', 'admin-nav.js'), 'utf8'));
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

page = page
  .replace(/var API_BASE = "[^"]*";/, `var API_BASE = "${BASE}";`)
  .replace('<head>', `<head><script>localStorage.setItem('potentia_admin_token', ${JSON.stringify(TOKEN)});
    localStorage.removeItem('shedpro_schedule_view');</script>`)
  .replace('</body>', `<script>
var R = {};
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function until(fn, ms){var t=Date.now();while(Date.now()-t<(ms||6000)){var v=fn();if(v)return v;await sleep(60)}return null}
function txt(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim()}
function days(){return [].slice.call(document.querySelectorAll('.day'))}
function cells(){return [].slice.call(document.querySelectorAll('.cal-day'))}
function cell(iso){return document.querySelector('.cal-day[data-day="'+iso+'"]')}
function chipsOn(iso){var c=cell(iso);return c?[].slice.call(c.querySelectorAll('.cal-chip')).map(txt):null}
function snapshot(){
  return days().map(function(d){
    return { head: txt(d.querySelector('.day-date')),
             when: txt(d.querySelector('.day-when')),
             whenCls: (d.querySelector('.day-when')||{}).className,
             jobs: [].slice.call(d.querySelectorAll('.job')).map(function(j){
               return { item: txt(j.querySelector('.job-item')),
                        name: txt(j.querySelector('.job-name')),
                        href: (j.querySelector('.job-name')||{}).getAttribute('href'),
                        meta: txt(j.querySelector('.job-meta')),
                        note: txt(j.querySelector('.job-note')),
                        acts: [].slice.call(j.querySelectorAll('.act')).map(txt),
                        invite: ([].slice.call(j.querySelectorAll('.act'))
                          .filter(function(a){return /invite/i.test(txt(a))})[0]||{}).href || null };
             }) };
  });
}
function pressBtn(label){
  var b=[].slice.call(document.querySelectorAll('.range-btn'))
    .filter(function(x){return txt(x)===label && x.offsetParent !== null})[0];
  if(b) b.click();
  return !!b;
}
(async function(){
  try{
    await until(function(){return cells().length});
    R.defaultView = txt(document.querySelector('#views .range-btn.on'));
    R.cellCount = cells().length;
    R.dows = [].slice.call(document.querySelectorAll('.cal-dow')).map(txt);
    R.monthName = txt(document.getElementById('month-name'));
    R.rangesHidden = document.getElementById('ranges').hidden;
    R.listEmpty = txt(document.getElementById('list')) === '';
    R.count = txt(document.getElementById('count'));

    R.todayCellIso = (document.querySelector('.cal-day.today')||{}).getAttribute
      ? document.querySelector('.cal-day.today').getAttribute('data-day') : null;

    R.chips = { d0: chipsOn(DAY0), d1: chipsOn(DAY1), d0b: chipsOn(DAY0B) };
    R.spanSecond = chipsOn(DAY0_PLUS1);

    /* Tap the day with the two-day shed install on it. */
    var c = cell(DAY0);
    R.pickable = !!c && c.tagName === 'BUTTON';
    if (c) { c.click(); await sleep(250); }
    R.pickedIso = (document.querySelector('.cal-day.picked')||{}).getAttribute
      ? document.querySelector('.cal-day.picked').getAttribute('data-day') : null;
    R.pickedHead = txt(document.querySelector('.picked-head'));
    R.pickedJobs = [].slice.call(document.querySelectorAll('#cal .job'))
      .map(function(j){return txt(j.querySelector('.job-name'))});
    R.pickedActs = [].slice.call(document.querySelectorAll('#cal .job .act')).map(txt);

    /* Stepping months. */
    document.getElementById('next-month').click();
    await sleep(400);
    await until(function(){return cells().length});
    R.nextMonth = txt(document.getElementById('month-name'));
    R.clearedOnStep = !document.querySelector('.cal-day.picked');
    document.getElementById('this-month').click();
    await sleep(400);
    R.backToToday = txt(document.getElementById('month-name'));

    /* And the list view still works. */
    R.pressedList = pressBtn('List');
    await sleep(400);
    await until(function(){return days().length});
    R.calHidden = document.getElementById('cal').hidden;
    R.rangesShown = !document.getElementById('ranges').hidden;
    R.month = snapshot();
    R.listCount = txt(document.getElementById('count'));

    R.pressedWeek = pressBtn('Next 7 days');
    await sleep(400);
    await until(function(){return days().length});
    R.week = snapshot();

    R.pressedPast = pressBtn('Past');
    await sleep(400);
    await until(function(){return days().length});
    R.past = snapshot();

    R.pressedAll = pressBtn('Everything');
    await sleep(400);
    await until(function(){return days().length});
    R.all = snapshot();
    R.allCount = txt(document.getElementById('count'));
  }catch(e){R.threw=String((e&&e.stack)||e)}
  fetch('${BASE}/__result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(R)});
})();
</script></body>`)
  /* The fixture's dates, handed to the page so the test looks cells up by
     date rather than counting squares — which would depend on what day of
     the month it happens to be run. */
  .replace('<body>', `<body><script>
    var DAY0=${JSON.stringify(localDay(0))}, DAY1=${JSON.stringify(localDay(1))},
        DAY0B=${JSON.stringify(localDay(5))}, DAY0_PLUS1=${JSON.stringify(localDay(1))};
  </script>`);

const TZ = process.env.SCHEDULE_TEST_TZ || 'America/Denver';
await new Promise((resolve) => {
  execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--virtual-time-budget=30000', '--dump-dom', BASE + '/'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000,
      env: { ...process.env, TZ } }, () => resolve());
});
srv.close();

const R = report || {};
console.log('\n-- the calendar --');
check('the browser reported back', !!report, '(nothing)');
check('nothing threw', !R.threw, R.threw);
check('it opens on the month grid', R.defaultView === 'Month', R.defaultView);
check('six weeks of cells', R.cellCount === 42, R.cellCount);
check('a weekday header, starting Sunday',
  JSON.stringify(R.dows) === '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]', R.dows);
check('the range buttons are put away in this view', R.rangesHidden === true);
check('and the list is not drawn underneath it', R.listEmpty === true);
check('it names the month it is showing',
  (R.monthName || '').indexOf(new Intl.DateTimeFormat('en-US',
    { timeZone: TEST_TZ, month: 'long' }).format(new Date())) === 0, R.monthName);

/* Today's cell, found by its own date rather than by counting squares —
   parsing the day as UTC would mark the wrong one west of Greenwich. */
check('today is marked, and it is actually today', R.todayCellIso === localDay(0),
  { marked: R.todayCellIso, today: localDay(0) });

console.log('\n-- jobs on the grid --');
check('the shed install shows on its day',
  (R.chips.d0 || []).some((c) => /Ellis/.test(c)), R.chips.d0);
check('a second job five days out shows too',
  (R.chips.d0b || []).some((c) => /Ellis/.test(c)), R.chips.d0b);
/* A two-day install occupies both days. A calendar that only marks start
   dates tells you the yard is free on a day it is not. */
check('a two-day install spans both days',
  (R.spanSecond || []).some((c) => /Ellis/.test(c)), R.spanSecond);
check('and the second day is marked as a continuation, not a new job',
  (R.spanSecond || []).some((c) => /^·/.test(c)), R.spanSecond);
check('a different customer on the same day appears alongside it',
  (R.spanSecond || []).some((c) => /Reed/.test(c)), R.spanSecond);
check('the count is for the month on screen', /job/.test(R.count || ''), R.count);

console.log('\n-- tapping a day --');
check('a day with jobs is tappable', R.pickable === true);
check('it opens that day', R.pickedIso === localDay(0), { picked: R.pickedIso, expected: localDay(0) });
check('with a full heading', /\d{4}/.test(R.pickedHead || ''), R.pickedHead);
check('and the whole job, not just a chip',
  (R.pickedJobs || []).some((n) => n === 'Hank Ellis'), R.pickedJobs);
check('Call, Text, Map and Invite are all on it',
  ['Call', 'Text', 'Map ↗', 'Invite ↗'].every((a) => (R.pickedActs || []).indexOf(a) !== -1),
  R.pickedActs);

console.log('\n-- stepping months --');
check('next month moves on', !!R.nextMonth && R.nextMonth !== R.monthName,
  { from: R.monthName, to: R.nextMonth });
check('and clears the open day', R.clearedOnStep === true);
check('Today comes back', R.backToToday === R.monthName,
  { back: R.backToToday, expected: R.monthName });

console.log('\n-- the list view still works --');
check('switching hides the grid and shows the ranges',
  R.pressedList === true && R.calHidden === true && R.rangesShown === true,
  { cal: R.calHidden, ranges: R.rangesShown });
const month = R.month || [];
check('three days are booked in the next 30', month.length === 3,
  month.map((d) => d.head + ' / ' + d.when));
check('today is labelled Today', (month[0] || {}).when === 'Today', month[0]);
check('tomorrow is labelled Tomorrow', (month[1] || {}).when === 'Tomorrow', month[1]);
check('five days out reads In 5 days', (month[2] || {}).when === 'In 5 days', month[2]);
const todayName = new Intl.DateTimeFormat('en-US',
  { timeZone: TEST_TZ, weekday: 'long' }).format(new Date());
check('the heading names the right weekday, not yesterday\u2019s',
  ((month[0] || {}).head || '').indexOf(todayName) === 0,
  { head: (month[0] || {}).head, expected: todayName });

const first = ((month[0] || {}).jobs || [])[0] || {};
check('a job carries its detail', first.item === 'Install' &&
  first.name === 'Hank Ellis' && first.href === 'admin-customer.html?id=1', first);
check('the install note is shown', first.note === 'gate code 1234', first.note);
check('the invite carries the customer AND the crew',
  /add=hank%40roof\.test%2Ccrew%40shedpro\.test|add=hank%40roof\.test,crew%40shedpro\.test/
    .test(first.invite || ''), first.invite);

console.log('\n-- the ranges --');
check('Next 7 days drops the one 5 weeks out and the past one',
  R.pressedWeek === true && (R.week || []).length === 3, (R.week || []).map((d) => d.when));
check('Past shows only what has already happened',
  R.pressedPast === true && (R.past || []).length === 1 &&
  /ago/.test(((R.past || [])[0] || {}).when || ''), R.past);
check('Everything shows all five bookings',
  R.pressedAll === true &&
  (R.all || []).reduce((t, d) => t + d.jobs.length, 0) === 5,
  { days: (R.all || []).length, count: R.allCount });

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
