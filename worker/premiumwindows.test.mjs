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
         windowDisplayName, computePricing } from './pricing.js';

const premium = () => WINDOW_CATALOG.filter((e) => e.grp === 'Premium');

test('the premium group exists and holds the bi-fold sizes', () => {
  const p = premium();
  assert.ok(p.length >= 3, `expected at least 3 premium windows, got ${p.length}`);
  const bifold = p.filter((e) => /Bi-Fold Bar/.test(e.key));
  assert.ok(bifold.length >= 3, 'the three bi-fold sizes are not all in the catalog');
  for (const e of bifold) {
    // Three equal panels, or the closed window is two lights and a remainder.
    assert.equal(e.w % 3, 0, `${e.key} is ${e.w}" wide and does not divide into three`);
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

test('a placed bi-fold itemises at its own price, unflagged', () => {
  const e = premium().find((x) => /Bi-Fold Bar/.test(x.key));
  const { redline } = computePricing({
    style: 'gable', w: 12, l: 20, h: 9,
    windows: [{ wall: 'front', pos: 0.5, w: e.w, h: e.h, cy: 62, type: e.key }]
  });
  const lines = redline.windowSellLines || [];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].price, SELL.windows[e.key]);
  assert.equal(lines[0].label, windowDisplayName(e.key));
  assert.ok(/\bWindow\b/.test(lines[0].label), `"${lines[0].label}" names the product`);
  assert.ok(!lines[0].est, 'a priced premium window should not be flagged as an estimate');
  assert.ok(!(redline.unpriced || []).some((u) => u.includes('Bi-Fold')),
    'the bi-fold is being reported as unpriced');
});

test('the fold state rides along and changes nothing about the price', () => {
  /* open / fold / ledge live on the placed window and travel with a saved
     design. The server has no opinion on any of them, and must not acquire
     one by accident — a window that costs more folded left than right is the
     kind of thing nobody finds until a customer asks. */
  const e = premium().find((x) => /Bi-Fold Bar/.test(x.key));
  const base = { wall: 'front', pos: 0.5, w: e.w, h: e.h, cy: 62, type: e.key };
  const states = [
    {}, { open: true }, { open: true, fold: 'right' }, { ledge: false },
    { open: true, fold: 'right', ledge: false }
  ];
  const totals = states.map((st) =>
    computePricing({ style: 'gable', w: 12, l: 20, h: 9,
                     windows: [Object.assign({}, base, st)] }).customer);
  for (const t of totals) assert.equal(t, totals[0], 'the fold state moved the price');
});
