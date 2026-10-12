// Concrete stain as its own line, and discounts at their sheet value (Nando, 12 Oct 2026).
// Run: node --experimental-sqlite --test worker/stainsplit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing, CONCRETE_STAIN_NAME } from './pricing.js';
import { quoteLines, TAX_RATE } from './quotelines.js';
import { buildInvoice } from './invoices.js';
import worker from './index.js';

const CFG = { style: 'gable', w: 12, l: 16, h: 8, foundation: 'pad', foundationFinish: 'coated' };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.011, (m || '') + ' ' + a + ' vs ' + b);
const sheet = () => computePricing(CFG).redline;
const stamped = () => Object.assign(sheet(), { cardUplift: 0.03, discountsAtSheet: true });
const legacy = () => Object.assign(sheet(), { cardUplift: 0.03 });

test('the stain is its own $300 line in the pad phase; the pad line is just the pad', () => {
  const rl = sheet();
  assert.equal(rl.foundName, 'Concrete Pad (4" slab)');
  assert.equal(rl.foundSell, 3000); assert.equal(rl.foundPromo, 500);
  assert.equal(rl.finishSellName, CONCRETE_STAIN_NAME); assert.equal(rl.finishSell, 300);
  const f = quoteLines(rl, []).rows.find((r) => r.kind === 'foundation');
  assert.match(f.label, /Concrete Foundation$/);
  assert.deepEqual(f.regularSubLines.map((s) => [s.label, s.amt]), [['Concrete Pad (4" slab)', 3500], [CONCRETE_STAIN_NAME, 300]]);
  near(f.amt, 3300);
});

test('a staff pad price replaces the pad only: the stain stays, the promo still comes off the pad', () => {
  const rl = sheet();
  const bd = quoteLines(rl, [{ kind: 'override', item: rl.foundName, amount: 4500, note: 'Pad over 175 sq ft' }]);
  const f = bd.rows.find((r) => r.kind === 'foundation');
  near(f.amt, 4500 - 500 + 300, 'pad 4,500 less promo plus stain');
  assert.deepEqual(f.regularSubLines.map((s) => s.amt), [4500, 300]);
  assert.ok(bd.discounts.some((d) => d.kind === 'promo' && d.amt === 500));
});

test('card quote: regular lines marked up 3%, promo at -$500; cash = sheet less promo', () => {
  const bd = quoteLines(stamped(), []);
  const f = bd.rows.find((r) => r.kind === 'foundation');
  assert.deepEqual(f.regularSubLines.map((s) => Math.round(s.amt * 100) / 100), [3605, 309]);
  const promo = bd.discounts.find((d) => d.kind === 'promo');
  assert.equal(promo.amt, 500);
  const base = quoteLines(sheet(), []);
  near(bd.adjustedSubtotal, (base.adjustedSubtotal + 500) * 1.03 - 500, 'card subtotal');
  near(bd.cashDiscount.cashTotal, base.total, 'cash total is the sheet total');
  near(bd.total - bd.cashDiscount.amount, base.total);
  near(bd.total / (1 + bd.cashDiscount.uplift), base.total, 'effective uplift');
});

test('staff discounts and price cuts are at what was typed; charges are marked up', () => {
  const rl = stamped();
  const bd = quoteLines(rl, [{ kind: 'amount', value: -250, note: 'Loyalty' }, { kind: 'amount', value: 100, note: 'Extra outlet' },
                             { kind: 'override', item: rl.foundName, amount: 3200, note: 'Small pad' }]);
  assert.equal(bd.discounts.find((d) => d.label === 'Loyalty').amt, 250);
  assert.equal(bd.discounts.find((d) => d.kind === 'override').amt, 300, 'cut 3,500 -> 3,200 reads $300');
  near(bd.charges.find((c) => c.label === 'Extra outlet').amt, 103);
  const inv = buildInvoice(bd, 'balance', [], { adjustments: [{ kind: 'amount', value: -250, note: 'Loyalty' }, { kind: 'amount', value: 100, note: 'Extra outlet' }] });
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  assert.ok(inv.lines.some((l) => l.amountCents === -25000), 'loyalty billed at -$250.00');
});

