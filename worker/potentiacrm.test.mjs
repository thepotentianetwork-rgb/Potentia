/* Run: node --experimental-sqlite --test worker/potentiacrm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

function makeD1(db) {
  const writes = [];
  const shape = (sql) => { if (!/^\s*(select|pragma)/i.test(sql)) writes.push(sql);
    return (args) => ({ first() { return db.prepare(sql).get(...args) ?? null; }, all() { return { results: db.prepare(sql).all(...args) }; } }); };
  return { writes, prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; } };
}
const NOW = Date.now(); const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const KEY = 'k'.repeat(40);
function crm() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, business_name TEXT, contact_name TEXT, status TEXT, source TEXT, monthly_fee REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE client_notes (id INTEGER PRIMARY KEY, client_id INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE client_tasks (id INTEGER PRIMARY KEY, client_id INTEGER, title TEXT, due_date TEXT, done INTEGER DEFAULT 0, created_at TEXT);`);
  const ins = db.prepare('INSERT INTO clients (business_name,status,source,monthly_fee,created_at,updated_at) VALUES (?,?,?,?,?,?)');
  ins.run('Taller MX', 'lead', 'pipeline_intl', null, ago(0.2), ago(0.2));
  ins.run('Sheds Co', 'lead', 'pipeline_sheds', null, ago(0.3), ago(0.3));
  ins.run('Old Live', 'live', 'website', 150, ago(40), ago(40));
  db.exec(`INSERT INTO client_notes (client_id,text,created_at) VALUES (1,'called','${ago(0.1)}');
    INSERT INTO client_tasks (client_id,title,due_date,created_at) VALUES (2,'follow up','2000-01-01','${ago(1)}');`);
  return makeD1(db);
}
const call = (env, qs = '') => worker.fetch(new Request('https://x/api/briefing/potentia' + qs, { headers: { Authorization: 'Bearer ' + KEY, 'CF-Connecting-IP': '10.1.0.' + Math.floor(Math.random() * 250) } }), env);

test('Potentia CRM report reads CRM_DB only, read-only', async () => {
  const CRM_DB = crm(); const DB = makeD1(new DatabaseSync(':memory:'));
  const r = await call({ DB, CRM_DB, BRIEFING_API_KEY: KEY });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.crm, 'potentia');
  assert.equal(b.totals.clients, 3); assert.equal(b.totals.by_status.lead, 2); assert.equal(b.totals.mrr, 150);
  assert.deepEqual(b.new_by_source, { pipeline_intl: 1, pipeline_sheds: 1 });
  assert.equal(b.tasks_due.length, 1); assert.equal(b.recent_notes.length, 1);
  assert.match(b.spoken, /Potentia CRM: 3 clients/);
  assert.equal(CRM_DB.writes.length, 0);
});
test('no key → 401/403; no CRM_DB → error body', async () => {
  const r = await worker.fetch(new Request('https://x/api/briefing/potentia'), { CRM_DB: crm(), BRIEFING_API_KEY: KEY });
  assert.ok(r.status >= 400);
  const b = await (await call({ DB: crm(), BRIEFING_API_KEY: KEY })).json();
  assert.equal(b.error, 'CRM_DB not bound');
});
test('/api/briefing?crm=all adds potentia block; default has none', async () => {
  const env = { DB: makeD1(new DatabaseSync(':memory:')), CRM_DB: crm(), BRIEFING_API_KEY: KEY };
  const h = { headers: { Authorization: 'Bearer ' + KEY, 'CF-Connecting-IP': '10.2.0.1' } };
  const d = await (await worker.fetch(new Request('https://x/api/briefing', h), env)).json();
  assert.equal(d.potentia, undefined);
  const a = await (await worker.fetch(new Request('https://x/api/briefing?crm=all', h), env)).json();
  assert.equal(a.potentia.totals.clients, 3); assert.match(a.spoken_all, /Potentia CRM/);
});
