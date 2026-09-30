/* WHAT THE CUSTOMER GETS CHARGED.
 *
 * Runs against real redlines through the real quoteLines, so these are the
 * figures an actual shed would be billed — not a fixture someone typed.
 *
 * Run: node --test worker/invoices.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { buildInvoice, splitPayments, toCents, buildMemo, buildFooter,
         buildCustomFields, LIMITS } from './invoices.js';

const BUILDS = {
  'plain 10x16': { style: 'gable', w: 10, l: 16, h: 9 },
  'pad + interior + electrical': { style: 'gable', w: 10, l: 16, h: 9,
    foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted', elec: 'essential' },
  'removals and a porch': { style: 'gable', w: 12, l: 20, h: 9,
    porchLoc: 'front', porchDepth: 6, porchDeck: 'composite',
    addons: { shedRemoval: true, concreteRemoval: true } },
  'barn, everything on': {
    style: 'barn', w: 12, l: 20, h: 10, siding: 'board-batten', foundation: 'pad',
    foundationFinish: 'coated', intFinish: 'painted', floor: 'better', elec: 'essential',
    loft: '6-front', porchFront: 4,
    doors: [{ wall: 'front', pos: 0.5, w: 36, h: 80, style: 'fairytale', color: 'white' }],
    windows: [{ wall: 'left', pos: 0.3, w: 24, h: 36, cy: 52, type: 'White Vinyl 24x36' }],
    addons: { shutters: true, shedRemoval: true, skylight: true },
  },
};

const ADJUSTMENTS = [
  ['no adjustment', []],
  ['10% off', [{ kind: 'percent', value: -10 }]],
  ['$750 off', [{ kind: 'amount', value: -750 }]],
  ['percent and amount', [{ kind: 'percent', value: -7.5 }, { kind: 'amount', value: -250 }]],
];

function cases() {
  const out = [];
  for (const [b, config] of Object.entries(BUILDS)) {
    const { redline } = computePricing(config);
    for (const [a, adj] of ADJUSTMENTS) out.push([`${b} / ${a}`, quoteLines(redline, adj), adj]);
  }
  return out;
}

/* THE ONE THAT MATTERS MOST. A document about money whose own lines do not add
   up to its own total is the kind of error a customer finds, not a test. */
test('every line sums to exactly the invoice total, to the penny', () => {
  for (const [label, bd] of cases()) {
    for (const kind of ['deposit', 'balance']) {
      const inv = buildInvoice(bd, kind, kind === 'balance' ? [{ amount: 1500, method: 'check' }] : []);
      const sum = inv.lines.reduce((t, l) => t + l.amountCents, 0);
      assert.equal(sum, inv.totalCents, `${label} / ${kind}: lines sum to ${sum}, total says ${inv.totalCents}`);
    }
  }
});

test('the deposit is 30% of the job, tax included', () => {
  for (const [label, bd] of cases()) {
    const inv = buildInvoice(bd, 'deposit', []);
    assert.equal(inv.totalCents, toCents(bd.depositTotal), `${label}: deposit total`);
    /* Within a penny of 30% of the tax-inclusive job: the deposit is summed
       per phase, so it can round a cent away from a flat 30% of the whole. */
    assert.ok(Math.abs(inv.totalCents - Math.round(inv.jobTotalCents * 0.30)) <= 2,
      `${label}: ${inv.totalCents} is not ~30% of ${inv.jobTotalCents}`);
  }
});

/* THE WHOLE QUOTE ON THE FACE OF THE INVOICE.
 *
 * The customer read a quote with phases, then adjustments, then tax. If the
 * invoice restates the same job in a different shape they have to check one
 * document against the other, and the document asking for money is the worst
 * possible place to make them do that. So the lines are the quote's lines, in
 * the quote's order, and only the last line differs by kind. */
