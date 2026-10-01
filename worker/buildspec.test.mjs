/* WHAT TO BUILD, ON THE INVITE.
 *
 * The install invite carried one line — "12x20 ft · gable · board-batten" —
 * which says where to go and nothing about what to make. It carries the spec
 * now, and the thing that makes that safe is what is NOT on it: the customer
 * is a guest on every on-site day, the description is the same for everyone on
 * the event, and a calendar invite is the easiest thing in the world to
 * forward. No prices. That is the first test here and the one that matters.
 *
 * Run: node --test worker/buildspec.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecLines, designLinkFor } from './buildspec.js';
import { installDetails, DETAILS_MAX } from './calendar.js';

const LOADED = {
  style: 'barn', w: 12, l: 20, h: 10, pitch: 6, siding: 'board-batten', roofType: 'shingle',
  foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted', floor: 'better',
  elec: 'essential', loft: '6-front', porchLoc: 'front', porchDepth: 6, porchDeck: 'composite',
  doors: [{ wall: 'front', w: 36, style: 'fairytale' },
          { wall: 'right', w: 96, style: 'rollup', color: 'brown' }],
  windows: [{ wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' },
            { wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' },
            { wall: 'back', w: 72, h: 42, type: 'Black Lift-Up Bar 72x42' }],
  vents: [{ wall: 'front' }], shelves: [{ wall: 'back', len: 12, depth: 24 }],
  addons: { shedRemoval: true }
};
const text = (c) => buildSpecLines(c).join('\n');

test('NO PRICES, anywhere, ever', () => {
  /* The customer is on this invite and so is anyone they forward it to. */
  const out = text(LOADED);
  assert.ok(!/\$/.test(out), `a dollar sign reached the invite: ${out}`);
  assert.ok(!/\b\d{3,}(\.\d\d)?\b(?!\s*x)/.test(out.replace(/\d+x\d+/g, '')),
    `something price-shaped reached the invite: ${out}`);
  for (const word of ['price', 'total', 'deposit', 'quote', 'margin', 'cost']) {
    assert.ok(!new RegExp(word, 'i').test(out), `"${word}" reached the invite`);
  }
  // And it is not empty — "no prices" is trivially true of nothing.
  assert.ok(buildSpecLines(LOADED).length >= 10, buildSpecLines(LOADED));
});

test('the shell line says the things you cannot see from the others', () => {
  const lines = buildSpecLines(LOADED);
  assert.equal(lines[0], '12x20 ft · barn · 10ft walls · 6/12 pitch');
  // Wall height and pitch are the two a crew cannot infer and the old one-line
  // summary left out entirely.
  assert.match(lines[0], /10ft walls/);
  assert.match(lines[0], /6\/12 pitch/);
});

