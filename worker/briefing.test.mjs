/* GET /api/briefing — auth, params, and that each section picks the right rows
 * out of a real SQLite standing in for D1.
 *
 * Run: node --experimental-sqlite --test worker/briefing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
import { buildBriefing, moneyWords, numberWords, parseParams, briefingWindow, denverMidnightUtc, designSummary } from './briefing.js';

function makeD1(db) {
  const writes = [];
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    if (!isSelect) writes.push(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const s = db.prepare(sql); return isSelect ? { results: s.all(...args) } : (s.run(...args), {}); }
    });
  }
  return { writes, prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; } };
}

// 2026-10-14 13:00 Denver (MDT, UTC-6) = 19:00Z
const NOW = Date.parse('2026-10-14T19:00:00Z');
const cfg = (o) => JSON.stringify({ city: 'Provo', heardAbout: 'google', quotedPrice: 9000.4, config: { w: 10, l: 12, style: 'barn', ...o } });

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, city TEXT, created_at TEXT NOT NULL, updated_at TEXT, temp_override TEXT, follow_up_at TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, name TEXT, email TEXT, details TEXT, status TEXT, created_at TEXT, customer_id INTEGER, effective_price REAL);
    CREATE TABLE installs (id INTEGER PRIMARY KEY, submission_id INTEGER, item TEXT, install_date TEXT, days REAL, done_at TEXT, created_at TEXT);
    INSERT INTO customers (id,name,city,created_at,temp_override,follow_up_at) VALUES
      (1,'Ann New',NULL,'2026-10-14T15:00:00Z',NULL,NULL),
      (2,'Bob Lastnight','Orem','2026-10-14T05:00:00Z',NULL,NULL),
      (3,'Cal Old','Lehi','2026-09-01T00:00:00Z','dormant','2026-10-10'),
      (4,'Dee Later',NULL,'2026-09-01T00:00:00Z','dormant','2027-01-01'),
      (5,'Eve Today',NULL,'2026-09-01T00:00:00Z','warm','2026-10-14');
    INSERT INTO submissions (id,name,details,status,created_at,customer_id,effective_price) VALUES
      (10,'Ann New','${cfg({ w: 12, l: 16 })}','new','2026-10-14T15:01:00Z',1,NULL),
      (11,'x','${cfg()}','quoted','2026-10-01T00:00:00Z',3,18100),
      (12,'x','${cfg()}','quoted','2026-10-10T00:00:00Z',5,NULL),
      (13,'x','${cfg()}','superseded','2026-10-14T16:00:00Z',3,NULL),
      (14,'x','${cfg()}','won','2026-09-01T00:00:00Z',4,5000),
      (15,'x','${cfg()}','won','2026-09-02T00:00:00Z',5,5000),
      (16,'x','${cfg()}','lost','2026-09-02T00:00:00Z',2,5000);
    INSERT INTO installs (id,submission_id,item,install_date,days,done_at) VALUES
      (1,14,'shed','2026-10-20',1,NULL),
      (2,14,'concrete','2026-10-13',1,NULL),
      (3,14,'pour','2026-10-28',1,NULL),
      (4,14,'prep','2026-10-15',1,'2026-10-15'),
      (5,16,'shed','2026-10-16',1,NULL);
  `);
  return db;
}
const env = (o) => ({ DB: makeD1(setup()), BRIEFING_API_KEY: 'k3y', ...o });
const req = (q = '', h = { Authorization: 'Bearer k3y' }, method = 'GET') =>
  new Request('https://w.example/api/briefing' + q, { method, headers: h });

test('auth: 503 without secret, 401 bad/missing key, 405 non-GET, no CORS', async () => {
  assert.equal((await worker.fetch(req(), env({ BRIEFING_API_KEY: undefined }))).status, 503);
  assert.equal((await worker.fetch(req('', { Authorization: 'Bearer nope' }), env())).status, 401);
  assert.equal((await worker.fetch(req('', {}), env())).status, 401);
  assert.equal((await worker.fetch(req('', { Authorization: 'Bearer k3y' }, 'POST'), env())).status, 405);
  const opt = await worker.fetch(req('', { Origin: 'https://evil.example' }, 'OPTIONS'), env());
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), null);
  const ok = await worker.fetch(req('', { Authorization: 'Bearer k3y', Origin: 'https://evil.example' }), env());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), null);
});

test('params', () => {
  const p = (q) => parseParams(new URLSearchParams(q));
  assert.equal(p('').days, 1);
  assert.equal(p('days=99').days, 30);
  assert.equal(p('days=-3').days, 1);
  assert.equal(p('days=abc').days, 1);
  assert.deepEqual(p('sections=follow_ups,bogus,new_leads').sections, ['new_leads', 'follow_ups']);
});

test('window is Denver midnight', () => {
  assert.equal(denverMidnightUtc('2026-10-14'), '2026-10-14T06:00:00.000Z');
  assert.equal(denverMidnightUtc('2026-12-01'), '2026-12-01T07:00:00.000Z');
  assert.equal(briefingWindow(NOW, 7).from, '2026-10-08T06:00:00.000Z');
});

test('money and numbers in words', () => {
  assert.equal(moneyWords(18100), 'eighteen thousand one hundred dollars');
  assert.equal(moneyWords(11180.9), 'eleven thousand one hundred eighty-one dollars');
  assert.equal(numberWords(1000000), 'one million');
  assert.equal(moneyWords(1), 'one dollar');
});

test('designSummary', () => {
  assert.equal(designSummary(cfg({ w: 12, l: 16, style: 'leanto' })), '12x16 lean-to');
  assert.equal(designSummary('not json'), null);
});

test('sections pick the right rows (days=1) and the endpoint is read-only', async () => {
  const e = env();
  const realNow = Date.now; Date.now = () => NOW;
  let body;
  try { body = await (await worker.fetch(req(), e)).json(); } finally { Date.now = realNow; }
  const d = body.display;
  assert.equal(body.timezone, 'America/Denver');
  assert.deepEqual(d.new_leads.map((x) => x.name), ['Ann New']);  // Bob was 23:00 Denver yesterday
  assert.equal(d.new_leads[0].source, 'google');
  assert.equal(d.new_leads[0].city, 'Provo');                     // falls back to submission city
  assert.deepEqual(d.new_designs.map((x) => x.submission_id), [10]); // superseded excluded
  assert.equal(d.new_designs[0].summary, '12x16 barn');
  assert.deepEqual(d.pending_proposals.map((x) => [x.quote_number, x.total, x.days_since_sent]), [[11, 18100, 13], [12, 9000.4, 4]]);
  assert.deepEqual(d.upcoming_installs.map((x) => x.install_id), [1, 3]); // not past, done, lost, or >14d
  assert.deepEqual(d.follow_ups.map((x) => [x.name, x.dormant]), [['Cal Old', true], ['Eve Today', false]]);
  assert.equal(d.counts.install_date_coverage.won_orders, 2);
  assert.equal(d.counts.install_date_coverage.won_orders_with_dates, 1);
  assert.match(body.spoken, /eighteen thousand one hundred dollars/);
  assert.doesNotMatch(body.spoken, /[$#|*{}\[\]]/);
  assert.deepEqual(e.DB.writes, []);
});

test('days=7 widens new items; sections filter', async () => {
  const realNow = Date.now; Date.now = () => NOW;
  let body;
  try { body = await (await worker.fetch(req('?days=7&sections=new_leads'), env())).json(); } finally { Date.now = realNow; }
  assert.deepEqual(body.display.new_leads.map((x) => x.name), ['Ann New', 'Bob Lastnight']);
  assert.deepEqual(Object.keys(body.display), ['new_leads', 'counts']);
  assert.doesNotMatch(body.spoken, /proposal/);
});

test('empty database still answers', () => {
  const b = buildBriefing({}, { nowMs: NOW });
  assert.equal(b.display.counts.new_leads, 0);
  assert.match(b.spoken, /No new leads/);
});
