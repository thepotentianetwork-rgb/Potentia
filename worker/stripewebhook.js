/* VERIFYING THAT AN EVENT REALLY CAME FROM STRIPE.
 *
 * This endpoint is public and it marks sheds as paid. Unverified, anyone who
 * learns the URL can post {"type":"invoice.paid"} and clear an $11,000 balance.
 * There is no second check downstream — the CRM believes what lands here.
 *
 * Implemented from Stripe's documented scheme rather than their SDK, because
 * the worker is pasted into a dashboard as one file and has no dependencies.
 *
 * Three things here are load-bearing, and each is a real vulnerability if got
 * wrong rather than a style preference:
 *
 *   1. ONLY the v1 scheme is accepted. Stripe deliberately sends a bogus v0
 *      signature alongside real ones. Accepting any scheme that verifies is a
 *      downgrade attack: an attacker picks the weak one.
 *
 *   2. The comparison is constant time. A byte-by-byte compare that returns
 *      early leaks, through timing, how much of a guessed signature was right,
 *      which is enough to forge one a byte at a time.
 *
 *   3. The timestamp is checked against a tolerance. Without it a valid event
 *      captured once can be replayed forever — the same "paid" event posted
 *      again next month still verifies.
 */

/* Stripe's default, and their explicit advice: never 0, which disables the
   recency check entirely rather than tightening it. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/* t=1492774577,v1=5257a8...,v0=6ffbb5...  — one line, comma separated. */
export function parseSignatureHeader(header) {
  const out = { timestamp: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') out.timestamp = Number(value);
    /* v0 is Stripe's deliberately fake test signature. Anything that is not
       v1 is ignored outright — not tried and rejected, never looked at. */
    else if (key === 'v1') out.v1.push(value);
  });
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Compares every byte regardless of where it first differs. Length is folded
   in through the accumulator rather than returned on early, so a wrong-length
   guess is not distinguishable by timing either. */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  /* The length is folded in rather than returned on early, so a wrong-length
     guess is not distinguishable by timing either. Out of range reads as 0
     instead of wrapping the index: an earlier version used modulo, which made
     "ab" and "abab" compare equal the moment the length term came out. */
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return mismatch === 0;
}

export async function computeSignature(secret, signedPayload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload)));
}

/* rawBody must be the body EXACTLY as it arrived. Parsing and re-serialising
   changes key order and whitespace, and the signature is over the bytes.
   Returns { ok } or { ok: false, reason } — the reason is for a log, never for
   the response: telling a caller which part of their forgery failed helps them. */
export async function verifyStripeSignature(rawBody, header, secret, opts = {}) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!timestamp || !isFinite(timestamp)) return { ok: false, reason: 'no timestamp in the signature header' };
  if (!v1.length) return { ok: false, reason: 'no v1 signature in the header' };

  const tolerance = opts.toleranceSeconds === undefined ? DEFAULT_TOLERANCE_SECONDS : opts.toleranceSeconds;
  const now = opts.nowSeconds === undefined ? Math.floor(Date.now() / 1000) : opts.nowSeconds;
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp outside the tolerance window' };
  }

  const expected = await computeSignature(secret, `${timestamp}.${rawBody}`);
  /* Several v1 signatures arrive while a secret is being rolled — one per
     active secret — so any match is a match. Every candidate is compared, with
     no early exit on success either. */
  let matched = false;
  for (const candidate of v1) if (timingSafeEqual(expected, candidate)) matched = true;
  return matched ? { ok: true } : { ok: false, reason: 'signature did not match' };
}
