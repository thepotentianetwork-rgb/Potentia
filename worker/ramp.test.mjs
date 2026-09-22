/* The metal ramp at the drive-in door: a flat $200 add-on.
 *
 * Nothing clever here, which is the point — it goes through the same flat
 * add-on path as the stairs and the ladders. What is worth pinning is that it
 * is FLAT: the designer builds one ramp, at the widest drive-in door, because
 * the price is for the shed and not per door. If this ever becomes per-door,
 * rampDoors() in designer.html has to change in the same commit.
 *
 * Run: node --test worker/ramp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, SELL } from './pricing.js';

const BASE = { style:'gable', w:12, l:20, h:9 };
const ramped = (extra) => computePricing(Object.assign({}, BASE, extra, { addons:{ ramp:true } }));

test('the ramp is $200', () => {
  assert.equal(SELL.options.flat['Ramp'], 200);
  const line = (ramped().redline.addonLines || []).find(l => l.name === 'Ramp');
  assert.ok(line, 'it is itemised');
  assert.equal(line.amt, 200);
});

test('it adds exactly $200 to the price', () => {
  const off = computePricing(BASE).customer;
  const on = ramped().customer;
  assert.ok(Math.abs((on - off) - 200) < 0.01, `+$${Math.round(on - off)}`);
});

test('it is flat — the same on every shed', () => {
  // A per-sqft add-on sneaking in here would show up as a different delta on a
  // bigger shed, and the designer draws exactly one ramp on the strength of
  // this being flat.
  const sizes = [{ w:8, l:8, h:8 }, { w:10, l:16, h:9 }, { w:16, l:24, h:10 }];
  for (const s of sizes) {
    const off = computePricing(Object.assign({}, BASE, s)).customer;
    const on = ramped(s).customer;
    assert.ok(Math.abs((on - off) - 200) < 0.01,
      `${s.w}x${s.l}: +$${Math.round(on - off)}, not $200`);
  }
});

test('it costs nothing when it is not asked for', () => {
  const r = computePricing(Object.assign({}, BASE, { addons:{} })).redline;
  assert.ok(!(r.addonLines || []).some(l => l.name === 'Ramp'));
});

test('it can be given away like any other add-on line', () => {
  // Comps are keyed on the line's name; a name the comp list cannot see is a
  // line staff cannot discount.
  const r = ramped().redline;
  assert.ok((r.addonLines || []).some(l => l.name === 'Ramp' && l.amt > 0));
});
