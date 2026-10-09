/* DISCOUNTS GO AT THE VERY END (Nando, 9 Oct 2026).
 *
 * Every line on the quote, the Stripe invoices and the CRM preview shows its
 * REGULAR price; the pad promo, each item included free, each staff discount
 * (and, on a regular-price quote, the cash, check & bank transfer discount)
 * is its own line, grouped at the end. DISPLAY ONLY: every total, deposit,
 * phase and remainder is the same number it was before, which is what most
 * of this file checks.
 *
 * Run: node --test worker/discountsend.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing } from './pricing.js';
import { quoteLines, TAX_RATE, compedMap } from './quotelines.js';
import { buildInvoice, buildPhaseInvoice, phaseParts, phaseStatus, toCents, addCashDiscount, buildMemo } from './invoices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ` ${a} vs ${b}`);

const RICH = { style: 'barn', w: 12, l: 20, h: 10, foundation: 'pad', foundationFinish: 'coated',
  intFinish: 'painted', elec: 'essential', loft: '6-front', addons: { shutters: true, skylight: true, shedRemoval: true } };
const { redline } = computePricing(RICH);
const ADJS = {
  none: [],
  loyalty: [{ kind: 'amount', value: -1000, note: 'Loyalty discount' }],
  percent: [{ kind: 'percent', value: -10, note: 'Repeat customer' }],
  comps: [{ kind: 'comp', item: 'Skylight' }, { kind: 'comp', item: 'Shutters' }],
  mixed: [{ kind: 'comp', item: 'Skylight' }, { kind: 'amount', value: -500, note: 'Staff adjustment' },
          { kind: 'amount', value: 300, note: 'Custom shelving' }, { kind: 'travel', days: 2, rate: 75 }],
  freePad: [{ kind: 'comp', item: redline.foundName }],
};
const variants = [];
for (const [name, adj] of Object.entries(ADJS)) {
  variants.push([name, redline, adj]);
  variants.push([name + ' at regular prices', { ...redline, cardUplift: 0.03 }, adj]);
}

test('fixture: the build has a pad promo, and comp-able items', () => {
  assert.ok(Number(redline.foundPromo) > 0, 'the pad promo is on');
  assert.ok(redline.foundName);
});

test('regular subtotal + charges - discounts = the same adjusted subtotal; each row adds back to its total', () => {
  for (const [label, rl, adj] of variants) {
    const bd = quoteLines(rl, adj);
    const charges = bd.charges.reduce((t, c) => t + c.amt, 0);
    near(bd.regularSubtotal + charges - bd.discountTotal, bd.adjustedSubtotal, label);
    near(bd.discounts.reduce((t, d) => t + d.amt, 0), bd.discountTotal, label);
    bd.rows.forEach((r) => {
      near(r.regularTotal - r.discountTotal, r.total, label + ' ' + r.label);
      near(r.regularAmt - r.discounts.reduce((t, d) => t + d.amt, 0), r.amt, label + ' ' + r.label);
      assert.ok(r.discountTotal >= 0);
    });
    near(bd.adjustedSubtotal * (1 + TAX_RATE), bd.total, label);
  }
});

test('each discount is named the way Nando asked', () => {
  const bd = quoteLines(redline, [...ADJS.loyalty, ...ADJS.comps]);
  const labels = bd.discounts.map((d) => d.label);
  assert.ok(labels.includes('Concrete pad promo'));
  assert.ok(labels.includes('Loyalty discount'));
  assert.ok(labels.includes('Skylight \u2014 included free'));
  assert.ok(labels.includes('Shutters \u2014 included free'));
  const pad = bd.rows.find((r) => r.kind === 'foundation');
  near(pad.regularAmt, pad.amt + Number(redline.foundPromo));
});

test('a positive adjustment is a charge, never listed as a discount', () => {
  const bd = quoteLines(redline, ADJS.mixed);
  assert.deepEqual(bd.charges.map((c) => c.label), ['Custom shelving']);
  assert.ok(!bd.discounts.some((d) => /Custom shelving|Travel/.test(d.label)));
});

test('a pad given away entirely is shown at its price with its comp among the discounts', () => {
  const bd = quoteLines(redline, ADJS.freePad);
  assert.ok(!bd.rows.some((r) => r.kind === 'foundation'), 'no phase for a free pad (as before)');
  assert.equal(bd.freeRows.length, 1);
  assert.ok(bd.discounts.some((d) => d.label === redline.foundName + ' \u2014 included free'));
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: ADJS.freePad });
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
  assert.equal(inv.totalCents, toCents(bd.depositTotal));
});

/* ── the deposit / balance invoice ────────────────────────────────────── */
test('invoices: phases at regular prices, charges, then every discount, then tax; totals unchanged', () => {
  for (const [label, rl, adj] of variants) {
    const bd = quoteLines(rl, adj);
    for (const kind of ['deposit', 'balance']) {
      const pays = kind === 'balance' ? [{ amount: 1500, method: 'check', paid_at: '2026-09-01' }] : [];
      const inv = buildInvoice(bd, kind, pays, { adjustments: adj, comped: compedMap(rl, adj) });
      assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents, label);
      assert.equal(inv.totalCents, kind === 'deposit' ? toCents(bd.depositTotal) : toCents(bd.total) - 150000, label);
      const iTax = inv.lines.findIndex((l) => /^Sales Tax/.test(l.label));
      const disc = inv.lines.map((l, i) => (l.discount ? i : -1)).filter((i) => i > -1);
      assert.equal(disc.length, bd.discounts.length, label + ': one line per discount');
      disc.forEach((i, k) => {
        assert.equal(i, iTax - disc.length + k, label + ': discounts sit together, right before tax');
        assert.ok(inv.lines[i].amountCents < 0);
      });
      /* Nothing above the discounts mentions a promo or a comp any more. */
      inv.lines.slice(0, iTax - disc.length).forEach((l) => assert.doesNotMatch(l.label, /promo|less \$/i, label));
      /* The face of the invoice (to tax) is still the job in full. */
      const face = inv.lines.slice(0, iTax + 1).reduce((t, l) => t + l.amountCents, 0);
      assert.ok(Math.abs(face - toCents(bd.total)) <= 2, label + ': face ' + face + ' vs ' + toCents(bd.total));
      if (bd.cashDiscount) {
        const ach = addCashDiscount(inv, () => bd.cashDiscount.uplift, 1);
        assert.match(ach.lines[ach.lines.length - 1].label, /^Cash, check & bank transfer discount \(2\.9%\)/, 'the cash discount is the very last line');
      }
    }
  }
});

