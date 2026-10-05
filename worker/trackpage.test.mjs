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

/* A build with things CHOSEN on it — 9ft walls, paint, a loft, a premium
   window, shelves — so the itemised list has customizations to list rather
   than a bare shed. */
const LOADED = computePricing({ style: 'barn', w: 12, l: 20, h: 9,
  foundation: 'pad', foundationFinish: 'coated', siding: 'vertical',
  paint: 'two-tone', intFinish: 'painted', floor: 'vinyl', elec: 'standard',
  loft: '8-ft',
  doors: [{ wall: 'front', w: 72, style: 'double', color: 'brown' }],
  windows: [{ wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' },
            { wall: 'right', w: 48, h: 36, type: 'Black Bi-Fold Bar 48x36' }],
  shelves: [{ wall: 'back', len: 8 }] }).redline;

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

// ── the itemised build ──────────────────────────────────────────────────────

/* THE SAME BREAKDOWN AS THE QUOTE, from the same function. If these two ever
   disagree about what was bought, one of them is lying to a customer who has
   both open. */
function loadedSetup() {
  const { db, env } = setup();
  db.prepare("UPDATE submissions SET details = ? WHERE id = 7")
    .run(JSON.stringify({ redline: LOADED, quotedPrice: 24000,
                          permalink: 'https://shedpro-utah.com/designer.html?d=a1b2c3d4',
                          config: { w: 12, l: 20, h: 9, style: 'barn' } }));
  return { db, env };
}

test('the itemised list carries every choice they made', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;

  assert.ok((d.items || []).length, 'nothing was itemised');
  const labels = d.items.reduce((a, g) => a.concat((g.lines || []).map((l) => l.label)), []);
  /* The options this fixture actually chose — each has to appear by name. */
  ["9' Walls", 'Exterior Paint', 'Black Bi-Fold Bar Window 48x36',
   'Black Vinyl Window 24x36'].forEach((want) => {
    assert.ok(labels.some((l) => l.indexOf(want) !== -1),
      '"' + want + '" is not on the list: ' + labels.join(' | '));
  });
  assert.ok(labels.some((l) => /loft/i.test(l)), 'no loft: ' + labels.join(' | '));
  assert.ok(labels.some((l) => /shelf/i.test(l)), 'no shelf: ' + labels.join(' | '));
});

test('each line carries what it cost', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;
  const lines = d.items.reduce((a, g) => a.concat(g.lines || []), []);
  assert.ok(lines.length, 'no lines');
  lines.forEach((l) => {
    assert.equal(typeof l.amount, 'number', l.label + ' has no amount');
    assert.ok(isFinite(l.amount), l.label + ' amount is not a number: ' + l.amount);
  });
  assert.ok(lines.some((l) => l.amount > 0), 'every line came back free');
});

/* The tracker draws its OWN four phases on the same screen. Two unrelated
   things both numbered "Phase 2" is what a customer rings about. */
test('the quote’s phase numbering is not carried onto the tracker', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;
  d.items.forEach((g) => {
    assert.ok(!/^Phase \d/.test(g.label), 'a quote phase number reached the tracker: ' + g.label);
    assert.ok(g.label.trim().length, 'a group lost its name entirely');
  });
  assert.ok(d.items.some((g) => /shed/i.test(g.label)), d.items.map((g) => g.label));
});

test('the totals add up to the price they were quoted', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;
  assert.ok(d.pricing, 'no totals');
  assert.ok(d.pricing.total > 0);
  /* Subtotal plus tax is the total, to the cent. A customer with a calculator
     is the one who notices. */
  assert.ok(Math.abs((d.pricing.subtotal + d.pricing.tax) - d.pricing.total) < 0.02,
    JSON.stringify(d.pricing));
  const groups = d.items.reduce((t2, g) => t2 + g.amount, 0);
  assert.ok(Math.abs(groups - d.pricing.subtotal) < 0.02,
    'the groups do not add up to the subtotal: ' + groups + ' vs ' + d.pricing.subtotal);
});

