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

/* Probed ABOVE the legacy yardstick on purpose. Below it the shortfall top-up
   closes any gap, so zeroing the fee would leave the total unmoved - correct
   behaviour, but it tells you nothing about whether the money reaches the
   total. Pushed over the yardstick the top-up is 0 and the fee is visible. */
test('paint and labor reach the customer total', () => {
  const build = { style: 'gable', w: 10, l: 16, h: 9 };
  const hi = withOverride({ SELL: { exteriorPaint: { flat: 6000 } } },
    () => computePricing(build));
  assert.equal(hi.redline.finishRecovered, 0, 'well over the yardstick, so no top-up');

  const hi2 = withOverride({ SELL: { exteriorPaint: { flat: 6500 } } },
    () => computePricing(build));
  assert.equal(Math.round(hi2.customer - hi.customer), 500,
    'every dollar of the fee lands on the total');
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

/* ── THE SHORTFALL TOP-UP ────────────────────────────────────────────────────
 * The flat fee and the per-height rates were FITTED to the old $7-a-wall-foot
 * finish charge, and a fit is not exact — mid-size sheds came out a few hundred
 * under. That difference is recovered into the base shed price, so no shed is
 * quoted for less than it used to be. It is a top-up only: where the fitted
 * rates already charge more, nothing is handed back.
 */
const LEGACY = 7;
const WALLH = { 6: 6, 7: 7, 8: 7.71, 9: 9, 10: 10, 12: 12 };
const legacyFinish = (w, l, h) => LEGACY * 2 * (w + l) * WALLH[h];

test('no shed is quoted for less finish than it used to be', () => {
  for (const s of [{ w: 8, l: 8, h: 8 }, { w: 8, l: 12, h: 8 }, { w: 10, l: 12, h: 8 },
                   { w: 10, l: 16, h: 9 }, { w: 12, l: 16, h: 9 }, { w: 12, l: 20, h: 9 },
                   { w: 12, l: 20, h: 10 }, { w: 14, l: 24, h: 10 }, { w: 16, l: 24, h: 10 },
                   { w: 16, l: 32, h: 12 }]) {
    const { redline } = computePricing({ style: 'gable', ...s });
    const charged = redline.paintSell + redline.laborSell + redline.finishRecovered;
    assert.ok(charged >= legacyFinish(s.w, s.l, s.h) - 1,
      `${s.w}x${s.l} @ ${s.h}ft charges $${Math.round(charged)}, under the old $${Math.round(legacyFinish(s.w, s.l, s.h))}`);
  }
});

test('the top-up closes the gap exactly, never overshoots', () => {
  for (const s of [{ w: 10, l: 12, h: 8 }, { w: 12, l: 16, h: 9 }, { w: 12, l: 20, h: 10 }]) {
    const { redline } = computePricing({ style: 'gable', ...s });
    assert.ok(redline.finishRecovered > 0, `${s.w}x${s.l} @ ${s.h}ft has a gap to close`);
    assert.equal(
      Math.round(redline.paintSell + redline.laborSell + redline.finishRecovered),
      Math.round(legacyFinish(s.w, s.l, s.h)),
      'lands on the old figure, not past it'
    );
  }
});

test('nothing is handed back where the new rates already charge more', () => {
  for (const s of [{ w: 8, l: 8, h: 8 }, { w: 16, l: 24, h: 10 }, { w: 16, l: 32, h: 12 }]) {
    const { redline } = computePricing({ style: 'gable', ...s });
    assert.equal(redline.finishRecovered, 0);
    assert.ok(redline.paintSell + redline.laborSell > legacyFinish(s.w, s.l, s.h),
      'these builds are over the old figure and stay there');
  }
});

test('the top-up lands in the base shed, not in a line of its own', () => {
  const build = { style: 'gable', w: 12, l: 20, h: 10 };
  const { redline } = computePricing(build);
  assert.ok(redline.finishRecovered > 0);

  /* marginPrice is what the quote prints as Base Shed, so the top-up has to be
     inside it — and it has to reach the customer total exactly once. */
  const bare = computePricing({ ...build, siding: 'pine' });
  assert.equal(bare.redline.finishRecovered, 0, 'pine pays no finish, so nothing to recover');
  assert.ok(redline.marginPrice > bare.redline.marginPrice,
    'the recovered money is inside the base shed price');
});

test('pine recovers nothing, having never paid the old charge', () => {
  const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10, siding: 'pine' });
  assert.equal(redline.paintSell, 0);
  assert.equal(redline.laborSell, 0);
  assert.equal(redline.finishRecovered, 0);
});

test('the top-up follows the owner down if they cut the paint fee', () => {
  const build = { style: 'gable', w: 12, l: 20, h: 10 };
  const base = computePricing(build).redline.finishRecovered;
  withOverride({ SELL: { exteriorPaint: { flat: 700 } } }, () => {
    const { redline } = computePricing(build);
    assert.equal(Math.round(redline.finishRecovered), Math.round(base + 700),
      'cutting the fee widens the gap, and the top-up covers it');
    assert.equal(
      Math.round(redline.paintSell + redline.laborSell + redline.finishRecovered),
      Math.round(legacyFinish(12, 20, 10)),
      'the shed still totals the same either way'
    );
  });
});
