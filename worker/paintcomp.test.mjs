/* Exterior Paint is a billed shed line, so the CRM must be able to give it
   away or re-price it. It used to be left out of the picker and of the
   quote-page lookup, so "Include free" could not target it and a saved paint
   comp would have been ignored on the customer quote.
   Run: node --test worker/paintcomp.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing } from './pricing.js';
import { quoteLines, compItemPrices, nameList } from './quotelines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('exterior paint is in the giveaway / re-price set', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 8, siding: 'horizontal' });
  assert.ok(redline.paintSell > 0, 'a painted shed charges for paint');
  assert.equal(redline.paintSellName, 'Exterior Paint');
  assert.equal(compItemPrices(redline)['Exterior Paint'], redline.paintSell);
  assert.ok(nameList(redline, 'shed').includes('Exterior Paint'));
  assert.ok(!nameList(redline, 'shed').includes(redline.laborSellName),
    'labor stays out of the set — it is folded into Base Shed');
});

test('pine has no paint line to give away', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 8, siding: 'pine' });
  assert.equal(redline.paintSell, 0);
  assert.equal(compItemPrices(redline)['Exterior Paint'], undefined);
  assert.ok(!nameList(redline, 'shed').includes('Exterior Paint'));
});

test('comping exterior paint takes it off the quote and lists it as included free', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 8, siding: 'horizontal' });
  const paint = redline.paintSell;
  const none = quoteLines(redline, []);
  const free = quoteLines(redline, [{ kind: 'comp', item: 'Exterior Paint' }]);
  const shedNone = none.rows.find(r => r.kind === 'shed');
  const shedFree = free.rows.find(r => r.kind === 'shed');
  const charged = (shedFree.subLines || []).find(l => l.label === 'Exterior Paint');
  assert.ok(!charged || Math.abs(charged.amt) < 0.01, 'paint is not charged once comped');
  const disc = (free.discounts || []).find(d => /Exterior Paint/.test(d.label));
  assert.ok(disc, 'the quote lists paint as included free');
  assert.match(disc.label, /included free/i);
  assert.ok(Math.abs(disc.amt - paint * (redline.discountsAtSheet && redline.cardUplift ? 1 + redline.cardUplift : 1)) < 1
    || Math.abs(disc.amt - paint) < 1,
    `free-line amount ${disc.amt} should match the paint price`);
  assert.ok(shedFree.amt < shedNone.amt - paint * 0.5,
    'the shed phase drops by about the paint price');
  assert.ok(Math.abs((none.adjustedSubtotal - free.adjustedSubtotal) - disc.amt) < 1,
    'the quote total drops by the same amount as the free line');
});

test('a siding giveaway still works when paint is also billed', () => {
  /* Jake Oakden #99: Horizontal Siding was marked free and a 25% discount was
     added. Paint must stay charged until someone actually comps it. */
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 8, siding: 'horizontal',
  });
  const adj = [
    { kind: 'percent', value: -25 },
    { kind: 'comp', item: 'Horizontal Siding' },
  ];
  const bd = quoteLines(redline, adj);
  const shed = bd.rows.find(r => r.kind === 'shed');
  const charged = (shed.subLines || []).map(l => l.label);
  const listed = (shed.regularSubLines || shed.subLines || []).map(l => l.label);
  assert.ok(listed.includes('Horizontal Siding'), 'siding was a priced line');
  assert.ok(!charged.includes('Horizontal Siding') ||
    Math.abs((shed.subLines || []).find(l => l.label === 'Horizontal Siding').amt) < 0.01,
    'siding is not charged once comped');
  const paintNet = (shed.subLines || []).find(l => l.label === 'Exterior Paint');
  assert.ok(paintNet && paintNet.amt > 0, 'paint is still billed');
  const labels = (bd.discounts || []).map(d => d.label).join(' | ');
  assert.match(labels, /Horizontal Siding.*included free/i);
  assert.match(labels, /Discount \(25%\)/);
  assert.ok(!(bd.discounts || []).some(d => /Exterior Paint/.test(d.label)),
    'paint was not given away by the siding comp');
});

test('the worker picker source includes paint and no longer claims it is absent', () => {
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  assert.match(src, /push\(redline\.paintSellName,\s*redline\.paintSell\)/);
  assert.doesNotMatch(src, /paintSell is deliberately absent/);
});
