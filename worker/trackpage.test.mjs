/* THE ONE PAGE A STRANGER CAN OPEN.
 *
 * /track/:token has no login. The token is the whole of the authorisation, so
 * the things that matter are what it will NOT serve: an order that is not a
 * live job, anyone else's order, the shop's own cost, and anything about the
 * customer that whoever is holding the link should not be reading back.
 *
 * Run: node --experimental-sqlite --test worker/trackpage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing } from './pricing.js';
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

const { redline } = computePricing({ style: 'barn', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', siding: 'vertical' });

function setup(extraEnv = {}) {
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
              VALUES (7,1,?,'proposal','2026-09-01')`)
    .run(JSON.stringify({ redline, quotedPrice: 9000,
                          permalink: 'https://shedpro-utah.com/designer.html?d=a1b2c3d4',
                          config: { w: 10, l: 16, h: 9, style: 'barn', siding: 'vertical',
                                    foundation: 'pad', foundationFinish: 'coated',
                                    doors: [{ wall: 'front', w: 96, style: 'rollup', color: 'brown' }] } }));
  /* A second customer, so "it only ever shows one order" can actually fail. */
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
              VALUES (2,'Dana Reed','dana@reed.test','4355551111','9 Oak Ave','Lehi','UT','84043','2026-08-02')`).run();
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (9,2,?,'won','2026-09-02')`)
    .run(JSON.stringify({ redline, quotedPrice: 4000, config: { w: 8, l: 12, style: 'gable' } }));
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k', ...extraEnv } };
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
async function win(env, t, id = 7) {
  return api(env, 'POST', '/admin/submissions/status', { id, status: 'won' }, t);
}
async function linkFor(env, t, id = 7) {
  const r = await api(env, 'POST', '/admin/submissions/' + id + '/track-link', {}, t);
  return r.data && r.data.url ? r.data.url : null;
}
function tokenOf(url) {
  return String(url || '').split('?t=')[1] || '';
}
async function plan(env, t, id = 7, anchor = '2026-10-07') {
  return api(env, 'POST', '/admin/submissions/' + id + '/plan',
    { anchor_date: anchor, confirm: true }, t);
}

// ── the link ────────────────────────────────────────────────────────────────

test('winning an order issues its tracking link', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const url = await linkFor(env, t);
  assert.ok(url, 'no link came back');
  assert.match(url, /^https:\/\/www\.potentianetwork\.com\/track\.html\?t=[0-9a-f]{32}$/,
    'the link is not the shape expected: ' + url);
});

/* A LINK ALREADY IN SOMEONE'S INBOX HAS TO KEEP WORKING. */
test('the link never changes once issued', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const first = await linkFor(env, t);
  await api(env, 'POST', '/admin/submissions/status', { id: 7, status: 'proposal' }, t);
  await win(env, t);
  await plan(env, t);
  assert.equal(await linkFor(env, t), first, 'the customer’s link was reissued under them');
});

test('an order that is not won has no tracking page to link to', async () => {
  const { env } = setup();
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/submissions/7/track-link', {}, t);
  assert.equal(r.status, 409);
  assert.equal(await linkFor(env, t), null);
});

test('the link endpoint needs an admin token', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  assert.equal((await api(env, 'POST', '/admin/submissions/7/track-link', {})).status, 401);
});

test('an order that does not exist has no link', async () => {
  const { env } = setup();
  const t = await token(env);
  assert.equal((await api(env, 'POST', '/admin/submissions/4242/track-link', {}, t)).status, 404);
});

test('the base can be moved without a code change', async () => {
  const { env } = setup({ TRACK_BASE_URL: 'https://shedpro-utah.com/where-is-my-shed.html' });
  const t = await token(env);
  await win(env, t);
  assert.match(await linkFor(env, t), /^https:\/\/shedpro-utah\.com\/where-is-my-shed\.html\?t=/);
});

/* Planning is the other moment a job becomes real, and the install invite is
   built right after it. */
test('planning a build also issues the link', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare("UPDATE submissions SET status = 'won' WHERE id = 7").run();
  await plan(env, t);
  const row = db.prepare('SELECT track_token FROM submissions WHERE id = 7').get();
  assert.match(String(row.track_token), /^[0-9a-f]{32}$/);
});

// ── what the page serves ────────────────────────────────────────────────────

