/* CRM line-item name edits must show on the customer quote and the printable
   PDF. A reason-only override note is NOT a new name (Lee/Dan quotes). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { computePricing } from './pricing.js';
import { quoteLines } from './quotelines.js';
import { buildInvoice, buildMemo } from './invoices.js';
import worker from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = { style: 'gable', w: 18, l: 30, h: 10, foundation: 'pad', foundationFinish: 'plain' };
const redline = () => computePricing(CFG).redline;
const padName = (r) => r.foundName;
const found = (bd) => bd.rows.find((x) => x.kind === 'foundation');
const labelsOf = (bd) => {
  const out = [];
  (bd.rows || []).forEach((r) => {
    out.push(r.label);
    (r.regularSubLines || r.subLines || []).forEach((l) => out.push(l.label));
  });
  (bd.discounts || []).forEach((d) => out.push(d.label));
  (bd.charges || []).forEach((c) => out.push(c.label));
  return out;
};

function loadQuotePage() {
  const html = fs.readFileSync(path.join(HERE, '..', 'quote.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  const el = { innerHTML: '', textContent: '', className: '', style: {}, appendChild() {}, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; } };
  const ctx = { console, URLSearchParams, localStorage: { getItem: () => 't', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: { getElementById: () => el, createElement: () => Object.create(el), querySelector: () => el,
      querySelectorAll: () => [], addEventListener() {} },
    fetch: () => new Promise(() => {}), setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'quotelines.browser.js'), 'utf8'), ctx);
  vm.runInContext(m[1], ctx);
  return ctx;
}
const text = (h) => String(h || '').replace(/<[^>]+>/g, '\u00a6').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('a renamed, raised pad shows the new name and the new price, with no extra adjustment line', () => {
  const r = redline();
  const name = '6" Concrete Pad - 18 x 30';
  const adj = [{ kind: 'override', item: padName(r), amount: 9000, note: name, label: name }];
  const bd = quoteLines(r, adj);
  const pad = found(bd);
  assert.equal(pad.amt, 9000);
  assert.match(pad.label, /6" Concrete Pad - 18 x 30/);
  assert.doesNotMatch(pad.label, /4" slab/);
  assert.equal(pad.override, undefined);
  assert.ok(!(bd.discounts || []).some((d) => d.kind === 'override'));
  assert.ok(!(bd.charges || []).some((c) => /6"|4" slab|Adjustment/i.test(c.label || '')));
  const withNoteOnly = quoteLines(r, [{ kind: 'override', item: padName(r), amount: 9000, note: name }]);
  assert.equal(withNoteOnly.adjustedSubtotal, bd.adjustedSubtotal);
  assert.equal(withNoteOnly.total, bd.total);
});

test('a reason-only note on a raised pad does not rename the line (Lee/Dan)', () => {
  const r = redline();
  const bd = quoteLines(r, [{ kind: 'override', item: padName(r), amount: 4500, note: 'Pad over 175 sq ft' }]);
  const pad = found(bd);
  assert.match(pad.label, /Concrete Pad \(4" slab\)/);
  assert.doesNotMatch(pad.label, /Pad over 175/);
  assert.ok(!labelsOf(bd).some((l) => /Pad over 175/.test(l)));
  const dan = quoteLines(r, [{ kind: 'override', item: padName(r), amount: 8500, note: 'Concrete pad price' }]);
  assert.match(found(dan).label, /Concrete Pad \(4" slab\)/);
  assert.ok(!labelsOf(dan).some((l) => /Concrete pad price/i.test(l)));
});

test('a custom name is not overwritten by the default 4" slab wording', () => {
  const r = redline();
  const bd = quoteLines(r, [{ kind: 'override', item: padName(r), amount: r.foundSell, label: 'Concrete Pad (6" slab)' }]);
  assert.match(found(bd).label, /Concrete Pad \(6" slab\)/);
  assert.doesNotMatch(found(bd).label, /4" slab/);
  assert.equal(found(bd).amt, r.foundSell);
  const plain = quoteLines(r, []);
  assert.equal(bd.adjustedSubtotal, plain.adjustedSubtotal);
  assert.equal(bd.total, plain.total);
});

test('a lowered price keeps the new name on the line and the note as the discount reason', () => {
  const r = redline();
  const bd = quoteLines(r, [{ kind: 'override', item: padName(r), amount: 2000, note: 'Site already level', label: '6" Concrete Pad' }]);
  const pad = found(bd);
  assert.match(pad.label, /6" Concrete Pad/);
  const disc = (bd.discounts || []).find((d) => d.kind === 'override');
  assert.ok(disc);
  assert.match(disc.label, /6" Concrete Pad/);
  assert.match(disc.label, /Site already level/);
});

test('Jen-like stamped quote: the renamed pad shows on card and cash figures, totals unchanged by the label', () => {
  const r = Object.assign(redline(), { cardUplift: 0.03, discountsAtSheet: true });
  const adj = [{ kind: 'override', item: padName(r), amount: 9000, note: '6" Concrete Pad - 18 x 30' }];
  const named = [{ ...adj[0], label: '6" Concrete Pad - 18 x 30' }];
  const before = quoteLines(r, adj);
  const after = quoteLines(r, named);
  assert.match(found(after).label, /6" Concrete Pad - 18 x 30/);
  assert.doesNotMatch(found(before).label, /6" Concrete Pad/);
  assert.match(found(before).label, /4" slab/);
  assert.equal(after.adjustedSubtotal, before.adjustedSubtotal);
  assert.equal(after.total, before.total);
  assert.equal(after.cashDiscount.cashTotal, before.cashDiscount.cashTotal);
  const inv = buildInvoice(after, 'deposit', [], { adjustments: named });
  const blob = JSON.stringify(inv) + buildMemo(after);
  assert.match(blob, /6" Concrete Pad - 18 x 30/);
  assert.doesNotMatch(blob, /4" slab/);
});

test('quote page / PDF breakdown shows the edited name, not the default 4" slab label', () => {
  const page = loadQuotePage();
  const r = Object.assign(redline(), { cardUplift: 0.03, discountsAtSheet: true });
  page.ADJUSTMENTS = [{ kind: 'override', item: padName(r), amount: 9000, label: '6" Concrete Pad - 18 x 30', note: '6" Concrete Pad - 18 x 30' }];
  const bd = page.taxBreakdown(r);
  const t = text(page.buildBreakdown(bd)) + text(page.priceBox(bd, bd.total));
  assert.match(t, /6" Concrete Pad - 18 x 30/);
  assert.doesNotMatch(t, /4" slab/);
  assert.doesNotMatch(t, /Adjustment/);
});

function makeD1(db) {
  function shape(q) {
    const sel = /^\s*(select|pragma|with)/i.test(q);
    const st = db.prepare(q);
    return (a) => ({
      first() { return sel ? (st.get(...a) ?? null) : (st.run(...a), null); },
      all() { return { results: st.all(...a) }; },
      run() {
        if (sel) return { results: st.all(...a) };
        const r = st.run(...a);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map((x) => x.run()); }
  };
}

test('POST /adjustments persists a line label and does not change the price when only the name is added', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')),
                ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k' };
  async function call(m, p, b, t) {
    const h = { Origin: 'https://potentianetwork.com' };
    if (b) h['Content-Type'] = 'application/json';
    if (t) h.Authorization = 'Bearer ' + t;
    const res = await worker.fetch(new Request('https://x' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env);
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  const now = new Date().toISOString();
  const { redline: rl, customer } = computePricing(CFG);
  db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('Jen',?,?)").run(now, now);
  db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'Jen','j@x',?,?,?)")
    .run(JSON.stringify({ quotedPrice: customer, config: CFG, redline: rl }), 'quoted', now);
  const tok = (await call('POST', '/admin/login', { password: 'pw' })).data.token;
  const item = rl.foundName;
  const price = 9000;
  let r = await call('POST', '/admin/submissions/1/adjustments', {
    adjustments: [{ kind: 'override', item, amount: price, note: '6" Concrete Pad - 18 x 30' }]
  }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const priced = r.data.effective_price;
  assert.equal(r.data.adjustments[0].label, undefined);
  r = await call('POST', '/admin/submissions/1/adjustments', {
    adjustments: [{ kind: 'override', item, amount: price, note: '6" Concrete Pad - 18 x 30', label: '6" Concrete Pad - 18 x 30' }]
  }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.adjustments[0].label, '6" Concrete Pad - 18 x 30');
  assert.equal(r.data.adjustments[0].amount, price);
  assert.equal(r.data.effective_price, priced);
  r = await call('POST', '/admin/submissions/1/adjustments', {
    adjustments: [{ kind: 'override', item, amount: price, label: item }]
  }, tok);
  assert.equal(r.status, 200);
  assert.equal(r.data.adjustments[0].label, undefined, 'same-as-item label is not stored');
});
