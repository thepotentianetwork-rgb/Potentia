/* The lead pipeline's rules, exercised against a real SQLite database.
 *
 * The three things worth proving here are the ones that cost money or lose
 * data if they break: it never pays twice for the same business, it never
 * touches a CRM row a human owns, and it never keeps Places content past the
 * moment it judges a candidate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  normalisePhone, registrableDomain, findExisting, ensureLeadPipelineTables,
  pushLeadToCrm, stripCandidate, spentToday, withRetry, parseClaudeJson,
  parseGrokJson, enrichmentSchemaFor, defaultSources, seedLeadSources,
  offerName, LEAD_DEFAULTS
} from './leadpipeline.js';

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

async function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT, contact_name TEXT,
    email TEXT, phone TEXT, website_url TEXT, package TEXT,
    status TEXT NOT NULL DEFAULT 'lead', source TEXT, service TEXT, message TEXT,
    build_fee REAL, monthly_fee REAL, domain TEXT, domain_renews_at TEXT,
    launched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const env = { CRM_DB: makeD1(db) };
  await ensureLeadPipelineTables(env);
  return { env, db };
}

// ── pure helpers ──────────────────────────────────────────────────────────
test('phones normalise to the last 10 digits', () => {
  for (const v of ['(435) 232-9516', '+1 435-232-9516', '4352329516', '1-435-232-9516'])
    assert.equal(normalisePhone(v), '4352329516');
  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone(null), null);
});

test('domains normalise across scheme, www, path and query', () => {
  for (const v of ['https://www.Acme-Concrete.com/', 'acme-concrete.com',
                   'http://acme-concrete.com/quote?utm=fb', 'https://ACME-CONCRETE.com'])
    assert.equal(registrableDomain(v), 'acme-concrete.com');
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain(null), null);
});

test('the enrichment schema is segment-specific and Anthropic-legal', () => {
  const dealer = enrichmentSchemaFor('dealer');
  const trade = enrichmentSchemaFor('contractor');
  assert.ok('inventory_gap' in dealer.properties, 'dealers get the inventory gap');
  assert.ok(!('inventory_gap' in trade.properties), 'contractors do not');
  assert.ok('shows_license_or_insured' in trade.properties);
  for (const s of [dealer, trade]) {
    assert.equal(s.additionalProperties, false, 'structured outputs require this');
    assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort());
  }
});

test('mobile_friendly is nullable — unknown must not read as false', () => {
  const t = enrichmentSchemaFor('handyman').properties.mobile_friendly;
  assert.deepEqual(t.type, ['boolean', 'null']);
});

// ── dedupe: never pay twice ───────────────────────────────────────────────
test('a business already in the CRM is caught on place_id, phone OR domain', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (business_name, phone, website_url, status, created_at, updated_at, place_id)
              VALUES ('Acme Concrete','(435) 232-9516','https://www.acme-concrete.com/','lead',?,?,'PLACE_A')`)
    .run(now, now);

  assert.ok(await findExisting(env, { place_id: 'PLACE_A' }), 'same place_id');
  // Same shop, re-listed under a new place_id — phone still gives it away.
  const byPhone = await findExisting(env, { place_id: 'PLACE_NEW', phone: '+1 435-232-9516' });
  assert.equal(byPhone && byPhone.on, 'phone');
  const byDomain = await findExisting(env, { place_id: 'PLACE_NEW2', website: 'acme-concrete.com/contact' });
  assert.equal(byDomain && byDomain.on, 'domain');
  assert.equal(await findExisting(env, { place_id: 'OTHER', phone: '8015550000' }), null);
});

test('a candidate already judged is not re-sourced', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  // A rejected tombstone: place_id and a score, no Places content at all.
  db.prepare(`INSERT INTO lead_candidates (place_id, segment, status, score, created_at, updated_at)
              VALUES ('PLACE_R','handyman','rejected',18,?,?)`).run(now, now);
  const hit = await findExisting(env, { place_id: 'PLACE_R' });
  assert.equal(hit && hit.where, 'lead_candidates');
});

// ── rule 2: the pipeline never overwrites ─────────────────────────────────
test('pushing a lead inserts and never touches an existing row', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (business_name, phone, status, message, created_at, updated_at)
              VALUES ('Acme Concrete','4352329516','proposal','Called Tue - wants a quote',?,?)`).run(now, now);
  const before = db.prepare("SELECT * FROM clients WHERE id = 1").get();

  await pushLeadToCrm(env,
    { place_id: 'PLACE_B', segment: 'contractor' },
    { name: 'Different Co', address: '1 Main St', phone: '8015551234', website: '' },
    { notes: 'no website found', contact_phone: '8015551234', contact_website: null },
    { best_offer: 1, score: 88, reason: 'no site', opener: 'Hi —' });

  const after = db.prepare("SELECT * FROM clients WHERE id = 1").get();
  assert.deepEqual(after, before, 'the human-owned row is byte-identical');
  const rows = db.prepare("SELECT COUNT(*) AS c FROM clients").get();
  assert.equal(Number(rows.c), 2, 'the new lead was inserted alongside it');
});

test('a pushed lead lands as status lead, flagged as pipeline-made', async () => {
  const { env, db } = await freshEnv();
  const id = await pushLeadToCrm(env,
    { place_id: 'PLACE_C', segment: 'dealer' },
    { name: 'Valley Autos', address: '2 Main St', phone: '', website: '' },
    { notes: '', contact_phone: '9285550000', contact_website: 'valleyautos.com' },
    { best_offer: 3, score: 71, reason: 'FB daily, site stale', opener: 'Saw your Facebook —' });
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

  // 'ready to call' would fail the CRM's own status validation, so leads land
  // as 'lead' and rank on lead_score.
  assert.equal(row.status, 'lead');
  assert.equal(row.created_by_pipeline, 1);
  assert.equal(row.do_not_contact, 0);
  assert.equal(row.lead_score, 71);
  assert.equal(row.lead_offer, 3);
  assert.equal(row.place_id, 'PLACE_C');
  assert.equal(row.service, offerName(3));
  assert.match(row.lead_opener, /Facebook/);
  // Contact details came from what the business publishes, not from Places.
  assert.equal(row.phone, '9285550000');
  assert.equal(row.website_url, 'valleyautos.com');
});

// ── rule 1: Places content does not outlive the judgement ─────────────────
test('judging a candidate strips every byte of Places and research content', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  const places = { place_id: 'PLACE_D', name: 'Bob Handyman', address: '9 Elm St',
                   phone: '4355551111', website: '', rating: 4.8, review_count: 31 };
  db.prepare(`INSERT INTO lead_candidates
      (place_id, segment, status, places_json, places_fetched_at, enrichment_json, opener, created_at, updated_at)
      VALUES ('PLACE_D','handyman','scored',?,?,?,'Hi Bob —',?,?)`)
    .run(JSON.stringify(places), now, JSON.stringify({ notes: 'no site' }), now, now);

  await stripCandidate(env, 1, 'rejected', 22, 'has a decent site already', null);
  const row = db.prepare("SELECT * FROM lead_candidates WHERE id = 1").get();

  assert.equal(row.places_json, null, 'no Places content kept');
  assert.equal(row.enrichment_json, null, 'no research kept');
  assert.equal(row.opener, null);
  // What survives: the permanently-storable id, and our own numbers.
  assert.equal(row.place_id, 'PLACE_D');
  assert.equal(row.status, 'rejected');
  assert.equal(row.score, 22);
  assert.match(row.reason, /decent site/);

  const blob = JSON.stringify(row);
  for (const leaked of ['Bob Handyman', '9 Elm St', '4355551111', '4.8'])
    assert.ok(!blob.includes(leaked), 'must not still hold ' + leaked);
});

// ── the cost ceiling ──────────────────────────────────────────────────────
test('spend is summed over a rolling 24 hours, not all time', async () => {
  const { env, db } = await freshEnv();
  const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO enrichment_runs (trigger, started_at, est_cost_usd) VALUES ('cron',?,1.25)").run(recent);
  db.prepare("INSERT INTO enrichment_runs (trigger, started_at, est_cost_usd) VALUES ('cron',?,9.99)").run(old);
  assert.equal(await spentToday(env), 1.25, 'yesterday does not count against today');
});

// ── retries ───────────────────────────────────────────────────────────────
test('withRetry gives up after three attempts and rethrows the last error', async () => {
  let calls = 0;
  const nap = async () => {};
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('xAI 503'); }, nap),
    /xAI 503/);
  assert.equal(calls, 3, 'one try plus two retries');

  calls = 0;
  const ok = await withRetry(async () => { calls++; if (calls < 2) throw new Error('flaky'); return 'fine'; }, nap);
  assert.equal(ok, 'fine');
  assert.equal(calls, 2, 'stops as soon as it succeeds');
});

// ── response parsing ──────────────────────────────────────────────────────
test('Claude JSON is found past thinking blocks, and the score is clamped', () => {
  const out = parseClaudeJson({
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '{"best_offer":2,"score":140,"reason":"r","opener":"o"}' }
    ]
  });
  // The schema cannot express 0-100 (Anthropic rejects numeric constraints),
  // so the clamp is the only thing standing between 140 and the CRM.
  assert.equal(out.score, 100);
  assert.equal(out.best_offer, 2);
});

test('a Claude refusal is an error, not a silent zero', () => {
  assert.throws(() => parseClaudeJson({ stop_reason: 'refusal', content: [] }), /declined/);
});

test('Grok JSON is found whether it arrives flat or nested past tool calls', () => {
  assert.equal(parseGrokJson({ output_text: '{"has_website":false}' }).has_website, false);
  const nested = parseGrokJson({
    output: [
      { type: 'web_search_call', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: '{"has_website":true}' }] }
    ]
  });
  assert.equal(nested.has_website, true);
  assert.throws(() => parseGrokJson({ output: [] }), /no JSON/);
});

// ── the search grid ───────────────────────────────────────────────────────
test('Utah ships disabled, California and Arizona ship enabled', async () => {
  const rows = defaultSources();
  const ut = rows.filter(r => r.state === 'UT');
  assert.ok(ut.length > 0);
  assert.ok(ut.every(r => r.enabled === 0), 'nothing local is called until it is switched on');
  assert.ok(rows.filter(r => r.state !== 'UT').every(r => r.enabled === 1));
  for (const seg of ['contractor', 'handyman', 'dealer'])
    assert.ok(rows.some(r => r.segment === seg), seg + ' is covered');
});

test('seeding is idempotent — a second call adds nothing', async () => {
  const { env, db } = await freshEnv();
  const first = await seedLeadSources(env);
  assert.ok(first > 0);
  assert.equal(await seedLeadSources(env), 0, 'does not duplicate the grid on restart');
  const n = db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get();
  assert.equal(Number(n.c), first);
});

// ── the whole run, with the three APIs stubbed ────────────────────────────
import { runLeadPipeline } from './leadpipeline.js';

function stubFetch(handlers) {
  const calls = { places: 0, xai: 0, anthropic: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (u.includes('places.googleapis.com')) { calls.places++; return handlers.places(body); }
    if (u.includes('api.x.ai')) { calls.xai++; return handlers.xai(body); }
    if (u.includes('api.anthropic.com')) { calls.anthropic++; return handlers.anthropic(body); }
    throw new Error('unexpected fetch: ' + u);
  };
  return calls;
}
const ok = obj => new Response(JSON.stringify(obj), { status: 200 });

const PLACE = n => ({
  id: 'P' + n, displayName: { text: 'Biz ' + n }, formattedAddress: n + ' Main St',
  nationalPhoneNumber: '801555000' + n, websiteUri: '', rating: 4.5,
  userRatingCount: 10, businessStatus: 'OPERATIONAL'
});

async function seededEnv(extra) {
  const { env, db } = await freshEnv();
  // One enabled source so the grid is deterministic.
  db.prepare(`INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
              VALUES ('handyman','Fresno','CA','handyman',1,1,?)`).run(new Date().toISOString());
  Object.assign(env, { GOOGLE_PLACES_API_KEY: 'k', XAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, extra || {});
  return { env, db };
}

test('dry run sources and dedupes without spending a cent on AI', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2), PLACE(3)] }),
    xai: () => { throw new Error('dry run must not call xAI'); },
    anthropic: () => { throw new Error('dry run must not call Anthropic'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(out.sourced, 3);
  assert.equal(calls.xai, 0);
  assert.equal(calls.anthropic, 0);
  assert.equal(out.pushed, 0);
  const n = db.prepare("SELECT COUNT(*) AS c FROM lead_candidates WHERE status='new'").get();
  assert.equal(Number(n.c), 3, 'candidates are staged, ready for a real run');
});

test('a full run scores, pushes the good one and rejects the rest', async () => {
  const { env, db } = await seededEnv();
  let score = 90;
  stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'no site anywhere',
      source_urls: ['https://example.com'], contact_phone: '8015550001',
      contact_website: null, web_presence: 'none', site_is_http_only: null,
      shows_license_or_insured: null, does_subcontract_work: false }) }),
    anthropic: () => {
      const s = score; score = 20;   // first qualifies, second does not
      return ok({ stop_reason: 'end_turn', content: [{ type: 'text',
        text: JSON.stringify({ best_offer: 1, score: s, reason: 'r', opener: 'o' }) }] });
    }
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.enriched, 2);
  assert.equal(out.scored, 2);
  assert.equal(out.pushed, 1);
  assert.equal(out.rejected, 1);

  const leads = db.prepare("SELECT * FROM clients WHERE created_by_pipeline = 1").all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].lead_score, 90);

  // Both candidates judged, both stripped.
  const left = db.prepare("SELECT places_json, enrichment_json FROM lead_candidates").all();
  assert.ok(left.every(r => r.places_json === null && r.enrichment_json === null));

  const run = db.prepare("SELECT * FROM enrichment_runs ORDER BY id DESC LIMIT 1").get();
  assert.ok(run.est_cost_usd > 0, 'the run logged what it spent');
  assert.ok(run.finished_at, 'and closed itself out');
});

test('the daily ceiling stops a run before it spends', async () => {
  const { env, db } = await seededEnv({ LEADS_DAILY_USD_CAP: '0.01' });
  db.prepare("INSERT INTO enrichment_runs (trigger, started_at, est_cost_usd) VALUES ('cron',?,5.0)")
    .run(new Date().toISOString());
  const calls = stubFetch({
    places: () => { throw new Error('must not source over the ceiling'); },
    xai: () => { throw new Error('must not enrich over the ceiling'); },
    anthropic: () => { throw new Error('must not score over the ceiling'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'cron' });
  assert.equal(calls.places + calls.xai + calls.anthropic, 0, 'no paid call was made');
  assert.ok(out.errors.join(' ').includes('ceiling'));
});

test('a do_not_contact business is never re-sourced into the CRM', async () => {
  const { env, db } = await seededEnv();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (business_name, phone, status, created_at, updated_at, place_id, do_not_contact)
              VALUES ('Biz 1','8015550001','lost',?,?,'P1',1)`).run(now, now);
  stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    xai: () => { throw new Error('must not enrich a do_not_contact business'); },
    anthropic: () => { throw new Error('must not score a do_not_contact business'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.deduped, 1, 'caught by the existing CRM row');
  assert.equal(out.pushed, 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM clients").get().c), 1, 'no second row');
});

test('a candidate that keeps failing is retired after three attempts', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    xai: () => new Response('upstream on fire', { status: 503 }),
    anthropic: () => { throw new Error('never reached'); }
  });
  for (let i = 0; i < 3; i++) await runLeadPipeline(env, { trigger: 'cron', limit: 1 });
  const row = db.prepare("SELECT * FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(row.status, 'failed');
  assert.ok(row.attempts >= LEAD_DEFAULTS.maxAttempts);
  assert.match(row.last_error, /503/);
});
