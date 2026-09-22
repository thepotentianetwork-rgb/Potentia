/* The porch upgrade money moved from the finish tier to the decking.
 *
 * The porch page charged for the choice nobody could see and gave away the one
 * they could. PORCH_TIER ran from $8.33 to $35 per sqft and appeared in no 3D
 * code path at all — picking "Posts, Beams & Composite Floor" showed the
 * identical shed and added $1,900 to a 72 sqft porch. PORCH_DECK, pressure
 * treated against composite, did change the 3D, was sent up with every config,
 * and was never priced.
 *
 * So the tier picker is gone from the designer and the charge sits on the
 * decking. Two things have to stay true at once, and both are tested here:
 * composite now costs money, and a design SAVED against an old finish tier
 * still prices exactly as it did — the tier is not removed from the engine,
 * only from the questions a new customer is asked.
 *
 * Run: node --test worker/porchdeck.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePricing, porchDeckLineFor, porchSqftFor, porchLineFor,
  SELL, pricingDefaults, applyPricingOverrides
} from './pricing.js';

const COMPOSITE = 8.50;

function withOverride(o, fn) {
  const before = pricingDefaults();
  try { applyPricingOverrides(o); return fn(); }
  finally {
    Object.keys(SELL).forEach(k => delete SELL[k]);
    Object.assign(SELL, before.SELL);
  }
}

// ── THE RATE ─────────────────────────────────────────────────────────────

test('composite decking is the rate times the porch area', () => {
  // 6ft front porch on a 12ft-wide shed = 72 sqft.
  const line = porchDeckLineFor('front', 6, 'composite', 12);
  assert.equal(line.price, Math.round(COMPOSITE * 72));
  assert.ok(/72 sqft/.test(line.name), `names the area: ${line.name}`);
  assert.ok(/composite/i.test(line.name), `names the material: ${line.name}`);
});

test('a front porch spans the width and a side porch the length', () => {
  // Same shed, same depth, different wall: the areas must differ, or one of
  // the two is billing on the wrong dimension.
  assert.equal(porchSqftFor('front', 4, 12), 48);
  assert.equal(porchSqftFor('side', 4, 20), 80);
  assert.equal(porchDeckLineFor('front', 4, 'composite', 12).price, Math.round(COMPOSITE * 48));
  assert.equal(porchDeckLineFor('side', 4, 'composite', 20).price, Math.round(COMPOSITE * 80));
});

test('pressure treated and no deck are not charged', () => {
  assert.equal(porchDeckLineFor('front', 6, 'pt', 12), null);
  assert.equal(porchDeckLineFor('front', 6, 'none', 12), null);
  // The standard porch rate already includes a PT floor, so charging for it
  // would be charging twice.
  assert.equal(SELL.porchDeckSqft.pt, 0);
  assert.equal(SELL.porchDeckSqft.none, 0);
});

test('an unknown deck id charges nothing rather than the composite rate', () => {
  // A typo, an old saved design, a client sending junk. None of them may
  // invent a charge, and none may pick a cheaper one either — the default is
  // free because the base porch rate already covers a floor.
  for (const bad of ['Composite', 'COMPOSITE', 'cedar', '', null, undefined, 0, {}]) {
    assert.equal(porchDeckLineFor('front', 6, bad, 12), null, `"${bad}" is not charged`);
  }
});

test('no porch means no decking charge, whatever the deck says', () => {
  assert.equal(porchDeckLineFor('none', 6, 'composite', 12), null);
  assert.equal(porchDeckLineFor('front', 0, 'composite', 12), null);
  assert.equal(porchSqftFor('none', 6, 12), 0);
});

// ── ON A REAL BUILD ──────────────────────────────────────────────────────

const PORCHED = { style: 'gable', w: 12, l: 20, h: 9, porchLoc: 'front', porchDepth: 6 };

test('composite decking reaches the customer price', () => {
  const pt = computePricing({ ...PORCHED, porchDeck: 'pt' });
  const comp = computePricing({ ...PORCHED, porchDeck: 'composite' });
  const want = Math.round(COMPOSITE * 72);
  assert.equal(pt.redline.porchDeckSell, 0);
  assert.equal(comp.redline.porchDeckSell, want);
  assert.ok(Math.abs((comp.customer - pt.customer) - want) < 1,
    `composite adds $${want} to the price (added $${Math.round(comp.customer - pt.customer)})`);
});

test('the decking is its own line, not folded into the porch', () => {
  const { redline } = computePricing({ ...PORCHED, porchDeck: 'composite' });
  assert.ok(redline.porchSell > 0, 'the porch still has its own price');
  assert.ok(redline.porchDeckSell > 0, 'the decking has its own price');
  assert.ok(redline.porchDeckSellName, 'and its own name');
  assert.notEqual(redline.porchSellName, redline.porchDeckSellName);
});

test('a shed with no porch is unchanged by the deck setting', () => {
  const a = computePricing({ style: 'gable', w: 12, l: 20, h: 9, porchDeck: 'composite' });
  const b = computePricing({ style: 'gable', w: 12, l: 20, h: 9, porchDeck: 'pt' });
  assert.equal(a.customer, b.customer);
  assert.equal(a.redline.porchDeckSell, 0);
});

test('the deck setting does not leak between builds', () => {
  /* The porch globals are module state reset per call. A composite build
     followed by a plain one used to be exactly how PORCH_TIER-style state
     bled across quotes. */
  computePricing({ ...PORCHED, porchDeck: 'composite' });
  const after = computePricing(PORCHED);
  assert.equal(after.redline.porchDeckSell, 0, 'the next quote starts from pt');
});

