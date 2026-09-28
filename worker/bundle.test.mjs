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

function modules() {
  const src = fs.readFileSync(path.join(HERE, 'build-bundle.mjs'), 'utf8');
  const m = src.match(/const MODULES = \[([^\]]*)\]/);
  assert.ok(m, 'build-bundle.mjs still declares MODULES');
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

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

test('the committed bundle is valid JavaScript', () => {
  assert.ok(fs.existsSync(BUNDLE), 'dist/index.bundle.js is missing');
  execFileSync(process.execPath, ['--check', BUNDLE]);   // throws on a syntax error
});

test('the bundle carries every module, and no import statements survive', () => {
  const out = fs.readFileSync(BUNDLE, 'utf8');
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