/* THE WHOLE REASON THIS IS COPIED FIELD BY FIELD. quoteLines reads a redline,
   and a redline is the shop's cost sheet. */
test('itemising the build does not carry the shop’s cost with it', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;
  const body = JSON.stringify(d);

  assert.ok(!/redline/i.test(body), 'redline is in the response');
  assert.ok(!/margin|trueTotalCost|grandBase|helperCost|fuelCost/i.test(body),
    'a cost field name is in the response');

  const secret = { trueTotalCost: LOADED.trueTotalCost, grandBase: LOADED.grandBase,
                   marginDollars: LOADED.marginDollars, framing: LOADED.framing,
                   helperCost: LOADED.helperCost };
  Object.keys(secret).forEach((k) => {
    assert.ok(Number(secret[k]) > 0, 'the fixture has no ' + k + ' to leak');
    [String(secret[k]), String(Math.round(secret[k]))].forEach((n) => {
      assert.ok(body.indexOf(n) === -1, k + ' (' + n + ') is in the response');
    });
  });
});

/* An order saved before the designer stored a redline still has to render. */
test('an order with no priced breakdown still gets a page', async () => {
  const { db, env } = setup();
  db.prepare("UPDATE submissions SET details = ? WHERE id = 7")
    .run(JSON.stringify({ quotedPrice: 9000, config: { w: 10, l: 16, style: 'barn' } }));
  const t = await token(env);
  await win(env, t);
  const r = await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items, [], 'it invented an itemised list from nothing');
  assert.equal(r.data.pricing, null);
  assert.equal(r.data.total, 9000, 'the plain total is still there to fall back on');
});

/* THE GUARD THAT MAKES "copied field by field" MEAN SOMETHING. Without this,
   spreading quoteLines' whole result into the response failed nothing — it
   happens to return only sell-side numbers today, so nothing leaked and nothing
   complained. Pinning the keys is what turns a careful habit into a rule: a
   field added to that function later cannot reach a customer's screen without
   somebody naming it here. */
test('the page serves these fields and no others', async () => {
  const { env } = loadedSetup();
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;

  assert.deepEqual(Object.keys(d).sort(), [
    'changes', 'complete', 'design_url', 'first_name', 'included', 'items',
    'order_id', 'phases', 'pricing', 'shop_email', 'shop_phone', 'spec',
    'summary', 'total'
  ].sort(), Object.keys(d).join(','));

  d.items.forEach((g) => {
    assert.deepEqual(Object.keys(g).sort(), ['amount', 'label', 'lines'], Object.keys(g).join(','));
    (g.lines || []).forEach((l) => {
      assert.deepEqual(Object.keys(l).sort(), ['amount', 'includes', 'label'], Object.keys(l).join(','));
    });
  });
  assert.deepEqual(Object.keys(d.pricing).sort(), ['discount', 'subtotal', 'tax', 'total']);
});

// ── custom work ─────────────────────────────────────────────────────────────

/* ANYTHING THE CONFIGURATOR HAS NO OPTION FOR is agreed as an adjustment that
   adds to the price, with a note saying what it is. quoteLines folds that into
   the subtotal and never names it, so the itemised list used to add up to less
   than the figure printed under it — measured at $14,819 of lines under a
   stated $15,269 — with the note explaining the difference dropped entirely. */
async function withAdjustments(list) {
  const { db, env } = loadedSetup();
  db.prepare('UPDATE submissions SET adjustments = ? WHERE id = 7').run(JSON.stringify(list));
  const t = await token(env);
  await win(env, t);
  const d = (await api(env, 'GET', '/track/' + tokenOf(await linkFor(env, t)))).data;
  return { db, env, d };
}
function allLines(d) {
  return (d.items || []).reduce((a, g) => a.concat(g.lines || []), []);
}