test('the deposit invoice shows the whole quote, then defers the rest', () => {
  for (const [label, bd, adj] of cases()) {
    const inv = buildInvoice(bd, 'deposit', [], { adjustments: adj });
    const phases = bd.rows.filter((r) => toCents(r.amt) !== 0);

    phases.forEach((r, i) => {
      /* startsWith, not equals: the phase line now names what is in the
         phase after a colon, because the memo cannot carry it at 500
         characters. The phase's own name still has to lead. */
      assert.ok(inv.lines[i].label.startsWith(r.label),
        `${label}: "${inv.lines[i].label}" should lead with "${r.label}"`);
      assert.equal(inv.lines[i].amountCents, toCents(r.amt),
        `${label}: "${r.label}" should be the quote's pre-tax figure`);
    });

    const tax = inv.lines.filter((l) => /Sales Tax/.test(l.label));
    assert.equal(tax.length, 1, `${label}: one tax line`);
    assert.equal(tax[0].amountCents, toCents(bd.tax), `${label}: tax must match the quote exactly`);
    assert.match(tax[0].label, /Sales Tax \(7\.25%\)/);

    const adjLines = inv.lines.filter((l) => /Discount|Adjustment/.test(l.label));
    assert.equal(adjLines.reduce((t, l) => t + l.amountCents, 0), toCents(bd.adjust),
      `${label}: the adjustment lines must come to what the quote took off`);

    const last = inv.lines[inv.lines.length - 1];
    assert.match(last.label, /Less balance due on completion/, `${label}: last line`);
    assert.ok(last.amountCents < 0, `${label}: the deferral is a credit`);

    /* Everything above the deferral is the job in full — which is what makes
       the subtraction check out in front of the customer. */
    const job = inv.lines.slice(0, -1).reduce((t, l) => t + l.amountCents, 0);
    assert.ok(Math.abs(job - toCents(bd.total)) <= 2,
      `${label}: the face of the invoice shows ${job}, the job is ${toCents(bd.total)}`);
    assert.equal(inv.totalCents, toCents(bd.depositTotal), `${label}: deposit total`);
  }
});

/* The named adjustment lines are a courtesy; the arithmetic is not. A caller
   that forgets to pass them must still produce an invoice that agrees with the
   quote — otherwise reconcile() buries the shortfall in a phase line and every
   phase silently disagrees with what the customer was shown. */
test('an invoice built without the adjustment list still matches the quote', () => {
  for (const [label, bd] of cases()) {
    const inv = buildInvoice(bd, 'deposit', []);              // no opts at all
    const phases = bd.rows.filter((r) => toCents(r.amt) !== 0);
    phases.forEach((r, i) => {
      assert.equal(inv.lines[i].amountCents, toCents(r.amt), `${label}: "${r.label}" drifted`);
    });
    const adjLines = inv.lines.filter((l) => /Discount|Adjustment/.test(l.label));
    assert.equal(adjLines.reduce((t, l) => t + l.amountCents, 0), toCents(bd.adjust), label);
    assert.equal(inv.totalCents, toCents(bd.depositTotal), label);
  }
});

/* And when they ARE passed, the customer's own words come through — "Local
   customer - Honoring price before they increased" explains a $1,089 credit
   in a way "Discount" never will. */
test('an adjustment keeps the note that was written for it', () => {
  const adj = [{ kind: 'amount', value: -1089, note: 'Honoring price before they increased' },
               { kind: 'percent', value: -10, note: 'Repeat customer' }];
  const { redline } = computePricing(BUILDS['plain 10x16']);
  const bd = quoteLines(redline, adj);
  const inv = buildInvoice(bd, 'deposit', [], { adjustments: adj });

  const flat = inv.lines.find((l) => /Honoring price/.test(l.label));
  assert.ok(flat, 'the note is not on the invoice: ' + inv.lines.map((l) => l.label).join(' | '));
  assert.equal(flat.amountCents, -108900);

  const pct = inv.lines.find((l) => /Repeat customer/.test(l.label));
  assert.ok(pct, 'the percentage note is missing');
  assert.match(pct.label, /Repeat customer \(10%\)/);
  assert.equal(pct.amountCents, toCents(bd.subtotal * -0.10));

  /* Both together still come to exactly what the quote took off. */
  assert.equal(flat.amountCents + pct.amountCents, toCents(bd.adjust));
});

/* THE FLAT-70% TRAP. A balance of "the other 70%" is right only when the
   deposit was paid exactly and once. */
