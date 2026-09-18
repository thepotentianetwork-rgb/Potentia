/* The worker ships by pasting a bundle into the Cloudflare dashboard, so there
 * is no deploy log and no version number. Without a way to read the running
 * build from outside, a bundle that was never pasted is indistinguishable from
 * a bug in the code — which has cost real time chasing pricing that was already
 * correct in git but not yet live.
 *
 * Run: node --test worker/version.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeD1(db) {
  function shape(sql) {
    const st = db.prepare(sql);
    const sel = /^\s*(select|pragma)/i.test(sql);
    return a => ({
      first() { return sel ? (st.get(...a) ?? null) : (st.run(...a), null); },
      all() { return { results: st.all(...a) }; },
      run() {
        if (sel) return { results: st.all(...a) };
        const r = st.run(...a);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map(x => x.run()); }
  };
}

function env() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return {
    DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')),
    ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k'
  };
}

const ORIGIN = 'https://shedpro-utah.com';
const get = () => worker.fetch(new Request('https://x/version', { headers: { Origin: ORIGIN } }), env());

test('/version answers without a token — that is the point of it', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('build' in body, 'reports a build');
  assert.ok('builtAt' in body, 'reports when it was built');
});

test('run unbundled it says so rather than pretending to know', async () => {
  const body = await (await get()).json();
  assert.equal(body.build, 'unbundled',
    'index.js has no stamp until build-bundle.mjs writes one');
});

test('the built bundle carries a real stamp and serves it', async () => {
  const bundle = fs.readFileSync(path.join(here, 'dist', 'index.bundle.js'), 'utf8');
  const m = bundle.match(/^const WORKER_BUILD = "([^"]+)";$/m);
  assert.ok(m, 'the bundle is stamped');
  assert.notEqual(m[1], 'unbundled');
  assert.match(m[1], /^[0-9a-f]{7,}(-dirty)?$|^unknown$/, `odd build id: ${m[1]}`);

  const at = bundle.match(/^const WORKER_BUILT_AT = "([^"]+)";$/m);
  assert.ok(at, 'the bundle records its build time');
  assert.ok(!isNaN(Date.parse(at[1])), 'and it is a real timestamp');
});

test('it leaks nothing about the business', async () => {
  const body = await (await get()).json();
  assert.deepEqual(Object.keys(body).sort(), ['build', 'builtAt']);
});

test('the stamp sits above the code, so a partial paste cannot fake it', async () => {
  const bundle = fs.readFileSync(path.join(here, 'dist', 'index.bundle.js'), 'utf8');
  const stampAt = bundle.indexOf('const WORKER_BUILD =');
  const codeAt = bundle.indexOf('export default');
  assert.ok(stampAt > -1 && codeAt > -1);
  assert.ok(stampAt < codeAt, 'the stamp is at the top of the file');
});
