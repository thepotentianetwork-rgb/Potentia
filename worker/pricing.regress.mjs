// Regression check for the pricing.js extraction: runs a batch of configs
// through the ORIGINAL client-side pricing engine (the IIFE this file used
// to be, executed exactly as designer.html did — bare globals, window.*)
// and through the extracted worker/pricing.js module, and diffs the
// customer totals to the cent. This is the check that matters for this
// refactor — see the "Definition of done" item about regression-testing
// ten saved configs and diffing to the dollar.
//
// Usage: node worker/pricing.regress.mjs /path/to/designer.html
//
// Pulls the pricing IIFE straight out of the given designer.html (between
// the `(function(){` that opens it and the `window.ShedPricing = {...}`
// close) so this always regresses against whatever the live file actually
// contains, not a stale copy pasted in here.

import fs from 'node:fs';
import vm from 'node:vm';
import { computePricing as newCompute } from './pricing.js';

const designerPath = process.argv[2];
if (!designerPath) {
  console.error('Usage: node pricing.regress.mjs /path/to/designer.html');
  process.exit(2);
}
const html = fs.readFileSync(designerPath, 'utf8');
const startMarker = '(function(){\n  "use strict";';
const endMarker = '})();\n\n/* ══════════════════════════════════════════════════════════════════════════\n   ADMIN — PRICING CONTROL';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  console.error('Could not locate the pricing IIFE in', designerPath, '(markers moved?)');
  process.exit(2);
}
const iife = html.slice(startIdx, endIdx + '})();'.length);

// A CONFIG is the same shape getDesignConfig()/setConfig() use. Old-engine
// globals are set directly (that's how designer.html itself works); the
// new engine takes the identical object as computePricing's first arg.
function oldEngineCompute(cfg) {
  function porchEatFtImpl() {
    if (cfg.style !== 'gable') return { w: 0, l: 0 };
    if (cfg.porchLoc === 'none' || cfg.porchLoc == null) return { w: 0, l: 0 };
    if (!(cfg.porchDepth > 0)) return { w: 0, l: 0 };
    return cfg.porchLoc === 'front' ? { w: 0, l: cfg.porchDepth } : { w: cfg.porchDepth, l: 0 };
  }
  function padSqftImpl() {
    const eat = porchEatFtImpl();
    return Math.round((cfg.w - eat.w) * (cfg.l - eat.l));
  }
  const sandbox = {
    window: {},
    console,
    Math,
    JSON,
    // bare globals the IIFE reads directly
    STYLE: cfg.style, PITCH: cfg.pitch, ROOFTYPE: cfg.roofType,
    OVTYPE: cfg.ovType, OVH: cfg.ovh, SIDING: cfg.siding,
    W: cfg.w, L: cfg.l, H: cfg.h,
    PORCH_LOC: cfg.porchLoc, SIDE_PORCH: cfg.porchDepth, PORCH_TIER: cfg.porchTier,
    DORMER_L: cfg.dormerL, DORMER_R: cfg.dormerR,
    FOUNDATION: cfg.foundation, FOUNDATION_FINISH: cfg.foundationFinish,
    LOFT: cfg.loft, ELEC: cfg.elec, INT_FINISH: cfg.intFinish, ADDONS: cfg.addons,
    doorsData: cfg.doors, windowsData: cfg.windows, ventsData: cfg.vents, shelvesData: cfg.shelves,
    // porchEatFt()/padSqft() dependencies live outside the IIFE in the real
    // file; the IIFE only calls them via typeof-guard, so replicate just
    // enough of them here for the interior-finish and broom-finish lines.
    porchEatFt: porchEatFtImpl,
    padSqft: padSqftImpl
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox, { filename: 'designer-pricing-iife.js' });
  return sandbox.window.ShedPricing.compute();
}

function newEngineCompute(cfg) {
  return newCompute(cfg);
}

