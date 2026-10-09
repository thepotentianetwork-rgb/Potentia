/* OCTOBER 9 PRICING: the concrete pad promo, sprinkler relocation, and the
 * travel & fuel surcharge.
 *
 *   1. Concrete pad: list $3,500, a $500 promo, $3,000 to pay. The promo is
 *      shown (list struck through, promo as a line) but every total, phase and
 *      deposit is the $3,000 the customer pays, same as before the change.
 *   2. Sprinkler relocation: $300 a head up to 5 ft, +$100 per started 2 ft
 *      past that. Its own site-prep phase, ahead of the pad.
 *   3. Travel & fuel: an adjustment {kind:'travel', days, rate} added in the
 *      CRM. Inside the Shed phase, taxed with it, never discounted by a
 *      percentage.
 *
 * Run: node --experimental-sqlite --test worker/pricingoct9.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing, applyPricingOverrides, sprinklerHeadPrice, sprinklerLineFor, sprinklerFeet,
         concretePromoAmount, SELL, mergedPricingConfig } from './pricing.js';
import { quoteLines, travelAmount, travelLabel, isSitePrep, TAX_RATE } from './quotelines.js';
import { buildInvoice, buildPhaseInvoice, phaseStatus, phaseParts, toCents } from './invoices.js';
import { buildSpecLines } from './buildspec.js';
import worker from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, (msg || '') + ' ' + a + ' vs ' + b);
const PAD = { style: 'gable', w: 10, l: 20, h: 8, foundation: 'pad', foundationFinish: 'plain' };

/* ── 1. CONCRETE ─────────────────────────────────────────────────────── */
test('the pad lists at $3,500 with a $500 promo, and costs $3,000', () => {
  assert.equal(SELL.foundation.pad, 3500);
  assert.equal(SELL.concretePromo.amount, 500);
  const { redline } = computePricing(PAD);
  assert.equal(redline.foundSell, 3000, 'what they pay');
  assert.equal(redline.foundPromo, 500);
  assert.equal(redline.foundList, 3500);
  assert.equal(redline.foundPromoName, 'Concrete pad promo');
});

test('the promo comes off the pad, never the floor finish', () => {
  // 10x20 = 200 sqft enclosed -> broom finish over 175 sqft = $1,000
  const { redline } = computePricing({ ...PAD, foundationFinish: 'broom' });
  assert.equal(redline.foundSell, 3000 + 1000);
  assert.equal(redline.foundList, 3500 + 1000);
  const coated = computePricing({ ...PAD, foundationFinish: 'coated' }).redline;
  assert.equal(coated.foundSell, 3000 + 300);
  assert.equal(coated.foundList, 3800);
});

test('every pad size pays the same $3,000 it paid before (the pad is a flat price)', () => {
  for (const [w, l] of [[6, 6], [8, 8], [8, 16], [10, 20], [12, 24], [16, 32], [26, 34]]) {
    const { redline } = computePricing({ ...PAD, w, l });
    assert.equal(redline.foundSell, 3000, w + 'x' + l);
    assert.equal(redline.foundList, 3500, w + 'x' + l);
  }
});

test('blocks, gravel and existing foundations carry no promo', () => {
  for (const f of ['blocks', 'gravel', 'existing']) {
    const { redline } = computePricing({ ...PAD, w: 8, l: 10, foundation: f });
    assert.equal(redline.foundPromo, 0, f);
    assert.equal(redline.foundList, 0, f);
    assert.equal(redline.foundPromoName, '', f);
  }
});

test('promo set to 0 in Admin Pricing: full list price, no promo line', () => {
  try {
    applyPricingOverrides({ SELL: { concretePromo: { amount: 0 } } });
    const { redline } = computePricing(PAD);
    assert.equal(redline.foundSell, 3500);
    assert.equal(redline.foundPromo, 0);
    const bd = quoteLines(redline, []);
    assert.equal(bd.rows[0].promo, undefined);
  } finally {
    applyPricingOverrides({ SELL: { concretePromo: { amount: 500 } } });
  }
  assert.equal(concretePromoAmount(200), 200, 'never more than the pad');
  assert.equal(concretePromoAmount(0), 0);
});

