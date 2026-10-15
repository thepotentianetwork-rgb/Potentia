/* GET /api/briefing/customer-design — "Jarvis, render Nahui's shed".
 * Finds the customer by name, prefers the saved 3D design, then the latest
 * quote, then the inquiry words; never writes; same Bearer auth as briefing.
 *
 * Run: node --experimental-sqlite --test worker/customerdesign.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
import { describeDesign, nameScore, findCustomerDesign } from './customerdesign.js';

const Q71 = JSON.parse(JSON.parse(readFileSync(new URL('./fixtures/q71-like.json', import.meta.url), 'utf8')).details).config;

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
  return { raw: db, writes, prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; } };
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, city TEXT, created_at TEXT NOT NULL);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, name TEXT, email TEXT, details TEXT, status TEXT, created_at TEXT, customer_id INTEGER, effective_price REAL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE saved_designs (code TEXT PRIMARY KEY, config TEXT NOT NULL, contact_name TEXT, contact_email TEXT, contact_phone TEXT, created_at TEXT NOT NULL);
  `);
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins("INSERT INTO customers (id,name,email,created_at) VALUES (1,'Nahui Lopez','n@x.com','2026-10-01'),(2,'Ann Quote','a@x.com','2026-10-01'),(3,'Ivan Inquiry','i@x.com','2026-10-01'),(4,'Nora Nothing','z@x.com','2026-10-01')");
  ins("INSERT INTO saved_designs VALUES ('abcd1234',?, 'Someone Else','n@x.com',NULL,'2026-10-05')", JSON.stringify(Q71));
  ins("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (73,1,?, 'new','2026-10-04')", JSON.stringify({ config: { w: 8, l: 8, style: 'barn' } }));
  ins("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (80,2,?, 'new','2026-10-04')", JSON.stringify({ config: { w: 10, l: 12, style: 'barn', roofType: 'metal' } }));
  ins("INSERT INTO submissions (id,customer_id,details,status,created_at) VALUES (81,3,?, 'new','2026-10-04')", JSON.stringify({ notes: 'Wants a 10x12 with a loft' }));
  ins("INSERT INTO notes (customer_id,text,created_at) VALUES (3,'Called, prefers gray','2026-10-06')");
  return makeD1(db);
}

const KEY = 'k_test_123';
const call = (env, q, auth = 'Bearer ' + KEY) => worker.fetch(new Request('https://x/api/briefing/customer-design?q=' + encodeURIComponent(q), { headers: auth ? { Authorization: auth } : {} }), env);

test('spec: style label, Sherwin-Williams trim, colors, ridge vent, placement — all from the config', () => {
  const s = describeDesign(Q71).text;
  assert.match(s, /Size: 12' wide x 16' deep, 8' walls, 8\/12 roof pitch/);
  assert.match(s, /Style: Gable \/ A-Frame/);
  assert.match(s, /Trim color: Sherwin-Williams SW 7073 Network Gray \(#A0A5A7\)/);
  assert.match(s, /Siding color: Gray \(#44484D\)/);
  assert.match(s, /Roof: Black Asphalt \(#28282A\), asphalt shingle/);
  assert.match(s, /Ridge vent: yes/);
  assert.match(s, /Loft:/);
  assert.match(s, /Door placement: centered on the right side wall/);
  assert.match(s, /Window placement: centered on the front wall; near the right end of the right side wall; near the left end of the right side wall/);
  assert.doesNotMatch(s, /\$|\d+\.\d\d\b/, 'no prices');
  assert.doesNotMatch(s, /fb color|shutter color/, 'colour settings are not add-ons');
  assert.equal(s.match(/^Roof/gm).length, 1, 'one roof line');
});

test('barn style and missing fields are left out, not invented', () => {
  const s = describeDesign({ style: 'barn', w: 10, l: 12 }).text;
  assert.equal(s, "Size: 10' wide x 12' deep\nStyle: Barn");
});

test('fuzzy names', () => {
  assert.ok(nameScore('nahui', 'Nahui Lopez') > 0);
  assert.ok(nameScore("Nahui's", 'Nahui Lopez') > 0);
  assert.ok(nameScore('NAHUI LOPES', 'Nahui López') > 0);
  assert.equal(nameScore('bob', 'Nahui Lopez'), 0);
  assert.ok(nameScore('Nahui Lopez', 'Nahui Lopez') > nameScore('nahui', 'Nahui Lopez'));
});

test('source order: won quote > newest of saved design (by email) / quote > inquiry > nothing', async () => {
  const db = setup();
  const a = await findCustomerDesign(db, 'nahui');
  assert.equal(a.source, 'saved_design'); assert.equal(a.ref.code, 'abcd1234'); assert.equal(a.customer.name, 'Nahui Lopez');
  db.raw.prepare("UPDATE submissions SET status='won' WHERE id=73").run();
  const w = await findCustomerDesign(db, 'nahui');
  assert.equal(w.source, 'quote'); assert.equal(w.ref.submission_id, 73);
  const b = await findCustomerDesign(db, 'ann');
  assert.equal(b.source, 'quote'); assert.equal(b.ref.submission_id, 80); assert.match(b.spec_text, /Style: Barn/);
  const c = await findCustomerDesign(db, 'ivan inquiry');
  assert.equal(c.source, 'inquiry'); assert.deepEqual(c.inquiry, ['Wants a 10x12 with a loft']); assert.deepEqual(c.notes, ['Called, prefers gray']);
  const d = await findCustomerDesign(db, 'nora');
  assert.equal(d.source, null);
  const e = await findCustomerDesign(db, 'zzzz');
  assert.equal(e.found, false);
  assert.deepEqual(db.writes, []);
});

test('endpoint: auth, 404, read-only marker', async () => {
  const DB = setup();
  const env = { DB, BRIEFING_API_KEY: KEY };
  assert.equal((await call({ DB }, 'nahui')).status, 503);
  assert.equal((await call(env, 'nahui', null)).status, 401);
  assert.equal((await call(env, 'nahui', 'Bearer nope')).status, 401);
  assert.equal((await call(env, '')).status, 400);
  const r = await call(env, 'Nahui Lopez');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.source, 'saved_design'); assert.match(j.prompt, /Gable \/ A-Frame/);
  assert.equal((await call(env, 'nobody here')).status, 404);
  assert.deepEqual(DB.writes, []);
});