test('the balance is the job less what was actually paid, not a flat 70%', () => {
  const [, bd] = cases()[0];
  const job = toCents(bd.total);

  for (const paid of [[], [{ amount: 1000 }], [{ amount: 1000 }, { amount: 2500 }],
                      [{ amount: 3333.33 }]]) {
    const inv = buildInvoice(bd, 'balance', paid);
    const expect = job - paid.reduce((t, p) => t + toCents(p.amount), 0);
    assert.equal(inv.totalCents, expect, `paid ${JSON.stringify(paid)}`);
  }

  /* And it is NOT simply 70% once the payment is anything but the exact deposit. */
  const odd = buildInvoice(bd, 'balance', [{ amount: 1000 }]);
  assert.notEqual(odd.totalCents, Math.round(job * 0.70),
    'a $1000 payment must not produce the same balance as a full deposit');
});

/* Summing to the right total is not enough. If the phase lines carried
   pre-tax amounts, reconcile would quietly pile the whole tax onto the largest
   one — the invoice would still add up, and every phase on it would disagree
   with the customer's quote. Found by deliberately making that change and
   watching this file stay green, so it is checked line by line now. */
test('the balance invoice shows the same quote, then credits what was paid', () => {
  for (const [label, bd, adj] of cases()) {
    const inv = buildInvoice(bd, 'balance', [{ amount: 1500, method: 'check' }], { adjustments: adj });
    const phases = bd.rows.filter((r) => toCents(r.amt) !== 0);
    phases.forEach((r, i) => {
      /* startsWith, not equals: the phase line now names what is in the
         phase after a colon, because the memo cannot carry it at 500
         characters. The phase's own name still has to lead. */
      assert.ok(inv.lines[i].label.startsWith(r.label),
        `${label}: "${inv.lines[i].label}" should lead with "${r.label}"`);
      assert.ok(Math.abs(inv.lines[i].amountCents - toCents(r.amt)) <= 2,
        `${label}: "${r.label}" is ${inv.lines[i].amountCents}, the quote says ${toCents(r.amt)}`);
    });
    const tax = inv.lines.find((l) => /Sales Tax/.test(l.label));
    assert.equal(tax.amountCents, toCents(bd.tax), `${label}: tax`);
    const credit = inv.lines.find((l) => /Payment received/.test(l.label));
    assert.equal(credit.amountCents, -150000, `${label}: the payment credit`);
    assert.equal(inv.totalCents, toCents(bd.total) - 150000, `${label}: balance total`);
    /* Nothing on a balance invoice may be the tax-inclusive phase figure: that
       would double-count the separate tax line. */
    phases.forEach((r, i) => {
      if (Math.abs(toCents(r.total) - toCents(r.amt)) > 5) {
        assert.notEqual(inv.lines[i].amountCents, toCents(r.total),
          `${label}: "${r.label}" is tax-inclusive AND there is a tax line`);
      }
    });
  }
});

test('each payment shows on the invoice as its own credit', () => {
  const [, bd] = cases()[0];
  const inv = buildInvoice(bd, 'balance', [
    { amount: 1500, method: 'check', paid_at: '2026-09-01T10:00:00Z' },
    { amount: 900, method: 'stripe', paid_at: '2026-09-14T10:00:00Z' },
  ]);
  const credits = inv.lines.filter((l) => l.amountCents < 0);
  assert.equal(credits.length, 2, 'two payments, two credit lines');
  assert.match(credits[0].label, /Payment received by check 2026-09-01/);
  assert.match(credits[1].label, /Payment received by stripe 2026-09-14/);
  assert.equal(credits.reduce((t, l) => t + l.amountCents, 0), -240000);
});

/* Rounding never lands on a credit: a penny moved onto "Payment received"
   would misstate what the customer has paid.
 *
 * SYNTHETIC BREAKDOWN, deliberately. Removing the guard and running every real
 * fixture through it changes nothing — across ten thousand payment amounts the
 * credit was the largest line every time and was never once adjusted, because
 * those cases happen to carry no rounding drift at all. A guard whose test
 * cannot fail when the guard is deleted is not a test. So the numbers below
 * are built to produce exactly the collision the guard exists for: a one-cent
 * drift, and a credit larger than any other line. */
