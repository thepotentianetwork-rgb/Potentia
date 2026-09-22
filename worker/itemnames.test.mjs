/* What the itemisation CALLS things.
 *
 * Two naming faults, both reported by a customer reading their own quote:
 *
 *   1. A window line read "Black Vinyl 36x36". That is a colour, a material
 *      and a size, and no noun — it never says the thing being bought is a
 *      window. Sat next to a door line reading "6' Roll-Up Garage Door", it
 *      looked like a material charge.
 *
 *   2. The horizontal siding line read "Horizontal Lap". It is not lap siding.
 *      It is T1-11 run horizontally. Naming a product after a different, more
 *      expensive-sounding product is not a typo you want a customer to catch.
 *
 * Both names are display-only and both are built from ids that must NOT move:
 * the window catalog key indexes SELL.windows and lives in every saved design,
 * and the siding id indexes SELL.siding and does the same. So the tests below
 * pin two things at once — that the label reads correctly, and that the key
 * underneath it did not change with it.
 *
 * Run: node --test worker/itemnames.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePricing, windowDisplayName, sidingDisplayName,
  WINDOW_CATALOG, SELL, sellWindowPrice
} from './pricing.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ── WINDOWS ──────────────────────────────────────────────────────────────

test('a window line says it is a window', () => {
  assert.equal(windowDisplayName('Black Vinyl 36x36'), 'Black Vinyl Window 36x36');
  assert.equal(windowDisplayName('White Vinyl 18x24'), 'White Vinyl Window 18x24');
  assert.equal(windowDisplayName('Brown Aluminum 24x36'), 'Brown Aluminum Window 24x36');
  assert.equal(windowDisplayName('White Transom 3x10'), 'White Transom Window 3x10');
});

test('the size stays last, so it reads like the door lines do', () => {
  const n = windowDisplayName('Black Vinyl 36x36');
  assert.ok(/36x36$/.test(n), `size is on the end: ${n}`);
  assert.ok(/Window 36x36$/.test(n), `noun sits before the size: ${n}`);
});

test('every catalog window gets the noun', () => {
  for (const e of WINDOW_CATALOG) {
    const n = windowDisplayName(e.key);
    assert.ok(/\bwindow\b/i.test(n), `${e.key} -> "${n}" names the product`);
  }
});

test('the noun is not doubled up if it is already there', () => {
  // A key someone adds later as "... Window 24x36", or a name fed back
  // through on a re-render, must not come out "Window Window".
  const once = windowDisplayName('Black Vinyl Window 36x36');
  assert.equal(once, 'Black Vinyl Window 36x36');
  assert.equal(windowDisplayName(windowDisplayName('Black Vinyl 36x36')),
               'Black Vinyl Window 36x36');
  assert.equal(windowDisplayName('Window'), 'Window');
});

test('a name with no size in it is left alone', () => {
  assert.equal(windowDisplayName('Window'), 'Window');
  assert.equal(windowDisplayName('Transom 87x10'), 'Transom Window 87x10');
  assert.equal(windowDisplayName(''), 'Window');
  assert.equal(windowDisplayName(null), 'Window');
  assert.equal(windowDisplayName(undefined), 'Window');
});

test('renaming the label did not rename the priced key', () => {
  /* This is the whole reason the rename happens on the way out. If the
     catalog keys had been renamed instead, every one of these lookups would
     miss and the window would quote at nothing. */
  for (const e of WINDOW_CATALOG) {
    if (SELL.windows[e.key] == null) continue;   // the unpriced transoms
    const display = windowDisplayName(e.key);
    assert.notEqual(display, e.key, `${e.key} is displayed differently`);
    assert.equal(SELL.windows[display], undefined,
      `"${display}" is a label, not a price key — nothing may index SELL.windows by it`);
    assert.ok(SELL.windows[e.key] > 0, `${e.key} still has its price`);
    assert.equal(sellWindowPrice({ type: e.key, w: e.w, h: e.h }), SELL.windows[e.key],
      `${e.key} still prices off its key`);
  }
});

test('the quote line for a placed window carries the noun', () => {
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 9,
    windows: [
      { wall: 'left',  pos: 0.3, w: 36, h: 36, cy: 52, type: 'Black Vinyl 36x36' },
      { wall: 'right', pos: 0.5, w: 24, h: 30, cy: 52, type: 'White Vinyl 24x30' }
    ]
  });
  const labels = (redline.windowSellLines || []).map(l => l.label);
  assert.equal(labels.length, 2, 'both windows are itemised');
  for (const l of labels) assert.ok(/\bWindow\b/.test(l), `"${l}" says window`);
  assert.ok(labels.includes('Black Vinyl Window 36x36'));
  assert.ok(labels.includes('White Vinyl Window 24x30'));
});

test('an untyped window still itemises, and still says window', () => {
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 9,
    windows: [{ wall: 'left', pos: 0.3, w: 24, h: 30, cy: 52 }]
  });
  const lines = redline.windowSellLines || [];
  assert.equal(lines.length, 1);
  assert.ok(/\bWindow\b/i.test(lines[0].label), `"${lines[0].label}" says window`);
});