test('a custom charge is named on the tracker, in the words it was written in', async () => {
  const { d } = await withAdjustments([
    { kind: 'amount', value: 450, note: 'Built-in workbench along the back wall' }
  ]);
  const line = allLines(d).filter((l) => /workbench/i.test(l.label))[0];
  assert.ok(line, 'the custom work is not listed: ' + allLines(d).map((l) => l.label).join(' | '));
  assert.equal(line.label, 'Built-in workbench along the back wall');
  assert.equal(line.amount, 450);
  assert.ok(d.items.some((g) => g.label === 'Custom work for you'), d.items.map((g) => g.label));
});

/* THE ARITHMETIC IS THE POINT. A list that does not add up to the figure under
   it invites exactly the phone call it was built to prevent. */
test('the lines add up to the subtotal, custom work and discounts included', async () => {
  for (const list of [
    [{ kind: 'amount', value: 450, note: 'Workbench' }],
    [{ kind: 'amount', value: -200, note: 'Repeat customer' }],
    [{ kind: 'amount', value: 450, note: 'Workbench' },
     { kind: 'amount', value: -200, note: 'Repeat customer' }],
    [{ kind: 'percent', value: -10, note: 'Winter rate' }],
    [{ kind: 'amount', value: 1200, note: 'Dutch door and ramp' },
     { kind: 'percent', value: -5, note: 'Cash' }],
    []
  ]) {
    const { d } = await withAdjustments(list);
    const lines = (d.items || []).reduce((t, g) => t + g.amount, 0);
    const net = lines - (d.pricing.discount || 0);
    assert.ok(Math.abs(net - d.pricing.subtotal) < 0.02,
      JSON.stringify(list) + ': lines ' + Math.round(lines) + ' - discount '
      + Math.round(d.pricing.discount) + ' = ' + Math.round(net)
      + ', but the page states a subtotal of ' + Math.round(d.pricing.subtotal));
    assert.ok(Math.abs((d.pricing.subtotal + d.pricing.tax) - d.pricing.total) < 0.02,
      'subtotal plus tax is not the total');
  }
});

test('money off is a discount, not a thing they bought', async () => {
  const { d } = await withAdjustments([{ kind: 'amount', value: -200, note: 'Repeat customer' }]);
  assert.ok(!d.items.some((g) => g.label === 'Custom work for you'),
    'a discount was listed as custom work');
  assert.equal(Math.round(d.pricing.discount), 200);
  assert.ok(!allLines(d).some((l) => l.amount < 0), 'a negative line reached the list');
});

test('a percentage that adds is custom work too', async () => {
  const { d } = await withAdjustments([{ kind: 'percent', value: 5, note: 'Long haul delivery' }]);
  const line = allLines(d).filter((l) => /long haul/i.test(l.label))[0];
  assert.ok(line, allLines(d).map((l) => l.label).join(' | '));
  assert.ok(line.amount > 0);
  assert.equal(d.pricing.discount, 0);
});

/* A charge with no note is still a charge. Silence about it is worse than a
   vague label. */
test('a custom charge with no note still gets a line', async () => {
  const { d } = await withAdjustments([{ kind: 'amount', value: 300 }]);
  const line = allLines(d).filter((l) => l.label === 'Custom work')[0];
  assert.ok(line, allLines(d).map((l) => l.label).join(' | '));
  assert.equal(line.amount, 300);
});

test('several custom items each get their own line', async () => {
  const { d } = await withAdjustments([
    { kind: 'amount', value: 450, note: 'Workbench' },
    { kind: 'amount', value: 800, note: 'Dutch door' }
  ]);
  const grp = d.items.filter((g) => g.label === 'Custom work for you')[0];
  assert.ok(grp);
  assert.deepEqual(grp.lines.map((l) => l.label), ['Workbench', 'Dutch door']);
  assert.equal(grp.amount, 1250);
});