test('the quote: list struck through, promo line, and the totals on what they pay', () => {
  const { redline } = computePricing(PAD);
  const bd = quoteLines(redline, []);
  const pad = bd.rows.find((r) => r.kind === 'foundation');
  assert.equal(pad.amt, 3000);
  assert.equal(pad.listAmt, 3500);
  assert.deepEqual(pad.promo, { label: 'Concrete pad promo', amt: 500 });
  near(pad.total, 3000 * (1 + TAX_RATE), 'phase total');
  near(pad.deposit, 965.25, '30% deposit on $3,217.50');
  const shed = bd.rows.find((r) => r.kind === 'shed');
  near(bd.subtotal, pad.amt + shed.amt);
});

test('a discount on a promo quote scales the pad phase from $3,000, not $3,500', () => {
  const { redline } = computePricing({ style: 'gable', w: 8, l: 16, h: 8, foundation: 'pad' });
  const bd = quoteLines(redline, [{ kind: 'amount', value: -1000, note: 'Loyal customer price adjustment' }]);
  const pad = bd.rows.find((r) => r.kind === 'foundation');
  const ratio = (bd.subtotal - 1000) / bd.subtotal;
  near(pad.total, 3000 * ratio * (1 + TAX_RATE));
});

test("a quote saved before the promo (no foundPromo) reads exactly as it did", () => {
  const old = { marginPrice: 7000, foundSell: 3000, foundName: 'Concrete Pad (4" slab)', baseSheetLabel: 'A-Frame' };
  const bd = quoteLines(old, []);
  assert.equal(bd.rows[0].amt, 3000);
  assert.equal(bd.rows[0].listAmt, undefined);
  assert.equal(bd.rows[0].promo, undefined);
  near(bd.total, 10000 * (1 + TAX_RATE));
});

/* Discounts go at the END (Nando, 9 Oct 2026): the pad is billed at its list
   price and the promo is its own line after the phases, before tax. */
test('invoices list the pad at list price and the promo last; the amounts are unchanged', () => {
  const { redline } = computePricing(PAD);
  const bd = quoteLines(redline, []);
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: [] });
  const padLine = inv.lines.find((l) => /Concrete Pad/.test(l.label));
  assert.doesNotMatch(padLine.label, /promo/);
  assert.equal(padLine.amountCents, 350000);
  const promo = inv.lines.find((l) => l.label === 'Concrete pad promo');
  assert.equal(promo.amountCents, -50000);
  assert.equal(promo.discount, true);
  const iTax = inv.lines.findIndex((l) => /Sales Tax/.test(l.label));
  assert.ok(inv.lines.indexOf(promo) > inv.lines.indexOf(padLine) && inv.lines.indexOf(promo) < iTax, 'after the phases, before tax');
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  const st = phaseStatus(bd, []);
  const ph = buildPhaseInvoice(bd, [], st.suggested);
  assert.equal(ph.lines[0].label, 'Phase 1: Concrete Pad (4" slab) deposit (30%)');
  assert.equal(ph.lines[0].amountCents, toCents(3500 * (1 + TAX_RATE) * 0.30));
  assert.equal(ph.lines[ph.lines.length - 1].label, 'Discount on Phase 1 deposit (Concrete pad promo)');
  assert.equal(ph.lines.reduce((t, l) => t + l.amountCents, 0), ph.totalCents);
  assert.equal(ph.totalCents, toCents(965.25));
});

/* ── 2. SPRINKLERS ───────────────────────────────────────────────────── */
test('per-head price: $300 to 5 ft, +$100 per started 2 ft', () => {
  const want = { 1: 300, 3: 300, 5: 300, 5.5: 400, 6: 400, 7: 400, 7.1: 500, 8: 500, 9: 500,
                 10: 600, 11: 600, 12: 700, 13: 700, 15: 800, 25: 1300 };
  for (const [ft, p] of Object.entries(want)) assert.equal(sprinklerHeadPrice(Number(ft)), p, ft + ' ft');
  assert.equal(sprinklerHeadPrice(0), 300, 'no distance given = the included distance');
  assert.equal(sprinklerHeadPrice(undefined), 300);
});

