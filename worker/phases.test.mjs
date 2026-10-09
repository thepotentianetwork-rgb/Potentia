/* BILLING BY PHASE: Phase 1 deposit; then Phase 2 deposit + the rest of
 * Phase 1; then Phase 3 deposit + the rest of Phase 2; then the rest of the
 * last phase on completion. Every figure from quoteLines — the same per-phase
 * 30% deposits the quote prints.
 *
 * Run: node --experimental-sqlite --test worker/phases.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { phaseParts, phaseStatus, allocatePhases, buildPhaseInvoice, buildTogetherInvoice, togetherStatus,
         toCents, LIMITS } from './invoices.js';
import worker from './index.js';

/* Three phases: concrete pad, shed, interior. */
const { redline } = computePricing({ style: 'gable', w: 10, l: 20, h: 9, foundation: 'pad', intFinish: 'painted' });
const BD = quoteLines(redline, []);
const P = phaseParts(BD);
const sum = (inv) => inv.lines.reduce((t, l) => t + l.amountCents, 0);

test('phases come straight from the quote, and add up to the job to the cent', () => {
  assert.equal(P.length, 3);
  assert.match(P[0].name, /Concrete/);
  assert.match(P[1].name, /Shed/);
  P.forEach((p, i) => {
    assert.equal(p.depositCents, toCents(BD.rows[i].deposit), 'deposit is the quote\'s Phase N Deposit (30%)');
    assert.equal(p.depositCents + p.remainderCents, p.totalCents);
  });
  assert.equal(P.reduce((t, p) => t + p.totalCents, 0), toCents(BD.total));
});

test('nothing paid: suggest Phase 1 deposit only', () => {
  const st = phaseStatus(BD, []);
  assert.deepEqual(st.suggested, [{ phase: 1, part: 'deposit' }]);
  const inv = buildPhaseInvoice(BD, [], st.suggested);
  assert.equal(inv.totalCents, P[0].depositCents);
  assert.match(inv.lines[0].label, /^Phase 1: Concrete.* deposit \(30%\)$/);
});

test("Stephanie's case: concrete deposit paid outside Stripe -> Phase 2 deposit + rest of Phase 1", () => {
  const pays = [{ amount: P[0].depositCents / 100, method: 'invoice2go', paid_at: '2026-09-01T00:00:00.000Z' }];
  const st = phaseStatus(BD, pays);
  assert.deepEqual(st.suggested, [{ phase: 2, part: 'deposit' }, { phase: 1, part: 'remainder' }]);
  const inv = buildPhaseInvoice(BD, pays, st.suggested, { submissionId: 7 });
  assert.equal(inv.totalCents, P[1].depositCents + P[0].remainderCents);
  assert.equal(sum(inv), inv.totalCents);
  const labels = inv.lines.map((l) => l.label);
  assert.match(labels[0], /^Phase 2: Shed.* deposit \(30%\)$/);
  /* The rest of Phase 1 is shown as what is LEFT — the deposit she paid is
     already inside that number, not a minus line to reconcile. */
  assert.equal(labels[1], 'Remainder of Phase 1: Concrete Pad (4" slab) ($500.00 concrete pad promo applied), due after completion');
  assert.equal(inv.lines[1].amountCents, P[0].remainderCents);
  assert.equal(inv.lines.length, 2, 'no separate credit line: the payment is folded in');
  assert.ok(inv.lines.every((l) => l.amountCents > 0));
  assert.match(inv.memo, /Your \$965\.25 deposit \(Invoice2go, 9\/1\/2026\) has been applied\./);
  assert.match(inv.memo, /30% deposit on that phase/);
  assert.match(inv.memo, /due once that phase is complete/);
  assert.match(inv.memo, /This invoice: Phase 2 deposit \+ rest of Phase 1\./);
  assert.ok(inv.memo.length <= LIMITS.memo);
  assert.deepEqual(inv.covers.map((c) => c.phase + c.part), ['2deposit', '1remainder']);
});

