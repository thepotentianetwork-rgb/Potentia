/* International lead profile (Phase 0 + Phase 1 first slice, 2026-11-02).
 *
 * Two jobs: prove the domestic pipeline did not move (profile scoping,
 * byte-identical Places request, identical grid), and pin the intl rules
 * (website required, no review ceiling, crawl only keeps public role emails).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureLeadPipelineTables, seedLeadSources, seedIntlSources, defaultSources, intlDefaultSources,
  listSegments, setSegmentEnabled, listIntlSegments, setIntlSourcesEnabled,
  placesReject, intlReject, intlPromise, intlVerdict, placesTextSearch, runLeadPipeline,
  recheckLeads, normalisePhone, INTL_SEGMENTS, LEAD_SEGMENTS
} from './leadpipeline.js';
import {
  crawlSite, extractEmails, classifyEmail, parseRobots, candidateLinks, decodeCfEmail,
  baseDomain, relatedDomain, isRoleLocal
} from './intlcrawl.js';

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

async function freshEnv(extra) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT, contact_name TEXT,
    email TEXT, phone TEXT, website_url TEXT, package TEXT,
    status TEXT NOT NULL DEFAULT 'lead', source TEXT, service TEXT, message TEXT,
    build_fee REAL, monthly_fee REAL, domain TEXT, domain_renews_at TEXT,
    launched_at TEXT, owner TEXT, owner_since TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE client_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
    direction TEXT NOT NULL, outcome TEXT NOT NULL, duration_min REAL,
    notes TEXT, logged_by TEXT, called_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const env = { CRM_DB: makeD1(db), GOOGLE_PLACES_API_KEY: 'k', ...(extra || {}) };
  await ensureLeadPipelineTables(env);
  return { env, db };
}

// ── Phase 0: domestic unchanged ───────────────────────────────────────────
test('domestic grid is identical to origin/main (2356 rows, same hash)', () => {
  const rows = defaultSources();
  assert.equal(rows.length, 2356);
  const h = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  assert.equal(h, '5d53b3e06fe530af549309fb3ef54fdace08e205100e85e9caa11920e4e55098');
});

test('domestic Places request body is byte-identical when no intl opts are given', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { seen.push(init.body); return new Response('{"places":[]}'); };
  try {
    await placesTextSearch({ GOOGLE_PLACES_API_KEY: 'k' }, 'plumber Mesa AZ');
    await placesTextSearch({ GOOGLE_PLACES_API_KEY: 'k' }, 'renta de yates Cabo', undefined,
                           { regionCode: 'mx', languageCode: 'es' });
  } finally { globalThis.fetch = orig; }
  assert.equal(seen[0], '{"textQuery":"plumber Mesa AZ","maxResultCount":20}');
  assert.deepEqual(JSON.parse(seen[1]), { textQuery: 'renta de yates Cabo', maxResultCount: 20,
                                          regionCode: 'mx', languageCode: 'es' });
});

test('domestic placesReject still has its 150-review ceiling', () => {
  assert.match(placesReject({ review_count: 151, rating: 4.9 }), /too established/);
});

test('existing rows default to profile=domestic, country=US', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env);
  const r = db.prepare("SELECT DISTINCT profile, country FROM lead_sources").all();
  assert.deepEqual(r.map(x => ({ ...x })), [{ profile: 'domestic', country: 'US' }]);
});

test('domestic ?reseed=1 does not wipe intl rows, and intl reseed does not wipe domestic', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env);
  const nIntl = await seedIntlSources(env);
  assert.ok(nIntl > 0);
  const count = (p) => Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile = ?").get(p).c);
  const dom = count('domestic');
  db.prepare("UPDATE lead_sources SET last_run_at = 'x' WHERE profile = 'intl'").run();

  await seedLeadSources(env, true);
  assert.equal(count('intl'), nIntl, 'intl untouched by domestic reseed');
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='intl' AND last_run_at='x'").get().c), nIntl);
  assert.equal(count('domestic'), dom);

  db.prepare("UPDATE lead_sources SET last_run_at = 'y' WHERE profile = 'domestic'").run();
  await seedIntlSources(env, true);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='domestic' AND last_run_at='y'").get().c), dom);
  assert.equal(count('intl'), nIntl);
});

test('intl rows seeded first do not stop the domestic grid seeding', async () => {
  const { env } = await freshEnv();
  await seedIntlSources(env);
  assert.equal(await seedLeadSources(env), 2356);
});

test('domestic category toggles and list ignore intl rows', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env); await seedIntlSources(env);
  const intlOnBefore = Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='intl' AND enabled=1").get().c);
  const segs = await listSegments(env);
  assert.deepEqual(segs.map(s => s.key), LEAD_SEGMENTS);
  await setSegmentEnabled(env, 'home_service', false);
  await setSegmentEnabled(env, 'detailer', true);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='intl' AND enabled=1").get().c), intlOnBefore);
  await assert.rejects(() => setSegmentEnabled(env, 'intl_yacht_charter', true));
});

test('a domestic run never searches an intl source', async () => {
  const { env } = await freshEnv();
  await seedLeadSources(env); await seedIntlSources(env);
  const queries = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { queries.push(JSON.parse(init.body).textQuery); return new Response('{"places":[]}'); };
  try { await runLeadPipeline(env, { dryRun: true }); } finally { globalThis.fetch = orig; }
  assert.equal(queries.length, 2);
  for (const q of queries) assert.doesNotMatch(q, /Cabo|yate|yacht/i);
  for (const q of queries) assert.doesNotMatch(q, /,/, 'domestic query format "{q} {city} {state}" unchanged');
});

test('recheck never touches intl leads', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (business_name, website_url, status, created_at, updated_at, created_by_pipeline, lead_segment, country)
              VALUES ('Cabo Yachts','https://caboyachts.com','lead',?,?,1,'intl_yacht_charter','MX')`).run(now, now);
  let called = 0;
  const r = await recheckLeads(env, { deps: { pageSpeed: async () => { called++; return { performance: 99, hasViewport: true }; } } });
  assert.equal(called, 0); assert.equal(r.looked, 0);
  assert.equal(db.prepare("SELECT status FROM clients").get().status, 'lead');
});

test('MX phone formats normalise together for dedupe', () => {
  for (const v of ['+52 624 143 1234', '624 143 1234', '+52 1 624 143 1234', '(624) 143-1234', '52-624-143-1234'])
    assert.equal(normalisePhone(v), '6241431234');
});

// ── Phase 1: intl grid ───────────────────────────────────────────────────
test('intl grid ships disabled except Cabo San Lucas × yacht charter, with EN+ES variants', async () => {
  const { env, db } = await freshEnv();
  await seedIntlSources(env);
  const on = db.prepare("SELECT DISTINCT segment, city, country FROM lead_sources WHERE profile='intl' AND enabled=1").all();
  assert.deepEqual(on.map(x => ({ ...x })), [{ segment: 'intl_yacht_charter', city: 'Cabo San Lucas', country: 'MX' }]);
  const langs = db.prepare("SELECT DISTINCT language FROM lead_sources WHERE profile='intl' AND enabled=1 ORDER BY language").all();
  assert.deepEqual(langs.map(x => x.language), ['en', 'es']);
  const qs = db.prepare("SELECT query_template FROM lead_sources WHERE profile='intl' AND enabled=1").all().map(x => x.query_template);
  assert.ok(qs.includes('yacht charter') && qs.includes('renta de yates'));
  assert.ok(INTL_SEGMENTS.length >= 15);
  assert.equal(await seedIntlSources(env), 0, 'idempotent');
});

test('intl toggles: enable a city, disable a segment, never domestic', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env); await seedIntlSources(env);
  const domOn = Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='domestic' AND enabled=1").get().c);
  await setIntlSourcesEnabled(env, 'intl_yacht_charter', true, 'Puerto Vallarta');
  let y = (await listIntlSegments(env)).find(s => s.key === 'intl_yacht_charter');
  assert.deepEqual(y.cities, ['Cabo San Lucas', 'Puerto Vallarta']);
  await setIntlSourcesEnabled(env, 'intl_yacht_charter', false);
  y = (await listIntlSegments(env)).find(s => s.key === 'intl_yacht_charter');
  assert.equal(y.enabled, false);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE profile='domestic' AND enabled=1").get().c), domOn);
  await assert.rejects(() => setIntlSourcesEnabled(env, 'home_service', true));
  await assert.rejects(() => setIntlSourcesEnabled(env, 'intl_tours', true, 'Atlantis'));
});

test('intl screen: website required, no review ceiling, rating floor kept', () => {
  assert.equal(intlReject({ website: 'https://caboyachts.com', review_count: 900, rating: 4.8 }), null);
  assert.match(intlReject({ website: '', review_count: 80, rating: 4.8 }), /no website/);
  assert.match(intlReject({ website: 'https://facebook.com/cabo', review_count: 80, rating: 4.8 }), /facebook/);
  assert.match(intlReject({ website: 'https://x.mx', review_count: 2, rating: 5 }), /reviews/);
  assert.match(intlReject({ website: 'https://x.mx', review_count: 50, rating: 3.6 }), /cut-off/);
  assert.ok(intlPromise({ review_count: 900, rating: 4.9, website: 'https://a.mx' }) >
            intlPromise({ review_count: 12, rating: 4.1, website: 'http://a.mx' }));
});

test('intl verdict: unreachable site rejected; role email ranks higher', () => {
  const p = { review_count: 120, rating: 4.8, website: 'https://a.mx' };
  assert.equal(intlVerdict(p, { ok: false, error: 'homepage 500' }).qualified, false);
  const base = { ok: true, pages: [{ url: 'https://a.mx/' }], phones: [], whatsapp: [] };
  const withRole = intlVerdict(p, { ...base, emails: [{ email: 'info@a.mx', type: 'role' }] });
  const none = intlVerdict(p, { ...base, emails: [] });
  assert.ok(withRole.qualified && none.qualified && withRole.score > none.score);
  assert.match(withRole.reason, /info@a\.mx/);
});

// ── Phase 1: crawl ───────────────────────────────────────────────────────
test('role allowlist and domain relatedness', () => {
  for (const l of ['info', 'reservaciones', 'ventas', 'booking', 'contacto', 'hello', 'office', 'marketing', 'sales', 'info2', 'ventas.cabo'])
    assert.ok(isRoleLocal(l), l);
  for (const l of ['juan.perez', 'maria', 'jsmith']) assert.ok(!isRoleLocal(l), l);
  assert.equal(baseDomain('https://www.tours.caboyachts.com.mx/x'), 'caboyachts.com.mx');
  assert.ok(relatedDomain('cabo-yachts.mx', 'https://caboyachts.com'));
  assert.ok(!relatedDomain('wix.com', 'https://caboyachts.com'));
  assert.deepEqual(classifyEmail('info@caboyachts.com', 'https://www.caboyachts.com'), { type: 'role', eligibility: 'pending_verification' });
  assert.equal(classifyEmail('juan.perez@caboyachts.com', 'https://caboyachts.com').eligibility, 'excluded');
  assert.equal(classifyEmail('info@wixpress.com', 'https://caboyachts.com'), null);
  assert.equal(classifyEmail('caboyachts@gmail.com', 'https://caboyachts.com').eligibility, 'review');
});

test('email extraction: mailto, visible text, Cloudflare-protected; not image names', () => {
  // "info@x.mx" XOR 0x42
  const enc = '42' + Buffer.from('info@x.mx').map(b => b ^ 0x42).toString('hex');
  assert.equal(decodeCfEmail(enc), 'info@x.mx');
  const got = extractEmails(`<a href="mailto:Reservaciones@X.mx?subject=hi">r</a>
     <p>Write ventas [at] x.mx or hello@x.mx</p><img src="logo@2x.png">
     <span data-cfemail="${enc}"></span><script>var a="bot@x.mx"</script>`).sort();
  assert.deepEqual(got, ['hello@x.mx', 'info@x.mx', 'reservaciones@x.mx', 'ventas@x.mx']);
});

test('robots.txt parsing', () => {
  const allowed = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/contact\n', 'PotentiaLeadBot/1.0');
  assert.equal(allowed('/'), true);
  assert.equal(allowed('/private/x'), false);
  assert.equal(allowed('/private/contact'), true);
  assert.equal(parseRobots('User-agent: *\nDisallow: /\n', 'x')('/contacto'), false);
});

test('link selection: same site, contact/about/reservation pages only, contact first', () => {
  const l = candidateLinks(`<a href="/about-us">About</a><a href="/gallery">Fotos</a>
    <a href="https://other.com/contact">x</a><a href="/es/contacto">Contáctanos</a>
    <a href="/r">Reservaciones</a><a href="mailto:a@b.c">m</a>`, 'https://www.cabo.mx/');
  assert.deepEqual(l, ['https://www.cabo.mx/es/contacto', 'https://www.cabo.mx/about-us', 'https://www.cabo.mx/r']);
});

function fakeSite(pages) {
  const hits = [];
  const f = async (url) => {
    hits.push(url);
    const p = pages[url];
    if (!p) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(p.body, { status: p.status || 200, headers: { 'content-type': p.type || 'text/html' } });
  };
  return { f, hits };
}

const CABO = {
  'https://caboyachts.example.mx/robots.txt': { body: 'User-agent: *\nDisallow: /privado', type: 'text/plain' },
  'https://caboyachts.example.mx/': { body: `<h1>Cabo Yachts</h1>
      <a href="/contacto">Contacto</a><a href="/privado/reservaciones">Reservaciones</a>
      <a href="/nosotros">Nosotros</a><a href="/fleet">Fleet</a>
      <a href="tel:+52 624 143 1234">call</a><a href="https://wa.me/5216241431234">WA</a>
      <footer>info@caboyachts.example.mx</footer>` },
  'https://caboyachts.example.mx/contacto': { body: `<a href="mailto:reservaciones@caboyachts.example.mx">r</a>
      <p>Capitán: juan.perez@caboyachts.example.mx · partner: sales@wix.com</p>` },
  'https://caboyachts.example.mx/nosotros': { body: '<p>Since 1998</p>' },
};

test('crawl: robots honoured, role emails kept with source URL, personal excluded, never guessed', async () => {
  const { f, hits } = fakeSite(CABO);
  const r = await crawlSite('https://caboyachts.example.mx', { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.ok(!hits.some(h => h.includes('/privado')), 'robots disallow honoured');
  assert.ok(r.pages.length <= 6);
  assert.deepEqual(r.emails.map(e => e.email).sort(),
    ['info@caboyachts.example.mx', 'reservaciones@caboyachts.example.mx']);
  assert.equal(r.emails.find(e => e.email.startsWith('reserv')).source_url, 'https://caboyachts.example.mx/contacto');
  assert.equal(r.excluded, 2, 'personal + off-domain counted, not stored');
  assert.deepEqual(r.phones, ['+526241431234']);
  assert.deepEqual(r.whatsapp, ['5216241431234']);
});

test('crawl: dead homepage is a result, not a throw', async () => {
  const r = await crawlSite('https://dead.example.mx', { fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

// ── Phase 1: end-to-end intl run ─────────────────────────────────────────
const PLACES = [
  { place_id: 'P1', name: 'Cabo Yachts', website: 'https://caboyachts.example.mx', phone: '624 143 1234',
    address: 'Marina, Cabo San Lucas, B.C.S., Mexico', rating: 4.9, review_count: 640, photo_count: 40, status: 'OPERATIONAL' },
  { place_id: 'P2', name: 'FB Only Charters', website: 'https://facebook.com/fbc', rating: 4.8, review_count: 90, status: 'OPERATIONAL' },
  { place_id: 'P3', name: 'No Site Pesca', website: '', rating: 4.7, review_count: 40, status: 'OPERATIONAL' },
];
function intlDeps(calls) {
  const { f } = fakeSite(CABO);
  return {
    placesTextSearch: async (env, q, sig, opts) => { calls.push({ q, opts }); return calls.length === 1 ? PLACES : []; },
    crawlSite: (u) => crawlSite(u, { fetchImpl: f })
  };
}

test('intl plan mode makes no network call and lists the Cabo searches', async () => {
  const { env } = await freshEnv();
  const orig = globalThis.fetch; let net = 0;
  globalThis.fetch = async () => { net++; throw new Error('no network in plan'); };
  let out;
  try { out = await runLeadPipeline(env, { profile: 'intl', plan: true }); } finally { globalThis.fetch = orig; }
  assert.equal(net, 0);
  assert.equal(out.searches.length, 2);
  for (const s of out.searches) assert.match(s.query, /Cabo San Lucas, Baja California Sur$/);
  assert.equal(out.est_cost_usd, 0.07);
});

test('intl dry run: screens, crawls, previews emails, writes nothing to clients', async () => {
  const { env, db } = await freshEnv();
  const calls = [];
  const out = await runLeadPipeline(env, { profile: 'intl', dryRun: true, deps: intlDeps(calls) });
  assert.equal(calls[0].opts.regionCode, 'mx');
  assert.ok(['en', 'es'].includes(calls[0].opts.languageCode));
  assert.equal(out.screened, 2);
  assert.equal(out.preview.length, 1);
  assert.deepEqual(out.preview[0].emails.map(e => e.email).sort(),
    ['info@caboyachts.example.mx', 'reservaciones@caboyachts.example.mx']);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM clients").get().c), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_emails").get().c), 0);
  assert.equal(db.prepare("SELECT status FROM lead_candidates WHERE place_id='P1'").get().status, 'new');
});

test('intl real run: pushes intl_yacht_charter lead with MX/city and lead_emails; strips Places content', async () => {
  const { env, db } = await freshEnv();
  const out = await runLeadPipeline(env, { profile: 'intl', deps: intlDeps([]) });
  assert.equal(out.pushed, 1, JSON.stringify(out.errors));
  const c = db.prepare("SELECT * FROM clients").get();
  assert.equal(c.lead_segment, 'intl_yacht_charter');
  assert.equal(c.country, 'MX');
  assert.equal(c.city, 'Cabo San Lucas');
  assert.equal(c.status, 'lead');
  assert.equal(c.source, 'pipeline_intl');
  assert.ok(['info@caboyachts.example.mx', 'reservaciones@caboyachts.example.mx'].includes(c.email));
  assert.equal(c.phone, '+526241431234', 'phone from the site, not Places');
  assert.equal(c.lead_address, '', 'Places street address not stored');
  const em = db.prepare("SELECT * FROM lead_emails WHERE client_id = ? ORDER BY email").all(c.id);
  assert.equal(em.length, 2);
  assert.equal(em[0].verification_status, 'unverified');
  assert.equal(em[0].opted_out, 0);
  assert.ok(em.every(e => e.source_url && e.discovered_at && e.type === 'role'));
  const cand = db.prepare("SELECT * FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(cand.status, 'pushed'); assert.equal(cand.places_json, null);
  const run = db.prepare("SELECT * FROM enrichment_runs").get();
  assert.equal(run.trigger, 'manual_intl');
  // Domestic list/batch cannot see it: the next domestic run leaves it alone.
  assert.ok(!(await listSegments(env)).some(s => s.key.startsWith('intl_')));
});

test('intl run respects its own daily cap', async () => {
  const { env, db } = await freshEnv({ LEADS_INTL_DAILY_USD_CAP: '0.01' });
  const calls = [];
  const out = await runLeadPipeline(env, { profile: 'intl', dryRun: true, deps: intlDeps(calls) });
  assert.equal(calls.length, 0);
  assert.match(out.errors.join(' '), /ceiling/);
});

test('crawl: a redirect to a sister domain still keeps role emails for either domain', async () => {
  const f = async (url) => {
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const r = new Response('<p>info@redrum.example.com and reservas@marvida.example.com</p>',
                           { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(r, 'url', { value: 'https://marvida.example.com/' });
    return r;
  };
  const r = await crawlSite('https://www.redrum.example.com', { fetchImpl: f });
  assert.deepEqual(r.emails.map(e => e.email).sort(), ['info@redrum.example.com', 'reservas@marvida.example.com']);
});

test('intl run: a homepage that times out is retried later, not rejected', async () => {
  const { env, db } = await freshEnv();
  const out = await runLeadPipeline(env, { profile: 'intl', deps: {
    placesTextSearch: async () => [PLACES[0]],
    crawlSite: async () => ({ ok: false, home_status: null, error: 'timeout', pages: [], emails: [], phones: [], whatsapp: [] }) } });
  assert.equal(out.rejected, 0);
  const c = db.prepare("SELECT status, attempts FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(c.status, 'new'); assert.equal(c.attempts, 1);
});
