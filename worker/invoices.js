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
  /* `fixed` lines are off limits: a payment credit is a statement of what the
     customer actually handed over, and a customer who paid $2,091.52 and sees
     $2,091.51 credited has found a discrepancy in the one document where
     finding one destroys their confidence in all of it. Only lines we
     computed get adjusted. Previously this picked the largest line outright,
     which on a balance invoice could be the deposit credit. */
  /* A line marked `residue` is the designated place for the odd penny — on a
     deposit that is the deferral, a figure derived here and printed nowhere
     else, so a cent on it contradicts nothing the customer can check. */
  let target = lines.findIndex((l) => l.residue && !l.fixed);
  if (target < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].fixed) continue;
      if (target < 0 || Math.abs(lines[i].amountCents) > Math.abs(lines[target].amountCents)) target = i;
    }
  }
  if (target < 0) target = 0;
  lines[target].amountCents += drift;
  return lines;
}

/* THE LINES, IN THE SAME ORDER AND THE SAME WORDS AS THE QUOTE.
 *
 * The quote a customer already read shows: each phase at its pre-tax price,
 * then each adjustment on its own line with the note that was written for it,
 * then sales tax. So that is what the invoice shows. Re-stating the same job
 * in a different shape — a single "30% deposit" line, say — makes a customer
 * check one document against the other, and the one place they must never
 * have to do that is the one asking for money.
 *
 * What differs between the two kinds is only the LAST line:
 *
 *   deposit — the rest is deferred, so a single credit carries 70% forward
 *   balance — what has actually been paid comes off, one credit per payment
 *
 * Both therefore show the whole job on the face of the invoice, which is also
 * what makes the second one add up in front of the customer.
 */