test('a penny of drift lands on a phase, never on the payment credit', () => {
  const bd = {
    rows: [{ label: 'Phase 1 — A', amt: 10.004 }, { label: 'Phase 2 — B', amt: 10.004 }],
    subtotal: 20.008, adjust: 0, percentAdjust: 0, amountAdjust: 0,
    adjustedSubtotal: 20.008, tax: 1.45, total: 21.46,
    totalBefore: 21.46, savings: 0, depositTotal: 6.438
  };
  const inv = buildInvoice(bd, 'balance', [{ amount: 20, method: 'check' }]);

  const credit = inv.lines.find((l) => /Payment received/.test(l.label));
  assert.equal(Math.abs(credit.amountCents), 2000, 'the credit must be exactly what was paid');
  const biggest = inv.lines.reduce((a, b) =>
    Math.abs(b.amountCents) > Math.abs(a.amountCents) ? b : a);
  assert.equal(biggest, credit, 'fixture is wrong: the credit should be the largest line');

  assert.equal(inv.lines.reduce((t, l) => t + l.amountCents, 0), inv.totalCents, 'still adds up');
  assert.equal(inv.totalCents, 146);
  /* The penny went to a phase, which is where it is allowed to go. */
  const phases = inv.lines.filter((l) => /^Phase/.test(l.label));
  assert.equal(phases.reduce((t, l) => t + l.amountCents, 0), 2001);
});

test('a rounding penny never lands on a payment credit', () => {
  for (const [label, bd] of cases()) {
    const inv = buildInvoice(bd, 'balance', [{ amount: 1234.567, method: 'check' }]);
    const credit = inv.lines.find((l) => /Payment received/.test(l.label));
    assert.equal(credit.amountCents, -toCents(1234.567), `${label}: the credit was adjusted`);
  }
});

test('it refuses rather than silently billing nothing', () => {
  const [, bd] = cases()[0];
  assert.throws(() => buildInvoice(bd, 'tip'), /unknown invoice kind/);
  assert.throws(() => buildInvoice(null, 'deposit'), /no priced phases/);
  assert.throws(() => buildInvoice({ rows: [] }, 'deposit'), /no priced phases/);
  assert.throws(() => buildInvoice(bd, 'balance', [{ amount: 999999 }]),
    /payments already cover this job/);
});

/* Stripe must not add tax on top: the quote already did. If these amounts ever
   stop being tax-inclusive, this is where it shows. */
test('the amounts handed over are tax-inclusive', () => {
  const [, bd] = cases()[0];
  const inv = buildInvoice(bd, 'balance', []);
  assert.equal(inv.totalCents, toCents(bd.total), 'balance should be the tax-INCLUSIVE job total');
  assert.notEqual(inv.totalCents, toCents(bd.adjustedSubtotal), 'it must not be the pre-tax figure');
  assert.ok(inv.totalCents > toCents(bd.adjustedSubtotal));
});

/* ── WHOSE SHED WAS THAT PAYMENT FOR ─────────────────────────────────────────
 * A few customers have bought a second shed. Crediting the second one with what
 * they paid for the first is the failure this guards.
 */
const ROWS = [
  { id: 1, amount: 3000, submission_id: 11, method: 'check' },   // first shed
  { id: 2, amount: 8000, submission_id: 11, method: 'card' },    // first shed
  { id: 3, amount: 2500, submission_id: 22, method: 'stripe' },  // second shed
  { id: 4, amount: 500,  submission_id: null, method: 'cash' },  // before the column existed
];

test('a payment for the first shed never lands on the second', () => {
  const { applied, unassigned, other } = splitPayments(ROWS, 22);
  assert.deepEqual(applied.map((p) => p.id), [3], 'only this job');
  assert.deepEqual(other.map((p) => p.id), [1, 2], 'the first shed, excluded');
  assert.deepEqual(unassigned.map((p) => p.id), [4], 'and the one nobody placed');
});

test('the balance on the second shed is not reduced by the first', () => {
  const [, bd] = cases()[0];
  const job = toCents(bd.total);
  const { applied } = splitPayments(ROWS, 22);
  const inv = buildInvoice(bd, 'balance', applied);
  assert.equal(inv.totalCents, job - toCents(2500), 'only the $2,500 comes off');
  /* The number it would have been if every payment were subtracted. */
  const wrong = job - toCents(3000 + 8000 + 2500 + 500);
  assert.notEqual(inv.totalCents, wrong, 'it credited the other shed');
});

test('unassigned payments are handed back, not guessed at', () => {
  const { applied, unassigned } = splitPayments(ROWS, 22);
  /* Not silently counted... */
  assert.ok(!applied.some((p) => p.submission_id == null));
  /* ...and not silently dropped either: the caller gets them to put in front
     of a person, because ignoring one bills a customer twice. */
  assert.equal(unassigned.length, 1);
  assert.equal(unassigned[0].amount, 500);
});

