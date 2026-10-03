/* THE BUILD SCHEDULE MESSAGE — the words a customer reads, and the endpoint
 * the CRM's "Send Build Schedule" button asks for them.
 *
 * The message is written once, in the worker, so the hand-sent text of today
 * and the Twilio text of tomorrow cannot drift apart. These pin what it says,
 * what it must never carry (the shop's guest list, its internal notes), and
 * that it only exists for a won order with dates on it.
 *
 * Run: node --experimental-sqlite --test worker/schedulemsg.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scheduleMessage, smStages, smDay } from './schedulemsg.js';
import { planBuild } from './schedule.js';
import worker from './index.js';

const TRACK = 'https://www.potentianetwork.com/track.html?t=0123456789abcdef0123456789abcdef';
const gravelRows = () => planBuild('2026-10-13', { foundation: 'gravel' })
  .map((s, i) => ({ id: i + 1, ...s, done_at: null }));

// ── the words ───────────────────────────────────────────────────────────────

test('dates read like a person wrote them', () => {
  assert.equal(smDay('2026-10-13'), 'Tue Oct 13');
  assert.equal(smDay('2026-10-14T00:00:00Z'), 'Wed Oct 14');
  assert.equal(smDay('2026-02-30'), null);
  assert.equal(smDay(''), null);
});

test('a gravel job lists shop, then pad, then install, in plain words', () => {
  const m = scheduleMessage({ firstName: 'Hank', installs: gravelRows(), trackUrl: TRACK,
                              address: '123 Main St, Eagle Mountain, UT 84005', shopPhone: '435-277-0764' });
  assert.deepEqual(m.stages.map((s) => [s.item, s.when]), [
    ['materials', 'Fri Oct 9'], ['shop', 'Mon Oct 12'], ['gravel', 'Tue Oct 13'], ['shed', 'Wed Oct 14']]);
  assert.match(m.text, /^Hi Hank! Here's your ShedPro build schedule:/);
  assert.match(m.text, /- Gravel pad: Tue Oct 13 - at your place\n/);
  assert.match(m.text, /- Shed install: Wed Oct 14 \(2 days\) - at your place\n/);
  assert.match(m.text, /- Shed built in our shop: Mon Oct 12\n/, 'the shop day does not say "at your place"');
  assert.ok(m.text.indexOf('Gravel pad: Tue') < m.text.indexOf('Shed install: Wed'));
  assert.ok(m.text.indexOf('Follow your build anytime: ' + TRACK) !== -1);
  assert.match(m.text, /Call or text 435-277-0764/);
  assert.equal(m.subject, 'Your ShedPro build schedule');
});

test('a calendar link for each day at their place, and none for the shop', () => {
  const m = scheduleMessage({ firstName: 'Hank', installs: gravelRows(), trackUrl: TRACK,
                              address: '123 Main St', shopPhone: '1' });
  assert.deepEqual(m.calendar.map((c) => c.item), ['gravel', 'shed']);
  m.calendar.forEach((c) => {
    assert.ok(c.url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE'));
    assert.ok(m.text.indexOf(c.url) !== -1, 'the link is in the message');
  });
  assert.match(m.calendar[1].url, /dates=20261014\/20261016/, 'the 2-day install spans two days');
});

/* The shop's own invite links carry the crew's guest list and internal notes.
   A customer who saved one would invite the crew from their own calendar. */
test('the customer links carry no guests and no shop notes', () => {
  const rows = gravelRows().map((r) => ({ ...r, note: 'gate code 4411, customer is difficult' }));
  const m = scheduleMessage({ firstName: 'Hank', installs: rows, trackUrl: TRACK, address: 'x', shopPhone: '1' });
  m.calendar.forEach((c) => assert.ok(!/[?&]add=/.test(c.url), 'a guest list leaked: ' + c.url));
  assert.ok(!/gate code|difficult/.test(m.text + m.calendar.map((c) => decodeURIComponent(c.url)).join()));
});

test('plain ASCII in our own words, so a text stays in the cheap encoding', () => {
  const m = scheduleMessage({ firstName: 'Hank', installs: gravelRows(), trackUrl: TRACK, address: 'x', shopPhone: '1' });
  assert.ok(/^[\x00-\x7f]*$/.test(m.text), 'non-ASCII in: ' + m.text.match(/[^\x00-\x7f]/));
});

