/* The quote page's own arithmetic, executed.
 *
 * Twice now a helper in quote.html has referenced a name that was not in its
 * scope — first `config`, then `num` — and each time the result was the same:
 * a ReferenceError thrown while building the document, no quote, and the page
 * left sitting on "Loading…". Nothing caught it, because every test in this
 * repo tested the worker and none of them ever ran the page.
 *
 * This loads the real <script> out of quote.html into a VM and calls
 * taxBreakdown() directly, so a name that isn't in scope fails here instead of
 * on a customer's quote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing } from './pricing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'quote.html');

function loadQuotePage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'quote.html has an inline <script>');

  // Enough of a browser for the module-level code to run. There is no id in
  // the search string, so the page does not try to fetch anything; every
  // function it declared is still left on the context for us to call.
  const el = {
    innerHTML: '', textContent: '', className: '', style: {},
    appendChild() {}, setAttribute() {}, querySelector() { return null },
    querySelectorAll() { return [] },
  };
  const ctx = {
    console,
    URLSearchParams,
    localStorage: { getItem: () => 'test-token', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: {
      getElementById: () => el,
      createElement: () => Object.create(el),
      querySelector: () => el,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'quote.html' });
  return ctx;
}

const BASE_REDLINE = {
  marginPrice: 5000,
  baseSheetLabel: 'A-Frame',
  foundName: 'Concrete Pad 10x16',
  foundSell: 2000,
  addonLines: [],
};

test('taxBreakdown prices a plain shed', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown(BASE_REDLINE);
  assert.ok(bd, 'a redline with dollars in it produces a breakdown');
  assert.equal(bd.subtotal, 7000);
});

test('a quote carrying removal add-ons does not throw', () => {
  const page = loadQuotePage();
  // This is the exact shape that blanked the page: both removals present as
  // addonLines, which sends taxBreakdown through removalTotal().
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [
      { name: 'Shed Removal', amt: 1000 },
      { name: 'Concrete Removal', amt: 1000 },
    ],
  });
  assert.ok(bd, 'removal add-ons still produce a breakdown');

  const clearance = bd.rows.find(r => /Site Clearance/.test(r.label));
  assert.ok(clearance, 'both removals collapse into one Site Clearance phase');
  assert.equal(clearance.amt, 2000);
  assert.deepEqual(
    clearance.subLines.map(s => [s.label, s.amt]),
    [['Shed Removal', 1000], ['Concrete Removal', 1000]],
    'each removal is itemised under it'
  );

  // Removal is its own phase, so it must not also be inside the Shed total.
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));
  assert.equal(shed.amt, 5000, 'removal dollars are not double-counted into Shed');
  assert.equal(bd.subtotal, 9000);
});

test('a single removal keeps its own name', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [{ name: 'Concrete Removal', amt: 1000 }],
  });
  const row = bd.rows.find(r => /Concrete Removal/.test(r.label));
  assert.ok(row, 'one removal is labelled with the thing being removed');
  assert.ok(!row.subLines, 'and needs no sub-lines');
});

test('removal is the first phase, ahead of the concrete', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [{ name: 'Shed Removal', amt: 1000 }],
  });
  assert.match(bd.rows[0].label, /^Phase 1 — Shed Removal/);
  assert.match(bd.rows[1].label, /^Phase 2 — Concrete Pad/);
});


/* ── The quote must bill what the engine charges ──────────────────────────
 *
 * The customer is shown computeQuote().customer — in the designer, and again
 * as the price on the customer page, which is what gets stored as
 * details.quotedPrice. The quote DOCUMENT re-derives that number from the
 * redline, in quote.html, by listing the fields to add up.
 *
 * That list silently omitted paintSell. Exterior paint is on every shed that
 * isn't pine, so nearly every quote totalled thousands of dollars below the
 * price the customer had already been shown. floorSell was missing the same
 * way and would have started costing money the day flooring went live.
 *
 * So don't test the list — test it against the engine. Any sell field added
 * to customerPrice in the future and not added to quote.html fails here.
 */