// ── THE OLD TIERS STILL PRICE ────────────────────────────────────────────

test('a design saved against an old finish tier still prices at that tier', () => {
  /* This is the whole reason the tier stays in the engine. Staff reopen saved
     designs to re-quote, and quotes already sent freeze their own redline. If
     removing the picker had also removed the rates, every one of those would
     silently re-price down to standard. */
  const std = computePricing({ ...PORCHED, porchTier: 'standard' });
  for (const tier of Object.keys(SELL.porchFrontSqft)) {
    if (tier === 'standard') continue;
    const up = computePricing({ ...PORCHED, porchTier: tier });
    assert.ok(up.redline.porchSell > std.redline.porchSell,
      `"${tier}" still prices above standard ($${up.redline.porchSell} vs $${std.redline.porchSell})`);
    assert.ok(new RegExp(tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(up.redline.porchSellName),
      `the line still names the tier: ${up.redline.porchSellName}`);
  }
});

test('a new quote defaults to the standard tier', () => {
  // The designer no longer sends one, so the default is what every new porch
  // gets, and it must be the cheap end rather than whatever key sorts first.
  const { redline } = computePricing(PORCHED);
  const std = porchLineFor('front', 6, 'standard', 12);
  assert.equal(redline.porchSell, std.price);
  assert.ok(!/—/.test(redline.porchSellName),
    `standard is not spelled out as an upgrade: ${redline.porchSellName}`);
});

// ── EDITABLE WITHOUT A DEPLOY ────────────────────────────────────────────

test('the composite rate is an override, so it moves without a code change', () => {
  withOverride({ SELL: { porchDeckSqft: { composite: 20 } } }, () => {
    const { redline } = computePricing({ ...PORCHED, porchDeck: 'composite' });
    assert.equal(redline.porchDeckSell, Math.round(20 * 72));
  });
  // and hands itself back
  assert.equal(SELL.porchDeckSqft.composite, COMPOSITE);
});

test('an override cannot make pressure treated cost money by accident', () => {
  // Only ids in the table are chargeable, and an explicit 0 stays 0.
  withOverride({ SELL: { porchDeckSqft: { pt: 0 } } }, () => {
    const { redline } = computePricing({ ...PORCHED, porchDeck: 'pt' });
    assert.equal(redline.porchDeckSell, 0);
  });
});

// ── THE RATE IS EDITABLE FROM THE DASHBOARD ──────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = readFileSync(join(REPO, 'admin-pricing.html'), 'utf8');

/* admin-pricing.html keeps its OWN literal copy of the shipped rates, so it
   can render an editor before it has heard back from the worker. That copy is
   a second source of truth, and it has already drifted once — the paint table
   was edited there while the engine kept the old numbers, and the dashboard
   showed rates nothing was charging. Nothing guarded it. This does. */
function adminDefaults() {
  const m = ADMIN.match(/var SELL_DEFAULTS = (\{[\s\S]*?\n\};)/);
  assert.ok(m, 'admin-pricing.html declares SELL_DEFAULTS');
  return vm.runInNewContext('(' + m[1].replace(/;$/, '') + ')');
}

test('the dashboard offers the decking rate for editing', () => {
  // Four places, all of which have to agree or the edit silently does nothing:
  // the literal defaults, the rendered group list, the paste importer's
  // whitelist, and the note that tells the owner what the group is called.
  const d = adminDefaults();
  assert.ok(d.porchDeckSqft, 'in SELL_DEFAULTS');
  assert.ok(/key: 'porchDeckSqft'/.test(ADMIN), 'in the editable group list');
  assert.ok(/'porchDeckSqft'[,\]]/.test(ADMIN.replace(/key: 'porchDeckSqft'/, '')),
    "in the paste importer's whitelist");
  assert.ok(/<code>porchDeckSqft<\/code>/.test(ADMIN), 'named in the help note');
});

test("the dashboard's copy of every rate matches what the engine charges", () => {
  const d = adminDefaults();
  const drift = [];
  for (const group of Object.keys(d)) {
    const mine = SELL[group];
    if (!mine) { drift.push(`${group}: the engine has no such group`); continue; }
    for (const item of Object.keys(d[group])) {
      if (mine[item] !== d[group][item]) {
        drift.push(`${group}.${item}: dashboard ${d[group][item]}, engine ${mine[item]}`);
      }
    }
  }
  assert.deepEqual(drift, [], 'admin-pricing.html and pricing.js disagree:\n  ' + drift.join('\n  '));
});
