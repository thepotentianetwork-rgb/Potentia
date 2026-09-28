/* THE PORT, PINNED TO THE PAGE IT CAME FROM.
 *
 * worker/quotelines.js is quote.html's taxBreakdown() moved server-side so a
 * Stripe invoice can carry the same figures the customer agreed to. A port
 * that is merely close is worse than no port: it would bill a different number
 * than the quote, and nobody would notice until a customer did.
 *
 * So nothing here asserts a hand-typed expectation. Every case runs BOTH
 * implementations — the real <script> out of quote.html in a VM, and the
 * module — over the same redline, and fails on any difference. The page stays
 * the authority until it is switched over to import the module; at that point
 * these tests keep protecting the swap rather than becoming redundant.
 *
 * Run: node --test worker/quotelines.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing } from './pricing.js';
import { quoteLines, compItemPrices, TAX_RATE, DEPOSIT_RATE } from './quotelines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'quote.html');
const BROWSER_MATH = path.join(HERE, '..', 'quotelines.browser.js');

/* Same loader as quotepage.test.mjs: enough of a browser for the page's
   module-level code to run, with no id in the search string so it never tries
   to fetch. Every function it declared is left on the context to call. */
function loadQuotePage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'quote.html has an inline <script>');
  const el = {
    innerHTML: '', textContent: '', className: '', style: {},
    appendChild() {}, setAttribute() {}, querySelector() { return null },
    querySelectorAll() { return [] },
  };
  const ctx = {
    console, URLSearchParams,
    localStorage: { getItem: () => 'test-token', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: {
      getElementById: () => el, createElement: () => Object.create(el),
      querySelector: () => el, querySelectorAll: () => [], addEventListener() {},
    },
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  /* The page loads this before its own script, and its arithmetic now comes
     from it. Loading only the inline script would leave taxBreakdown calling a
     quoteLines that isn't there — which is the same class of failure this file
     was written to catch, so the harness has to load what the browser loads. */
  vm.runInContext(fs.readFileSync(BROWSER_MATH, 'utf8'), ctx, { filename: 'quotelines.browser.js' });
  vm.runInContext(m[1], ctx, { filename: 'quote.html' });
  return ctx;
}

/* The page reads its adjustments off two module-level globals that render()
   fills in. Setting them by hand is what render() does, minus the DOM. */
function pageBreakdown(page, redline, adjustments) {
  const adj = adjustments || [];
  const prices = page.compItemPrices(redline);
  const comped = {};
  adj.forEach((a) => {
    if (a && a.kind === 'comp' && prices[a.item] != null) comped[a.item] = prices[a.item];
  });
  vm.runInContext('ADJUSTMENTS = __adj; COMPED = __comp;',
    Object.assign(page, { __adj: adj, __comp: comped }));
  return page.taxBreakdown(redline);
}

const BUILDS = {
  'plain 10x16': { style: 'gable', w: 10, l: 16, h: 9 },
  'pine (no paint charge)': { style: 'gable', w: 10, l: 16, h: 9, siding: 'pine' },
  'tall walls': { style: 'gable', w: 12, l: 20, h: 10 },
  'pad + coating': { style: 'gable', w: 10, l: 16, h: 9, foundation: 'pad', foundationFinish: 'coated' },
  'interior + electrical': { style: 'gable', w: 10, l: 16, h: 9, intFinish: 'painted', elec: 'essential' },
  'flooring': { style: 'gable', w: 10, l: 16, h: 9, intFinish: 'painted', floor: 'best' },
  'removals (both)': { style: 'gable', w: 10, l: 16, h: 9, addons: { shedRemoval: true, concreteRemoval: true } },
  'removal (one only)': { style: 'gable', w: 10, l: 16, h: 9, addons: { shedRemoval: true } },
  'front porch, composite': { style: 'gable', w: 12, l: 20, h: 9, porchLoc: 'front', porchDepth: 6, porchDeck: 'composite' },
  'side porch, pressure treated': { style: 'gable', w: 12, l: 20, h: 9, porchLoc: 'side', porchDepth: 4, porchDeck: 'pt' },
  'barn, everything on': {
    style: 'barn', w: 12, l: 20, h: 10, siding: 'board-batten', foundation: 'pad',
    foundationFinish: 'coated', intFinish: 'painted', floor: 'better', elec: 'essential',
    loft: '6-front', porchFront: 4,
    doors: [{ wall: 'front', pos: 0.5, w: 36, h: 80, style: 'fairytale', color: 'white' },
            { wall: 'right', pos: 0.5, w: 96, h: 84, style: 'rollup', color: 'brown' }],
    windows: [{ wall: 'left', pos: 0.3, w: 24, h: 36, cy: 52, type: 'White Vinyl 24x36' }],
    shelves: [{ wall: 'back', pos: 0.5, cy: 48, depth: 24, len: 12 }],
    addons: { shutters: true, shedRemoval: true, concreteRemoval: true, skylight: true, houseWrap: true },
  },
};

/* Every adjustment shape the CRM can store, including the ones that exercise
   the clamps: a discount bigger than the shed, and an adjustment that puts the
   price UP. */
function adjustmentCases(redline) {
  const compable = Object.keys(compItemPrices(redline));
  const cases = [
    ['none', []],
    ['10% off', [{ kind: 'percent', value: -10 }]],
    ['$500 off', [{ kind: 'amount', value: -500 }]],
    ['price up 5%', [{ kind: 'percent', value: 5 }]],
    ['percent and amount together', [{ kind: 'percent', value: -7.5 }, { kind: 'amount', value: -250 }]],
    ['two percentages (add, not compound)', [{ kind: 'percent', value: -5 }, { kind: 'percent', value: -5 }]],
    ['discount larger than the shed', [{ kind: 'amount', value: -999999 }]],
    ['a junk value', [{ kind: 'percent', value: 'abc' }]],
  ];
  if (compable.length) {
    cases.push(['one comp', [{ kind: 'comp', item: compable[0] }]]);
    cases.push(['a comp and a discount',
      [{ kind: 'comp', item: compable[0] }, { kind: 'percent', value: -10 }]]);
  }
  if (compable.length > 2) {
    cases.push(['several comps', compable.slice(0, 3).map((i) => ({ kind: 'comp', item: i }))]);
  }
  return cases;
}

for (const [label, config] of Object.entries(BUILDS)) {
  test(`page and module agree: ${label}`, () => {
    const page = loadQuotePage();
    const { redline } = computePricing(config);
    for (const [what, adj] of adjustmentCases(redline)) {
      const mine = quoteLines(redline, adj);
      const theirs = pageBreakdown(page, redline, adj);
      assert.deepEqual(
        JSON.parse(JSON.stringify(mine)),
        JSON.parse(JSON.stringify(theirs)),
        `${label} / ${what}: the port disagrees with quote.html`
      );
    }
  });
}

test('a redline it cannot read returns null, same as the page', () => {
  const page = loadQuotePage();
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.equal(quoteLines(bad, []), pageBreakdown(page, bad, []),
      `${JSON.stringify(bad)} should behave identically`);
  }
});