test('earned cash discounts follow every payment line, not interleaved', () => {
  const bd = quoteLines({ ...redline, cardUplift: 0.03 }, []);
  const inv = buildInvoice(bd, 'balance', [
    { amount: 1000, discount_amount: 29.13, method: 'check', paid_at: '2026-09-01' },
    { amount: 500, method: 'card', paid_at: '2026-09-05' }]);
  const labels = inv.lines.map((l) => l.label);
  const iDisc = labels.findIndex((l) => /discount on the \$1,000\.00 check payment/.test(l));
  const iCard = labels.findIndex((l) => /Payment received by card/.test(l));
  assert.ok(iDisc > iCard, labels.join(' | '));
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
});

test('the memo shows phases at their regular price and lists the discounts last when there is room', () => {
  const bd = quoteLines({ marginPrice: 7000, foundSell: 3000, foundPromo: 500, foundName: 'Concrete Pad (4" slab)' }, []);
  const memo = buildMemo(bd, {});
  assert.match(memo, /Concrete Pad \(4" slab\) \u2014 \$3,500\.00/);
  assert.match(memo, /Discounts:\n   Concrete pad promo \u2212\$500\.00$/);
});

/* ── phase invoices ───────────────────────────────────────────────────── */
test('phase invoices: every part bills the same cents; its discount is shown at the end', () => {
  for (const [label, rl, adj] of variants) {
    const bd = quoteLines(rl, adj);
    const P = phaseParts(bd);
    P.forEach((p) => {
      assert.ok(p.discount.depositCents >= 0 && p.discount.remainderCents >= 0, label);
      for (const sel of [[{ phase: p.phase, part: 'deposit' }], [{ phase: p.phase, part: 'remainder' }],
                         [{ phase: p.phase, part: 'deposit' }, { phase: p.phase, part: 'remainder' }]]) {
        const inv = buildPhaseInvoice(bd, [], sel);
        const want = sel.reduce((t, s) => t + p[s.part + 'Cents'], 0);
        assert.equal(inv.totalCents, want, label + ' phase ' + p.phase);
        assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), want);
        assert.deepEqual(inv.covers.map((c) => c.cents), sel.map((s) => p[s.part + 'Cents']), 'covers are the real cents');
        const disc = inv.lines.filter((l) => l.discount);
        if (disc.length) assert.deepEqual(inv.lines.slice(-disc.length), disc, 'discount lines are last');
        const dWant = sel.reduce((t, s) => t + p.discount[s.part + 'Cents'], 0);
        assert.equal(-disc.reduce((t, l) => t + l.amountCents, 0) + 0, dWant + 0);
        inv.lines.filter((l) => !l.discount).forEach((l) => assert.doesNotMatch(l.label, /promo applied/));
      }
    });
    /* The discount comes off the right phase: the pad promo only on the pad. */
    if (!adj.some((a) => a.kind === 'amount' || a.kind === 'percent')) {
      P.forEach((p) => {
        const names = p.discount.names.join(',');
        if (p.kind === 'foundation') assert.match(names, /Concrete pad promo/);
        else assert.doesNotMatch(names, /Concrete pad promo/);
      });
    }
  }
});