/* A comp is already removed from the phase row it belongs to, so counting it
   here as well would take it off twice.
   The SECOND case is the one that keeps the comp guard honest. A comp carries
   no `value` today, so the isFinite check alone already skips it and removing
   the guard failed nothing — until a comp arrives carrying a figure, which is
   exactly what a stored price on a comped line would look like. */
test('a comped item is not double-counted as a discount', async () => {
  for (const comp of [{ kind: 'comp', item: "9' Walls" },
                      { kind: 'comp', item: "9' Walls", value: -1152 }]) {
    const { d } = await withAdjustments([comp]);
    assert.equal(d.pricing.discount, 0,
      'a comp was subtracted a second time: ' + JSON.stringify(comp));
    const lines = (d.items || []).reduce((t, g) => t + g.amount, 0);
    assert.ok(Math.abs(lines - d.pricing.subtotal) < 0.02,
      JSON.stringify(comp) + ': lines ' + Math.round(lines)
      + ' vs subtotal ' + Math.round(d.pricing.subtotal));
    assert.ok(!(d.items || []).some((g) => g.label === 'Custom work for you'),
      'a comp was listed as custom work');
  }
});

/* The note is the shop's own words, typed into the CRM, and it lands on a page
   a customer reads. */
test('a note cannot smuggle markup onto the page', async () => {
  const { d } = await withAdjustments([
    { kind: 'amount', value: 100, note: '<img src=x onerror=alert(1)>' }
  ]);
  const line = allLines(d).filter((l) => l.amount === 100)[0];
  assert.ok(line);
  assert.equal(typeof line.label, 'string');
});

// ── things thrown in free ───────────────────────────────────────────────────

/* A comp is taken off the phase row it belongs to, which is right for the
   arithmetic and left the customer seeing neither the item nor the gift. */
test('a comped item is named as included, not left off', async () => {
  const { d } = await withAdjustments([{ kind: 'comp', item: "9' Walls" }]);
  assert.deepEqual(d.included, ["9' Walls"], JSON.stringify(d.included));
});

test('several comps are all named', async () => {
  const { d } = await withAdjustments([
    { kind: 'comp', item: "9' Walls" },
    { kind: 'comp', item: '16" Shelf 8ft' }
  ]);
  assert.equal(d.included.length, 2, JSON.stringify(d.included));
  assert.ok(d.included.indexOf("9' Walls") !== -1, JSON.stringify(d.included));
});

/* "Included" is a gift. A price beside it would read as a charge, and a $0
   would read as a line with its price missing. */
test('an included item carries no price', async () => {
  const { d } = await withAdjustments([{ kind: 'comp', item: "9' Walls" }]);
  d.included.forEach((n) => assert.equal(typeof n, 'string', JSON.stringify(n)));
  assert.ok(!allLines(d).some((l) => /9' Walls/.test(l.label) && l.amount === 0),
    'the comped item also appeared as a $0 line');
});

/* It is already off its phase row, so naming it must not move a number. */
test('naming the gift does not change what they pay', async () => {
  const plain = (await withAdjustments([])).d;
  const comped = (await withAdjustments([{ kind: 'comp', item: "9' Walls" }])).d;
  assert.ok(comped.pricing.total < plain.pricing.total, 'the comp took nothing off');
  const lines = (comped.items || []).reduce((t, g) => t + g.amount, 0);
  assert.ok(Math.abs(lines - comped.pricing.subtotal) < 0.02,
    'lines ' + Math.round(lines) + ' vs subtotal ' + Math.round(comped.pricing.subtotal));
});

test('an order with nothing comped has an empty list, not a missing one', async () => {
  const { d } = await withAdjustments([{ kind: 'amount', value: 450, note: 'Workbench' }]);
  assert.deepEqual(d.included, []);
});

/* A comp naming a line this quote does not have buys nothing and must not be
   announced as a gift. */
test('a comp for something they did not order is not listed', async () => {
  const { d } = await withAdjustments([{ kind: 'comp', item: 'Cupola They Never Ordered' }]);
  assert.deepEqual(d.included, [], JSON.stringify(d.included));
});
