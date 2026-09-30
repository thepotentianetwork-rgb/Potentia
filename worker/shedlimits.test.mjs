/* THE SIZE THE DESIGNER OFFERS AND THE SIZE THE SERVER PRICES MUST BE ONE SIZE.
 *
 * This is the bug that shipped. The designer's sliders were raised to 22x34;
 * the clamp in validateShedConfig stayed at 20x32. Nothing failed. The server
 * quietly shrank every larger request and quoted the smaller shed, so a
 * customer configuring a 22x34 was shown the price of a shed two feet smaller
 * each way — on the page, in the quote, in the redline, consistently. Every
 * test in this repo passed, because every one of them asks whether the number
 * that came back is internally consistent, and it was.
 *
 * What could not be tested is the other repo's markup. So the fix is not a
 * test at all: the server now SERVES its limits and the designer sets its
 * sliders from them. These tests hold up that contract from this side.
 *
 *   1. The limits are on the wire, with the shape the client reads.
 *   2. A build at the maximum is priced AT that size, not clamped.
 *   3. A build past the maximum is clamped to it, and the served limits say
 *      where that is — so the client can never be offering more than this.
 *   4. Size still moves the price, which is what makes 2 and 3 meaningful.
 *
 * Run: node --test worker/shedlimits.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { computePricing } from './pricing.js';

const ORIGIN = 'https://shedpro-utah.com';
/* Just enough D1 for the quote path: it reads one row of saved pricing
   overrides and carries on if there is none. No row here, so every quote is
   priced off the tables in pricing.js rather than off whatever an admin has
   saved — which is what makes the figures below comparable run to run. */
const ENV = { DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) , bind() { return this; } }) } };
async function quote(config) {
  const res = await worker.fetch(new Request('https://x/shed/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ config })
  }), ENV, { waitUntil() {} });
  assert.equal(res.status, 200, `/shed/quote returned ${res.status}`);
  return res.json();
}

test('the server tells the client what sizes it will price', () => {
  return quote({ style: 'gable', w: 12, l: 16, h: 9 }).then((d) => {
    const lim = d.optionPrices && d.optionPrices.limits;
    assert.ok(lim, 'no limits on the wire — the designer has nothing to read');
    for (const k of ['w', 'l', 'h']) {
      assert.ok(lim[k], `no limit for ${k}`);
      assert.equal(typeof lim[k].min, 'number');
      assert.equal(typeof lim[k].max, 'number');
      assert.ok(lim[k].max > lim[k].min, `${k} limits are inverted`);
    }
    assert.equal(lim.w.max, 26);
    assert.equal(lim.l.max, 34);
  });
});

test('a shed built AT the maximum is priced at that size', async () => {
  const { limits } = (await quote({ style: 'gable', w: 12, l: 16, h: 9 })).optionPrices;
  const wMax = limits.w.max, lMax = limits.l.max;

  const big = await quote({ style: 'gable', w: wMax, l: lMax, h: 9 });
  /* Priced against the engine directly at the SAME dimensions. If the clamp
     were still below the served maximum, the endpoint would come back holding
     the price of a smaller shed and this is the comparison that catches it —
     the old 20x32 clamp against a 26x34 request was a $5,300 gap. */
  const direct = computePricing({ style: 'gable', w: wMax, l: lMax, h: 9 }).customer;
  assert.ok(Math.abs(big.total - direct) < 0.01,
    `a ${wMax}x${lMax} quoted $${Math.round(big.total)} but prices at $${Math.round(direct)} — it is being clamped below the size the client is offered`);
});

test('past the maximum is clamped TO the maximum, not beyond it', async () => {
  const { limits } = (await quote({ style: 'gable', w: 12, l: 16, h: 9 })).optionPrices;
  const wMax = limits.w.max, lMax = limits.l.max;
  const over = await quote({ style: 'gable', w: wMax + 10, l: lMax + 10, h: 9 });
  const atMax = await quote({ style: 'gable', w: wMax, l: lMax, h: 9 });
  assert.ok(Math.abs(over.total - atMax.total) < 0.01,
    'an oversized request is not being clamped to the served maximum');
  // And below the minimum, the same in the other direction.
  const under = await quote({ style: 'gable', w: 1, l: 1, h: 9 });
  const atMin = await quote({ style: 'gable', w: limits.w.min, l: limits.l.min, h: 9 });
  assert.ok(Math.abs(under.total - atMin.total) < 0.01, 'an undersized request is not clamped to the minimum');
});

