/* End to end: a quote sent before the split, fetched through the real worker
 * endpoint the quote document reads, comes back on current pricing — and the
 * row in D1 is untouched.
 *
 * Run: node --test worker/repriceendpoint.test.mjs
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

/* 12x18, 8ft walls — 463 sqft of wall charged at the old $7, no laborSell. */
const LEGACY_DETAILS = {
  config: { w: 12, l: 18, h: 8, siding: 'board-batten', style: 'gable' },
  quotedPrice: 17000,
  redline: {
    marginPrice: 8000,
    paintSell: 3238, paintSellName: 'Exterior Paint (463 sqft)',
    sidingSell: 1600, sidingSellName: 'Board & Batten',
    elecSell: 3000, elecSellName: 'Essential Electrical',
    baseSheetLabel: 'Gable'
  }
};

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT INTO customers (id, name, email, created_at, updated_at)
              VALUES (1, 'Test Customer', 'test@example.com', '2026-01-01', '2026-01-01')`).run();
  db.prepare(`INSERT INTO submissions (id, customer_id, name, email, details, status, created_at)
              VALUES (1, 1, 'Test Customer', 'test@example.com', ?, 'quoted', '2026-01-01')`)
    .run(JSON.stringify(LEGACY_DETAILS));
  const env = {
    DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')),
    ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k'
  };
  return { db, env };
}

const ORIGIN = 'https://shedpro-utah.com';

async function login(env) {
  const r = await worker.fetch(new Request('https://x/admin/login', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' })
  }), env);
  return (await r.json()).token;
}

/* The same endpoint quote.html reads, with the token it sends. */
async function getSubmission(env, token) {
  const tok = token || await login(env);
  return await worker.fetch(new Request('https://x/admin/submissions/1', {
    headers: { Origin: ORIGIN, Authorization: 'Bearer ' + tok }
  }), env);
}

test('the quote endpoint serves the finish on current pricing', async () => {
  const { env } = setup();
  const res = await getSubmission(env);
  assert.equal(res.status, 200, 'the submission is readable');
  const body = await res.json();
  const details = JSON.parse(body.submission.details);

  assert.equal(details.redline.paintSell, 1400, 'paint is the flat fee now');
  assert.equal(details.redline.paintSellName, 'Exterior Paint', 'and no longer names a wall area');
  assert.equal(Math.round(details.redline.laborSell), Math.round(7.75 * 216),
    'labor is charged on the 216 sqft of shed');
  assert.equal(details.redline.laborSellName, 'Build Labor (216 sqft)');
});

test('the quoted total moves by exactly the finish delta', async () => {
  const { env } = setup();
  const body = await (await getSubmission(env)).json();
  const details = JSON.parse(body.submission.details);
  const delta = (1400 + 7.75 * 216) - 3238;
  assert.equal(Math.round(details.quotedPrice), Math.round(17000 + delta));
});

test('everything else the customer was quoted survives untouched', async () => {
  const { env } = setup();
  const body = await (await getSubmission(env)).json();
  const r = JSON.parse(body.submission.details).redline;
  assert.equal(r.marginPrice, 8000);
  assert.equal(r.sidingSell, 1600);
  assert.equal(r.elecSell, 3000);
  assert.equal(r.baseSheetLabel, 'Gable');
});

test('the electrical backfill still runs alongside it', async () => {
  const { env } = setup();
  const body = await (await getSubmission(env)).json();
  const r = JSON.parse(body.submission.details).redline;
  assert.ok(Array.isArray(r.elecIncludes) && r.elecIncludes.length > 0,
    'Essential Electrical still itemises its contents');
});

/* The point of doing this on read rather than as a migration. */
test('the stored row in D1 is not rewritten', async () => {
  const { db, env } = setup();
  await getSubmission(env);
  const row = db.prepare('SELECT details FROM submissions WHERE id = 1').get();
  const stored = JSON.parse(row.details);
  assert.equal(stored.redline.paintSell, 3238, 'the record still holds what was quoted');
  assert.equal(stored.redline.laborSell, undefined);
  assert.equal(stored.quotedPrice, 17000);
});

test('reading twice does not apply the change twice', async () => {
  const { env } = setup();
  const a = JSON.parse((await (await getSubmission(env)).json()).submission.details);
  const b = JSON.parse((await (await getSubmission(env)).json()).submission.details);
  assert.equal(a.quotedPrice, b.quotedPrice, 'the delta is not compounding');
  assert.equal(a.redline.paintSell, b.redline.paintSell);
});

test('the admin list shows the same total as the quote document', async () => {
  const { env } = setup();
  const tok = await login(env);
  const list = await (await worker.fetch(new Request('https://x/admin/customers', {
    headers: { Origin: ORIGIN, Authorization: 'Bearer ' + tok }
  }), env)).json();

  const quote = JSON.parse((await (await getSubmission(env)).json()).submission.details);
  const row = (list.customers || []).find(c => c.id === 1);
  assert.ok(row, 'the customer is listed');
  assert.equal(Math.round(row.latest_quoted_price), Math.round(quote.quotedPrice),
    'list and quote must not disagree about the price');
});
