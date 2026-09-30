/* PREMIUM WINDOWS MUST CARRY A PRICE OF THEIR OWN.
 *
 * An unpriced window does not quote as TBD. sellWindowPrice falls through to
 * the nearest WHITE VINYL by area, so a catalog entry with no SELL.windows key
 * quotes at somewhere between $130 and $310 — with a note against it, and
 * nothing else. That is survivable for a transom nobody has costed. On a
 * bought-in architectural unit it is a four-thousand-dollar hole in a quote
 * that adds up correctly and looks fine.
 *
 * So: every Premium entry is priced explicitly, and the fallback is shown to
 * be the thing it is being protected from rather than assumed to be.
 *
 * Run: node --test worker/premiumwindows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_CATALOG, SELL, sellWindowPrice, sellWindowPriced,
         windowDisplayName, computePricing, sellBarLedge } from './pricing.js';

const premium = () => WINDOW_CATALOG.filter((e) => e.grp === 'Premium');

test('the premium group holds both products, at every size asked for', () => {
  /* Pinned as exact lists. "at least three bi-folds" is satisfied by a
     catalog that has quietly lost a lift-up size, and the missing one shows
     up as a tile nobody can click rather than as an error. */
  const sizes = (re) => premium().filter((e) => re.test(e.key))
    .map((e) => e.w + 'x' + e.h).join(',');
  /* The SAME four sizes for both, so the two price ladders compare line for
     line and choosing between them is choosing a mechanism, not a size. */
  assert.equal(sizes(/Bi-Fold Bar/), '48x36,60x42,72x42,96x48');
  assert.equal(sizes(/Lift-Up Bar/), '48x36,60x42,72x42,96x48');
  // Nothing else has crept into the tier.
  assert.equal(premium().filter((e) => !/(Bi-Fold|Lift-Up) Bar/.test(e.key)).length, 0);

  for (const e of premium().filter((x) => /Bi-Fold Bar/.test(x.key))) {
    // Three equal panels, or the closed window is two lights and a remainder.
    assert.equal(e.w % 3, 0, `${e.key} is ${e.w}" wide and does not divide into three`);
  }
  for (const e of premium()) {
    assert.ok(e.w > e.h, `${e.key} should be a wide serving opening`);
  }
});

/* THE PRICE LIST, AS SUPPLIED. Normally a test that restates a constant is
   worth nothing — it passes by agreeing with whatever is there. These numbers
   are different: they are not a derived value, they are what ShedPro sells
   these windows for, handed over as a list. The failure this catches is a
   transposition — 5795 where 7495 belongs, a lift-up row typed at a bi-fold
   price — which every other test in this file is blind to, because a wrong
   number itemises, totals and flags exactly like a right one.
   Change these ONLY against a new list from the business. */
test('both price ladders are exactly what ShedPro quotes', () => {
  const expect = {
    'Black Bi-Fold Bar 48x36': 2495,
    'Black Bi-Fold Bar 60x42': 3495,
    'Black Bi-Fold Bar 72x42': 3995,
    'Black Bi-Fold Bar 96x48': 5795,
    'Black Lift-Up Bar 48x36': 3695,
    'Black Lift-Up Bar 60x42': 4995,
    'Black Lift-Up Bar 72x42': 5995,
    'Black Lift-Up Bar 96x48': 7495
  };
  for (const [key, price] of Object.entries(expect)) {
    assert.equal(SELL.windows[key], price, `${key} is priced at ${SELL.windows[key]}`);
  }
  // Every premium entry is covered above — a new size must be priced here too.
  assert.equal(premium().map((e) => e.key).sort().join('|'),
               Object.keys(expect).sort().join('|'));

  assert.equal(SELL.options.flat['Exterior Bar Ledge'], 695);

  /* The lift-up is the dearer of the two at every size. Not a preference —
     it is what the list says, and it is the shape a transposed pair breaks. */
  for (const size of ['48x36', '60x42', '72x42', '96x48']) {
    assert.ok(SELL.windows['Black Lift-Up Bar ' + size] > SELL.windows['Black Bi-Fold Bar ' + size],
      `at ${size} the lift-up is not above the bi-fold`);
  }
});

test('every premium window is priced explicitly, not by area', () => {
  for (const e of premium()) {
    assert.ok(sellWindowPriced({ type: e.key }),
      `${e.key} has no SELL.windows entry — it would quote at the nearest white vinyl`);
    assert.equal(sellWindowPrice({ type: e.key, w: e.w, h: e.h }), SELL.windows[e.key]);
  }
});

test('the area fallback is exactly what a missing price would do', () => {
  /* The hazard, demonstrated rather than described — if this stops being true
     the test above is guarding nothing and should be rewritten, not deleted. */
  const big = premium().reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b));
  const byArea = sellWindowPrice({ w: big.w, h: big.h });          // no type at all
  assert.ok(byArea > 0 && byArea < 1000,
    `the untyped fallback for a ${big.w}x${big.h} is $${byArea}`);
  assert.ok(SELL.windows[big.key] > byArea * 3,
    `${big.key} at $${SELL.windows[big.key]} should be far above the $${byArea} fallback, `
    + 'or there is nothing here worth protecting');
});

