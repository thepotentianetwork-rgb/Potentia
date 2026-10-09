/* CREDIT CARD SURCHARGE ON STRIPE BILLS (Nando, 9 Oct 2026).
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

test('settings: off by default, capped at 3, junk is off', () => {
  resetConfig();
  assert.deepEqual(cardFeeSettings(), { enabled: false, percent: 3, rate: 0 });
  SELL.cardFee = { enabled: 1, percent: 2.5 }; assert.equal(cardFeeSettings().rate, 0.025);
  SELL.cardFee = { enabled: 1, percent: 9 };   assert.equal(cardFeeSettings().percent, 3);
  SELL.cardFee = { enabled: 'yes', percent: 3 }; assert.equal(cardFeeSettings().enabled, false);
  SELL.cardFee = { enabled: 1, percent: 0 };   assert.equal(cardFeeSettings().enabled, false);
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
test('surcharge OFF: preview and Stripe exactly as before', async () => {
  const { env } = setup({ enabled: 0, percent: 3 });
  const t = await token(env); const s = stubStripe();
  try {
    const p = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', preview: true, pay_by: 'card' }, t);
    assert.equal(p.data.card_fee, null); assert.equal(p.data.fee, 0); assert.equal(p.data.pay_by, null);
    assert.equal(p.data.amount, Math.round(BD.depositTotal * 100) / 100);
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', pay_by: 'card' }, t);
    assert.equal(r.status, 200);
    const inv = s.calls.find((c) => c.path === '/v1/invoices');
    assert.equal(inv.params['payment_settings[payment_method_types][0]'], 'us_bank_account');
    assert.equal(inv.params['payment_settings[payment_method_types][1]'], 'card');
    assert.ok(!s.calls.some((c) => /surcharge/.test(c.params.description || '')));
  } finally { s.restore(); }
});

test('surcharge ON: preview offers both bills; the default is bank with no fee', async () => {
  const { env } = setup(ON);
  const t = await token(env); const s = stubStripe();
  try {
    const p = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', preview: true }, t);
    assert.equal(s.calls.length, 0, 'preview never calls Stripe');
    assert.equal(p.data.pay_by, 'bank'); assert.equal(p.data.fee, 0);
    assert.deepEqual(p.data.payment_methods, ['us_bank_account']);
    const base = p.data.card_fee.amount_without_fee;
    assert.equal(p.data.amount, base);
    assert.equal(p.data.card_fee.fee, Math.round(base * 3) / 100);
    assert.equal(p.data.card_fee.amount_with_fee, Math.round((base + p.data.card_fee.fee) * 100) / 100);
    assert.ok(p.data.card_fee.lines_with_fee.at(-1).fee);
    assert.match(p.data.footer, /bank transfer \(ACH\) with no fee/);
  } finally { s.restore(); }
});

test('surcharge ON, card bill: card only, fee line sent to Stripe, fee stored', async () => {
  const { env, db } = setup(ON);
  const t = await token(env); const s = stubStripe();
  try {
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', pay_by: 'card' }, t);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const inv = s.calls.find((c) => c.path === '/v1/invoices');
    assert.equal(inv.params['payment_settings[payment_method_types][0]'], 'card');
    assert.equal(inv.params['payment_settings[payment_method_types][1]'], undefined);
    assert.equal(inv.params['automatic_tax[enabled]'], 'false', 'no Stripe tax on top');
    const items = s.calls.filter((c) => c.path === '/v1/invoiceitems');
    const feeItem = items.at(-1);
    assert.match(feeItem.params.description, /^Credit card surcharge \(3%\)/);
    const sum = items.reduce((t2, c) => t2 + Number(c.params.amount), 0);
    const row = db.prepare('SELECT amount, fee_cents FROM invoices').get();
    assert.equal(sum, Math.round(row.amount * 100), 'Stripe items add up to what we stored');
    assert.equal(Number(feeItem.params.amount), row.fee_cents);
    assert.equal(row.fee_cents, Math.round(BD.depositTotal * 100 * 0.03));
  } finally { s.restore(); }
});

test('card bill paid: the build is credited the pre-fee amount; the fee is kept apart', async () => {
  const { env, db } = setup(ON);
  const t = await token(env); let s = stubStripe();
  let total;
  try {
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit', pay_by: 'card' }, t);
    total = Math.round(r.data.amount * 100);
  } finally { s.restore(); }
  s = stubStripe(() => ({ ok: true, status: 200, json: async () => ({ id: 'in_1', status: 'paid', amount_paid: total, hosted_invoice_url: 'x' }) }));
  try {
    const row = db.prepare('SELECT id, fee_cents FROM invoices').get();
    const sync = await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t);
    assert.equal(sync.data.status, 'paid', JSON.stringify(sync.data));
    const pays = db.prepare('SELECT amount, method, note FROM payments').all();
    assert.equal(pays.length, 1);
    assert.equal(Math.round(pays[0].amount * 100), total - row.fee_cents, 'only the deposit itself is credited');
    assert.equal(Math.round(pays[0].amount * 100), Math.round(BD.depositTotal * 100));
    assert.match(pays[0].note, /card surcharge, kept separately/);
    assert.equal(db.prepare('SELECT fee_paid_cents FROM invoices').get().fee_paid_cents, row.fee_cents);
    /* Balance math: the deposit is covered exactly — not over by the fee. */
    const bal = balanceSummary(BD, pays);
    assert.equal(bal.depositDueCents, 0);
    assert.equal(bal.balanceCents, Math.round(BD.total * 100) - Math.round(BD.depositTotal * 100));
    assert.equal(bal.overpaidCents, 0);
    /* And a second check changes nothing (idempotent). */
    const again = await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1, JSON.stringify(again.data));
  } finally { s.restore(); }
});