const BUILDS = {
  'plain 10x16': { style: 'gable', w: 10, l: 16, h: 9 },
  'pine (no paint charge)': { style: 'gable', w: 10, l: 16, h: 9, siding: 'pine' },
  'tall walls': { style: 'gable', w: 12, l: 20, h: 10 },
  'pad + coating': { style: 'gable', w: 10, l: 16, h: 9, foundation: 'pad', foundationFinish: 'coated' },
  'interior + electrical': { style: 'gable', w: 10, l: 16, h: 9, intFinish: 'painted', elec: 'essential' },
  'flooring (still hidden)': { style: 'gable', w: 10, l: 16, h: 9, intFinish: 'painted', floor: 'best' },
  'removals': { style: 'gable', w: 10, l: 16, h: 9, addons: { shedRemoval: true, concreteRemoval: true } },
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

for (const [label, config] of Object.entries(BUILDS)) {
  test(`quote subtotal matches the engine: ${label}`, () => {
    const page = loadQuotePage();
    const { customer, redline } = computePricing(config);
    const bd = page.taxBreakdown(redline);
    assert.ok(bd, 'the build produces a breakdown');
    assert.ok(
      Math.abs(bd.subtotal - customer) < 1,
      `quote subtotal $${Math.round(bd.subtotal)} != customer price $${Math.round(customer)} ` +
      `(off by $${Math.round(bd.subtotal - customer)}) — a sell field the engine charges for ` +
      `is missing from shedTotal in quote.html`
    );
  });
}

/* The itemisation has one job that matters more than being complete: the parts
   must add up to the line they sit under. A customer reading a breakdown does
   the sum — that is why they asked for it — and a shed row that does not match
   its own items discredits the whole document. */
for (const [label, config] of Object.entries(BUILDS)) {
  test(`the shed's items add up to the shed: ${label}`, () => {
    const page = loadQuotePage();
    const { redline } = computePricing(config);
    const bd = page.taxBreakdown(redline);
    const shed = bd.rows.find(r => / Shed\b/.test(r.label));
    assert.ok(shed, 'there is a shed phase');
    const subs = shed.subLines || [];
    assert.ok(subs.length > 2, `the shed is itemised (${subs.length} lines)`);
    const summed = subs.reduce((t, l) => t + l.amt, 0);
    assert.ok(
      Math.abs(summed - shed.amt) < 1,
      `items total $${Math.round(summed)} but the Shed line reads $${Math.round(shed.amt)} ` +
      `(off by $${Math.round(summed - shed.amt)}) — something the engine charges for is ` +
      `either missing from the itemisation or counted twice`
    );
  });
}

test('a comped item is not charged in the itemisation', () => {
  /* It is already listed under "Included at No Charge". Showing it at full
     price here as well would put the same item on the quote twice, once
     charged and once free, and break the sum above. */
  const page = loadQuotePage();
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const skylight = (redline.addonLines || []).find(l => l.name === 'Skylight');
  assert.ok(skylight, 'the fixture has a skylight to comp');
  page.ADJUSTMENTS = [{ kind: 'comp', item: 'Skylight' }];
  page.COMPED = { Skylight: skylight.amt };
  page.COMP_TOTAL = skylight.amt;
  const bd = page.taxBreakdown(redline);
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));
  const line = (shed.subLines || []).find(l => l.label === 'Skylight');
  assert.ok(!line, 'a fully comped line is not charged in the breakdown');
});

test('exterior paint is inside the shed phase, not a phase of its own', () => {
  const page = loadQuotePage();
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9 });
  assert.ok(redline.paintSell > 0, 'a painted shed does charge for paint');
  const bd = page.taxBreakdown(redline);
  assert.equal(bd.rows.length, 1, 'a bare painted shed is one phase');
  assert.match(bd.rows[0].label, /Shed/);
});

