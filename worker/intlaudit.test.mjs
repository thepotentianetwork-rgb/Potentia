/* Intl Phase 2: US relevance, score gate, audit statuses, opportunity, and
   the intl run wiring (dry run previews, real run writes lead_evidence). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureLeadPipelineTables, runLeadPipeline } from './leadpipeline.js';
import { crawlSite } from './intlcrawl.js';
import { extractUsSignals, usScore, auditSite, opportunity, analyzeIntlLead, sampleLinks,
         AUDIT_STATUS, US_GATE_CAP } from './intlaudit.js';

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
async function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT, contact_name TEXT,
    email TEXT, phone TEXT, website_url TEXT, package TEXT, status TEXT NOT NULL DEFAULT 'lead', source TEXT,
    service TEXT, message TEXT, build_fee REAL, monthly_fee REAL, domain TEXT, domain_renews_at TEXT,
    launched_at TEXT, owner TEXT, owner_since TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE client_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
    direction TEXT NOT NULL, outcome TEXT NOT NULL, duration_min REAL, notes TEXT, logged_by TEXT,
    called_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const env = { CRM_DB: makeD1(db), GOOGLE_PLACES_API_KEY: 'k' };
  await ensureLeadPipelineTables(env);
  return { env, db };
}

const EN_HOME = `<html lang="en"><head><meta name="viewport" content="width=device-width">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<link rel="alternate" hreflang="es" href="https://cabo.example.mx/es/"></head><body>
<h1>Private yacht charters in Cabo</h1><p>Welcome to our fleet. We will take you and your family from the marina
for the best sunset tour. Book now with our team and enjoy the trip. Most of our guests from the US book online.</p>
<p>Half day from US$ 650. Free hotel pickup and airport transfers available.</p>
<a href="tel:+1 619 555 0101">Call our US line</a> <a href="https://wa.me/526241234567">WhatsApp</a>
<a href="/fleet">Fleet</a> <a href="/missing">Old page</a>
<form action="/contact"><input name="email"></form>
<script src="https://fareharbor.com/embeds/api/v1/"></script></body></html>`;

const ES_HOME = `<html lang="es"><head></head><body><h1>Pesca deportiva en Los Cabos</h1>
<p>Somos una empresa familiar con los mejores barcos de la bahía. Reserva con nosotros para el día de pesca.
Precios desde $3,500 por persona y por día con el capitán y la tripulación del barco.</p></body></html>`;

test('extractors: EN page, USD, +1 phone, US audience, airport — confirmed with url+snippet', () => {
  const s = extractUsSignals([{ url: 'https://cabo.example.mx/', html: EN_HOME }]);
  const k = Object.fromEntries(s.map(r => [r.kind, r]));
  for (const kind of ['lang_en', 'usd_price', 'us_phone', 'us_audience', 'airport_transfer']) {
    assert.ok(k[kind], kind); assert.equal(k[kind].status, 'confirmed', kind);
    assert.equal(k[kind].url, 'https://cabo.example.mx/'); assert.ok(k[kind].snippet.length > 0);
  }
  assert.match(k.us_phone.snippet, /619 555 0101/);
  assert.equal(k.medical_tourism, undefined);
});

test('extractors: bare $ price is needs_review (MXN also uses $); Spanish page has no lang_en', () => {
  const s = extractUsSignals([{ url: 'https://pesca.example.mx/', html: ES_HOME }]);
  const usd = s.find(r => r.kind === 'usd_price');
  assert.equal(usd.status, 'needs_review'); assert.equal(usd.confirmed, false);
  assert.equal(s.find(r => r.kind === 'lang_en'), undefined);
});

test('extractors: medical tourism and foreign-buyer language', () => {
  const s = extractUsSignals([
    { url: 'https://d.example.mx/', html: '<p>We welcome international patients — save up to 70% compared to US prices.</p>' },
    { url: 'https://r.example.mx/', html: '<p>Guidance for foreign buyers on the fideicomiso bank trust.</p>' }]);
  assert.equal(s.find(r => r.kind === 'medical_tourism').status, 'confirmed');
  assert.equal(s.find(r => r.kind === 'foreign_buyer').url, 'https://r.example.mx/');
});

test('score gate: English alone (or + one signal) is capped; two confirmed non-language passes', () => {
  const en = { kind: 'lang_en', category: 'us', confirmed: true };
  const usd = { kind: 'usd_price', category: 'us', confirmed: true };
  const ph = { kind: 'us_phone', category: 'us', confirmed: true };
  const rev = { kind: 'us_audience', category: 'us', confirmed: false };
  assert.equal(usScore([en]).gate, false);
  assert.ok(usScore([en]).score <= US_GATE_CAP);
  const one = usScore([en, usd, rev]);
  assert.equal(one.gate, false); assert.equal(one.score, US_GATE_CAP); assert.ok(one.raw > US_GATE_CAP);
  const two = usScore([en, usd, ph]);
  assert.equal(two.gate, true); assert.equal(two.score, 65); assert.equal(two.non_language_confirmed, 2);
  assert.equal(usScore([en, usd, ph, rev, { kind: 'airport_transfer', confirmed: true },
    { kind: 'medical_tourism', confirmed: true }, { kind: 'foreign_buyer', confirmed: true }]).score, 100);
});

test('audit: good EN site is all ok except measured items', () => {
  const docs = [{ url: 'https://cabo.example.mx/', html: EN_HOME }];
  const rows = auditSite({ docs, crawl: { pages: [{ url: docs[0].url, status: 200 }], whatsapp: [] },
    pagespeed: { performance: 42, hasViewport: true }, links: [{ url: 'https://cabo.example.mx/fleet', status: 200 },
    { url: 'https://cabo.example.mx/missing', status: 404 }] });
  const st = Object.fromEntries(rows.map(r => [r.kind, r.status]));
  for (const r of rows) assert.ok(AUDIT_STATUS.includes(r.status));
  assert.deepEqual(st, { audit_https: 'ok', audit_viewport: 'ok', audit_speed: 'confirmed_issue',
    audit_broken_links: 'confirmed_issue', audit_forms: 'ok', audit_booking: 'ok', audit_analytics: 'ok',
    audit_whatsapp: 'ok', audit_lang_switch: 'ok' });
  assert.match(rows.find(r => r.kind === 'audit_broken_links').snippet, /404 https:\/\/cabo\.example\.mx\/missing/);
});

test('audit: absence is opportunity_needs_review, not a confirmed issue; unmeasured is untested', () => {
  const rows = auditSite({ docs: [{ url: 'http://pesca.example.mx/', html: ES_HOME }], crawl: { pages: [] } });
  const st = Object.fromEntries(rows.map(r => [r.kind, r.status]));
  assert.equal(st.audit_https, 'confirmed_issue');
  assert.equal(st.audit_viewport, 'confirmed_issue');
  assert.equal(st.audit_speed, 'untested');
  assert.equal(st.audit_broken_links, 'untested');
  for (const k of ['audit_forms', 'audit_booking', 'audit_analytics', 'audit_whatsapp', 'audit_lang_switch'])
    assert.equal(st[k], 'opportunity_needs_review', k);
  const none = auditSite({ docs: [], crawl: {} });
  assert.ok(none.every(r => r.status === 'untested'));
});

test('opportunity: service, tier, talking points cite confirmed evidence only', () => {
  const docs = [{ url: 'http://pesca.example.mx/', html: ES_HOME }];
  const us = extractUsSignals(docs);
  const ev = us.concat(auditSite({ docs, crawl: { pages: [] }, usSignals: us }));
  const o = opportunity(usScore(us), ev, 'intl_yacht_charter');
  assert.equal(o.service, 'website_rebuild'); assert.equal(o.tier, 'C');
  assert.ok(o.talking_points.length >= 2);
  assert.ok(o.talking_points.every(t => !/USD/.test(t))); // the needs_review $ is not cited
  // Only lang switch missing -> bilingual
  const ev2 = [{ kind: 'audit_lang_switch', category: 'audit', status: 'opportunity_needs_review' }];
  assert.equal(opportunity({ score: 70, gate: true }, ev2, 'intl_tours').service, 'bilingual_site');
  assert.equal(opportunity({ score: 70, gate: true }, ev2, 'intl_tours').talking_points.length, 0);
});

test('sampleLinks HEADs same-site links only, falls back to GET on 405', async () => {
  const seen = [];
  const f = async (u, o) => { seen.push(o.method + ' ' + u); return { status: u.endsWith('/b') && o.method === 'HEAD' ? 405 : 200 }; };
  const out = await sampleLinks('<a href="/a">a</a><a href="/b">b</a><a href="https://other.com/x">x</a><a href="mailto:x@y">m</a>',
    'https://s.example.mx/', { fetchImpl: f });
  assert.deepEqual(out.map(l => l.url), ['https://s.example.mx/a', 'https://s.example.mx/b']);
  assert.ok(seen.includes('GET https://s.example.mx/b'));
});

// ── wiring through the intl run ──
const PLACES = [{ place_id: 'P1', name: 'Cabo Yachts', website: 'https://cabo.example.mx', rating: 4.9,
  review_count: 640, photo_count: 40, status: 'OPERATIONAL' }];
function siteFetch(u, o) {
  const url = String(u);
  const mk = (status, body, ct) => ({ ok: status < 400, status, url, headers: { get: () => ct || 'text/html' }, text: async () => body });
  if (url.endsWith('/robots.txt')) return mk(404, '', 'text/plain');
  if (url === 'https://cabo.example.mx/') return mk(200, EN_HOME);
  if (url.endsWith('/missing')) return mk(404, 'nope');
  return mk(200, '<html><body>ok info@cabo.example.mx</body></html>');
}
function deps() {
  return {
    placesTextSearch: async () => PLACES,
    crawlSite: (u) => crawlSite(u, { fetchImpl: async (x, o) => siteFetch(x, o), keepHtml: true }),
    analyzeLead: (c, opts) => analyzeIntlLead(c, { ...opts, fetchImpl: async (x, o) => siteFetch(x, o) }),
    pageSpeed: async () => ({ performance: 38, hasViewport: true, unreachable: false })
  };
}

test('intl dry run previews US score, opportunity and evidence; writes nothing', async () => {
  const { env, db } = await freshEnv();
  const out = await runLeadPipeline(env, { profile: 'intl', dryRun: true, deps: deps() });
  assert.equal(out.preview.length, 1);
  const p = out.preview[0];
  assert.equal(p.us_gate, true); assert.ok(p.us_score >= 60);
  assert.equal(p.suggested_service, 'website_rebuild');
  assert.ok(p.evidence.some(e => e.kind === 'audit_speed' && e.status === 'confirmed_issue'));
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM lead_evidence').get().c), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM clients').get().c), 0);
});

test('intl real run saves lead_evidence and summary columns on the client', async () => {
  const { env, db } = await freshEnv();
  const out = await runLeadPipeline(env, { profile: 'intl', deps: deps() });
  assert.equal(out.pushed, 1);
  const c = db.prepare('SELECT * FROM clients').get();
  assert.ok(c.lead_us_score >= 60); assert.ok(c.lead_us_signals >= 2);
  assert.equal(c.lead_suggested_service, 'website_rebuild'); assert.ok(['A', 'B'].includes(c.lead_tier));
  const tp = JSON.parse(c.lead_talking_points); assert.ok(tp.length > 0);
  const ev = db.prepare('SELECT * FROM lead_evidence WHERE client_id = ?').all(c.id);
  assert.equal(ev.length, out.evidence_saved);
  assert.ok(ev.some(e => e.kind === 'us_phone' && e.confirmed === 1 && e.url));
  assert.ok(ev.some(e => e.kind === 'audit_broken_links' && e.status === 'confirmed_issue'));
});

test('intl run without analyzeLead behaves as Phase 1 (no evidence, null columns)', async () => {
  const { env, db } = await freshEnv();
  const d = deps(); delete d.analyzeLead;
  await runLeadPipeline(env, { profile: 'intl', deps: d });
  assert.equal(db.prepare('SELECT lead_us_score FROM clients').get().lead_us_score, null);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM lead_evidence').get().c), 0);
});
