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
import { assemble, build, MODULES } from './build-bundle.mjs';
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

/* Running the builder for real once wrote a good bundle and THEN threw, on the
   line that logs what it wrote. Nothing caught it: every test above calls
   assemble(), and the write lived inside the `is this the main module` guard
   where no test could reach it. A build that prints a stack trace but leaves a
   correct file on disk is the worst of both — it looks broken and isn't, so
   the fix does not get pasted. build() exists to be reachable; this runs it.

   Into a temp directory, never worker/dist: that file holds whatever was last
   pasted into Cloudflare, and overwriting it here would destroy the only
   record of what is actually running. */
test('the builder writes a bundle without falling over', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-build-'));
  try {
    const res = build(out);
    assert.equal(res.outPath, path.join(out, 'index.bundle.js'));
    assert.ok(res.lines > 100, 'suspiciously short bundle: ' + res.lines + ' lines');
    assert.ok(res.stamp && res.stamp.length, 'no build stamp');
    execFileSync(process.execPath, ['--check', res.outPath]);
    assert.equal(fs.readFileSync(res.outPath, 'utf8').split('\n').length, res.lines);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

/* ── TWO FILES MAY NOT SHARE A NAME ──────────────────────────────────────────
   The single most repeated failure in this worker: PAYMENT_METHODS, usd, pad2
   and FOUNDATION have all collided. Everything is inlined into one top-level
   scope, so a name in two files is one name.

   Two consts collide loudly — the bundle is a SyntaxError and the worker will
   not start. A duplicate `function` or `var` does NOT throw: the second
   silently replaces the first, the bundle parses, the worker starts, and
   something far away quietly uses the wrong one. That is the case worth a
   guard, and it is the case `node --check` cannot see. */
test('the builder refuses a bundle where two files declare the same name', async () => {
  const { assemble } = await import('./build-bundle.mjs');
  const fsp = await import('node:fs');
  const p = await import('node:path');
  const dir = p.dirname(fileURLToPath(import.meta.url));

  const spec = p.join(dir, 'buildspec.js');
  const original = fsp.readFileSync(spec, 'utf8');
  try {
    /* The FOUNDATION collision exactly as it happened: a const in a module
       against a name pricing.js declares FOUR LINES into a wrapped `let` list.
       A line-anchored grep says that name is free, which is why it got in. */
    fsp.writeFileSync(spec, original.replace('const SPEC_FOUNDATION = {', 'const FOUNDATION = {'));
    assert.throws(() => assemble(), /same top-level name[\s\S]*FOUNDATION/,
      'a collision with a name declared mid-list went through');

    /* And a duplicate FUNCTION, which is legal JavaScript and parses fine. */
    fsp.writeFileSync(spec, original + '\nexport function configSummary(c){ return "oops"; }\n');
    assert.throws(() => assemble(), /same top-level name[\s\S]*configSummary/,
      'a silently-shadowing duplicate function went through');
  } finally {
    fsp.writeFileSync(spec, original);
  }
  // And the real sources still build.
  assert.ok(assemble().length > 1000);
});
