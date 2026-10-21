/* porchAdds designs are labelled by the enclosed shed + the porch; every
 * other design keeps its w x l label byte-for-byte. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { porchAddsSize } from './pricing.js';
import { describeDesign } from './customerdesign.js';
import { assemble } from './build-bundle.mjs';

const NEW = { style: 'gable', w: 12, l: 20, h: 8, porchLoc: 'front', porchDepth: 4, porchAdds: 1, shedW: 12, shedL: 16 };
const OLD = { style: 'gable', w: 12, l: 16, h: 8, porchLoc: 'front', porchDepth: 4 };

test('porchAddsSize only for a flagged design with a full porch and sizes', () => {
  assert.deepEqual(porchAddsSize(NEW), { w: 12, l: 16, depth: 4, loc: 'front', porch: "4' front porch" });
  assert.equal(porchAddsSize(OLD), null);
  assert.equal(porchAddsSize({ ...NEW, shedW: undefined }), null);
  assert.equal(porchAddsSize({ ...NEW, porchLoc: 'none' }), null);
});

test('customer design size line', () => {
  assert.match(describeDesign(NEW).lines ? describeDesign(NEW).lines.join('\n') : JSON.stringify(describeDesign(NEW)),
    /Size: 12' wide x 16' deep \+ 4' front porch \(12' x 20' overall\), 8' walls/);
  assert.match(JSON.stringify(describeDesign(OLD)), /Size: 12' wide x 16' deep, 8' walls/);
});

test('bundle: configSummary / buildName / specShell / cqDesign', async () => {
  const src = assemble().replace(/^import .*$/mg, '');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src + '\nexport { configSummary, buildName, specShell, cqDesign };').toString('base64'));
  assert.equal(mod.configSummary(NEW), "12x16 ft + 4' front porch \u00b7 Gable / A-Frame");
  assert.equal(mod.configSummary(OLD), '12x16 ft \u00b7 Gable / A-Frame');
  assert.equal(mod.buildName(NEW), "12x16 + 4' front porch Gable / A-Frame");
  assert.equal(mod.buildName(OLD), '12x16 Gable / A-Frame');
  assert.match(mod.specShell(NEW), /^12x16 ft \+ 4' front porch · gable/);
  assert.match(mod.specShell(OLD), /^12x16 ft · gable/);
  assert.equal(mod.cqDesign(JSON.stringify({ config: NEW })), "12x16 + 4' front porch gable");
  assert.equal(mod.cqDesign(JSON.stringify({ config: OLD })), '12x16 gable');
});

test('quote page and CRM customer page carry the same helper', () => {
  for (const f of ['quote.html', 'admin-customer.html']) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const m = /function porchAddsSize\(c\) \{[\s\S]*?\n\}/.exec(s);
    assert.ok(m, f);
    const fn = new Function(m[0] + '; return porchAddsSize;')();
    assert.deepEqual(fn(NEW), porchAddsSize(NEW), f);
    assert.equal(fn(OLD), null, f);
  }
});