test('bank bill paid with the surcharge on: credited in full, no fee', async () => {
  const { env, db } = setup(ON);
  const t = await token(env); let s = stubStripe();
  let total;
  try {
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'deposit' }, t);
    total = Math.round(r.data.amount * 100);
  } finally { s.restore(); }
  s = stubStripe(() => ({ ok: true, status: 200, json: async () => ({ id: 'in_1', status: 'paid', amount_paid: total, hosted_invoice_url: 'x' }) }));
  try {
    const row = db.prepare('SELECT id, fee_cents FROM invoices').get();
    assert.equal(row.fee_cents, 0);
    await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t);
    const p = db.prepare('SELECT amount, note FROM payments').get();
    assert.equal(Math.round(p.amount * 100), total);
    assert.doesNotMatch(p.note, /surcharge/);
  } finally { s.restore(); }
});

test('phase bill by card: the parts are booked pre-fee, so phase status is not overpaid', async () => {
  const { env, db } = setup(ON);
  const t = await token(env); let s = stubStripe();
  let r;
  try {
    r = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', parts: [{ phase: 1, part: 'deposit' }], pay_by: 'card' }, t);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  } finally { s.restore(); }
  const total = Math.round(r.data.amount * 100);
  s = stubStripe(() => ({ ok: true, status: 200, json: async () => ({ id: 'in_1', status: 'paid', amount_paid: total, hosted_invoice_url: 'x' }) }));
  try {
    const row = db.prepare('SELECT id, fee_cents FROM invoices').get();
    await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t);
    const p = db.prepare('SELECT amount FROM payments').get();
    assert.equal(Math.round(p.amount * 100), total - row.fee_cents);
    assert.equal(Math.round(p.amount * 100), Math.round(BD.rows[0].deposit * 100));
  } finally { s.restore(); }
});

test('the quote endpoint carries the disclosure rate only while the surcharge is on', async () => {
  for (const [fee, want] of [[ON, 3], [{ enabled: 0, percent: 3 }, 0]]) {
    const { env } = setup(fee);
    const t = await token(env);
    const r = await api(env, 'GET', '/admin/submissions/7', null, t);
    assert.equal(r.data.submission.card_fee_percent, want);
  }
});
