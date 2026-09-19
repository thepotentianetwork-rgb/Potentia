/* The contractor intake sheet landing in the CRM.
 *
 * Two things have to hold, and the second is the one that matters:
 *   1. Someone new becomes a client.
 *   2. Someone ALREADY in the CRM does not become a second client. A record
 *      per submission is how a CRM starts lying about how many clients there
 *      are, and the duplicate is always found months later.
 *
 * And nothing already on a record is ever overwritten by a form.
 *
 * Run: node --test worker/intake.test.mjs
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

const ORIGIN = 'https://potentianetwork.com';

function setup() {
  const shed = new DatabaseSync(':memory:');
  shed.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  const crm = new DatabaseSync(':memory:');
  crm.exec(fs.readFileSync(path.join(here, 'schema-crm.sql'), 'utf8'));
  const env = {
    DB: makeD1(shed), CRM_DB: makeD1(crm),
    ADMIN_PASSWORD: 'pw', CRM_PASSWORD: 'c', ADMIN_SESSION_SECRET: 'k'
  };
  return { crm, env };
}

const SHEET = {
  business_name: 'Vega Drywall', owner_name: 'Rosa Vega',
  email: 'rosa@example.com', phone: '(801) 555-0148',
  service_area: 'Utah County', years_exp: '12 years',
  trade: ['Drywall', 'Framing'], project_type: ['Residential'],
  credentials: ['Bonded'], story: 'Started in 2011 with one van.',
  svc_name_1: 'Level 5 finish', svc_price_1: 'Call for quote'
};

const post = (env, body) => worker.fetch(new Request('https://x/crm/intake', {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}), env);

test('a new contractor becomes a client', async () => {
  const { crm, env } = setup();
  const res = await post(env, SHEET);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);

  const row = crm.prepare('SELECT * FROM clients WHERE id = ?').get(body.id);
  assert.equal(row.business_name, 'Vega Drywall');
  assert.equal(row.contact_name, 'Rosa Vega');
  assert.equal(row.email, 'rosa@example.com');
  assert.equal(row.phone, '(801) 555-0148');
  assert.equal(row.source, 'intake', 'marked as more than a cold enquiry');
  assert.equal(row.service, 'Drywall, Framing', 'the trades they ticked');
});

/* The form is unlisted and noindexed, so the only way to reach it is a link
   someone was sent. Filling it in means their build is starting - landing them
   at 'lead' would mean moving every one of them along by hand. */
test('a new contractor lands in the build pipeline, not the lead pile', async () => {
  const { crm, env } = setup();
  const { id } = await (await post(env, SHEET)).json();
  assert.equal(crm.prepare('SELECT status FROM clients WHERE id = ?').get(id).status, 'building');
});

test('the whole sheet is kept, not just the fields with columns', async () => {
  const { crm, env } = setup();
  const { id } = await (await post(env, SHEET)).json();
  const row = crm.prepare('SELECT payload FROM client_intake WHERE client_id = ?').get(id);
  assert.ok(row, 'the sheet is stored');
  assert.deepEqual(JSON.parse(row.payload), SHEET, 'every answer, exactly as sent');
});

test('the timeline says what arrived', async () => {
  const { crm, env } = setup();
  const { id } = await (await post(env, SHEET)).json();
  const note = crm.prepare('SELECT text FROM client_notes WHERE client_id = ?').get(id);
  assert.match(note.text, /intake sheet/i);
  assert.match(note.text, /Vega Drywall/);
  assert.match(note.text, /Drywall, Framing/);
});

/* ── MATCHING AN EXISTING CLIENT ─────────────────────────────────────────── */

function seedClient(crm, fields) {
  const cols = Object.keys(fields);
  crm.prepare(
    `INSERT INTO clients (${cols.join(',')}, created_at, updated_at)
     VALUES (${cols.map(() => '?').join(',')}, '2026-01-01', '2026-01-01')`
  ).run(...cols.map(c => fields[c]));
  return crm.prepare('SELECT id FROM clients ORDER BY id DESC LIMIT 1').get().id;
}

test('a known email attaches to that client instead of making a second', async () => {
  const { crm, env } = setup();
  const id = seedClient(crm, { business_name: 'Vega Drywall', email: 'rosa@example.com', status: 'live' });
  const body = await (await post(env, SHEET)).json();
  assert.equal(body.created, false);
  assert.equal(body.id, id);
  assert.equal(crm.prepare('SELECT COUNT(*) n FROM clients').get().n, 1, 'still one client');
});

