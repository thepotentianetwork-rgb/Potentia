/* PRICE TBD windows (owner, 20 Oct 2026): 72x48 double-pane vinyl slider and
   24x80 fixed double-pane vinyl sidelight, white and black. Listed as
   "Price TBD", add nothing to any total, and leave older quotes untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, WINDOW_PRICE_TBD, SELL } from './pricing.js';
import { supplierWindowLabel, quoteLines } from './quotelines.js';

const base = { width: 10, depth: 12, wallH: 8, doors: [], windows: [] };
const withWin = (type, w, h) => Object.assign({}, base, { windows: [{ wall: 'front', pos: 0.5, w, h, cy: 52, type }] });

test('labels: inches W x H, slider / fixed sidelight, frame colour', () => {
  assert.equal(supplierWindowLabel('White Vinyl 72x48', 72, 48), 'Window 72" W x 48" H \u00b7 Slider (XO) \u00b7 Double-pane \u00b7 White vinyl frame');
  assert.equal(supplierWindowLabel('Black Vinyl 72x48', 72, 48), 'Window 72" W x 48" H \u00b7 Slider (XO) \u00b7 Double-pane \u00b7 Black ext / White int vinyl frame');
  assert.equal(supplierWindowLabel('White Sidelight 24x80', 24, 80), 'Sidelight Window 24" W x 80" H \u00b7 Fixed \u00b7 Double-pane \u00b7 White vinyl frame');
  assert.equal(supplierWindowLabel('Black Sidelight 24x80', 24, 80), 'Sidelight Window 24" W x 80" H \u00b7 Fixed \u00b7 Double-pane \u00b7 Black ext / White int vinyl frame');
  // existing labels unchanged
  assert.equal(supplierWindowLabel('Black Vinyl 36x24', 36, 24), 'Window 36" W x 24" H \u00b7 Slider (XO) \u00b7 Black ext / White int vinyl frame');
});

test('no price exists and none is invented', () => {
  WINDOW_PRICE_TBD.forEach((k) => assert.equal(SELL.windows[k], undefined, k));
});

for (const [type, w, h] of [['White Vinyl 72x48', 72, 48], ['Black Vinyl 72x48', 72, 48], ['White Sidelight 24x80', 24, 80], ['Black Sidelight 24x80', 24, 80]]) {
  test(type + ' adds $0 to totals and shows as Price TBD', () => {
    const a = computePricing(base, { supplierLabels: true });
    const b = computePricing(withWin(type, w, h), { supplierLabels: true });
    assert.equal(b.customer, a.customer);
    assert.equal(b.redline.windowSell, 0);
    assert.equal(b.redline.windowSellLines.length, 0);
    assert.equal(b.redline.trueTotalCost, a.redline.trueTotalCost);
    assert.equal(b.redline.tbdLines.length, 1);
    assert.equal(b.redline.tbdLines[0].label, supplierWindowLabel(type, w, h));
    const qa = quoteLines(a.redline, []), qb = quoteLines(b.redline, []);
    assert.equal(qb.total, qa.total);
    assert.equal(qb.subtotal, qa.subtotal);
    assert.equal(qb.tbdLines.length, 1);
    assert.match(qb.tbdLines[0].note, /final price confirmed before deposit/);
  });
}

test('quotes without TBD items carry no tbdLines', () => {
  const a = computePricing(withWin('Black Vinyl 36x36', 36, 36));
  assert.equal(a.redline.tbdLines, undefined);
  assert.deepEqual(quoteLines(a.redline, []).tbdLines, []);
});
