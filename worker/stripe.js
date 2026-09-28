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

const API = 'https://api.stripe.com/v1';

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

  const res = await fetch(API + path, {
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

/* ACH first, card second. On an eleven thousand dollar shed the difference is
   about $360 — ACH is capped at $5, a card is 2.9% plus the invoicing fee. The
   order is the order they appear to the customer, so the cheaper one is the
   one they see first. Card stays because some people will always reach for it,
   and a deposit that does not get paid is worse than one that costs more. */
export const PAYMENT_METHODS = ['us_bank_account', 'card'];

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
  customerId, lines, kind, description, footer, idempotencyKey, metadata
}) {
  const days = DAYS_UNTIL_DUE[kind];
  if (days === undefined) throw new Error(`unknown invoice kind: ${kind}`);

  const invoice = await stripeCall(env, '/invoices', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: days,
    payment_method_types: PAYMENT_METHODS,
    auto_advance: false,
    automatic_tax: { enabled: false },
    currency: 'usd',
    description: description || undefined,
    footer: footer || undefined,
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

  return sent;
}

export async function voidInvoice(env, stripeInvoiceId) {
  return stripeCall(env, `/invoices/${stripeInvoiceId}/void`, {});
}
