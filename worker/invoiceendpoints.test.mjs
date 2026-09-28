/* THE BUTTON THAT ASKS A CUSTOMER FOR MONEY.
 *
 * Real worker, real SQLite standing in for D1, Stripe stubbed. Nothing here
 * needs a key or a network.
 *
 * Run: node --experimental-sqlite --test worker/invoiceendpoints.test.mjs
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

const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted' });

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);`);
  db.prepare("INSERT INTO customers (id,name,email,phone) VALUES (1,'Hank','hank@roof.test','4355550000')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,created_at) VALUES (?,?,?,?)")
    .run(7, 1, JSON.stringify({ redline }), '2026-09-01');
  db.prepare("INSERT INTO submissions (id,customer_id,details,created_at) VALUES (?,?,?,?)")
    .run(8, 1, JSON.stringify({ redline }), '2026-09-20');   // their SECOND shed
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k',
                      STRIPE_SECRET_KEY: 'sk_test_fake' } };
}

function stubStripe(overrides = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, params: Object.fromEntries(new URLSearchParams(init.body || '')) });
    if (overrides[p]) return overrides[p];
    const id = p === '/v1/customers' ? 'cus_new' : p.includes('invoiceitems') ? 'ii_1' : 'in_1';
    return { ok: true, status: 200, json: async () => ({
      id, status: 'open', hosted_invoice_page: 'https://pay.stripe/x' }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function token(env) {
  const r = await api(env, 'POST', '/admin/login', { password: 'pw' });
  return r.data.token;
}

test('a preview prices the invoice without touching Stripe', async () => {
  const { env } = setup();
  const t = await token(env);
  const s = stubStripe();
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', preview: true }, t);
  s.restore();
  assert.equal(r.status, 200);
  assert.equal(r.data.preview, true);
  assert.ok(r.data.amount > 0 && r.data.lines.length >= 2, JSON.stringify(r.data).slice(0, 200));
  assert.equal(s.calls.length, 0, 'a preview must not call Stripe');
});

test('sending records what went out, with the link to it', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubStripe();
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.hosted_url, 'https://pay.stripe/x');
  const row = db.prepare('SELECT * FROM invoices').get();
  assert.equal(row.submission_id, 7);
  assert.equal(row.kind, 'deposit');
  assert.equal(row.stripe_invoice_id, 'in_1');
  assert.ok(Math.abs(row.amount - r.data.amount) < 0.005, 'the recorded amount is what was billed');
});

test('the Stripe customer is stored, so a second invoice does not create another', async () => {
  const { db, env } = setup();
  const t = await token(env);
  let s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(db.prepare('SELECT stripe_customer_id FROM customers WHERE id=1').get().stripe_customer_id, 'cus_new');

  s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit' }, t);
  s.restore();
  assert.ok(!s.calls.some((c) => c.path === '/v1/customers'), 'it created a duplicate customer');
});

test('a second invoice of the same kind is refused until the first is voided', async () => {
  const { env } = setup();
  const t = await token(env);
  let s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();

  s = stubStripe();
  const again = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(again.status, 409, 'a double send should be refused');
  assert.match(again.data.error, /already exists/);
  assert.equal(s.calls.length, 0, 'and nothing should have reached Stripe');
});

/* THE SECOND-SHED CASE. */
test("the balance on shed two is not credited with shed one's payments", async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.exec(`CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL,
           method TEXT, note TEXT, paid_at TEXT, created_at TEXT, submission_id INTEGER)`);
  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,5000,'check','2026-09-02','2026-09-02',7)").run();
  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,1000,'card','2026-09-21','2026-09-21',8)").run();

  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'balance', preview: true }, t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.already_paid, 1000, 'only shed two’s payment counts');
  const credits = r.data.lines.filter((l) => l.amount < 0);
  assert.equal(credits.length, 1, 'one credit line, not two');
});

test('payments with no job attached are surfaced, not silently applied', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.exec(`CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL,
           method TEXT, note TEXT, paid_at TEXT, created_at TEXT, submission_id INTEGER)`);
  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,2500,'cash','2026-08-01','2026-08-01',NULL)").run();

  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  assert.equal(r.data.already_paid, 0, 'not applied');
  const w = (r.data.warnings || []).find((x) => x.code === 'unassigned_payments');
  assert.ok(w, 'and not ignored either — it has to be said out loud');
  assert.equal(w.total, 2500);
});

test('voiding clears it here and in Stripe', async () => {
  const { db, env } = setup();
  const t = await token(env);
  let s = stubStripe();
  const made = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();

  s = stubStripe();
  const v = await api(env, 'POST', `/admin/invoices/${made.data.id}/void`, {}, t);
  s.restore();
  assert.equal(v.status, 200);
  assert.ok(s.calls.some((c) => c.path === '/v1/invoices/in_1/void'), 'Stripe was not told');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(made.data.id).status, 'void');
});

test('a paid invoice is not voidable — that would be a refund', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubStripe();
  const made = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  db.prepare("UPDATE invoices SET status='paid' WHERE id=?").run(made.data.id);

  const v = await api(env, 'POST', `/admin/invoices/${made.data.id}/void`, {}, t);
  assert.equal(v.status, 409);
  assert.match(v.data.error, /refund it in Stripe/);
});

test('a Stripe refusal is reported, and nothing is recorded as sent', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubStripe({ '/v1/invoices': { ok: false, status: 400,
    json: async () => ({ error: { message: 'Customer has no payment method.' } }) } });
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(r.status, 502);
  assert.match(r.data.error, /no payment method/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0,
    'a failed send must not leave a row claiming an invoice exists');
});

test('none of it is reachable without an admin token', async () => {
  const { env } = setup();
  for (const [m, p] of [['POST', '/admin/invoices'], ['GET', '/admin/customers/1/invoices'],
                        ['POST', '/admin/invoices/1/void']]) {
    const r = await api(env, m, p, m === 'GET' ? null : {});
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('the list shows what was billed and links back to each one', async () => {
  const { env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  const r = await api(env, 'GET', '/admin/customers/1/invoices', null, t);
  assert.equal(r.status, 200);
  assert.equal(r.data.invoices.length, 1);
  assert.ok(Array.isArray(r.data.invoices[0].lines) && r.data.invoices[0].lines.length >= 2,
    'the lines are stored, so the invoice reads the same later even if pricing moves');
});