test('the unpriced warning names the window the customer sees, not the raw key', () => {
  // Staff read this note against the quote in front of them. If it spells the
  // item differently from the line it refers to, it is a note about nothing.
  const unpricedKey = WINDOW_CATALOG.find(e => SELL.windows[e.key] == null);
  assert.ok(unpricedKey, 'there is at least one catalog window with no price');
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 9,
    windows: [{ wall: 'left', pos: 0.3, w: unpricedKey.w, h: unpricedKey.h,
                cy: 52, type: unpricedKey.key }]
  });
  const note = (redline.unpriced || []).find(u => /no workbook price/.test(u));
  assert.ok(note, 'the estimate is flagged');
  assert.ok(note.startsWith(windowDisplayName(unpricedKey.key)),
    `note "${note}" leads with the displayed name`);
});

// ── SIDING ───────────────────────────────────────────────────────────────

test('the horizontal siding line no longer claims to be lap siding', () => {
  const n = sidingDisplayName('horizontal');
  assert.ok(!/lap/i.test(n), `"${n}" does not say lap`);
  assert.equal(n, 'Horizontal Siding');
});

test('each siding is named by its orientation', () => {
  assert.equal(sidingDisplayName('vertical'), 'Vertical Siding');
  assert.equal(sidingDisplayName('horizontal'), 'Horizontal Siding');
  assert.equal(sidingDisplayName('board-batten'), 'Board & Batten Siding');
  assert.equal(sidingDisplayName('pine'), 'Pine T&G Siding');
});

test('every siding the engine can charge for has a name', () => {
  /* The fallback returns the raw id, which would put "board-batten" on a
     customer's quote. Worse, the comp picker matches on this exact string, so
     a raw id there is a line staff cannot give away by name. Adding a rate
     without adding a label fails here. */
  for (const id of Object.keys(SELL.siding)) {
    const n = sidingDisplayName(id);
    assert.notEqual(n, id, `siding "${id}" has a customer-facing name`);
    assert.ok(/^[A-Z]/.test(n), `"${n}" is written like a label`);
    assert.ok(!/-/.test(n), `"${n}" is not an id with a hyphen in it`);
  }
});

test('the siding line on a real quote reads correctly', () => {
  for (const [id, want] of [['horizontal', 'Horizontal Siding'],
                            ['board-batten', 'Board & Batten Siding']]) {
    const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9, siding: id });
    assert.equal(redline.sidingSellName, want);
    assert.ok(redline.sidingSell > 0, `${id} is an upcharge, so it has a line`);
  }
});

test('vertical is the included siding, so it has no line to name', () => {
  const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9, siding: 'vertical' });
  assert.equal(redline.sidingSell, 0);
  assert.equal(redline.sidingSellName, '', 'no upcharge, no line');
});

test('nothing anywhere still says "Horizontal Lap"', () => {
  /* The name was in the engine, in the analytics chart and on the designer's
     own siding button. Fixing one and leaving the others is how a customer
     ends up seeing two names for the same product. The designer lives in the
     other repo, so this guards the files here. */
  const files = readdirSync(REPO)
    .filter(f => /\.(html|js|mjs|json|md)$/.test(f))
    .concat(readdirSync(join(REPO, 'worker'))
      .filter(f => /\.(js|mjs)$/.test(f) && f !== 'itemnames.test.mjs')
      .map(f => join('worker', f)));
  const hits = [];
  for (const f of files) {
    const txt = readFileSync(join(REPO, f), 'utf8');
    if (/Horizontal Lap/.test(txt)) hits.push(f);
  }
  assert.deepEqual(hits, [], `still says "Horizontal Lap": ${hits.join(', ')}`);
});

// ── THE NAMES ARE ALSO COMP KEYS ─────────────────────────────────────────

test('a comp on a window still matches after the rename', async () => {
  /* compItemsFromRedline (worker) offers the picker its names, and
     compItemPrices (quote.html) looks the chosen name back up. Both read the
     SAME stored redline, which is the only reason renaming a label is safe:
     an old quote keeps its old labels on both sides, a new one gets new
     labels on both sides, and neither can half-rename. If one of those two
     ever stops deriving from the redline, a comped window would silently go
     back to being charged. */
  const html = readFileSync(join(REPO, 'quote.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'quote.html has an inline script');
  const { redline } = computePricing({
    style: 'gable', w: 10, l: 16, h: 9, siding: 'horizontal',
    windows: [{ wall: 'left', pos: 0.3, w: 36, h: 36, cy: 52, type: 'Black Vinyl 36x36' }]
  });

  const vm = await import('node:vm');
  const el = { innerHTML: '', textContent: '', className: '', style: {},
               appendChild() {}, setAttribute() {}, querySelector() { return null },
               querySelectorAll() { return [] } };
  const ctx = { console, URLSearchParams,
    localStorage: { getItem: () => 't', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/quote.html' },
    document: { getElementById: () => el, createElement: () => Object.create(el),
                querySelector: () => el, querySelectorAll: () => [], addEventListener() {} },
    fetch: () => new Promise(() => {}), setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script[1], ctx, { filename: 'quote.html' });

  const prices = ctx.compItemPrices(redline);
  const names = ctx.nameList(redline, 'shed');
  for (const want of ['Black Vinyl Window 36x36', 'Horizontal Siding']) {
    assert.ok(prices[want] > 0, `"${want}" is comp-able at a price`);
    assert.ok(names.indexOf(want) !== -1, `"${want}" is in the shed's name list`);
  }
});