test('then: Phase 3 deposit + rest of Phase 2; then the rest of Phase 3 on completion', () => {
  const pays = [
    { amount: P[0].depositCents / 100, method: 'check', phase_alloc: '{"phase":1}' },
    { amount: (P[1].depositCents + P[0].remainderCents) / 100, method: 'stripe',
      phase_alloc: JSON.stringify({ parts: [{ phase: 2, part: 'deposit', cents: P[1].depositCents },
                                            { phase: 1, part: 'remainder', cents: P[0].remainderCents }] }) },
  ];
  let st = phaseStatus(BD, pays);
  assert.deepEqual(st.suggested, [{ phase: 3, part: 'deposit' }, { phase: 2, part: 'remainder' }]);
  const third = buildPhaseInvoice(BD, pays, st.suggested);
  assert.equal(third.totalCents, P[2].depositCents + P[1].remainderCents);
  pays.push({ amount: third.totalCents / 100, method: 'stripe', phase_alloc: JSON.stringify({ parts: third.covers }) });
  st = phaseStatus(BD, pays);
  assert.deepEqual(st.suggested, [{ phase: 3, part: 'remainder' }]);
  const last = buildPhaseInvoice(BD, pays, st.suggested);
  assert.equal(last.totalCents, P[2].remainderCents);
  pays.push({ amount: last.totalCents / 100, method: 'stripe' });
  st = phaseStatus(BD, pays);
  assert.deepEqual(st.suggested, [], 'paid in full: nothing to suggest');
  const paid = pays.reduce((t, p) => t + toCents(p.amount), 0);
  assert.equal(paid, toCents(BD.total), 'the four invoices together are exactly the job');
});

test('untagged payments fill deposits first: an old full-deposit payment covers every phase deposit', () => {
  const st = phaseStatus(BD, [{ amount: BD.depositTotal, method: 'stripe' }]);
  st.phases.forEach((p) => {
    assert.equal(p.deposit.remainingCents, 0);
    assert.equal(p.remainder.paidCents, 0);
  });
  assert.deepEqual(st.suggested, [{ phase: 1, part: 'remainder' }]);
});

test('a payment tagged to a phase stays on that phase, even out of order', () => {
  const st = phaseStatus(BD, [{ amount: 1000, method: 'cash', phase_alloc: '{"phase":2}' }]);
  assert.equal(st.phases[1].deposit.paidCents, 100000);
  assert.equal(st.phases[0].deposit.paidCents, 0);
  assert.deepEqual(st.suggested, [{ phase: 1, part: 'deposit' }]);
  /* Billing phase 2's deposit now credits the $1,000 toward it. */
  const inv = buildPhaseInvoice(BD, [{ amount: 1000, method: 'cash', paid_at: '2026-10-01', phase_alloc: '{"phase":2}' }],
    [{ phase: 2, part: 'deposit' }]);
  assert.equal(inv.totalCents, P[1].depositCents - 100000);
  assert.equal(inv.lines.length, 1);
  assert.match(inv.lines[0].label, /^Phase 2: Shed \(Gable \/ A-Frame\) deposit \(30%\), less \$1,000\.00 already paid$/);
  assert.equal(inv.lines[0].amountCents, P[1].depositCents - 100000);
});

test('a tagged payment bigger than its phase spills to the rest, never lost', () => {
  const big = (P[0].totalCents + 5000) / 100;
  const a = allocatePhases(P, [{ amount: big, phase_alloc: '{"phase":1}' }]);
  assert.equal(a.paid['1:deposit'] + a.paid['1:remainder'], P[0].totalCents);
  assert.equal(a.paid['2:deposit'], 5000);
  assert.equal(a.overpaidCents, 0);
});

test('overpaid never goes negative', () => {
  const a = allocatePhases(P, [{ amount: BD.total + 10 }]);
  assert.equal(a.overpaidCents, 1000);
});