test('flooring is broken out without displacing electrical', () => {
  const page = loadQuotePage();
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 9, intFinish: 'painted', floor: 'best', elec: 'essential',
  });
  const bd = page.taxBreakdown(redline);
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));
  const labels = (shed.subLines || []).map(s => s.label).join(' | ');
  assert.match(labels, /Electrical/, 'electrical still shown');
  assert.match(labels, /Flooring/, 'flooring shown alongside it, not instead of it');
});

/* A quote that went out before the paint/labour split has a redline with the
 * old $7-a-foot paintSell on it and no laborSell at all. Redlines freeze at
 * submit time and this page reads the stored one — it re-prices nothing — so
 * that customer must still see the number they were quoted, with no Build
 * Labor line appearing under it and no change to the total.
 */
test('a quote sent before the split still shows its original price', () => {
  const page = loadQuotePage();
  const legacy = {
    marginPrice: 6759,
    paintSell: 4480, paintSellName: 'Exterior Paint (640 sqft)',   // the old $7/sqft
    sidingSell: 1600, sidingSellName: 'Board & Batten',
    heightSell: 1920, heightSellName: "10' Walls",
    baseSheetLabel: 'Barn'
    /* no laborSell — the field did not exist when this was written */
  };
  const bd = page.taxBreakdown(legacy);
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));

  assert.equal(Math.round(shed.amt), 14759, 'the stored total must not move');

  const subs = shed.subLines || [];
  assert.ok(!subs.some(l => /Labor/i.test(l.label)),
    'no labor line may appear on a quote written before it existed');

  const paint = subs.find(l => /Exterior Paint/.test(l.label));
  assert.equal(Math.round(paint.amt), 4480, 'the old paint figure is shown as quoted');

  const summed = subs.reduce((t, l) => t + l.amt, 0);
  assert.ok(Math.abs(summed - shed.amt) < 1,
    `an old quote still itemises to its own total (${summed} vs ${shed.amt})`);
});

/* Build labour is priced as its own thing by the engine so staff can see the
 * split, but the customer is shown one price to build the shed. It has to be
 * inside Base Shed, and it has to be inside it exactly once — folding it in
 * while also listing it would double-charge, and the itemisation would stop
 * adding up to the phase total.
 */
test('build labor is folded into Base Shed, not listed separately', () => {
  const page = loadQuotePage();
  const { redline } = computePricing(BUILDS['barn, everything on']);
  assert.ok(redline.laborSell > 0, 'this build does charge labor');

  const bd = page.taxBreakdown(redline);
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));
  const subs = shed.subLines || [];

  assert.ok(!subs.some(l => /Labor/i.test(l.label)),
    'no standalone labor line reaches the customer');

  const base = subs.find(l => l.label === 'Base Shed');
  assert.equal(
    Math.round(base.amt),
    Math.round(redline.marginPrice + redline.laborSell),
    'Base Shed carries the labor inside it'
  );

  const summed = subs.reduce((t, l) => t + l.amt, 0);
  assert.ok(Math.abs(summed - shed.amt) < 1,
    `the itemisation still adds up (${summed} vs ${shed.amt})`);
});

/* Labor is deliberately NOT compable: it is not a line the customer can see,
 * so there is nothing to give away. This pins that, because the fold into Base
 * Shed adds laborSell whole — if labor became compable in one of these lists
 * without the other two following, Base Shed and the phase total would drift
 * apart and the itemisation would stop adding up.
 */
test('labor is not in the compable set, which is what lets Base Shed add it whole', () => {
  const page = loadQuotePage();
  const { redline } = computePricing(BUILDS['barn, everything on']);
  assert.ok(redline.laborSellName, 'this build has a labor line to look for');

  assert.equal(page.compItemPrices(redline)[redline.laborSellName], undefined,
    'labor cannot be selected as a comp');
  assert.ok(!page.nameList(redline, 'shed').includes(redline.laborSellName),
    'labor is not among the shed names a comp is deducted against');
});

/* ── THE DEAL ────────────────────────────────────────────────────────────────
 * A discount should be the line a customer catches first, and the closing
 * figure should say what the shed was before it. The numbers behind that have
 * to be exact: a "you save" that does not subtract from the before figure to
 * the total is worse than not showing one.
 */
