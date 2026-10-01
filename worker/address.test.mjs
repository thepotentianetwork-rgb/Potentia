/* AN ADDRESS YOU CAN POST SOMETHING TO.
 *
 * Four places composed one by hand and no two agreed. Three dropped the ZIP —
 * including the location on the Google Calendar invite, which is the address a
 * crew types into a phone on the morning of an install. The fourth kept it and
 * wrote "Riverton, UT, 84065".
 *
 * The comma before the ZIP is the interesting failure. It is what every
 * hand-rolled [city, state, zip].join(', ') produces, it looks fine in a code
 * review, and it is wrong on every piece of mail and every delivery label.
 *
 * Run: node --test worker/address.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityStateZip, fullAddress } from './address.js';

const FULL = { address: '11999 South Lampton View Drive', city: 'Riverton', state: 'UT', zip: '84065' };

test('a complete address reads the way an address is written', () => {
  assert.equal(fullAddress(FULL), '11999 South Lampton View Drive, Riverton, UT 84065');
  assert.equal(cityStateZip(FULL), 'Riverton, UT 84065');
});

test('a SPACE before the ZIP, never a comma', () => {
  /* The whole reason this is a function. */
  const out = fullAddress(FULL);
  assert.ok(/UT 84065$/.test(out), out);
  assert.ok(!/,\s*84065/.test(out), `"${out}" punctuates the ZIP as a list item`);
  // And a comma IS still right between the city and the state.
  assert.ok(/Riverton, UT/.test(out), out);
});

test('the ZIP actually survives', () => {
  // The failure that shipped: three of the four call sites simply left it out,
  // and an address line with no ZIP looks complete.
  assert.ok(fullAddress(FULL).includes('84065'));
  assert.ok(cityStateZip(FULL).includes('84065'));
});

test('missing parts fall out without leaving their punctuation behind', () => {
  // Most rows have a city and a state and nothing else.
  assert.equal(cityStateZip({ city: 'Riverton', state: 'UT' }), 'Riverton, UT');
  assert.equal(fullAddress({ city: 'Riverton', state: 'UT' }), 'Riverton, UT');
  assert.equal(cityStateZip({ city: 'Riverton' }), 'Riverton');
  assert.equal(cityStateZip({ state: 'UT', zip: '84065' }), 'UT 84065');
  /* No state but a ZIP. The comma has to stay with the city, or this comes
     out "Riverton 84065" — which reads as a street number. */
  assert.equal(cityStateZip({ city: 'Riverton', zip: '84065' }), 'Riverton, 84065');
  assert.equal(fullAddress({ address: '11999 S Lampton View Dr' }), '11999 S Lampton View Dr');
});

test('nothing at all is an empty string, not punctuation', () => {
  for (const empty of [{}, null, undefined, { city: '', state: '', zip: '' },
                       { address: '   ', city: '  ' }]) {
    assert.equal(fullAddress(empty), '', JSON.stringify(empty));
    assert.equal(cityStateZip(empty), '', JSON.stringify(empty));
  }
});

test('whitespace and non-strings do not reach the output', () => {
  assert.equal(cityStateZip({ city: '  Riverton ', state: ' UT', zip: ' 84065 ' }), 'Riverton, UT 84065');
  // A ZIP that arrived as a number from JSON still prints.
  assert.equal(cityStateZip({ city: 'Riverton', state: 'UT', zip: 84065 }), 'Riverton, UT 84065');
});

/* ── AND NOBODY ROLLS THEIR OWN ─────────────────────────────────────────────
   This is the half that matters. The formatter being right says nothing about
   whether the four places that need it use it — three of them had been
   dropping the ZIP for as long as they had existed, each with its own little
   [city, state].join(', '). The page files cannot import this module (they are
   static HTML served by Vercel, with no bundler), so what is checked is that
   none of them has gone back to composing a locality line with a comma where
   the space belongs. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no page writes "state, zip"', () => {
  const pages = readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f));
  assert.ok(pages.length > 5, `only found ${pages.length} pages to check`);
  for (const f of pages) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    /* The exact shape that produces "Riverton, UT, 84065": state and zip as
       two items of one comma-joined list. */
    const bad = /\.state\s*,\s*\w*\.?zip\b[^)]*\)\s*\.join\(\s*['"],\s*['"]/.exec(src);
    assert.equal(bad, null, `${f} joins the state and the ZIP with a comma: ${bad && bad[0]}`);
  }
});

test('the CRM customer page reads the ZIP it is already sent', () => {
  /* The endpoint selects * from customers, so the ZIP has been on this
     payload all along — the page simply never read it, and showed a location
     you could not post anything to. Checked at the source because the line is
     inside a fetch callback on a page that needs a logged-in session and a
     real customer id to reach. */
  const src = readFileSync(path.join(ROOT, 'admin-customer.html'), 'utf8');
  const loc = /var loc\s*=\s*(.+)/.exec(src);
  assert.ok(loc, 'the location line has moved or been renamed');
  assert.ok(/\bc\.zip\b/.test(loc[1]),
    'the customer page builds its location without the ZIP: ' + loc[1].trim());
  assert.ok(/\bc\.city\b/.test(loc[1]) && /\bc\.state\b/.test(loc[1]), loc[1].trim());
});

test('the worker composes every address through this module', () => {
  const idx = readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  /* Any surviving hand-rolled address line in the worker. These are the two
     that shipped without a ZIP: the calendar invite's location and the
     schedule's. */
  const handmade = [...idx.matchAll(/\[\s*\w+\.address\s*,[^\]]*\]\s*\.filter\(Boolean\)\s*\.join/g)];
  assert.equal(handmade.length, 0,
    `worker/index.js still builds ${handmade.length} address line(s) by hand: ` +
    handmade.map((m) => m[0]).join(' | '));
  assert.ok(/import \{ fullAddress \} from "\.\/address\.js"/.test(idx),
    'the worker does not import the formatter at all');
});
