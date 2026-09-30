/* THE CEDAR SINGLE'S PRICE, and the ladder it must not fall into.
 *
 * sellDoorName buckets every cedar door by width, and before the single
 * existed EVERY cedar door — any width at all — came back as a Double: a 36in
 * cedar priced as a 5' Cedar Double at $700. Nothing errors when that happens.
 * The quote just says "5' Cedar Double" next to a door that plainly is not
 * one, and the number is wrong by whatever the two products differ by.
 *
 * So the single is its own style id, and these tests hold the two ladders
 * apart at both ends:
 *
 *   1. Each cedarSingle width names a Cedar SINGLE and carries a real price.
 *   2. Each cedar width still names the Double it always did — the ladder was
 *      not shifted by inserting a branch above it.
 *   3. No width reachable from either catalogue tile prices at $0. A missing
 *      SELL.doors key does not throw; sellDoorUpcharge returns 0 and the door
 *      is quietly free, which is the failure mode worth a test.
 *   4. Every DOOR_PRICE_ENTRIES pair resolves to a key the table actually has,
 *      so the client's optionPrices map never hands a tile a zero either.
 *
 * Run: node --test worker/cedardoor.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { doorDisplayName, sellDoorUpcharge, SELL } from './pricing.js';

/* index.js's DOOR_PRICE_ENTRIES, read from source. It is a plain literal and
   importing index.js would drag in the whole worker, so it is parsed. If the
   parse ever stops matching the literal's shape the count check below fails
   loudly, rather than every test passing over an empty list. */
function priceEntries() {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const block = src.split('const DOOR_PRICE_ENTRIES = [')[1].split('];')[0];
  const pairs = [...block.matchAll(/\["([a-zA-Z0-9]+)",\s*(\d+)\]/g)].map((m) => [m[1], +m[2]]);
  assert.ok(pairs.length > 20, `only found ${pairs.length} door price entries — the parse is wrong`);
  assert.ok(pairs.some(([s]) => s === 'cedarSingle'), 'cedarSingle is missing from DOOR_PRICE_ENTRIES');
  return pairs;
}

// The widths the designer's Cedar Single / Cedar Double tiles actually offer.
const SINGLES = [[36, "3' Cedar Single"], [42, "3'6\" Cedar Single"]];
const DOUBLES = [[60, "5' Cedar Double"], [72, "6' Cedar Double"],
                 [84, "7' Cedar Double"], [96, "8' Cedar Double"]];

test('each cedar single width names a Single, and is priced', () => {
  for (const [w, name] of SINGLES) {
    assert.equal(doorDisplayName({ style: 'cedarSingle', w }), name, `cedarSingle @${w}"`);
    assert.ok(SELL.doors[name] > 0, `${name} has no price in SELL.doors`);
    assert.equal(sellDoorUpcharge({ style: 'cedarSingle', w }), SELL.doors[name]);
  }
});

test('the double ladder is untouched by the branch above it', () => {
  for (const [w, name] of DOUBLES) {
    assert.equal(doorDisplayName({ style: 'cedar', w }), name, `cedar @${w}"`);
    assert.ok(sellDoorUpcharge({ style: 'cedar', w }) > 0, `${name} priced at 0`);
  }
});

test('a cedar single never falls into the double ladder', () => {
  for (const [w] of SINGLES) {
    assert.ok(!/Double/.test(doorDisplayName({ style: 'cedarSingle', w })),
      `a ${w}" cedar single is being named a Double`);
  }
  // And the reverse: the single branch must not swallow a double. The narrowest
  // double the catalogue offers is 60"; anything at or above it stays a double.
  assert.ok(/Double/.test(doorDisplayName({ style: 'cedar', w: 60 })));
});

/* The designer's catalogue and index.js's DOOR_PRICE_ENTRIES are two hand-kept
   lists in two repositories, so nothing can check them against each other here.
   What CAN be checked is that every pair index.js lists resolves to something
   real on this side.

   "Resolves" means the same chain sellDoorUpcharge walks: the exact key, then
   the 4-panel naming variant, then the plain-door base. Not "costs more than
   zero" — several plain doors are deliberately $0 because they are the door
   the shed already includes, so a price assertion would fail on those and
   still miss the case below, which is the one that matters. */
test('every DOOR_PRICE_ENTRIES pair resolves to a name SELL.doors holds', () => {
  const has = (k) => Object.prototype.hasOwnProperty.call(SELL.doors, k);
  for (const [style, w] of priceEntries()) {
    // doorDisplayName renames the roll-ups on the way out; the key is the
    // table's own spelling, which is what has to be looked up here.
    const key = doorDisplayName({ style, w }).replace(/Roll-Up Garage Door$/, 'Roll Up');
    const base = key.replace(/ \((?:X-Trim|Arch Trim|4 Panel)\)$| Craftsman$/, '');
    assert.ok(has(key) || has(base + ' (4-Panel)') || has(base),
      `${style}@${w} resolves to "${key}", which SELL.doors has no entry for — `
      + 'not even a plain-door fallback');
  }
});

/* A MISSPELLED STYLE ID DOES NOT THROW. sellDoorName ends in a width ladder,
   so "cedarSingel" at 36in comes back "3' Single" — a name the table holds, at
   the plain door's price, on a quote line that says the wrong product. Every
   check above is satisfied by that; only this one isn't.
   The rule that catches it: 'basic' IS the plain door, and every other style
   is something else, so every other style must name itself differently at the
   same width. Nothing but a style id the branches don't recognise can make a
   styled entry and the plain entry agree. */
test('no DOOR_PRICE_ENTRIES style silently degrades to the plain door', () => {
  for (const [style, w] of priceEntries()) {
    if (style === 'basic') continue;
    assert.notEqual(doorDisplayName({ style, w }), doorDisplayName({ style: 'basic', w }),
      `"${style}" is not recognised by sellDoorName — it fell through to the plain `
      + `${w}" door's name and price. Check the spelling against pricing.js.`);
  }
});

/* The cedar single is new, so unlike the plain doors it has no included-door
   reason to be free. Both of its widths must carry a price of their own. */
test('neither cedar single falls through to a $0 fallback', () => {
  for (const [w, name] of SINGLES) {
    assert.ok(Object.prototype.hasOwnProperty.call(SELL.doors, name),
      `SELL.doors has no "${name}" entry, so the door would quote as free`);
    assert.ok(sellDoorUpcharge({ style: 'cedarSingle', w }) > 0);
  }
});