test('the line: "Sprinkler Relocation — 3 heads", priced head by head', () => {
  const l = sprinklerLineFor([5, 5, 5]);
  assert.equal(l.name, 'Sprinkler Relocation \u2014 3 heads');
  assert.equal(l.amt, 900);
  assert.equal(sprinklerLineFor([8]).name, 'Sprinkler Relocation \u2014 1 head');
  assert.equal(sprinklerLineFor([5, 7, 9]).amt, 300 + 400 + 500);
  assert.equal(sprinklerLineFor([]), null);
  assert.deepEqual(sprinklerFeet([5, { ft: 8 }, 'x', -2, 200]), [5, 8, 0, 0, 100]);
  assert.equal(sprinklerFeet(new Array(40).fill(5)).length, 20, 'capped at 20 heads');
});

test('rates come from Admin Pricing', () => {
  try {
    applyPricingOverrides({ SELL: { sprinkler: { base: 350, stepAmt: 150 } } });
    assert.equal(sprinklerHeadPrice(5), 350);
    assert.equal(sprinklerHeadPrice(8), 650);
  } finally {
    applyPricingOverrides({ SELL: { sprinkler: { base: 300, stepAmt: 100 } } });
  }
  const m = mergedPricingConfig({});
  assert.deepEqual(m.SELL.sprinkler, { base: 300, includedFt: 5, stepFt: 2, stepAmt: 100 });
  assert.deepEqual(m.SELL.travel, { perDay: 0 });
  assert.deepEqual(m.SELL.concretePromo, { amount: 500 });
});

test('sprinklers add to the quote and sit in their own phase before the pad', () => {
  const base = computePricing(PAD);
  const withS = computePricing({ ...PAD, sprinklers: [5, 5, 8] });
  assert.equal(withS.customer - base.customer, 1100);
  const line = withS.redline.addonLines.find((l) => isSitePrep(l.name));
  assert.equal(line.name, 'Sprinkler Relocation \u2014 3 heads');
  const bd = quoteLines(withS.redline, []);
  assert.equal(bd.rows[0].label, 'Phase 1 \u2014 Sprinkler Relocation \u2014 3 heads');
  assert.equal(bd.rows[0].kind, 'clearance');
  assert.equal(bd.rows[0].amt, 1100);
  assert.equal(bd.rows[1].kind, 'foundation');
  const bd0 = quoteLines(base.redline, []);
  near(bd.rows.find((r) => r.kind === 'shed').amt, bd0.rows.find((r) => r.kind === 'shed').amt, 'not in the Shed phase');
  near(bd.subtotal, withS.customer);
});

test('with a removal it reads "Site Prep"; two removals still read "Site Clearance"', () => {
  const r = computePricing({ ...PAD, sprinklers: [5], addons: { shedRemoval: true } }).redline;
  const row = quoteLines(r, []).rows[0];
  assert.equal(row.label, 'Phase 1 \u2014 Site Prep');
  assert.deepEqual(row.subLines.map((s) => s.label), ['Shed Removal', 'Sprinkler Relocation \u2014 1 head']);
  assert.equal(row.amt, 1300);
  const r2 = computePricing({ ...PAD, addons: { shedRemoval: true, concreteRemoval: true } }).redline;
  assert.equal(quoteLines(r2, []).rows[0].label, 'Phase 1 \u2014 Site Clearance');
});

test('sprinkler relocation can be comped from the CRM', () => {
  const r = computePricing({ ...PAD, sprinklers: [5, 5] }).redline;
  const bd = quoteLines(r, [{ kind: 'comp', item: 'Sprinkler Relocation \u2014 2 heads' }]);
  assert.equal(bd.rows[0].kind, 'foundation', 'the site-prep phase is gone, it is free');
});

