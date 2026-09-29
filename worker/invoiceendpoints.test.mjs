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
      id, status: 'open', hosted_invoice_url: 'https://pay.stripe/x' }) };
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

/* ── WHICH SHED DID THIS PAY FOR ─────────────────────────────────────────────
 * Recording a payment without a build is what created the unassigned pile in
 * the first place. These cover putting one on, and putting one on afterwards.
 */
function withPayments() {
  const s = setup();
  s.db.exec(`CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL,
             method TEXT, note TEXT, paid_at TEXT, created_at TEXT, submission_id INTEGER)`);
  /* The full customer endpoint reads notes too, and there is no
     ensureNotesTable — it predates the lazy-creation pattern. */
  s.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT)');
  s.db.prepare("INSERT INTO customers (id,name,email) VALUES (2,'Someone Else','x@y.test')").run();
  s.db.prepare("INSERT INTO submissions (id,customer_id,details,created_at) VALUES (99,2,'{}','2026-01-01')").run();
  return s;
}

test('a payment can say which build it paid for', async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments',
    { amount: 5000, method: 'check', submission_id: 7 }, t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT submission_id FROM payments WHERE id=?').get(r.data.id).submission_id, 7);
});

/* Money attached to another customer's job would be credited to a stranger's
   balance invoice. */
test("a build belonging to another customer is refused", async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments',
    { amount: 5000, method: 'check', submission_id: 99 }, t);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /does not belong/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0, 'and nothing was written');
});

/* A payment can arrive before anyone knows which shed it is for. Refusing it
   pushes someone into not recording it at all, which is worse. */
test('a payment with no build is still accepted', async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments', { amount: 5000, method: 'cash' }, t);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT submission_id FROM payments WHERE id=?').get(r.data.id).submission_id, null);
});

test('an old unassigned payment can be placed afterwards', async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  db.prepare("INSERT INTO payments (id,customer_id,amount,method,paid_at,created_at,submission_id) VALUES (50,1,2500,'cash','2026-08-01','2026-08-01',NULL)").run();

  const r = await api(env, 'POST', '/admin/payments/50/submission', { submission_id: 8 }, t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT submission_id FROM payments WHERE id=50').get().submission_id, 8);

  /* And it now counts against that shed's balance, which is the point. */
  const prev = await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'balance', preview: true }, t);
  assert.equal(prev.data.already_paid, 2500);
  assert.ok(!(prev.data.warnings || []).some((w) => w.code === 'unassigned_payments'),
    'the warning should clear once it is placed');
});

test('it can be moved off a build again, and cannot be moved to a stranger’s', async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  db.prepare("INSERT INTO payments (id,customer_id,amount,method,paid_at,created_at,submission_id) VALUES (51,1,900,'card','2026-08-01','2026-08-01',7)").run();

  const off = await api(env, 'POST', '/admin/payments/51/submission', { submission_id: '' }, t);
  assert.equal(off.status, 200);
  assert.equal(db.prepare('SELECT submission_id FROM payments WHERE id=51').get().submission_id, null);

  const bad = await api(env, 'POST', '/admin/payments/51/submission', { submission_id: 99 }, t);
  assert.equal(bad.status, 400, 'another customer’s build must be refused here too');
});

test('assigning a payment needs the admin token', async () => {
  const { env } = withPayments();
  const r = await api(env, 'POST', '/admin/payments/50/submission', { submission_id: 7 });
  assert.equal(r.status, 401);
});

test('the payments list carries the build, so the page can show it', async () => {
  const { db, env } = withPayments();
  const t = await token(env);
  db.prepare("INSERT INTO payments (id,customer_id,amount,method,paid_at,created_at,submission_id) VALUES (52,1,900,'card','2026-08-01','2026-08-01',7)").run();
  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  assert.equal(r.status, 200);
  assert.equal((r.data.payments || [])[0].submission_id, 7);
});

/* ── THE WEBHOOK, END TO END ─────────────────────────────────────────────────
 * Signature verification has its own file. These are about what a verified
 * event does to the database.
 */
import { computeSignature } from './stripewebhook.js';

const WH_SECRET = 'whsec_test_secret';

async function postEvent(env, event, opts = {}) {
  const raw = JSON.stringify(event);
  const t = opts.t || Math.floor(Date.now() / 1000);
  const sig = opts.badSignature
    ? 'deadbeef'
    : await computeSignature(opts.secret || WH_SECRET, `${t}.${raw}`);
  const r = await worker.fetch(new Request('https://local/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` },
    body: raw,
  }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}

const paidEvent = (stripeId, cents) => ({
  id: 'evt_' + stripeId, type: 'invoice.paid',
  data: { object: { id: stripeId, amount_paid: cents } },
});

async function issued(env, t, kind = 'deposit', submission = 7) {
  const s = stubStripe();
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: submission, kind }, t);
  s.restore();
  return r;
}

