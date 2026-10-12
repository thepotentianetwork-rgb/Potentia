// Loft placement (Nando, 12 Oct 2026): long side or short side.
import test from 'node:test'; import assert from 'node:assert/strict';
import { computePricing } from './pricing.js';
import { loftSpec } from './quotelines.js';
const base = { style: 'gable', w: 12, l: 16, h: 9, loft: '4-back' };
test('a design with no loftSide prices exactly as before (front/back walls)', () => {
  const a = computePricing(base), b = computePricing({ ...base, loftSide: 'ends' });
  assert.equal(a.customer, b.customer); assert.equal(a.redline.loftSell, 4 * 12 * 3); assert.match(a.redline.loftSellName, /Back Gable/);
});
test('side walls: same $3/sqft over the length; dual capped at half the width', () => {
  const s = computePricing({ ...base, loftSide: 'sides' });
  assert.equal(s.redline.loftSell, 4 * 16 * 3); assert.match(s.redline.loftSellName, /Right Side/);
  const d = computePricing({ ...base, loft: '8-dual', loftSide: 'sides' });
  assert.equal(d.redline.loftSell, 6 * 16 * 2 * 3);
});
test('quote wording names the walls and long/short side from the real size', () => {
  assert.equal(loftSpec(base), '4\u2032 back gable loft \u00b7 front & back walls, 12\u2032 (short side)');
  assert.equal(loftSpec({ ...base, loftSide: 'sides' }), '4\u2032 right side loft \u00b7 side walls, 16\u2032 (long side)');
  assert.equal(loftSpec({ loft: 'none' }), null);
  assert.equal(loftSpec({ loft: '6-front' }), '6\u2032 front gable loft');
});
