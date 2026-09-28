/* WHAT AN INVOICE ACTUALLY CHARGES, WORKED OUT BEFORE STRIPE IS INVOLVED.
 *
 * Kept apart from the Stripe calls on purpose: this is the half that decides
 * how much money to ask a customer for, and it should be runnable — and wrong
 * in an obvious way — without a network, an API key or a sandbox.
 *
 * Everything here comes from quoteLines(), so the invoice cannot disagree with
 * the quote the customer already saw. Nothing is re-derived.
 *
 * TWO THINGS THAT WOULD OTHERWISE BITE:
 *
 * 1. Stripe takes integer CENTS. Rounding each line independently and letting
 *    them fall where they may is how an invoice ends up a penny off its own
 *    total — which looks like sloppiness on a document about money, and on a
 *    balance invoice means the job never quite reaches zero. The lines here are
 *    reconciled against the total, and a test asserts they sum to it exactly.
 *
 * 2. The amounts are TAX-INCLUSIVE. The quote computes Utah sales tax itself,
 *    and a phase's deposit is 30% of its tax-included figure. So Stripe must
 *    not add tax on top — no tax rates on the items, Stripe Tax off for these
 *    invoices. Sending a tax-inclusive amount to a tax-computing invoice is a
 *    7.25% overcharge that nothing in the code would flag.
 */

export const KINDS = ['deposit', 'balance'];

/* Money in, money out, in the unit Stripe speaks. Rounded half away from zero
   rather than JS's default half-up, so a credit of -0.005 and a charge of
   0.005 land symmetrically instead of both rounding upward. */
export function toCents(n) {
  const v = Number(n) || 0;
  return Math.sign(v) * Math.round(Math.abs(v) * 100);
}

export function fromCents(c) { return (Number(c) || 0) / 100; }

/* Reconcile a set of line amounts so they sum to exactly `totalCents`.
   The residue lands on the LARGEST line, where a penny is least visible, not
   on the last one, which on a balance invoice is a credit — adjusting a credit
   to fix a rounding error would misstate what the customer has paid. */
function reconcile(lines, totalCents) {
  if (!lines.length) return lines;
  const sum = lines.reduce((t, l) => t + l.amountCents, 0);
  const drift = totalCents - sum;
  if (!drift) return lines;
  let target = 0;
  for (let i = 1; i < lines.length; i++) {
    if (Math.abs(lines[i].amountCents) > Math.abs(lines[target].amountCents)) target = i;
  }
  lines[target].amountCents += drift;
  return lines;
}

/* The deposit: 30% of each phase's tax-included total, one line per phase, so
   the customer sees the same phases the quote showed them rather than a single
   unexplained number. */
function depositInvoice(bd) {
  const lines = bd.rows.map((r) => ({
    label: r.label + ' — 30% deposit (tax included)',
    amountCents: toCents(r.deposit)
  })).filter((l) => l.amountCents !== 0);
  const totalCents = toCents(bd.depositTotal);
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* The balance: the whole job, less what has already been paid.
 *
 * NOT "the other 70%". A customer who paid a round number, or paid twice, or
 * whose deposit was taken by check before any of this existed, would be
 * overcharged by a flat 70% — and the error grows with how unusual the
 * payment history is, which is exactly when nobody is checking.
 *
 * Payments arrive as [{amount, method, paid_at}] and are listed individually
 * as credits rather than netted into one figure, so the invoice shows its own
 * arithmetic and a wrongly-applied payment is visible on the document instead
 * of buried in a subtraction. */
function balanceInvoice(bd, payments) {
  const lines = bd.rows.map((r) => ({
    label: r.label + ' (tax included)',
    amountCents: toCents(r.total)
  })).filter((l) => l.amountCents !== 0);

  (payments || []).forEach((p) => {
    const c = toCents(p.amount);
    if (!c) return;
    const when = p.paid_at ? ' ' + String(p.paid_at).slice(0, 10) : '';
    const how = p.method ? ' by ' + p.method : '';
    lines.push({ label: 'Payment received' + how + when, amountCents: -Math.abs(c) });
  });

  const jobCents = toCents(bd.total);
  const paidCents = (payments || []).reduce((t, p) => t + Math.abs(toCents(p.amount)), 0);
  const totalCents = jobCents - paidCents;
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* Build one invoice.
 *
 * Returns { kind, lines, totalCents, jobTotalCents, paidCents } — or throws.
 * Throwing rather than returning a zero invoice is deliberate: every caller
 * here is a button someone pressed meaning "bill this person", and silently
 * billing nothing is worse than an error they can read. */
export function buildInvoice(breakdown, kind, payments) {
  if (!KINDS.includes(kind)) throw new Error(`unknown invoice kind: ${kind}`);
  if (!breakdown || !Array.isArray(breakdown.rows) || !breakdown.rows.length) {
    throw new Error('this submission has no priced phases to invoice');
  }
  const paid = payments || [];
  const out = kind === 'deposit' ? depositInvoice(breakdown) : balanceInvoice(breakdown, paid);

  if (out.totalCents <= 0) {
    throw new Error(kind === 'balance'
      ? 'nothing left to invoice — payments already cover this job'
      : 'the deposit for this job works out to nothing');
  }
  return {
    kind,
    lines: out.lines,
    totalCents: out.totalCents,
    jobTotalCents: toCents(breakdown.total),
    paidCents: paid.reduce((t, p) => t + Math.abs(toCents(p.amount)), 0)
  };
}
