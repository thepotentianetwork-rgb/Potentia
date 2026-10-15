/* GET /api/briefing/query — "Jarvis, pull up ...". Read-only CRM views.
 * Run: node --experimental-sqlite --test worker/crmquery.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

function makeD1(db) {
  const writes = [];
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    if (!isSelect) writes.push(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const s = db.prepare(sql); return isSelect ? { results: s.all(...args) } : (s.run(...args), {}); }
    });
  }
  return { writes, prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; } };
}

const NOW = Date.parse('2026-10-14T18:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const day = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

function setup({ noInvoices = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, city TEXT, created_at TEXT NOT NULL);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, name TEXT, email TEXT, details TEXT, status TEXT, created_at TEXT, effective_price REAL, won_at TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, method TEXT, note TEXT, paid_at TEXT, created_at TEXT);
    CREATE TABLE installs (id INTEGER PRIMARY KEY, submission_id INTEGER, item TEXT, install_date TEXT, days REAL, note TEXT, created_at TEXT, done_at TEXT);
  `);
  if (!noInvoices) db.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER, submission_id INTEGER, kind TEXT, amount REAL, status TEXT, created_at TEXT, paid_at TEXT);');
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins('INSERT INTO customers VALUES (1,?,?,?,?,?)', 'Nahui Lopez', 'n@x.com', '801-555-1234', 'Ogden', ago(3));
  ins('INSERT INTO customers VALUES (2,?,?,?,?,?)', 'Ann Old', 'a@x.com', '', 'Provo', ago(60));
  ins('INSERT INTO submissions VALUES (10,1,?,?,?,?,?,?,?)', 'Nahui Lopez', 'n@x.com', JSON.stringify({ config: { w: 10, l: 12, style: 'barn' } }), 'won', ago(2), 9000, ago(1));
  ins('INSERT INTO submissions VALUES (9,1,?,?,?,?,?,?,?)', 'Nahui Lopez', 'n@x.com', '{}', 'superseded', ago(3), 8000, null);
  ins('INSERT INTO submissions VALUES (11,2,?,?,?,?,?,?,?)', 'Ann Old', 'a@x.com', JSON.stringify({ quotedPrice: 5000 }), 'quoted', ago(5), null, null);
  ins('INSERT INTO payments VALUES (1,1,2700,?,?,?,?)', 'card', 'deposit', ago(1).slice(0, 10), ago(1));
  ins('INSERT INTO installs VALUES (1,10,?,?,1,NULL,?,NULL)', 'shed', day(5), ago(1));
  ins('INSERT INTO installs VALUES (2,10,?,?,1,NULL,?,?)', 'pour', day(2), ago(1), ago(0));
  ins('INSERT INTO notes VALUES (1,1,?,?)', 'Wants gray trim', ago(1));
  if (!noInvoices) {
    ins('INSERT INTO invoices VALUES (1,1,10,?,6300,?,?,NULL)', 'balance', 'open', ago(1));
    ins('INSERT INTO invoices VALUES (2,1,10,?,2700,?,?,?)', 'deposit', 'paid', ago(2), ago(1));
  }
  return makeD1(db);
}

const KEY = 'k_test_123';
const realNow = Date.now;
async function call(env, qs, auth = 'Bearer ' + KEY) {
  Date.now = () => NOW;
  try {
    const r = await worker.fetch(new Request('https://x/api/briefing/query?' + qs, { headers: auth ? { Authorization: auth, 'CF-Connecting-IP': '10.0.0.' + Math.floor(Math.random() * 250) } : {} }), env);
    return { status: r.status, body: await r.json() };
  } finally { Date.now = realNow; }
}

test('auth required, bad view is 400, never writes', async () => {
  const DB = setup(); const env = { DB, BRIEFING_API_KEY: KEY };
  assert.equal((await call(env, 'view=leads', null)).status, 401);
  assert.equal((await call(env, 'view=leads', 'Bearer nope')).status, 401);
  assert.equal((await call(env, 'view=drop')).status, 400);
  for (const v of ['customers', 'customer&q=nahui', 'leads', 'quotes', 'invoices', 'payments', 'schedule', 'revenue']) {
    const r = await call(env, 'view=' + v);
    assert.equal(r.status, 200, v);
    assert.equal(r.body.side_effects, 'none', v);
  }
  assert.deepEqual(DB.writes, []);
});

test('customer detail: profile, live quotes only, payments, invoices, installs, notes', async () => {
  const r = await call({ DB: setup(), BRIEFING_API_KEY: KEY }, 'view=customer&q=' + encodeURIComponent("Nahui's"));
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'CUSTOMER: NAHUI LOPEZ');
  const card = (t) => r.body.cards.find((c) => c.title === t).lines.join(' | ');
  assert.match(card('QUOTES'), /#10 10x12 barn .* won, \$9,000\.00/);
  assert.doesNotMatch(card('QUOTES'), /#9/);
  assert.match(card('PAYMENTS'), /Total paid: \$2,700\.00/);
  assert.match(card('INVOICES'), /balance \$6,300\.00/);
  assert.match(card('INSTALLS'), /shed/);
  assert.match(card('LATEST NOTES'), /gray trim/);
  assert.match(r.body.summary, /won order at \$9,000\.00, with \$2,700\.00 paid/);
  assert.equal((await call({ DB: setup(), BRIEFING_API_KEY: KEY }, 'view=customer&q=zelda')).status, 404);
  assert.equal((await call({ DB: setup(), BRIEFING_API_KEY: KEY }, 'view=customer')).status, 400);
});

test('lists: leads window, quote status filter, open invoices, schedule skips done, revenue', async () => {
  const env = { DB: setup(), BRIEFING_API_KEY: KEY };
  const leads = (await call(env, 'view=leads&days=14')).body;
  assert.deepEqual(leads.rows.map((x) => x.name), ['Nahui Lopez']);
  const q = (await call(env, 'view=quotes&status=quoted')).body;
  assert.deepEqual(q.rows.map((x) => [x.customer, x.total]), [['Ann Old', '$5,000.00']]);
  const inv = (await call(env, 'view=invoices')).body;
  assert.deepEqual(inv.rows.map((x) => x.amount), ['$6,300.00']);
  const sch = (await call(env, 'view=schedule')).body;
  assert.deepEqual(sch.rows.map((x) => x.item), ['shed']);
  const rev = (await call(env, 'view=revenue')).body;
  assert.match(rev.summary, /\$2,700\.00 collected and \$9,000\.00 booked/);
  const cs = (await call(env, 'view=customers&q=1234')).body;
  assert.deepEqual(cs.rows.map((x) => x.name), ['Nahui Lopez']);
});

test('a table the worker has not created yet reads as empty, not an error', async () => {
  const r = await call({ DB: setup({ noInvoices: true }), BRIEFING_API_KEY: KEY }, 'view=invoices');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, []);
  assert.equal(r.body.summary, 'Nothing outstanding.');
});