const withAdjust = (redline, adjustments) => {
  const page = loadQuotePage();
  page.ADJUSTMENTS = adjustments;
  page.COMPED = {};
  return { page, bd: page.taxBreakdown(redline) };
};

test('before, saving and total subtract to each other exactly', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, [{ kind: 'amount', value: -1500 }]);
  assert.ok(bd.savings > 0);
  assert.ok(Math.abs((bd.totalBefore - bd.savings) - bd.total) < 0.005,
    `${bd.totalBefore} - ${bd.savings} should be ${bd.total}`);
});

test('the saving is the discount plus the tax no longer owed on it', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, [{ kind: 'amount', value: -1500 }]);
  assert.ok(Math.abs(bd.savings - 1500 * (bd.total / bd.adjustedSubtotal)) < 0.01,
    'the customer saves the tax on the discount too');
});

test('a percentage discount works the same way', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, [{ kind: 'percent', value: -10 }]);
  assert.ok(Math.abs(bd.savings - bd.subtotal * 0.10 * (bd.total / bd.adjustedSubtotal)) < 0.01);
  assert.ok(Math.abs((bd.totalBefore - bd.savings) - bd.total) < 0.005);
});

test('an adjustment that raises the price claims no saving', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, [{ kind: 'amount', value: 800 }]);
  assert.equal(bd.savings, 0, 'nothing was saved');
  assert.ok(bd.total > bd.totalBefore, 'the price went up, and says so');
});

/* adjustedSubtotal is clamped at zero, so a discount bigger than the shed must
   not report a saving larger than the price ever was. */
test('an over-sized discount cannot save more than the shed cost', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, [{ kind: 'amount', value: -999999 }]);
  assert.equal(bd.adjustedSubtotal, 0);
  assert.ok(Math.abs(bd.savings - bd.totalBefore) < 0.005,
    'the most that can be saved is the whole price');
  assert.equal(bd.total, 0);
});

test('with no adjustment there is no saving and no before figure to show', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { bd } = withAdjust(redline, []);
  assert.equal(bd.savings, 0);
  assert.equal(bd.adjust, 0);
  assert.ok(Math.abs(bd.totalBefore - bd.total) < 0.005,
    'before and after are the same number');
});

test('the discount line is marked so it can be made to stand out', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { page } = withAdjust(redline, [{ kind: 'amount', value: -1500, note: 'Fall promo' }]);
  const html = page.buildBreakdown(page.taxBreakdown(redline));
  assert.match(html, /br-row br-save/, 'the discount row carries the savings class');
  assert.match(html, /Fall promo/, 'and the note staff wrote');
});

test('a price rise is not dressed up as a saving', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { page } = withAdjust(redline, [{ kind: 'amount', value: 800, note: 'Rush build' }]);
  const html = page.buildBreakdown(page.taxBreakdown(redline));
  assert.ok(!/br-save/.test(html), 'no savings styling on a line that costs more');
});

test('the price box shows the before figure and the saving', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { page, bd } = withAdjust(redline, [{ kind: 'amount', value: -1500 }]);
  const html = page.priceBox(bd, bd.total);
  assert.match(html, /Total Due After Adjustment/);
  assert.match(html, /Before adjustment/);
  assert.match(html, /You save/);
  assert.match(html, /price-box-deal/);
});

test('the price box is unchanged when nothing was adjusted', () => {
  const { redline } = computePricing(BUILDS['barn, everything on']);
  const { page, bd } = withAdjust(redline, []);
  const html = page.priceBox(bd, bd.total);
  assert.match(html, /Total Due \(Tax Included\)/);
  assert.ok(!/Before adjustment/.test(html));
  assert.ok(!/You save/.test(html));
  assert.ok(!/price-box-deal/.test(html));
});

test('a quote with no breakdown at all still renders a price box', () => {
  const page = loadQuotePage();
  const html = page.priceBox(null, null);
  assert.match(html, /Pending review/);
  assert.ok(!/You save/.test(html));
});
