/* International Phase 4: drafts + compliance. Nothing sends. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { ensureLeadPipelineTables } from './leadpipeline.js';
import { addressOk, fill, findingLines, footer, COUNTRY_RULES } from './intlcampaigns.js';

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
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map(x => x.run()); } };
}

async function setup(extra) {
  const crm = new DatabaseSync(':memory:');
  const shed = new DatabaseSync(':memory:');
  shed.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  const env = Object.assign({ DB: makeD1(shed), CRM_DB: makeD1(crm), CRM_PASSWORD: 'crm-pw', ADMIN_PASSWORD: 'shed-pw',
    ADMIN_SESSION_SECRET: 's3cr3t-test-key', OUTREACH_POSTAL_ADDRESS: 'PO Box 1, Park City, UT 84060',
    PUBLIC_API_BASE: 'https://api.test' }, extra || {});
  const raw = async (method, p, body, token) => {
    const headers = { Origin: 'https://potentianetwork.com' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    return worker.fetch(new Request('https://api.test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  };
  const call = async (...a) => { const res = await raw(...a); let data = null; try { data = await res.json(); } catch (e) {} return { status: res.status, data }; };
  const token = (await call('POST', '/crm/login', { password: 'crm-pw' })).data.token;
  await call('GET', '/crm/clients', null, token);
  await ensureLeadPipelineTables(env);
  const now = new Date().toISOString();
  const lead = (o) => {
    const id = Number(crm.prepare(`INSERT INTO clients (business_name, website_url, status, source, country, do_not_contact, created_at, updated_at)
      VALUES (?, ?, 'lead', ?, ?, ?, ?, ?)`).run(o.name, o.website || null, o.source || 'pipeline_intl', o.country || 'MX', o.dnc ? 1 : 0, now, now).lastInsertRowid);
    for (const em of o.emails || []) crm.prepare(`INSERT INTO lead_emails (client_id, email, discovered_at, type, verification_status, source_url, eligibility)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, em.email, now, em.type || 'role', em.v || 'unverified', em.src === undefined ? 'https://' + (o.website || 'x').replace(/^https?:\/\//, '') + '/contacto' : em.src, em.elig || 'pending_verification');
    for (const ev of o.evidence || []) crm.prepare(`INSERT INTO lead_evidence (client_id, kind, category, status, confirmed, created_at)
      VALUES (?, ?, 'audit', ?, ?, ?)`).run(id, ev[0], ev[1], ev[1] === 'confirmed_issue' ? 1 : 0, now);
    return id;
  };
  return { env, crm, call, raw, token, lead };
}

const good = (name, dom) => ({ name, website: 'https://' + dom, emails: [{ email: 'info@' + dom }],
  evidence: [['audit_https', 'confirmed_issue'], ['audit_booking', 'opportunity_needs_review']] });

test('pure helpers: address gate, fill, finding lines, footer', () => {
  assert.equal(addressOk({ email: 'info@hotel.mx', type: 'role' }, { website_url: 'https://www.hotel.mx' }), null);
  assert.equal(addressOk({ email: 'info@other.mx', type: 'role' }, { website_url: 'https://hotel.mx' }), 'role_off_domain');
  assert.equal(addressOk({ email: 'hotel@gmail.com', type: 'freemail_role' }, { website_url: 'https://hotel.mx' }), 'unverified_freemail');
  assert.equal(addressOk({ email: 'hotel@gmail.com', verification_status: 'verified' }, {}), null);
  assert.equal(addressOk({ email: 'x@hotel.mx', verification_status: 'invalid', type: 'role' }, { website_url: 'hotel.mx' }), 'invalid_address');
  assert.equal(fill('Hi {{a}} {{b}}', { a: 'X' }), 'Hi X ');
  assert.deepEqual(findingLines([{ kind: 'audit_https' }, { kind: 'audit_https' }, { kind: 'zzz' }], 'es').length, 1);
  const f = footer({ OUTREACH_SENDER_NAME: 'Potentia', PUBLIC_API_BASE: 'https://api.x' }, 'es', 'abc');
  assert.match(f, /POSTAL ADDRESS NOT SET/); assert.match(f, /https:\/\/api\.x\/u\/abc/); assert.match(f, /dé de baja/);
  assert.equal(COUNTRY_RULES.CA.allowed, false);
});

test('/crm/intl/campaigns etc need CRM login', async () => {
  const { call } = await setup();
  for (const [m, p] of [['GET', '/crm/intl/campaigns'], ['POST', '/crm/intl/campaigns'], ['GET', '/crm/intl/templates'],
                        ['GET', '/crm/intl/suppressions'], ['POST', '/crm/intl/messages/1'], ['POST', '/crm/intl/campaigns/1/status']]) {
    assert.equal((await call(m, p, m === 'POST' ? {} : null)).status, 401, p);
  }
});

test('drafts only from confirmed findings; gate blocks with reasons; domestic skipped', async () => {
  const { call, token, lead } = await setup();
  const a = lead(good('Hotel Mar', 'hotelmar.mx'));
  const noConf = lead({ name: 'Review Only', website: 'https://ro.mx', emails: [{ email: 'info@ro.mx' }], evidence: [['audit_speed', 'opportunity_needs_review']] });
  const dnc = lead(Object.assign(good('DNC', 'dnc.mx'), { dnc: true }));
  const ca = lead(Object.assign(good('Canuck', 'canuck.ca'), { country: 'CA' }));
  const free = lead(Object.assign(good('Free', 'free.mx'), { emails: [{ email: 'free@gmail.com', type: 'freemail_role' }] }));
  const dom = lead(Object.assign(good('Domestic', 'dom.com'), { source: 'pipeline', country: 'US' }));
  const noMail = lead(Object.assign(good('NoMail', 'nm.mx'), { emails: [] }));
  const r = await call('POST', '/crm/intl/campaigns', { client_ids: [a, noConf, dnc, ca, free, dom, noMail], lang: 'es' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.drafted, 1); assert.equal(r.data.blocked, 3);
  const sk = Object.fromEntries(r.data.skipped.map(x => [x.client_id, x.reason]));
  assert.deepEqual(sk, { [noConf]: 'no_confirmed_findings', [dom]: 'not_intl_lead', [noMail]: 'no_address' });
  const d = await call('GET', '/crm/intl/campaigns/' + r.data.campaign_id, null, token);
  const by = Object.fromEntries(d.data.messages.map(m => [m.client_id, m]));
  assert.equal(by[a].status, 'draft');
  assert.equal(by[dnc].block_reason, 'do_not_contact');
  assert.equal(by[ca].block_reason, 'country_blocked');
  assert.equal(by[free].block_reason, 'unverified_freemail');
  const p = by[a].preview;
  assert.match(p.subject, /Hotel Mar/);
  assert.match(p.body, /HTTPS/); assert.doesNotMatch(p.body, /reservar o consultar/, 'needs-review finding never in copy');
  assert.match(p.body, /PO Box 1, Park City/); assert.match(p.body, /https:\/\/api\.test\/u\/[a-f0-9]{36}/);
  assert.match(p.list_unsubscribe, /^<https:\/\/api\.test\/u\//);
});

test('edit keeps footer; approve re-checks gate; send states locked; schedule', async () => {
  const { call, token, lead } = await setup();
  const a = lead(good('Hotel Mar', 'hotelmar.mx'));
  const c = (await call('POST', '/crm/intl/campaigns', { client_ids: [a] }, token)).data.campaign_id;
  let d = await call('GET', '/crm/intl/campaigns/' + c, null, token);
  const mid = d.data.messages[0].id;
  assert.equal((await call('POST', '/crm/intl/messages/' + mid, { subject: 'New subj', body: 'Short body.' }, token)).status, 200);
  d = await call('GET', '/crm/intl/campaigns/' + c, null, token);
  assert.equal(d.data.messages[0].edited, 1);
  assert.match(d.data.messages[0].preview.body, /^Short body\.[\s\S]*unsubscribe here: https:\/\/api\.test\/u\//);
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'sending' }, token)).status, 400);
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'scheduled', scheduled_for: '2099-01-01T00:00:00Z' }, token)).status, 400);
  let s = await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'approved' }, token);
  assert.equal(s.status, 200); assert.equal(s.data.eligible, 1);
  assert.equal((await call('POST', '/crm/intl/messages/' + mid, { subject: 'x', body: 'y' }, token)).status, 400, 'no edit after approve');
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'scheduled', scheduled_for: '2000-01-01' }, token)).status, 400);
  s = await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'scheduled', scheduled_for: '2099-01-01T00:00:00Z' }, token);
  assert.equal(s.status, 200);
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'done' }, token)).status, 400);
});

test('approve refused without postal address config', async () => {
  const { call, token, lead } = await setup({ OUTREACH_POSTAL_ADDRESS: '' });
  const a = lead(good('Hotel Mar', 'hotelmar.mx'));
  const c = (await call('POST', '/crm/intl/campaigns', { client_ids: [a] }, token)).data.campaign_id;
  const s = await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'approved' }, token);
  assert.equal(s.status, 400); assert.match(s.data.error, /Postal/);
});

test('approve blocks a message suppressed after drafting (domain suppression)', async () => {
  const { call, token, lead } = await setup();
  const a = lead(good('Hotel Mar', 'hotelmar.mx'));
  const c = (await call('POST', '/crm/intl/campaigns', { client_ids: [a] }, token)).data.campaign_id;
  assert.equal((await call('POST', '/crm/intl/suppressions', { kind: 'domain', value: '@HotelMar.mx' }, token)).status, 200);
  assert.equal((await call('POST', '/crm/intl/suppressions', { kind: 'domain', value: 'nope' }, token)).status, 400);
  const s = await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'approved' }, token);
  assert.equal(s.status, 400); assert.match(s.data.error, /No eligible/);
  const d = await call('GET', '/crm/intl/campaigns/' + c, null, token);
  assert.match(d.data.messages[0].block_reason, /^(opted_out|suppressed_domain)$/);
  // new draft also blocked
  const r = await call('POST', '/crm/intl/campaigns', { client_ids: [a] }, token);
  assert.equal(r.data.blocked, 1);
});

test('public /u/:token: GET confirms without changing anything, POST suppresses + do_not_contact', async () => {
  const { call, raw, token, lead, crm } = await setup();
  const a = lead(good('Hotel Mar', 'hotelmar.mx'));
  const c = (await call('POST', '/crm/intl/campaigns', { client_ids: [a], lang: 'es' }, token)).data.campaign_id;
  const tok = crm.prepare('SELECT unsubscribe_token t FROM campaign_messages WHERE campaign_id = ?').get(c).t;
  let res = await raw('GET', '/u/' + tok);
  assert.equal(res.status, 200); const html = await res.text();
  assert.match(html, /info@hotelmar\.mx/); assert.match(html, /<form method="post">/); assert.match(html, /Confirmar baja/);
  assert.equal(crm.prepare('SELECT COUNT(*) n FROM email_suppressions').get().n, 0);
  res = await raw('POST', '/u/' + tok);
  assert.equal(res.status, 200);
  assert.equal(crm.prepare("SELECT COUNT(*) n FROM email_suppressions WHERE kind='email' AND value='info@hotelmar.mx'").get().n, 1);
  assert.equal(crm.prepare('SELECT do_not_contact d FROM clients WHERE id = ?').get(a).d, 1);
  assert.equal(crm.prepare('SELECT opted_out o FROM lead_emails WHERE client_id = ?').get(a).o, 1);
  assert.equal(crm.prepare('SELECT status s FROM campaign_messages WHERE campaign_id = ?').get(c).s, 'blocked');
  // idempotent
  assert.equal((await raw('POST', '/u/' + tok)).status, 200);
  assert.equal((await raw('GET', '/u/deadbeefdeadbeefdeadbeef')).status, 404);
  assert.equal((await raw('GET', '/u/not-a-token!')).status, 404);
});

test('templates: EN/ES seeded and editable', async () => {
  const { call, token } = await setup();
  let t = await call('GET', '/crm/intl/templates', null, token);
  assert.deepEqual(t.data.templates.map(x => x.lang), ['en', 'es']);
  assert.equal((await call('POST', '/crm/intl/templates', { key: 'audit_intro', lang: 'es', subject: 'Hola {{business}}', body: '{{findings}}' }, token)).status, 200);
  assert.equal((await call('POST', '/crm/intl/templates', { key: 'Bad Key', lang: 'fr', subject: 'x', body: 'y' }, token)).status, 400);
  t = await call('GET', '/crm/intl/templates', null, token);
  assert.equal(t.data.templates.find(x => x.lang === 'es').subject, 'Hola {{business}}');
});
