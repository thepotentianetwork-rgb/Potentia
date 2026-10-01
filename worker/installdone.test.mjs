/* TICKING A STAGE OFF, AND WHY IT IS A SEPARATE FACT FROM THE DATE.
 *
 * installs.install_date is a PLAN. Until done_at existed, the only thing the
 * CRM — and the customer tracker built on top of it — could say was what the
 * diary said, so the first time a pour slipped a day the page was confidently
 * wrong. A plan and a report of what happened are two different facts and this
 * file keeps them apart: ticking a stage must not move its date, and a date
 * going past must not tick anything off.
 *
 * Run: node --experimental-sqlite --test worker/installdone.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

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

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
             address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
              VALUES (1,'Hank Ellis','hank@roof.test','4355550000','123 Main St','Lehi','UT','84043','2026-08-01')`).run();
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (7,1,?,'won','2026-09-01')`)
    .run(JSON.stringify({ quotedPrice: 9000, config: { w: 10, l: 16, h: 9, style: 'barn',
                                                       foundation: 'pad' } }));
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}

async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function token(env) {
  return (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
}
/* Through the planner, so the rows are the ones the shop will really be
   ticking off rather than hand-made ones. */
async function planned(env, t) {
  await api(env, 'POST', '/admin/submissions/7/plan',
    { anchor_date: '2026-10-07', confirm: true }, t);
  return (await api(env, 'GET', '/admin/customers/1', null, t)).data.installs;
}
function rows(db) {
  return db.prepare('SELECT id, item, install_date, done_at FROM installs ORDER BY install_date, id').all();
}

test('a stage starts life not done', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const installs = await planned(env, t);
  assert.ok(installs.length, 'the planner booked nothing');
  installs.forEach((i) => {
    assert.equal(i.done_at, null, i.item + ' was born already finished');
  });
  assert.ok(rows(db).every((r) => r.done_at === null));
});

test('one tap ticks a stage off, and says when', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const installs = await planned(env, t);
  const pour = installs.find((i) => i.item === 'pour');

  const r = await api(env, 'POST', '/admin/installs/' + pour.id + '/done', {}, t);
  assert.equal(r.status, 200);
  assert.ok(r.data.done_at, 'no timestamp came back');
  assert.ok(!isNaN(Date.parse(r.data.done_at)), 'done_at is not a date: ' + r.data.done_at);

  const after = rows(db).find((x) => x.item === 'pour');
  assert.equal(after.done_at, r.data.done_at);
});

/* An empty body is what a plain button sends. */
test('no body at all means done', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const id = (await planned(env, t)).find((i) => i.item === 'shop').id;
  const r = await worker.fetch(new Request('https://local/admin/installs/' + id + '/done',
    { method: 'POST', headers: { Authorization: 'Bearer ' + t } }), env);
  assert.equal(r.status, 200);
  assert.ok(rows(db).find((x) => x.item === 'shop').done_at, 'an empty body did not count as done');
});

/* THE MOST LIKELY MISTAKE THERE IS: a tap on the wrong row, which would
   otherwise tell a customer their shed was built. */
test('it can be untapped again', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const id = (await planned(env, t)).find((i) => i.item === 'prep').id;
  await api(env, 'POST', '/admin/installs/' + id + '/done', {}, t);
  assert.ok(rows(db).find((x) => x.item === 'prep').done_at);

  const r = await api(env, 'POST', '/admin/installs/' + id + '/done', { done: false }, t);
  assert.equal(r.status, 200);
  assert.equal(r.data.done_at, null);
  assert.equal(rows(db).find((x) => x.item === 'prep').done_at, null, 'it stayed done');
});

/* A PLAN AND A REPORT ARE DIFFERENT FACTS. If ticking a stage moved its date,
   the schedule would reorder itself under the crew as they worked. */
test('ticking a stage off does not move it in the diary', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const installs = await planned(env, t);
  const dates = rows(db).map((r) => [r.item, r.install_date]);
  assert.ok(dates.length, 'nothing was booked to compare');
  for (const i of installs) await api(env, 'POST', '/admin/installs/' + i.id + '/done', {}, t);
  assert.deepEqual(rows(db).map((r) => [r.item, r.install_date]), dates,
    'a date moved when a stage was ticked off');
  assert.ok(rows(db).every((r) => r.done_at), 'not every stage was actually ticked off');
});

test('ticking one stage leaves the others alone', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const installs = await planned(env, t);
  const shed = installs.find((i) => i.item === 'shed');
  await api(env, 'POST', '/admin/installs/' + shed.id + '/done', {}, t);
  const done = rows(db).filter((r) => r.done_at).map((r) => r.item);
  assert.deepEqual(done, ['shed'], 'the wrong stages were marked: ' + done.join(','));
});

test('the tick survives to both pages the shop reads', async () => {
  const { env } = setup();
  const t = await token(env);
  const id = (await planned(env, t)).find((i) => i.item === 'materials').id;
  await api(env, 'POST', '/admin/installs/' + id + '/done', {}, t);

  const cust = await api(env, 'GET', '/admin/customers/1', null, t);
  assert.ok(cust.data.installs.find((i) => i.id === id).done_at,
    'the customer page does not know it was done');

  const sched = await api(env, 'GET', '/admin/schedule', null, t);
  assert.ok(sched.data.installs.find((i) => i.id === id).done_at,
    'the schedule page does not know it was done');
});

test('a stage nobody has can not be ticked off', async () => {
  const { env } = setup();
  const t = await token(env);
  await planned(env, t);
  assert.equal((await api(env, 'POST', '/admin/installs/99999/done', {}, t)).status, 404);
});

test('it needs an admin token', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const id = (await planned(env, t)).find((i) => i.item === 'pour').id;
  assert.equal((await api(env, 'POST', '/admin/installs/' + id + '/done', {})).status, 401);
  assert.equal(rows(db).find((x) => x.item === 'pour').done_at, null, 'it was ticked off anyway');
});

/* Asserting "nothing was deleted" alone passes happily on a 404: a route that
   is never reached does nothing, which is exactly what makes that failure
   quiet. So this checks the tick LANDED as well as that the row survived — the
   two halves of "the right row changed and only it". */
test('the done route is reachable, and does not delete the stage', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const installs = await planned(env, t);
  const n = installs.length;
  const r = await api(env, 'POST', '/admin/installs/' + installs[0].id + '/done', {}, t);
  assert.equal(r.status, 200, 'the route was not reached: ' + JSON.stringify(r.data));
  assert.equal(rows(db).length, n, 'a stage went missing');
  assert.equal(rows(db).filter((x) => x.done_at).length, 1, 'nothing was ticked off');
});

/* The planner books stages this endpoint used to refuse by hand. */
test('every stage the planner books can also be added by hand', async () => {
  const { env } = setup();
  const t = await token(env);
  const planner = (await planned(env, t)).map((i) => i.item);
  assert.ok(planner.length >= 4, 'fixture produced too few stages');
  for (const item of new Set(planner.concat(['gravel', 'concrete']))) {
    const r = await api(env, 'POST', '/admin/submissions/7/installs',
      { item, install_date: '2026-11-02', days: 1 }, t);
    assert.equal(r.status, 200, item + ' was refused: ' + JSON.stringify(r.data));
  }
  const bad = await api(env, 'POST', '/admin/submissions/7/installs',
    { item: 'housewarming', install_date: '2026-11-02' }, t);
  assert.equal(bad.status, 400, 'any string at all was accepted as a stage');
});
