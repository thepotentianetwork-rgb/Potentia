import test from 'node:test'; import assert from 'node:assert/strict';
import { roofSpec } from './quotelines.js';
const row = (c) => (roofSpec({ style: 'gable', pitch: 6, ...c }, {}) || []).find((r) => r.label === 'Soffit');
test('Match Trim names the trim colour', () => {
  assert.equal(row({ soffit: 'trim', trimColor: 0xF2F0EC }).value, 'Matches the trim (White)');
  assert.equal(row({ soffit: 'trim', trimColor: 0x2C3E52 }).value, 'Matches the trim (Navy)');
  assert.equal(row({ soffit: 'trim', trimColor: 0x123456 }).value, 'Matches the trim');
});
test('older soffit values unchanged', () => {
  assert.equal(row({ soffit: 'match' }).value, 'Matches the walls');
  assert.equal(row({ soffit: 'cedar' }).value, 'Cedar');
  assert.equal(row({}), undefined);
});
