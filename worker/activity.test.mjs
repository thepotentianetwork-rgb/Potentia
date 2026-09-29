/* WHAT HAPPENED WHILE YOU WERE NOT LOOKING.
 *
 * A Stripe payment lands in the CRM silently — the only way to find out used
 * to be opening the right customer. This merges money in, invoices out and
 * anyone new into one stream, and the ordering is the whole product: an event
 * in the wrong place in the list is an event nobody sees.
 *
 * Run: node --experimental-sqlite --test worker/activity.test.mjs
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
             created_at TEXT, effective_price REAL);`);
  db.prepare("INSERT INTO customers (id,name,email,created_at) VALUES (1,'Hank Ellis','h@r.test','2026-08-01')").run();
  db.prepare("INSERT INTO customers (id,name,email,created_at) VALUES (2,'Dana Reed','d@r.test','2026-08-02')").run();
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}
async function api(env, path, tok) {
  const h = {};
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, { headers: h }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function token(env) {
  const r = await worker.fetch(new Request('https://local/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }) }), env);
  return (await r.json()).token;
}
/* The tables the worker creates lazily; made up front so rows can be seeded. */
async function warm(env, t) { await api(env, '/admin/activity', t); }

test('payments, invoices and new designs land in one stream, newest first', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);

  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (7,1,?,'quoted','2026-09-01T10:00:00Z')`)
    .run(JSON.stringify({ quotedPrice: 9000, config: { w: 10, l: 16, style: 'barn' } }));
  db.prepare(`INSERT INTO invoices (customer_id,submission_id,kind,stripe_invoice_id,hosted_url,
              amount,status,lines,created_at,created_by)
              VALUES (1,7,'deposit','in_1','https://pay/x',2700,'open','[]','2026-09-02T10:00:00Z',null)`).run();
  db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
              VALUES (1,2700,'stripe','Deposit paid on Stripe','2026-09-03T10:00:00Z','2026-09-03T10:00:00Z',7)`).run();

  const r = await api(env, '/admin/activity', t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.events.map((e) => e.kind),
    ['payment', 'invoice_sent', 'order'], JSON.stringify(r.data.events.map((e) => e.at)));
  assert.equal(r.data.events[0].amount, 2700);
  assert.equal(r.data.events[0].customer_name, 'Hank Ellis');
  assert.equal(r.data.events[1].invoice_kind, 'deposit');
  assert.equal(r.data.events[1].hosted_url, 'https://pay/x');
  assert.equal(r.data.events[2].summary, '10x16 ft · barn');
});

/* A payment recorded late still belongs on the day the money moved. Using
   created_at would file a cheque entered on Friday under Friday, when the
   customer handed it over on Monday. */
test('a payment is dated when it was PAID, not when it was typed in', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);
  db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
              VALUES (1,500,'check','','2026-09-01T00:00:00Z','2026-09-20T00:00:00Z',null)`).run();
  db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
              VALUES (2,600,'cash','','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z',null)`).run();
  const r = await api(env, '/admin/activity', t);
  assert.deepEqual(r.data.events.map((e) => e.amount), [600, 500],
    'the cash on the 10th is newer than the cheque from the 1st');
});

test('a consult reads differently from a finished design', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (8,2,?,'new','2026-09-05T10:00:00Z')`)
    .run(JSON.stringify({ consult: true, bestTime: 'mornings', question: 'How thick is the pad?' }));
  const r = await api(env, '/admin/activity', t);
  const e = r.data.events[0];
  assert.equal(e.kind, 'consult');
  assert.equal(e.best_time, 'mornings');
  assert.equal(e.question, 'How thick is the pad?');
  assert.equal(e.amount, null, 'a consult has no price yet');
});

/* THE BADGE. Everything hangs off this: `since` decides what is new, and the
   page stores `latest` so the next visit is measured from the right point. */
test('since marks what is new without the server remembering anything', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);
  for (const [n, when] of [[100, '2026-09-01T00:00:00Z'], [200, '2026-09-05T00:00:00Z'],
                           [300, '2026-09-09T00:00:00Z']]) {
    db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
                VALUES (1,?,'cash','',?,?,null)`).run(n, when, when);
  }
  const all = await api(env, '/admin/activity', t);
  assert.equal(all.data.unseen, 0, 'no since means nothing is flagged new');
  assert.equal(all.data.latest, '2026-09-09T00:00:00Z');

  const since = await api(env, '/admin/activity?since=' +
    encodeURIComponent('2026-09-05T00:00:00Z'), t);
  assert.equal(since.data.unseen, 1, 'only the one after it');
  assert.deepEqual(since.data.events.map((e) => e.unseen), [true, false, false]);
  assert.equal(since.data.events[0].amount, 300);

  /* Marking read stores `latest`; coming back must then show nothing new. */
  const after = await api(env, '/admin/activity?since=' +
    encodeURIComponent(since.data.latest), t);
  assert.equal(after.data.unseen, 0, 'marking all seen must actually clear it');
});

test('the newest timestamp comes from the data, not the clock', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);
  /* A row dated in the future — a hand-entered payment date, say. If `latest`
     were "now", this event would be skipped over the moment it was marked
     read and never seen again. */
  db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
              VALUES (1,900,'cash','','2099-01-01T00:00:00Z','2026-09-01T00:00:00Z',null)`).run();
  const r = await api(env, '/admin/activity', t);
  assert.equal(r.data.latest, '2099-01-01T00:00:00Z');
});

test('the feed is capped, however much history there is', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await warm(env, t);
  /* More rows than the cap, deliberately — with only 120 the cap could be
     deleted entirely and this test would still pass, because there was never
     anything for it to trim. */
  for (let i = 0; i < 250; i++) {
    const when = '2026-09-' + String((i % 28) + 1).padStart(2, '0') + 'T00:00:00Z';
    db.prepare(`INSERT INTO payments (customer_id,amount,method,note,paid_at,created_at,submission_id)
                VALUES (1,?,'cash','',?,?,null)`).run(i + 1, when, when);
  }
  assert.equal((await api(env, '/admin/activity', t)).data.events.length, 60, 'default cap');
  assert.equal((await api(env, '/admin/activity?limit=10', t)).data.events.length, 10);
  assert.equal((await api(env, '/admin/activity?limit=9999', t)).data.events.length, 200,
    'a hand-typed limit cannot ask for everything');
  assert.equal((await api(env, '/admin/activity?limit=abc', t)).data.events.length, 60,
    'nonsense falls back to the default');
});

test('an empty CRM returns an empty feed, not an error', async () => {
  const { env } = setup();
  const t = await token(env);
  const r = await api(env, '/admin/activity', t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.events, []);
  assert.equal(r.data.unseen, 0);
  assert.equal(r.data.latest, null);
});

test('it needs an admin token', async () => {
  const { env } = setup();
  assert.equal((await api(env, '/admin/activity')).status, 401);
});
