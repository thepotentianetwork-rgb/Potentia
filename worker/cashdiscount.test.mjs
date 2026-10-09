/* CASH, CHECK & BANK TRANSFER DISCOUNT (Nando, 9 Oct 2026).
 *
 * "Yes build the cash or check or ACH discount. If credit card charge a 3% fee."
 * Done the way card networks allow: a quote priced while the switch is on is
 * at REGULAR (card) prices — today's price x 1.03 — and paying any other way
 * takes the difference back off, so a non-card payer pays exactly today's price.
 *
 * Real worker, SQLite standing in for D1, Stripe stubbed — no key, no network.
 * Run: node --experimental-sqlite --test worker/cashdiscount.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing, cashDiscountSettings, resetConfig, SELL } from './pricing.js';
import { quoteLines, cardUpliftOf, cashDiscountPctLabel, cashDiscountDisclosure } from './quotelines.js';
import { balanceSummary, phaseStatus, cashDiscountCents, manualDiscountCents, paidDiscountCents,
         addCashDiscount, buildInvoice, creditCentsOf } from './invoices.js';
import worker from './index.js';

const c = (n) => Math.round(Number(n) * 100);          // dollars -> cents
const CFG = { style: 'gable', w: 10, l: 16, h: 9, foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted' };
const { redline: TODAY } = computePricing(CFG);
const STAMPED = { ...TODAY, cardUplift: 0.03 };
const BD0 = quoteLines(TODAY, []);
const BD = quoteLines(STAMPED, []);

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

/* Build 7 = quoted BEFORE the switch (no uplift); build 8 = quoted after it. */
function setup(cash, extraSubs = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, stripe_customer_id TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT, status TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, created_at TEXT, effective_price REAL);
           CREATE TABLE pricing_config (id INTEGER PRIMARY KEY, data TEXT, updated_at TEXT);
           CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, amount REAL NOT NULL,
             method TEXT NOT NULL, note TEXT, paid_at TEXT NOT NULL, created_at TEXT NOT NULL, submission_id INTEGER, phase_alloc TEXT);`);
  db.prepare("INSERT INTO customers (id,name,email,phone) VALUES (1,'Demo','demo@example.test','5550100')").run();
  const add = db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (?,?,?,?,?)");
  add.run(7, 1, JSON.stringify({ config: CFG, redline: TODAY }), 'won', '2026-09-01');
  add.run(8, 1, JSON.stringify({ config: CFG, redline: STAMPED }), 'won', '2026-10-10');
  extraSubs.forEach(([id, rl]) => add.run(id, 1, JSON.stringify({ config: CFG, redline: rl }), 'won', '2026-10-10'));
  db.prepare("INSERT INTO pricing_config (id,data,updated_at) VALUES (1,?,?)")
    .run(JSON.stringify({ SELL: { cashDiscount: cash } }), '2026-10-09');
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k', STRIPE_SECRET_KEY: 'sk_test_fake' } };
}
let PAID = 0;
function stubStripe() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const method = (init && init.method) || 'GET';
    calls.push({ path: p, method, params: Object.fromEntries(new URLSearchParams((init && init.body) || '')) });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ id: 'in_x', status: 'paid', amount_paid: PAID }) };
    const id = p === '/v1/customers' ? 'cus_new' : p.includes('invoiceitems') ? 'ii_1' : 'in_' + calls.length;
    return { ok: true, status: 200, json: async () => ({ id, status: 'open', hosted_invoice_url: 'https://pay.stripe/x' }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json', Origin: 'https://www.shedpro-utah.com' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
const token = async (env) => (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
const ON = { enabled: 1, percent: 3 }, OFF = { enabled: 0, percent: 3 };
const pays = (db, sub) => db.prepare('SELECT amount, discount_amount, method, note, phase_alloc FROM payments WHERE submission_id = ? ORDER BY id').all(sub);
const summary = (db, sub, bd) => balanceSummary(bd, pays(db, sub));
async function sendAndPay(env, db, t, body) {
  let s = stubStripe(); let r;
  try { r = await api(env, 'POST', '/admin/invoices', body, t); } finally { s.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  PAID = c(r.data.amount);
  const row = db.prepare('SELECT id FROM invoices ORDER BY id DESC').get();
  s = stubStripe();
  try { await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t); } finally { s.restore(); }
  return { r, s };
}

/* ── the math ─────────────────────────────────────────────────────────── */
test('the $10,000 job: card pays $10,300.00, cash / check / ACH pays $10,000.00', () => {
  const regular = 1030000;                                   // $10,300.00 regular (card) price
  assert.equal(cashDiscountCents(regular, 0.03), 30000);      // $300.00 discount
  assert.equal(regular - cashDiscountCents(regular, 0.03), 1000000);
  assert.equal(manualDiscountCents(1000000, 0.03, regular), 30000);   // a $10,000 check settles it
  assert.equal(cashDiscountPctLabel(0.03), '2.9');            // $300 of $10,300 is 2.9%, not 3%
  assert.match(cashDiscountDisclosure(0.03, 300), /^Prices shown are our regular prices\. Pay by cash, check, cashier.s check or bank transfer \(ACH\) and save 2\.9% \(\$300\.00\)\.$/);
});

test('settings: off by default; percent held to 0..10; junk is off', () => {
  resetConfig();
  assert.deepEqual(cashDiscountSettings(), { enabled: false, percent: 3, uplift: 0 });
  SELL.cashDiscount = { enabled: 1, percent: 3 };   assert.equal(cashDiscountSettings().uplift, 0.03);
  SELL.cashDiscount = { enabled: 1, percent: 40 };  assert.equal(cashDiscountSettings().percent, 10);
  SELL.cashDiscount = { enabled: 'yes', percent: 3 }; assert.equal(cashDiscountSettings().enabled, false);
  SELL.cashDiscount = { enabled: 1, percent: 0 };   assert.equal(cashDiscountSettings().enabled, false);
  resetConfig();
});

test('a quote priced before the switch is untouched: same figures, no cashDiscount', () => {
  assert.equal(cardUpliftOf(TODAY), 0);
  assert.equal(BD0.cashDiscount, undefined);
  assert.deepEqual(quoteLines(JSON.parse(JSON.stringify(TODAY)), []), BD0);
});

test('a regular-price quote: every figure x1.03, and the cash total is exactly today\'s', () => {
  const k = 1.03;
  assert.ok(Math.abs(BD.total - BD0.total * k) < 1e-6);
  assert.ok(Math.abs(BD.depositTotal - BD0.depositTotal * k) < 1e-6);
  assert.ok(Math.abs(BD.tax - BD0.tax * k) < 1e-6);
  BD.rows.forEach((r, i) => {
    assert.ok(Math.abs(r.amt - BD0.rows[i].amt * k) < 1e-6);
    assert.ok(Math.abs(r.deposit - BD0.rows[i].deposit * k) < 1e-6);
    (r.subLines || []).forEach((s, j) => assert.ok(Math.abs(s.amt - BD0.rows[i].subLines[j].amt * k) < 1e-6));
  });
  assert.equal(c(BD.cashDiscount.cashTotal), c(BD0.total));
  assert.equal(c(BD.cashDiscount.amount), c(BD.total) - c(BD0.total));
  assert.equal(BD.cashDiscount.percentLabel, '2.9');
});

test('adjustments on a regular-price quote scale with it, so the cash total is still today\'s', () => {
  const adj = [{ kind: 'amount', value: -1000, note: 'Loyal customer' }, { kind: 'percent', value: -5, note: 'Promo' }];
  const a0 = quoteLines(TODAY, adj), a1 = quoteLines(STAMPED, adj);
  assert.equal(c(a1.cashDiscount.cashTotal), c(a0.total));
  const inv = buildInvoice(a1, 'balance', [], { adjustments: adj });
  const loyal = inv.lines.find((l) => l.label === 'Loyal customer');
  assert.equal(loyal.amountCents, -103000, 'a typed -$1,000 reads -$1,030 at regular price');
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
});

test('library: ACH bill, partial payment proration, manual cap', () => {
  const inv = buildInvoice(BD, 'deposit', []);
  const ach = addCashDiscount(inv, () => 0.03, 8);
  assert.equal(ach.discountCents, Math.round(inv.totalCents * 0.03 / 1.03));
  assert.equal(ach.totalCents, inv.totalCents - ach.discountCents);
  assert.equal(ach.lines.reduce((t, l) => t + l.amountCents, 0), ach.totalCents);
  assert.equal(addCashDiscount(inv, () => 0, 7), null, 'no uplift, no ACH version');
  assert.equal(paidDiscountCents(ach.totalCents, ach.totalCents, ach.discountCents), ach.discountCents);
  assert.equal(paidDiscountCents(Math.round(ach.totalCents / 2), ach.totalCents, ach.discountCents), Math.round(ach.discountCents / 2));
  assert.equal(manualDiscountCents(500000, 0.03, 300000), 0, 'never more than the job: overpaying earns nothing');
  assert.equal(manualDiscountCents(100000, 0.03, 102000), 2000, 'capped at what is left beyond the payment');
});

/* ── designer / quote endpoint ───────────────────────────────────────── */
test('/shed/quote: off = exactly as today; on = regular prices, scaled tiles, disclosure', async () => {
  const off = setup(OFF), on = setup(ON);
  const a = await api(off.env, 'POST', '/shed/quote', { config: CFG });
  const b = await api(on.env, 'POST', '/shed/quote', { config: CFG });
  assert.equal(a.data.cashDiscount, undefined);
  assert.ok(Math.abs(b.data.total - a.data.total * 1.03) < 0.01);
  assert.ok(Math.abs(b.data.cashDiscount.cashTotal - a.data.total) < 0.01);
  assert.equal(b.data.cashDiscount.percentLabel, '2.9');
  assert.match(b.data.cashDiscount.disclosure, /^Prices shown are our regular prices\./);
  const w = Object.keys(a.data.optionPrices.windows)[0];
  assert.equal(b.data.optionPrices.windows[w], Math.round(a.data.optionPrices.windows[w] * 103) / 100);
  assert.deepEqual(b.data.optionPrices.limits, a.data.optionPrices.limits, 'sizes are not money');
  assert.equal(b.data.optionPrices.flooring.areaSqft, a.data.optionPrices.flooring.areaSqft);
  const t = await token(on.env);
  const r = await api(on.env, 'POST', '/shed/quote?redline=1', { config: CFG }, t);
  assert.equal(r.data.redline.cardUplift, 0.03, 'a quote priced now is stamped');
});

/* ── existing quotes ─────────────────────────────────────────────────── */
test('existing quote (#7) with the switch ON: one bill, both methods, same amount; checks earn nothing', async () => {
  const { env, db } = setup(ON);
  const t = await token(env);
  const p = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'balance', preview: true, pay_by: 'bank' }, t);
  assert.equal(p.data.cash_discount, null); assert.equal(p.data.pay_by, null);
  assert.deepEqual(p.data.payment_methods, ['us_bank_account', 'card']);
  assert.equal(c(p.data.amount), c(BD0.total));
  await api(env, 'POST', '/admin/customers/1/payments', { amount: 1000, method: 'check', submission_id: 7 }, t);
  assert.equal(pays(db, 7)[0].discount_amount, null);
});

/* ── regular-price job: Stripe bills ─────────────────────────────────── */
test('regular-price job, ACH bill (default): discount line, ACH only, sums exactly', async () => {
  const { env } = setup(OFF);       // the BUILD decides, not today's switch
  const t = await token(env); const s = stubStripe();
  try {
    const p = await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit', preview: true }, t);
    assert.equal(s.calls.length, 0, 'preview never calls Stripe');
    assert.equal(p.data.pay_by, 'bank');
    assert.deepEqual(p.data.payment_methods, ['us_bank_account']);
    const cd = p.data.cash_discount;
    assert.equal(c(cd.amount_card), c(BD.depositTotal));
    assert.equal(c(cd.amount_bank), c(BD.depositTotal) - c(cd.discount));
    assert.equal(c(cd.amount_bank), c(BD0.depositTotal), 'ACH deposit = today\'s deposit');
    assert.match(cd.lines_bank.at(-1).label, /^Cash, check & bank transfer discount \(2\.9%\)/);
    assert.equal(cd.lines_bank.reduce((t2, l) => t2 + c(l.amount), 0), c(cd.amount_bank));
    assert.match(p.data.footer, /bank transfer \(ACH\) and includes our 2\.9% cash, check & bank transfer discount/);
  } finally { s.restore(); }
});

test('regular-price job, card bill: regular price, card only, no discount line, disclosure in footer', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env); const s = stubStripe();
  try {
    const r = await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit', pay_by: 'card' }, t);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(c(r.data.amount), c(BD.depositTotal));
    const inv = s.calls.find((x) => x.path === '/v1/invoices');
    assert.equal(inv.params['payment_settings[payment_method_types][0]'], 'card');
    assert.equal(inv.params['payment_settings[payment_method_types][1]'], undefined);
    assert.match(inv.params.footer, /^Prices shown are our regular prices\. This bill is for payment by card\./);
    assert.ok(!s.calls.some((x) => /discount/i.test(x.params.description || '') && x.path.includes('invoiceitems')));
    const row = db.prepare('SELECT discount_cents, pay_by FROM invoices').get();
    assert.equal(row.discount_cents, 0); assert.equal(row.pay_by, 'card');
  } finally { s.restore(); }
});

test('ACH deposit paid: money as billed, discount booked beside it, deposit fully covered', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  const { r } = await sendAndPay(env, db, t, { submission_id: 8, kind: 'deposit', pay_by: 'bank' });
  const [p] = pays(db, 8);
  assert.equal(c(p.amount), c(r.data.amount));
  assert.equal(c(p.discount_amount), c(r.data.cash_discount.discount));
  assert.match(p.note, /by bank transfer \(ACH\), with \$[\d,.]+ cash, check & bank transfer discount/);
  const sm = summary(db, 8, BD);
  assert.equal(sm.depositDueCents, 0); assert.equal(sm.overpaidCents, 0);
  assert.equal(sm.paidCents, c(BD0.depositTotal));
  assert.equal(sm.balanceCents, c(BD.total) - c(BD.depositTotal));
  // idempotent: syncing again books nothing more
  const row = db.prepare('SELECT id FROM invoices').get(); const s = stubStripe();
  try { await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t); } finally { s.restore(); }
  assert.equal(pays(db, 8).length, 1);
});

test('a part-paid ACH bill earns that share of the discount', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  let s = stubStripe(); let r;
  try { r = await api(env, 'POST', '/admin/invoices', { submission_id: 8, kind: 'deposit', pay_by: 'bank' }, t); } finally { s.restore(); }
  const billed = c(r.data.amount); PAID = Math.round(billed / 2);
  const row = db.prepare('SELECT id, discount_cents FROM invoices').get();
  s = stubStripe();
  try { await api(env, 'POST', '/admin/invoices/' + row.id + '/sync', {}, t); } finally { s.restore(); }
  const [p] = pays(db, 8);
  assert.equal(c(p.amount), PAID);
  assert.equal(c(p.discount_amount), Math.round(row.discount_cents * PAID / billed));
});

/* ── manual payments ─────────────────────────────────────────────────── */
test('check for the whole cash price: discount applied automatically, job paid in full', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments', { amount: Math.round(BD0.total * 100) / 100, method: 'check', submission_id: 8 }, t);
  assert.equal(r.status, 200);
  const [p] = pays(db, 8);
  assert.equal(c(p.discount_amount), c(BD.total) - c(BD0.total));
  const sm = summary(db, 8, BD);
  assert.equal(sm.paidInFull, true); assert.equal(sm.balanceCents, 0); assert.equal(sm.overpaidCents, 0);
  const bal = await api(env, 'GET', '/admin/customers/1/balances', null, t);
  const b8 = bal.data.builds.find((b) => b.submission_id === 8);
  assert.equal(b8.paid_in_full, true);
  assert.equal(c(b8.payments[0].discount), c(p.discount_amount));
  assert.equal(c(b8.cash_discount.discounts_earned), c(p.discount_amount));
});

test('card typed in the CRM, or staff unticking the box: no discount', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'card', submission_id: 8 }, t);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'check', submission_id: 8, cash_discount: false }, t);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'check' }, t);   // no build picked
  assert.deepEqual(db.prepare('SELECT discount_amount FROM payments ORDER BY id').all().map((x) => x.discount_amount), [null, null, null]);
});

test('editing or placing a typed payment works its discount out again', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  const r = await api(env, 'POST', '/admin/customers/1/payments', { amount: 1000, method: 'check' }, t);
  const id = r.data.id;
  await api(env, 'POST', '/admin/payments/' + id + '/submission', { submission_id: 8 }, t);
  const row = db.prepare('SELECT discount_amount FROM payments WHERE id = ?').get(id);
  assert.equal(c(row.discount_amount), 3000);
  await api(env, 'POST', '/admin/payments/' + id, { amount: 2000 }, t);
  assert.equal(c(db.prepare('SELECT discount_amount FROM payments WHERE id = ?').get(id).discount_amount), 6000);
  await api(env, 'POST', '/admin/payments/' + id, { method: 'card' }, t);
  assert.equal(db.prepare('SELECT discount_amount FROM payments WHERE id = ?').get(id).discount_amount, null);
});

/* ── mixed payments ──────────────────────────────────────────────────── */
test('MIXED: deposit by check, balance by card — discount only on the check\'s part', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  const cashDeposit = c(BD0.depositTotal);                     // what they write the check for
  await api(env, 'POST', '/admin/customers/1/payments', { amount: cashDeposit / 100, method: 'check', submission_id: 8 }, t);
  const [chk] = pays(db, 8);
  assert.equal(c(chk.amount) + c(chk.discount_amount), c(BD.depositTotal), 'the check covers the regular deposit');
  let sm = summary(db, 8, BD);
  assert.equal(sm.depositDueCents, 0);
  const { r } = await sendAndPay(env, db, t, { submission_id: 8, kind: 'balance', pay_by: 'card' });
  assert.equal(c(r.data.amount), c(BD.total) - c(BD.depositTotal), 'card pays the rest at the regular price');
  assert.ok(!r.data.lines.some((l) => /bank transfer discount \(/.test(l.label)), 'no ACH discount on a card bill');
  assert.ok(r.data.lines.some((l) => /discount on that payment/.test(l.label)), 'the check\'s earned discount is shown');
  sm = summary(db, 8, BD);
  assert.equal(sm.paidInFull, true); assert.equal(sm.overpaidCents, 0);
  // what they paid in money: today's deposit + the rest at x1.03
  assert.equal(sm.paidCents, cashDeposit + (c(BD.total) - c(BD.depositTotal)));
  assert.ok(sm.paidCents > c(BD0.total) && sm.paidCents < c(BD.total));
});

test('MIXED by phase: phase 1 deposit by ACH, then the next step by card; phases stay whole', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  await sendAndPay(env, db, t, { submission_id: 8, kind: 'phase', parts: [{ phase: 1, part: 'deposit' }], pay_by: 'bank' });
  let ps = phaseStatus(BD, pays(db, 8), []);
  assert.equal(ps.phases[0].deposit.remainingCents, 0, 'ACH money + discount covers the regular phase-1 deposit');
  assert.equal(ps.overpaidCents, 0);
  const step = ps.suggested;
  const { r } = await sendAndPay(env, db, t, { submission_id: 8, kind: 'phase', parts: step, pay_by: 'card' });
  assert.equal(r.data.pay_by, 'card');
  ps = phaseStatus(BD, pays(db, 8), []);
  step.forEach((x) => {
    const ph = ps.phases.find((p) => p.phase === x.phase);
    assert.equal(ph[x.part].remainingCents, 0);
  });
  assert.equal(ps.overpaidCents, 0);
  const [ach, card] = pays(db, 8);
  assert.ok(Number(ach.discount_amount) > 0); assert.equal(card.discount_amount, null);
});

test('MIXED builds on one combined bill: only the regular-price build earns the ACH discount', async () => {
  const { env, db } = setup(OFF);
  const t = await token(env);
  const p = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', builds: [7, 8],
    parts: [{ phase: 1, part: 'deposit' }], preview: true }, t);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const want = Math.round(c(BD.rows[0].deposit) * 0.03 / 1.03);
  assert.equal(c(p.data.cash_discount.discount), want, 'discount on build 8\'s part only');
  const { r } = await sendAndPay(env, db, t, { submission_id: 7, kind: 'phase', builds: [7, 8], parts: [{ phase: 1, part: 'deposit' }], pay_by: 'bank' });
  assert.equal(c(r.data.discount), want);
  assert.equal(pays(db, 7)[0].discount_amount, null);
  assert.equal(c(pays(db, 8)[0].discount_amount), want);
  assert.equal(phaseStatus(BD0, pays(db, 7), []).phases[0].deposit.remainingCents, 0);
  assert.equal(phaseStatus(BD, pays(db, 8), []).phases[0].deposit.remainingCents, 0);
});

test('credit of a payment = money + discount; a plain payment is just its amount', () => {
  assert.equal(creditCentsOf({ amount: 3000, discount_amount: 90 }), 309000);
  assert.equal(creditCentsOf({ amount: 3000 }), 300000);
});
