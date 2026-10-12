// The quote's Roof section (Nando, 12 Oct 2026). Display only.
import test from 'node:test'; import assert from 'node:assert/strict';
import { roofSpec, quoteLines } from './quotelines.js';
const m = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.value]));
test('#69-style gable: pitch, shingle colour, overhang, soffit, ridge vent', () => {
  const r = m(roofSpec({ style: 'gable', pitch: 8, ovh: 6, ovType: 'all4', roofType: 'shingle', roofColor: 0x28282A, soffit: 'white' },
    { addonLines: [{ name: 'Roof Ridge Vent', amt: 263 }] }));
  assert.equal(r['Pitch'], '8/12'); assert.equal(r['Shingles & color'], 'Asphalt shingle, Black Asphalt');
  assert.equal(r['Overhang'], '6\u2033 overhang, all 4 sides'); assert.equal(r['Soffit'], 'White');
  assert.match(r['Ridge vent'], /^Included/);
});
test('a stale colour name is not trusted: metal black is Black, not Black Asphalt (#68)', () => {
  const r = m(roofSpec({ style: 'gable', pitch: 8, roofType: 'metal', roofColor: 0x1A1A1A, colorNames: { roof: 'Black Asphalt' } }));
  assert.equal(r['Roofing & color'], 'Metal, Black');
});
test('a gable without the vent says so; a lean-to has no ridge row', () => {
  assert.equal(m(roofSpec({ style: 'gable', pitch: 6 }))['Ridge vent'], 'Not included');
  const lt = m(roofSpec({ style: 'leanto', l: 16, leantoDrop: 2, ovh: 6, ovType: 'gable', leantoFrontOvh: 12, roofType: 'metal', roofColor: 0x6E2B2B }));
  assert.equal(lt['Ridge vent'], undefined);
  assert.equal(lt['Pitch'], '2 ft drop, front to back (about 1.5/12)');
  assert.equal(lt['Overhang'], 'Flush, 6\u2033 fascia board; front (tall side) 1 ft');
});
test('barn: fixed gambrel and flush eaves whatever pitch/ovh were saved', () => {
  const b = m(roofSpec({ style: 'barn', pitch: 8, ovh: 12, ovType: 'all4' }));
  assert.match(b['Pitch'], /Gambrel/); assert.equal(b['Ridge vent'], 'Not included'); assert.equal(b['Overhang'], 'Flush eaves, 4\u2033 gable rake');
});
test('old or empty designs show only what is known', () => {
  assert.deepEqual(roofSpec({}), []); assert.deepEqual(roofSpec(null), []);
  const o = m(roofSpec({ style: 'leanto', roofType: 'metal', roofColor: 0x123456 }));
  assert.deepEqual(Object.keys(o), ['Roof style', 'Roofing & color']); assert.equal(o['Roofing & color'], 'Metal');
});
