/* THE GENERATED COPY MUST NOT GO STALE.
 *
 * quote.html loads quotelines.browser.js; the worker imports quotelines.js.
 * They are the same code by construction — the browser file is generated from
 * the module — but only as long as someone remembers to regenerate it.
 *
 * Forget once, and the failure is the worst shape available: the worker bills
 * one number and the quote the customer is looking at shows another, with
 * every test still green because each half is internally consistent. So this
 * regenerates in memory and compares. It writes nothing.
 *
 * Run: node --test worker/quotelines.sync.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, EXPORTED } from './build-quotelines-browser.mjs';
import * as mod from './quotelines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'quotelines.js');
const OUT = path.join(HERE, '..', 'quotelines.browser.js');
const PAGE = path.join(HERE, '..', 'quote.html');

test('quotelines.browser.js is what the builder would write right now', () => {
  const onDisk = fs.readFileSync(OUT, 'utf8');
  const fresh = generate(fs.readFileSync(SRC, 'utf8'));
  assert.equal(onDisk, fresh,
    'quotelines.browser.js is stale — run: node worker/build-quotelines-browser.mjs');
});

test('everything the module exports reaches the browser global', () => {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(OUT, 'utf8'), ctx, { filename: 'quotelines.browser.js' });
  for (const name of Object.keys(mod)) {
    assert.ok(EXPORTED.includes(name),
      `${name} is exported from quotelines.js but missing from EXPORTED in the builder`);
    assert.notEqual(ctx[name], undefined, `${name} never reached the browser global`);
  }
});

test('the page actually loads it, before its own script', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const tag = html.indexOf('<script src="quotelines.browser.js"></script>');
  const inline = html.indexOf('<script>');
  assert.ok(tag > -1, 'quote.html does not load quotelines.browser.js');
  assert.ok(tag < inline,
    'it must load BEFORE the inline script, which calls quoteLines at render time');
});

test('the page keeps no second copy of the math', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  for (const gone of ['function taxBreakdown(redline) {\n  if (!redline',
                      'var TAX_RATE =', 'var DEPOSIT_RATE =',
                      'function compItemPrices', 'function nameList',
                      'function removalTotal', 'function compedIn']) {
    assert.ok(!html.includes(gone), `quote.html still declares its own ${gone.trim()}`);
  }
});
