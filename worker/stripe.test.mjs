/* WHAT ACTUALLY GOES ON THE WIRE TO STRIPE.
 *
 * No key and no network: fetch is stubbed and every request is captured, so
 * these assert the exact form body Stripe would receive. That matters more
 * than usual here, because Stripe IGNORES parameters it cannot parse. A
 * mis-encoded payment_method_types does not error — the invoice just comes out
 * with the default payment methods, which on an $11k shed is the difference
 * between a $5 ACH fee and about $360 on a card. Nothing would flag it.
 *
 * Run: node --test worker/stripe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripeForm, stripeCall, createAndSendInvoice, ensureCustomer,
         STRIPE_PAYMENT_METHODS, DAYS_UNTIL_DUE, RESPONSE_FIELDS } from './stripe.js';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_fake' };

/* Captures every call and replies the way Stripe would. */
function stubFetch(replies) {
  const calls = [];
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const body = init.body || '';
    calls.push({
      url, method: init.method, headers: init.headers, body,
      params: Object.fromEntries(new URLSearchParams(body)),
    });
    const r = replies[n++] || { ok: true, json: { id: 'obj_' + n } };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ── the encoder ────────────────────────────────────────────────────────────

test('arrays use Stripe bracket indexes, not JSON', () => {
  const s = stripeForm({ payment_method_types: ['us_bank_account', 'card'] });
  assert.equal(s, 'payment_method_types%5B0%5D=us_bank_account&payment_method_types%5B1%5D=card');
  assert.ok(!s.includes('%5B%5D'), 'not payment_method_types[]');
  assert.ok(!s.includes('%22'), 'no JSON quoting');
});

test('nested objects become a[b]', () => {
  assert.equal(decodeURIComponent(stripeForm({ automatic_tax: { enabled: false } })),
    'automatic_tax[enabled]=false');
});

/* false and 0 must survive: automatic_tax[enabled]=false is the parameter that
   stops Stripe adding tax on top of an already-tax-inclusive amount, and
   days_until_due=0 is what makes a deposit due on receipt. */
test('false and zero are sent, null and undefined are dropped', () => {
  const s = decodeURIComponent(stripeForm({
    a: false, b: 0, c: null, d: undefined, e: '',
  }));
  assert.match(s, /a=false/);
  assert.match(s, /b=0/);
  assert.ok(!s.includes('c='), 'null must not be sent as "null"');
  assert.ok(!s.includes('d='), 'undefined must not be sent');
  assert.match(s, /e=/, 'an empty string is a real value');
});

test('negative amounts survive encoding, because credits are negative', () => {
  assert.equal(decodeURIComponent(stripeForm({ amount: -240000 })), 'amount=-240000');
});

test('values are escaped, so a shed name with an ampersand cannot break the body', () => {
  const s = stripeForm({ description: 'Phase 1 — Concrete & Pad' });
  assert.ok(!s.includes('&Pad'), 'an unescaped & would start a new parameter');
  assert.equal(Object.fromEntries(new URLSearchParams(s)).description, 'Phase 1 — Concrete & Pad');
});

// ── the call ───────────────────────────────────────────────────────────────

test('it refuses to run without a key rather than calling Stripe unauthenticated', async () => {
  await assert.rejects(() => stripeCall({}, '/customers', {}), /not configured/);
});

test("Stripe's own error message is what surfaces", async () => {
  const f = stubFetch([{ ok: false, status: 402, json: { error: { message: 'Your card was declined.', code: 'card_declined' } } }]);
  await assert.rejects(() => stripeCall(ENV, '/invoices', {}), (e) => {
    assert.equal(e.message, 'Your card was declined.');
    assert.equal(e.status, 402);
    assert.equal(e.stripeCode, 'card_declined');
    return true;
  });
  f.restore();
});

// ── the invoice sequence ───────────────────────────────────────────────────

const LINES = [
  { label: 'Phase 1 — Concrete Pad (4" slab) — 30% deposit (tax included)', amountCents: 64350 },
  { label: 'Phase 2 — Shed — 30% deposit (tax included)', amountCents: 181350 },
];

async function sendOne(extra = {}) {
  const f = stubFetch([
    { json: { id: 'in_123' } },                       // create invoice
    { json: { id: 'ii_1' } }, { json: { id: 'ii_2' } }, // items
    { json: { id: 'in_123', status: 'open', hosted_invoice_url: 'https://pay/x' } },
  ]);
  const sent = await createAndSendInvoice(ENV, {
    customerId: 'cus_1', lines: LINES, kind: 'deposit',
    idempotencyKey: 'sub42:deposit', ...extra,
  });
  f.restore();
  return { calls: f.calls, sent };
}

test('create, one call per line, then send', async () => {
  const { calls, sent } = await sendOne();
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
    '/v1/invoices', '/v1/invoiceitems', '/v1/invoiceitems', '/v1/invoices/in_123/send',
  ]);
  assert.equal(sent.hostedUrl, 'https://pay/x');
});

