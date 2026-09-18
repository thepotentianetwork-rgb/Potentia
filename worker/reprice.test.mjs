/* Showing an already-sent quote under current pricing.
 *
 * Redlines freeze at submit time, so a quote written before paint and labour
 * were split carries one paintSell charged at $7 per sqft of WALL area and no
 * laborSell at all. repriceFinish recomputes just those two figures from the
 * stored config, so the document shows what the business charges today without
 * the quote being re-issued.
 *
 * Only those two. Everything else on that redline is what the customer was
 * quoted and must survive untouched.
 *
 * Run: node --test worker/reprice.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repriceFinish, SELL, pricingDefaults, applyPricingOverrides } from './pricing.js';

const PAINT = 1400;
const LABOR = { 6: 5.00, 7: 6.50, 8: 7.75, 9: 9.75, 10: 11.50, 12: 14.50 };

function withOverride(o, fn) {
  const before = pricingDefaults();
  try { applyPricingOverrides(o); return fn(); }
  finally {
    Object.keys(SELL).forEach(k => delete SELL[k]);
    Object.assign(SELL, before.SELL);
  }
}

/* A redline as it was actually written before the split: 12x18, 8ft walls,
   463 sqft of wall at the old $7. */
const legacyRedline = () => ({
  marginPrice: 8000,
  paintSell: 3238, paintSellName: 'Exterior Paint (463 sqft)',
  sidingSell: 1600, sidingSellName: 'Board & Batten',
  heightSell: 0, elecSell: 3000, elecSellName: 'Essential Electrical'
});
const legacyConfig = { w: 12, l: 18, h: 8, siding: 'board-batten' };

test('the finish is recomputed to what the same build costs today', () => {
  const out = repriceFinish(legacyRedline(), legacyConfig);
  assert.equal(out.paintSell, PAINT);
  assert.equal(out.paintSellName, 'Exterior Paint');
  assert.equal(Math.round(out.laborSell), Math.round(LABOR[8] * 216));
  assert.equal(out.laborSellName, 'Build Labor (216 sqft)');
});

/* The customer agreed to a number. Re-pricing changes where that money is
   shown going, not how much of it there is - the shortfall between the fitted
   rates and what this quote originally charged is recovered into the base
   shed, so the total holds exactly. */
test('the total the customer was given does not move', () => {
  const out = repriceFinish(legacyRedline(), legacyConfig);
  assert.equal(Math.round(out.recovered), Math.round(3238 - PAINT - LABOR[8] * 216));
  assert.equal(Math.round(out.delta), 0, 'nothing moves');
  assert.equal(Math.round(out.paintSell + out.laborSell + out.recovered), 3238);
});

/* Not every quote gets cheaper. A small shed has little wall and a lot of
   flat paint fee, so it goes UP — a customer holding one of those quotes is
   being shown a higher number than they were sent. Pinned so that is a
   decision on the record rather than a surprise. */
/* The top-up only ever tops up. Where the fitted rates already charge more than
   this quote originally did, there is nothing to recover and the rise is
   reported rather than hidden. */
test('a small shed is repriced UPWARDS, and the delta says so', () => {
  const small = { marginPrice: 4000, paintSell: 1727, paintSellName: 'Exterior Paint (247 sqft)' };
  const out = repriceFinish(small, { w: 8, l: 8, h: 8 });
  assert.equal(out.recovered, 0, 'nothing to recover when already over');
  assert.ok(out.delta > 0, `expected a rise, got ${out.delta}`);
  assert.equal(Math.round(out.delta), Math.round(PAINT + LABOR[8] * 64 - 1727));
});

test('nothing else on the redline is touched', () => {
  const before = legacyRedline();
  const out = repriceFinish(before, legacyConfig);
  /* repriceFinish returns a patch and mutates nothing itself */
  assert.equal(before.paintSell, 3238, 'the input redline is left alone');
  assert.deepEqual(Object.keys(out).sort(),
    ['delta', 'laborSell', 'laborSellName', 'paintSell', 'paintSellName', 'recovered']);
});

test('a quote already on the new model is left alone', () => {
  const current = { paintSell: 1400, paintSellName: 'Exterior Paint', laborSell: 1674 };
  assert.equal(repriceFinish(current, legacyConfig), null);
});

test('a pine quote is left alone, having never paid either line', () => {
  assert.equal(repriceFinish(legacyRedline(), { ...legacyConfig, siding: 'pine' }), null);
});

test('a quote with no paint charge is left alone', () => {
  assert.equal(repriceFinish({ marginPrice: 5000, paintSell: 0 }, legacyConfig), null);
});

test('a quote whose config cannot be read is left as written, never guessed', () => {
  for (const cfg of [null, undefined, {}, { w: 12 }, { w: 12, l: 18 },
                     { w: 0, l: 18, h: 8 }, { w: 'twelve', l: 18, h: 8 }]) {
    assert.equal(repriceFinish(legacyRedline(), cfg), null,
      `config ${JSON.stringify(cfg)} must not produce a price`);
  }
});

test('a missing or malformed redline is handled', () => {
  assert.equal(repriceFinish(null, legacyConfig), null);
  assert.equal(repriceFinish('nope', legacyConfig), null);
  assert.equal(repriceFinish({}, legacyConfig), null);
});

test('the wall height on the stored config picks the labor rate', () => {
  for (const h of [6, 7, 8, 9, 10, 12]) {
    const out = repriceFinish(legacyRedline(), { ...legacyConfig, h });
    assert.equal(Math.round(out.laborSell), Math.round(LABOR[h] * 216), `${h}ft walls`);
  }
});

test('a stored height with no rate of its own uses the 8ft rate', () => {
  const out = repriceFinish(legacyRedline(), { ...legacyConfig, h: 11 });
  assert.equal(Math.round(out.laborSell), Math.round(LABOR[8] * 216));
});

test("the owner's dashboard edits reach re-priced quotes too", () => {
  withOverride({ SELL: { exteriorPaint: { flat: 900 }, labor: { 8: 6 } } }, () => {
    const out = repriceFinish(legacyRedline(), legacyConfig);
    assert.equal(out.paintSell, 900);
    assert.equal(Math.round(out.laborSell), Math.round(6 * 216));
  });
});
