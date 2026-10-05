/* THE CUSTOMER'S PAGE, IN A REAL BROWSER AT PHONE WIDTH, AGAINST THE REAL
 * WORKER.
 *
 * This is the only page in the business a customer sees unsupervised, and it is
 * read on a phone, in a driveway, by someone deciding whether to trust us. Two
 * classes of bug matter and neither is visible in the worker's own tests:
 *
 *   THE DAY. The page turns '2026-10-15' into words. new Date('2026-10-15') is
 *   midnight UTC, which is the 14th in Utah — so the naive version names the
 *   wrong day and looks completely normal doing it. The fixture books stages on
 *   known days and the test reads back what the browser printed.
 *
 *   WHAT ENDS UP IN THE DOM. The worker's tests check the JSON. The page could
 *   still render something the JSON did not carry, or a later change could pipe
 *   more of the order through. So the rendered text is searched for the shop's
 *   cost and the customer's own details.
 *
 * Nothing here touches production.
 *
 * Run: node --experimental-sqlite tests/track-page.test.mjs
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

/* THE TIMEZONE THE BROWSER WILL BE IN, and the fixture's dates computed in it,
   so the test and the page agree about what "the 15th" means. Utah, because
   that is where the sheds are. */
const TZ = process.env.TRACK_TEST_TZ || 'America/Denver';
function localDay(offset) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + offset);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function wordsFor(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

const COST = computePricing({ style: 'barn', w: 12, l: 20, h: 9, foundation: 'pad',
  foundationFinish: 'coated', siding: 'vertical', paint: 'two-tone',
  intFinish: 'painted', floor: 'vinyl', elec: 'standard', loft: '8-ft',
  doors: [{ wall: 'front', w: 72, style: 'double', color: 'brown' }],
  windows: [{ wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' },
            { wall: 'right', w: 48, h: 36, type: 'Black Bi-Fold Bar 48x36' }],
  shelves: [{ wall: 'back', len: 8 }] }).redline;

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
           address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
           adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
           created_at TEXT, effective_price REAL);
         CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
            VALUES (1,'Hank Ellis','hank@roof.test','4355550000','123 Main St','Eagle Mountain','UT','84005','2026-08-01')`).run();
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
            VALUES (7,1,?,'won','2026-09-01')`)
  .run(JSON.stringify({ redline: COST, quotedPrice: 14250,
    permalink: 'https://shedpro-utah.com/designer.html?d=a1b2c3d4',
    config: { w: 10, l: 16, h: 9, style: 'barn', siding: 'vertical',
              foundation: 'pad', foundationFinish: 'coated',
              doors: [{ wall: 'front', w: 96, style: 'rollup', color: 'brown' }],
              windows: [{ wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' }] } }));

/* A custom charge the configurator has no option for, and a discount — the two
   things that used to leave the itemised list not adding up. */
db.prepare("UPDATE submissions SET adjustments = ? WHERE id = 7").run(JSON.stringify([
  { kind: 'amount', value: 450, note: 'Built-in workbench along the back wall' },
  { kind: 'amount', value: -200, note: 'Repeat customer' }
]));

const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' };

async function call(method, p, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + p, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}

const ADMIN = (await call('POST', '/admin/login', { password: 'pw' })).data.token;
/* The pour is two days back and ticked off; the shop day is ahead. So the page
   has a finished phase, an active one and two upcoming — all four states — and
   known days to print. */
const PREP = localDay(-3), POUR = localDay(-2), MATS = localDay(4), SHOP = localDay(5), SHED = localDay(6);
await call('POST', '/admin/submissions/7/plan', { anchor_date: POUR, confirm: true }, ADMIN);
db.prepare('DELETE FROM installs').run();
for (const [item, day] of [['prep', PREP], ['pour', POUR], ['materials', MATS],
                           ['shop', SHOP], ['shed', SHED]]) {
  db.prepare(`INSERT INTO installs (submission_id,item,install_date,days,created_at)
              VALUES (7,?,?,1,'2026-09-25')`).run(item, day);
}
const installs = (await call('GET', '/admin/customers/1', null, ADMIN)).data.installs;
for (const item of ['prep', 'pour']) {
  const row = installs.find((i) => i.item === item);
  await call('POST', '/admin/installs/' + row.id + '/done', {}, ADMIN);
}
const TOKEN = String((await call('POST', '/admin/submissions/7/track-link', {}, ADMIN)).data.url)
  .split('?t=')[1];

/* The real worker, over HTTP, for whatever the page fetches. */
async function api(req, res) {
  if (!/^\/track\//.test(req.url)) return false;
  const chunks = []; for await (const c of req) chunks.push(c);
  const out = await worker.fetch(new Request('https://local' + req.url, {
    method: req.method, headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  const text = await out.text();
  res.writeHead(out.status, { 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' });
  res.end(text);
  return true;
}

function pageFor(query, probe) {
  return readFileSync(path.join(here, '..', 'track.html'), 'utf8')
    .replace(/var API_BASE = "[^"]*";/, 'var API_BASE = "";')
    .replace(/var TOKEN = [^;]+;/, 'var TOKEN = ' + JSON.stringify(query) + ';')
    .replace('</body>', `<script>
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function until(fn,ms){var t=Date.now();while(Date.now()-t<(ms||8000)){var v=fn();if(v)return v;await sleep(60)}return null}
function txt(e){return (e&&e.textContent||'').replace(/\\s+/g,' ').trim()}
(async function(){var R={};try{ ${probe} }catch(e){R.threw=String((e&&e.stack)||e)}
window.__R=R;})();
</script></body>`);
}

const PROBE = `
  await until(function(){return document.querySelector('.phase')||document.querySelector('.state')});
  await sleep(250);
  R.state = txt(document.getElementById('state'));
  R.greet = txt(document.querySelector('.greet'));
  R.now = txt(document.querySelector('.now-text'));
  R.nowLabel = txt(document.querySelector('.now-label'));
  R.phases = [].slice.call(document.querySelectorAll('.phase')).map(function(p){
    return { name: txt(p.querySelector('.phase-name')),
             when: txt(p.querySelector('.phase-when')),
             cls: p.className,
             dot: txt(p.querySelector('.phase-dot')),
             stages: [].slice.call(p.querySelectorAll('.phase-stage')).map(txt) };
  });
  R.spec = [].slice.call(document.querySelectorAll('.spec li')).map(txt);
  R.total = txt(document.querySelector('.total'));
  /* The itemised build: a group per phase of the quote, each with its lines. */
  R.groups = [].slice.call(document.querySelectorAll('.grp')).map(function(g){
    return { name: txt(g.querySelector('.grp-name')), amt: txt(g.querySelector('.grp-amt')),
             lines: [].slice.call(g.querySelectorAll('.item')).map(function(i){
               return txt(i.querySelector('.item-name')) + ' = ' + txt(i.querySelector('.item-amt'));
             }) };
  });
  R.totalLines = [].slice.call(document.querySelectorAll('.tline')).map(txt);
  R.grand = txt(document.querySelector('.tline.grand'));
  R.body = document.body.innerText || '';
  R.html = document.body.innerHTML || '';
  R.threeD = ([].slice.call(document.querySelectorAll('a.btn'))
    .filter(function(a){return /3D/i.test(txt(a))})[0]||{}).href || null;
  /* Phone layout: nothing may stick out sideways. */
  R.vw = document.documentElement.clientWidth;
  R.scrollW = document.documentElement.scrollWidth;
  R.widest = Math.max.apply(null, [].slice.call(document.querySelectorAll('.card,.now,.phase,.btn,.greet'))
    .map(function(e){return Math.round(e.getBoundingClientRect().right)}));
  /* And the change form really posts. */
  document.getElementById('change-text').value = 'Could we add a window on the left wall?';
  document.getElementById('change-send').click();
  await until(function(){var m=document.getElementById('change-msg');return m&&/Got it/.test(txt(m))});
  R.sendMsg = txt(document.getElementById('change-msg'));
  R.sendCls = (document.getElementById('change-msg')||{}).className;
`;

console.log('\n-- a live build, on a phone --');
const R = await runAtWidth({ width: 390, height: 844, html: pageFor(TOKEN, PROBE), api, tz: TZ });
check('nothing threw', !R.threw, R.threw);
check('it really is a phone viewport', R.vw === 390, R.vw);
check('the customer is greeted by first name only',
  R.greet === 'Hank, here is your shed', R.greet);
check('four phases are drawn', R.phases.length === 4, R.phases.map((p) => p.name));
check('in the customer’s words',
  JSON.stringify(R.phases.map((p) => p.name)) ===
  JSON.stringify(['Pre-build', 'Gathering materials', 'Building in the shop', 'Build day']),
  R.phases.map((p) => p.name));

check('the finished phase is marked done', /\bdone\b/.test(R.phases[0].cls), R.phases[0].cls);
check('and shows a tick, not a number', R.phases[0].dot === '✓', R.phases[0].dot);
check('the live phase is marked active', /\bactive\b/.test(R.phases[1].cls), R.phases[1].cls);
check('later phases are upcoming',
  /upcoming/.test(R.phases[2].cls) && /upcoming/.test(R.phases[3].cls),
  [R.phases[2].cls, R.phases[3].cls]);
check('an upcoming step is numbered so it reads as a step',
  R.phases[2].dot === '3' && R.phases[3].dot === '4', [R.phases[2].dot, R.phases[3].dot]);

check('"right now" names the live phase', R.now === 'Gathering materials', R.now);
check('and it is headed as such', R.nowLabel === 'Right now', R.nowLabel);

/* THE DAY ITSELF. A UTC-parsed date would print the day before. */
check('the finished phase prints its own day, not the day before',
  R.phases[0].when === 'Done · ' + wordsFor(PREP),
  { got: R.phases[0].when, want: 'Done · ' + wordsFor(PREP) });
check('the live phase prints the right day too',
  R.phases[1].when.indexOf(wordsFor(MATS)) !== -1,
  { got: R.phases[1].when, want: wordsFor(MATS) });
check('the build day prints the right day',
  R.phases[3].when === wordsFor(SHED), { got: R.phases[3].when, want: wordsFor(SHED) });

check('the stages inside the finished phase are ticked',
  JSON.stringify(R.phases[0].stages) === JSON.stringify(['✓ Site preparation', '✓ Concrete poured']),
  R.phases[0].stages);
check('an upcoming phase does not list things that have not happened',
  R.phases[3].stages.length === 0, R.phases[3].stages);

check('the build is spelled out', R.spec.length >= 3, R.spec);

console.log('\n-- every customization, itemised --');
check('the build is broken into groups', (R.groups || []).length >= 2,
  (R.groups || []).map((g) => g.name));
const allLines = (R.groups || []).reduce((a, g) => a.concat(g.lines), []);
check('with a line for each thing chosen', allLines.length >= 5, allLines);
/* The options this fixture actually chose. A tracker that lists the shed and
   not the £2,495 window is the one that gets a phone call. */
["9' Walls", 'Exterior Paint', 'Bi-Fold Bar Window', 'Vinyl Window']
  .forEach((want) => {
    check('"' + want + '" is listed',
      allLines.some((l) => l.indexOf(want) !== -1), allLines);
  });
check('a loft is listed', allLines.some((l) => /loft/i.test(l)), allLines);
check('a shelf is listed', allLines.some((l) => /shelf/i.test(l)), allLines);
check('every line carries a price',
  allLines.length > 0 && allLines.every((l) => /= \$[\d,]+$/.test(l)), allLines);
check('no quote phase numbering leaks onto the tracker',
  (R.groups || []).every((g) => !/^Phase \d/.test(g.name)), (R.groups || []).map((g) => g.name));
check('the totals are spelled out',
  (R.totalLines || []).some((l) => /Subtotal/.test(l)) &&
  (R.totalLines || []).some((l) => /sales tax/i.test(l)), R.totalLines);
check('and it ends on their price', /^Your price/.test(R.grand || ''), R.grand);

/* THE ONE THE WHOLE ITEMISED LIST TURNS ON. A custom charge the configurator
   has no option for used to be folded into the subtotal unnamed, leaving the
   lines adding up to less than the figure printed under them. */
check('a custom charge is named, in the words it was agreed in',
  allLines.some((l) => /Built-in workbench along the back wall/.test(l)), allLines);
check('under its own heading',
  (R.groups || []).some((g) => /Custom work/i.test(g.name)), (R.groups || []).map((g) => g.name));
check('and a discount shows as a discount, not as something bought',
  (R.totalLines || []).some((l) => /Discount/.test(l)) &&
  !allLines.some((l) => /Repeat customer/.test(l)), { totals: R.totalLines, lines: allLines });
check('the 3D design is linked', /\?d=a1b2c3d4$/.test(R.threeD || ''), R.threeD);

console.log('\n-- what must never be on it --');
const costs = { trueTotalCost: COST.trueTotalCost, grandBase: COST.grandBase,
                marginDollars: COST.marginDollars, framing: COST.framing };
Object.keys(costs).forEach((k) => {
  const n = String(Math.round(costs[k]));
  check('the shop’s ' + k + ' (' + n + ') is nowhere in the page',
    Number(costs[k]) > 0 && R.html.indexOf(n) === -1, n);
});
check('no redline anywhere in the DOM', !/redline/i.test(R.html));
check('the address is not read back', R.html.indexOf('123 Main St') === -1);
check('the phone number is not read back', R.html.indexOf('4355550000') === -1);
check('the email is not read back', R.html.indexOf('hank@roof.test') === -1);
check('the surname is not read back', R.html.indexOf('Ellis') === -1);

console.log('\n-- the phone layout --');
check('nothing overflows sideways', R.scrollW <= R.vw, { scrollW: R.scrollW, vw: R.vw });
check('and nothing reaches past the gutter', R.widest <= 390 - 16 + 1,
  { widest: R.widest });

console.log('\n-- the change request --');
check('it confirms in plain words', /Got it/.test(R.sendMsg || ''), R.sendMsg);
check('and says so as good news', /sent/.test(R.sendCls || ''), R.sendCls);
const notes = db.prepare('SELECT customer_id, text FROM notes').all();
check('the note reached the shop', notes.length === 1, notes);
check('on the right customer', notes[0] && notes[0].customer_id === 1, notes[0]);
check('labelled so the shop knows what it is', /CHANGE REQUEST/.test((notes[0] || {}).text || ''), notes[0]);
check('with what they actually asked for',
  /window on the left wall/.test((notes[0] || {}).text || ''), notes[0]);

console.log('\n-- a link that is no good --');
const BAD = await runAtWidth({ width: 390, height: 844, api, tz: TZ,
  html: pageFor('00000000000000000000000000000000', `
    await until(function(){return document.querySelector('.state')});
    await sleep(200);
    R.state = txt(document.querySelector('.state'));
    R.phases = document.querySelectorAll('.phase').length;
    R.html = document.body.innerHTML;`) });
check('it says the link itself is the problem, not the network',
  /could not find a build for this link/i.test(BAD.state || ''), BAD.state);
check('and offers a way out', /give us a call/i.test(BAD.state || ''), BAD.state);
check('it does not say why, because that is a phone conversation',
  !/lost|not won|status/i.test(BAD.state || ''), BAD.state);
check('and draws no progress at all', BAD.phases === 0, BAD.phases);

/* THE FAILURE PATH. A form that quietly says "Sent" when nothing was sent is
   worse than one that says it failed: the customer waits for a call that is
   never coming. The page is loaded with a good token so it renders, then the
   token is swapped under it so the POST is refused. */
const SENDFAIL = await runAtWidth({ width: 390, height: 844, api, tz: TZ,
  html: pageFor(TOKEN, `
    await until(function(){return document.getElementById('change-send')});
    TOKEN = '00000000000000000000000000000000';
    document.getElementById('change-text').value = 'anyone there?';
    document.getElementById('change-send').click();
    await until(function(){return document.getElementById('change-msg')});
    await sleep(150);
    R.msg = txt(document.getElementById('change-msg'));
    R.cls = (document.getElementById('change-msg')||{}).className;
    R.btn = txt(document.getElementById('change-send'));
    R.disabled = document.getElementById('change-send').disabled;
    R.kept = document.getElementById('change-text').value;`) });
check('a refused change request says so', /did not send/i.test(SENDFAIL.msg || ''), SENDFAIL.msg);
check('and says it as a problem, not as good news',
  /err/.test(SENDFAIL.cls || '') && !/sent/.test(SENDFAIL.cls || ''), SENDFAIL.cls);
check('it points at the phone instead', /call or text/i.test(SENDFAIL.msg || ''), SENDFAIL.msg);
check('the button goes back to being pressable',
  SENDFAIL.disabled === false && /send to the shop/i.test(SENDFAIL.btn || ''),
  { btn: SENDFAIL.btn, disabled: SENDFAIL.disabled });
check('and what they typed is still there to retry with',
  SENDFAIL.kept === 'anyone there?', SENDFAIL.kept);
const after = db.prepare('SELECT COUNT(*) n FROM notes').get().n;
check('nothing extra was written', after === 1, after);

const NONE = await runAtWidth({ width: 390, height: 844, api, tz: TZ,
  html: pageFor('', `
    await until(function(){return document.querySelector('.state')});
    await sleep(150);
    R.state = txt(document.querySelector('.state'));`) });
check('a link with no token at all is handled too',
  /incomplete/i.test(NONE.state || ''), NONE.state);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