/* THE SHAPE STRIPE ACTUALLY ACCEPTS.
 *
 * This test used to assert payment_method_types[0] at the TOP level and
 * passed every time, because the stub below accepts whatever it is handed.
 * Stripe does not: the first real invoice anyone tried to send came back
 * "Received unknown parameter: payment_method_types. Did you mean
 * payment_settings?" and nothing went out. On the Invoice API the field is
 * nested under payment_settings; it is top level on PaymentIntents and
 * Checkout Sessions, which is where the wrong shape came from.
 *
 * So this asserts the nested path AND the absence of the top-level one — a
 * test that only checks the right key is still green if the wrong key is
 * sent alongside it, and the wrong key is what causes the rejection. */
test('the payment methods go under payment_settings, where the Invoice API wants them', async () => {
  const { calls } = await sendOne();
  const p = calls[0].params;
  assert.equal(p['payment_settings[payment_method_types][0]'], 'us_bank_account');
  assert.equal(p['payment_settings[payment_method_types][1]'], 'card');
  assert.deepEqual(STRIPE_PAYMENT_METHODS, ['us_bank_account', 'card']);
  assert.equal(Object.keys(p).filter((k) => k.startsWith('payment_method_types')).length, 0,
    'a top-level payment_method_types is rejected outright by Stripe: ' +
    JSON.stringify(Object.keys(p)));
});

/* Nothing else may quietly climb to the top level either, on any of the calls.
   Stripe's failure mode for a parameter it does not recognise on a given
   endpoint is a hard rejection — no invoice, no row, and a red box in the CRM
   — and the parameter that is right on one endpoint is wrong on another, which
   is exactly how the last one got in. Each list below is what the API
   reference documents for that endpoint. */
/* THE SAME BUG, ON THE WAY BACK.
 *
 * Sending a wrong parameter name at least gets rejected. READING a wrong
 * field name does not: Stripe returns the invoice, the missing field is
 * undefined, it is stored as null, and the CRM quietly shows an invoice with
 * no link to pay it. That shipped — the field is `hosted_invoice_url` and
 * this module read `hosted_invoice_page`, which does not exist. Every test
 * passed, because every stub here invented the field the code asked for.
 *
 * A stub cannot catch that, so this reads the source instead: every field
 * pulled off a Stripe invoice response must be one the API reference
 * documents. */
const INVOICE_OBJECT_FIELDS = [
  'id', 'object', 'status', 'hosted_invoice_url', 'invoice_pdf', 'amount_due',
  'amount_paid', 'amount_remaining', 'currency', 'customer', 'number', 'total',
  'subtotal', 'due_date', 'created', 'livemode', 'metadata', 'payment_settings',
  'collection_method', 'description', 'footer', 'auto_advance', 'automatic_tax',
];
test('every field read off a Stripe invoice is one the API documents', () => {
  const src = readFileSync(new URL('./stripe.js', import.meta.url), 'utf8');
  /* The three names createAndSendInvoice binds Stripe responses to. */
  const read = [...src.matchAll(/\b(?:sent|invoice|c)\.([a-z_][a-z0-9_]*)\b/g)]
    .map((m) => m[1]);
  const bogus = [...new Set(read)].filter((f) => !INVOICE_OBJECT_FIELDS.includes(f));
  assert.deepEqual(bogus, [], 'not fields on a Stripe invoice object: ' + bogus.join(', '));
});