test('the crew sheet says how many heads and how far', () => {
  const lines = buildSpecLines({ ...PAD, sprinklers: [5, 8, 12] });
  assert.ok(lines.includes('Sprinkler relocation: 3 heads (up to 5 ft, 8 ft, 12 ft) · estimate, confirm on site'), lines.join(' | '));
  assert.ok(!buildSpecLines(PAD).some((l) => /Sprinkler/.test(l)));
});

/* ── 3. TRAVEL & FUEL ────────────────────────────────────────────────── */
test('travel: days x per day, labelled the way the quote prints it', () => {
  const a = { kind: 'travel', days: 3, rate: 250 };
  assert.equal(travelAmount(a), 750);
  assert.equal(travelLabel(a), 'Travel & fuel surcharge \u2014 3 days \u00d7 $250');
  assert.equal(travelLabel({ days: 1, rate: 175.5 }), 'Travel & fuel surcharge \u2014 1 day \u00d7 $175.5');
  assert.equal(travelAmount({ kind: 'travel', days: 2.5, rate: 200 }), 500);
  assert.equal(travelAmount({ kind: 'travel', days: 3, rate: 0 }), 0);
  assert.equal(travelAmount({ kind: 'amount', value: 500 }), 0);
});

test('travel lands in the Shed phase, is taxed with it, and moves its deposit', () => {
  const { redline } = computePricing(PAD);
  const bd0 = quoteLines(redline, []);
  const bd = quoteLines(redline, [{ kind: 'travel', days: 3, rate: 250 }]);
  const s0 = bd0.rows.find((r) => r.kind === 'shed'), s = bd.rows.find((r) => r.kind === 'shed');
  near(s.amt - s0.amt, 750);
  assert.ok(s.subLines.some((l) => l.label === 'Travel & fuel surcharge \u2014 3 days \u00d7 $250' && l.amt === 750));
  near(bd.subtotal - bd0.subtotal, 750);
  near(bd.tax - bd0.tax, 750 * TAX_RATE);
  near(s.deposit - s0.deposit, 750 * (1 + TAX_RATE) * 0.30);
  near(bd.rows[0].amt, bd0.rows[0].amt, 'the pad phase does not move');
  assert.equal(bd.adjust, 0, 'not an adjustment line: it is billed work');
  assert.equal(bd.travel, 750);
});

test('a percentage is never taken off the travel surcharge', () => {
  const { redline } = computePricing(PAD);
  const bd0 = quoteLines(redline, [{ kind: 'percent', value: -10 }]);
  const bd = quoteLines(redline, [{ kind: 'percent', value: -10 }, { kind: 'travel', days: 2, rate: 300 }]);
  near(bd.percentAdjust, bd0.percentAdjust);
  near(bd.adjustedSubtotal - bd0.adjustedSubtotal, 600);
});

test('phase and deposit invoices carry the travel inside the Shed phase and add up', () => {
  const { redline } = computePricing({ ...PAD, sprinklers: [5] });
  const adj = [{ kind: 'travel', days: 3, rate: 250 }, { kind: 'amount', value: -500, note: 'Fall promo' }];
  const bd = quoteLines(redline, adj);
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: adj });
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  const shedLine = inv.lines.find((l) => /^Phase 3 — Shed/.test(l.label));
  assert.match(shedLine.label, /Travel & fuel surcharge — 3 days × \$250/);
  assert.ok(inv.lines.some((l) => l.label === 'Fall promo' && l.amountCents === -50000));
  assert.ok(!inv.lines.some((l) => /^Travel/.test(l.label)), 'not a separate adjustment line');
  const P = phaseParts(bd);
  assert.equal(P.reduce((t, p) => t + p.totalCents, 0), toCents(bd.total));
});

