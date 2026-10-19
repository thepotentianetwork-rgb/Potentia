/* view=installs: completed install history for Jarvis charts. Read-only.
 * Run: node --experimental-sqlite --test worker/installshistory.test.mjs */
import { test } from 'node:test'; import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite';
import { runQuery, QUERY_VIEWS } from './crmquery.js';
function makeD1(db) { const writes = [];
  return { writes, prepare(sql) { if (!/^\s*select/i.test(sql)) writes.push(sql); const m = (a) => ({ all: () => ({ results: db.prepare(sql).all(...a) }) }); return { ...m([]), bind: (...a) => m(a) }; } }; }
const NOW = Date.parse('2026-10-19T20:00:00Z');
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT);
    CREATE TABLE installs (id INTEGER PRIMARY KEY, submission_id INTEGER, item TEXT, install_date TEXT, done_at TEXT);
    INSERT INTO customers VALUES (1,'A'),(2,'B'); INSERT INTO submissions VALUES (1,1,'won'),(2,2,'lost');
    INSERT INTO installs (submission_id,item,install_date,done_at) VALUES
      (1,'pour','2026-09-08','2026-09-08T20:00:00Z'), (1,'shed','2026-09-16','2026-09-17T01:00:00Z'), (1,'gravel','2026-10-12','2026-10-12T22:00:00Z'),
      (1,'shed','2026-10-14',NULL), (1,'shed','2026-10-30',NULL), (2,'shed','2026-10-05','2026-10-05T20:00:00Z'), (1,'shed','2024-01-01','2024-01-02');`);
  return makeD1(db);
}
test('installs is a listed view', () => assert.ok(QUERY_VIEWS.includes('installs')));
test('completed by month and week; future, lost orders and old rows excluded; read-only', async () => {
  const db = setup();
  const r = await runQuery(db, { view: 'installs', limit: 25 }, { nowMs: NOW });
  assert.deepEqual(r.months, [{ period: '2026-09', completed: 2, sheds: 1, missed: 0 }, { period: '2026-10', completed: 1, sheds: 0, missed: 1 }]);
  assert.deepEqual(r.weeks.map((w) => w.period), ['2026-09-07', '2026-09-14', '2026-10-12']);
  assert.equal(r.weeks[2].completed, 1); assert.equal(r.weeks[2].missed, 1);
  assert.deepEqual(r.totals, { completed: 3, sheds: 1, missed: 1 });
  assert.match(r.summary, /3 install stages completed/);
  assert.equal(db.writes.length, 0);
});
test('days is capped and missing table gives empty history', async () => {
  const r = await runQuery({ prepare() { throw new Error('no such table'); } }, { view: 'installs', days: '9999', limit: 25 }, { nowMs: NOW });
  assert.equal(r.months.length, 0); assert.match(r.title, /730/);
});
