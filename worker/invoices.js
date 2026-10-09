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
/* What a phase is made of, named on the phase's own line.
 *
 * This used to live only in the memo — until the memo turned out to be capped
 * at 500 characters, which a real shed's itemisation does not fit inside. So
 * the names move to the line items, where there is a separate budget per line
 * and, better, where they sit beside the money they explain. No prices: the
 * sub-items add up to the phase total on the same line, and printing both
 * invites a customer to check one against the other. */
function phaseLabel(row) {
  const parts = (row.subLines || []).map((s) => s.label).filter(Boolean);
  if (!parts.length) return row.label;
  /* Not clipped here. buildInvoice clips every line label on the way out, and
     a second cap at this spot is a line that looks load-bearing but cannot be
     made to fail — removing it changed no test, which is the tell. */
  return row.label + ': ' + parts.join(', ');
}

function jobLines(bd, adjustments) {
  const lines = bd.rows
    .map((r) => ({ label: phaseLabel(r), amountCents: toCents(r.amt) }))
    .filter((l) => l.amountCents !== 0);
  adjustmentLines(bd, adjustments).forEach((l) => lines.push({ ...l, fixed: true }));
  const taxCents = toCents(bd.tax);
  if (taxCents) lines.push({ label: 'Sales Tax (' + pct(taxRateOf(bd)) + '%)', amountCents: taxCents, fixed: true });
  return lines;
}

/* The deposit, less anything this job has already been paid.
 *
 * Money taken outside Stripe — a cashier's check, cash, a deposit collected on
 * Invoice2go before Stripe — is still money the customer has handed over. A
 * deposit invoice that ignored it asked them for the full 30% a second time.
 * So the same credits the balance invoice shows appear here too, one line per
 * payment, and the figure asked for is what is still owed of the deposit. */