function whEnv() {
  const s = withPayments();
  s.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  return s;
}

test('a paid invoice records the payment against the right shed', async () => {
  const { db, env } = whEnv();
  const t = await token(env);
  const made = await issued(env, t);

  const r = await postEvent(env, paidEvent('in_1', 250000));
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const pay = db.prepare("SELECT * FROM payments WHERE method='stripe'").get();
  assert.ok(pay, 'no payment was recorded');
  assert.equal(pay.amount, 2500, 'amount_paid is in cents');
  assert.equal(pay.submission_id, 7, 'and it belongs to the shed that was invoiced');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(made.data.id).status, 'paid');
});

/* Stripe retries for three days, and a resend can be triggered by hand for 30.
   One payment recorded several times makes the balance invoice under-bill. */
test('the same event arriving repeatedly records one payment', async () => {
  const { db, env } = whEnv();
  const t = await token(env);
  await issued(env, t);
  for (let i = 0; i < 4; i++) {
    const r = await postEvent(env, paidEvent('in_1', 250000));
    assert.equal(r.status, 200);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE method='stripe'").get().n, 1);
});

test('an unsigned event changes nothing', async () => {
  const { db, env } = whEnv();
  const t = await token(env);
  await issued(env, t);
  const r = await postEvent(env, paidEvent('in_1', 250000), { badSignature: true });
  assert.equal(r.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments").get().n, 0, 'nothing was written');
  assert.equal(r.data.error, 'bad signature');
  assert.ok(!JSON.stringify(r.data).includes('match'), 'the reason must not leak to the caller');
});

test('an event signed with the wrong secret changes nothing', async () => {
  const { db, env } = whEnv();
  const t = await token(env);
  await issued(env, t);
  const r = await postEvent(env, paidEvent('in_1', 250000), { secret: 'whsec_attacker' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments").get().n, 0);
});

test('an invoice raised outside the CRM is acknowledged, not errored', async () => {
  const { db, env } = whEnv();
  const r = await postEvent(env, paidEvent('in_from_dashboard', 5000));
  assert.equal(r.status, 200, 'a non-2xx would make Stripe retry it for three days');
  assert.match(String(r.data.ignored), /unknown invoice/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments").get().n, 0);
});

test('event types we do not handle are acknowledged', async () => {
  const { env } = whEnv();
  const r = await postEvent(env, { id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_1' } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, 'customer.created');
});

/* What cleared is not always what was billed — a partial payment or a credit
   note changes it. */
test('a part payment records what actually arrived', async () => {
  const { db, env } = whEnv();
  const t = await token(env);
  await issued(env, t);
  await postEvent(env, paidEvent('in_1', 100000));
  assert.equal(db.prepare("SELECT amount FROM payments WHERE method='stripe'").get().amount, 1000);
});

/* The point of the whole thing: the balance invoice knows what Stripe collected
   without anyone re-typing it. */
test('the payment it records comes off the balance invoice by itself', async () => {
  const { env } = whEnv();
  const t = await token(env);
  await issued(env, t, 'deposit', 7);
  await postEvent(env, paidEvent('in_1', 250000));

  const prev = await api(env, 'POST', '/admin/invoices',
    { submission_id: 7, kind: 'balance', preview: true }, t);
  assert.equal(prev.data.already_paid, 2500);
  assert.ok(!(prev.data.warnings || []).some((w) => w.code === 'unassigned_payments'),
    'a Stripe payment is never unassigned — it knows its shed');
});

/* Deposit sent, not paid, and someone reaches for the balance. buildInvoice
   nets off money RECEIVED, so the balance is still the whole job — correct,
   and dangerous, because the customer now holds two bills adding up to more
   than the shed. The endpoint has to say so. */
test('an unpaid invoice on the same shed is called out on the next one', async () => {
  const { env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  s.restore();
  const warn = (r.data.warnings || []).find((w) => w.code === 'unpaid_invoice');
  assert.ok(warn, 'no warning: ' + JSON.stringify(r.data.warnings));
  assert.equal(warn.kind, 'deposit');
  assert.ok(warn.combined > r.data.job_total,
    'the point of the warning is that the two together exceed the job');
  assert.ok(Math.abs(warn.combined - (warn.amount + r.data.amount)) < 0.005,
    'combined is the two invoices added up');
});

test('a PAID deposit is credited instead of warned about', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  db.prepare("UPDATE invoices SET status = 'paid' WHERE kind = 'deposit'").run();
  const inv = db.prepare("SELECT amount FROM invoices WHERE kind = 'deposit'").get();
  db.prepare(`INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at, submission_id)
              VALUES (1,?,'stripe','',?,?,7)`).run(inv.amount, '2026-09-10', '2026-09-10');
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  s.restore();
  assert.equal((r.data.warnings || []).filter((w) => w.code === 'unpaid_invoice').length, 0,
    'a paid invoice is not outstanding');
  assert.ok(Math.abs(r.data.already_paid - inv.amount) < 0.005, 'the deposit is credited');
  assert.ok(Math.abs(r.data.amount - (r.data.job_total - inv.amount)) < 0.005,
    'so the balance is the rest of the job');
});

test('a VOIDED invoice is neither credited nor warned about', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  db.prepare("UPDATE invoices SET status = 'void' WHERE kind = 'deposit'").run();
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  s.restore();
  assert.equal((r.data.warnings || []).filter((w) => w.code === 'unpaid_invoice').length, 0);
  assert.equal(r.data.already_paid, 0);
});

/* The other shed's invoice is not this shed's problem. Without the
   submission_id in that query, every repeat customer would get a double-bill
   warning on a job that has nothing to do with the open one. */
test('an unpaid invoice on a DIFFERENT shed is not warned about here', async () => {
  const { env } = setup();
  const t = await token(env);
  const s = stubStripe();
  await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit' }, t);
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true }, t);
  s.restore();
  assert.equal((r.data.warnings || []).filter((w) => w.code === 'unpaid_invoice').length, 0,
    JSON.stringify(r.data.warnings));
});

/* ---- Check Stripe: the path for when the webhook did not arrive --------- */

function stubGet(invoice) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: (init && init.method) || 'POST' });
    if (/^\/v1\/invoices\/in_/.test(u.pathname) && (init && init.method) === 'GET') {
      return { ok: true, status: 200, json: async () => invoice };
    }
    const id = u.pathname === '/v1/customers' ? 'cus_new'
      : u.pathname.includes('invoiceitems') ? 'ii_1' : 'in_1';
    return { ok: true, status: 200, json: async () => ({
      id, status: 'open', hosted_invoice_url: 'https://pay.stripe/x' }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

async function sentInvoice() {
  const { db, env } = setup();
  const t = await token(env);
  const s = stubGet({});
  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  s.restore();
  const row = db.prepare("SELECT * FROM invoices WHERE kind='deposit'").get();
  return { db, env, t, row };
}

test('Check Stripe records a payment the webhook never delivered', async () => {
  const { db, env, t, row } = await sentInvoice();
  assert.equal(row.status, 'open', 'starts unpaid');

  const s = stubGet({ id: row.stripe_invoice_id, status: 'paid',
    amount_paid: Math.round(row.amount * 100), hosted_invoice_url: 'https://pay.stripe/x' });
  const r = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  s.restore();

  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'paid');
  assert.equal(r.data.changed, true);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(row.id).status, 'paid');
  const pay = db.prepare('SELECT * FROM payments').all();
  assert.equal(pay.length, 1, 'exactly one payment recorded');
  assert.equal(pay[0].submission_id, 7, 'against the right shed');
  assert.equal(pay[0].method, 'stripe');
  assert.ok(Math.abs(pay[0].amount - row.amount) < 0.005);
});

/* THE ONE THAT MATTERS. Pressing the button after the webhook already worked
   must not record the payment twice — a double-counted deposit makes the
   balance invoice under-bill by that amount, and nothing would flag it. */
test('the button and the webhook cannot both record the same payment', async () => {
  const { db, env, t, row } = await sentInvoice();
  const paid = { id: row.stripe_invoice_id, status: 'paid',
    amount_paid: Math.round(row.amount * 100) };

  let s = stubGet(paid);
  await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  const second = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  const third = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  s.restore();

  assert.equal(second.data.changed, false, 'the second press changed nothing');
  assert.equal(third.data.changed, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1,
    'one payment, however many times the button is pressed');
});

test('it backfills a pay link that was never stored', async () => {
  const { db, env, t, row } = await sentInvoice();
  db.prepare('UPDATE invoices SET hosted_url = NULL WHERE id = ?').run(row.id);

  const s = stubGet({ id: row.stripe_invoice_id, status: 'open',
    hosted_invoice_url: 'https://pay.stripe/recovered' });
  const r = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  s.restore();

  assert.equal(r.data.changed, false, 'the status did not move');
  assert.equal(db.prepare('SELECT hosted_url FROM invoices WHERE id=?').get(row.id).hosted_url,
    'https://pay.stripe/recovered', 'but the missing link came back');
});

test('a voided or written-off invoice stops showing as money owed', async () => {
  for (const status of ['void', 'uncollectible']) {
    const { db, env, t, row } = await sentInvoice();
    const s = stubGet({ id: row.stripe_invoice_id, status });
    const r = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
    s.restore();
    assert.equal(r.data.status, status);
    assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(row.id).status, status);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0,
      status + ' must not record a payment');
  }
});

