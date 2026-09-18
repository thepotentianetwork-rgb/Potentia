/* Exterior paint is a FLAT fee; build labor is per sq ft of SHED FLOOR area.
 *
 * The history matters, because each step was a correction of the last:
 *   1. A three-tier table ($4 under 100 sqft of wall, $5 from 100, $7 from
 *      200) that was never a table. Wall area is 2*(W+D)*wallH, so even a 6x6
 *      with 6ft walls is 144 sqft and every shed sold cleared the top break.
 *      A flat $7 in disguise, and tiered the wrong way round.
 *   2. A flat $4/sqft of wall, with the other $3 split out as labor. Same
 *      total, honest labels.
 *   3. This: paint does not actually scale with area at all — a small shed
 *      takes nearly the same paint as a big one. Time does. So paint is a flat
 *      fee and labor carries the size, priced on the shed's own footprint.
 *
 * Run: node --test worker/paint.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, SELL, pricingDefaults, applyPricingOverrides } from './pricing.js';

const PAINT = 1400;
const LABOR = { 6: 5.00, 7: 6.50, 8: 7.75, 9: 9.75, 10: 11.50, 12: 14.50 };

/* SELL is live module state shared by every later test in the run, so an
   override test has to hand it back exactly as it found it. */
function withOverride(o, fn) {
  const before = pricingDefaults();
  try { applyPricingOverrides(o); return fn(); }
  finally {
    Object.keys(SELL).forEach(k => delete SELL[k]);
    Object.assign(SELL, before.SELL);
  }
}

const SIZES = [
  { w: 6,  l: 6,  h: 6  },
  { w: 8,  l: 8,  h: 8  },
  { w: 10, l: 12, h: 8  },
  { w: 12, l: 16, h: 9  },
  { w: 12, l: 20, h: 10 },
  { w: 16, l: 24, h: 10 }
];

test('paint is the same fee on every shed, whatever the size', () => {
  for (const s of SIZES) {
    const { redline } = computePricing({ style: 'gable', ...s });
    assert.equal(redline.paintSell, PAINT, `${s.w}x${s.l} pays the flat fee`);
  }
});

test('paint does not move with wall height either', () => {
  const heights = [6, 8, 9, 10, 12].map(h => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h });
    return redline.paintSell;
  });
  assert.deepEqual(heights, heights.map(() => PAINT));
});

test('the paint line is not labelled with an area it is no longer charged on', () => {
  const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10 });
  assert.equal(redline.paintSellName, 'Exterior Paint');
  assert.ok(!/sqft/i.test(redline.paintSellName), 'no square footage in the name');
});

test('labor is the rate times the SHED footprint, not the wall area', () => {
  for (const s of SIZES) {
    const { redline } = computePricing({ style: 'gable', ...s });
    assert.equal(
      Math.round(redline.laborSell), Math.round(LABOR[s.h] * s.w * s.l),
      `${s.w}x${s.l} @ ${s.h}ft: labor bills on ${s.w * s.l} sqft of shed`
    );
  }
});

test('labor steps with wall height, so a taller shed is not built for the same', () => {
  const at = h => computePricing({ style: 'gable', w: 10, l: 12, h }).redline.laborSell;
  const heights = [6, 7, 8, 9, 10, 12];
  for (let i = 1; i < heights.length; i++) {
    assert.ok(at(heights[i]) > at(heights[i - 1]),
      `${heights[i]}ft walls cost more labor than ${heights[i - 1]}ft`);
  }
  assert.equal(Math.round(at(12) / at(6) * 100) / 100, Math.round(LABOR[12] / LABOR[6] * 100) / 100);
});

test('a bigger footprint costs more labor at the same height', () => {
  const small = computePricing({ style: 'gable', w: 10, l: 12, h: 9 }).redline.laborSell;
  const big = computePricing({ style: 'gable', w: 12, l: 20, h: 9 }).redline.laborSell;
  assert.ok(big > small);
});

test('a height with no rate of its own is built at the standard 8ft rate', () => {
  /* 11ft is not in the table. wallHObjFor already treats an unknown height as
     standard, and the labor rate has to agree with it rather than price at 0. */
  const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 11 });
  assert.equal(Math.round(redline.laborSell), Math.round(LABOR[8] * 120));
});

test('tombstoning a height rate restores the shipped one, it does not zero it', () => {
  withOverride({ SELL: { labor: { 9: null } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 9 });
    assert.equal(Math.round(redline.laborSell), Math.round(LABOR[9] * 120),
      'a deleted height rate must not price labor at zero');
  });
});

test('labor is named with the shed sqft, which is the footprint', () => {
  const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10 });
  assert.equal(redline.laborSellName, 'Build Labor (240 sqft)');
});

test('pine is stained, not painted, so it is charged neither', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9, siding: 'pine' });
  assert.equal(redline.paintSell, 0);
  assert.equal(redline.paintSellName, '');
  assert.equal(redline.laborSell, 0);
  assert.equal(redline.laborSellName, '');
});