test('every opening is named the way the quote names it', () => {
  const out = text(LOADED);
  /* Through doorDisplayName / windowDisplayName, so the shop and the customer
     read the same words for the same product. A second label table here would
     drift the first time something was renamed. */
  assert.match(out, /Fairytale Entry \(front\)/);
  assert.match(out, /8' Roll-Up Garage Door · Brown \(right\)/);
  assert.match(out, /Black Lift-Up Bar Window 72x42 \(back\)/);
});

test('the door colour comes along — a brown roll-up is not a white one', () => {
  assert.match(text(LOADED), /Roll-Up Garage Door · Brown/);
  // And a door at its default colour is not labelled, or every line carries noise.
  assert.ok(!/Fairytale Entry ·/.test(text(LOADED)), text(LOADED));
});

test('identical items are grouped, not listed one by one', () => {
  // Six identical windows listed six times is a wall of text nobody finishes.
  assert.match(text(LOADED), /2 × Black Vinyl Window 24x36 \(left\)/);
  const six = Object.assign({}, LOADED, {
    windows: Array.from({ length: 6 }, () => ({ wall: 'back', w: 24, h: 36, type: 'Black Vinyl 24x36' }))
  });
  assert.match(text(six), /6 × Black Vinyl Window 24x36 \(back\)/);
  assert.equal((text(six).match(/Black Vinyl Window/g) || []).length, 1);
});

test('the siding is not named twice', () => {
  // sidingDisplayName already ends in "Siding".
  assert.match(text(LOADED), /Siding: Board & Batten$/m);
  assert.ok(!/Siding: .*Siding/.test(text(LOADED)), text(LOADED));
});

test('a plain shed is short, and nothing prints as "none"', () => {
  const plain = { style: 'gable', w: 10, l: 16, h: 9 };
  const lines = buildSpecLines(plain);
  assert.equal(lines.length, 1, lines);
  assert.equal(lines[0], '10x16 ft · gable · 9ft walls');
  // Empty selections drop out rather than printing their own absence.
  const nones = { style: 'gable', w: 10, l: 16, h: 9, porchLoc: 'none', loft: 'none',
                  intFinish: 'none', floor: 'none', elec: 'none', doors: [], windows: [],
                  vents: [], shelves: [], addons: {} };
  assert.deepEqual(buildSpecLines(nones), lines);
  for (const bad of [null, undefined, 'nope', 42, []]) assert.deepEqual(buildSpecLines(bad), []);
});

test('the design link is the short code, or nothing at all', () => {
  assert.equal(designLinkFor({ permalink: 'https://shedpro-utah.com/designer.html?d=a1b2c3d4' }),
    'https://www.shedpro-utah.com/designer.html?d=a1b2c3d4');
  /* A permalink can also carry the WHOLE config base64'd into the fragment —
     thousands of characters. This is going into the query string of a Google
     Calendar link, so that one is dropped rather than carried: a truncated URL
     takes the description down with it. */
  assert.equal(designLinkFor({ permalink: 'https://x/designer.html#d=' + 'A'.repeat(3000) }), '');
  assert.equal(designLinkFor({ permalink: '' }), '');
  assert.equal(designLinkFor(null), '');
  // The old renamed page is not reused — the payload is, on the current URL.
  assert.match(designLinkFor({ permalink: 'https://x/designer%203.html?d=beefcafe' }),
    /www\.shedpro-utah\.com\/designer\.html\?d=beefcafe$/);
});

test('the spec replaces the one-line summary rather than repeating it', () => {
  const out = installDetails({ summary: '12x20 ft · barn · board-batten',
                               spec: buildSpecLines(LOADED), orderId: 318 });
  assert.equal((out.match(/12x20 ft/g) || []).length, 1, out);
  // With no spec, the summary is still what you get.
  assert.match(installDetails({ summary: 'X · Y', orderId: 1 }), /^X · Y\n/);
});

test('the 3D link goes last, under the note', () => {
  const out = installDetails({ spec: buildSpecLines(LOADED), note: 'Gate code 4417.',
                               designUrl: 'https://x/designer.html?d=a1b2c3d4', orderId: 318 });
  const lines = out.split('\n');
  assert.match(lines[lines.length - 1], /^3D build: https:/);
  assert.ok(out.indexOf('Note: Gate code') < out.indexOf('3D build:'), out);
});

test('an overlong description is cut by whole lines, and keeps the link', () => {
  /* It goes into a URL's query string, where every newline costs three
     characters encoded. The failure mode without a cap is silent truncation
     by the browser — the link opens, the event saves, and the back half of
     the spec is simply gone. */
  const out = installDetails({
    spec: buildSpecLines(LOADED), orderId: 318,
    note: 'x'.repeat(4000),
    designUrl: 'https://x/designer.html?d=a1b2c3d4'
  });
  assert.ok(out.length <= DETAILS_MAX, `${out.length} > ${DETAILS_MAX}`);
  // The link survives — a truncated URL is worse than no URL.
  assert.match(out, /\n3D build: https:\/\/x\/designer\.html\?d=a1b2c3d4$/);
  // Cut at a line break, not mid-word, and it says it was cut.
  assert.match(out, /…/);
  assert.ok(!/xxxx…/.test(out), 'cut mid-line');
  // A normal build is nowhere near the cap and comes back untouched.
  const normal = installDetails({ spec: buildSpecLines(LOADED), orderId: 318, note: 'Gate code 4417.' });
  assert.ok(normal.length < DETAILS_MAX);
  assert.ok(!/…/.test(normal), normal);
});