test('the declared response fields match what the code actually reads', () => {
  for (const f of RESPONSE_FIELDS) {
    assert.ok(INVOICE_OBJECT_FIELDS.includes(f), f + ' is not a documented invoice field');
  }
});

const DOCUMENTED = {
  '/v1/invoices': ['customer', 'collection_method', 'days_until_due', 'auto_advance',
    'automatic_tax', 'currency', 'description', 'footer', 'metadata', 'payment_settings',
    'custom_fields'],
  '/v1/invoiceitems': ['customer', 'invoice', 'amount', 'currency', 'description'],
};
test('every parameter sent is one that endpoint documents', async () => {
  const { calls } = await sendOne();
  for (const c of calls) {
    const known = DOCUMENTED[new URL(c.url).pathname];
    if (!known) continue;                       // /send takes no parameters
    const roots = [...new Set(Object.keys(c.params).map((k) => k.split('[')[0]))];
    const unknown = roots.filter((r) => !known.includes(r));
    assert.deepEqual(unknown, [],
      'not documented on POST ' + new URL(c.url).pathname + ': ' + unknown.join(', '));
  }
});

/* The 7.25% overcharge that would not raise an error anywhere. */
test('Stripe is told not to add tax, because the amounts already include it', async () => {
  const { calls } = await sendOne();
  assert.equal(calls[0].params['automatic_tax[enabled]'], 'false');
});

test('the invoice stays a draft until the lines are on it', async () => {
  const { calls } = await sendOne();
  assert.equal(calls[0].params.auto_advance, 'false',
    'finalizing early would freeze an invoice with no lines on it');
  assert.equal(calls[0].params.collection_method, 'send_invoice');
});

test('a deposit is due on receipt, a balance in seven days', async () => {
  const { calls } = await sendOne();
  assert.equal(calls[0].params.days_until_due, '0');
  const b = await sendOne({ kind: 'balance' });
  assert.equal(b.calls[0].params.days_until_due, '7');
  assert.deepEqual(DAYS_UNTIL_DUE, { deposit: 0, balance: 7 });
});

test('the lines arrive with their labels and exact cents', async () => {
  const { calls } = await sendOne();
  assert.equal(calls[1].params.amount, '64350');
  assert.equal(calls[1].params.description, LINES[0].label);
  assert.equal(calls[1].params.invoice, 'in_123');
  assert.equal(calls[2].params.amount, '181350');
});

/* A double-tapped button is two invoices to the same customer for the same
   shed, and the second one cannot be un-sent. */
test('every call carries a distinct idempotency key', async () => {
  const { calls } = await sendOne();
  const keys = calls.map((c) => c.headers['Idempotency-Key']);
  assert.deepEqual(keys, ['sub42:deposit:invoice', 'sub42:deposit:item:0',
                          'sub42:deposit:item:1', 'sub42:deposit:send']);
  assert.equal(new Set(keys).size, keys.length, 'keys must not repeat within one send');
});

test('an unknown kind is refused before anything reaches Stripe', async () => {
  const f = stubFetch([]);
  await assert.rejects(() => createAndSendInvoice(ENV, { customerId: 'c', lines: [], kind: 'tip' }),
    /unknown invoice kind/);
  assert.equal(f.calls.length, 0, 'nothing should have been sent');
  f.restore();
});

// ── customers ──────────────────────────────────────────────────────────────

test('an existing Stripe customer is reused, not duplicated', async () => {
  const f = stubFetch([]);
  const r = await ensureCustomer(ENV, { stripeCustomerId: 'cus_old', email: 'a@b.test' });
  assert.deepEqual(r, { id: 'cus_old', created: false });
  assert.equal(f.calls.length, 0, 'it should not have called Stripe at all');
  f.restore();
});

test('a customer with no email is refused, with a reason worth reading', async () => {
  const f = stubFetch([]);
  await assert.rejects(() => ensureCustomer(ENV, { name: 'Hank' }), /no email address/);
  f.restore();
});