test('the whole phase (deposit + rest) can be billed at once', () => {
  const inv = buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit' }, { phase: 1, part: 'remainder' }]);
  assert.equal(inv.totalCents, P[0].totalCents);
  assert.equal(inv.lines.length, 1);
  assert.match(inv.description, /all of Phase 1/);
});

test('the rest of a phase without its unpaid deposit bills only the 70%', () => {
  const inv = buildPhaseInvoice(BD, [], [{ phase: 1, part: 'remainder' }]);
  assert.equal(inv.totalCents, P[0].remainderCents);
  assert.match(inv.lines[0].label, /, due after completion — 70% of the phase$/);
});

test('refusals: nothing ticked, unknown phase, already paid, already on an open invoice', () => {
  assert.throws(() => buildPhaseInvoice(BD, [], []), (e) => e.code === 'nothing_selected');
  assert.throws(() => buildPhaseInvoice(BD, [], [{ phase: 9, part: 'deposit' }]), (e) => e.code === 'bad_phase');
  assert.throws(() => buildPhaseInvoice(BD, [{ amount: P[0].depositCents / 100 }], [{ phase: 1, part: 'deposit' }]),
    (e) => e.code === 'already_paid');
  assert.throws(() => buildPhaseInvoice(BD, [], [{ phase: 1, part: 'deposit' }], { openParts: [{ phase: 1, part: 'deposit', invoice_id: 3 }] }),
    (e) => e.code === 'already_billed');
  /* ... and an open part is never suggested. */
  const st = phaseStatus(BD, [], [{ phase: 1, part: 'deposit', invoice_id: 3 }]);
  assert.deepEqual(st.suggested, [{ phase: 2, part: 'deposit' }]);
});

test('a discount scales every phase, and the phases still add up', () => {
  const bd = quoteLines(redline, [{ kind: 'amount', value: -1000, note: 'Loyal customer' }]);
  const pp = phaseParts(bd);
  assert.equal(pp.reduce((t, p) => t + p.totalCents, 0), toCents(bd.total));
  assert.ok(pp[0].totalCents < P[0].totalCents);
});

/* ---- endpoints ----------------------------------------------------------- */

