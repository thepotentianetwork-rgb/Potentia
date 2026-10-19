import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() {
        const s = db.prepare(sql);
        if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}


function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT, status TEXT, created_at TEXT, effective_price REAL);`);
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (1,1,'{}','quoted','2026-09-01'),(2,1,'{}','lost','2026-08-01')").run();
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}
async function api(env, path, body, tok) {
  const r = await worker.fetch(new Request('https://local' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
test('marking lost stores reason, note, competitor and lost_at', async () => {
  const { db, env } = setup(); const t = (await api(env, '/admin/login', { password: 'pw' })).data.token;
  const r = await api(env, '/admin/submissions/status', { id: 1, status: 'lost', lost_reason: 'competitor', lost_competitor: 'Tuff Shed', lost_note: 'cheaper' }, t);
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT * FROM submissions WHERE id = 1').get();
  assert.equal(row.lost_reason, 'competitor'); assert.equal(row.lost_competitor, 'Tuff Shed'); assert.equal(row.lost_note, 'cheaper'); assert.ok(row.lost_at);
  assert.equal((await api(env, '/admin/submissions/status', { id: 1, status: 'lost', lost_reason: 'bogus' }, t)).status, 400);
  await api(env, '/admin/submissions/status', { id: 1, status: 'quoted' }, t);
  assert.equal(db.prepare('SELECT lost_at FROM submissions WHERE id = 1').get().lost_at, null);
});
test('backfill sets a reason on an existing lost quote without touching status or lost_at', async () => {
  const { db, env } = setup(); const t = (await api(env, '/admin/login', { password: 'pw' })).data.token;
  assert.equal((await api(env, '/admin/submissions/lost-reason', { id: 2, lost_reason: 'money' })).status, 401);
  assert.equal((await api(env, '/admin/submissions/lost-reason', { id: 2, lost_reason: 'money', lost_note: 'over budget' }, t)).status, 200);
  const row = db.prepare('SELECT * FROM submissions WHERE id = 2').get();
  assert.equal(row.status, 'lost'); assert.equal(row.lost_reason, 'money'); assert.equal(row.lost_at, null);
  assert.equal((await api(env, '/admin/submissions/lost-reason', { id: 1, lost_reason: 'money' }, t)).status, 409);
});
