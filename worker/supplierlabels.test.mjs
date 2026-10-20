/* Supplier-order door/window labels: inches, W x H, only known attributes,
   gated to quotes priced with opts.supplierLabels. Prices never move. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, WINDOW_CATALOG, windowDisplayName } from './pricing.js';
import { supplierWindowLabel, supplierDoorLabel } from './quotelines.js';

test('3x10 / 5x10 transoms read as 36" / 60" wide (matches the 3D w/h)', () => {
  assert.equal(supplierWindowLabel('White Transom 3x10', 36, 10), 'Transom Window 36" W x 10" H · Fixed · White frame');
  assert.equal(supplierWindowLabel('Black Transom 5x10'), 'Transom Window 60" W x 10" H · Fixed · Black frame');
  assert.equal(supplierWindowLabel('Transom 87x10'), 'Transom Window 87" W x 10" H · Fixed');
});
test('regular windows are sliders, small squares fixed', () => {
  assert.equal(supplierWindowLabel('Black Vinyl 36x24', 36, 24), 'Window 36" W x 24" H · Slider (XO) · Black ext / White int vinyl frame');
  assert.equal(supplierWindowLabel('White Aluminum 12x12', 12, 12), 'Window 12" W x 12" H · Fixed · White aluminum frame');
});
test('every catalog window gets a label whose size is its 3D w x h', () => {
  for (const e of WINDOW_CATALOG) {
    const l = supplierWindowLabel(e.key, e.w, e.h);
    assert.ok(l && l.includes(e.w + '" W x ' + e.h + '" H'), e.key + ' -> ' + l);
  }
});
test('doors: inches + nominal', () => {
  assert.equal(supplierDoorLabel({ style: 'res6', w: 36, h: 82.5 }), 'Residential Prehung Door 36" W x 80" H (3/0 6/8) · 6 Panel · White');
  assert.equal(supplierDoorLabel({ style: 'craftsman', w: 72, h: 76 }), 'Double Door 72" W x 76" H (6/0 6/4) · Craftsman · Shop-built');
  assert.equal(supplierDoorLabel({ style: 'slideglass', w: 70, h: 80 }), 'Sliding Glass Patio Door 60" W x 80" H (5/0 6/8) · White vinyl');
  assert.equal(supplierDoorLabel({ style: 'slideglassB', w: 70, h: 80 }), 'Sliding Glass Patio Door 60" W x 80" H (5/0 6/8) · Black ext / White int vinyl');
  assert.equal(supplierWindowLabel('Black Vinyl 24x36', 24, 36), 'Window 24" W x 36" H · Slider (XO) · Black ext / White int vinyl frame');
});
const cfg = { style: 'gable', w: 12, l: 16, h: 8,
  doors: [{ wall: 'front', pos: 0.5, style: 'resfullB', w: 36, h: 82.5 }],
  windows: [{ wall: 'left', pos: 0.3, type: 'Black Transom 3x10', w: 36, h: 10 },
            { wall: 'left', pos: 0.7, type: 'White Vinyl 36x24', w: 36, h: 24 }] };
test('without the flag the redline is byte-identical to before (old quotes untouched)', () => {
  const r = computePricing(cfg).redline;
  assert.equal(r.supplierLabels, undefined);
  assert.deepEqual(r.windowSellLines.map(l => l.label), [windowDisplayName('Black Transom 3x10'), windowDisplayName('White Vinyl 36x24')]);
  assert.equal(r.doorUpLines[0].label, '36" Residential Full Lite (Black)');
});
test('the flag changes labels only, never a price', () => {
  const a = computePricing(cfg), b = computePricing(cfg, { supplierLabels: true });
  assert.equal(a.customer, b.customer);
  assert.deepEqual(a.redline.windowSellLines.map(l => l.price), b.redline.windowSellLines.map(l => l.price));
  assert.deepEqual(a.redline.doorUpLines.map(l => l.up), b.redline.doorUpLines.map(l => l.up));
  assert.equal(b.redline.supplierLabels, true);
  assert.equal(b.redline.windowSellLines[0].label, 'Transom Window 36" W x 10" H · Fixed · Black frame');
});