test('an empty string is as unassigned as a null', () => {
  const { unassigned } = splitPayments([{ id: 9, amount: 100, submission_id: '' }], 22);
  assert.equal(unassigned.length, 1, 'a blank from a form is not job 0');
});

test('ids compare by value, so a string id from the DB still matches', () => {
  const { applied } = splitPayments([{ id: 9, amount: 100, submission_id: '22' }], 22);
  assert.equal(applied.length, 1);
});


/* ---- what the customer reads around the numbers ------------------------ */

const RICH = computePricing({ style: 'barn', w: 10, l: 16, h: 9, foundation: 'pad',
  foundationFinish: 'coated', intFinish: 'painted', elec: 'essential', floor: 'lvp',
  siding: 'vertical', loft: '6-front',
  doors: [{ wall: 'front', pos: 0.5, w: 36, h: 80, style: 'fairytale', color: 'white' }],
  windows: [{ wall: 'left', pos: 0.3, w: 24, h: 36, cy: 52, type: 'White Vinyl 24x36' }],
  addons: { shutters: true, skylight: true } }).redline;

test('the memo lists the build the way the quote lists it', () => {
  const bd = quoteLines(RICH, []);
  const memo = buildMemo(bd, { summary: '10x16 ft \u00b7 barn \u00b7 vertical', submissionId: 42 });

  assert.match(memo, /10x16 ft \u00b7 barn \u00b7 vertical/);
  assert.match(memo, /Order #42/);
  bd.rows.forEach((r) => assert.ok(memo.includes(r.label), 'missing phase: ' + r.label));

  /* The breakout is the point — "Shed" on its own tells a customer nothing
     about what they are paying for. */
  const subs = bd.rows.reduce((t, r) => t + (r.subLines || []).length, 0);
  assert.ok(subs > 3, 'fixture should have sub-lines to show');
  bd.rows.forEach((r) => (r.subLines || []).forEach((s) => {
    assert.ok(memo.includes(s.label), 'missing item: ' + s.label);
  }));
  assert.ok(memo.length <= LIMITS.memo, 'memo is ' + memo.length + ' chars');
});

/* An undocumented limit is still a limit, and on this endpoint exceeding one
   means the invoice never goes out. The detail has to shed gracefully. */
test('a build too detailed to fit drops detail, never the phases', () => {
  const bd = quoteLines(RICH, []);
  const long = 'X'.repeat(400);
  const fat = { ...bd, rows: bd.rows.map((r) => ({ ...r,
    subLines: (r.subLines || []).map((s) => ({ ...s, label: s.label + ' ' + long,
      includes: [long, long] })) })) };

  const memo = buildMemo(fat, { summary: 'big', submissionId: 1 });
  assert.ok(memo.length <= LIMITS.memo, 'memo is ' + memo.length + ' chars');
  /* Phases survive: they are the part that has to be there. */
  fat.rows.forEach((r) => assert.ok(memo.includes(r.label), 'lost phase: ' + r.label));
});

test('the footer names what was thrown in free', () => {
  const bd = quoteLines(RICH, []);
  const footer = buildFooter(bd, { Shutters: 60, Skylight: 184 }, 'deposit');
  assert.match(footer, /Included at no charge: Shutters, Skylight\./);
  assert.match(footer, /balance is invoiced on completion/);
  assert.match(footer, /include Utah sales tax/i);
  assert.ok(footer.length <= LIMITS.footer);

  const bal = buildFooter(bd, {}, 'balance');
  assert.doesNotMatch(bal, /Included at no charge/, 'nothing comped, nothing to say');
  assert.match(bal, /settles the balance/);
});

test('the footer states the saving when there is one', () => {
  const bd = quoteLines(RICH, [{ kind: 'amount', value: -1500 }]);
  assert.match(buildFooter(bd, {}, 'deposit'), /You save \$1,6\d\d\.\d\d/);
  assert.doesNotMatch(buildFooter(quoteLines(RICH, []), {}, 'deposit'), /You save/);
});

test('the header fields stay inside what Stripe accepts', () => {
  const bd = quoteLines(RICH, []);
  const fields = buildCustomFields(bd, 'deposit',
    { summary: 'x'.repeat(300), submissionId: 42 });
  assert.ok(fields.length <= 4, 'Stripe takes at most four');
  fields.forEach((f) => {
    assert.ok(f.name.length <= LIMITS.fieldName, f.name);
    assert.ok(f.value.length <= LIMITS.fieldValue, f.value.length + ' chars');
    assert.ok(f.name && f.value, 'both are required by Stripe');
  });
  assert.equal(fields.find((f) => f.name === 'Order').value, '#42');
  assert.match(fields.find((f) => f.name === 'Payment').value, /Deposit/);

  /* No order number and no design summary: the empty ones drop out rather
     than going up as blanks, which Stripe rejects. */
  const bare = buildCustomFields(bd, 'balance', {});
  bare.forEach((f) => assert.ok(f.value.length > 0));
});

test('buildInvoice hands all three back, ready to send', () => {
  const bd = quoteLines(RICH, []);
  const inv = buildInvoice(bd, 'deposit', [], { summary: '10x16 ft', submissionId: 7,
    comped: { Shutters: 60 } });
  assert.ok(inv.memo.includes('Order #7'));
  assert.match(inv.footer, /Shutters/);
  assert.ok(inv.customFields.length >= 2);
  inv.lines.forEach((l) => assert.ok(l.label.length <= LIMITS.label, l.label));
});

/* ---- the quote and the invoice must say the same thing ------------------ */

/* THE PROMISE ON EVERY QUOTE.
 *
 * The quote used to tell customers "each item is invoiced separately as its
 * stage of work begins — a 30% deposit is collected per item". The invoicing
 * never did that: it bills every phase at once, before anything starts. Two
 * documents, one of them wrong, and nothing in the code connected them — the
 * wording sat in a template string and the behaviour sat here.
 *
 * Whichever way that is settled, it has to be settled in BOTH places. This
 * fails if the quote starts promising per-stage billing again while the
 * deposit invoice still covers the lot. */
test('the quote describes the deposit the code actually sends', () => {
  const quote = readFileSync(new URL('../quote.html', import.meta.url), 'utf8');
  const note = (/<div class="br-note">([^<]*)<\/div>/.exec(quote) || [])[1] || '';
  assert.ok(note, 'the deposit note has gone missing from the quote');

  assert.doesNotMatch(note, /invoiced separately|per item|as its stage/i,
    'the quote promises per-stage billing that buildInvoice does not do: "' + note + '"');
  assert.match(note, /before work begins/i,
    'the quote should say when the deposit is collected: "' + note + '"');

  /* And the behaviour it now describes: one invoice, covering every phase. */
  const bd = quoteLines(RICH, []);
  assert.ok(bd.rows.length > 1, 'fixture needs several phases to be worth checking');
  const inv = buildInvoice(bd, 'deposit', []);
  assert.equal(inv.totalCents, toCents(bd.depositTotal));
  const everyPhase = bd.rows.reduce((t, r) => t + toCents(r.deposit), 0);
  assert.ok(Math.abs(inv.totalCents - everyPhase) <= 2,
    'the deposit invoice must cover EVERY phase, not just the first: ' +
    inv.totalCents + ' vs ' + everyPhase);
});

/* A gravel pad is its own phase, and the question that prompted all this was
   whether it gets billed on its own. It does not — it rides on the one
   deposit with everything else. */
test('a foundation phase is billed on the same deposit as the shed', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 8, foundation: 'gravel' });
  const bd = quoteLines(redline, []);
  const phases = bd.rows.map((r) => r.label);
  assert.ok(phases.some((l) => /Gravel Pad/i.test(l)), phases.join(' | '));
  assert.ok(phases.some((l) => /Shed/i.test(l)), phases.join(' | '));

  const inv = buildInvoice(bd, 'deposit', []);
  const labels = inv.lines.map((l) => l.label);
  assert.ok(labels.some((l) => /Gravel Pad/i.test(l)), labels.join(' | '));
  assert.ok(labels.some((l) => /Shed/i.test(l)), labels.join(' | '));
  assert.equal(inv.totalCents, toCents(bd.depositTotal),
    'one invoice, both phases');
});