test('the page comes back with the build and its four phases', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  await plan(env, t);
  const tok = tokenOf(await linkFor(env, t));

  const r = await api(env, 'GET', '/track/' + tok);
  assert.equal(r.status, 200);
  assert.equal(r.data.first_name, 'Hank', 'the whole name was read back');
  assert.equal(r.data.order_id, 7);
  assert.deepEqual(r.data.phases.map((p) => p.key),
    ['prebuild', 'materials', 'shop', 'install']);
  assert.equal(r.data.phases[0].state, 'active');
  assert.ok(r.data.spec.length, 'no build spec');
  assert.equal(r.data.complete, false);
  assert.match(r.data.design_url, /\?d=a1b2c3d4$/, 'no 3D link');
  assert.equal(r.data.total, 9000);
  assert.ok(r.data.shop_phone, 'nothing to call');
});

test('ticking a stage off moves the customer’s page on', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  await plan(env, t);
  const tok = tokenOf(await linkFor(env, t));

  const installs = (await api(env, 'GET', '/admin/customers/1', null, t)).data.installs;
  for (const item of ['prep', 'pour']) {
    const row = installs.find((i) => i.item === item);
    await api(env, 'POST', '/admin/installs/' + row.id + '/done', {}, t);
  }
  const r = await api(env, 'GET', '/track/' + tok);
  assert.equal(r.data.phases[0].state, 'done', 'the foundation went in and the page did not move');
  assert.equal(r.data.phases[1].state, 'active');
  assert.deepEqual(r.data.phases[0].stages.map((s) => [s.label, s.done]),
    [['Site preparation', true], ['Concrete poured', true]]);
});

// ── what it must never serve ────────────────────────────────────────────────

/* THE SHOP'S COST. redline is in the same submission row the page reads from,
   so this is one careless spread away at all times. */
test('the shop’s own cost never leaves the building', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));
  const r = await api(env, 'GET', '/track/' + tok);
  const body = JSON.stringify(r.data);
  assert.ok(!/redline/i.test(body), 'the word redline is in the response');
  assert.ok(!/\bcost\b/i.test(body), 'a cost field is in the response');
  assert.ok(!/margin/i.test(body), 'a margin figure is in the response');

  /* Every number the shop would not say out loud, checked by value rather than
     by field name — a leak would arrive under some other name. */
  const secret = { trueTotalCost: redline.trueTotalCost, grandBase: redline.grandBase,
                   marginDollars: redline.marginDollars, framing: redline.framing,
                   helperCost: redline.helperCost };
  Object.keys(secret).forEach((k) => {
    assert.ok(Number(secret[k]) > 0, 'the fixture has no ' + k + ' to leak');
    [String(secret[k]), String(Math.round(secret[k]))].forEach((n) => {
      assert.ok(body.indexOf(n) === -1, k + ' (' + n + ') is in the response');
    });
  });
});

/* It does not need to recite the customer back to whoever has the link. */
test('it does not read the customer’s details back', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));
  const body = JSON.stringify((await api(env, 'GET', '/track/' + tok)).data);
  assert.ok(body.indexOf('123 Main St') === -1, 'the address is on the page');
  assert.ok(body.indexOf('4355550000') === -1, 'the customer phone is on the page');
  assert.ok(body.indexOf('hank@roof.test') === -1, 'the customer email is on the page');
  assert.ok(body.indexOf('Ellis') === -1, 'the surname is on the page');
});

test('one token shows one order, never the one next to it', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const mine = tokenOf(await linkFor(env, t));
  const theirs = tokenOf(await linkFor(env, t, 9));
  assert.ok(mine && theirs && mine !== theirs, 'two orders share a token');

  assert.equal((await api(env, 'GET', '/track/' + mine)).data.order_id, 7);
  const other = await api(env, 'GET', '/track/' + theirs);
  assert.equal(other.data.order_id, 9);
  assert.equal(other.data.first_name, 'Dana');
});

/* AN UN-WON ORDER GOES DARK. The token is not burned — it may already be in an
   inbox — but it serves nothing until the job is live again. */
test('a token stops working when the order stops being won', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));
  assert.equal((await api(env, 'GET', '/track/' + tok)).status, 200);

  await api(env, 'POST', '/admin/submissions/status', { id: 7, status: 'lost' }, t);
  assert.equal((await api(env, 'GET', '/track/' + tok)).status, 404, 'a lost job is still on show');

  await win(env, t);
  assert.equal((await api(env, 'GET', '/track/' + tok)).status, 200, 'the same link did not come back');
});

