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
  assert.equal(sizes(/Bi-Fold Bar/), '60x36,72x40,96x40');
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

test('the bar ledge is a line of its own, not folded into the window', () => {
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
  assert.match(ledgeLine.label, /Bar Ledge/, `"${ledgeLine.label}" should name the ledge`);
  assert.match(ledgeLine.label, new RegExp(String(e.w / 12) + 'ft'), 'the line should say how long it is');
  assert.ok(ledgeLine.price > 0, 'the ledge is on the quote at nothing');

  // The difference in the TOTAL is exactly the ledge line, so the line is not
  // decoration over a price charged somewhere else as well.
  assert.equal(on.customer - off.customer, ledgeLine.price);
  // It scales with the window, so an 8ft bar costs more to counter than a 4ft
  // one. Measured between the widest and the narrowest lift-up rather than
  // between two entries that happened to be the same size — which is what the
  // first version of this compared, and it passed by comparing a thing to itself.
  assert.ok(sellBarLedge({ type: e.key, w: e.w }) > sellBarLedge({ type: small.key, w: small.w }),
    `a ${e.w}" ledge should cost more than a ${small.w}" one`);
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
