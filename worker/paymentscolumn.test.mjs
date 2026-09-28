/* THE COLUMN THAT HAS TO APPEAR ON A TABLE FULL OF REAL PAYMENTS.
 *
 * ensurePaymentsTable runs on every payment request. It was a CREATE TABLE IF
 * NOT EXISTS and nothing else, which is a no-op forever once the table exists —
 * so adding submission_id means an ALTER that runs against the live table, with
 * real rows in it, on the next deploy.
 *
 * Nothing tested it. D1 has no ADD COLUMN IF NOT EXISTS, and a duplicate ADD
 * throws, so a mistake here does not fail loudly at deploy: it fails the next
 * time someone records a payment.
 *
 * The case that matters is the production one — a table that already exists
 * WITHOUT the column — not a fresh database where CREATE TABLE covers it.
 *
 * Run: node --experimental-sqlite --test worker/paymentscolumn.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

/* The same D1 stand-in the end-to-end test uses. PRAGMA has to read like a
   SELECT or table_info comes back empty and the ALTER never runs. */
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

/* The table exactly as it stands in production today: no submission_id. */
const OLD_SCHEMA = `CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  note TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

function envWith(sql) {
  const db = new DatabaseSync(':memory:');
  if (sql) db.exec(sql);
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}

async function token(env) {
  const r = await worker.fetch(new Request('https://local/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' })
  }), env);
  return (await r.json()).token;
}

/* Reaching ensurePaymentsTable through a real request rather than importing it,
   because a helper that is only ever correct when called directly is not the
   thing that runs. */
async function touchPayments(env) {
  const t = await token(env);
  return worker.fetch(new Request('https://local/admin/customers/1/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify({ amount: 100, method: 'check', paid_at: '2026-09-01' })
  }), env);
}

const cols = (db) => db.prepare('PRAGMA table_info(payments)').all().map((r) => r.name);

test('the column is added to a table that already exists without it', async () => {
  const { db, env } = envWith(OLD_SCHEMA);
  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at) VALUES (1,3000,'check','2026-01-01','2026-01-01')").run();
  assert.ok(!cols(db).includes('submission_id'), 'starts without it, as production does');

  await touchPayments(env);
  assert.ok(cols(db).includes('submission_id'), 'submission_id was never added');
});

test('the payments already in the table survive it', async () => {
  const { db, env } = envWith(OLD_SCHEMA);
  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at) VALUES (7,3000,'check','2026-01-01','2026-01-01')").run();
  await touchPayments(env);

  const rows = db.prepare('SELECT customer_id, amount, submission_id FROM payments ORDER BY id').all();
  assert.equal(rows[0].customer_id, 7, 'the existing row is still there');
  assert.equal(rows[0].amount, 3000, 'with its amount intact');
  assert.equal(rows[0].submission_id, null, 'and unattributed rather than guessed at');
});

/* The one that would break recording a payment entirely: D1 throws on a
   duplicate ADD COLUMN, and this helper runs on EVERY payment request. */
test('running it again does not throw on the duplicate ADD', async () => {
  const { db, env } = envWith(OLD_SCHEMA);
  for (let i = 0; i < 3; i++) {
    const r = await touchPayments(env);
    assert.ok(r.status < 500, `call ${i + 1} returned ${r.status}`);
  }
  assert.equal(cols(db).filter((c) => c === 'submission_id').length, 1, 'added exactly once');
});

test('a database with no payments table at all still gets one, with the column', async () => {
  const { db, env } = envWith(null);
  await touchPayments(env);
  assert.ok(cols(db).includes('submission_id'), 'a fresh table should have it from the start');
});
