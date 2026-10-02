/* THE DASHBOARD, END TO END.
 *
 * dashboard.test.mjs checks the arithmetic on made-up rows. This checks the
 * seam: that the endpoint picks the RIGHT rows out of a database with lost
 * orders, superseded orders, paid invoices and other people's customers in it.
 * Every figure on that screen is a number somebody will act on, and a number
 * built from the wrong rows looks exactly like a number built from the right
 * ones.
 *
 * Run: node --experimental-sqlite --test worker/dashboardendpoint.test.mjs
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

const TODAY = '2026-10-15';
function cfg(over) {
  return Object.assign({ w: 10, l: 16, h: 9, style: 'barn', siding: 'vertical' }, over);
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
             address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
           /* won_at is set directly below, so the column has to exist before the
              worker's own migration would have added it. */
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL, won_at TEXT);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);

  const cust = (id, name, phone, city, extra) => db.prepare(
    `INSERT INTO customers (id,name,phone,city,state,created_at) VALUES (?,?,?,?,'UT',?)`
  ).run(id, name, phone, city, extra || '2026-08-01');

  cust(1, 'Hank Ellis', '4355550001', 'Lehi');
  cust(2, 'Dana Reed', '4355550002', 'Provo');
  cust(3, 'Mo Patel', '4355550003', 'Orem');
  cust(4, 'Sam Okafor', '4355550004', 'Herriman');
  cust(5, 'No Phone', null, 'Draper');

  const sub = (id, custId, status, created, price, details) => db.prepare(
    `INSERT INTO submissions (id,customer_id,details,status,created_at,effective_price)
     VALUES (?,?,?,?,?,?)`
  ).run(id, custId, JSON.stringify(details || { quotedPrice: price, config: cfg() }),
        status, created, price);

  /* 1: won this month, booked. 2: won this month, NO date yet.
     3: won LAST month. 4: a live quote. 5: lost. 6: superseded.
     7: a brand-new lead nobody has called. */
  sub(1, 1, 'won', '2026-09-20T10:00:00Z', 12000,
      { quotedPrice: 12000, config: cfg({ foundation: 'pad' }),
        renders: { perspective: 'https://r2.test/one.jpg' } });
  sub(2, 2, 'won', '2026-10-02T10:00:00Z', 9000);
  sub(3, 3, 'won', '2026-08-05T10:00:00Z', 7000);
  sub(4, 4, 'quoted', '2026-10-10T10:00:00Z', 5000);
  sub(5, 4, 'lost', '2026-10-03T10:00:00Z', 99000);
  sub(6, 4, 'superseded', '2026-10-04T10:00:00Z', 88000);
  sub(7, 5, 'new', '2026-10-14T08:00:00Z', 4000);

  db.prepare("UPDATE submissions SET won_at = '2026-10-05T10:00:00Z' WHERE id = 1").run();
  db.prepare("UPDATE submissions SET won_at = '2026-10-09T10:00:00Z' WHERE id = 2").run();
  db.prepare("UPDATE submissions SET won_at = '2026-09-02T10:00:00Z' WHERE id = 3").run();
  /* A superseded order that was once won — its price must not be counted. */
  db.prepare("UPDATE submissions SET won_at = '2026-10-06T10:00:00Z' WHERE id = 6").run();

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
async function dash(env, t, today = TODAY) {
  return (await api(env, 'GET', '/admin/dashboard?today=' + today, null, t)).data;
}
/* Books stages through the real endpoint so the rows are the shape the shop
   produces, not one invented here. */
async function book(env, t, subId, item, date, days) {
  return api(env, 'POST', '/admin/submissions/' + subId + '/installs',
    { item, install_date: date, days: days || 1 }, t);
}

// ── the four figures ────────────────────────────────────────────────────────

test('it needs an admin token', async () => {
  const { env } = setup();
  assert.equal((await api(env, 'GET', '/admin/dashboard')).status, 401);
});

test('new leads counts this month only', async () => {
  const { env } = setup();
  const d = await dash(env, await token(env));
  /* October: orders 2, 4, 5, 7 were created this month. 6 is superseded and
     out; 1 and 3 are older. */
  assert.equal(d.kpis.newLeads.count, 4, JSON.stringify(d.kpis.newLeads));
});