// Ten+ configs spanning styles, porch, siding, dormers, finishes, and a
// couple of doors/windows — not exhaustive, but enough spread to catch a
// wrong global, a dropped branch, or a sign flip in the port.
const baseDoors = [{ wall: 'front', pos: 0.5, style: 'basic', w: 60, h: 76 }];
const baseWindows = [{ wall: 'front', pos: 0.3, type: 'White Vinyl 24x30', w: 24, h: 30 }];
const CONFIGS = [
  { name: '8x12 gable, all defaults',
    style: 'gable', w: 8, l: 12, h: 8, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: [], windows: [], vents: [], shelves: [] },
  { name: '10x16 gable, front porch standard, one door one window',
    style: 'gable', w: 10, l: 16, h: 8, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'front', porchDepth: 6, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'pad', foundationFinish: 'broom',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: baseDoors, windows: baseWindows, vents: [], shelves: [] },
  { name: '12x20 barn, metal roof, dormer both sides',
    style: 'barn', w: 12, l: 20, h: 9, pitch: 8, siding: 'horizontal', roofType: 'metal',
    ovType: 'all4', ovh: 12, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 8, dormerR: 12, foundation: 'blocks', foundationFinish: 'plain',
    loft: '4-front', elec: 'basic', intFinish: 'drywall', addons: {}, doors: baseDoors, windows: baseWindows, vents: [{}], shelves: [] },
  { name: '8x10 lean-to, side porch, pine siding',
    style: 'leanto', w: 8, l: 10, h: 7, pitch: 3, siding: 'pine', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'side', porchDepth: 4, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'pad', foundationFinish: 'coated',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: [], windows: [], vents: [], shelves: [] },
  { name: '10x12 hip (poolhouse), board-batten, painted interior',
    style: 'hip', w: 10, l: 12, h: 8, pitch: 6, siding: 'board-batten', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'pad', foundationFinish: 'plain',
    loft: 'none', elec: 'core', intFinish: 'painted', addons: {}, doors: baseDoors, windows: [], vents: [], shelves: [] },
  { name: '12x16 3peak, wall height 10, essential elec, addons',
    style: '3peak', w: 12, l: 16, h: 10, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'essential', intFinish: 'none',
    addons: { shutters: true, flowerboxes: true, cupola: 'black', skylight: true, ridgeVent: true },
    doors: baseDoors, windows: baseWindows, vents: [], shelves: [{ wall: 'left', len: 4, depth: 16 }] },
  { name: '16x20 4peak, big shed, two doors two windows',
    style: '4peak', w: 16, l: 20, h: 8, pitch: 6, siding: 'vertical', roofType: 'metal',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {},
    doors: baseDoors.concat([{ wall: 'right', pos: 0.5, style: 'res6', w: 36, h: 82.5 }]),
    windows: baseWindows.concat([{ wall: 'back', pos: 0.5, type: 'Black Vinyl 24x36', w: 24, h: 36 }]),
    vents: [], shelves: [] },
  { name: '8x12 gable, side porch max depth, dormer 12ft',
    style: 'gable', w: 8, l: 24, h: 8, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'side', porchDepth: 8, porchTier: 'standard',
    dormerL: 12, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: [], windows: [], vents: [], shelves: [] },
  { name: '10x14 gable, front porch upgraded tier',
    style: 'gable', w: 10, l: 14, h: 8, pitch: 8, siding: 'vertical', roofType: 'shingle',
    ovType: 'all4', ovh: 8, porchLoc: 'front', porchDepth: 6, porchTier: 'Composite Awning',
    dormerL: 0, dormerR: 0, foundation: 'pad', foundationFinish: 'broom',
    loft: 'none', elec: 'standard', intFinish: 'none', addons: {}, doors: baseDoors, windows: [], vents: [], shelves: [] },
  { name: '12x12 poolhouse, tall walls, no doors no windows',
    style: 'hip', w: 12, l: 12, h: 12, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: [], windows: [], vents: [], shelves: [] },
  { name: '20x32 gable, largest offered size',
    style: 'gable', w: 20, l: 32, h: 8, pitch: 6, siding: 'vertical', roofType: 'shingle',
    ovType: 'gable', ovh: 4, porchLoc: 'none', porchDepth: 0, porchTier: 'standard',
    dormerL: 0, dormerR: 0, foundation: 'blocks', foundationFinish: 'plain',
    loft: 'none', elec: 'none', intFinish: 'none', addons: {}, doors: [], windows: [], vents: [], shelves: [] }
];

let pass = 0, fail = 0;
for (const cfg of CONFIGS) {
  let oldR, newR, err;
  try {
    oldR = oldEngineCompute(cfg);
    newR = newEngineCompute(cfg);
  } catch (e) {
    err = e;
  }
  if (err) {
    fail++;
    console.log('✗ ' + cfg.name + '  THREW: ' + err.message);
    continue;
  }
  const oldTotal = Math.round(oldR.customer * 100) / 100;
  const newTotal = Math.round(newR.customer * 100) / 100;
  const oldTrue = Math.round(oldR.redline.trueTotalCost * 100) / 100;
  const newTrue = Math.round(newR.redline.trueTotalCost * 100) / 100;
  if (oldTotal === newTotal && oldTrue === newTrue) {
    pass++;
    console.log('✓ ' + cfg.name + '  customer=$' + oldTotal.toFixed(2) + '  cost=$' + oldTrue.toFixed(2));
  } else {
    fail++;
    console.log('✗ ' + cfg.name);
    console.log('    OLD customer=$' + oldTotal.toFixed(2) + '  cost=$' + oldTrue.toFixed(2));
    console.log('    NEW customer=$' + newTotal.toFixed(2) + '  cost=$' + newTrue.toFixed(2));
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed, out of ' + CONFIGS.length);
process.exit(fail ? 1 : 0);