test('it asks Stripe and does not change anything there', async () => {
  const { env, t, row } = await sentInvoice();
  const s = stubGet({ id: row.stripe_invoice_id, status: 'open' });
  await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  s.restore();
  assert.deepEqual(s.calls, [{ path: '/v1/invoices/' + row.stripe_invoice_id, method: 'GET' }],
    'one GET, nothing else: ' + JSON.stringify(s.calls));
});

test('Check Stripe reports a refusal instead of guessing', async () => {
  const { db, env, t, row } = await sentInvoice();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404,
    json: async () => ({ error: { message: 'No such invoice' } }) });
  const r = await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  globalThis.fetch = orig;
  assert.equal(r.status, 502);
  assert.match(r.data.error, /No such invoice/);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(row.id).status, 'open',
    'a failed check leaves the row alone');
});

test('sync needs an admin token, and a real invoice', async () => {
  const { env, t } = await sentInvoice();
  assert.equal((await api(env, 'POST', '/admin/invoices/1/sync', {})).status, 401);
  assert.equal((await api(env, 'POST', '/admin/invoices/99999/sync', {}, t)).status, 404);
});

/* ---- where the invoice actually went ----------------------------------- */

test('the address Stripe sent to is recorded on the invoice', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    const id = p === '/v1/customers' ? 'cus_new' : p.includes('invoiceitems') ? 'ii_1' : 'in_1';
    return { ok: true, status: 200, json: async () => ({ id, status: 'open',
      hosted_invoice_url: 'https://pay.stripe/x',
      /* Stripe reports where it went; that is what gets stored, not what we
         asked for — the two differ when the customer record says otherwise. */
      customer_email: 'where-it-went@roof.test', email: 'where-it-went@roof.test' }) };
  };
  const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  globalThis.fetch = orig;

  /* Deliberately NOT the address in the CRM (hank@roof.test). Storing what we
     asked for rather than what Stripe reports passes every test where the two
     agree, and the whole point of the field is the case where they do not. */
  assert.notEqual(db.prepare('SELECT email FROM customers WHERE id=1').get().email,
    'where-it-went@roof.test', 'fixture must make the two differ');
  assert.equal(r.data.sent_to, 'where-it-went@roof.test');
  assert.equal(db.prepare('SELECT sent_to FROM invoices').get().sent_to, 'where-it-went@roof.test');

  const list = await api(env, 'GET', '/admin/customers/1/invoices', null, t);
  assert.equal(list.data.invoices[0].sent_to, 'where-it-went@roof.test',
    'the CRM must be able to show where it went');
});

