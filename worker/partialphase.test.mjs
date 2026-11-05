/* PARTIAL PHASE AMOUNTS: {phase, part, sub, cents} bills only `cents` of a
 * part (a progress payment). Omit cents and nothing changes.
 * Run: node --test worker/partialphase.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { buildTogetherInvoice, buildPhaseInvoice } from './invoices.js';

const BD = quoteLines(computePricing({ style: 'gable', w: 10, l: 20, h: 9, foundation: 'pad' }).redline, []);
const BD2 = quoteLines(computePricing({ style: 'gable', w: 8, l: 16, h: 8, foundation: 'pad' }).redline, []);
const two = () => [{ sub: 7, name: '10x20 Gable', bd: BD, payments: [] }, { sub: 38, name: '8x16 Gable', bd: BD2, payments: [] }];

test('partial remainders on two builds bill exactly the cents given', () => {
  const inv = buildTogetherInvoice(two(), [
    { phase: 2, part: 'remainder', sub: 7, cents: 257222 },
    { phase: 2, part: 'remainder', sub: 38, cents: 116831 }]);
  assert.equal(inv.totalCents, 374053);
  assert.deepEqual(inv.covers.map((c) => [c.sub, c.phase, c.part, c.cents]),
    [[7, 2, 'remainder', 257222], [38, 2, 'remainder', 116831]]);
  assert.match(inv.lines[0].label, /^Progress payment toward remainder of Phase 2/);
  assert.match(inv.description, /progress payment/);
});

test('omitting cents is unchanged; too much or bad cents is refused', () => {
  const full = buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit' }]);
  const part = buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit', cents: 100 }]);
  assert.equal(part.totalCents, 100);
  assert.ok(full.totalCents > 100);
  assert.throws(() => buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit', cents: full.totalCents + 1 }]), /more than/);
  assert.throws(() => buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit', cents: -5 }]), /whole number/);
  assert.throws(() => buildTogetherInvoice(two(), [{ phase: 2, part: 'remainder', cents: 5 }]), /needs the build/);
});