test('the sparkline has a bar for every day of the month so far', async () => {
  const { env } = setup();
  const d = await dash(env, await token(env));
  assert.equal(d.kpis.newLeads.series.length, 15, 'the 1st to the 15th is 15 days');
  assert.equal(d.kpis.newLeads.series.reduce((a, b) => a + b, 0), d.kpis.newLeads.count,
    'the bars do not add up to the number above them');
  assert.equal(d.kpis.won.series.length, 15);
});

test('jobs won counts what was won this month, at its price', async () => {
  const { env } = setup();
  const d = await dash(env, await token(env));
  assert.equal(d.kpis.won.count, 2, 'orders 1 and 2 were won in October');
  assert.equal(d.kpis.won.amount, 21000, JSON.stringify(d.kpis.won));
});

/* A SUPERSEDED ORDER IS A REPLACED DESIGN, not a sale. Counting one puts
   money on the screen that was never sold. */
test('a superseded order is not counted as won, even with a win date on it', async () => {
  const { env } = setup();
  const d = await dash(env, await token(env));
  assert.ok(d.kpis.won.amount < 88000, 'the superseded order was counted: ' + d.kpis.won.amount);
  assert.equal(d.kpis.won.count, 2);
});

test('a lost order is not on the screen anywhere', async () => {
  const { env } = setup();
  const body = JSON.stringify(await dash(env, await token(env)));
  assert.ok(body.indexOf('99000') === -1, 'the lost order’s price is on the dashboard');
});

test('awaiting schedule is what is sold with no date on it', async () => {
  const { env } = setup();
  const t = await token(env);
  let d = await dash(env, t);
  assert.equal(d.kpis.awaiting.count, 3, 'orders 1, 2 and 3 are won and unbooked');
  assert.equal(d.kpis.awaiting.amount, 28000);

  await book(env, t, 1, 'shed', '2026-10-20', 2);
  d = await dash(env, t);
  assert.equal(d.kpis.awaiting.count, 2, 'booking one did not take it off the list');
  assert.equal(d.kpis.awaiting.amount, 16000);
});

test('unpaid invoices are counted, paid ones are not', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER, submission_id INTEGER, kind TEXT, stripe_invoice_id TEXT,
    hosted_url TEXT, amount REAL, status TEXT, lines TEXT, created_at TEXT,
    created_by TEXT, paid_at TEXT)`).run();
  const inv = (id, cust, sub, kind, amount, status, created) => db.prepare(
    `INSERT INTO invoices (id,customer_id,submission_id,kind,amount,status,created_at,hosted_url)
     VALUES (?,?,?,?,?,?,?,?)`).run(id, cust, sub, kind, amount, status, created,
                                    'https://pay.test/' + id);
  inv(1, 1, 1, 'deposit', 3600, 'open', '2026-10-07T10:00:00Z');
  inv(2, 2, 2, 'balance', 2700, 'open', '2026-10-12T10:00:00Z');
  inv(3, 3, 3, 'deposit', 5000, 'paid', '2026-09-01T10:00:00Z');
  inv(4, 3, 3, 'balance', 1234, 'void', '2026-09-02T10:00:00Z');

  const d = await dash(env, t);
  assert.equal(d.kpis.unpaid.count, 2, 'paid or void invoices were counted');
  assert.equal(d.kpis.unpaid.amount, 6300);
  assert.deepEqual(d.payments.map((p) => p.id), [1, 2], 'oldest first');
  assert.equal(d.payments[0].customer_name, 'Hank Ellis');
  assert.equal(d.payments[0].kind, 'deposit');
  assert.equal(d.payments[0].hosted_url, 'https://pay.test/1');
});

/* SENT, NOT OVERDUE. Nothing in this CRM records payment terms, so an
   "8 days overdue" chip would be a number it has no basis for. */
test('an invoice says how long since it was sent, not how late it is', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER, submission_id INTEGER, kind TEXT, stripe_invoice_id TEXT,
    hosted_url TEXT, amount REAL, status TEXT, lines TEXT, created_at TEXT,
    created_by TEXT, paid_at TEXT)`).run();
  db.prepare(`INSERT INTO invoices (id,customer_id,submission_id,kind,amount,status,created_at)
              VALUES (1,1,1,'deposit',3600,'open','2026-10-07T10:00:00Z')`).run();
  const d = await dash(env, t);
  assert.equal(d.payments[0].sent_days, 8);
  assert.ok(!('overdue' in d.payments[0]), 'it claims to know a due date');
});

