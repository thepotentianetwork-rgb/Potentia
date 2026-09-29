/* A SMALL STRIPE CLIENT, BECAUSE THE WORKER HAS NO DEPENDENCIES.
 *
 * worker/index.js is pasted into the Cloudflare dashboard as one file. There is
 * no npm install, so no stripe SDK. This is the slice of the REST API this
 * feature uses, written against the documented wire format.
 *
 * The Stripe API is FORM-ENCODED, not JSON, with a bracket syntax for nested
 * values — payment_method_types[0]=us_bank_account, not a JSON array. Getting
 * that wrong does not error usefully: Stripe ignores what it cannot parse, so
 * an invoice quietly comes out with the default payment methods and the
 * default tax behaviour instead of the ones asked for. That is why the encoder
 * is its own function with its own tests.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/* Stripe's form encoding. Nested objects become a[b], arrays become a[0].
   Null and undefined are dropped rather than sent as the string "null", which
   Stripe would take literally. false and 0 are kept — automatic_tax[enabled]
   being false is the whole point of sending it. */
export function stripeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') stripeForm(item, `${key}[${i}]`, out);
        else out.push([`${key}[${i}]`, String(item)]);
      });
    } else if (typeof v === 'object') {
      stripeForm(v, key, out);
    } else {
      out.push([key, String(v)]);
    }
  }
  return prefix ? out : out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/* One call. Errors come back from Stripe as JSON with an error.message worth
   showing whoever pressed the button — "Your card was declined" or "No such
   customer" is far more use than "Stripe 400". */
export async function stripeCall(env, path, body, opts = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured on this worker');
  const headers = {
    Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  /* Stripe deduplicates on this key for 24 hours. Without it, a double-tapped
     button is two invoices to the same customer for the same shed. */
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(STRIPE_API + path, {
    method: opts.method || 'POST',
    headers,
    body: body === undefined ? undefined : stripeForm(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe returned ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.stripeCode = data && data.error && data.error.code;
    throw err;
  }
  return data;
}

/* ACH and card. On an eleven thousand dollar shed the difference is about
   $360 — ACH is capped at $5, a card is 2.9% plus the invoicing fee. Card
   stays offered because some people will always reach for it, and a deposit
   that does not get paid is worse than one that costs more.

   The array order is NOT a display order: Stripe decides how the hosted
   invoice page presents them. An earlier version of this comment claimed
   otherwise. Listing ACH first is harmless but buys nothing. */
/* STRIPE_ prefixed, not PAYMENT_METHODS: index.js already has a constant by
   that name for the ways a human can record a payment, and the bundler
   inlines every module at top level. A duplicate const there is a
   SyntaxError that takes down the whole worker, not just this feature. */
export const STRIPE_PAYMENT_METHODS = ['us_bank_account', 'card'];

/* Days until due, per kind. A deposit gates the build starting, so it is due
   when it arrives; the balance is billed against work already done. */
export const DAYS_UNTIL_DUE = { deposit: 0, balance: 7 };

/* Create a customer, or reuse one we already recorded.
   Stripe will happily create a second customer with the same email, which is
   how a business ends up with four Jenny Rosens and a payment history split
   across all of them. */
export async function ensureCustomer(env, { stripeCustomerId, name, email, phone }) {
  if (stripeCustomerId) return { id: stripeCustomerId, created: false };
  if (!email) throw new Error('this customer has no email address to invoice');
  const c = await stripeCall(env, '/customers', { name, email, phone });
  return { id: c.id, created: true };
}

/* The documented sequence: create the invoice, add its items, then send.
 *
 * auto_advance is false so the invoice stays a draft while the lines go on —
 * otherwise Stripe can finalize it the moment it is created and the items
 * arrive on a document that is already legally frozen.
 *
 * automatic_tax is explicitly OFF. The quote already computed Utah sales tax
 * and every amount here is tax-inclusive; letting Stripe add its own would
 * overcharge by 7.25% and nothing in this code would notice.
 */
export async function createAndSendInvoice(env, {
  customerId, lines, kind, description, footer, customFields, idempotencyKey, metadata
}) {
  const days = DAYS_UNTIL_DUE[kind];
  if (days === undefined) throw new Error(`unknown invoice kind: ${kind}`);

  const invoice = await stripeCall(env, '/invoices', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: days,
    /* NESTED, not top level. On the Invoice API a top-level
       payment_method_types is rejected outright — "Received unknown
       parameter: payment_method_types. Did you mean payment_settings?" — and
       it was, by Stripe, on the first real invoice anyone tried to send. It
       belongs under payment_settings. (payment_method_types IS top level on
       PaymentIntents and Checkout Sessions, which is where the wrong shape
       came from.) */
    payment_settings: { payment_method_types: STRIPE_PAYMENT_METHODS },
    auto_advance: false,
    automatic_tax: { enabled: false },
    currency: 'usd',
    description: description || undefined,
    footer: footer || undefined,
    /* Up to four, across the top of the invoice. Sent only when there are
       any: an empty array is not the same as leaving the parameter off, and
       Stripe reads one as "clear them". */
    custom_fields: (customFields && customFields.length) ? customFields : undefined,
    metadata: metadata || undefined,
  }, { idempotencyKey: idempotencyKey ? idempotencyKey + ':invoice' : undefined });

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await stripeCall(env, '/invoiceitems', {
      customer: customerId,
      invoice: invoice.id,
      amount: l.amountCents,
      currency: 'usd',
      description: l.label,
    }, { idempotencyKey: idempotencyKey ? `${idempotencyKey}:item:${i}` : undefined });
  }

  /* Sending finalizes it. From here the monetary values cannot be edited —
     which is the behaviour we want, and why a mistake is fixed by voiding and
     reissuing rather than by editing. */
  const sent = await stripeCall(env, `/invoices/${invoice.id}/send`, {},
    { idempotencyKey: idempotencyKey ? idempotencyKey + ':send' : undefined });

  /* Normalised, so nothing downstream has to know Stripe's spelling.
     RESPONSE_FIELDS below is the list this reads from the invoice object, and
     a test checks nothing outside it is touched — because reading a field
     Stripe does not return is NOT an error. It is undefined, it is stored as
     null, and the first sign of trouble is a missing link in the CRM a week
     later. That is exactly how this function came to read
     `hosted_invoice_page`, which is not a field on the invoice object at all;
     the real one is `hosted_invoice_url`. */
  return {
    id: sent.id,
    status: sent.status || 'open',
    hostedUrl: sent.hosted_invoice_url || null,
  };
}

/* Fields this module reads off a Stripe invoice object, checked against the
   API reference. Kept beside the code that reads them so the test below has
   something to compare against. */
export const RESPONSE_FIELDS = ['id', 'status', 'hosted_invoice_url', 'amount_paid'];

/* Ask Stripe what actually happened, instead of waiting to be told.
 *
 * The webhook is the normal path and this is not a replacement for it — it is
 * the path for when the webhook did not arrive, which happens, and whose
 * failure mode is the CRM insisting a customer has not paid when they have.
 * Read-only: it answers a question and changes nothing at Stripe. */
export async function getInvoice(env, stripeInvoiceId) {
  const inv = await stripeCall(env, '/invoices/' + encodeURIComponent(stripeInvoiceId),
    undefined, { method: 'GET' });
  return {
    id: inv.id,
    status: inv.status || null,
    hostedUrl: inv.hosted_invoice_url || null,
    amountPaidCents: Number(inv.amount_paid) || 0,
  };
}

export async function voidInvoice(env, stripeInvoiceId) {
  return stripeCall(env, `/invoices/${stripeInvoiceId}/void`, {});
}
