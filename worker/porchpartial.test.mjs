/* PARTIAL PORCHES ON THE SERVER.
 *
 * A porch shorter than its wall (porchLen < span) is priced on its OWN area,
 * depth x length, at the same per-sqft rate as a full porch, with a flat and
 * a minimum hook (SELL.porchPartial, both 0 = off) for when the numbers are
 * set. Its depth comes out of the enclosed room only under the porch, so the
 * enclosed area loses depth x length, not depth x the whole wall. A config
 * with no porchLen is the full porch it always was.
 *
 * Run: node --experimental-sqlite --test worker/porchpartial.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { porchLineFor, applyPricingOverrides, porchIsPartialFor, porchLenFtFor, computePricing } from './pricing.js';

const ORIGIN = 'https://shedpro-utah.com';
const ENV = { DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}), bind() { return this; } }) } };
async function quote(config) {
  const res = await worker.fetch(new Request('https://x/shed/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ config })
  }), ENV, { waitUntil() {} });
  assert.equal(res.status, 200);
  return res.json();
}

test('helpers: a length shorter than the wall is partial, 0 or the whole wall is full', () => {
  assert.equal(porchIsPartialFor('side', 4, 4, 10, 20), true);
  assert.equal(porchIsPartialFor('side', 4, 0, 10, 20), false);
  assert.equal(porchIsPartialFor('side', 4, 20, 10, 20), false);
  assert.equal(porchIsPartialFor('front', 4, 6, 12, 16), true);
  assert.equal(porchLenFtFor('side', 4, 0, 10, 20), 20);
  assert.equal(porchLenFtFor('front', 4, 6, 12, 16), 6);
});

test('a 4x4 side porch is 16 sqft at the side rate, named by both sizes', () => {
  const l = porchLineFor('side', 4, 'standard', 4, true);
  assert.equal(l.price, Math.round(8.33 * 16));
  assert.match(l.name, /^4' × 4' Side Porch \(16 sqft\)$/);
  const full = porchLineFor('side', 4, 'standard', 20, false);
  assert.equal(full.name, "4' Side Porch (80 sqft)", 'the full porch line is unchanged');
});

test('the flat and minimum hooks apply to partial porches only', () => {
  try {
    applyPricingOverrides({ SELL: { porchPartial: { flat: 50, min: 400 } } });
    assert.equal(porchLineFor('side', 4, 'standard', 4, true).price, 400, 'raised to the minimum');
    assert.equal(porchLineFor('side', 8, 'standard', 12, true).price, Math.round(8.33 * 96) + 50, 'flat added above the minimum');
    assert.equal(porchLineFor('side', 4, 'standard', 20, false).price, Math.round(8.33 * 80), 'full porch untouched');
  } finally {
    applyPricingOverrides({ SELL: { porchPartial: { flat: 0, min: 0 } } });
  }
});

test('the quote prices a 4x4 side porch on its own 16 sqft and serves the length prices', async () => {
  const cfg = { style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4, porchLen: 4, porchOff: 8 };
  const r = computePricing(cfg).redline;
  assert.equal(r.porchSellName, "4' × 4' Side Porch (16 sqft)");
  assert.equal(r.porchSell, Math.round(8.33 * 16));
  const d = await quote(cfg);
  const op = d.optionPrices.porch;
  assert.ok(op.lengths, 'length prices on the wire');
  assert.equal(op.lengths['4'], Math.round(8.33 * 16));
  assert.equal(op.lengths.full, Math.round(8.33 * 80));
  assert.ok(!('20' in op.lengths), 'a length equal to the wall is "full", not a number');
  assert.equal(d.optionPrices.limits.porchMinLen, 4);
});

test('a saved config with no porchLen quotes exactly as before', async () => {
  const a = await quote({ style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4 });
  const b = await quote({ style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4, porchLen: 20 });
  assert.equal(a.total, b.total);
  const r = computePricing({ style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4 }).redline;
  assert.equal(r.porchSellName, "4' Side Porch (80 sqft)");
  assert.equal(r.porchSell, Math.round(8.33 * 80));
});

test('a partial porch is not quoted as the full porch of the same depth', async () => {
  const full = await quote({ style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4, interior: 'drywall-paint' });
  const part = await quote({ style: 'gable', w: 10, l: 20, h: 8, porchLoc: 'side', porchDepth: 4, porchLen: 4, interior: 'drywall-paint' });
  assert.ok(typeof full.total === 'number' && typeof part.total === 'number');
  assert.ok(part.total !== full.total);
});
