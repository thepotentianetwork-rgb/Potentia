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
  offerName, LEAD_DEFAULTS, scorePrompt, placesReject, placesPromise,
  apiKey, providerError
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
test('only subcontractors and general contractors are switched on', () => {
  const rows = defaultSources();
  const on = rows.filter(r => r.enabled);
  const segs = [...new Set(on.map(r => r.segment))].sort();
  assert.deepEqual(segs, ['general', 'subcontractor'],
    'handymen and dealers are seeded but off until asked for');
  // Still present, so switching either back on is one UPDATE, not a reseed.
  for (const seg of ['handyman', 'dealer'])
    assert.ok(rows.some(r => r.segment === seg), seg + ' is still in the grid');
});

test('Utah ships disabled in every segment', () => {
  const ut = defaultSources().filter(r => r.state === 'UT');
  assert.ok(ut.length > 0);
  assert.ok(ut.every(r => r.enabled === 0), 'nothing local is called until it is switched on');
});

test('the enabled grid is mostly subcontractors', () => {
  const on = defaultSources().filter(r => r.enabled);
  const subs = on.filter(r => r.segment === 'subcontractor').length;
  assert.ok(subs / on.length > 0.7, 'subs are the target, GCs ride along');
});

test('establishment is a first-class enrichment field for trades, not dealers', () => {
  const trade = enrichmentSchemaFor('subcontractor');
  assert.ok('establishment' in trade.properties);
  assert.ok('establishment_evidence' in trade.properties,
    'the caller needs to know what the judgement was based on');
  assert.ok(trade.properties.establishment.type.includes('null'),
    'unknown must stay expressible — a guess here keeps the caller off good leads');
  assert.ok(!('establishment' in enrichmentSchemaFor('dealer').properties));
});

test('the scoring prompt gates on establishment, hardest for general contractors', () => {
  const prompt = scorePrompt('general',
    { name: 'Big Build Co', address: '1 Main St' },
    { establishment: 'established' });
  assert.match(prompt, /established\s+-> cap the score at 30/,
    'an established firm must be capped out of calling range');
  assert.match(prompt, /GENERAL CONTRACTOR/, 'GCs are held to a stricter bar');
  assert.match(prompt, /do not guess/, 'null establishment must not be invented');
});

test('the free triage vetoes the dead and the too-big, and nothing between', () => {
  // Under 5 reviews: no evidence the business actually trades.
  assert.match(placesReject({ review_count: 2 }), /reviews/);
  assert.match(placesReject({ review_count: null }), /no reviews/);
  // Over 150: they can afford an agency and are not buying a cheap site.
  assert.match(placesReject({ review_count: 400 }), /too established/);
  // The whole band in between is somebody's problem to research, not to veto.
  assert.equal(placesReject({ review_count: 5 }), null);
  assert.equal(placesReject({ review_count: 150 }), null);
});

test('promise ranks the profile: mid reviews, no site, few photos', () => {
  const ideal = placesPromise({ review_count: 24, website: '', photo_count: 3 });
  const hasSite = placesPromise({ review_count: 24, website: 'x.com', photo_count: 3 });
  const tended = placesPromise({ review_count: 24, website: '', photo_count: 50 });
  const big = placesPromise({ review_count: 140, website: '', photo_count: 3 });

  assert.equal(ideal, 100);
  assert.ok(hasSite < ideal, 'an existing site is the weakest lead of the four');
  assert.ok(tended < ideal, 'a listing somebody tends is a worse lead');
  assert.ok(big < ideal, 'near the review ceiling is a worse lead');
  // Always a usable ORDER BY key.
  for (const v of [ideal, hasSite, tended, big]) {
    assert.ok(v >= 0 && v <= 100 && Number.isFinite(v));
  }
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

test('a reseed replaces the grid; without force it leaves it alone', async () => {
  const { env, db } = await freshEnv();
  const first = await seedLeadSources(env);
  assert.ok(first > 0);

  // Someone switches a Utah row on by hand.
  db.prepare("UPDATE lead_sources SET enabled = 1 WHERE state = 'UT'").run();
  const utOn = () => Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE state='UT' AND enabled=1").get().c);
  assert.ok(utOn() > 0);

  // A normal run must not touch it.
  assert.equal(await seedLeadSources(env), 0, 'no force, no change');
  assert.ok(utOn() > 0, 'the manual enable survives an ordinary run');

  // A forced reseed replaces the grid — and drops that manual enable with it.
  await seedLeadSources(env, true);
  assert.equal(utOn(), 0, 'reseed returns every row to what the code ships');
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c), first,
    'replaced, not appended — a reseed must not double the grid');
});

/* PLACE(n) is the middle of the band on purpose, so the triage passes it.
   These two build the edges. */
const DEAD = n => Object.assign(PLACE(n), { userRatingCount: 1 });
const HUGE = n => Object.assign(PLACE(n), { userRatingCount: 900 });
const TENDED = n => Object.assign(PLACE(n), {
  websiteUri: 'https://biz' + n + '.com',
  photos: new Array(60).fill({ name: 'p' })
});