/* The email was read from the CRM on the first invoice only. Correcting it
   afterwards changed nothing, and every later invoice went to the old
   address — with Stripe reporting each send as successful. */
test('a corrected email reaches Stripe on the next invoice, not just the first', async () => {
  const { db, env } = setup();
  const t = await token(env);
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, params: Object.fromEntries(new URLSearchParams((init && init.body) || '')) });
    const id = p.startsWith('/v1/customers') ? 'cus_new'
      : p.includes('invoiceitems') ? 'ii_1' : 'in_1';
    const email = p.startsWith('/v1/customers')
      ? (Object.fromEntries(new URLSearchParams((init && init.body) || '')).email || null) : null;
    return { ok: true, status: 200, json: async () => ({ id, status: 'open',
      hosted_invoice_url: 'https://pay.stripe/x', email,
      customer_email: 'typo@roof.test' }) };
  };

  await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
  assert.equal(db.prepare('SELECT stripe_customer_id FROM customers WHERE id=1').get()
    .stripe_customer_id, 'cus_new');

  /* Someone fixes the address in the CRM. */
  db.prepare("UPDATE customers SET email = 'fixed@roof.test' WHERE id = 1").run();
  calls.length = 0;
  await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit' }, t);
  globalThis.fetch = orig;

  const cust = calls.find((c) => c.path.startsWith('/v1/customers'));
  assert.ok(cust, 'Stripe was never told: ' + JSON.stringify(calls.map((c) => c.path)));
  assert.equal(cust.path, '/v1/customers/cus_new', 'it must update, not duplicate');
  assert.equal(cust.params.email, 'fixed@roof.test', 'the corrected address must reach Stripe');
});

test('Check Stripe backfills a recipient that was never recorded', async () => {
  const { db, env, t, row } = await sentInvoice();
  db.prepare('UPDATE invoices SET sent_to = NULL WHERE id = ?').run(row.id);
  const s = stubGet({ id: row.stripe_invoice_id, status: 'open',
    customer_email: 'hank@roof.test' });
  await api(env, 'POST', `/admin/invoices/${row.id}/sync`, {}, t);
  s.restore();
  assert.equal(db.prepare('SELECT sent_to FROM invoices WHERE id=?').get(row.id).sent_to,
    'hank@roof.test');
});
