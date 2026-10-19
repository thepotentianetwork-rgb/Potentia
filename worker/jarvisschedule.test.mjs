/* Jarvis's two briefing-key routes: install invites (read) and plan/replan (write, backup-gated).
 * Run: node --experimental-sqlite --test worker/jarvisschedule.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
function makeD1(db) {
  function shape(sql) { const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({ first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const s = db.prepare(sql); if (isSelect) return { results: s.all(...args) }; const r = s.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; } }); }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; }, async batch(st) { return st.map((s) => s.run()); } };
}
const KEY = 'test-key';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT, adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT, created_at TEXT, effective_price REAL, track_token TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
  db.prepare("INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at) VALUES (1,'Nahui Lopez','nahui@x.test','8015550000','1 Elm','Salt Lake City','UT','84101','2026-09-01')").run();
  db.prepare("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (7,1,?,'won','2026-09-02')").run(JSON.stringify({ config: { w: 10, l: 12, style: 'barn', foundation: 'pad', foundationFinish: 'concrete' } }));
  return { db, env: { DB: makeD1(db), BRIEFING_API_KEY: KEY, ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k' } };
}
let ip = 0;
async function call(env, method, path, body) {
  const r = await worker.fetch(new Request('https://local' + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.' + (++ip) } }), env);
  return { status: r.status, data: await r.json() };
}
const plan = { q: 'nahui', anchor_date: '2099-03-06', install_days: 2 };

test('preview writes nothing', async () => {
  const { db, env } = setup();
  const r = await call(env, 'POST', '/api/briefing/schedule', plan);
  assert.equal(r.status, 200); assert.equal(r.data.preview, true); assert.equal(r.data.side_effects, 'none');
  assert.ok(r.data.stages.length >= 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM installs').get().n, 0);
});
test('confirm without a fresh backup is refused', async () => {
  const { db, env } = setup();
  let r = await call(env, 'POST', '/api/briefing/schedule', { ...plan, confirm: true });
  assert.equal(r.status, 428); assert.equal(r.data.error, 'backup_required');
  db.exec("CREATE TABLE backup_log (at TEXT)"); db.prepare('INSERT INTO backup_log VALUES (?)').run(new Date(Date.now() - 3600e3).toISOString());
  r = await call(env, 'POST', '/api/briefing/schedule', { ...plan, confirm: true });
  assert.equal(r.status, 428, 'an hour-old backup is not fresh');
});
test('confirm with a fresh backup writes, replan needs replace, invites come back', async () => {
  const { db, env } = setup();
  db.exec("CREATE TABLE backup_log (at TEXT)"); db.prepare('INSERT INTO backup_log VALUES (?)').run(new Date().toISOString());
  let r = await call(env, 'POST', '/api/briefing/schedule', { ...plan, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.side_effects, 'installs_written');
  const n = db.prepare('SELECT COUNT(*) n FROM installs').get().n; assert.equal(n, r.data.booked);
  r = await call(env, 'POST', '/api/briefing/schedule', { ...plan, anchor_date: '2099-03-13', confirm: true });
  assert.equal(r.status, 409, 'replan without replace must refuse');
  r = await call(env, 'POST', '/api/briefing/schedule', { ...plan, anchor_date: '2099-03-13', confirm: true, replace: true });
  assert.equal(r.status, 200); assert.equal(r.data.replaced, n);
  const inv = await call(env, 'GET', '/api/briefing/install-invites?q=nahui');
  assert.equal(inv.status, 200); assert.equal(inv.data.installs.length, n);
  const shed = inv.data.installs.find((i) => i.item === 'shed');
  assert.match(shed.calendar_url, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(decodeURIComponent(shed.calendar_url), /nahui@x\.test/);
});
test('unknown customer 404, GET on schedule 405, no key 401', async () => {
  const { env } = setup();
  assert.equal((await call(env, 'POST', '/api/briefing/schedule', { ...plan, q: 'zzz' })).status, 404);
  assert.equal((await call(env, 'GET', '/api/briefing/schedule')).status, 405);
  const r = await worker.fetch(new Request('https://local/api/briefing/install-invites?q=n'), env); assert.equal(r.status, 401);
});