/* ---- the limits Stripe actually enforces -------------------------------- */

/* A REAL INVOICE CAME BACK "must be at most 500 characters" AND DID NOT SEND.
 *
 * Stripe documents the custom-field limits and not the memo's, so the memo was
 * capped at a "conservative" 1200. The real figure is 500. The old cap test
 * passed, because it checked the memo against LIMITS.memo — the same wrong
 * number the code was using. A test that reads its expectation out of the
 * implementation cannot fail.
 *
 * So this checks against the constant Stripe enforced, written here on its
 * own, and against every string that goes over the wire — not just the one
 * that happened to break. */
const STRIPE_MAX_STRING = 500;

function hugeBreakdown() {
  /* A shed with everything on it, then every name lengthened, because the
     invoice that broke was a real build with a full electrical package. */
  const { redline } = computePricing({ style: 'barn', w: 12, l: 20, h: 9,
    foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted',
    elec: 'essential', floor: 'lvp', siding: 'vertical', loft: '6-front',
    doors: [{ wall: 'front', pos: 0.5, w: 72, h: 80, style: 'fairytale', color: 'white' }],
    windows: [{ wall: 'left', pos: 0.3, w: 24, h: 36, cy: 52, type: 'White Vinyl 24x36' }],
    addons: { shutters: true, skylight: true, flowerbox: true } });
  const bd = quoteLines(redline, []);
  return { ...bd, rows: bd.rows.map((r) => ({
    ...r,
    label: r.label + ' ' + 'X'.repeat(300),
    subLines: (r.subLines || []).map((s) => ({
      ...s, label: s.label + ' ' + 'Y'.repeat(200),
      includes: (s.includes || []).map((i) => i + ' ' + 'Z'.repeat(200))
    }))
  })) };
}

