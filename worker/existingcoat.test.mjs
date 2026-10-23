// Behr concrete floor paint over an EXISTING slab (Nando, 23 Oct 2026):
// same $300 SELL.foundationFinish.coated, its own line, no pad, no estimate tag.
// Run: node --test worker/existingcoat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, EXISTING_COAT_NAME, CONCRETE_STAIN_NAME } from './pricing.js';
import { quoteLines } from './quotelines.js';

const BASE = { style: 'gable', w: 10, l: 20, h: 8, foundation: 'existing' };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.011, a + ' vs ' + b);

test('existing slab + coated adds exactly $300 as its own named line', () => {
  const plain = computePricing(Object.assign({}, BASE, { foundationFinish: 'plain' }));
  const coat = computePricing(Object.assign({}, BASE, { foundationFinish: 'coated', foundationStain: 'pfc63' }));
  assert.equal(coat.customer - plain.customer, 300);
  assert.equal(coat.redline.finishSell, 300);
  assert.equal(coat.redline.finishSellName, EXISTING_COAT_NAME);
  assert.equal(coat.redline.foundSell, 0);
  assert.equal(coat.redline.foundName, '');
});

test('existing slab ignores broom (wet-concrete only)', () => {
  const plain = computePricing(Object.assign({}, BASE, { foundationFinish: 'plain' }));
  const broom = computePricing(Object.assign({}, BASE, { foundationFinish: 'broom' }));
  assert.equal(broom.customer, plain.customer);
});

test('quote row is the coat alone, marked up 3% on a card quote, not an estimate', () => {
  const rl = Object.assign(computePricing(Object.assign({}, BASE, { foundationFinish: 'coated' })).redline, { cardUplift: 0.03, discountsAtSheet: true });
  const f = quoteLines(rl, []).rows.find((r) => r.kind === 'foundation');
  assert.ok(f.label.endsWith(EXISTING_COAT_NAME), f.label);
  near(f.amt, 309);
  assert.ok(!f.estimate);
  assert.ok(!f.subLines);
});

test('poured pad still uses the original stain line', () => {
  const rl = computePricing(Object.assign({}, BASE, { foundation: 'pad', foundationFinish: 'coated' })).redline;
  assert.equal(rl.finishSellName, CONCRETE_STAIN_NAME);
  const f = quoteLines(rl, []).rows.find((r) => r.kind === 'foundation');
  assert.match(f.label, /Concrete Foundation$/);
});