test('a placed bar window itemises at its own price, unflagged', () => {
  for (const e of premium()) {
    const { redline } = computePricing({
      style: 'gable', w: 12, l: 20, h: 9,
      windows: [{ wall: 'front', pos: 0.5, w: e.w, h: e.h, cy: 62, type: e.key, ledge: false }]
    });
    const lines = redline.windowSellLines || [];
    assert.equal(lines.length, 1, `${e.key} itemised as ${lines.length} lines`);
    assert.equal(lines[0].price, SELL.windows[e.key]);
    assert.equal(lines[0].label, windowDisplayName(e.key));
    assert.ok(/\bWindow\b/.test(lines[0].label), `"${lines[0].label}" names the product`);
    assert.ok(!lines[0].est, `${e.key} is flagged as an estimate`);
  }
  assert.ok(!(computePricing({ style:'gable', w:12, l:20, h:9,
      windows:[{ wall:'front', pos:0.5, w:72, h:42, cy:63, type:'Black Lift-Up Bar 72x42' }] })
    .redline.unpriced || []).some((u) => /Bar/.test(u)),
    'a bar window is being reported as unpriced');
});

test('the bar ledge is a line of its own, at one flat price', () => {
  /* Folded into the window's price it would be invisible: a customer turning
     the ledge off would watch the total drop with nothing on the quote to say
     what left. */
  const lifts = premium().filter((x) => /Lift-Up Bar/.test(x.key))
                         .sort((a, b) => a.w - b.w);
  const small = lifts[0], e = lifts[lifts.length - 1];
  assert.ok(e.w > small.w, 'the lift-up sizes are all the same width');
  const run = (ledge) => computePricing({ style:'gable', w:12, l:20, h:9,
    windows: [{ wall:'front', pos:0.5, w:e.w, h:e.h, cy:63, type:e.key, ledge }] });

  const on = run(undefined), off = run(false);      // undefined = the default
  const onLines = on.redline.windowSellLines, offLines = off.redline.windowSellLines;
  assert.equal(onLines.length, 2, 'the ledge should add a line');
  assert.equal(offLines.length, 1, 'ledge off should add nothing');
  const ledgeLine = onLines[1];
  assert.equal(ledgeLine.label, 'Exterior Bar Ledge');
  assert.ok(ledgeLine.price > 0, 'the ledge is on the quote at nothing');
  /* No footage on the label. It was priced per linear foot first and the line
     read "Exterior Bar Ledge 6ft"; against a flat fee that reads as a rate a
     customer can divide out and query. */
  assert.ok(!/\dft/.test(ledgeLine.label), `"${ledgeLine.label}" still carries a length`);

  // The difference in the TOTAL is exactly the ledge line, so the line is not
  // decoration over a price charged somewhere else as well.
  assert.equal(on.customer - off.customer, ledgeLine.price);

  /* ONE price per ledge, whatever the window. This is the assertion that
     flipped: while it was per-foot, an 8ft ledge cost more than a 4ft one and
     this test said so. ShedPro quotes it flat, so the two must now MATCH —
     and the same number has to reach both products. */
  assert.equal(sellBarLedge({ type: e.key, w: e.w }), sellBarLedge({ type: small.key, w: small.w }),
    'the ledge is still being priced by the foot');
  const fold = premium().find((x) => /Bi-Fold Bar/.test(x.key));
  assert.equal(sellBarLedge({ type: fold.key, w: fold.w }), ledgeLine.price,
    'the two products are quoting different prices for the same counter');
});

test('only a bar window gets a ledge', () => {
  for (const e of WINDOW_CATALOG) {
    const want = e.grp === 'Premium' && /\bBar\b/.test(e.key);
    assert.equal(sellBarLedge({ type: e.key, w: e.w }) > 0, want,
      `${e.key} ${want ? 'should' : 'should not'} price a bar ledge`);
  }
  /* Not by a regex on the key alone — the entry has to be IN THE CATALOG and
     in the Premium group. A key spelled like a bar window but not offered
     (an old saved design carrying a retired type, a typo) must not start
     charging for a countertop.
     The first version of this test used "White Barn Sash", which cannot fail:
     \bBar\b does not match "Barn", so it passed with the catalog check torn
     out. It needs a name that really would slip through. */
  assert.equal(sellBarLedge({ type: 'White Bar Sash 36x36', w: 36 }), 0,
    'a type that is not in the catalog at all is being charged for a bar ledge');
  assert.equal(sellBarLedge({ w: 72 }), 0);
});

test('how a bar window is opened never moves the price', () => {
  /* open / fold live on the placed window and travel with a saved design. The
     server has no opinion on either and must not acquire one by accident — a
     window that costs more folded left than right is the kind of thing nobody
     finds until a customer asks. The LEDGE is the one state that does cost,
     and it is checked above. */
  for (const e of premium()) {
    const base = { wall:'front', pos:0.5, w:e.w, h:e.h, cy:62, type:e.key, ledge:true };
    const states = [{}, { open:true }, { open:true, fold:'right' }, { fold:'right' }];
    const totals = states.map((st) => computePricing({ style:'gable', w:12, l:20, h:9,
      windows: [Object.assign({}, base, st)] }).customer);
    for (const t of totals) assert.equal(t, totals[0], `${e.key}: how it opens moved the price`);
  }
});
