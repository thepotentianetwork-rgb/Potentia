/* International Phase 3 (2026-11-03): +52 dedupe keys, the possible-duplicate
 * queue, and the /crm/intl/* endpoints behind the International view.
 * Also pins that none of it can touch a domestic row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import {
  ensureLeadPipelineTables, intlPhoneKey, intlDomainKey, intlBrandKey, intlNameKey, intlDedupe,
  normalisePhone, registrableDomain
} from './leadpipeline.js';

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
      },
    });
  }
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map(x => x.run()); },
  };
}

async function setup() {
  const crm = new DatabaseSync(':memory:');
  const shed = new DatabaseSync(':memory:');
  shed.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  const env = { DB: makeD1(shed), CRM_DB: makeD1(crm), CRM_PASSWORD: 'crm-pw', ADMIN_PASSWORD: 'shed-pw',
                ADMIN_SESSION_SECRET: 's3cr3t-test-key' };
  const call = async (method, p, body, token) => {
    const headers = { Origin: 'https://potentianetwork.com' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://api.test' + p, { method, headers,
      body: body ? JSON.stringify(body) : undefined }), env);
    let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
  // Touch /crm/clients first so the CRM tables exist exactly as in production.
  const login = await call('POST', '/crm/login', { password: 'crm-pw' });
  const token = login.data.token;
  await call('GET', '/crm/clients', null, token);
  await ensureLeadPipelineTables(env);
  const now = new Date().toISOString();
  const ins = (o) => Number(crm.prepare(
    `INSERT INTO clients (business_name, email, phone, website_url, status, source, country, city,
       lead_us_score, lead_opportunity_score, lead_tier, lead_segment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
       o.name, o.email || null, o.phone || null, o.website || null, o.status || 'lead', o.source || null,
       o.country || null, o.city || null, o.us ?? null, o.opp ?? null, o.tier || null, o.segment || null,
       now, now).lastInsertRowid);
  return { env, crm, call, token, ins };
}

test('+52 phone keys: every common Mexican format collapses to one key', () => {
  const k = '526241431234';
  for (const v of ['+52 624 143 1234', '+52 1 624 143 1234', '5216241431234', '624 143 1234',
                   '(624) 143-1234', '044 624 143 1234', '01 624 143 1234', '0052 624 143 1234']) {
    assert.equal(intlPhoneKey(v), k, v);
  }
  assert.equal(intlPhoneKey('+1 435 232 9516'), '14352329516', 'US kept distinct from MX');
  assert.equal(intlPhoneKey('12345'), null);
  assert.equal(intlPhoneKey(''), null);
});

test('domestic normalisePhone / registrableDomain unchanged', () => {
  assert.equal(normalisePhone('(435) 232-9516'), '4352329516');
  assert.equal(normalisePhone('+1 435-232-9516'), '4352329516');
  assert.equal(registrableDomain('https://www.Example.com/x?y'), 'example.com');
  assert.equal(registrableDomain('shop.example.com'), 'shop.example.com');
});

test('domain keys know .com.mx and ignore shared hosts', () => {
  assert.equal(intlDomainKey('https://reservas.hotelmar.com.mx/es'), 'hotelmar.com.mx');
  assert.equal(intlDomainKey('www.hotelmar.com.mx'), 'hotelmar.com.mx');
  assert.equal(intlDomainKey('https://book.cabo-yachts.com'), 'cabo-yachts.com');
  assert.equal(intlDomainKey('https://facebook.com/somebiz'), null);
  assert.equal(intlDomainKey('https://x.wixsite.com/y'), null);
  assert.equal(intlBrandKey('https://cabo-yachts.com'), 'caboyachts');
  assert.equal(intlBrandKey('caboyachts.mx'), 'caboyachts');
  assert.equal(intlNameKey('Restaurante  La Paloma, S.A. de C.V.'), intlNameKey('la paloma'));
});

test('intlDedupe: hard on phone or domain, soft on brand or name+city', async () => {
  const { env, ins } = await setup();
  const a = ins({ name: 'Cabo Yachts', phone: '624 143 1234', website: 'https://cabo-yachts.com', city: 'Cabo San Lucas' });
  let r = await intlDedupe(env, { name: 'X', phone: '+52 1 624 143 1234', website: '' }, null, null);
  assert.deepEqual(r.hard, { id: a, on: 'phone' });
  r = await intlDedupe(env, { name: 'X', website: 'https://www.book.cabo-yachts.com/en' }, null, null);
  assert.deepEqual(r.hard, { id: a, on: 'domain' });
  r = await intlDedupe(env, { name: 'X', website: 'https://caboyachts.mx' }, null, null);
  assert.equal(r.hard, null); assert.deepEqual(r.soft, { id: a, on: 'brand' });
  r = await intlDedupe(env, { name: 'Cabo Yachts', website: 'https://otro.mx' }, null, { city: 'Cabo San Lucas' });
  assert.deepEqual(r.soft, { id: a, on: 'name_city' });
  r = await intlDedupe(env, { name: 'Cabo Yachts', website: 'https://otro.mx' }, null, { city: 'Tulum' });
  assert.equal(r.soft, null);
  // crawl phones / WhatsApp count too
  r = await intlDedupe(env, { name: 'Y', website: 'https://zzz.mx' }, { phones: [], whatsapp: ['5216241431234'], pages: [] }, null);
  assert.deepEqual(r.hard, { id: a, on: 'phone' });
  // shared host never matches
  ins({ name: 'FB Shop', website: 'https://facebook.com/fbshop' });
  r = await intlDedupe(env, { name: 'Other', website: 'https://facebook.com/other' }, null, null);
  assert.equal(r.hard, null);
});

test('/crm/intl/* needs a CRM login', async () => {
  const { call } = await setup();
  for (const [m, p] of [['GET', '/crm/intl/leads'], ['POST', '/crm/intl/leads/status'],
                        ['GET', '/crm/intl/leads/1/evidence'], ['GET', '/crm/intl/duplicates'],
                        ['POST', '/crm/intl/duplicates/1']]) {
    assert.equal((await call(m, p, m === 'POST' ? {} : null)).status, 401, p);
  }
});

test('GET /crm/intl/leads: intl rows only, metrics, sorted by opportunity', async () => {
  const { call, token, ins } = await setup();
  ins({ name: 'Domestic Co', source: 'outreach', phone: '4352329516' });
  ins({ name: 'Dom pipeline', source: 'pipeline' });
  const a = ins({ name: 'A', source: 'pipeline_intl', country: 'MX', city: 'Tulum', us: 80, opp: 90, tier: 'A', email: 'info@a.mx', segment: 'intl_hotel' });
  const b = ins({ name: 'B', source: 'pipeline_intl', country: 'MX', city: 'Cabo San Lucas', us: 20, opp: 40, tier: 'C', segment: 'intl_yacht_charter' });
  const r = await call('GET', '/crm/intl/leads', null, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.leads.map(x => x.id), [a, b]);
  const m = r.data.metrics;
  assert.equal(m.total, 2); assert.equal(m.tier_a, 1); assert.equal(m.tier_c, 1);
  assert.equal(m.with_email, 1); assert.equal(m.us_relevant, 1); assert.equal(m.avg_opportunity, 65);
  assert.deepEqual(m.by_status, { lead: 2 });
  assert.equal(r.data.leads[0].email_count, 0);
});

test('bulk status: moves intl rows, refuses bad status, never touches domestic', async () => {
  const { call, token, ins, crm } = await setup();
  const d = ins({ name: 'Domestic', source: 'outreach' });
  const a = ins({ name: 'A', source: 'pipeline_intl' });
  const b = ins({ name: 'B', source: 'pipeline_intl' });
  let r = await call('POST', '/crm/intl/leads/status', { ids: [a, b, d], status: 'contacted' }, token);
  assert.equal(r.status, 200); assert.equal(r.data.changed, 2);
  assert.equal(crm.prepare('SELECT status FROM clients WHERE id=?').get(d).status, 'lead');
  assert.equal(crm.prepare('SELECT status FROM clients WHERE id=?').get(a).status, 'contacted');
  r = await call('POST', '/crm/intl/leads/status', { ids: [a], status: 'hacked' }, token);
  assert.equal(r.status, 400);
  r = await call('POST', '/crm/intl/leads/status', { ids: [], status: 'lost' }, token);
  assert.equal(r.status, 400);
});

test('GET /crm/intl/leads/:id/evidence returns evidence + emails; 404 when missing', async () => {
  const { call, token, ins, crm } = await setup();
  const a = ins({ name: 'A', source: 'pipeline_intl' });
  const now = new Date().toISOString();
  crm.prepare(`INSERT INTO lead_evidence (client_id, kind, category, status, confirmed, url, snippet, created_at)
               VALUES (?, 'usd_price', 'us', 'confirmed', 1, 'https://a.mx/precios', 'USD $120', ?)`).run(a, now);
  crm.prepare(`INSERT INTO lead_emails (client_id, email, source_url, discovered_at, type, verification_status, eligibility, opted_out)
               VALUES (?, 'info@a.mx', 'https://a.mx', ?, 'role', 'unverified', 'pending_verification', 0)`).run(a, now);
  const r = await call('GET', '/crm/intl/leads/' + a + '/evidence', null, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.evidence.length, 1); assert.equal(r.data.evidence[0].kind, 'usd_price');
  assert.equal(r.data.emails[0].email, 'info@a.mx');
  assert.equal((await call('GET', '/crm/intl/leads/99999/evidence', null, token)).status, 404);
});

test('possible-duplicate queue: list, mark duplicate (lost), mark distinct', async () => {
  const { call, token, ins, crm } = await setup();
  const orig = ins({ name: 'Cabo Yachts', source: 'pipeline_intl', website: 'https://cabo-yachts.com' });
  const d1 = ins({ name: 'Cabo Yachts MX', source: 'pipeline_intl', website: 'https://caboyachts.mx' });
  const d2 = ins({ name: 'Cabo Yachts 2', source: 'pipeline_intl' });
  crm.prepare("UPDATE clients SET lead_dup_of=?, lead_dup_status='possible', lead_dup_reason='brand' WHERE id IN (?, ?)").run(orig, d1, d2);
  let r = await call('GET', '/crm/intl/duplicates', null, token);
  assert.equal(r.data.duplicates.length, 2);
  assert.equal(r.data.duplicates.find(x => x.id === d1).other_id, orig);
  r = await call('POST', '/crm/intl/duplicates/' + d1, { action: 'duplicate' }, token);
  assert.equal(r.data.changed, 1);
  assert.deepEqual({ ...crm.prepare('SELECT status, lead_dup_status FROM clients WHERE id=?').get(d1) },
                   { status: 'lost', lead_dup_status: 'confirmed' });
  r = await call('POST', '/crm/intl/duplicates/' + d2, { action: 'distinct' }, token);
  assert.equal(crm.prepare('SELECT lead_dup_status FROM clients WHERE id=?').get(d2).lead_dup_status, 'distinct');
  assert.equal((await call('POST', '/crm/intl/duplicates/' + d2, { action: 'nope' }, token)).status, 400);
  r = await call('GET', '/crm/intl/duplicates', null, token);
  assert.equal(r.data.duplicates.length, 0);
});

test('domestic /crm/clients still lists everything with the same stats shape', async () => {
  const { call, token, ins } = await setup();
  ins({ name: 'Domestic', source: 'outreach' });
  ins({ name: 'Intl', source: 'pipeline_intl' });
  const r = await call('GET', '/crm/clients', null, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.clients.length, 2);
  assert.deepEqual(Object.keys(r.data.stats).sort(), ['active_clients', 'collected_30d', 'mrr', 'open_leads']);
});

test('crm.html: International view present, scripts parse, domestic table unchanged', () => {
  const html = fs.readFileSync(path.join(here, '..', 'crm.html'), 'utf8');
  for (const id of ['intl-view', 'intl-toggle', 'intl-metrics', 'intl-rows', 'intl-csv', 'intl-assign',
                    'intl-apply', 'intl-dupes', 'intl-evidence', 'if-country', 'if-city', 'if-tier', 'if-segment']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  for (const h of ['Country', 'City', 'US', 'Opp.', 'Tier', 'Email', 'Phone', 'Website', 'Segment']) {
    assert.ok(html.includes('<th>' + h + '</th>'), h);
  }
  assert.ok(html.includes('<tbody id="clients-body">'));
  assert.ok(html.includes('<tr><th>Client</th><th>Contact</th><th>Package</th><th>Status</th><th>Value</th><th>Open Work</th><th>Latest Note</th><th></th></tr>'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 2);
  for (const s of scripts) new vm.Script(s);
  const intl = scripts.find(s => s.includes('/crm/intl/leads'));
  assert.ok(intl && !/\/crm\/clients/.test(intl), 'intl view only calls /crm/intl/*');
});
