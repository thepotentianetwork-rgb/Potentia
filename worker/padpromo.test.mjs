/* Nando, 9 Oct 2026: "Make the promo come off whatever pad price I type."
   On a quote that carries the concrete pad promo, a price typed for the pad
   with "Change a line's price" is its REGULAR price; the promo still comes
   off it as its own discount line. Quotes priced before the promo carry no
   foundPromo and are unaffected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing } from './pricing.js';
import { quoteLines, overridePays, padPromoOf, TAX_RATE } from './quotelines.js';
import { buildInvoice, phaseParts } from './invoices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAD = { style: 'gable', w: 12, l: 16, h: 8, foundation: 'pad', foundationFinish: 'plain' };
const toC = (n) => Math.round(n * 100);
const redline = () => computePricing(PAD).redline;
const ovr = (r, amount, note) => ({ kind: 'override', item: r.foundName, amount, note });

test('the #69 case: $4,500 typed, the $500 promo comes off, pad costs $4,000', () => {
  const r = redline();
  assert.equal(r.foundPromo, 500);
  const adj = [{ kind: 'amount', value: 500, note: 'Land clearance' }, { kind: 'travel', days: 5, rate: 80 }, ovr(r, 4500, 'Over 175 sq ft pad')];
  const bd = quoteLines(r, adj);
  const pad = bd.rows.find((x) => x.kind === 'foundation');
  assert.equal(pad.regularAmt, 4500);
  assert.equal(pad.amt, 4000);
  assert.deepEqual(bd.discounts.map((d) => [d.label, d.amt]), [['Concrete pad promo', 500]]);
  assert.ok(!JSON.stringify(bd.discounts).includes('Over 175'), 'a raise gives no reason');
  const plain = quoteLines(r, adj.slice(0, 2));
  assert.equal(toC(bd.adjustedSubtotal), toC(plain.adjustedSubtotal + 1000), 'pad $4,000 against the $3,000 it was');
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: adj });
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  assert.ok(inv.lines.some((l) => l.discount && l.label === 'Concrete pad promo' && l.amountCents === -50000));
  assert.equal(phaseParts(bd).reduce((t, p) => t + p.totalCents, 0), toC(bd.total));
});

test('lowered below regular: the promo and the cut are both discounts; pays typed less promo', () => {
  const r = redline();
  const bd = quoteLines(r, [ovr(r, 3000, 'Site already level')]);
  const pad = bd.rows.find((x) => x.kind === 'foundation');
  assert.equal(pad.amt, 2500);
  assert.equal(pad.regularAmt, 3500);
  assert.deepEqual(bd.discounts.map((d) => [d.kind, d.amt]), [['promo', 500], ['override', 500]]);
});

test('typed below the promo: the promo is never more than the price; nothing negative', () => {
  const r = redline();
  assert.equal(overridePays(300, 500), 0);
  assert.equal(overridePays(4500, 500), 4000);
  const bd = quoteLines(r, [ovr(r, 300, 'Bundle')]);
  assert.ok(!bd.rows.some((x) => x.kind === 'foundation'));
  const free = bd.freeRows[0];
  assert.equal(toC(free.regularAmt), toC(3500));
  assert.equal(toC(free.discounts.reduce((t, d) => t + d.amt, 0)), toC(3500));
});

test('a quote priced before the promo is unaffected: the typed price is what they pay', () => {
  const r = { ...redline() }; delete r.foundPromo; delete r.foundPromoName;
  assert.equal(padPromoOf(r, r.foundName), 0);
  const bd = quoteLines(r, [ovr(r, 4500, 'Over 175 sq ft pad')]);
  const pad = bd.rows.find((x) => x.kind === 'foundation');
  assert.equal(pad.amt, 4500);
  assert.equal(bd.discounts.length, 0);
});

test('only the pad: another line re-priced is not touched by the promo', () => {
  const r = computePricing({ ...PAD, sprinklers: [5, 5] }).redline;
  const item = r.addonLines.find((l) => /Sprinkler/.test(l.name)).name;
  assert.equal(padPromoOf(r, item), 0);
  const bd = quoteLines(r, [{ kind: 'override', item, amount: 900 }]);
  assert.equal(bd.rows[0].amt, 900);
});

test('CRM label: regular price, the new price, and that the promo still applies', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'admin-customer.html'), 'utf8');
  const src = html.match(/function adjLabelFor\(a, compPrices, compPromos\) \{[\s\S]*?\n\}/)[0];
  const ctx = { fmtN: (n) => Math.round(n).toLocaleString('en-US'), travelText: () => '', travelAmt: () => 0 };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const name = 'Concrete Pad (4" slab)';
  assert.equal(ctx.adjLabelFor({ kind: 'override', item: name, amount: 4500 }, { [name]: 3000 }, { [name]: 500 }),
    name + ' \u2014 $3,500 \u2192 $4,500, promo \u2212$500 still applies');
  assert.equal(ctx.adjLabelFor({ kind: 'override', item: name, amount: 4500 }, { [name]: 3000 }, {}),
    name + ' \u2014 $3,000 \u2192 $4,500', 'no promo on the quote: no promo wording');
});
