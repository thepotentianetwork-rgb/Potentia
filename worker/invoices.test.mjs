/* WHAT THE CUSTOMER GETS CHARGED.
 *
 * Runs against real redlines through the real quoteLines, so these are the
 * figures an actual shed would be billed — not a fixture someone typed.
 *
 * Run: node --test worker/invoices.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { buildInvoice, toCents } from './invoices.js';

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
    for (const [a, adj] of ADJUSTMENTS) out.push([`${b} / ${a}`, quoteLines(redline, adj)]);
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

test('one line per phase, named the way the quote named them', () => {
  const [, bd] = cases()[0];
  const inv = buildInvoice(bd, 'deposit', []);
  assert.equal(inv.lines.length, bd.rows.filter((r) => toCents(r.deposit) !== 0).length);
  inv.lines.forEach((l, i) => {
    assert.ok(l.label.startsWith(bd.rows[i].label), `"${l.label}" should lead with the phase name`);
    assert.match(l.label, /tax included/);
  });
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
test('each phase line matches that phase on the quote, tax included', () => {
  for (const [label, bd] of cases()) {
    const inv = buildInvoice(bd, 'balance', []);
    const phases = bd.rows.filter((r) => toCents(r.total) !== 0);
    assert.equal(inv.lines.length, phases.length, `${label}: line count`);
    inv.lines.forEach((l, i) => {
      const want = toCents(phases[i].total);
      assert.ok(Math.abs(l.amountCents - want) <= 2,
        `${label}: "${l.label}" is ${l.amountCents}, the quote says ${want}`);
      /* And emphatically not the pre-tax figure. */
      const pre = toCents(phases[i].amt);
      if (Math.abs(want - pre) > 5) {
        assert.notEqual(l.amountCents, pre, `${label}: "${l.label}" is the PRE-TAX amount`);
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
   would misstate what the customer has paid. */
test('a rounding penny never lands on a payment credit', () => {
  for (const [label, bd] of cases()) {
    const inv = buildInvoice(bd, 'balance', [{ amount: 1234.567, method: 'check' }]);
    const credit = inv.lines.find((l) => l.amountCents < 0);
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
