/* Exterior paint is a flat rate per sq ft of WALL area.
 *
 * It used to be a three-tier table — $4 under 100 sqft, $5 from 100, $7 from
 * 200 — which read like volume pricing but never behaved like it. Wall area is
 * 2 * (W + D) * wallH, so even an 8x8 with 8ft walls is 247 sqft: every shed
 * ever quoted cleared the top break and paid $7 on every square foot. The two
 * lower rates were dead code, and the table ran backwards anyway, charging the
 * most per sqft on the biggest jobs.
 *
 * Run: node --test worker/paint.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, wallAreaFt, SELL, pricingDefaults, applyPricingOverrides } from './pricing.js';

const RATE = 4;

/* Every override test has to hand the module back exactly as it found it —
   SELL is live module state shared by every later test in the run. */
function withOverride(o, fn) {
  const before = pricingDefaults();
  try { applyPricingOverrides(o); return fn(); }
  finally {
    Object.keys(SELL).forEach(k => delete SELL[k]);
    Object.assign(SELL, before.SELL);
  }
}

const SIZES = [
  { w: 8,  l: 8,  h: 8 },
  { w: 10, l: 12, h: 8 },
  { w: 12, l: 16, h: 9 },
  { w: 12, l: 20, h: 10 },
  { w: 16, l: 24, h: 10 }
];

test('paint is the flat rate times wall area, at every size', () => {
  for (const s of SIZES) {
    const { redline } = computePricing({ style: 'gable', ...s });
    const area = wallAreaFt(s.w, s.l, s.h);
    assert.equal(
      Math.round(redline.paintSell),
      Math.round(RATE * area),
      `${s.w}x${s.l} @ ${s.h}ft: ${area} sqft should paint at $${RATE}/sqft`
    );
  }
});

test('the rate per sq ft never changes with size', () => {
  const rates = SIZES.map(s => {
    const { redline } = computePricing({ style: 'gable', ...s });
    return redline.paintSell / wallAreaFt(s.w, s.l, s.h);
  });
  for (const r of rates) assert.ok(Math.abs(r - RATE) < 1e-9, `rate drifted to ${r}`);
});

test('the old top tier is gone — a big shed is not paying $7/sqft', () => {
  const s = { w: 16, l: 24, h: 10 };
  const { redline } = computePricing({ style: 'gable', ...s });
  const area = wallAreaFt(s.w, s.l, s.h);
  assert.equal(Math.round(redline.paintSell), Math.round(RATE * area));
  assert.ok(redline.paintSell < 7 * area, 'the $7 tier must not be reachable');
});

test('the line still names the wall sqft it charged for', () => {
  const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10 });
  const area = Math.round(wallAreaFt(12, 20, 10));
  assert.equal(redline.paintSellName, `Exterior Paint (${area} sqft)`);
});

test('pine is stained, not painted, so it is charged no paint', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9, siding: 'pine' });
  assert.equal(redline.paintSell, 0);
  assert.equal(redline.paintSellName, '');
});

test('the owner can still move the rate', () => {
  withOverride({ SELL: { exteriorPaint: { rate: 6 } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9 });
    assert.equal(Math.round(redline.paintSell), Math.round(6 * wallAreaFt(10, 16, 9)));
  });
});

test('the owner can zero paint out deliberately', () => {
  withOverride({ SELL: { exteriorPaint: { rate: 0 } } }, () => {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9 });
    assert.equal(redline.paintSell, 0);
  });
});

/* The one that matters in production: the owner's saved pricing snapshot in D1
   predates the flat rate, so it carries under/mid/over and no `rate` at all. It
   is layered OVER the shipped defaults and never deletes from them, so `rate`
   has to survive underneath and the dead tier keys have to stay ignored. */
test('a saved override from the tier era neither resurrects $7 nor zeroes paint', () => {
  const legacy = { SELL: { exteriorPaint: { under: 4, mid: 5, over: 7, breakLo: 100, breakHi: 200 } } };
  withOverride(legacy, () => {
    const area = wallAreaFt(12, 20, 10);
    const { redline } = computePricing({ style: 'gable', w: 12, l: 20, h: 10 });
    assert.equal(Math.round(redline.paintSell), Math.round(RATE * area),
      'a stale snapshot must still price paint at the shipped flat rate');
  });
});

test('a tombstoned rate falls back to the shipped rate, not to free', () => {
  withOverride({ SELL: { exteriorPaint: { rate: null } } }, () => {
    const area = wallAreaFt(10, 16, 9);
    const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9 });
    assert.equal(Math.round(redline.paintSell), Math.round(RATE * area),
      'paint must never silently fall to $0');
  });
});

/* Pine is the wrong baseline for this — it swaps in a siding upcharge and a
   mandatory stain, so it is not the same shed minus paint. Zeroing the rate on
   an otherwise identical build is. */
test('paint is still folded into the customer price', () => {
  const build = { style: 'gable', w: 10, l: 16, h: 9 };
  const painted = computePricing(build);
  assert.ok(painted.redline.paintSell > 0);
  const unpainted = withOverride({ SELL: { exteriorPaint: { rate: 0 } } },
    () => computePricing(build));
  assert.equal(
    Math.round(painted.customer - unpainted.customer),
    Math.round(painted.redline.paintSell),
    'the paint line has to reach the total, to the dollar'
  );
});
