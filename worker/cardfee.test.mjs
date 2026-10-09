/* CREDIT CARD SURCHARGE ON STRIPE BILLS (Nando, 9 Oct 2026) — RETIRED.
 *
 * Stripe-hosted invoices cannot surcharge, so the switch is pinned off in
 * pricing.js (CARD_FEE_AVAILABLE) and the cash discount replaced it
 * (cashdiscount.test.mjs). The library pieces stay and are still checked here;
 * the worker tests now prove that no saved setting can put a fee on a bill.
 *
 * Real worker, SQLite standing in for D1, Stripe stubbed — no key, no network,
 * no real invoice. Covers: the math, bank vs card bills, what Stripe is sent,
 * and that only the pre-fee part of a card payment credits the build.
 *
 * Run: node --experimental-sqlite --test worker/cardfee.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing, cardFeeSettings, setConfig, resetConfig, SELL } from './pricing.js';
import { addCardFee, cardFeeCents, splitFee, cardFeeLabel, buildInvoice, balanceSummary } from './invoices.js';
import { quoteLines } from './quotelines.js';
import { invoiceMethods, STRIPE_PAYMENT_METHODS } from './stripe.js';
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
const BD = quoteLines(redline, []);

function setup(fee) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);
           CREATE TABLE pricing_config (id INTEGER PRIMARY KEY, data TEXT, updated_at TEXT);`);
  db.prepare("INSERT INTO customers (id,name,email,phone) VALUES (1,'Hank','hank@roof.test','4355550000')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,created_at) VALUES (?,?,?,?)")
    .run(7, 1, JSON.stringify({ redline }), '2026-09-01');
  db.prepare("INSERT INTO pricing_config (id,data,updated_at) VALUES (1,?,?)")
    .run(JSON.stringify({ SELL: { cardFee: fee } }), '2026-10-09');
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k',
                      STRIPE_SECRET_KEY: 'sk_test_fake' } };
}
function stubStripe(onGet) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, method: (init && init.method) || 'GET', params: Object.fromEntries(new URLSearchParams((init && init.body) || '')) });
    if ((!init || !init.body) && onGet) return onGet(p);
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
const token = async (env) => (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
const ON = { enabled: 1, percent: 3 };

/* ── the math ─────────────────────────────────────────────────────────── */
test('3% of the amount billed, rounded to the cent; never more than 3%', () => {
  assert.equal(cardFeeCents(100000, 0.03), 3000);
  assert.equal(cardFeeCents(338499, 0.03), 10155);          // $3,384.99 -> $101.55
  assert.equal(cardFeeCents(100000, 0.05), 3000, 'held at the 3% cap');
  assert.equal(cardFeeCents(100000, 0), 0);
  assert.equal(cardFeeLabel(0.03), 'Credit card surcharge (3%) \u2014 not applied to bank transfer (ACH), check or cashier\u2019s check');
});

test('settings: retired — off whatever the saved config says', () => {
  resetConfig();
  assert.deepEqual(cardFeeSettings(), { enabled: false, percent: 3, rate: 0 });
  SELL.cardFee = { enabled: 1, percent: 2.5 }; assert.equal(cardFeeSettings().enabled, false); assert.equal(cardFeeSettings().rate, 0);
  SELL.cardFee = { enabled: 1, percent: 9 };   assert.equal(cardFeeSettings().percent, 3);
  SELL.cardFee = { enabled: 'yes', percent: 3 }; assert.equal(cardFeeSettings().enabled, false);
  resetConfig();
});

test('the fee is its own last line on top of a tax-inclusive bill, and adds up', () => {
  const inv = buildInvoice(BD, 'deposit', []);
  const card = addCardFee(inv, 0.03);
  assert.equal(card.baseCents, inv.totalCents);
  assert.equal(card.feeCents, Math.round(inv.totalCents * 0.03));
  assert.equal(card.totalCents, inv.totalCents + card.feeCents);
  assert.equal(card.lines.reduce((t, l) => t + l.amountCents, 0), card.totalCents, 'lines sum to the total');
  const last = card.lines[card.lines.length - 1];
  assert.ok(last.fee && /Credit card surcharge \(3%\)/.test(last.label));
  assert.equal(inv.lines.length + 1, card.lines.length, 'original untouched');
  assert.match(card.footer, /Debit and prepaid cards cannot be used/);
  assert.ok(card.footer.length <= 500);
});

test('splitting a payment: only the pre-fee part credits the build', () => {
  assert.deepEqual(splitFee(103000, 103000, 3000), { creditCents: 100000, feeCents: 3000 });
  assert.deepEqual(splitFee(51500, 103000, 3000), { creditCents: 50000, feeCents: 1500 }, 'partial pays in proportion');
  assert.deepEqual(splitFee(100000, 100000, 0), { creditCents: 100000, feeCents: 0 }, 'bank bill: all of it');
});

test('payment methods: both when off; one or the other when on', () => {
  assert.deepEqual(invoiceMethods(false, 'card'), STRIPE_PAYMENT_METHODS);
  assert.deepEqual(invoiceMethods(true, 'card'), ['card']);
  assert.deepEqual(invoiceMethods(true, 'bank'), ['us_bank_account']);
  assert.deepEqual(invoiceMethods(true, undefined), ['us_bank_account']);
});

/* ── through the worker ───────────────────────────────────────────────── */
test('a saved "enabled: 1" surcharge never reaches a bill, a payment or the quote', async () => {
  const { env, db } = setup(ON);
  const t = await token(env); const s = stubStripe(() => ({ ok: true, status: 200,
    json: async () => ({ id: 'in_1', status: 'paid', amount_paid: Math.round(BD.depositTotal * 100) }) }));
  try {
    const p = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', preview: true, pay_by: 'card' }, t);
    assert.equal(p.data.card_fee, null); assert.equal(p.data.pay_by, null);
    assert.equal(p.data.amount, Math.round(BD.depositTotal * 100) / 100);
    assert.deepEqual(p.data.payment_methods, STRIPE_PAYMENT_METHODS);
    assert.ok(!p.data.lines.some((l) => /surcharge/i.test(l.label)));
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', pay_by: 'card' }, t);
    assert.equal(r.status, 200);
    const inv = s.calls.find((c) => c.path === '/v1/invoices');
    assert.equal(inv.params['payment_settings[payment_method_types][0]'], 'us_bank_account');
    assert.equal(inv.params['payment_settings[payment_method_types][1]'], 'card');
    assert.ok(!s.calls.some((c) => /surcharge/i.test(JSON.stringify(c.params))));
    assert.equal(db.prepare('SELECT fee_cents FROM invoices').get().fee_cents, 0);
    const q = await api(env, 'GET', '/admin/submissions/7', null, t);
    assert.equal(q.data.submission.card_fee_percent, 0);
  } finally { s.restore(); }
});