test('a partly-paid part still bills exactly what is left', () => {
  const bd = quoteLines(redline, ADJS.loyalty);
  const P = phaseParts(bd);
  const f = P.find((p) => p.kind === 'foundation');
  const pays = [{ amount: 100, method: 'check', phase_alloc: JSON.stringify({ phase: f.phase }) }];
  const st = phaseStatus(bd, pays);
  const inv = buildPhaseInvoice(bd, pays, [{ phase: f.phase, part: 'deposit' }]);
  assert.equal(inv.totalCents, f.depositCents - 10000);
  assert.equal(inv.totalCents, st.phases.find((p) => p.phase === f.phase).deposit.remainingCents);
  assert.ok(inv.lines.some((l) => l.discount), 'the discount is still shown');
  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents);
});

/* ── the quote page ───────────────────────────────────────────────────── */
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
const money = (n) => '$' + Math.round(n).toLocaleString();
const text = (h) => h.replace(/<[^>]+>/g, '\u00a6').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('quote page: regular prices, then the Discounts section, then tax and the total', () => {
  const page = loadQuotePage();
  const adj = [...ADJS.loyalty, ...ADJS.comps];
  page.ADJUSTMENTS = adj;
  const bd = page.taxBreakdown(redline);
  const t = text(page.buildBreakdown(bd));
  const at = (s) => { const i = t.indexOf(s); assert.ok(i > -1, 'missing: ' + s); return i; };
  const pad = bd.rows.find((r) => r.kind === 'foundation');
  assert.ok(t.includes(pad.label + '\u00a6\u00a6' + money(pad.regularAmt)), 'pad at its list price');
  assert.ok(t.includes('Skylight\u00a6\u00a6' + money(redline.addonLines.find((l) => l.name === 'Skylight').amt)), 'a free item still at its price');
  assert.doesNotMatch(t, /Included at No Charge/);
  const iSub = at('Subtotal at regular prices (before tax)');
  const iHead = at('\u00a6Discounts\u00a6');
  const iPromo = at('Concrete pad promo\u00a6\u00a6\u2212' + money(Number(redline.foundPromo)));
  const iLoyal = at('Loyalty discount\u00a6\u00a6\u2212$1,000');
  const iSky = at('Skylight \u2014 included free');
  const iAfter = at('Subtotal after discounts (before tax)\u00a6\u00a6' + money(bd.adjustedSubtotal));
  const iTax = at('Sales Tax (7.25%)\u00a6\u00a6' + money(bd.tax));
  const iTot = at('Total (tax included)\u00a6\u00a6' + money(bd.total));
  assert.ok(iSub < iHead && iHead < iPromo && iPromo < iSky && iSky < iLoyal && iLoyal < iAfter && iAfter < iTax && iTax < iTot);
  /* Nothing discount-like before the section. */
  assert.doesNotMatch(t.slice(0, iHead), /promo|\u2212/);
  /* The deposits are the same figures as before. */
  bd.rows.forEach((r) => assert.ok(t.includes('Phase ' + r.phase + ' Deposit (30%)\u00a6\u00a6' + money(r.deposit))));
});

test('quote page: a rise is a charge above the discounts; with no discounts there is no section', () => {
  const page = loadQuotePage();
  page.ADJUSTMENTS = [{ kind: 'amount', value: 800, note: 'Rush build' }];
  const plain = { marginPrice: 7000, baseSheetLabel: 'A-Frame' };
  const t = text(page.buildBreakdown(page.taxBreakdown(plain)));
  assert.match(t, /Rush build\u00a6\u00a6\+\$800/);
  assert.doesNotMatch(t, /Discounts/);
  assert.match(t, /Adjusted Subtotal \(before tax\)\u00a6\u00a6\$7,800/);
});

test('quote page at regular prices: the cash discount stays the very last thing, under the total', () => {
  const page = loadQuotePage();
  page.ADJUSTMENTS = [];
  const bd = page.taxBreakdown({ ...redline, cardUplift: 0.03 });
  const box = text(page.priceBox(bd, bd.total));
  assert.ok(box.indexOf('Total Due') < box.indexOf('Cash, check & bank transfer discount (2.9%)'));
  const t = text(page.buildBreakdown(bd));
  assert.ok(t.indexOf('Concrete pad promo') < t.indexOf('Sales Tax'));
});