test('a known phone matches however either side was typed', async () => {
  for (const stored of ['801-555-0148', '(801) 555-0148', '8015550148', '+1 801 555 0148']) {
    const { crm, env } = setup();
    const id = seedClient(crm, { business_name: 'Vega Drywall', phone: stored, status: 'building' });
    /* no email on the sheet, so the phone is the only thing to match on */
    const body = await (await post(env, { ...SHEET, email: '' })).json();
    assert.equal(body.created, false, `stored as ${stored}`);
    assert.equal(body.id, id);
  }
});

test('a different phone is a different client', async () => {
  const { crm, env } = setup();
  seedClient(crm, { business_name: 'Other Co', phone: '801-555-0199' });
  const body = await (await post(env, { ...SHEET, email: '' })).json();
  assert.equal(body.created, true, 'not the same person');
  assert.equal(crm.prepare('SELECT COUNT(*) n FROM clients').get().n, 2);
});

test('a seven-digit number does not match everyone', async () => {
  const { crm, env } = setup();
  seedClient(crm, { business_name: 'Other Co', phone: '5550148' });
  const body = await (await post(env, { ...SHEET, email: '' })).json();
  assert.equal(body.created, true, 'too short to be a confident match');
});

/* ── NOTHING GETS OVERWRITTEN ────────────────────────────────────────────── */

test('what is already on the record wins', async () => {
  const { crm, env } = setup();
  const id = seedClient(crm, {
    business_name: 'Vega Drywall LLC',        // the proper legal name, typed by staff
    contact_name: 'Rosa M. Vega',
    email: 'rosa@example.com',
    phone: '801-555-0148',
    status: 'live', package: 'tier2', build_fee: 1200
  });
  await post(env, SHEET);
  const row = crm.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  assert.equal(row.business_name, 'Vega Drywall LLC', 'the staff-typed name stands');
  assert.equal(row.contact_name, 'Rosa M. Vega');
  assert.equal(row.phone, '801-555-0148', 'their formatting, not the form\'s');
  assert.equal(row.package, 'tier2');
  assert.equal(row.build_fee, 1200);
});

test('a form never moves someone along the pipeline', async () => {
  for (const status of ['lead', 'proposal', 'building', 'live', 'paused', 'lost']) {
    const { crm, env } = setup();
    const id = seedClient(crm, { email: 'rosa@example.com', status });
    await post(env, SHEET);
    assert.equal(crm.prepare('SELECT status FROM clients WHERE id = ?').get(id).status, status,
      `${status} must be left where staff put it`);
  }
});

test('blanks on the record do get filled', async () => {
  const { crm, env } = setup();
  const id = seedClient(crm, { email: 'rosa@example.com', business_name: '', contact_name: null, status: 'lead' });
  await post(env, SHEET);
  const row = crm.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  assert.equal(row.business_name, 'Vega Drywall', 'an empty string counts as blank');
  assert.equal(row.contact_name, 'Rosa Vega', 'and so does null');
  assert.equal(row.phone, '(801) 555-0148', 'a missing phone is gained');
});

test('a second sheet is kept as well as the first, not instead of it', async () => {
  const { crm, env } = setup();
  const { id } = await (await post(env, SHEET)).json();
  await post(env, { ...SHEET, service_area: 'Salt Lake County' });
  const rows = crm.prepare('SELECT payload FROM client_intake WHERE client_id = ? ORDER BY id').all(id);
  assert.equal(rows.length, 2, 'both submissions survive');
  assert.equal(JSON.parse(rows[0].payload).service_area, 'Utah County');
  assert.equal(JSON.parse(rows[1].payload).service_area, 'Salt Lake County');
  assert.equal(crm.prepare('SELECT COUNT(*) n FROM clients').get().n, 1);
});

/* ── THE EDGES ───────────────────────────────────────────────────────────── */

test('a sheet with no way to reach anyone is refused', async () => {
  const { crm, env } = setup();
  const res = await post(env, { ...SHEET, email: '', phone: '' });
  assert.equal(res.status, 400);
  assert.equal(crm.prepare('SELECT COUNT(*) n FROM clients').get().n, 0, 'and writes nothing');
});

test('email matching ignores case', async () => {
  const { crm, env } = setup();
  const id = seedClient(crm, { email: 'Rosa@Example.com' });
  const body = await (await post(env, SHEET)).json();
  assert.equal(body.id, id);
  assert.equal(body.created, false);
});

test('a sheet with only a phone still works', async () => {
  const { crm, env } = setup();
  const body = await (await post(env, { ...SHEET, email: '' })).json();
  assert.equal(body.created, true);
  assert.equal(crm.prepare('SELECT email FROM clients WHERE id = ?').get(body.id).email, null);
});