// ── the week ────────────────────────────────────────────────────────────────

test('the week shows the next seven days of work, in order', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'prep', '2026-10-16', 1);
  await book(env, t, 1, 'pour', '2026-10-17', 1);
  await book(env, t, 2, 'shed', '2026-10-30', 2);     // beyond the week
  await book(env, t, 1, 'shop', '2026-10-09', 1);     // already past

  const d = await dash(env, t);
  assert.deepEqual(d.week.map((w) => w.item), ['prep', 'pour']);
  assert.deepEqual(d.week.map((w) => w.install_date), ['2026-10-16', '2026-10-17']);
  assert.equal(d.week[0].customer_name, 'Hank Ellis');
  assert.equal(d.week[0].city, 'Lehi');
  assert.equal(d.week[0].label, 'Site prep', 'the stage is not named for a person');
  assert.ok(d.week[0].summary, 'no build summary');
});

/* The job somebody is standing on. */
test('a job already underway is still on the week', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'shed', '2026-10-14', 3);
  const d = await dash(env, t);
  assert.deepEqual(d.week.map((w) => w.item), ['shed'],
    'the three-day install that started yesterday fell off');
});

test('a stage already ticked off says so', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'prep', '2026-10-16', 1);
  const id = (await dash(env, t)).week[0].id;
  await api(env, 'POST', '/admin/installs/' + id + '/done', {}, t);
  assert.equal((await dash(env, t)).week[0].done, true);
});

test('the build picture is the customer’s own, or nothing', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'prep', '2026-10-16', 1);   // order 1 has a render
  await book(env, t, 2, 'prep', '2026-10-17', 1);   // order 2 has none
  const d = await dash(env, t);
  assert.equal(d.week[0].image, 'https://r2.test/one.jpg');
  assert.equal(d.week[1].image, null, 'a shed that is not theirs was put on the row');
});

test('an order that stops being won drops off the week', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'prep', '2026-10-16', 1);
  assert.equal((await dash(env, t)).week.length, 1);
  await api(env, 'POST', '/admin/submissions/status', { id: 1, status: 'lost' }, t);
  assert.equal((await dash(env, t)).week.length, 0, 'a lost job is still on the schedule');
});

// ── who to ring ─────────────────────────────────────────────────────────────

test('an untouched lead is on the call list', async () => {
  const { env } = setup();
  const d = await dash(env, await token(env));
  const names = d.followUps.map((f) => f.name);
  assert.ok(names.indexOf('No Phone') !== -1, 'the new lead is not on the list: ' + names);
});

test('a follow-up date that has come round beats it', async () => {
  const { db, env } = setup();
  db.prepare("ALTER TABLE customers ADD COLUMN follow_up_at TEXT").run();
  db.prepare("UPDATE customers SET follow_up_at = '2026-10-12' WHERE id = 1").run();
  const d = await dash(env, await token(env));
  assert.equal(d.followUps[0].name, 'Hank Ellis');
  assert.equal(d.followUps[0].when, '3 days late');
  assert.equal(d.followUps[0].phone, '4355550001');
});

test('the latest note is what it says to talk about', async () => {
  const { db, env } = setup();
  db.prepare("ALTER TABLE customers ADD COLUMN follow_up_at TEXT").run();
  db.prepare("UPDATE customers SET follow_up_at = ? WHERE id = 1").run(TODAY);
  db.prepare(`INSERT INTO notes (customer_id,text,created_at)
              VALUES (1,'Asked about delivery timing','2026-10-14T09:00:00Z')`).run();
  const d = await dash(env, await token(env));
  assert.equal(d.followUps[0].reason, 'Asked about delivery timing');
});

test('a customer who has been called is left alone', async () => {
  const { db, env } = setup();
  const t = await token(env);
  /* Checked, because the first version of this left out `direction`, the POST
     answered 400, no call was ever logged — and the assertion below then
     reported it as the dashboard failing to notice a call that never happened. */
  const logged = await api(env, 'POST', '/admin/customers/5/calls',
    { direction: 'outbound', outcome: 'connected', notes: 'spoke to them' }, t);
  assert.equal(logged.status, 200, 'the call was not logged: ' + JSON.stringify(logged.data));
  const d = await dash(env, t);
  assert.ok(d.followUps.every((f) => f.name !== 'No Phone'),
    'a lead that was rung is still on the call list');
});

