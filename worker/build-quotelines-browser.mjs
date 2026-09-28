/* Builds quotelines.browser.js from worker/quotelines.js.
 *
 * The worker imports quotelines.js as an ES module. quote.html cannot: its
 * inline <script> is a classic script, and every function it declares has to
 * stay global — the page's own onclick handlers reach them, and
 * worker/quotepage.test.mjs runs that script in a VM and calls them off the
 * context. Converting it to type="module" would take all of that away.
 *
 * So the browser gets a generated copy with the `export` keywords stripped and
 * the names hung on the global, exactly the way worker/dist/index.bundle.js is
 * a generated copy of the worker. One source of truth, two shapes.
 *
 * quotelines.sync.test.mjs fails if the generated file is stale, so a change
 * to the module that never gets rebuilt cannot reach a customer's quote.
 *
 *   node worker/build-quotelines-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(dir, 'quotelines.js');
const OUT = path.join(dir, '..', 'quotelines.browser.js');

export const EXPORTED = ['TAX_RATE', 'DEPOSIT_RATE', 'BASE_SHED_INCLUDES',
  'REMOVAL_NAMES', 'compItemPrices', 'compedMap', 'nameList', 'quoteLines'];

export function generate(source) {
  const body = source.replace(/^export /gm, '');
  const names = EXPORTED.map((n) => `  root.${n} = ${n};`).join('\n');
  return `/* GENERATED FROM worker/quotelines.js — DO NOT EDIT.
   Rebuild with: node worker/build-quotelines-browser.mjs
   The comments below are the module's own; this file is the same code with its
   export keywords stripped and its names hung on the global for quote.html. */
(function (root) {
'use strict';

${body}
${names}
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = generate(fs.readFileSync(SRC, 'utf8'));
  fs.writeFileSync(OUT, out);
  console.log(`Wrote ${OUT} (${out.split('\n').length} lines)`);
}