test('hopeless candidates are vetoed at sourcing, before any paid call', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [DEAD(1), HUGE(2), PLACE(3)] }),
    xai: () => { throw new Error('a vetoed candidate must never reach xAI'); },
    anthropic: () => { throw new Error('a vetoed candidate must never reach Anthropic'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(out.sourced, 3);
  assert.equal(out.screened, 2, 'the dead one and the huge one are vetoed for free');
  assert.equal(out.rejected, 0, 'nothing was researched, so nothing was rejected on merit');
  assert.equal(calls.xai + calls.anthropic, 0);

  const staged = db.prepare("SELECT COUNT(*) AS c FROM lead_candidates WHERE status='new'").get();
  assert.equal(Number(staged.c), 1, 'only the one worth researching is staged');

  /* The tombstone keeps place_id and the reason and no Places content — that
     is what stops us paying to look at this business a second time. */
  const tomb = db.prepare("SELECT * FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(tomb.status, 'rejected');
  assert.equal(tomb.places_json, null);
  assert.match(tomb.reason, /reviews/);
});

test('a vetoed business is not re-sourced on the next run', async () => {
  const { env, db } = await seededEnv();
  stubFetch({ places: () => ok({ places: [DEAD(1)] }), xai: () => { throw new Error('no'); },
              anthropic: () => { throw new Error('no'); } });
  await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  const second = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(second.screened, 0, 'the second sighting dedupes, it does not re-veto');
  assert.equal(second.deduped, 1);
  const n = db.prepare("SELECT COUNT(*) AS c FROM lead_candidates").get();
  assert.equal(Number(n.c), 1);
});

test('the run spends its budget on the most promising candidates first', async () => {
  const { env, db } = await seededEnv();
  /* TENDED(1) is sourced first and is the weaker lead: it has a website and a
     tended listing. PLACE(2) has neither. With one slot in the run, the money
     must go to PLACE(2) even though it was staged second. */
  const seen = [];
  stubFetch({
    places: () => ok({ places: [TENDED(1), PLACE(2)] }),
    xai: (body) => {
      seen.push(JSON.stringify(body).includes('Biz 2') ? 'P2' : 'P1');
      return ok({ output_text: JSON.stringify({
        has_website: false, website_quality: 'none', mobile_friendly: null,
        google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
        contact_phone: null, contact_website: null, web_presence: 'none'
      }) });
    },
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 10, best_offer: 1, reason: 'r', opener: 'o'
    }) }] })
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  assert.equal(out.enriched, 1, 'exactly one candidate was paid for');
  assert.deepEqual(seen, ['P2'], 'the money went to the better lead, not the older row');

  const left = db.prepare("SELECT place_id FROM lead_candidates WHERE status='new'").all();
  assert.deepEqual(left.map(r => r.place_id), ['P1'], 'the weaker one waits for the next run');
});

test('a run reports each stage as it happens, not only at the end', async () => {
  const { env } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 90, best_offer: 1, reason: 'r', opener: 'o'
    }) }] })
  });

  const seen = [];
  await runLeadPipeline(env, { trigger: 'manual', limit: 1, onProgress: e => seen.push(e) });
  const kinds = seen.map(e => e.event);

  /* The point of these is that they arrive DURING the run. Without them the
     request sends nothing for minutes and Cloudflare cuts it off at 100s. */
  assert.deepEqual(kinds, ['sourcing', 'sourced', 'batch', 'researching', 'scoring', 'judged']);
  const judged = seen[seen.length - 1];
  assert.equal(judged.name, 'Biz 1', 'a person watching sees a business, not a row id');
  assert.equal(judged.kept, true);
  assert.equal(judged.score, 90);
});

test('a client that hangs up mid-run does not stop the run', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 90, best_offer: 1, reason: 'r', opener: 'o'
    }) }] })
  });

  // Throws from the first event onward, the way a closed socket does.
  const out = await runLeadPipeline(env, {
    trigger: 'manual', limit: 1,
    onProgress: () => { throw new Error('socket closed'); }
  });
  assert.equal(out.pushed, 1, 'the candidate was already paid for; it must still land');
  const n = db.prepare("SELECT COUNT(*) AS c FROM clients WHERE created_by_pipeline = 1").get();
  assert.equal(Number(n.c), 1);
});

test('spend is written to the run row as it goes, not only at the end', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 10, best_offer: 1, reason: 'r', opener: 'o'
    }) }] })
  });

  /* Read the run row at the moment the FIRST candidate is judged. A run that
     is killed right here has still spent that money, and the daily ceiling
     only knows about it if the row was written on the way through. */
  let midRun = null;
  await runLeadPipeline(env, {
    trigger: 'manual', limit: 2,
    onProgress: (e) => {
      if (e.event === 'judged' && e.position === 1 && midRun === null) {
        midRun = db.prepare('SELECT est_cost_usd, scored FROM enrichment_runs ORDER BY id DESC LIMIT 1').get();
      }
    }
  });
  assert.ok(midRun, 'the first candidate was judged');
  assert.ok(Number(midRun.est_cost_usd) > 0, 'spend so far is already on the row');
  assert.equal(Number(midRun.scored), 1, 'and so is the progress');
});