test('stored (legacy) quotes keep the uniform markup: promo -$515', () => {
  const bd = quoteLines(legacy(), []);
  near(bd.discounts.find((d) => d.kind === 'promo').amt, 515);
  near(bd.cashDiscount.cashTotal, bd.total / 1.03);
});

/* ---- grandfathering through the worker ---- */
function makeD1(db){function shape(q){const isSel=/^\s*(select|pragma|with)/i.test(q);return(a)=>({first(){const s=db.prepare(q);return isSel?(s.get(...a)??null):(s.run(...a),null)},all(){return{results:db.prepare(q).all(...a)}},run(){const s=db.prepare(q);if(isSel)return{results:s.all(...a)};const r=s.run(...a);return{meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}}})}return{prepare(q){const m=shape(q);return{...m([]),bind:(...a)=>m(a)}},async batch(st){return st.map(s=>s.run())}}}
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, name TEXT, email TEXT, phone TEXT, details TEXT, status TEXT, created_at TEXT, adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, effective_price REAL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE pricing_config (id INTEGER PRIMARY KEY, data TEXT, updated_at TEXT);`);
  db.prepare("INSERT INTO pricing_config (id,data,updated_at) VALUES (1,?,?)").run(JSON.stringify({ SELL: { cashDiscount: { enabled: 1, percent: 3 } } }), '2026-10-09');
  db.prepare("INSERT INTO customers (id,name,email) VALUES (32,'Lee','lee@x.test'),(40,'New','new@x.test')").run();
  const add = db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (?,?,?,?,?,?)");
  add.run(32, 'Lee', 'lee@x.test', JSON.stringify({ config: CFG, redline: legacy(), quotedPrice: 1 }), 'new', '2026-10-12');
  add.run(40, 'New', 'new@x.test', JSON.stringify({ config: CFG, redline: sheet(), quotedPrice: 1 }), 'new', '2026-10-12');
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}
async function call(env, m, p, b, t) {
  const h = { 'Content-Type': 'application/json', Origin: 'https://www.shedpro-utah.com', 'User-Agent': 'test' };
  if (t) h.Authorization = 'Bearer ' + t;
  const r = await worker.fetch(new Request('https://x' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
const rlOf = (db, id) => JSON.parse(db.prepare('SELECT details FROM submissions WHERE id=?').get(id).details).redline;

test('a redone estimate for a customer quoted the old way keeps the -$515 promo; others get -$500', async () => {
  const { db, env } = setup();
  const t = (await call(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
  assert.equal((await call(env, 'POST', '/admin/submissions/1/design', { config: CFG }, t)).status, 200);
  assert.equal((await call(env, 'POST', '/admin/submissions/2/design', { config: CFG }, t)).status, 200);
  const lee = rlOf(db, 1), other = rlOf(db, 2);
  assert.ok(!lee.discountsAtSheet && lee.cardUplift === 0.03, 'Lee stays on the old treatment');
  assert.ok(other.discountsAtSheet, 'everyone else gets sheet-value discounts');
  near(quoteLines(lee, []).discounts.find((d) => d.kind === 'promo').amt, 515);
  assert.equal(quoteLines(other, []).discounts.find((d) => d.kind === 'promo').amt, 500);
  /* A brand-new submission from Lee too. */
  await call(env, 'POST', '/shed/submit', { contact: { name: 'Lee', email: 'lee@x.test', phone: '5550100' }, config: CFG });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions WHERE customer_id=32').get().n, 2, 'submission stored');
  const last = db.prepare("SELECT details FROM submissions WHERE customer_id=32 ORDER BY id DESC").get();
  assert.ok(!JSON.parse(last.details).redline.discountsAtSheet, 'new estimate for Lee keeps -$515');
});