function depositInvoice(bd, adjustments, payments) {
  const lines = jobLines(bd, adjustments);
  const depositCents = toCents(bd.depositTotal);
  const deferred = toCents(bd.total) - depositCents;
  if (deferred > 0) {
    lines.push({
      label: 'Less balance due on completion — ' + pct(1 - depositRateOf(bd)) + '% of each phase',
      amountCents: -deferred,
      residue: true
    });
  }
  creditLines(payments).forEach((l) => lines.push(l));
  const totalCents = depositCents - paidCentsOf(payments);
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* One credit line per payment received, exactly as the money arrived. Fixed:
   reconcile() never nudges a payment by a penny. */
function creditLines(payments) {
  const out = [];
  (payments || []).forEach((p) => {
    const c = toCents(p.amount);
    if (!c) return;
    const when = p.paid_at ? ' ' + String(p.paid_at).slice(0, 10) : '';
    const how = p.method ? ' by ' + methodLabel(p.method) : '';
    out.push({ label: 'Payment received' + how + when, amountCents: -Math.abs(c), fixed: true });
  });
  return out;
}

/* Payments are stored in DOLLARS (REAL) — manual ones as typed, Stripe ones as
   amount_paid / 100. Every sum is done in integer cents so that 0.1 + 0.2 never
   leaves a balance of $0.00000000004 that refuses to read as "paid". */
function paidCentsOf(payments) {
  return (payments || []).reduce((t, p) => t + Math.abs(toCents(p.amount)), 0);
}

const METHOD_LABELS = { cash: 'cash', check: 'check', cashiers_check: "cashier's check",
  venmo: 'Venmo', zelle: 'Zelle', invoice2go: 'Invoice2go', card: 'card', stripe: 'Stripe', other: 'other' };
function methodLabel(m) { return METHOD_LABELS[m] || m; }

/* WHERE A JOB STANDS: total, what has come in, what is left.
 *
 * The one figure the CRM puts beside the Stripe button, so it has to be the
 * same arithmetic the invoice uses — it is built from the same quoteLines()
 * breakdown and the same applied payments, in cents.
 *
 *   balanceCents   — never below zero. Overpayment is reported separately
 *                    rather than shown as a negative "balance due".
 *   depositDueCents — the 30% deposit less everything paid so far, never below
 *                    zero. A check that covered the deposit makes this 0.
 */
export function balanceSummary(breakdown, payments) {
  const jobTotalCents = toCents(breakdown && breakdown.total);
  const depositTotalCents = toCents(breakdown && breakdown.depositTotal);
  const paidCents = paidCentsOf(payments);
  const owed = jobTotalCents - paidCents;
  return {
    jobTotalCents,
    depositTotalCents,
    paidCents,
    balanceCents: Math.max(0, owed),
    overpaidCents: Math.max(0, -owed),
    depositDueCents: Math.max(0, depositTotalCents - paidCents),
    paidInFull: jobTotalCents > 0 && owed <= 0
  };
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
  creditLines(payments).forEach((l) => lines.push(l));

  const jobCents = toCents(bd.total);
  const totalCents = jobCents - paidCentsOf(payments);
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
/* MEASURED, NOT GUESSED.
 *
 * Stripe documents the custom-field limits (40 / 140) and not the others, so
 * the memo was capped at a "conservative" 1200. It is 500 — learned when a
 * real invoice came back "Invalid string: ...; must be at most 500
 * characters" and did not send. A conservative guess at an undocumented limit
 * is still a guess; these are the numbers Stripe has actually enforced, and
 * the rest sit under the same 500 because nothing here needs more. */
export const LIMITS = { memo: 500, footer: 500, fieldName: 40, fieldValue: 140, label: 250 };

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
export function buildFooter(bd, comped, kind, opts = {}) {
  const parts = [];
  const names = Object.keys(comped || {});
  if (names.length) parts.push('Included at no charge: ' + names.join(', ') + '.');
  if (bd.savings > 0.005) parts.push('You save ' + usd(bd.savings) + ' on this build.');
  parts.push(kind === 'deposit'
    ? 'This invoice collects the deposit' + (opts.credited ? ', less payments already received (credited above)' : '') +
      '. The balance is invoiced on completion.'
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

/* A SHORT, STABLE FINGERPRINT OF WHAT IS ABOUT TO BE SENT.
 *
 * Stripe remembers an idempotency key for 24 hours and refuses to reuse one
 * with different parameters. The key used to be built from the shed, the kind
 * and how many invoices had been raised — nothing about the CONTENT. So an
 * attempt that failed, followed by anything that changed the request, came
 * back "Keys for idempotent requests can only be used with the same
 * parameters they were first used with" and stayed stuck for a day. Which is
 * exactly what happened after the memo was shortened to fit Stripe's limit.
 *
 * Folding the content in makes the key identify THIS request: a double-tapped
 * button still sends one invoice, because nothing about it changed, while a
 * corrected one gets a fresh key immediately.
 *
 * Not a security hash — it is a cache key, and a collision would only
 * deduplicate two invoices that were identical anyway. */
export function fingerprint(parts) {
  const s = JSON.stringify(parts === undefined ? null : parts);
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b + c, 2246822519) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
  }
  return (a.toString(36) + b.toString(36)).slice(0, 12);
}

export function buildInvoice(breakdown, kind, payments, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown invoice kind: ${kind}`);
  if (!breakdown || !Array.isArray(breakdown.rows) || !breakdown.rows.length) {
    throw new Error('this submission has no priced phases to invoice');
  }
  const paid = payments || [];
  const adjustments = opts.adjustments || [];
  const out = kind === 'deposit'
    ? depositInvoice(breakdown, adjustments, paid)
    : balanceInvoice(breakdown, adjustments, paid);

  if (out.totalCents <= 0) {
    const e = new Error(kind === 'balance'
      ? 'Paid in full — payments already cover this job, so there is nothing to bill'
      : (paid.length
        ? 'The deposit is already covered by payments received — bill the balance instead'
        : 'the deposit for this job works out to nothing'));
    e.code = kind === 'balance' ? 'paid_in_full' : (paid.length ? 'deposit_covered' : 'nothing_to_bill');
    throw e;
  }
  return {
    kind,
    lines: out.lines.map((l) => ({ ...l, label: clip(l.label, LIMITS.label) })),
    totalCents: out.totalCents,
    jobTotalCents: toCents(breakdown.total),
    paidCents: paidCentsOf(paid),
    memo: buildMemo(breakdown, opts),
    footer: buildFooter(breakdown, opts.comped, kind, { credited: paid.length > 0 }),
    customFields: buildCustomFields(breakdown, kind, opts)
  };
}

/* ---------------------------------------------------------------------------
 * BILLING BY PHASE.
 *
 * The quote already splits every job into phases (quoteLines rows: Phase 1 —
 * Concrete Pad, Phase 2 — Shed, Phase 3 — Interior, with site clearance first
 * when there is any) and prints a 30% deposit per phase. Billing by phase uses
 * exactly those figures — nothing here invents a percentage:
 *
 *   each phase = its 30% DEPOSIT (collected before the phase starts)
 *              + its REMAINDER   (the other 70%, due once the phase is done)
 *
 * and the schedule is: Phase 1 deposit; then Phase 2 deposit + what is left of
 * Phase 1; then Phase 3 deposit + what is left of Phase 2; then what is left of
 * the last phase on completion. The CRM suggests that and lets a person tick
 * any other combination.
 * ------------------------------------------------------------------------- */

export const PHASE_PARTS = ['deposit', 'remainder'];

/* "Phase 2 — Shed (A-Frame)" -> "Shed (A-Frame)". */
function phaseName(row) {
  return String(row.label || '').replace(/^Phase\s+\d+\s+—\s+/, '');
}

/* Every phase in integer cents. Deposit and remainder are reconciled so the
   phases add up to the job total to the penny; any rounding cent lands on the
   LAST phase's remainder, the final amount billed. */
export function phaseParts(bd) {
  if (!bd || !Array.isArray(bd.rows)) return [];
  const out = bd.rows.map((r, i) => {
    const totalCents = toCents(r.total);
    const depositCents = toCents(r.deposit);
    return { phase: r.phase || i + 1, name: phaseName(r), totalCents, depositCents,
             remainderCents: totalCents - depositCents };
  });
  const drift = toCents(bd.total) - out.reduce((t, p) => t + p.totalCents, 0);
  if (drift && out.length) {
    const last = out[out.length - 1];
    last.totalCents += drift; last.remainderCents += drift;
  }
  return out;
}

/* What a payment says it was for. Stored as JSON in payments.phase_alloc:
     {"phase": 2}                                        typed by a person
     {"parts": [{"phase":1,"part":"remainder","cents":225225}, ...]}
                                                         written when a phase
                                                         invoice is paid
   Anything else (including null — every payment before this existed) is
   untagged. */
export function parseAlloc(v) {
  if (!v) return null;
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { return null; } }
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o.parts)) {
    const parts = o.parts.filter((p) => p && Number(p.phase) > 0 && PHASE_PARTS.includes(p.part))
      .map((p) => ({ phase: Number(p.phase), part: p.part, cents: Math.max(0, Math.round(Number(p.cents) || 0)) }));
    return parts.length ? { parts } : null;
  }
  if (Number(o.phase) > 0) return { phase: Number(o.phase) };
  return null;
}

/* WHICH PART OF WHICH PHASE EACH PAYMENT PAID.
 *
 *  1. Payments from a phase invoice go to the parts that invoice billed.
 *  2. Payments a person tagged with a phase go to that phase: deposit first,
 *     then its remainder.
 *  3. Everything else — untagged payments and anything left over from 1 or 2 —
 *     fills DEPOSITS first, in phase order, then remainders in phase order.
 *     That is what an untagged payment has always meant here: before phases,
 *     "the deposit" was all the phase deposits together, so a paid old-style
 *     deposit invoice lands on exactly the deposits it covered.
 *
 * Nothing is ever allocated past what a part costs; money beyond the whole job
 * is reported as overpaid, never as a negative balance. */
export function allocatePhases(phases, payments) {
  const key = (ph, part) => ph + ':' + part;
  const cost = {}, paid = {};
  phases.forEach((p) => {
    cost[key(p.phase, 'deposit')] = p.depositCents;
    cost[key(p.phase, 'remainder')] = p.remainderCents;
    paid[key(p.phase, 'deposit')] = 0;
    paid[key(p.phase, 'remainder')] = 0;
  });
  const room = (k) => (cost[k] == null ? 0 : Math.max(0, cost[k] - paid[k]));
  const byPayment = (payments || []).map((p) => ({ payment: p, parts: [] }));
  function put(entry, phase, part, cents) {
    const k = key(phase, part);
    const take = Math.min(cents, room(k));
    if (take <= 0) return cents;
    paid[k] += take;
    const same = entry.parts.find((x) => x.phase === phase && x.part === part);
    if (same) same.cents += take; else entry.parts.push({ phase, part, cents: take });
    return cents - take;
  }
  const leftover = byPayment.map((e) => Math.abs(toCents(e.payment.amount)));

  byPayment.forEach((e, i) => {                              // 1. from a phase invoice
    const a = parseAlloc(e.payment.phase_alloc);
    if (!a || !a.parts) return;
    a.parts.forEach((x) => {
      const want = Math.min(x.cents, leftover[i]);
      leftover[i] -= want - put(e, x.phase, x.part, want);
    });
  });
  byPayment.forEach((e, i) => {                              // 2. tagged by a person
    const a = parseAlloc(e.payment.phase_alloc);
    if (!a || !a.phase) return;
    leftover[i] = put(e, a.phase, 'deposit', leftover[i]);
    leftover[i] = put(e, a.phase, 'remainder', leftover[i]);
  });
  const order = phases.map((p) => [p.phase, 'deposit']).concat(phases.map((p) => [p.phase, 'remainder']));
  byPayment.forEach((e, i) => {                              // 3. everything else
    order.forEach(([ph, part]) => { if (leftover[i] > 0) leftover[i] = put(e, ph, part, leftover[i]); });
  });
  return { paid, byPayment, overpaidCents: leftover.reduce((t, c) => t + c, 0) };
}

/* Where each phase stands, and what the CRM should suggest billing next.
 * openParts: parts already on a sent, unpaid phase invoice — not suggested
 * again, so a second invoice cannot ask for the same money. */
export function phaseStatus(bd, payments, openParts) {
  const phases = phaseParts(bd);
  const { paid, byPayment, overpaidCents } = allocatePhases(phases, payments);
  const open = {};
  (openParts || []).forEach((o) => { open[o.phase + ':' + o.part] = o.invoice_id || true; });
  const rows = phases.map((p) => {
    const part = (name, cents) => {
      const k = p.phase + ':' + name;
      return { amountCents: cents, paidCents: paid[k] || 0,
               remainingCents: Math.max(0, cents - (paid[k] || 0)), openInvoice: open[k] || null };
    };
    return { phase: p.phase, name: p.name, totalCents: p.totalCents,
             deposit: part('deposit', p.depositCents), remainder: part('remainder', p.remainderCents) };
  });

  /* The suggestion: the first phase whose deposit is still owed, plus every
     earlier phase's unpaid remainder (those phases have started, so the work
     is done or under way). If every deposit is in, the earliest unpaid
     remainder — on the last phase that is the bill on completion. */
  const free = (x) => x.remainingCents > 0 && !x.openInvoice;
  const suggested = [];
  const next = rows.find((r) => free(r.deposit));
  if (next) {
    suggested.push({ phase: next.phase, part: 'deposit' });
    /* Only phases whose deposit is in — a phase that never started has no
       "rest" to collect yet. */
    rows.filter((r) => r.phase < next.phase && free(r.remainder) && r.deposit.remainingCents === 0)
      .forEach((r) => suggested.push({ phase: r.phase, part: 'remainder' }));
  } else {
    const rem = rows.find((r) => free(r.remainder));
    if (rem) suggested.push({ phase: rem.phase, part: 'remainder' });
  }
  return { phases: rows, byPayment, overpaidCents, suggested };
}

const SHORT_DATE = (v) => {
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
};
const METHOD_TITLE = { cash: 'Cash', check: 'Check', cashiers_check: "Cashier's check", venmo: 'Venmo',
  zelle: 'Zelle', invoice2go: 'Invoice2go', card: 'Card', stripe: 'Stripe', other: 'Other' };

/* ONE STRIPE INVOICE FOR THE PARTS SOMEONE TICKED.
 *
 * Written for the customer, who has to understand it without a call:
 *
 *   Phase 2: Shed deposit (30%)                                   $5,511.60
 *   Remainder of Phase 1: Concrete Pad (4" slab), due after
 *     completion — phase total                                    $3,217.50
 *   Deposit already paid (Invoice2go, 9/1/2026)                    -$965.25
 *
 * A remainder is shown as the PHASE TOTAL less what was already paid toward
 * that phase, one credit per payment, so the customer sees the 30% they paid
 * coming off rather than a bare "70%" they have to take on trust. A deposit is
 * shown as the deposit less anything already paid toward it.
 *
 * All amounts are tax-inclusive, exactly as the quote's per-phase figures are;
 * Stripe must not add tax (same rule as the deposit/balance invoices).
 *
 * `covers` is what each billed line pays for, net — written onto the stored
 * lines so that when Stripe says this invoice is paid, the payment is booked
 * against these exact parts and nothing is billed twice. */
export function buildPhaseInvoice(bd, payments, selected, opts = {}) {
  if (!bd || !Array.isArray(bd.rows) || !bd.rows.length) throw new Error('this submission has no priced phases to invoice');
  const st = phaseStatus(bd, payments, opts.openParts);
  const want = {};
  (selected || []).forEach((s) => {
    if (!s || !PHASE_PARTS.includes(s.part)) return;
    want[Number(s.phase) + ':' + s.part] = true;
  });
  const lines = [], covers = [];
  (selected || []).forEach((s) => {
    if (s && !st.phases.some((p) => p.phase === Number(s.phase))) {
      throw Object.assign(new Error('this build has no phase ' + s.phase), { code: 'bad_phase' });
    }
  });
  const picked = st.phases.filter((p) => want[p.phase + ':deposit'] || want[p.phase + ':remainder']);
  if (!picked.length) throw Object.assign(new Error('pick at least one phase to bill'), { code: 'nothing_selected' });

  function credits(phase, parts, labelFor) {
    st.byPayment.forEach((e) => {
      const c = e.parts.filter((x) => x.phase === phase && parts.includes(x.part)).reduce((t, x) => t + x.cents, 0);
      if (!c) return;
      const p = e.payment;
      const how = [METHOD_TITLE[p.method] || p.method, SHORT_DATE(p.paid_at)].filter(Boolean).join(', ');
      const onlyDeposit = e.parts.filter((x) => x.phase === phase && parts.includes(x.part)).every((x) => x.part === 'deposit');
      lines.push({ label: labelFor(onlyDeposit) + (how ? ' (' + how + ')' : ''), amountCents: -c, fixed: true });
    });
  }

  /* Deposits first — that is the phase about to start — then the rest of the
     phases already under way, in phase order. */
  const depositOnly = picked.filter((p) => want[p.phase + ':deposit'] && !want[p.phase + ':remainder']);
  const withRest = picked.filter((p) => want[p.phase + ':remainder']);
  depositOnly.forEach((p) => {
    if (p.deposit.openInvoice) throw Object.assign(new Error('Phase ' + p.phase + ' deposit is already on a sent invoice — void it first'), { code: 'already_billed' });
    if (!p.deposit.remainingCents) throw Object.assign(new Error('Phase ' + p.phase + ' deposit is already paid'), { code: 'already_paid' });
    lines.push({ label: 'Phase ' + p.phase + ': ' + p.name + ' deposit (30%)', amountCents: p.deposit.amountCents });
    credits(p.phase, ['deposit'], () => 'Deposit already paid');
    covers.push({ phase: p.phase, part: 'deposit', cents: p.deposit.remainingCents });
  });
  withRest.forEach((p) => {
    const both = want[p.phase + ':deposit'];
    if (p.remainder.openInvoice || (both && p.deposit.openInvoice)) {
      throw Object.assign(new Error('Phase ' + p.phase + ' is already on a sent invoice — void it first'), { code: 'already_billed' });
    }
    const owed = p.remainder.remainingCents + (both ? p.deposit.remainingCents : 0);
    if (!owed) throw Object.assign(new Error('Phase ' + p.phase + ' is already paid'), { code: 'already_paid' });
    /* Deposit paid in full: show the PHASE TOTAL and take each deposit payment
       off it, so the rest reads as "total minus what you paid". Deposit not
       (fully) paid and not ticked: bill only the 70% — the deposit stays owed
       on its own line, on its own invoice. */
    const showTotal = both || p.deposit.remainingCents === 0;
    const lbl = both
      ? 'Phase ' + p.phase + ': ' + p.name + ' — whole phase (deposit + rest, due after completion)'
      : 'Remainder of Phase ' + p.phase + ': ' + p.name + ', due after completion' +
        (showTotal ? ' — phase total' : ' — 70% of ' + usd(fromCents(p.totalCents)));
    lines.push({ label: lbl, amountCents: showTotal ? p.totalCents : p.remainder.amountCents });
    if (showTotal) credits(p.phase, ['deposit'], () => 'Deposit already paid');
    credits(p.phase, ['remainder'], () => 'Already paid toward Phase ' + p.phase);
    if (both && p.deposit.remainingCents) covers.push({ phase: p.phase, part: 'deposit', cents: p.deposit.remainingCents });
    if (p.remainder.remainingCents) covers.push({ phase: p.phase, part: 'remainder', cents: p.remainder.remainingCents });
  });


  const totalCents = covers.reduce((t, c) => t + c.cents, 0);
  const sum = lines.reduce((t, l) => t + l.amountCents, 0);
  if (sum !== totalCents) throw new Error('phase invoice lines (' + sum + ') do not add up to ' + totalCents);
  if (totalCents <= 0) throw Object.assign(new Error('nothing left to bill on those phases'), { code: 'already_paid' });

  const what = describeSelection(covers);
  return {
    kind: 'phase',
    lines: lines.map((l) => ({ ...l, label: clip(l.label, LIMITS.label) })),
    totalCents,
    jobTotalCents: toCents(bd.total),
    paidCents: (payments || []).reduce((t, p) => t + Math.abs(toCents(p.amount)), 0),
    covers,
    description: what,
    memo: phaseMemo(st.phases, what, opts),
    footer: clip('All amounts include Utah sales tax (7.25%). Payments already received are credited above.' +
      (opts.comped && Object.keys(opts.comped).length ? ' Included at no charge: ' + Object.keys(opts.comped).join(', ') + '.' : ''),
      LIMITS.footer),
    customFields: [
      ['Order', opts.submissionId ? '#' + opts.submissionId : null],
      ['Build', opts.summary || null],
      ['This invoice', what],
      ['Job total', usd(bd.total)]
    ].filter(([, v]) => v).map(([name, value]) => ({ name: clip(name, LIMITS.fieldName), value: clip(value, LIMITS.fieldValue) }))
  };
}

/* "Phase 2 deposit + rest of Phase 1" */
export function describeSelection(covers) {
  const deps = [], rests = [];
  const seen = {};
  (covers || []).forEach((c) => {
    if (c.part === 'deposit') deps.push(c.phase);
  });
  (covers || []).forEach((c) => {
    if (c.part === 'remainder' && !seen[c.phase]) { seen[c.phase] = 1; rests.push(c.phase); }
  });
  const bits = [];
  deps.filter((p) => rests.indexOf(p) === -1).forEach((p) => bits.push('Phase ' + p + ' deposit'));
  rests.forEach((p) => bits.push((deps.indexOf(p) > -1 ? 'all of Phase ' : 'rest of Phase ') + p));
  return bits.join(' + ');
}

/* The plain-words explanation, on every phase invoice. Under Stripe's 500. */
export function phaseMemo(phases, what, opts = {}) {
  const head = [opts.summary, opts.submissionId ? 'Order #' + opts.submissionId : null].filter(Boolean).join(' \u00b7 ');
  const list = phases.map((p) => 'Phase ' + p.phase + ': ' + p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()).join(', ');
  const text = [head,
    'How payment works: your build is done in phases (' + list + '). ' +
    'Before each phase starts we collect a 30% deposit on that phase. ' +
    'The rest of a phase is due once that phase is complete, and is added to the next invoice. ' +
    'Anything you have already paid is credited.',
    what ? 'This invoice: ' + what + '.' : ''].filter(Boolean).join('\n\n');
  return clip(text, LIMITS.memo);
}
