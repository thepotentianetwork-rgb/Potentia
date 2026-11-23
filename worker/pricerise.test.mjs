/* The Nov 2026 price rise (Nando, 23 Nov 2026): every designer price +15%,
   doors +25%, applied by saving the raised snapshot in pricing_config.
   These pin the code side: the four former constants are now SELL groups that
   change nothing at their shipped values, and do what they say when raised.
   Run: node --test worker/pricerise.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, applyPricingOverrides, pricingDefaults, SELL,
         flooringSellRateCents, flooringSellMinCents, rollUpColorUpcharge, wallAreaFt } from './pricing.js';

function withOverride(o, fn) {
  const before = pricingDefaults();
  try { applyPricingOverrides(o); return fn(); }
  finally { Object.keys(SELL).forEach(k => delete SELL[k]); Object.assign(SELL, before.SELL); }
}

test('shipped values of the new groups equal the old constants', () => {
  assert.equal(SELL.finishFloor.rate, 7);
  assert.deepEqual(SELL.rollupColor, { white: 0, black: 100, brown: 100 });
  assert.deepEqual(SELL.upliftPct, { flooring: 0, baseProxy: 0 });
  assert.equal(flooringSellRateCents('better'), 795);
  assert.equal(flooringSellMinCents('best'), 149500);
  assert.equal(rollUpColorUpcharge({ style: 'rollup', color: 'black' }), 100);
});

test('flooring uplift raises rate and minimum ~15%', () => {
  withOverride({ SELL: { upliftPct: { flooring: 15 } } }, () => {
    assert.equal(flooringSellRateCents('better'), 915);   // 7.95 -> 9.15
    assert.equal(flooringSellMinCents('better'), 137500); // 1195 -> 1375
  });
});

test('roll-up colour upcharge follows SELL.rollupColor', () => {
  withOverride({ SELL: { rollupColor: { black: 125, brown: 125 } } }, () => {
    assert.equal(rollUpColorUpcharge({ style: 'rollup', color: 'brown' }), 125);
    assert.equal(rollUpColorUpcharge({ style: 'rollup', color: 'white' }), 0);
    assert.equal(rollUpColorUpcharge({ style: 'basic', color: 'black' }), 0);
  });
});

test('base proxy (size with no sheet cell) scales with upliftPct.baseProxy', () => {
  const cfg = { style: 'gable', w: 20, l: 32, h: 8 };
  const a = computePricing(cfg).redline;
  assert.equal(a.baseSource, 'proxy');
  withOverride({ SELL: { upliftPct: { baseProxy: 15 } } }, () => {
    const b = computePricing(cfg).redline;
    assert.ok(Math.abs(b.baseProxy / a.baseProxy - 1.15) < 1e-9);
  });
});

test('finish floor rate is what paint + labour is topped up to', () => {
  const cfg = { style: 'gable', w: 12, l: 20, h: 8 };
  withOverride({ SELL: { exteriorPaint: { flat: 1610 }, labor: { 8: 8.91 }, finishFloor: { rate: 8.05 } } }, () => {
    const r = computePricing(cfg).redline;
    const wall = wallAreaFt(12, 20, 8);
    assert.ok(Math.abs((r.paintSell + r.laborSell + r.finishRecovered) - Math.max(8.05 * wall, r.paintSell + r.laborSell)) < 1e-6);
  });
});