test('paint and labor both reach the customer total', () => {
  const build = { style: 'gable', w: 10, l: 16, h: 9 };
  const full = computePricing(build);
  const none = withOverride(
    { SELL: { exteriorPaint: { flat: 0 }, labor: { 9: 0 } } },
    () => computePricing(build).customer
  );
  assert.equal(
    Math.round(full.customer - none),
    Math.round(full.redline.paintSell + full.redline.laborSell),
    'the total moves by exactly paint plus labor'
  );
});

test('the owner can move both, and zero either deliberately', () => {
  withOverride({ SELL: { exteriorPaint: { flat: 900 }, labor: { 8: 10 } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 8 });
    assert.equal(redline.paintSell, 900);
    assert.equal(Math.round(redline.laborSell), 1200);
  });
  withOverride({ SELL: { exteriorPaint: { flat: 0 }, labor: { 8: 0 } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 8 });
    assert.equal(redline.paintSell, 0);
    assert.equal(redline.laborSell, 0);
  });
});

/* The one that matters in production: the owner's saved snapshot in D1 predates
   every one of these shapes. It carries the original under/mid/over tier keys
   and no `flat`, no `rate`. It layers OVER the shipped defaults and never
   deletes from them, so the new keys have to survive underneath it. */
test('a saved override from the tier era still prices paint and labor correctly', () => {
  const legacy = { SELL: { exteriorPaint: { under: 4, mid: 5, over: 7, breakLo: 100, breakHi: 200 } } };
  withOverride(legacy, () => {
    const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10 });
    assert.equal(redline.paintSell, PAINT, 'the flat fee survives a stale snapshot');
    assert.equal(Math.round(redline.laborSell), Math.round(LABOR[10] * 240));
  });
});

test('a tombstoned fee or rate falls back to shipped, never to free', () => {
  withOverride({ SELL: { exteriorPaint: { flat: null }, labor: { 8: null } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 8 });
    assert.equal(redline.paintSell, PAINT, 'paint must never silently fall to $0');
    assert.equal(Math.round(redline.laborSell), Math.round(LABOR[8] * 120));
  });
});

/* The fee and rate were fitted against the STANDARD 8ft wall, where the change
   of basis was meant to be near-invisible. This guards that. */
test('at the standard 8ft wall, the change of basis held prices still', () => {
  for (const s of [{ w: 6, l: 8 }, { w: 8, l: 8 }, { w: 8, l: 12 }, { w: 10, l: 12 },
                   { w: 10, l: 16 }, { w: 12, l: 16 }, { w: 12, l: 20 }, { w: 16, l: 24 }]) {
    const { redline } = computePricing({ style: 'gable', ...s, h: 8 });
    const wasCharged = 7 * 2 * (s.w + s.l) * 7.71;          // the old $7/sqft of wall
    const nowCharged = redline.paintSell + redline.laborSell;
    assert.ok(Math.abs(nowCharged - wasCharged) < 300,
      `${s.w}x${s.l} moved $${Math.round(nowCharged - wasCharged)} (was $${Math.round(wasCharged)}, now $${Math.round(nowCharged)})`);
  }
});

/* The height steps exist precisely so this is NOT true any more. Pricing on
   footprint alone handed a 12x20 with 10ft walls about $1,220 off, because none
   of its extra 147 sqft of wall reached paint or labor. The per-height rates
   put that back. */
test('a taller shed is no longer quietly discounted', () => {
  const WALLH = { 8: 7.71, 9: 9, 10: 10, 12: 12 };
  for (const s of [{ w: 10, l: 16, h: 9 }, { w: 12, l: 16, h: 9 },
                   { w: 12, l: 20, h: 10 }, { w: 16, l: 24, h: 10 }, { w: 16, l: 32, h: 12 }]) {
    const { redline } = computePricing({ style: 'gable', ...s });
    const wasCharged = 7 * 2 * (s.w + s.l) * WALLH[s.h];
    const nowCharged = redline.paintSell + redline.laborSell;
    const drift = Math.abs(nowCharged - wasCharged);
    assert.ok(drift < 900,
      `${s.w}x${s.l} @ ${s.h}ft moved $${Math.round(drift)} (was $${Math.round(wasCharged)}, now $${Math.round(nowCharged)})`);
  }
});

/* Same footprint, twice the wall, should not be anywhere near the same price. */
test('a 12ft-wall shed costs meaningfully more than a 6ft one of the same footprint', () => {
  const short = computePricing({ style: 'gable', w: 10, l: 12, h: 6 });
  const tall = computePricing({ style: 'gable', w: 10, l: 12, h: 12 });
  const gap = tall.redline.laborSell - short.redline.laborSell;
  assert.ok(gap > 1000, `labor gap is only $${Math.round(gap)}`);
  assert.ok(tall.customer > short.customer);
});