// ── sold, no date yet ───────────────────────────────────────────────────────

test('ready to schedule lists the jobs waiting on a date', async () => {
  const { env } = setup();
  const t = await token(env);
  const d = await dash(env, t);
  assert.deepEqual(d.ready.map((r) => r.submission_id).sort(), [1, 2, 3]);
  const one = d.ready.filter((r) => r.submission_id === 1)[0];
  assert.equal(one.customer_name, 'Hank Ellis');
  assert.equal(one.amount, 12000);
  assert.ok(one.summary);
});

test('booking one takes it off the list', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 2, 'shed', '2026-11-20', 1);
  const d = await dash(env, t);
  assert.ok(d.ready.every((r) => r.submission_id !== 2),
    'a booked job is still listed as needing a date');
  assert.equal(d.ready.length, 2);
});

// ── the day ─────────────────────────────────────────────────────────────────

/* THE WORKER'S DAY IS NOT THE SHOP'S DAY for seven hours out of twenty-four. */
test('the browser says what day it is', async () => {
  const { env } = setup();
  const t = await token(env);
  await book(env, t, 1, 'prep', '2026-10-16', 1);
  assert.equal((await dash(env, t, '2026-10-16')).week.length, 1, 'on the day itself');
  assert.equal((await dash(env, t, '2026-10-17')).week.length, 0, 'the day after');
  assert.equal((await dash(env, t, '2026-10-16')).today, '2026-10-16');
});

/* A dashboard that refuses to load over a query parameter is worse than one a
   few hours out overnight. */
test('a day it cannot read falls back rather than failing', async () => {
  const { env } = setup();
  const t = await token(env);
  for (const bad of ['', 'today', '15/10/2026', '../../etc']) {
    const r = await api(env, 'GET', '/admin/dashboard?today=' + encodeURIComponent(bad), null, t);
    assert.equal(r.status, 200, 'a bad day broke the whole screen: ' + bad);
    assert.match(r.data.today, /^\d{4}-\d{2}-\d{2}$/, bad);
  }
  const none = await api(env, 'GET', '/admin/dashboard', null, t);
  assert.equal(none.status, 200);
  assert.match(none.data.today, /^\d{4}-\d{2}-\d{2}$/);
});

// ── an empty shop ───────────────────────────────────────────────────────────

/* The first morning, and every Monday in a quiet month. A dashboard that
   throws on no data is one nobody trusts on the day they most need it. */
test('a CRM with nothing in it still draws a dashboard', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
             address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
  const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' };
  const d = await dash(env, await token(env));
  assert.equal(d.kpis.newLeads.count, 0);
  assert.equal(d.kpis.won.amount, 0);
  assert.equal(d.kpis.unpaid.count, 0);
  assert.deepEqual(d.week, []);
  assert.deepEqual(d.followUps, []);
  assert.deepEqual(d.ready, []);
  assert.deepEqual(d.payments, []);
  assert.equal(d.kpis.newLeads.series.length, 15, 'a month of empty bars, not no bars');
});

/* THE SHOP'S COST IS IN THE SAME ROWS EVERY ONE OF THESE FIGURES CAME FROM, so
   it rides along the moment any list passes a whole details blob through. The
   order is put on the WEEK as well as left on the ready list: an earlier
   version covered only the ready list, so adding the blob to the week rows
   leaked the cost and failed nothing. */
test('the shop’s own cost is nowhere on it', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const leaky = JSON.stringify({ quotedPrice: 12000, config: cfg(),
                                 redline: { trueTotalCost: 7777, marginDollars: 4223 } });
  db.prepare("UPDATE submissions SET details = ? WHERE id = 1").run(leaky);
  db.prepare("UPDATE submissions SET details = ? WHERE id = 2").run(leaky);
  await book(env, t, 1, 'prep', '2026-10-16', 1);   // order 1 onto the week
                                                    // order 2 stays on ready
  const d = await dash(env, t);
  assert.ok(d.week.length, 'nothing on the week to check');
  assert.ok(d.ready.length, 'nothing on the ready list to check');

  const body = JSON.stringify(d);
  assert.ok(!/redline/i.test(body), 'redline is in the response');
  assert.ok(!/margin/i.test(body), 'a margin figure is in the response');
  assert.ok(body.indexOf('7777') === -1, 'the cost is in the response');
  assert.ok(body.indexOf('4223') === -1, 'the margin is in the response');
});