test('a concrete job keeps its order, pour first', () => {
  const rows = planBuild('2026-10-07', { foundation: 'concrete' }).map((s, i) => ({ id: i + 1, ...s }));
  assert.deepEqual(smStages(rows).map((s) => s.item), ['prep', 'pour', 'materials', 'shop', 'shed']);
});

test('the newest booking of a stage wins, and done stages say so', () => {
  const rows = [
    { id: 1, item: 'shed', install_date: '2026-10-14', days: 2 },
    { id: 5, item: 'shed', install_date: '2026-10-21', days: 1 },
    { id: 2, item: 'gravel', install_date: '2026-10-13', days: 1, done_at: '2026-10-13T20:00:00Z' },
    { id: 3, item: 'bogus', install_date: '2026-10-01' },
    { id: 4, item: 'shop', install_date: 'soon' }
  ];
  const s = smStages(rows);
  assert.deepEqual(s.map((x) => [x.item, x.date]), [['gravel', '2026-10-13'], ['shed', '2026-10-21']]);
  const m = scheduleMessage({ installs: rows, trackUrl: null });
  assert.match(m.text, /^Hi! /, 'no name, no awkward greeting');
  assert.match(m.text, /Gravel pad: Tue Oct 13 - at your place \(done\)/);
  assert.deepEqual(m.calendar.map((c) => c.item), ['shed'], 'no calendar link for a day already done');
  assert.ok(!/Follow your build/.test(m.text));
});

// ── the endpoint ────────────────────────────────────────────────────────────

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

function setup(status = 'won', customer = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
             address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
  const c = { name: 'Hank Ellis', email: 'hank@roof.test', phone: '4355550000',
              address: '123 Main St', city: 'Eagle Mountain', state: 'UT', zip: '84005', ...customer };
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
              VALUES (1,?,?,?,?,?,?,?,?)`)
    .run(c.name, c.email, c.phone, c.address, c.city, c.state, c.zip, '2026-08-01');
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,?,'2026-09-01')`)
    .run(JSON.stringify({ quotedPrice: 9000, config: { w: 10, l: 16, style: 'barn', foundation: 'gravel' } }), status);
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}
async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
const login = async (env) => (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
const msg = (env, t, id = 7) => api(env, 'POST', '/admin/submissions/' + id + '/schedule-message', null, t);

test('the endpoint writes the message for a planned, won order', async () => {
  const { db, env } = setup();
  const t = await login(env);
  await api(env, 'POST', '/admin/submissions/7/plan', { anchor_date: '2026-10-13', confirm: true }, t);
  const r = await msg(env, t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.stages.map((s) => s.item), ['materials', 'shop', 'gravel', 'shed']);
  assert.match(r.data.text, /^Hi Hank! /, 'first name only');
  assert.ok(!/Ellis/.test(r.data.text), 'no surname in a message that may be forwarded');
  assert.match(r.data.text, /Gravel pad: Tue Oct 13 - at your place/);
  assert.match(r.data.track_url, /track\.html\?t=[0-9a-f]{32}$/);
  assert.ok(r.data.text.indexOf(r.data.track_url) !== -1);
  assert.equal(r.data.phone, '4355550000');
  assert.equal(r.data.email, 'hank@roof.test');
  assert.match(decodeURIComponent(r.data.calendar[0].url), /location=123 Main St/);
  /* Asking twice reuses the same tracking link rather than minting another. */
  const again = await msg(env, t);
  assert.equal(again.data.track_url, r.data.track_url);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM installs').get().n, 4, 'and it books nothing');
});

test('no message for an order that is not won, or has no dates', async () => {
  const lost = setup('quoted');
  const t1 = await login(lost.env);
  assert.equal((await msg(lost.env, t1)).status, 409);

  const empty = setup('won');
  const t2 = await login(empty.env);
  const r = await msg(empty.env, t2);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /plan the build/i);

  assert.equal((await msg(empty.env, t2, 999)).status, 404);
});

test('the endpoint needs an admin login', async () => {
  const { env } = setup();
  assert.equal((await msg(env, null)).status, 401);
});

test('a customer with no phone or email still gets a message to copy', async () => {
  const { env } = setup('won', { phone: '', email: '' });
  const t = await login(env);
  await api(env, 'POST', '/admin/submissions/7/plan', { anchor_date: '2026-10-13', confirm: true }, t);
  const r = await msg(env, t);
  assert.equal(r.status, 200);
  assert.equal(r.data.phone, null);
  assert.equal(r.data.email, null);
  assert.ok(r.data.text.length > 50);
});
