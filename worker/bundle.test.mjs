/* THE BUNDLE HAS TO PARSE, AND NO TWO MODULES MAY CLAIM THE SAME NAME.
 *
 * worker/dist/index.bundle.js is what gets pasted into the Cloudflare
 * dashboard. The bundler inlines every module at TOP LEVEL, so two files
 * declaring the same const is not a subtle bug — it is a SyntaxError, and the
 * worker does not start. Not the feature: the worker. Every endpoint, for
 * everyone, until someone pastes a fixed build.
 *
 * This nearly happened: stripe.js exported PAYMENT_METHODS and index.js has
 * had a constant by that name for the ways a human records a payment. Node
 * runs both files happily in isolation, every unit test passes, and it only
 * falls over once concatenated.
 *
 * Run: node --test worker/bundle.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { assemble, MODULES } from './build-bundle.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, 'dist', 'index.bundle.js');

/* Top-level declarations only: anything indented is inside a function and
   cannot collide. */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

function topLevelNames(file) {
  const out = new Map();
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const m = DECL.exec(line);
    if (m) out.set(m[1], i + 1);
  });
  return out;
}

const modules = () => MODULES;

test('no two bundled files declare the same top-level name', () => {
  const files = ['index.js', ...modules()];
  const seen = new Map();
  const clashes = [];
  for (const f of files) {
    for (const [name, line] of topLevelNames(path.join(HERE, f))) {
      if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${f}:${line}`);
      else seen.set(name, `${f}:${line}`);
    }
  }
  assert.deepEqual(clashes, [],
    'these would be duplicate declarations once concatenated, and the worker would not start');
});

test('every module the worker imports is in MODULES', () => {
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const imported = [...src.matchAll(/from\s+["']\.\/([\w.-]+)["']/g)].map((m) => m[1]);
  const listed = modules();
  for (const f of imported) {
    assert.ok(listed.includes(f),
      `index.js imports ./${f} but build-bundle.mjs does not inline it — the bundle would ` +
      `reference a module that does not exist in the dashboard`);
  }
});

/* dist/ holds whatever was last PASTED into Cloudflare, which is what /version
   reports. It is deliberately not rebuilt on every commit — that would lose the
   only record of what is actually running. So the committed file is checked for
   being valid, and everything about the CURRENT sources is checked against a
   bundle assembled in memory. */
test('the committed bundle — whatever is deployed — is valid JavaScript', () => {
  assert.ok(fs.existsSync(BUNDLE), 'dist/index.bundle.js is missing');
  execFileSync(process.execPath, ['--check', BUNDLE]);
});

test('a bundle built from the sources as they stand now parses', () => {
  const tmp = path.join(os.tmpdir(), 'bundle-check-' + process.pid + '.js');
  fs.writeFileSync(tmp, assemble());
  try { execFileSync(process.execPath, ['--check', tmp]); }
  finally { fs.unlinkSync(tmp); }
});

test('that bundle carries every module, and no import statements survive', () => {
  const out = assemble();
  for (const f of modules()) {
    assert.ok(!new RegExp(`from ["']\\./${f.replace('.', '\\.')}["']`).test(out),
      `the bundle still imports ./${f} — the dashboard has no such file`);
  }
  /* A marker from each module, so "inlined" means the code is actually there
     rather than the import merely having been deleted. */
  assert.match(out, /function quoteLines/, 'quotelines.js is not in the bundle');
  assert.match(out, /function buildInvoice/, 'invoices.js is not in the bundle');
  assert.match(out, /function createAndSendInvoice/, 'stripe.js is not in the bundle');
});
