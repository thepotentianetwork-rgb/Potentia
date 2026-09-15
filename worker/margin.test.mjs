/* The staff margin lever.
 *
 * The margin target is the one number that moves the shed's base price, and
 * it is invisible to the customer by design — it lands inside marginPrice,
 * which the quote folds into the single "Shed" line.
 *
 * Two things have to hold at once:
 *   1. Staff can move it, and it SURVIVES the submit. It did not: the Worker
 *      re-priced every submission with no overrides, so the redline panel
 *      showed one price and the stored order kept another.
 *   2. Nobody else can move it. /shed/quote applied overrides BEFORE checking
 *      auth — the check only gated whether the redline came back — so an
 *      unauthenticated caller could post marginTarget:0 and be quoted well
 *      under the real price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePricing, clampMarginTarget, MARGIN_MIN, MARGIN_MAX } from './pricing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
      },
    });
  }
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map(x => x.run()); },
  };
}

async function harness() {
  const worker = (await import('./index.js')).default;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  const env = {
    DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')),
    ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k',
  };
  const login = await worker.fetch(new Request('https://x/admin/login', {
    method: 'POST',
    headers: { Origin: 'https://shedpro-utah.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  }), env);
  const { token } = await login.json();
  const H = ip => ({
    Origin: 'https://shedpro-utah.com', 'Content-Type': 'application/json',
    'CF-Connecting-IP': ip || '9.9.9.9',
  });
  return { worker, env, db, token, H };
}

const CONFIG = { style: 'gable', w: 10, l: 16, h: 9 };

test('the band is 30-70 and "unset" stays distinct from "set low"', () => {
  assert.equal(MARGIN_MIN, 30);
  assert.equal(MARGIN_MAX, 70);
  // Blank knob => not set. The designer sends null, and Number(null) is 0, so
  // clamping first would silently reprice every quote at the floor.
  for (const blank of [null, undefined, '']) assert.equal(clampMarginTarget(blank), null);
  assert.equal(clampMarginTarget('nonsense'), null);
  assert.equal(clampMarginTarget(10), 30, 'below the floor is pulled up');
  assert.equal(clampMarginTarget(700), 70, 'a fat-fingered 700 prices at 70, not 700');
  assert.equal(clampMarginTarget(55), 55);
});

test('margin moves the base price and nothing else', () => {
  const at = m => computePricing({ ...CONFIG }, { marginTarget: m });
  const lo = at(30), mid = at(42), hi = at(70);
  assert.ok(lo.customer < mid.customer && mid.customer < hi.customer, 'higher margin, higher price');

  // Everything outside the base must be untouched — the lever is the base price.
  for (const k of ['paintSell', 'heightSell', 'sidingSell', 'foundSell', 'intSell']) {
    assert.equal(lo.redline[k], hi.redline[k], `${k} must not move with margin`);
  }
  assert.equal(
    Math.round(hi.customer - lo.customer),
    Math.round(hi.redline.marginPrice - lo.redline.marginPrice),
    'the entire difference is the base price'
  );
});

test('an unauthenticated caller cannot move the price with overrides', async () => {
  const { worker, env, H } = await harness();
  const ask = async overrides => {
    const r = await worker.fetch(new Request('https://x/shed/quote', {
      method: 'POST', headers: H(), body: JSON.stringify({ config: CONFIG, overrides }),
    }), env);
    return (await r.json()).total;
  };
  const honest = await ask(undefined);
  for (const m of [0, 10, 30, 70, 90, 900]) {
    assert.equal(await ask({ marginTarget: m }), honest,
      `overrides.marginTarget=${m} must be ignored without a staff token`);
  }
});

test('a staff caller can move the price', async () => {
  const { worker, env, H, token } = await harness();
  const ask = async overrides => {
    const r = await worker.fetch(new Request('https://x/shed/quote', {
      method: 'POST',
      headers: { ...H(), Authorization: 'Bearer ' + token },
      body: JSON.stringify({ config: CONFIG, overrides }),
    }), env);
    return (await r.json()).total;
  };
  const honest = await ask(undefined);
  const low = await ask({ marginTarget: 30 });
  const high = await ask({ marginTarget: 70 });
  assert.ok(low < honest, 'staff can go down to 30% for a local job');
  assert.ok(high > honest, 'staff can go up to 70% for a long haul');
  assert.equal(await ask({ marginTarget: 900 }), high, '900 is clamped to the 70% ceiling');
});

async function submitAndRead({ worker, env, db, H }, body, headers) {
  await worker.fetch(new Request('https://x/shed/submit', {
    method: 'POST', headers: { ...H(), ...(headers || {}) }, body: JSON.stringify(body),
  }), env);
  const row = db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get();
  return JSON.parse(row.details);
}

test('a staff margin SURVIVES the submit', async () => {
  const h = await harness();
  const base = { name: 'T', email: 'a@e.com', phone: '4355550123', config: CONFIG };
  const plain = await submitAndRead(h, base);
  const raised = await submitAndRead(h,
    { ...base, email: 'b@e.com', overrides: { marginTarget: 70 } },
    { Authorization: 'Bearer ' + h.token });

  assert.ok(raised.quotedPrice > plain.quotedPrice,
    'the order stores the raised price, not the default the Worker would re-price to');
  assert.equal(raised.marginTarget, 70, 'and records what it was priced at');
  assert.equal(plain.marginTarget, null, 'an ordinary submit records no override');
  assert.equal(
    Math.round(raised.quotedPrice),
    Math.round(computePricing(CONFIG, { marginTarget: 70 }).customer),
    'stored price equals the engine at that margin'
  );
});

test('a customer cannot raise or lower their own order', async () => {
  const h = await harness();
  const base = { name: 'T', email: 'a@e.com', phone: '4355550123', config: CONFIG };
  const honest = await submitAndRead(h, base);
  for (const m of [0, 30, 70]) {
    const tampered = await submitAndRead(h,
      { ...base, email: `m${m}@e.com`, overrides: { marginTarget: m }, quotedPrice: 1 });
    assert.equal(Math.round(tampered.quotedPrice), Math.round(honest.quotedPrice),
      `overrides.marginTarget=${m} with no token must not change the stored price`);
    assert.equal(tampered.marginTarget, null);
  }
});

test('the customer never sees the margin on the quote', async () => {
  // It must land inside the Shed line, not as a line of its own.
  const { redline: plain } = computePricing(CONFIG, { marginTarget: 42 });
  const { redline: raised } = computePricing(CONFIG, { marginTarget: 70 });
  const names = r => JSON.stringify(r).toLowerCase();
  assert.ok(!/margin/.test(names(raised.addonLines || [])), 'no add-on line names the margin');
  assert.equal((raised.addonLines || []).length, (plain.addonLines || []).length,
    'raising the margin adds no new line to the quote');
});
