/* THE ENDPOINT THAT MARKS SHEDS AS PAID.
 *
 * It is public. Everything an attacker needs is the URL, unless the signature
 * check is exactly right. These are the forgeries worth trying.
 *
 * Run: node --test worker/stripewebhook.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyStripeSignature, parseSignatureHeader, computeSignature,
         timingSafeEqual, DEFAULT_TOLERANCE_SECONDS } from './stripewebhook.js';

const SECRET = 'whsec_abcdef0123456789';
const BODY = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
const NOW = 1790000000;

async function headerFor(body = BODY, t = NOW, secret = SECRET) {
  return `t=${t},v1=${await computeSignature(secret, `${t}.${body}`)}`;
}
const check = (body, header, opts) =>
  verifyStripeSignature(body, header, SECRET, { nowSeconds: NOW, ...opts });

test('a genuine event verifies', async () => {
  assert.deepEqual(await check(BODY, await headerFor()), { ok: true });
});

/* THE ONE THAT MATTERS. Anyone can POST this. */
test('an event with no signature at all is refused', async () => {
  for (const h of ['', null, undefined, 'garbage', 't=', 'v1=abc']) {
    const r = await check(BODY, h);
    assert.equal(r.ok, false, `header ${JSON.stringify(h)} was accepted`);
  }
});

test('a signature signed with the wrong secret is refused', async () => {
  const forged = `t=${NOW},v1=${await computeSignature('whsec_attacker', `${NOW}.${BODY}`)}`;
  assert.equal((await check(BODY, forged)).ok, false);
});

/* Change one dollar figure and the signature no longer covers it. */
test('a body altered after signing is refused', async () => {
  const header = await headerFor(BODY);
  const tampered = BODY.replace('in_1', 'in_9');
  assert.equal((await check(tampered, header)).ok, false);
});

/* Stripe sends a deliberately bogus v0 alongside the real one. Trying every
   scheme and accepting whichever verifies is a downgrade attack. */
test('a v0 signature is ignored, never tried', async () => {
  const parsed = parseSignatureHeader(`t=${NOW},v0=deadbeef,v1=abc123`);
  assert.deepEqual(parsed.v1, ['abc123'], 'only v1 should be collected');

  /* A header carrying ONLY v0 — even a correctly computed one — is not a
     signature this endpoint recognises. */
  const v0only = `t=${NOW},v0=${await computeSignature(SECRET, `${NOW}.${BODY}`)}`;
  const r = await check(BODY, v0only);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no v1 signature/);
});

/* A valid event captured once, posted again next month, still verifies without
   this. The same "paid" event, forever. */
test('a replayed event outside the window is refused', async () => {
  const old = await headerFor(BODY, NOW - DEFAULT_TOLERANCE_SECONDS - 1);
  const r = await check(BODY, old);
  assert.equal(r.ok, false);
  assert.match(r.reason, /tolerance/);

  /* Just inside is fine, and so is a clock a little ahead. */
  assert.equal((await check(BODY, await headerFor(BODY, NOW - DEFAULT_TOLERANCE_SECONDS + 5))).ok, true);
  assert.equal((await check(BODY, await headerFor(BODY, NOW + 30))).ok, true);
});

test('the tolerance is not zero, which would disable the check entirely', () => {
  assert.ok(DEFAULT_TOLERANCE_SECONDS > 0);
  assert.equal(DEFAULT_TOLERANCE_SECONDS, 300, "Stripe's documented default");
});

/* While a secret is being rolled, Stripe signs with both. */
test('during a secret roll, any one of several v1 signatures is enough', async () => {
  const real = await computeSignature(SECRET, `${NOW}.${BODY}`);
  assert.equal((await check(BODY, `t=${NOW},v1=deadbeef,v1=${real}`)).ok, true, 'second signature');
  assert.equal((await check(BODY, `t=${NOW},v1=${real},v1=deadbeef`)).ok, true, 'first signature');
});

test('a worker with no signing secret configured accepts nothing', async () => {
  const r = await verifyStripeSignature(BODY, await headerFor(), '', { nowSeconds: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no signing secret/);
});

/* Re-serialising the body changes key order and whitespace, and the signature
   is over the bytes. This is the mistake that makes verification "randomly"
   fail in production. */
test('the body must be the raw bytes, not a re-serialised object', async () => {
  const header = await headerFor(BODY);
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
  assert.notEqual(reserialised, BODY);
  assert.equal((await check(reserialised, header)).ok, false);
});

test('the comparison does not exit early on the first wrong byte', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false, 'length must count');
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual('a', ''), false);
  /* A repeat of the shorter string. An implementation that wraps the index
     with modulo calls these equal as soon as the length term is gone, so the
     loop has to disagree on its own. */
  assert.equal(timingSafeEqual('ab', 'abab'), false);
  assert.equal(timingSafeEqual('abcabc', 'abc'), false);
});

/* A STRUCTURAL CHECK, BECAUSE THE PROPERTY IS NOT OBSERVABLE FROM OUTSIDE.
 *
 * An early-exit comparison returns exactly the same answers as a constant-time
 * one. Every test above passes against it. What differs is how long a wrong
 * guess takes to reject, and that difference is enough to forge a signature a
 * byte at a time. A timing assertion in JS would be flaky and prove little, so
 * the shape of the loop is what gets checked: someone "tidying" this into an
 * early return is the realistic way it regresses.
 */
test('the comparison loop has no early exit', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./stripewebhook.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function timingSafeEqual'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const loop = body.slice(body.indexOf('for ('));
  assert.ok(!/\breturn\b/.test(loop.slice(0, loop.indexOf('\n  }'))),
    'returning from inside the loop makes the comparison variable-time');
  assert.match(body, /\|=/, 'differences must accumulate into one value, not short-circuit');
});