test('the rates are the ones the quote has always used', () => {
  const page = loadQuotePage();
  assert.equal(TAX_RATE, page.TAX_RATE, 'tax rate drifted from the page');
  assert.equal(DEPOSIT_RATE, page.DEPOSIT_RATE, 'deposit rate drifted from the page');
});

/* The two numbers a Stripe invoice is actually built from. Not a restatement
   of the arithmetic above — a check that the shape the invoice will read is
   present and internally consistent, so a later change that keeps the totals
   right but drops the per-phase deposits still fails here. */
test('every phase carries a deposit, and they sum to depositTotal', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const bd = quoteLines(redline, [{ kind: 'percent', value: -10 }]);
  assert.ok(bd.rows.length > 1, 'this build should produce several phases');
  let sum = 0;
  for (const r of bd.rows) {
    assert.ok(r.deposit > 0, `${r.label} has no deposit`);
    assert.ok(Math.abs(r.deposit - r.total * DEPOSIT_RATE) < 1e-9,
      `${r.label}: deposit is not ${DEPOSIT_RATE * 100}% of its tax-included total`);
    sum += r.deposit;
  }
  assert.ok(Math.abs(sum - bd.depositTotal) < 1e-9, 'phase deposits do not sum to depositTotal');
  assert.ok(bd.depositTotal < bd.total, 'the deposit cannot be the whole job');
});