/* ── through the worker ─────────────────────────────────────────────── */
function makeD1(db) {
  function shape(sql) { const st = db.prepare(sql); const sel = /^\s*(select|pragma)/i.test(sql);
    return (a) => ({ first() { return sel ? (st.get(...a) ?? null) : (st.run(...a), null); },
      all() { return { results: st.all(...a) }; },
      run() { if (sel) return { results: st.all(...a) }; const r = st.run(...a);
              return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; } }); }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((x) => x.run()); } };
}
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')),
              ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k' };
async function call(m, p, b, t) {
  const h = { Origin: 'https://potentianetwork.com' };
  if (b) h['Content-Type'] = 'application/json';
  if (t) h.Authorization = 'Bearer ' + t;
  const res = await worker.fetch(new Request('https://x' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('/shed/quote: the pad tile gets pay, list and promo; sprinklers are priced', async () => {
  const r = await call('POST', '/shed/quote', { config: PAD });
  const f = r.data.optionPrices.foundation;
  assert.equal(f.pad, 3000, 'an older designer reading .pad still shows what they pay');
  assert.equal(f.padList, 3500);
  assert.equal(f.padPromo, 500);
  const sp = r.data.optionPrices.sprinkler;
  assert.equal(sp.byFt[5], 300); assert.equal(sp.byFt[7], 400); assert.equal(sp.byFt[9], 500);
  assert.equal(sp.base, 300); assert.equal(sp.includedFt, 5);
  const r2 = await call('POST', '/shed/quote', { config: { ...PAD, sprinklers: [5, 5, 5] } });
  assert.equal(r2.data.total - r.data.total, 900);
  const r3 = await call('POST', '/shed/quote', { config: { ...PAD, sprinklers: 'lots' } });
  assert.equal(r3.data.total, r.data.total, 'junk is no heads');
});

test('CRM: a travel adjustment is stored, validated and priced into the effective price', async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('T',?,?)").run(now, now);
  const { redline, customer } = computePricing(PAD);
  db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'T','t@x',?,?,?)")
    .run(JSON.stringify({ quotedPrice: customer, config: PAD, redline }), 'won', now);
  const tok = (await call('POST', '/admin/login', { password: 'pw' })).data.token;
  const set = (adj) => call('POST', '/admin/submissions/1/adjustments', { adjustments: adj }, tok);

  let r = await set([{ kind: 'travel', days: 3, rate: 250, note: 'Logan' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.adjustments[0], { kind: 'travel', days: 3, rate: 250, note: 'Logan' });
  near(r.data.effective_price, customer + 750);

  r = await set([{ kind: 'percent', value: -10 }, { kind: 'travel', days: 2, rate: 300 }, { kind: 'amount', value: -100 }]);
  near(r.data.effective_price, customer * 0.9 + 600 - 100, 'percent off the shed only, then travel, then amounts');
  const bd = quoteLines(redline, r.data.adjustments);
  near(bd.adjustedSubtotal, r.data.effective_price, 'the quote and the stored price agree');

  for (const bad of [{ kind: 'travel', days: 0, rate: 200 }, { kind: 'travel', days: 3 },
                     { kind: 'travel', days: 3, rate: -5 }, { kind: 'travel', days: 99, rate: 5 }]) {
    r = await set([bad]);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  r = await set([{ kind: 'travel', days: 1, rate: 100 }, { kind: 'travel', days: 1, rate: 100 }]);
  assert.equal(r.status, 400, 'one per quote');

  r = await call('GET', '/admin/customers/1', null, tok);
  assert.equal(r.data.submissions[0].travel_per_day, 0, 'no default set yet');
});

/* ── staff re-pricing a line (site conditions) ─────────────────────── */
test('override: the pad re-priced for this job moves only the concrete phase', () => {
  const { redline } = computePricing(PAD);
  const bd0 = quoteLines(redline, []);
  const adj = [{ kind: 'override', item: redline.foundName, amount: 3600, note: 'Sloped lot, extra forms' }];
  const bd = quoteLines(redline, adj);
  const pad = bd.rows.find((r) => r.kind === 'foundation');
  assert.equal(pad.amt, 3600);
  /* Raised: just the new price, no trace of the old one (Nando, 9 Oct 2026). */
  assert.equal(pad.override, undefined);
  assert.equal(pad.regularAmt, 3600);
  assert.ok(!bd.discounts.length, 'a raise is not a discount');
  assert.ok(!pad.estimate, 'a price set after seeing the site is not an estimate');
  assert.equal(pad.promo, undefined, 'the staff price replaces the promo arithmetic');
  near(pad.deposit, 3600 * (1 + TAX_RATE) * 0.3);
  near(bd.subtotal - bd0.subtotal, 600);
  near(bd.rows.find((r) => r.kind === 'shed').amt, bd0.rows.find((r) => r.kind === 'shed').amt);
  assert.equal(bd.adjust, 0);
});

test('override: the sprinkler job re-priced, down as well as up', () => {
  const { redline } = computePricing({ ...PAD, sprinklers: [5, 5, 5] });
  const bd = quoteLines(redline, [{ kind: 'override', item: 'Sprinkler Relocation \u2014 3 heads', amount: 650 }]);
  assert.equal(bd.rows[0].kind, 'clearance');
  assert.equal(bd.rows[0].amt, 650);
  /* Lowered: the row at its old price, the cut a discount with the reason. */
  assert.equal(bd.rows[0].regularAmt, 900);
  assert.deepEqual(bd.discounts.filter((d) => d.kind === 'override').map((d) => [d.label, d.amt]), [['Sprinkler Relocation \u2014 3 heads \u2014 price adjusted', 250]]);
  const r2 = computePricing({ ...PAD, sprinklers: [5], addons: { shedRemoval: true } }).redline;
  const row = quoteLines(r2, [{ kind: 'override', item: 'Sprinkler Relocation \u2014 1 head', amount: 450 }]).rows[0];
  assert.equal(row.amt, 1450);
  assert.deepEqual(row.subLines.map((s) => s.amt), [1000, 450], 'the sub-line shows the new price');
  assert.deepEqual(row.regularSubLines.map((s) => s.amt), [1000, 450], 'raised: the customer sees only the new price');
});

test('concrete and sprinkler phases are flagged as estimates; removals alone are not', () => {
  const r = computePricing({ ...PAD, sprinklers: [5] }).redline;
  const bd = quoteLines(r, []);
  assert.equal(bd.rows[0].estimate, true);
  assert.equal(bd.rows[1].estimate, true);
  assert.ok(!bd.rows[2].estimate);
  const r2 = computePricing({ ...PAD, addons: { shedRemoval: true } }).redline;
  assert.equal(quoteLines(r2, []).rows[0].estimate, false);
});

test('CRM: overrides are stored, checked, and priced into the effective price', async () => {
  const tok = (await call('POST', '/admin/login', { password: 'pw' })).data.token;
  const set = (adj) => call('POST', '/admin/submissions/1/adjustments', { adjustments: adj }, tok);
  const { redline, customer } = computePricing(PAD);
  let r = await set([{ kind: 'override', item: redline.foundName, amount: 3400, note: 'Site visit' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  near(r.data.effective_price, customer + 400);
  r = await set([{ kind: 'override', item: redline.foundName, amount: 2800 }, { kind: 'percent', value: -10 }]);
  near(r.data.effective_price, (customer - 200) * 0.9);
  near(quoteLines(redline, r.data.adjustments).adjustedSubtotal, r.data.effective_price, 'quote and stored price agree');
  for (const bad of [[{ kind: 'override', item: 'Gold Taps', amount: 5 }],
                     [{ kind: 'override', item: redline.foundName, amount: -1 }],
                     [{ kind: 'override', item: redline.foundName }],
                     [{ kind: 'comp', item: redline.foundName }, { kind: 'override', item: redline.foundName, amount: 100 }],
                     [{ kind: 'override', item: redline.foundName, amount: 1 }, { kind: 'override', item: redline.foundName, amount: 2 }]]) {
    r = await set(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});