test('candidates stranded by a killed run are picked back up', async () => {
  const { env, db } = await seededEnv();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const places = JSON.stringify({ place_id: 'PX', name: 'Stranded Co', review_count: 20 });

  // One left mid-flight an hour ago, one that a run is working on right now.
  db.prepare(`INSERT INTO lead_candidates (place_id, segment, status, attempts, places_json, promise, created_at, updated_at)
              VALUES ('PX','handyman','enriching',1,?,80,?,?)`).run(places, old, old);
  db.prepare(`INSERT INTO lead_candidates (place_id, segment, status, attempts, places_json, promise, created_at, updated_at)
              VALUES ('PY','handyman','enriching',1,?,80,?,?)`).run(places, now, now);

  stubFetch({
    places: () => ok({ places: [] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 20, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 90, best_offer: 1, reason: 'r', opener: 'o'
    }) }] })
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.enriched, 1, 'the stranded one is researched');
  assert.equal(out.pushed, 1);

  const live = db.prepare("SELECT status FROM lead_candidates WHERE place_id='PY'").get();
  assert.equal(live.status, 'enriching', 'a row a live run is holding is left alone');
});

test('a key pasted with stray whitespace still works', () => {
  assert.equal(apiKey('  sk-ant-abc123\n'), 'sk-ant-abc123');
  assert.equal(apiKey(undefined), '');
  assert.equal(apiKey(null), '');
});

test('only 401 and 403 are marked unretryable', () => {
  assert.equal(providerError('Anthropic', 401, 'bad key').authFailure, true);
  assert.equal(providerError('Anthropic', 403, 'forbidden').authFailure, true);
  assert.equal(providerError('xAI', 429, 'slow down').authFailure, undefined);
  assert.equal(providerError('xAI', 500, 'oops').authFailure, undefined);
  assert.match(providerError('Anthropic', 401, 'bad key').message, /^Anthropic 401: bad key/);
});

test('withRetry gives up on a rejected key instead of hammering it', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(() => {
    calls++;
    throw providerError('Anthropic', 401, 'API key is invalid.');
  }, async () => {}), /401/);
  assert.equal(calls, 1, 'a wrong key is still wrong six seconds later');
});

test('a rejected key stops the run instead of repricing the same answer', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2), PLACE(3), PLACE(4), PLACE(5)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => new Response(JSON.stringify({
      type: 'error', error: { type: 'authentication_error', message: 'API key is invalid.' }
    }), { status: 401 })
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });

  /* The old behaviour: five candidates, five Grok calls at five cents each,
     fifteen Anthropic calls, to be told one thing five times. */
  assert.equal(calls.anthropic, 1, 'asked once, believed it');
  assert.equal(calls.xai, 1, 'stopped before buying research for the other four');
  assert.equal(out.enriched, 1);
  assert.match(out.errors.join(' '), /stopped: Anthropic 401/);

  const left = db.prepare("SELECT COUNT(*) AS c FROM lead_candidates WHERE status != 'rejected'").get();
  assert.equal(Number(left.c), 5, 'the other four are untouched, waiting for a good key');
});

test('research survives a scoring failure and is never bought twice', async () => {
  const { env, db } = await seededEnv();
  let anthropicOk = false;
  const calls = stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'researched once', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => anthropicOk
      ? ok({ content: [{ type: 'text', text: JSON.stringify({
          score: 90, best_offer: 1, reason: 'r', opener: 'o' }) }] })
      : new Response('{"error":"boom"}', { status: 500 })
  });

  // Run one: research succeeds, scoring is broken.
  const first = await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  assert.equal(first.enriched, 1);
  assert.equal(first.pushed, 0);
  const banked = db.prepare("SELECT enrichment_json FROM lead_candidates WHERE place_id='P1'").get();
  assert.match(banked.enrichment_json, /researched once/, 'the paid research was banked');

  // Run two: scoring works now. The research must NOT be bought again.
  anthropicOk = true;
  const xaiBefore = calls.xai;
  const second = await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  assert.equal(calls.xai, xaiBefore, 'no second Grok call for the same business');
  assert.equal(second.enriched, 0, 'nothing new was researched');
  assert.equal(second.pushed, 1, 'and it still made it into the CRM');
});

test('screened-for-free is counted apart from researched-and-rejected', async () => {
  const { env } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [Object.assign(PLACE(1), { userRatingCount: 1 }), PLACE(2)] }),
    xai: () => ok({ output_text: JSON.stringify({
      has_website: false, website_quality: 'none', mobile_friendly: null,
      google_rating: 4.5, review_count: 10, notes: 'n', source_urls: [],
      contact_phone: null, contact_website: null, web_presence: 'none'
    }) }),
    anthropic: () => ok({ content: [{ type: 'text', text: JSON.stringify({
      score: 10, best_offer: 1, reason: 'r', opener: 'o' }) }] })
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.screened, 1, 'one was vetoed before a cent was spent');
  assert.equal(out.rejected, 1, 'one was researched, scored and turned down');
});