function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const s = db.prepare(sql); if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; }
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}
function setup({ migrated = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT, adjustments TEXT,
      price_adjustment REAL, adjustment_note TEXT, status TEXT, created_at TEXT, effective_price REAL);
    CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, amount REAL NOT NULL,
      method TEXT NOT NULL, note TEXT, paid_at TEXT NOT NULL, created_at TEXT NOT NULL, submission_id INTEGER);`);
  if (migrated) db.exec(readFileSync(new URL('./migrations/0001_payment_phases.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO customers (id,name,email) VALUES (1,'Pat','pat@test.test')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,'won','2026-09-01')")
    .run(JSON.stringify({ redline }));
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k', STRIPE_SECRET_KEY: 'sk_test_fake' } };
}
let stripeSays = { status: 'open' };
const stripeCalls = [];
const realFetch = globalThis.fetch;
function stub() {
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    stripeCalls.push({ path: p, params: Object.fromEntries(new URLSearchParams((init && init.body) || '')) });
    const id = p === '/v1/customers' ? 'cus_1' : p.includes('invoiceitems') ? 'ii_1' : 'in_1';
    return { ok: true, status: 200, json: async () => ({ id, hosted_invoice_url: 'https://pay.stripe/x', status: 'open', ...stripeSays }) };
  };
}
function unstub() { globalThis.fetch = realFetch; }
async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' }; if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
const tokenOf = async (env) => (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
const c = (n) => Math.round(n * 100);

test('balances list phases and the suggestion; tagging a payment moves it', async () => {
  const { env } = setup();
  const t = await tokenOf(env);
  const id = (await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'check', submission_id: 7 }, t)).data.id;
  let b = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data;
  assert.equal(b.phase_tracking, true);
  let b7 = b.builds[0];
  assert.equal(b7.phases.length, 3);
  assert.equal(c(b7.phases[0].deposit.paid), 50000, 'untagged -> phase 1 deposit');
  assert.deepEqual(b7.payments[0].applied_to, [{ phase: 1, part: 'deposit', amount: 500 }]);

  const ed = await api(env, 'POST', '/admin/payments/' + id, { phase: 2 }, t);
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  b7 = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data.builds[0];
  assert.equal(c(b7.phases[1].deposit.paid), 50000, 'now on phase 2');
  assert.equal(b7.payments[0].phase, 2);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { phase: 'x' }, t)).status, 400);
  assert.equal((await api(env, 'POST', '/admin/payments/' + id, { phase: null }, t)).status, 200);
});

test('before the migration: everything works, only tagging is refused', async () => {
  const { env } = setup({ migrated: false });
  const t = await tokenOf(env);
  const id = (await api(env, 'POST', '/admin/customers/1/payments', { amount: 500, method: 'check', submission_id: 7 }, t)).data.id;
  const b = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data;
  assert.equal(b.phase_tracking, false);
  assert.equal(c(b.builds[0].phases[0].deposit.paid), 50000);
  const r = await api(env, 'POST', '/admin/payments/' + id, { phase: 2 }, t);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'needs_migration');
  stub();
  const prev = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', preview: true,
    parts: [{ phase: 1, part: 'deposit' }] }, t);
  unstub();
  assert.equal(prev.status, 200);
});

test('a phase invoice: preview, send, refuse a second bill for the same part, book the payment on paid', async () => {
  const { db, env } = setup();
  const t = await tokenOf(env);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: P[0].depositCents / 100, method: 'invoice2go',
    submission_id: 7, phase: 1, paid_at: '2026-09-01T00:00:00.000Z' }, t);
  const parts = [{ phase: 2, part: 'deposit' }, { phase: 1, part: 'remainder' }];
  stripeCalls.length = 0; stub();
  const prev = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', parts, preview: true }, t);
  assert.equal(stripeCalls.length, 0, 'preview never reaches Stripe');
  assert.equal(c(prev.data.amount), P[1].depositCents + P[0].remainderCents);
  assert.equal(prev.data.description, 'Phase 2 deposit + rest of Phase 1');
  assert.ok(prev.data.lines.every((l) => l.amount > 0), 'payments are folded in, not minus lines');
  assert.match(prev.data.memo, /Your \$[\d,.]+ deposit \(Invoice2go, 9\/1\/2026\) has been applied\./);

  const sent = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', parts }, t);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const fin = stripeCalls.find((x) => x.path === '/v1/invoices');
  assert.equal(fin.params.days_until_due, '0');
  assert.match(fin.params.description, /How payment works/);
  const fieldVals = Object.entries(fin.params).filter(([k]) => /^custom_fields\[\d+\]\[value\]$/.test(k)).map(([, v]) => v);
  assert.ok(fieldVals.includes('Phase 2 deposit + rest of Phase 1'), JSON.stringify(fieldVals));
  const items = stripeCalls.filter((x) => x.path === '/v1/invoiceitems').map((x) => [x.params.description, Number(x.params.amount)]);
  assert.equal(items.reduce((t2, x) => t2 + x[1], 0), P[1].depositCents + P[0].remainderCents);
  assert.ok(items.some((x) => /^Remainder of Phase 1/.test(x[0])));

  const again = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', parts: [{ phase: 2, part: 'deposit' }] }, t);
  assert.equal(again.status, 409, 'same part twice is refused while the first is open');
  const other = await api(env, 'POST', '/admin/invoices', { submission_id: 7, kind: 'phase', preview: true, parts: [{ phase: 3, part: 'deposit' }] }, t);
  assert.equal(other.status, 200, 'a different phase is fine');
  let b7 = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data.builds[0];
  assert.ok(b7.phases[1].deposit.open_invoice, 'shown as on a sent invoice');
  assert.deepEqual(b7.suggested, [{ phase: 3, part: 'deposit' }], 'and not suggested again');

  stripeSays = { status: 'paid', amount_paid: P[1].depositCents + P[0].remainderCents };
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);
  stripeSays = { status: 'open' }; unstub();
  const rows = db.prepare("SELECT * FROM payments WHERE method='stripe'").all();
  assert.equal(rows.length, 1, 'recorded once');
  assert.deepEqual(JSON.parse(rows[0].phase_alloc).parts.map((p) => p.phase + p.part), ['2deposit', '1remainder']);
  b7 = (await api(env, 'GET', '/admin/customers/1/balances', null, t)).data.builds[0];
  assert.equal(b7.phases[0].remainder.remaining, 0);
  assert.equal(b7.phases[1].deposit.remaining, 0);
  assert.deepEqual(b7.suggested, [{ phase: 3, part: 'deposit' }, { phase: 2, part: 'remainder' }]);
  assert.equal(c(b7.balance_due), toCents(BD.total) - P[0].totalCents - P[1].depositCents, 'total balance agrees');
});

/* ---------------------------------------------------------------------------
 * TWO BUILDS, BILLED TOGETHER. A 10x20 with concrete, shed and interior, and an
 * 8x16 with concrete and shed and a $1,000 discount — the shape of Stephanie
 * Padilla's two orders. Phases match by kind; each build keeps its own books.
 * ------------------------------------------------------------------------- */
const R2 = computePricing({ style: 'gable', w: 8, l: 16, h: 8, foundation: 'pad' }).redline;
const BD2 = quoteLines(R2, [{ kind: 'amount', value: -1000, note: 'Loyal customer' }]);
const P2 = phaseParts(BD2);
const NAME7 = '10x20 Gable / A-Frame', NAME38 = '8x16 Gable / A-Frame';
const two = (pays7, pays38, open7, open38) => [
  { sub: 7, name: NAME7, bd: BD, payments: pays7 || [], openParts: open7 },
  { sub: 38, name: NAME38, bd: BD2, payments: pays38 || [], openParts: open38 }];
const DEP7 = [{ amount: P[0].depositCents / 100, method: 'invoice2go', paid_at: '2026-09-01T00:00:00.000Z' }];

test('together: phases match by kind, and a build without one is just absent', () => {
  const ts = togetherStatus(two());
  assert.deepEqual(ts.groups.map((g) => [g.phase, g.kind, g.name, g.items.map((i) => i.sub)]), [
    [1, 'foundation', 'Concrete Pads', [7, 38]],
    [2, 'shed', 'Sheds', [7, 38]],
    [3, 'interior', P[2].name.replace(/\s*\([^)]*\)/g, ''), [7]],
  ]);
  /* A build with site clearance in front still lines its concrete up with the
     other's concrete, not with its clearance. */
  const cleared = computePricing({ style: 'gable', w: 8, l: 12, h: 8, foundation: 'pad', addons: { shedRemoval: true } }).redline;
  const bdc = quoteLines(cleared, []);
  assert.equal(bdc.rows[0].kind, 'clearance', 'fixture has a clearance phase');
  {
    const t2 = togetherStatus([{ sub: 1, name: 'A', bd: BD, payments: [] }, { sub: 2, name: 'B', bd: bdc, payments: [] }]);
    const conc = t2.groups.find((g) => g.kind === 'foundation');
    assert.deepEqual(conc.items.map((i) => [i.sub, i.phase]), [[1, 1], [2, 2]]);
  }
});

test("together, Stephanie's shape: only the 8x16's concrete deposit is owed first", () => {
  const ts = togetherStatus(two(DEP7));
  assert.deepEqual(ts.suggested, [{ phase: 1, part: 'deposit' }]);
  const inv = buildTogetherInvoice(two(DEP7), ts.suggested);
  assert.equal(inv.totalCents, P2[0].depositCents, 'the 10x20 concrete deposit is paid, so only the 8x16 one');
  assert.deepEqual(inv.lines.map((l) => l.label), ['Phase 1: Concrete Pad deposit (30%) — ' + NAME38]);
  assert.deepEqual(inv.covers, [{ sub: 38, phase: 1, part: 'deposit', cents: P2[0].depositCents }]);
  assert.equal(inv.description, 'Phase 1 deposit (8x16)');
  assert.ok(inv.memo.length <= LIMITS.memo);
  assert.match(inv.memo, /two sheds \(10x20 and 8x16\) are billed together/);
  assert.match(inv.memo, /Phase 3: .* \(10x20 only\)/);
});

test('together, the bigger bill: 8x16 concrete deposit + both shed deposits + rest of both concretes', () => {
  const sel = [{ phase: 1, part: 'deposit' }, { phase: 2, part: 'deposit' }, { phase: 1, part: 'remainder' }];
  const inv = buildTogetherInvoice(two(DEP7), sel);
  assert.equal(inv.totalCents, P2[0].depositCents + P[1].depositCents + P2[1].depositCents + P[0].remainderCents + P2[0].remainderCents);
  assert.equal(sum(inv), inv.totalCents);
  const labels = inv.lines.map((l) => l.label);
  assert.deepEqual(labels, [
    'Phase 2: Shed deposit (30%) — ' + NAME7,
    'Phase 2: Shed deposit (30%) — ' + NAME38,
    'Remainder of Phase 1: Concrete Pad, due after completion — ' + NAME7,
    'Phase 1: Concrete Pad, full amount (deposit + remainder) — ' + NAME38,
  ]);
  assert.ok(inv.lines.every((l) => l.amountCents > 0), 'no minus lines: her deposit is inside the 10x20 remainder');
  assert.match(inv.memo, /Your \$965\.25 deposit \(Invoice2go, 9\/1\/2026\) on the 10x20 has been applied\./);
  assert.ok(inv.memo.length <= LIMITS.memo, inv.memo.length);
  const fields = Object.fromEntries(inv.customFields.map((f) => [f.name, f.value]));
  assert.equal(fields.Orders, '#7 + #38');
  assert.equal(fields['Total, all builds'], '$' + ((toCents(BD.total) + toCents(BD2.total)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }));
  /* Every cent says which build it is for. */
  const per = {};
  inv.covers.forEach((c2) => { per[c2.sub] = (per[c2.sub] || 0) + c2.cents; });
  assert.equal(per[7], P[1].depositCents + P[0].remainderCents);
  assert.equal(per[38], P2[0].depositCents + P2[1].depositCents + P2[0].remainderCents);
});

test('together, start to finish: each build is paid to the cent, and nothing is billed twice', () => {
  const pays = { 7: DEP7.slice(), 38: [] };
  const book = (inv) => {
    const by = {};
    inv.covers.forEach((c2) => { (by[c2.sub] = by[c2.sub] || []).push({ phase: c2.phase, part: c2.part, cents: c2.cents }); });
    Object.entries(by).forEach(([sub, parts]) => pays[sub].push({
      amount: parts.reduce((t, x) => t + x.cents, 0) / 100, method: 'stripe', phase_alloc: JSON.stringify({ parts }) }));
  };
  let billed = 0, n = 0;
  for (;;) {
    const ts = togetherStatus(two(pays[7], pays[38]));
    if (!ts.suggested.length) break;
    const inv = buildTogetherInvoice(two(pays[7], pays[38]), ts.suggested);
    assert.equal(sum(inv), inv.totalCents);
    billed += inv.totalCents; book(inv);
    assert.ok(++n < 10, 'runs out');
  }
  const paid = (arr) => arr.reduce((t, p) => t + toCents(p.amount), 0);
  assert.equal(paid(pays[7]), toCents(BD.total), '10x20 paid exactly its total');
  assert.equal(paid(pays[38]), toCents(BD2.total), '8x16 paid exactly its total');
  assert.equal(billed + P[0].depositCents, toCents(BD.total) + toCents(BD2.total), 'the bills are exactly both jobs');
  /* Concrete deposit for the 8x16; then shed deposits + rest of both pads;
     then interior deposit + rest of both sheds; then the rest of the interior. */
  assert.equal(n, 4);
});

test('together: a part on an open combined invoice is refused for that build, the other build still bills', () => {
  const open38 = [{ phase: 1, part: 'deposit', invoice_id: 9 }];
  assert.throws(() => buildTogetherInvoice(two(DEP7, [], null, open38), [{ phase: 1, part: 'deposit' }]),
    (e) => e.code === 'already_billed');
  const inv = buildTogetherInvoice(two([], [], null, open38), [{ phase: 1, part: 'deposit' }]);
  assert.deepEqual(inv.covers.map((x) => x.sub), [7], 'only the build not already billed');
  assert.throws(() => buildTogetherInvoice(two(), [{ phase: 3, part: 'deposit', sub: 38 }]), (e) => e.code === 'bad_phase');
  const only = buildTogetherInvoice(two(), [{ phase: 2, part: 'deposit', sub: 38 }]);
  assert.equal(only.totalCents, P2[1].depositCents);
});

test('combined invoice end to end: preview, send, refused twice from either build, paid -> one payment per build', async () => {
  const { db, env } = setup();
  db.prepare("INSERT INTO submissions (id,customer_id,details,adjustments,status,created_at) VALUES (38,1,?,?,'won','2026-09-20')")
    .run(JSON.stringify({ redline: R2, config: { w: 8, l: 16, style: 'gable' } }),
         JSON.stringify([{ kind: 'amount', value: -1000, note: 'Loyal customer' }]));
  db.prepare("UPDATE submissions SET details = ? WHERE id = 7").run(JSON.stringify({ redline, config: { w: 10, l: 20, style: 'gable' } }));
  db.prepare("INSERT INTO customers (id,name,email) VALUES (2,'Other','o@test.test')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (50,2,?,'won','2026-09-20')").run(JSON.stringify({ redline }));
  const t = await tokenOf(env);
  await api(env, 'POST', '/admin/customers/1/payments', { amount: P[0].depositCents / 100, method: 'invoice2go',
    submission_id: 7, phase: 1, paid_at: '2026-09-01T00:00:00.000Z' }, t);

  let b = (await api(env, 'GET', '/admin/customers/1/balances?together=7,38', null, t)).data;
  assert.deepEqual(b.together.builds.map((x) => x.name), [NAME7, NAME38]);
  assert.deepEqual(b.together.suggested, [{ phase: 1, part: 'deposit' }]);
  assert.equal(b.together.phases[0].items[1].deposit.remaining * 100, P2[0].depositCents);

  const parts = [{ phase: 1, part: 'deposit' }, { phase: 2, part: 'deposit' }, { phase: 1, part: 'remainder' }];
  const want = P2[0].depositCents + P[1].depositCents + P2[1].depositCents + P[0].remainderCents + P2[0].remainderCents;
  stripeCalls.length = 0; stub();
  const prev = await api(env, 'POST', '/admin/invoices', { submission_id: 7, builds: [7, 38], kind: 'phase', parts, preview: true }, t);
  assert.equal(prev.status, 200, JSON.stringify(prev.data));
  assert.equal(stripeCalls.length, 0);
  assert.equal(c(prev.data.amount), want);
  assert.deepEqual(prev.data.builds, [7, 38]);
  assert.ok(prev.data.lines.some((l) => l.label === 'Phase 2: Shed deposit (30%) — ' + NAME38));

  const wrong = await api(env, 'POST', '/admin/invoices', { submission_id: 7, builds: [7, 50], kind: 'phase', parts, preview: true }, t);
  assert.equal(wrong.status, 400, 'another customer\'s build cannot ride along');

  const sent = await api(env, 'POST', '/admin/invoices', { submission_id: 7, builds: [7, 38], kind: 'phase', parts }, t);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const items = stripeCalls.filter((x) => x.path === '/v1/invoiceitems').map((x) => Number(x.params.amount));
  assert.equal(items.reduce((a, x) => a + x, 0), want);
  const fin = stripeCalls.find((x) => x.path === '/v1/invoices');
  assert.equal(fin.params['metadata[builds]'], '7,38');

  /* The same part, billed again — from the 8x16 alone, or together. */
  const again38 = await api(env, 'POST', '/admin/invoices', { submission_id: 38, kind: 'phase', parts: [{ phase: 2, part: 'deposit' }] }, t);
  assert.equal(again38.status, 409, 'the 8x16 shed deposit is on the open combined bill');
  const againBoth = await api(env, 'POST', '/admin/invoices', { submission_id: 38, builds: [38, 7], kind: 'phase', preview: true,
    parts: [{ phase: 1, part: 'remainder' }] }, t);
  assert.equal(againBoth.status, 409);
  b = (await api(env, 'GET', '/admin/customers/1/balances?together=7,38', null, t)).data;
  const b38 = b.builds.find((x) => x.submission_id === 38);
  assert.ok(b38.phases[1].deposit.open_invoice, 'the 8x16 sees the combined bill');
  assert.ok(b38.open_invoices.some((o) => o.id === sent.data.id && o.builds), 'listed on the 8x16 too');
  assert.deepEqual(b.together.suggested, [{ phase: 3, part: 'deposit' }]);

  stripeSays = { status: 'paid', amount_paid: want };
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);
  await api(env, 'POST', '/admin/invoices/' + sent.data.id + '/sync', null, t);
  stripeSays = { status: 'open' }; unstub();
  const rows = db.prepare("SELECT * FROM payments WHERE method='stripe' ORDER BY submission_id").all();
  assert.equal(rows.length, 2, 'one payment per build, recorded once');
  assert.deepEqual(rows.map((r) => [r.submission_id, c(r.amount)]),
    [[7, P[1].depositCents + P[0].remainderCents], [38, P2[0].depositCents + P2[1].depositCents + P2[0].remainderCents]]);
  b = (await api(env, 'GET', '/admin/customers/1/balances?together=7,38', null, t)).data;
  const by = Object.fromEntries(b.builds.map((x) => [x.submission_id, x]));
  assert.equal(c(by[7].balance_due), toCents(BD.total) - P[0].totalCents - P[1].depositCents);
  assert.equal(c(by[38].balance_due), toCents(BD2.total) - P2[0].totalCents - P2[1].depositCents);
  assert.deepEqual(b.together.suggested, [{ phase: 3, part: 'deposit' }, { phase: 2, part: 'remainder' }]);
});

test("Gable and A-Frame are one style, named 'Gable / A-Frame' to customers — old saved quotes included", async () => {
  const { shedStyleName } = await import('./quotelines.js');
  assert.equal(shedStyleName('gable'), 'Gable / A-Frame');
  assert.equal(shedStyleName('A-Frame'), 'Gable / A-Frame');
  assert.equal(shedStyleName('barn'), 'barn');
  const old = quoteLines({ ...redline, baseSheetLabel: 'A-Frame' }, []);
  assert.equal(old.rows[1].label, 'Phase 2 — Shed (Gable / A-Frame)');
  assert.equal(BD.rows[1].label, 'Phase 2 — Shed (Gable / A-Frame)', 'new quotes too');
  const inv = buildPhaseInvoice(BD, [], [{ phase: 2, part: 'deposit' }]);
  assert.equal(inv.lines[0].label, 'Phase 2: Shed (Gable / A-Frame) deposit (30%)');
});