test('nothing sent to Stripe can exceed what Stripe accepts', () => {
  for (const bd of [quoteLines(RICH, []), hugeBreakdown()]) {
    for (const kind of ['deposit', 'balance']) {
      const inv = buildInvoice(bd, kind, kind === 'balance' ? [{ amount: 500 }] : [], {
        summary: 'Z'.repeat(400), submissionId: 999999,
        comped: Object.fromEntries(Array.from({ length: 30 },
          (_, i) => ['Comped item number ' + i, 10])),
        adjustments: [{ kind: 'amount', value: -1000, note: 'N'.repeat(400) }]
      });

      assert.ok(inv.memo.length <= STRIPE_MAX_STRING,
        kind + ': memo is ' + inv.memo.length + ' characters');
      assert.ok(inv.footer.length <= STRIPE_MAX_STRING,
        kind + ': footer is ' + inv.footer.length + ' characters');
      inv.lines.forEach((l) => {
        assert.ok(l.label.length <= STRIPE_MAX_STRING,
          kind + ': a line is ' + l.label.length + ' characters: ' + l.label.slice(0, 60));
      });
      inv.customFields.forEach((f) => {
        assert.ok(f.name.length <= 40, 'field name: ' + f.name);
        assert.ok(f.value.length <= 140, 'field value is ' + f.value.length);
      });
    }
  }
});

/* And the caps in the code must not drift back above what Stripe takes. */
test('the declared caps stay inside what Stripe enforces', () => {
  assert.ok(LIMITS.memo <= STRIPE_MAX_STRING, 'memo cap is ' + LIMITS.memo);
  assert.ok(LIMITS.footer <= STRIPE_MAX_STRING, 'footer cap is ' + LIMITS.footer);
  assert.ok(LIMITS.label <= STRIPE_MAX_STRING, 'line cap is ' + LIMITS.label);
  assert.equal(LIMITS.fieldName, 40, 'Stripe documents this one');
  assert.equal(LIMITS.fieldValue, 140, 'and this one');
});

/* The detail has to survive the move, or the 500-character cap just deleted
   the thing the customer wanted to read. */
test('a phase still says what is in it, beside its price', () => {
  const bd = quoteLines(RICH, []);
  const inv = buildInvoice(bd, 'deposit', []);
  const shed = inv.lines.find((l) => /Shed/.test(l.label));
  assert.ok(shed, inv.lines.map((l) => l.label).join(' | '));
  assert.match(shed.label, /Base Shed/, 'the phase line should list its contents: ' + shed.label);
  /* Names, not prices — the sub-items add up to the figure on the same line,
     and printing both invites a check that will not balance to the penny. */
  assert.doesNotMatch(shed.label, /\$/, shed.label);
});
