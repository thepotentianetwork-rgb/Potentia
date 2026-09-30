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
