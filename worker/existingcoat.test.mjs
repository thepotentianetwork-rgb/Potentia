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

test('coat folds into the Shed phase: no phase of its own, +309 on a card quote, a Shed sub-line', () => {
  const mk = (ff) => Object.assign(computePricing(Object.assign({}, BASE, { foundationFinish: ff })).redline, { cardUplift: 0.03, discountsAtSheet: true });
  const q = quoteLines(mk('coated'), []), q0 = quoteLines(mk('plain'), []);
  assert.ok(!q.rows.find((r) => r.kind === 'foundation'));
  assert.equal(q.rows.length, q0.rows.length);
  const s = q.rows.find((r) => r.kind === 'shed'), s0 = q0.rows.find((r) => r.kind === 'shed');
  near(s.amt - s0.amt, 309);
  const sub = s.subLines.find((l) => l.label === EXISTING_COAT_NAME);
  assert.ok(sub, JSON.stringify(s.subLines));
  near(q.subtotal - q0.subtotal, 309);
});

test('poured pad still uses the original stain line', () => {
  const rl = computePricing(Object.assign({}, BASE, { foundation: 'pad', foundationFinish: 'coated' })).redline;
  assert.equal(rl.finishSellName, CONCRETE_STAIN_NAME);
  const f = quoteLines(rl, []).rows.find((r) => r.kind === 'foundation');
  assert.match(f.label, /Concrete Foundation$/);
});