test('size moves the price, so the checks above can fail', async () => {
  /* Without this, a build that returned one number for every size would pass
     all three tests above. It is the control, not decoration. */
  const { limits } = (await quote({ style: 'gable', w: 12, l: 16, h: 9 })).optionPrices;
  const small = await quote({ style: 'gable', w: limits.w.min, l: limits.l.min, h: 9 });
  const large = await quote({ style: 'gable', w: limits.w.max, l: limits.l.max, h: 9 });
  assert.ok(large.total > small.total * 1.5,
    `a ${limits.w.max}x${limits.l.max} ($${Math.round(large.total)}) should cost well over a ${limits.w.min}x${limits.l.min} ($${Math.round(small.total)})`);
  // Each foot of width counts on its own, not just the pair.
  const a = await quote({ style: 'gable', w: 20, l: 34, h: 9 });
  const b = await quote({ style: 'gable', w: 26, l: 34, h: 9 });
  assert.ok(b.total > a.total, 'width past the old 20ft ceiling adds nothing to the price');
});

/* ── THE PORCH, THE SAME WAY ─────────────────────────────────────────────────
   The depth ladder went to 10ft in the designer with the size bump, and the
   two loops that price the depth TILES still ran [4, 6, 8]. Nothing failed:
   a 10ft porch totals correctly, because porch is priced per square foot, so
   every check on the total stayed green. The tile the customer taps just had
   no price on it — nothing had computed one for a depth the server did not
   know was on offer.
   So the depths are served too, and these hold that the two agree. */

test('the porch depths are on the wire', async () => {
  const { limits } = (await quote({ style: 'gable', w: 16, l: 24, h: 9 })).optionPrices;
  assert.ok(Array.isArray(limits.porchDepths), 'no porch depths served');
  assert.ok(limits.porchDepths.includes(10), 'the 10ft porch is not offered');
  for (const d of limits.porchDepths) assert.ok(d > 0, `${d} is not a depth`);
});

test('every depth the server offers, the server has priced', async () => {
  /* On a shed big enough to take the deepest one, the priced tiles and the
     offered ladder must be the same list. A depth in one and not the other is
     either a blank tile or a price for something nobody can pick. */
  const d = (await quote({ style: 'gable', w: 26, l: 34, h: 9,
                           porchLoc: 'front', porchDepth: 6, porchTier: 'standard' })).optionPrices;
  const offered = d.limits.porchDepths.map(String).sort();
  assert.deepEqual(Object.keys(d.porch.frontDepths).sort(), offered,
    'the front porch tiles do not match the depths on offer');
  assert.deepEqual(Object.keys(d.porch.sideDepths).sort(), offered,
    'the side porch tiles do not match the depths on offer');
  for (const [ft, price] of Object.entries(d.porch.frontDepths)) {
    assert.ok(price > 0, `the ${ft}ft front porch tile shows ${price}`);
  }
});

test('a deeper porch costs more, on the tile and in the total', async () => {
  /* The control. Without it, a build that priced every depth the same would
     satisfy the test above. Checked in BOTH places, because they are computed
     separately — the tile from porchLineFor, the total from computePricing —
     and the 10ft case was right in one and missing from the other. */
  const cfg = { style: 'gable', w: 16, l: 24, h: 9, porchLoc: 'front', porchTier: 'standard' };
  const tiles = (await quote(Object.assign({}, cfg, { porchDepth: 6 }))).optionPrices.porch.frontDepths;
  const depths = Object.keys(tiles).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i++) {
    assert.ok(tiles[depths[i]] > tiles[depths[i - 1]],
      `the ${depths[i]}ft tile is not dearer than the ${depths[i - 1]}ft one`);
  }
  const shallow = await quote(Object.assign({}, cfg, { porchDepth: depths[0] }));
  const deep = await quote(Object.assign({}, cfg, { porchDepth: depths[depths.length - 1] }));
  assert.ok(deep.total > shallow.total,
    `a ${depths[depths.length - 1]}ft porch does not cost more in the total than a ${depths[0]}ft one`);
});

test('a footprint too small for a depth is not offered it', async () => {
  // The ladder is filtered by what the shed can carry, so a small shed shows
  // fewer tiles — not blank ones.
  const d = (await quote({ style: 'gable', w: 10, l: 12, h: 9,
                           porchLoc: 'front', porchDepth: 4, porchTier: 'standard' })).optionPrices;
  const priced = Object.keys(d.porch.frontDepths).map(Number);
  assert.ok(priced.length > 0, 'a 10x12 can take no porch at all');
  assert.ok(Math.max(...priced) <= 12 - 6, 'a depth was offered that eats the whole shed');
  assert.ok(priced.length < d.limits.porchDepths.length, 'a 12ft shed is being offered every depth');
});