function pct(rate) {
  const s = ((Number(rate) || 0) * 100).toFixed(2);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/* The rates are DERIVED from the breakdown, not restated here. Two reasons,
   and the second is the hard one: a second copy of TAX_RATE would drift from
   quotelines.js the day either changes, and the bundler inlines every module
   at top level, so a second `const TAX_RATE` is a SyntaxError that stops the
   whole worker. Reading them back out of the numbers quoteLines produced
   keeps one source of truth and cannot collide. */
function taxRateOf(bd) {
  return bd.adjustedSubtotal > 0 ? bd.tax / bd.adjustedSubtotal : 0;
}
function depositRateOf(bd) {
  return bd.total > 0 ? bd.depositTotal / bd.total : 0;
}

/* One line per adjustment, labelled the way the quote labels it — including
   the note, which is often the whole explanation ("Honoring price before they
   increased"). Percentages are resolved against the pre-adjustment subtotal,
   the same base quoteLines used, so the figures match to the penny.

   Not hardcoded "Discount": an adjustment can go up as well as down, and
   "Discount (10%)" beside a +$500 figure reads as an error on the whole
   document. */
function adjustmentLines(bd, adjustments) {
  const want = toCents(bd.adjust);
  const named = [];
  (adjustments || []).forEach((a) => {
    if (!a) return;
    const v = Number(a.value);
    if (!isFinite(v) || !v) return;
    if (a.kind === 'percent') {
      named.push({
        label: (a.note || (v < 0 ? 'Discount' : 'Adjustment')) + ' (' + Math.abs(v) + '%)',
        amountCents: toCents(bd.subtotal * (v / 100))
      });
    } else if (a.kind === 'amount') {
      named.push({ label: a.note || (v < 0 ? 'Discount' : 'Adjustment'), amountCents: toCents(v) });
    }
  });

  /* The named lines are for the customer's benefit; the ARITHMETIC comes from
     the breakdown either way. If the two disagree — a caller that did not pass
     the adjustment list, or one that passed a stale copy — the named lines are
     dropped and the figures quoteLines already computed are used instead.
     Without this the shortfall does not surface: reconcile() would quietly
     pile it onto the largest phase line, and the invoice would still add up
     while every phase on it disagreed with the customer's quote. */
  const sum = named.reduce((t, l) => t + l.amountCents, 0);
  if (named.length && sum === want) return named;
  if (!want) return [];
  const out = [];
  const pctCents = toCents(bd.percentAdjust);
  const amtCents = toCents(bd.amountAdjust);
  if (pctCents) out.push({ label: pctCents < 0 ? 'Discount' : 'Adjustment', amountCents: pctCents });
  if (amtCents) out.push({ label: amtCents < 0 ? 'Discount' : 'Adjustment', amountCents: amtCents });
  /* Any penny of difference between the two roundings belongs with the
     adjustment, not smeared onto a phase. */
  const drift = want - out.reduce((t, l) => t + l.amountCents, 0);
  if (drift && out.length) out[out.length - 1].amountCents += drift;
  else if (drift) out.push({ label: 'Adjustment', amountCents: drift });
  return out;
}

/* Phases, adjustments and tax — everything above the line that differs by
   kind. Sums to the job total, which is asserted in the tests rather than
   assumed here. */
function jobLines(bd, adjustments) {
  const lines = bd.rows
    .map((r) => ({ label: r.label, amountCents: toCents(r.amt) }))
    .filter((l) => l.amountCents !== 0);
  adjustmentLines(bd, adjustments).forEach((l) => lines.push({ ...l, fixed: true }));
  const taxCents = toCents(bd.tax);
  if (taxCents) lines.push({ label: 'Sales Tax (' + pct(taxRateOf(bd)) + '%)', amountCents: taxCents, fixed: true });
  return lines;
}

function depositInvoice(bd, adjustments) {
  const lines = jobLines(bd, adjustments);
  const totalCents = toCents(bd.depositTotal);
  const deferred = toCents(bd.total) - totalCents;
  if (deferred > 0) {
    lines.push({
      label: 'Less balance due on completion — ' + pct(1 - depositRateOf(bd)) + '% of each phase',
      amountCents: -deferred,
      residue: true
    });
  }
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
function balanceInvoice(bd, adjustments, payments) {
  const lines = jobLines(bd, adjustments);

  (payments || []).forEach((p) => {
    const c = toCents(p.amount);
    if (!c) return;
    const when = p.paid_at ? ' ' + String(p.paid_at).slice(0, 10) : '';
    const how = p.method ? ' by ' + p.method : '';
    lines.push({ label: 'Payment received' + how + when, amountCents: -Math.abs(c), fixed: true });
  });

  const jobCents = toCents(bd.total);
  const paidCents = (payments || []).reduce((t, p) => t + Math.abs(toCents(p.amount)), 0);
  const totalCents = jobCents - paidCents;
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* WHICH PAYMENTS BELONG TO THIS JOB.
 *
 * payments is keyed to the CUSTOMER, not the job — it predates anyone buying a
 * second shed, and a few customers have. Subtracting every payment a customer
 * ever made from the balance on their second shed would credit them for the
 * first one.
 *
 * So rows now carry submission_id, and they sort into three:
 *
 *   applied    — this job's. These come off the balance.
 *   unassigned — recorded before the column existed, or entered without a job
 *                picked. NOT guessed at in either direction: silently counting
 *                them credits the wrong shed, silently ignoring them bills a
 *                customer for money they already paid. The caller surfaces
 *                them so a person decides.
 *   other      — another job's. Excluded, and counted only so the UI can say
 *                so rather than leaving someone wondering where a payment went.
 */
export function splitPayments(payments, submissionId) {
  const applied = [], unassigned = [], other = [];
  const want = Number(submissionId);
  (payments || []).forEach((p) => {
    const sid = p && p.submission_id;
    if (sid == null || sid === '') unassigned.push(p);
    else if (Number(sid) === want) applied.push(p);
    else other.push(p);
  });
  return { applied, unassigned, other };
}

/* Build one invoice.
 *
 * Returns { kind, lines, totalCents, jobTotalCents, paidCents } — or throws.
 * Throwing rather than returning a zero invoice is deliberate: every caller
 * here is a button someone pressed meaning "bill this person", and silently
 * billing nothing is worse than an error they can read. */
/* WHAT THE CUSTOMER READS AROUND THE NUMBERS.
 *
 * The line items carry the money. Everything else the quote shows — what is
 * actually in the shed, what was thrown in free, how the two payments work —
 * goes in the three places a Stripe invoice has for it: custom fields across
 * the top, the memo under them, and the footer at the bottom.
 *
 * Every one of these is capped. Stripe documents a limit on the custom fields
 * (40 / 140 characters) and does not document one for the memo or the footer,
 * and an undocumented limit is still a limit — exceeding it is a hard
 * rejection, which on this endpoint means the invoice does not go out at all.
 * So they are trimmed to a conservative length here rather than discovered
 * the expensive way. The build detail degrades a piece at a time: the package
 * contents go first, then whole sub-lines, so what survives is always the
 * most useful part rather than an arbitrary cut mid-word.
 */
export const LIMITS = { memo: 1200, footer: 1000, fieldName: 40, fieldValue: 140, label: 250 };

function clip(s, max) {
  const t = String(s == null ? '' : s);
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

/* Exported because index.js needs the same formatter for its warnings, and the
   bundler inlines every module at TOP LEVEL — a second `function usd` there is
   a SyntaxError that stops the whole worker, not just this feature. */
export function usd(n) {
  return Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/* The build, itemised the way the quote itemises it: each phase, then the
   parts that make it up, then what a package contains. Rendered at three
   levels of detail and the longest one that fits is used. */
export function buildMemo(bd, opts = {}) {
  const head = [];
  if (opts.summary) head.push(opts.summary);
  if (opts.submissionId) head.push('Order #' + opts.submissionId);
  const heading = head.join(' \u00b7 ');

  function render(withIncludes, withSubLines) {
    const out = [];
    if (heading) out.push(heading, '');
    bd.rows.forEach((r) => {
      out.push(r.label + ' \u2014 ' + usd(r.amt));
      if (!withSubLines) return;
      (r.subLines || []).forEach((s) => {
        out.push('   + ' + s.label + ' \u2014 ' + usd(s.amt));
        if (!withIncludes) return;
        (s.includes || []).forEach((item) => out.push('       \u2014 ' + item));
      });
    });
    return out.join('\n').trim();
  }

  for (const [inc, sub] of [[true, true], [false, true], [false, false]]) {
    const text = render(inc, sub);
    if (text.length <= LIMITS.memo) return text;
  }
  return clip(render(false, false), LIMITS.memo);
}

/* Comped items, what they saved, and how the two payments work. The comped
   block is the reason this is not just a discount line: "Shutters — Included"
   is something you gave them, where "Discount -$60" reads as the price having
   been soft in the first place. */
export function buildFooter(bd, comped, kind) {
  const parts = [];
  const names = Object.keys(comped || {});
  if (names.length) parts.push('Included at no charge: ' + names.join(', ') + '.');
  if (bd.savings > 0.005) parts.push('You save ' + usd(bd.savings) + ' on this build.');
  parts.push(kind === 'deposit'
    ? 'This invoice collects the deposit. The balance is invoiced on completion.'
    : 'This invoice settles the balance. Payments already received are credited above.');
  parts.push('All amounts include Utah sales tax.');
  return clip(parts.join(' '), LIMITS.footer);
}

/* Four fields, across the top of the invoice, answering the questions a
   customer asks before reading any further: what is this for, which shed,
   and how much is the whole job. */
export function buildCustomFields(bd, kind, opts = {}) {
  const fields = [
    ['Order', opts.submissionId ? '#' + opts.submissionId : null],
    ['Build', opts.summary || null],
    ['Payment', kind === 'deposit' ? 'Deposit' : 'Balance on completion'],
    ['Job total', usd(bd.total)]
  ];
  return fields
    .filter(([, v]) => v)
    .map(([name, value]) => ({ name: clip(name, LIMITS.fieldName), value: clip(value, LIMITS.fieldValue) }))
    .slice(0, 4);
}

export function buildInvoice(breakdown, kind, payments, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown invoice kind: ${kind}`);
  if (!breakdown || !Array.isArray(breakdown.rows) || !breakdown.rows.length) {
    throw new Error('this submission has no priced phases to invoice');
  }
  const paid = payments || [];
  const adjustments = opts.adjustments || [];
  const out = kind === 'deposit'
    ? depositInvoice(breakdown, adjustments)
    : balanceInvoice(breakdown, adjustments, paid);

  if (out.totalCents <= 0) {
    throw new Error(kind === 'balance'
      ? 'nothing left to invoice — payments already cover this job'
      : 'the deposit for this job works out to nothing');
  }
  return {
    kind,
    lines: out.lines.map((l) => ({ ...l, label: clip(l.label, LIMITS.label) })),
    totalCents: out.totalCents,
    jobTotalCents: toCents(breakdown.total),
    paidCents: paid.reduce((t, p) => t + Math.abs(toCents(p.amount)), 0),
    memo: buildMemo(breakdown, opts),
    footer: buildFooter(breakdown, opts.comped, kind),
    customFields: buildCustomFields(breakdown, kind, opts)
  };
}
