/* "IF I MARK A PAYMENT, SUBTRACT IT BEFORE WE BILL WITH STRIPE."
 *
 * Every payment recorded against a build — a cashier's check, cash, a deposit
 * taken on Invoice2go before Stripe, or a Stripe invoice that already cleared —
 * comes off what Stripe is asked for. Deposit AND balance. Never below zero,
 * and a job that is covered gets no Stripe bill at all.
 *
 * Real worker, real SQLite standing in for D1, Stripe stubbed. No key, no
 * network, no real invoice.
 *
 * Run: node --experimental-sqlite --test worker/balance.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { buildInvoice, balanceSummary, toCents } from './invoices.js';
import worker from './index.js';

const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted' });
const BD = quoteLines(redline, []);
const JOB = toCents(BD.total);
const DEP = toCents(BD.depositTotal);
const sumLines = (inv) => inv.lines.reduce((t, l) => t + l.amountCents, 0);

/* ---- the arithmetic ---------------------------------------------------- */

test('a deposit marked by hand comes off the deposit invoice', () => {
  const inv = buildInvoice(BD, 'deposit', [{ amount: 1000, method: 'cashiers_check', paid_at: '2026-09-01' }]);
  assert.equal(inv.totalCents, DEP - 100000);
  assert.equal(sumLines(inv), inv.totalCents, 'the lines add up to what is asked');
  const credit = inv.lines.find((l) => /Payment received/.test(l.label));
  assert.equal(credit.amountCents, -100000, 'credited exactly as paid');
  assert.match(credit.label, /cashier's check 2026-09-01/);
  assert.match(inv.footer, /less payments already received/);
});

test('a deposit already covered by a check is not billed again', () => {
  assert.throws(() => buildInvoice(BD, 'deposit', [{ amount: BD.depositTotal, method: 'check' }]),
    (e) => e.code === 'deposit_covered');
  /* ... and the balance is still billable, for exactly the rest. */
  const bal = buildInvoice(BD, 'balance', [{ amount: BD.depositTotal, method: 'check' }]);
  assert.equal(bal.totalCents, JOB - toCents(BD.depositTotal));
});

test('the balance subtracts manual AND Stripe payments together', () => {
  const pays = [
    { amount: 965.25, method: 'invoice2go', paid_at: '2026-09-01' },
    { amount: 2000, method: 'stripe', paid_at: '2026-09-20' },
    { amount: 500, method: 'cash', paid_at: '2026-09-25' },
  ];
  const inv = buildInvoice(BD, 'balance', pays);
  assert.equal(inv.totalCents, JOB - 96525 - 200000 - 50000);
  assert.equal(sumLines(inv), inv.totalCents);
  assert.equal(inv.paidCents, 96525 + 200000 + 50000);
});

test('paid in full: no Stripe bill, and the summary says so', () => {
  const pays = [{ amount: BD.total, method: 'check' }];
  assert.throws(() => buildInvoice(BD, 'balance', pays), (e) => e.code === 'paid_in_full');
  const s = balanceSummary(BD, pays);
  assert.equal(s.balanceCents, 0);
  assert.equal(s.paidInFull, true);
  assert.equal(s.depositDueCents, 0);
});

test('overpaid never shows a negative balance', () => {
  const s = balanceSummary(BD, [{ amount: BD.total + 250, method: 'check' }]);
  assert.equal(s.balanceCents, 0);
  assert.equal(s.overpaidCents, 25000);
  assert.equal(s.paidInFull, true);
});

test('cents, not floating dollars: ten 10-cent payments are exactly one dollar', () => {
  const dimes = Array.from({ length: 10 }, () => ({ amount: 0.1, method: 'cash' }));
  const s = balanceSummary(BD, dimes);
  assert.equal(s.paidCents, 100);
  assert.equal(s.balanceCents, JOB - 100);
  /* 0.1 + 0.2 summed as floats is 0.30000000000000004 */
  assert.equal(balanceSummary(BD, [{ amount: 0.1 }, { amount: 0.2 }]).paidCents, 30);
});

test('no payments: balance is the whole job, deposit is the full 30%', () => {
  const s = balanceSummary(BD, []);
  assert.equal(s.balanceCents, JOB);
  assert.equal(s.depositDueCents, DEP);
  assert.equal(s.paidInFull, false);
  assert.equal(buildInvoice(BD, 'deposit', []).totalCents, DEP);
});

/* ---- the endpoints ------------------------------------------------------ */

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
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);`);
  db.prepare("INSERT INTO customers (id,name,email) VALUES (1,'Pat','pat@test.test')").run();
  db.prepare("INSERT INTO customers (id,name,email) VALUES (2,'Other','o@test.test')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,'won','2026-09-01')")
    .run(JSON.stringify({ redline }));
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (8,1,?,'new','2026-09-20')")
    .run(JSON.stringify({ consult: true }));
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k',
                      STRIPE_SECRET_KEY: 'sk_test_fake' } };
}
function stubStripe() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, params: Object.fromEntries(new URLSearchParams(init.body || '')) });
    const id = p === '/v1/customers' ? 'cus_new' : p.includes('invoiceitems') ? 'ii_1' : 'in_1';
    return { ok: true, status: 200, json: async () => ({ id, status: 'open', hosted_invoice_url: 'https://pay.stripe/x' }) };
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
async function token(env) { return (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token; }
const build7 = async (env, t) => (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data.builds
  .find((b) => b.submission_id === 7);
const c = (n) => Math.round(n * 100);

test('balances: total, payments and balance due, per priced build', async () => {
  const { env } = setup();
  const t = await token(env);
  let b = await build7(env, t);
  assert.equal(c(b.job_total), JOB);
  assert.equal(c(b.balance_due), JOB);
  assert.equal(c(b.deposit_due), DEP);
  assert.equal(b.payments.length, 0);
  const all = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data;
  assert.equal(all.builds.length, 1, 'the consult request has nothing to bill');
  assert.equal((await api(env, 'GET', '/admin/customers/1/balances')).status, 401, 'needs a login');
});

test('marking an outside payment lowers the balance and the Stripe preview', async () => {
  const { env } = setup();
  const t = await token(env);
  const add = await api(env, 'POST', '/admin/customers/1/payments',
    { amount: 965.25, method: 'invoice2go', submission_id: 7, note: 'Deposit on concrete', paid_at: '2026-09-01T00:00:00.000Z' }, t);
  assert.equal(add.status, 200);
  const b = await build7(env, t);
  assert.equal(c(b.paid), 96525);
  assert.equal(c(b.balance_due), JOB - 96525);
  assert.equal(c(b.deposit_due), DEP - 96525);

  const s = stubStripe();
  const bal = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  const dep = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', preview: true }, t);
  s.restore();
  assert.equal(s.calls.length, 0, 'previews never reach Stripe');
  assert.equal(c(bal.data.amount), JOB - 96525, 'Stripe would be asked for total minus the deposit');
  assert.equal(c(bal.data.balance_due), JOB - 96525);
  assert.equal(bal.data.payments.length, 1);
  assert.equal(bal.data.payments[0].method, 'invoice2go');
  assert.equal(c(dep.data.amount), DEP - 96525, 'and the deposit invoice credits it too');
});

test("a cashier's check is a method you can record", async () => {
  const { env } = setup();
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'cashiers_check', submission_id: 7 }, t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('amounts are stored as whole cents', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: '1250.005', method: 'cash', submission_id: 7 }, t);
  assert.equal(db.prepare('SELECT amount FROM payments').get().amount, 1250.01);
  const zero = await api(env, 'POST', '/admin/customers/1/payments', { amount: 0.001, method: 'cash' }, t);
  assert.equal(zero.status, 400, 'a payment that rounds to nothing is refused');
});

test('editing a payment changes the balance; deleting it restores it', async () => {
  const { env } = setup();
  const t = await token(env);
  const id = (await api(env, 'POST', '/admin/customers/1/payments', { amount: 1000, method: 'check', submission_id: 7 }, t)).data.id;
  assert.equal(c((await build7(env, t)).balance_due), JOB - 100000);

  const ed = await api(env, 'POST', '/admin/payments/' + id, { amount: 1500.5, note: 'typo fixed' }, t);
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(ed.data.payment.amount, 1500.5);
  assert.equal(c((await build7(env, t)).balance_due), JOB - 150050);

  const moved = await api(env, 'POST', '/admin/payments/' + id, { submission_id: null }, t);
  assert.equal(moved.status, 200);
  assert.equal(c((await build7(env, t)).balance_due), JOB, 'unassigned payments are not credited');
  assert.equal((await api(env, 'GET', '/admin/customers/1/balances', null, t)).data.unassigned.count, 1);
  await api(env, 'POST', '/admin/payments/' + id, { submission_id: 7 }, t);

  await api(env, 'DELETE', '/admin/payments/' + id, null, t);
  assert.equal(c((await build7(env, t)).balance_due), JOB);
});

test('edits are validated, and a Stripe-recorded payment keeps its amount', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const id = (await api(env, 'POST', '/admin/customers/1/payments', { amount: 100, method: 'cash', submission_id: 7 }, t)).data.id;
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { amount: -5 }, t)).status, 400);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { method: 'bitcoin' }, t)).status, 400);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { submission_id: 999 }, t)).status, 400);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, {}, t)).status, 400);
  assert.equal((await api(env, 'POST', '/admin/payments/99999', { amount: 1 }, t)).status, 404);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { amount: 1 })).status, 401);

  db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,2000,'stripe','2026-09-20','2026-09-20',7)").run();
  const sid = db.prepare("SELECT id FROM payments WHERE method='stripe'").get().id;
  assert.equal((await api(env, 'POST', '/admin/payments/' + sid, { amount: 1 }, t)).status, 409);
  assert.equal((await api(env, 'POST', '/admin/payments/' + sid, { note: 'fine' }, t)).status, 200);
});

test('a covered job gets no Stripe bill, with a code the CRM can show as "Paid in full"', async () => {
  const { env } = setup();
  const t = await token(env);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: BD.total, method: 'cashiers_check', submission_id: 7 }, t);
  const b = await build7(env, t);
  assert.equal(b.paid_in_full, true);
  assert.equal(b.balance_due, 0);
  const s = stubStripe();
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance' }, t);
  const d = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'paid_in_full');
  assert.equal(d.data.code, 'deposit_covered');
  assert.equal(s.calls.length, 0, 'nothing reached Stripe');
});

test('a Stripe payment already received is not counted twice', async () => {
  const { db, env } = setup();
  const t = await token(env);
  /* A deposit sent through the CRM and paid — the webhook path, via Check Stripe. */
  let s = stubStripe();
  const sent = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  assert.equal(sent.status, 200);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    id: 'in_1', status: 'paid', amount_paid: DEP, hosted_invoice_url: 'https://pay.stripe/x' }) });
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);   // twice: still one payment
  globalThis.fetch = orig;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE method='stripe'").get().n, 1);
  const b = await build7(env, t);
  assert.equal(c(b.balance_due), JOB - DEP);
  assert.equal(b.open_invoices.length, 0, 'a paid invoice is not listed as open');
});

test('an open Stripe invoice is listed but not subtracted', async () => {
  const { env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  const b = await build7(env, t);
  assert.equal(c(b.balance_due), JOB, 'money not yet received is not taken off');
  assert.equal(b.open_invoices.length, 1);
  assert.equal(b.open_invoices[0].kind, 'deposit');
});
