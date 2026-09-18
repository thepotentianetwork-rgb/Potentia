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
const LABOR = 7.75;

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
      Math.round(redline.laborSell), Math.round(LABOR * s.w * s.l),
      `${s.w}x${s.l}: labor bills on ${s.w * s.l} sqft of shed`
    );
  }
});

test('labor tracks footprint and ignores wall height', () => {
  const base = computePricing({ style: 'gable', w: 10, l: 12, h: 8 }).redline.laborSell;
  for (const h of [6, 9, 10, 12]) {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h });
    assert.equal(redline.laborSell, base, `${h}ft walls bill the same labor`);
  }
  const bigger = computePricing({ style: 'gable', w: 12, l: 20, h: 8 }).redline.laborSell;
  assert.ok(bigger > base, 'a bigger footprint does cost more labor');
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

test('both reach the customer total', () => {
  const build = { style: 'gable', w: 10, l: 16, h: 9 };
  const full = computePricing(build).customer;
  const none = withOverride(
    { SELL: { exteriorPaint: { flat: 0 }, labor: { rate: 0 } } },
    () => computePricing(build).customer
  );
  const { redline } = computePricing(build);
  assert.equal(
    Math.round(full - none),
    Math.round(redline.paintSell + redline.laborSell),
    'paint and labor together move the total by exactly their sum'
  );
});

test('the owner can move both, and zero either deliberately', () => {
  withOverride({ SELL: { exteriorPaint: { flat: 900 }, labor: { rate: 10 } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 8 });
    assert.equal(redline.paintSell, 900);
    assert.equal(Math.round(redline.laborSell), 1200);
  });
  withOverride({ SELL: { exteriorPaint: { flat: 0 }, labor: { rate: 0 } } }, () => {
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
    assert.equal(Math.round(redline.laborSell), Math.round(LABOR * 240));
  });
});

test('a tombstoned fee or rate falls back to shipped, never to free', () => {
  withOverride({ SELL: { exteriorPaint: { flat: null }, labor: { rate: null } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 12, h: 8 });
    assert.equal(redline.paintSell, PAINT, 'paint must never silently fall to $0');
    assert.equal(Math.round(redline.laborSell), Math.round(LABOR * 120));
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

/* Taller walls DO come out cheaper than they used to, and that is not a bug to
   be quietly patched — it falls straight out of pricing on footprint, which is
   what was asked for. A 12x20 with 10ft walls has 640 sqft of wall against 493
   at 8ft, and none of that difference reaches paint or labor any more.
   Pinned so the size of the cut is visible and nobody changes it by accident.
   The wall height upcharge still scales with wall area, so height is not free
   overall — it just no longer feeds these two lines. */
test('pricing on footprint means taller walls are charged less than they were', () => {
  const cut = (w, l, h, wallH) => {
    const { redline } = computePricing({ style: 'gable', w, l, h });
    return (redline.paintSell + redline.laborSell) - 7 * 2 * (w + l) * wallH;
  };
  const tall = cut(12, 20, 10, 10);
  assert.ok(tall < -1000 && tall > -1400,
    `a 12x20 with 10ft walls is about $1,220 cheaper on these two lines, got $${Math.round(tall)}`);

  /* and the taller the wall, the bigger the cut */
  assert.ok(cut(10, 12, 12, 12) < cut(10, 12, 9, 9), '12ft walls are cut harder than 9ft');

  /* height still costs money, just not here */
  const a = computePricing({ style: 'gable', w: 10, l: 12, h: 8 }).customer;
  const b = computePricing({ style: 'gable', w: 10, l: 12, h: 12 }).customer;
  assert.ok(b > a, 'a taller shed still costs more overall, via the wall height upcharge');
});
