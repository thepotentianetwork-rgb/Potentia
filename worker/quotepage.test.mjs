/* The quote page's own arithmetic, executed.
 *
 * Twice now a helper in quote.html has referenced a name that was not in its
 * scope — first `config`, then `num` — and each time the result was the same:
 * a ReferenceError thrown while building the document, no quote, and the page
 * left sitting on "Loading…". Nothing caught it, because every test in this
 * repo tested the worker and none of them ever ran the page.
 *
 * This loads the real <script> out of quote.html into a VM and calls
 * taxBreakdown() directly, so a name that isn't in scope fails here instead of
 * on a customer's quote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'quote.html');

function loadQuotePage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'quote.html has an inline <script>');

  // Enough of a browser for the module-level code to run. There is no id in
  // the search string, so the page does not try to fetch anything; every
  // function it declared is still left on the context for us to call.
  const el = {
    innerHTML: '', textContent: '', className: '', style: {},
    appendChild() {}, setAttribute() {}, querySelector() { return null },
    querySelectorAll() { return [] },
  };
  const ctx = {
    console,
    URLSearchParams,
    localStorage: { getItem: () => 'test-token', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: {
      getElementById: () => el,
      createElement: () => Object.create(el),
      querySelector: () => el,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'quote.html' });
  return ctx;
}

const BASE_REDLINE = {
  marginPrice: 5000,
  baseSheetLabel: 'A-Frame',
  foundName: 'Concrete Pad 10x16',
  foundSell: 2000,
  addonLines: [],
};

test('taxBreakdown prices a plain shed', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown(BASE_REDLINE);
  assert.ok(bd, 'a redline with dollars in it produces a breakdown');
  assert.equal(bd.subtotal, 7000);
});

test('a quote carrying removal add-ons does not throw', () => {
  const page = loadQuotePage();
  // This is the exact shape that blanked the page: both removals present as
  // addonLines, which sends taxBreakdown through removalTotal().
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [
      { name: 'Shed Removal', amt: 1000 },
      { name: 'Concrete Removal', amt: 1000 },
    ],
  });
  assert.ok(bd, 'removal add-ons still produce a breakdown');

  const clearance = bd.rows.find(r => /Site Clearance/.test(r.label));
  assert.ok(clearance, 'both removals collapse into one Site Clearance phase');
  assert.equal(clearance.amt, 2000);
  assert.deepEqual(
    clearance.subLines.map(s => [s.label, s.amt]),
    [['Shed Removal', 1000], ['Concrete Removal', 1000]],
    'each removal is itemised under it'
  );

  // Removal is its own phase, so it must not also be inside the Shed total.
  const shed = bd.rows.find(r => / Shed\b/.test(r.label));
  assert.equal(shed.amt, 5000, 'removal dollars are not double-counted into Shed');
  assert.equal(bd.subtotal, 9000);
});

test('a single removal keeps its own name', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [{ name: 'Concrete Removal', amt: 1000 }],
  });
  const row = bd.rows.find(r => /Concrete Removal/.test(r.label));
  assert.ok(row, 'one removal is labelled with the thing being removed');
  assert.ok(!row.subLines, 'and needs no sub-lines');
});

test('removal is the first phase, ahead of the concrete', () => {
  const page = loadQuotePage();
  const bd = page.taxBreakdown({
    ...BASE_REDLINE,
    addonLines: [{ name: 'Shed Removal', amt: 1000 }],
  });
  assert.match(bd.rows[0].label, /^Phase 1 — Shed Removal/);
  assert.match(bd.rows[1].label, /^Phase 2 — Concrete Pad/);
});