test('a token nobody issued is not found', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  for (const bad of ['', 'x', '00000000000000000000000000000000',
                     'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', '../admin/customers/1',
                     "' OR 1=1 --"]) {
    const r = await api(env, 'GET', '/track/' + encodeURIComponent(bad));
    assert.equal(r.status, 404, 'a token of "' + bad + '" was served');
  }
});

test('the order id in the path is no use without the token', async () => {
  const { env } = setup();
  const t = await token(env);
  await win(env, t);
  assert.equal((await api(env, 'GET', '/track/7')).status, 404);
});

// ── the change request ──────────────────────────────────────────────────────

test('a change request lands as a note on their own record', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));

  const r = await api(env, 'POST', '/track/' + tok + '/change',
    { text: 'Could we add a window on the left wall?' });
  assert.equal(r.status, 200);

  const notes = db.prepare('SELECT customer_id, text FROM notes').all();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].customer_id, 1, 'it landed on the wrong customer');
  assert.match(notes[0].text, /CHANGE REQUEST/, 'the shop cannot tell what this note is');
  assert.match(notes[0].text, /order #7/, 'it does not say which order');
  assert.match(notes[0].text, /window on the left wall/);

  const seen = await api(env, 'GET', '/admin/customers/1', null, t);
  assert.ok(seen.data.notes.some((n) => /CHANGE REQUEST/.test(n.text)),
    'the shop never sees it');
});

/* IT IS A MESSAGE, NOT AN EDIT. A customer changing a won order directly is how
   a shed gets built to one spec and invoiced against another. */
test('a change request changes nothing about the order', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await win(env, t);
  await plan(env, t);
  const tok = tokenOf(await linkFor(env, t));
  const before = db.prepare('SELECT details, status, effective_price FROM submissions WHERE id = 7').get();
  const dates = db.prepare('SELECT item, install_date, done_at FROM installs ORDER BY id').all();

  await api(env, 'POST', '/track/' + tok + '/change', { text: 'make it 14 feet wide' });

  assert.deepEqual(db.prepare('SELECT details, status, effective_price FROM submissions WHERE id = 7').get(),
    before, 'the order changed');
  assert.deepEqual(db.prepare('SELECT item, install_date, done_at FROM installs ORDER BY id').all(),
    dates, 'the schedule changed');
});

test('an empty message is refused, and a long one is cut not dropped', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));

  for (const bad of ['', '   ', undefined]) {
    assert.equal((await api(env, 'POST', '/track/' + tok + '/change', { text: bad })).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 0);

  const r = await api(env, 'POST', '/track/' + tok + '/change', { text: 'z'.repeat(5000) });
  assert.equal(r.status, 200);
  const text = db.prepare('SELECT text FROM notes').get().text;
  assert.ok(text.length < 1200, 'a 5000 character note went straight in: ' + text.length);
  assert.match(text, /z{900}/, 'the message was dropped rather than trimmed');
});

test('a change request needs a real token, on a live job', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await win(env, t);
  const tok = tokenOf(await linkFor(env, t));

  for (const bad of ['deadbeef', '', '00000000000000000000000000000000', "' OR 1=1 --"]) {
    const r = await api(env, 'POST', '/track/' + encodeURIComponent(bad) + '/change',
      { text: 'hello' });
    assert.equal(r.status, 404, 'a token of "' + bad + '" was allowed to write');
  }

  /* The same check the page itself makes: an un-won order goes dark, and that
     has to include the one endpoint a stranger can write through. */
  await api(env, 'POST', '/admin/submissions/status', { id: 7, status: 'lost' }, t);
  const after = await api(env, 'POST', '/track/' + tok + '/change', { text: 'hello' });
  assert.equal(after.status, 404, 'a lost order still took a change request');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 0,
    'something was written to the notes table anyway');
});

/* Asking late is reasonable; a silent failure is not an answer. */
test('a change request is still accepted once the build has started', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await win(env, t);
  await plan(env, t);
  const tok = tokenOf(await linkFor(env, t));
  const installs = (await api(env, 'GET', '/admin/customers/1', null, t)).data.installs;
  await api(env, 'POST', '/admin/installs/' + installs[0].id + '/done', {}, t);

  assert.equal((await api(env, 'GET', '/track/' + tok)).data.changes.open, false,
    'the page still says changes are open');
  assert.equal((await api(env, 'POST', '/track/' + tok + '/change', { text: 'one more shelf?' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 1);
});
