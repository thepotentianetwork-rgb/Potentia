/* Nando, 9 Oct 2026: "If I edit line pricing and up the price, don't show the
   original price just change it. Only when I lower it should it explain why."
   Raised line prices and plain rises show only the new price everywhere;
   lowered line prices are discount lines with the staff's reason. Display
   only: every total, deposit and phase figure is what it was. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { quoteLines, TAX_RATE } from './quotelines.js';
import { buildInvoice, buildPhaseInvoice, phaseParts, buildMemo, buildFooter } from './invoices.js';
import { computePricing } from './pricing.js';

const toC = (n) => Math.round(n * 100);
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAD = { style: 'gable', w: 10, l: 20, h: 8, foundation: 'pad', foundationFinish: 'plain' };
function base() { return computePricing(PAD).redline; }
function loadQuotePage() {
  const html = fs.readFileSync(path.join(HERE, '..', 'quote.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  const el = { innerHTML: '', textContent: '', className: '', style: {}, appendChild() {}, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; } };
  const ctx = { console, URLSearchParams, localStorage: { getItem: () => 't', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: { getElementById: () => el, createElement: () => Object.create(el), querySelector: () => el,
      querySelectorAll: () => [], addEventListener() {} },
    fetch: () => new Promise(() => {}), setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'quotelines.browser.js'), 'utf8'), ctx);
  vm.runInContext(m[1], ctx);
  return ctx;
}
const text = (h) => h.replace(/<[^>]+>/g, '\u00a6').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

test('a raised line price: the row is simply the new price, no old figure, no discount', () => {
  const r = base();
  const up = quoteLines(r, [{ kind: 'override', item: r.foundName, amount: 3900, note: 'Sloped lot' }]);
  const pad = up.rows.find((x) => x.kind === 'foundation');
  assert.equal(pad.regularAmt, 3900);
  assert.equal(pad.override, undefined);
  assert.equal(up.discounts.length, 0);
  assert.ok(!JSON.stringify(up).includes('Sloped lot'), 'the reason for a raise is not shown anywhere');
});

test('a lowered line price: shown at its old price with a discount line giving the reason', () => {
  const r = base();
  const was = quoteLines(r, []).rows.find((x) => x.kind === 'foundation');
  const bd = quoteLines(r, [{ kind: 'override', item: r.foundName, amount: 2400, note: 'Site already level' }]);
  const pad = bd.rows.find((x) => x.kind === 'foundation');
  assert.equal(pad.amt, 2400);
  const d = bd.discounts.find((x) => x.kind === 'override');
  assert.equal(d.label, r.foundName + ' \u2014 Site already level');
  assert.equal(toC(pad.regularAmt), toC(2400 + d.amt));
  assert.equal(toC(d.amt), toC(Number(r.foundSell) - 2400));
  assert.ok(was);
  // it counts in "You save"
  assert.equal(toC(bd.savings), toC(bd.discountTotal * (1 + TAX_RATE)));
});

test('a line lowered to zero is still shown at its price, with the cut among the discounts', () => {
  const r = base();
  const bd = quoteLines(r, [{ kind: 'override', item: r.foundName, amount: 0, note: 'Bundle deal' }]);
  assert.ok(!bd.rows.some((x) => x.kind === 'foundation'));
  assert.equal(bd.freeRows.length, 1);
  assert.equal(bd.discounts[0].label, r.foundName + ' \u2014 Bundle deal');
});

test('a plain rise (no note) is folded into the phases; a noted extra keeps its line', () => {
  const r = base();
  for (const adj of [[{ kind: 'percent', value: 7 }], [{ kind: 'amount', value: 333.33 }], [{ kind: 'amount', value: 500, note: 'Rush build' }, { kind: 'percent', value: 3 }]]) {
    const bd = quoteLines(r, adj); const b0 = quoteLines(r, []);
    const fold = bd.rows.reduce((t, x) => t + toC(x.foldAmt), 0);
    const chargeC = bd.charges.reduce((t, c) => t + toC(c.amt), 0);
    assert.ok(Math.abs(fold + chargeC - toC(bd.adjustedSubtotal - b0.adjustedSubtotal)) <= 1, 'within a rounding cent');
    assert.equal(toC(bd.regularSubtotal + bd.charges.reduce((t, c) => t + c.amt, 0) - bd.discountTotal), toC(bd.adjustedSubtotal));
    assert.ok(!bd.charges.some((c) => /^Adjustment/.test(c.label)));
  }
  assert.deepEqual(quoteLines(r, [{ kind: 'amount', value: 500, note: 'Rush build' }]).charges.map((c) => c.label), ['Rush build']);
  /* the items inside a phase still add up to it, at the new prices */
  const bd = quoteLines(r, [{ kind: 'percent', value: 4.5 }]);
  const shed = bd.rows.find((x) => x.kind === 'shed'), s0 = quoteLines(r, []).rows.find((x) => x.kind === 'shed');
  assert.equal(toC(shed.regularSubLines.reduce((t, l) => t + l.amt, 0)), toC(shed.regularAmt));
  assert.equal(toC(s0.regularSubLines.reduce((t, l) => t + l.amt, 0)), toC(s0.regularAmt));
  shed.regularSubLines.forEach((l, i) => assert.ok(l.amt > s0.regularSubLines[i].amt));
});

test('invoices: a rise has no line of its own; a lowered price is a discount line; totals unchanged', () => {
  const r = base();
  const adj = [{ kind: 'percent', value: 5 }, { kind: 'override', item: r.foundName, amount: 2500, note: 'Site already level' }];
  const bd = quoteLines(r, adj);
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: adj });
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  assert.ok(!inv.lines.some((l) => /Adjustment|\(5%\)/.test(l.label)), inv.lines.map((l) => l.label).join(' | '));
  const disc = inv.lines.filter((l) => l.discount);
  assert.deepEqual(disc.map((l) => l.label), [r.foundName + ' \u2014 Site already level']);
  const tax = inv.lines.findIndex((l) => /Sales Tax/.test(l.label));
  assert.ok(inv.lines.indexOf(disc[0]) < tax);
  const bal = buildInvoice(bd, 'balance', [], { adjustments: adj });
  assert.equal(bal.totalCents, toC(bd.total));
  assert.ok(!/Adjustment/.test(buildMemo(bd)));
  phaseParts(bd).forEach((p) => {
    const pi = buildPhaseInvoice(bd, [], [{ phase: p.phase, part: 'deposit' }], {});
    assert.equal(pi.totalCents, p.depositCents);
  });
});

test('quote page: a raise reads only the new price; a cut is explained in the Discounts section', () => {
  const page = loadQuotePage();
  const r = base();
  page.ADJUSTMENTS = [{ kind: 'override', item: r.foundName, amount: 3900, note: 'Sloped lot' }, { kind: 'percent', value: 4 }];
  let bd = page.taxBreakdown(r);
  let t = text(page.buildBreakdown(bd)) + text(page.priceBox(bd, bd.total));
  assert.doesNotMatch(t, /Sloped lot|Price set|Before|Adjust|Discounts|price-was/);
  page.ADJUSTMENTS = [{ kind: 'override', item: r.foundName, amount: 2400, note: 'Site already level' }];
  bd = page.taxBreakdown(r);
  t = text(page.buildBreakdown(bd));
  assert.ok(t.indexOf('Discounts') < t.indexOf('Site already level'));
  assert.ok(t.indexOf('Site already level') < t.indexOf('Sales Tax'));
  assert.doesNotMatch(t, /Price set for this job/);
});
