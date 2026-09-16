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
  pushLeadToCrm, stripCandidate, spentToday, defaultSources, seedLeadSources,
  offerName, LEAD_DEFAULTS, placesReject, placesPromise,
  apiKey, providerError, accountFailure, notARealWebsite, websiteVerdict, SLOW_AT,
  placeArea, coprimeStride, SEGMENTS, LEAD_SEGMENTS, HOME_STATE,
  listSegments, setSegmentEnabled
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
    { place_id: 'PLACE_B', segment: 'contractor', offer_hint: 1 },
    { name: 'Different Co', address: '1 Main St', phone: '8015551234', website: '' },
    { qualified: true, score: 88, reason: 'No website at all, 12 Google reviews.' });

  const after = db.prepare("SELECT * FROM clients WHERE id = 1").get();
  assert.deepEqual(after, before, 'the human-owned row is byte-identical');
  const rows = db.prepare("SELECT COUNT(*) AS c FROM clients").get();
  assert.equal(Number(rows.c), 2, 'the new lead was inserted alongside it');
});

test('a pushed lead lands as status lead, flagged as pipeline-made', async () => {
  const { env, db } = await freshEnv();
  const id = await pushLeadToCrm(env,
    { place_id: 'PLACE_C', segment: 'dealer', offer_hint: 3 },
    { name: 'Valley Autos', address: '2 Main St', phone: '9285550000',
      website: 'https://facebook.com/valleyautos' },
    { qualified: true, score: 71, reason: 'No site of their own, just a facebook.com page.' });
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

  // 'ready to call' would fail the CRM's own status validation, so leads land
  // as 'lead' and rank on lead_score.
  assert.equal(row.status, 'lead');
  assert.equal(row.created_by_pipeline, 1);
  assert.equal(row.do_not_contact, 0);
  assert.equal(row.lead_score, 71);
  assert.equal(row.lead_offer, 3);
  assert.equal(row.place_id, 'PLACE_C');
  assert.equal(row.service, offerName(3), 'the offer comes from the segment, not a guess');
  assert.match(row.lead_reason, /facebook/, 'the caller can read why without being briefed');
  assert.equal(row.phone, '9285550000');
  assert.equal(row.website_url, 'https://facebook.com/valleyautos');
  assert.equal(row.lead_address, '2 Main St');
  /* `message` is the human's note field. A pipeline lead never wrote us an
     inquiry, so nothing of ours belongs in it. */
  assert.ok(!row.message, 'the note field is left for the human');
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

// ── response parsing ──────────────────────────────────────────────────────



// ── the search grid ───────────────────────────────────────────────────────
test('only subcontractors and general contractors ship switched on', () => {
  const rows = defaultSources();
  const on = rows.filter(r => r.enabled);
  const segs = [...new Set(on.map(r => r.segment))].sort();
  assert.deepEqual(segs, ['general', 'subcontractor']);
  /* Every other category is seeded for every city anyway, so switching one on
     is an UPDATE. A reseed would work too but would throw away which cities
     have already been searched. */
  for (const seg of ['handyman', 'detailer', 'dealer'])
    assert.ok(rows.some(r => r.segment === seg), seg + ' is seeded, ready to switch on');
});

test('Utah ships disabled in every segment', () => {
  const ut = defaultSources().filter(r => r.state === 'UT');
  assert.ok(ut.length > 0);
  assert.ok(ut.every(r => r.enabled === 0), 'nothing local is called until it is switched on');
});

test('the grid covers Southern California and Phoenix, at suburb level', () => {
  const on = defaultSources().filter(r => r.enabled);
  const states = [...new Set(on.map(r => r.state))].sort();
  assert.deepEqual(states, ['AZ', 'CA']);

  const cities = new Set(on.map(r => r.city));
  // One from each region, so dropping a whole region fails loudly.
  for (const c of ['Pasadena', 'Newport Beach', 'Temecula', 'Carlsbad',
                   'Camarillo', 'Palm Desert', 'Scottsdale'])
    assert.ok(cities.has(c), c + ' is in the grid');

  /* Places returns 20 results per query, ranked on prominence, and a business
     with no website has none. Searching the metro by name would reach the same
     twenty well-known firms forever; the suburbs are how the grid reaches the
     businesses we are actually after. */
  for (const metro of ['Los Angeles', 'Phoenix'])
    assert.ok(!cities.has(metro), metro + ' by name would return the same twenty every time');

  assert.ok(cities.size >= 30, 'enough suburbs that the rotation keeps finding new ground');
});

test('two cities with the same name stay separate', () => {
  // Glendale CA and Glendale AZ are different places in different metros.
  const glendale = defaultSources().filter(r => r.city === 'Glendale');
  assert.deepEqual([...new Set(glendale.map(r => r.state))].sort(), ['AZ', 'CA']);
  const q = defaultSources().filter(r => r.city === 'Glendale' && r.segment === 'subcontractor');
  assert.ok(q.length > 2, 'each state gets its own full set of queries');
});

test('the enabled grid is mostly subcontractors', () => {
  const on = defaultSources().filter(r => r.enabled);
  const subs = on.filter(r => r.segment === 'subcontractor').length;
  assert.ok(subs / on.length > 0.7, 'subs are the target, GCs ride along');
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


// ── the website verdict, on its own ───────────────────────────────────────

test('social pages and dead builders are not websites', () => {
  assert.equal(notARealWebsite('https://www.facebook.com/valleydrywall'), 'facebook.com');
  assert.equal(notARealWebsite('https://linktr.ee/abc'), 'linktr.ee');
  // Google shut business.site down; anything still pointing there is dead.
  assert.equal(notARealWebsite('https://valleydrywall.business.site'), 'business.site');
  assert.equal(notARealWebsite('https://valleydrywall.com'), null);
  assert.equal(notARealWebsite(''), null);
});

test('no website qualifies without asking Google anything', async () => {
  let called = false;
  const v = await websiteVerdict({}, { name: 'A', website: '', review_count: 24 },
    { pageSpeed: async () => { called = true; } });
  assert.equal(v.qualified, true);
  assert.equal(v.checked, 'places');
  assert.match(v.reason, /No website at all, 24 Google reviews/);
  assert.equal(called, false, 'the cheap check comes first');
});

test('a facebook page, a dead builder page and plain http all qualify for free', async () => {
  const boom = { pageSpeed: async () => { throw new Error('must not be reached'); } };

  const fb = await websiteVerdict({}, { website: 'https://facebook.com/x', review_count: 30 }, boom);
  assert.equal(fb.qualified, true);
  assert.match(fb.reason, /just a facebook\.com page/);

  const dead = await websiteVerdict({}, { website: 'https://x.business.site' }, boom);
  assert.equal(dead.qualified, true);
  assert.match(dead.reason, /Google shut down/);

  const http = await websiteVerdict({}, { website: 'http://valleydrywall.com' }, boom);
  assert.equal(http.qualified, true);
  assert.match(http.reason, /plain http/);
});

test('a real site is judged on Google’s own mobile test', async () => {
  const site = { website: 'https://valleydrywall.com', review_count: 40 };
  const ps = r => ({ pageSpeed: async () => r });

  const slow = await websiteVerdict({}, site, ps({ performance: 22, hasViewport: true }));
  assert.equal(slow.qualified, true);
  assert.match(slow.reason, /22\/100/);

  const old = await websiteVerdict({}, site, ps({ performance: 80, hasViewport: false }));
  assert.equal(old.qualified, true);
  assert.match(old.reason, /no mobile viewport/,
    'a fast site built before phones is still an old site');

  const broken = await websiteVerdict({}, site, ps({ unreachable: true, code: 'FAILED_DOCUMENT_REQUEST' }));
  assert.equal(broken.qualified, true);
  assert.match(broken.reason, /cannot load/);

  const fine = await websiteVerdict({}, site, ps({ performance: 91, hasViewport: true }));
  assert.equal(fine.qualified, false, 'a business with a good site is not a lead');
  assert.match(fine.reason, /Nothing to sell them/);

  // The boundary itself, both sides.
  assert.equal((await websiteVerdict({}, site, ps({ performance: SLOW_AT - 1, hasViewport: true }))).qualified, true);
  assert.equal((await websiteVerdict({}, site, ps({ performance: SLOW_AT, hasViewport: true }))).qualified, false);
});

test('pageSpeed reads Google’s shape, including an in-band failure', async () => {
  const reply = body => async () => new Response(JSON.stringify(body), { status: 200 });

  const good = await pageSpeed({ GOOGLE_PLACES_API_KEY: 'k' }, 'https://x.com', reply({
    lighthouseResult: {
      categories: { performance: { score: 0.47 } },
      audits: { viewport: { score: 1 } }
    }
  }));
  assert.equal(good.performance, 47, 'Lighthouse 0-1 becomes a percentage');
  assert.equal(good.hasViewport, true);

  /* A site Google cannot fetch comes back as HTTP 200 with a runtimeError,
     not as an error status — reading res.ok alone would call it healthy. */
  const dead = await pageSpeed({}, 'https://x.com', reply({
    lighthouseResult: { runtimeError: { code: 'FAILED_DOCUMENT_REQUEST', message: 'nope' } }
  }));
  assert.equal(dead.unreachable, true);
  assert.equal(dead.code, 'FAILED_DOCUMENT_REQUEST');
});

test('the mobile strategy is what gets asked for', async () => {
  let asked = '';
  await pageSpeed({ GOOGLE_PLACES_API_KEY: 'k ' }, 'https://x.com', async (u) => {
    asked = String(u);
    return new Response(JSON.stringify({ lighthouseResult: {} }), { status: 200 });
  });
  assert.match(asked, /strategy=mobile/, 'desktop is the API default and the wrong question');
  assert.match(asked, /key=k(&|$)/, 'the key is trimmed before it goes out');
});

// ── the whole run ─────────────────────────────────────────────────────────
import { runLeadPipeline, pageSpeed } from './leadpipeline.js';

function stubFetch(handlers) {
  const calls = { places: 0, pagespeed: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (u.includes('places.googleapis.com')) { calls.places++; return handlers.places(body); }
    if (u.includes('pagespeedonline')) { calls.pagespeed++; return handlers.pagespeed(u); }
    throw new Error('unexpected fetch: ' + u);
  };
  return calls;
}
const ok = obj => new Response(JSON.stringify(obj), { status: 200 });

// No website by default — the common case, and free to judge.
const PLACE = n => ({
  id: 'P' + n, displayName: { text: 'Biz ' + n }, formattedAddress: n + ' Main St',
  nationalPhoneNumber: '801555000' + n, websiteUri: '', rating: 4.5,
  userRatingCount: 10, businessStatus: 'OPERATIONAL'
});
const WITH_SITE = (n, url) => Object.assign(PLACE(n), { websiteUri: url || ('https://biz' + n + '.com') });
const PS = (score, viewport) => () => ok({ lighthouseResult: {
  categories: { performance: { score: score / 100 } },
  audits: { viewport: { score: viewport === false ? 0 : 1 } }
} });

async function seededEnv(extra) {
  const { env, db } = await freshEnv();
  db.prepare(`INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
              VALUES ('handyman','Fresno','CA','handyman',1,1,?)`).run(new Date().toISOString());
  Object.assign(env, { GOOGLE_PLACES_API_KEY: 'k' }, extra || {});
  return { env, db };
}

test('a dry run stages candidates and checks nothing', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2), PLACE(3)] }),
    pagespeed: () => { throw new Error('a dry run must not check websites'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(out.sourced, 3);
  assert.equal(calls.pagespeed, 0);
  assert.equal(out.pushed, 0);
  const n = db.prepare("SELECT COUNT(*) AS c FROM lead_candidates WHERE status='new'").get();
  assert.equal(Number(n.c), 3);
});

test('a full run adds the businesses without a usable site and skips the rest', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [
      PLACE(1),                                        // no website
      WITH_SITE(2, 'https://facebook.com/biz2'),       // facebook only
      WITH_SITE(3),                                    // real site, checked
      WITH_SITE(4)                                     // real site, checked
    ] }),
    pagespeed: (u) => (u.includes('biz3') ? PS(18)() : PS(94)())
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 4 });
  assert.equal(out.pushed, 3, 'no site, facebook-only and the slow one');
  assert.equal(out.rejected, 1, 'the one with a good site');
  assert.equal(calls.pagespeed, 2, 'only the two real sites cost a check');

  const leads = db.prepare("SELECT business_name, lead_reason FROM clients WHERE created_by_pipeline = 1 ORDER BY business_name").all();
  assert.deepEqual(leads.map(r => r.business_name), ['Biz 1', 'Biz 2', 'Biz 3']);
  assert.match(leads[0].lead_reason, /No website at all/);
  assert.match(leads[1].lead_reason, /facebook\.com/);
  assert.match(leads[2].lead_reason, /18\/100/);
});

test('a run costs only what Google Places charges', async () => {
  const { env } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [WITH_SITE(1), WITH_SITE(2), WITH_SITE(3)] }),
    pagespeed: PS(10)
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 3 });
  assert.equal(out.pushed, 3);
  // One text search. PageSpeed is free, and there is nothing else left to pay.
  assert.equal(Number(out.est_cost_usd.toFixed(4)), 0.035);
});

test('a run reports each business as it is checked', async () => {
  const { env } = await seededEnv();
  stubFetch({ places: () => ok({ places: [PLACE(1)] }), pagespeed: PS(10) });
  const seen = [];
  await runLeadPipeline(env, { trigger: 'manual', limit: 1, onProgress: e => seen.push(e) });
  assert.deepEqual(seen.map(e => e.event),
    ['sourcing', 'sourced', 'batch', 'checking', 'judged']);
  const judged = seen[seen.length - 1];
  assert.equal(judged.name, 'Biz 1');
  assert.equal(judged.kept, true);
  assert.match(judged.reason, /No website/);
});

test('a refused speed test never burns a candidate\u2019s attempts', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [WITH_SITE(1), WITH_SITE(2), WITH_SITE(3)] }),
    pagespeed: () => new Response(JSON.stringify({
      error: { code: 403, message: 'Requests to this API pagespeedonline method ... are blocked.' }
    }), { status: 403 })
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 3 });
  assert.equal(out.deferred, 3, 'all three are waiting for a working speed test');
  assert.equal(out.failed, 0, 'none retired');

  /* Three runs during a misconfigured key must not retire three good
     businesses for something that was never about them. */
  for (const id of ['P1', 'P2', 'P3']) {
    const row = db.prepare("SELECT status, attempts FROM lead_candidates WHERE place_id=?").get(id);
    assert.equal(row.status, 'new');
    assert.equal(Number(row.attempts), 0, id + ' kept its attempts');
  }
});

test('the businesses with no site at all still land when PageSpeed is off', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1), PLACE(2)] }),   // neither has a website
    pagespeed: () => { throw new Error('should never be needed'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 2 });
  assert.equal(out.pushed, 2, 'the best leads need no API beyond Places');
  const n = db.prepare("SELECT COUNT(*) AS c FROM clients WHERE created_by_pipeline = 1").get();
  assert.equal(Number(n.c), 2);
});

test('the daily ceiling stops a run before it spends', async () => {
  const { env, db } = await seededEnv({ LEADS_DAILY_USD_CAP: '0.01' });
  db.prepare("INSERT INTO enrichment_runs (trigger, started_at, est_cost_usd) VALUES ('manual', ?, 4.99)")
    .run(new Date().toISOString());
  const calls = stubFetch({
    places: () => { throw new Error('must not search over the ceiling'); },
    pagespeed: () => { throw new Error('must not check over the ceiling'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual' });
  assert.equal(calls.places, 0);
  assert.match(out.errors.join(' '), /ceiling/);
});

test('a do_not_contact business is never re-sourced into the CRM', async () => {
  const { env, db } = await seededEnv();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO clients (business_name, place_id, do_not_contact, status, created_at, updated_at)
              VALUES ('Asked us to stop','P1',1,'lead',?,?)`).run(now, now);
  const calls = stubFetch({
    places: () => ok({ places: [PLACE(1)] }),
    pagespeed: () => { throw new Error('must not check a do_not_contact business'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual' });
  assert.equal(out.deduped, 1);
  assert.equal(calls.pagespeed, 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM clients").get().c), 1);
});

test('hopeless candidates are vetoed at sourcing, before any check', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [
      Object.assign(PLACE(1), { userRatingCount: 1 }),
      Object.assign(PLACE(2), { userRatingCount: 900 }),
      PLACE(3)
    ] }),
    pagespeed: () => { throw new Error('a vetoed candidate must never be checked'); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(out.screened, 2);
  assert.equal(calls.pagespeed, 0);
  const tomb = db.prepare("SELECT * FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(tomb.status, 'screened',
    'screened-on-sight is its own status, not the same as checked and turned down');
  assert.equal(tomb.places_json, null, 'a tombstone holds no Places content');
});

test('the run checks the most promising candidates first', async () => {
  const { env } = await seededEnv();
  /* Sourced first, but it has a real site and a tended listing. PLACE(2) has
     neither, so with one slot it must go first. */
  const tended = Object.assign(WITH_SITE(1), { photos: new Array(60).fill({ name: 'p' }) });
  const seen = [];
  stubFetch({
    places: () => ok({ places: [tended, PLACE(2)] }),
    pagespeed: () => { seen.push('checked a site'); return PS(95)(); }
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  assert.equal(out.pushed, 1);
  assert.deepEqual(seen, [], 'it spent its one slot on the no-website business');
});

test('a candidate that keeps failing is retired after three attempts', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [WITH_SITE(1)] }),
    pagespeed: () => new Response('upstream on fire', { status: 503 })
  });
  for (let i = 0; i < 3; i++) await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  const row = db.prepare("SELECT status, attempts FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(row.status, 'failed');
  assert.equal(Number(row.attempts), 3);
});

test('candidates stranded by a killed run are picked back up', async () => {
  const { env, db } = await seededEnv();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const places = JSON.stringify({ place_id: 'PX', name: 'Stranded Co', website: '', review_count: 20 });
  db.prepare(`INSERT INTO lead_candidates (place_id, segment, status, attempts, places_json, promise, created_at, updated_at)
              VALUES ('PX','handyman','enriching',1,?,80,?,?)`).run(places, old, old);
  db.prepare(`INSERT INTO lead_candidates (place_id, segment, status, attempts, places_json, promise, created_at, updated_at)
              VALUES ('PY','handyman','enriching',1,?,80,?,?)`).run(places, now, now);

  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(10) });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.pushed, 1, 'the stranded one is judged');
  assert.equal(db.prepare("SELECT status FROM lead_candidates WHERE place_id='PY'").get().status,
    'enriching', 'a row a live run is holding is left alone');
});

test('candidates retired during an earlier lapse come back', async () => {
  const { env, db } = await seededEnv();
  const now = new Date().toISOString();
  const places = JSON.stringify({ place_id: 'PZ', name: 'Revived Co', website: '', review_count: 20 });
  db.prepare(`INSERT INTO lead_candidates
    (place_id, segment, status, attempts, last_error, places_json, promise, created_at, updated_at)
    VALUES ('PZ','handyman','failed',3,'[account] PageSpeed 403: disabled',?,80,?,?)`)
    .run(places, now, now);

  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(10) });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 5 });
  assert.equal(out.pushed, 1, 'revived and judged');
});

test('a reseed replaces the grid; without force it leaves it alone', async () => {
  const { env, db } = await seededEnv();
  const before = Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c);
  const handAdded = db.prepare("SELECT id FROM lead_sources LIMIT 1").get().id;
  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(10) });

  await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c), before,
    'a normal run never touches a grid that already exists');

  await runLeadPipeline(env, { trigger: 'manual', dryRun: true, reseed: true });
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c) > 1,
    'a reseed writes the code’s own grid');
  /* Fresno is in the default grid too, so counting the city proves nothing —
     the hand-added ROW is what has to be gone. */
  assert.equal(db.prepare("SELECT id FROM lead_sources WHERE id = ?").get(handAdded), undefined,
    'and drops what was there, including hand-added rows');
});

test('a client that hangs up mid-run does not stop the run', async () => {
  const { env, db } = await seededEnv();
  stubFetch({ places: () => ok({ places: [PLACE(1)] }), pagespeed: PS(10) });
  const out = await runLeadPipeline(env, {
    trigger: 'manual', limit: 1,
    onProgress: () => { throw new Error('socket closed'); }
  });
  assert.equal(out.pushed, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM clients WHERE created_by_pipeline = 1").get().c), 1);
});

test('a lead carries the evidence a caller needs, and the speed test when there was one', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [PLACE(1), WITH_SITE(2)] }),
    pagespeed: PS(31, false)     // slow AND no viewport
  });
  await runLeadPipeline(env, { trigger: 'manual', limit: 2 });

  const noSite = db.prepare("SELECT * FROM clients WHERE business_name='Biz 1'").get();
  assert.ok(!noSite.website_url, 'nothing to open, and the UI says so');
  assert.equal(noSite.lead_speed, null, 'no site means no speed test to report');
  assert.equal(noSite.lead_check, 'places');
  assert.ok(noSite.place_id, 'the Google listing link needs this and nothing else');

  const slow = db.prepare("SELECT * FROM clients WHERE business_name='Biz 2'").get();
  assert.equal(slow.website_url, 'https://biz2.com', 'the caller can click straight through');
  assert.equal(Number(slow.lead_speed), 31);
  assert.equal(Number(slow.lead_mobile_ready), 0);
  assert.equal(slow.lead_check, 'pagespeed');
  assert.equal(slow.lead_address, '2 Main St');
});

test('a measured score is kept even when the verdict turns on something else', async () => {
  const site = { website: 'https://valleydrywall.com', review_count: 12 };
  // Fast enough to pass on speed, but built before phones — the viewport
  // decides it, and the number still has to survive onto the row.
  const v = await websiteVerdict({}, site, { pageSpeed: async () => ({ performance: 78, hasViewport: false }) });
  assert.equal(v.qualified, true);
  assert.equal(v.speed, 78, 'the caller should still see what Google scored it');
  assert.equal(v.mobileReady, false);
});

test('a run with no limit named checks the default batch, not five', async () => {
  const { env, db } = await seededEnv();
  const now = new Date().toISOString();
  // Twelve staged candidates, none with a website, so nothing is slow.
  for (let i = 1; i <= 12; i++) {
    db.prepare(`INSERT INTO lead_candidates (place_id, segment, offer_hint, status, places_json, promise, created_at, updated_at)
                VALUES (?, 'handyman', 1, 'new', ?, 50, ?, ?)`)
      .run('Q' + i, JSON.stringify({ place_id: 'Q' + i, name: 'Q Co ' + i, website: '', review_count: 20 }), now, now);
  }
  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(10) });

  const out = await runLeadPipeline(env, { trigger: 'manual' });
  assert.equal(LEAD_DEFAULTS.perRun, 20, 'the default is the one number that decides this');
  assert.equal(out.pushed, 12, 'the whole queue was worked, not the first five');
});

test('the batch size is clamped, however it is asked for', async () => {
  const { env, db } = await seededEnv();
  const now = new Date().toISOString();
  for (let i = 1; i <= 30; i++) {
    db.prepare(`INSERT INTO lead_candidates (place_id, segment, offer_hint, status, places_json, promise, created_at, updated_at)
                VALUES (?, 'handyman', 1, 'new', ?, 50, ?, ?)`)
      .run('R' + i, JSON.stringify({ place_id: 'R' + i, name: 'R Co ' + i, website: '', review_count: 20 }), now, now);
  }
  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(10) });

  // A run cannot be talked into an unbounded batch by the query string.
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 500 });
  assert.equal(out.pushed, 25, 'the hard ceiling holds');
});

// ── the rating floor ──────────────────────────────────────────────────────

test('a badly reviewed business is screened out before anything else happens', () => {
  const ok4 = { review_count: 40, rating: 4.4 };
  assert.equal(placesReject(ok4), null);

  const bad = placesReject({ review_count: 40, rating: 3.1 });
  assert.match(bad, /3\.1 stars from 40 reviews/);
  assert.match(bad, /below the 4 cut-off/);

  // The boundary, both sides.
  assert.equal(placesReject({ review_count: 40, rating: 4.0 }), null);
  assert.ok(placesReject({ review_count: 40, rating: 3.9 }));

  // Google not having a rating is not the same as a bad one.
  assert.equal(placesReject({ review_count: 40, rating: null }), null);

  // The review floor still runs first — too few reviews is the better reason.
  assert.match(placesReject({ review_count: 2, rating: 2.0 }), /only 2 reviews/);
});

test('the cut-off can be moved without a deploy', () => {
  assert.equal(placesReject({ review_count: 40, rating: 4.2 }, 4.5).includes('4.5 cut-off'), true);
  assert.equal(placesReject({ review_count: 40, rating: 3.6 }, 3.5), null,
    'a lower bar lets more through');
});

test('the rating floor is read from the environment', async () => {
  const { env } = await seededEnv({ LEADS_MIN_RATING: '4.6' });
  stubFetch({
    places: () => ok({ places: [
      Object.assign(PLACE(1), { rating: 4.9 }),
      Object.assign(PLACE(2), { rating: 4.5 })
    ] }),
    pagespeed: PS(10)
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(out.screened, 1, 'the 4.5 is below a 4.6 bar');
  assert.equal(out.sourced, 2);
});

test('rescreening reopens businesses screened under an old cut-off', async () => {
  const { env, db } = await seededEnv({ LEADS_MIN_RATING: '4.8' });
  const harsh = () => ok({ places: [Object.assign(PLACE(1), { rating: 4.4 })] });

  stubFetch({ places: harsh, pagespeed: PS(10) });
  const first = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(first.screened, 1);

  /* Without rescreen the tombstone dedupes it away for good, and the new,
     lower bar would never be applied to it. */
  env.LEADS_MIN_RATING = '4.0';
  const again = await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.equal(again.deduped, 1, 'the old verdict still stands in the way');
  assert.equal(again.sourced, 1);

  const relaxed = await runLeadPipeline(env, { trigger: 'manual', dryRun: true, rescreen: true });
  assert.equal(relaxed.rescreened, 1, 'the tombstone was cleared');
  const row = db.prepare("SELECT status FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(row.status, 'new', 'and the business is back in the queue');
});

test('rescreening never touches a business that was actually checked', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [Object.assign(WITH_SITE(1), { rating: 4.7 })] }),
    pagespeed: PS(96)     // a good site — checked, and turned down on merit
  });
  await runLeadPipeline(env, { trigger: 'manual' });
  assert.equal(db.prepare("SELECT status FROM lead_candidates WHERE place_id='P1'").get().status,
    'rejected');

  stubFetch({ places: () => ok({ places: [] }), pagespeed: PS(96) });
  const out = await runLeadPipeline(env, { trigger: 'manual', rescreen: true });
  assert.equal(out.rescreened, 0);
  assert.equal(db.prepare("SELECT status FROM lead_candidates WHERE place_id='P1'").get().status,
    'rejected', 'a real verdict survives a rescreen');
});

test('the town is pulled out of whatever shape Google sends', () => {
  // The ordinary case.
  assert.equal(placeArea('1401 Dove St, Newport Beach, CA 92660, USA'), 'Newport Beach, CA');
  // A suite line adds a comma, so counting from the front would be off by one.
  assert.equal(placeArea('1401 Dove St Ste 220, Newport Beach, CA 92660, USA'), 'Newport Beach, CA');
  // A rural address drops the street line, so it would be off the other way.
  assert.equal(placeArea('Queen Creek, AZ 85142, USA'), 'Queen Creek, AZ');
  // Zip+4.
  assert.equal(placeArea('55 W Main St, Mesa, AZ 85201-1234, USA'), 'Mesa, AZ');
  // Two-word state-side towns and saints keep their spaces.
  assert.equal(placeArea('9 Camino Real, Paradise Valley, AZ 85253, USA'), 'Paradise Valley, AZ');

  // No zip to anchor on: fall back to the last two parts, country dropped.
  assert.equal(placeArea('100 Main St, Torrance, California, USA'), 'Torrance, California');
  assert.equal(placeArea('Torrance'), 'Torrance');
  assert.equal(placeArea(''), '');
  assert.equal(placeArea(null), '');
  assert.equal(placeArea(undefined), '');
});

test('a lead carries its town for the list, and its street address for the call', async () => {
  const { env, db } = await seededEnv();
  stubFetch({
    places: () => ok({ places: [Object.assign(PLACE(1), {
      formattedAddress: '1401 Dove St Ste 220, Newport Beach, CA 92660, USA'
    })] }),
    pagespeed: PS(10)
  });
  await runLeadPipeline(env, { trigger: 'manual', limit: 1 });
  const row = db.prepare("SELECT * FROM clients WHERE created_by_pipeline = 1").get();
  assert.equal(row.lead_area, 'Newport Beach, CA', 'scannable in the list');
  assert.equal(row.lead_address, '1401 Dove St Ste 220, Newport Beach, CA 92660, USA',
    'and the full thing is still there');
});

// ── the rotation ──────────────────────────────────────────────────────────

test('a fresh grid does not spend its first ten runs in one town', () => {
  /* A run takes the two least-recently-searched sources, and on a fresh grid
     nothing has been searched, so they come back in insert order. Grouping the
     rows by city meant ten consecutive runs all searched the same town and
     every lead came from it — which reads as "the city list is wrong" when the
     city list is fine. */
  const on = defaultSources().filter(r => r.enabled);
  const firstTwentySearches = on.slice(0, 20).map(r => r.city + ',' + r.state);
  assert.equal(new Set(firstTwentySearches).size, 20,
    'ten runs, twenty searches, twenty different towns');

  // And they should not all be in one corner of the map either.
  const states = new Set(on.slice(0, 20).map(r => r.state));
  assert.ok(states.size > 1, 'the first ten runs reach more than one state');
});

test('every city is reachable, none searched twice as often as another', () => {
  const rows = defaultSources();
  const perCity = {};
  rows.forEach(r => { const k = r.city + ',' + r.state; perCity[k] = (perCity[k] || 0) + 1; });
  const counts = [...new Set(Object.values(perCity))];
  assert.equal(counts.length, 1, 'every city gets exactly the same set of queries');
});

test('the stride can never silently skip cities', () => {
  /* A stride sharing a factor with the city count walks a subset and repeats
     it forever — some towns would simply never be searched, with nothing to
     show for it. The stride is checked rather than trusted. */
  assert.equal(coprimeStride(17, 76), 17, '17 and 76 are coprime');
  assert.equal(coprimeStride(4, 8), 5, '4 would visit only half of 8');
  assert.equal(coprimeStride(2, 10), 3, '2 would visit only the even indices');
  assert.equal(coprimeStride(17, 1), 1);
  assert.equal(coprimeStride(17, 2), 1);

  // Whatever it returns must walk the whole ring, for any size.
  for (let n = 2; n <= 200; n++) {
    const s = coprimeStride(17, n);
    const seen = new Set();
    for (let i = 0; i < n; i++) seen.add((i * s) % n);
    assert.equal(seen.size, n, 'stride ' + s + ' misses cities when there are ' + n);
  }
});

// ── categories ────────────────────────────────────────────────────────────

test('a category is defined once, not in four places that must agree', () => {
  assert.deepEqual(LEAD_SEGMENTS, SEGMENTS.map(s => s.key),
    'the key list is derived, so it cannot drift from the definitions');
  for (const s of SEGMENTS) {
    assert.ok(s.label && s.label !== s.key, s.key + ' has a human label');
    assert.ok([1, 2, 3].includes(s.offer), s.key + ' maps to a real offer');
    assert.ok(s.queries.length > 0, s.key + ' has searches');
  }
  const keys = SEGMENTS.map(s => s.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');

  // Both new categories, and the offers they sell.
  const det = SEGMENTS.find(s => s.key === 'detailer');
  assert.equal(det.offer, 1, 'a detailer buys the $99 site, not the dealer CRM');
  assert.equal(SEGMENTS.find(s => s.key === 'dealer').offer, 3);
  assert.ok(det.queries.some(q => /detail/.test(q)));
});

test('every category is seeded for every city, so switching one on is an UPDATE', () => {
  const rows = defaultSources();
  const cities = new Set(rows.map(r => r.city + ',' + r.state)).size;
  for (const seg of SEGMENTS) {
    const n = rows.filter(r => r.segment === seg.key).length;
    assert.equal(n, cities * seg.queries.length,
      seg.key + ' is seeded everywhere, on or off');
  }
});

test('the toggles report what lead_sources actually says', async () => {
  const { env } = await freshEnv();
  await seedLeadSources(env);
  const segs = await listSegments(env);

  const byKey = {};
  segs.forEach(s => { byKey[s.key] = s; });
  assert.equal(byKey.subcontractor.enabled, true);
  assert.equal(byKey.detailer.enabled, false);
  assert.equal(byKey.detailer.searches, 0);
  assert.ok(byKey.detailer.total > 0, 'off, but seeded and ready');
  assert.equal(byKey.dealer.label, 'Car dealerships', 'the CRM shows this wording');
});

test('turning a category on switches its searches on, and off again', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env);

  await setSegmentEnabled(env, 'detailer', true);
  let byKey = {};
  (await listSegments(env)).forEach(s => { byKey[s.key] = s; });
  assert.equal(byKey.detailer.enabled, true);
  assert.ok(byKey.detailer.searches > 0);
  assert.equal(byKey.subcontractor.enabled, true, 'other categories are untouched');

  await setSegmentEnabled(env, 'detailer', false);
  byKey = {};
  (await listSegments(env)).forEach(s => { byKey[s.key] = s; });
  assert.equal(byKey.detailer.enabled, false);
  assert.equal(byKey.detailer.searches, 0);
});

test('switching a category on never switches on the home state', async () => {
  const { env, db } = await freshEnv();
  await seedLeadSources(env);
  await setSegmentEnabled(env, 'detailer', true);

  /* Turning on "Auto detailers" should not start ringing the shop down the
     road. The home state is off because it is home, not because that category
     happened to be off. */
  const home = db.prepare(
    "SELECT COUNT(*) AS c FROM lead_sources WHERE state = ? AND enabled = 1"
  ).get(HOME_STATE);
  assert.equal(Number(home.c), 0);
});

test('an unknown category is refused rather than silently doing nothing', async () => {
  const { env } = await freshEnv();
  await seedLeadSources(env);
  await assert.rejects(() => setSegmentEnabled(env, 'plumbers-but-cooler', true),
    /unknown category/);
});

test('a switched-on category actually gets searched', async () => {
  /* freshEnv + seed, not seededEnv: seededEnv hand-adds one source row, and a
     non-empty lead_sources means the real grid is never seeded — so there
     would be no detailer rows to switch on. */
  const { env } = await freshEnv();
  Object.assign(env, { GOOGLE_PLACES_API_KEY: 'k' });
  await seedLeadSources(env);
  for (const k of LEAD_SEGMENTS) await setSegmentEnabled(env, k, k === 'detailer');

  const queries = [];
  stubFetch({
    places: (body) => { queries.push(body.textQuery); return ok({ places: [] }); },
    pagespeed: PS(10)
  });
  await runLeadPipeline(env, { trigger: 'manual', dryRun: true });
  assert.ok(queries.length > 0, 'it searched something');
  for (const q of queries)
    assert.match(q, /detail|ceramic coating/, 'and only the category that is on: ' + q);
});

test('a lead remembers which trade found it, not just its category', async () => {
  const { env, db } = await freshEnv();
  Object.assign(env, { GOOGLE_PLACES_API_KEY: 'k' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
              VALUES ('roofing contractor','Carlsbad','CA','subcontractor',2,1,?)`).run(now);

  stubFetch({ places: () => ok({ places: [PLACE(1)] }), pagespeed: PS(10) });
  await runLeadPipeline(env, { trigger: 'manual', limit: 1 });

  const row = db.prepare("SELECT * FROM clients WHERE created_by_pipeline = 1").get();
  assert.equal(row.lead_trade, 'roofing contractor',
    '"subcontractor" is a bucket; "roofing contractor" is what you say on the phone');
  assert.equal(row.lead_segment, 'subcontractor', 'the category is still there to group by');
});

test('the trade survives a reseed, because it is not a foreign key', async () => {
  const { env, db } = await freshEnv();
  Object.assign(env, { GOOGLE_PLACES_API_KEY: 'k' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
              VALUES ('ceramic coating','Irvine','CA','detailer',1,1,?)`).run(now);

  stubFetch({ places: () => ok({ places: [PLACE(1)] }), pagespeed: PS(10) });
  await runLeadPipeline(env, { trigger: 'manual', limit: 1 });

  /* A reseed deletes every lead_sources row, so a lead that pointed at one by
     id would lose its trade. It is copied onto the candidate instead. */
  await seedLeadSources(env, true);
  const row = db.prepare("SELECT lead_trade FROM clients WHERE created_by_pipeline = 1").get();
  assert.equal(row.lead_trade, 'ceramic coating');
});

// ── PageSpeed must never be able to stop the whole pipeline ───────────────

test('a key the project refuses falls back to a keyless request', async () => {
  const seen = [];
  const reply = async (u) => {
    seen.push(String(u));
    if (String(u).includes('key=')) {
      return new Response(JSON.stringify({ error: { code: 403,
        message: 'Requests to this API pagespeedonline method ... are blocked.' } }), { status: 403 });
    }
    return new Response(JSON.stringify({ lighthouseResult: {
      categories: { performance: { score: 0.4 } }, audits: { viewport: { score: 1 } }
    } }), { status: 200 });
  };

  /* PageSpeed works with no key at all — the key only buys a higher rate
     limit — so a restriction the project will not accept is a reason to drop
     the key, not to stop working. */
  const out = await pageSpeed({ GOOGLE_PLACES_API_KEY: 'restricted' }, 'https://x.example', reply);
  assert.equal(out.performance, 40, 'it got the answer anyway');
  assert.equal(seen.length, 2);
  assert.match(seen[0], /key=restricted/);
  assert.ok(!seen[1].includes('key='), 'the retry drops the key');
});

test('a 403 with no key set is not retried pointlessly', async () => {
  let calls = 0;
  const reply = async () => { calls++; return new Response('{}', { status: 403 }); };
  await assert.rejects(() => pageSpeed({}, 'https://x.example', reply), /PageSpeed 403/);
  assert.equal(calls, 1);
});

test('no speed test still means leads, just not the ones needing one', async () => {
  const { env, db } = await seededEnv();
  const calls = stubFetch({
    places: () => ok({ places: [
      WITH_SITE(1),   // needs a speed test
      PLACE(2),       // no website — judgeable for free
      WITH_SITE(3),   // needs one
      PLACE(4)        // no website
    ] }),
    pagespeed: () => new Response(JSON.stringify({ error: { code: 403,
      message: 'Requests to this API pagespeedonline method ... are blocked.' } }), { status: 403 })
  });

  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 4 });

  /* The old behaviour stopped the whole run at the first refused check, so a
     misconfigured key cost every lead in the queue, not just the two that
     needed a speed test. */
  assert.equal(out.pushed, 2, 'both no-website businesses still landed');
  assert.equal(out.deferred, 2, 'and the two needing a check were put back');
  assert.match(out.errors.join(' '), /speed test unavailable/);
  assert.ok(!out.errors.join(' ').includes('stopped:'), 'the run did not stop');

  // Asked once with the key, once without, then never again this run.
  assert.equal(calls.pagespeed, 2, 'it stops asking after the first refusal');

  const deferred = db.prepare("SELECT status, attempts FROM lead_candidates WHERE place_id='P1'").get();
  assert.equal(deferred.status, 'new', 'waiting, not failed');
  assert.equal(Number(deferred.attempts), 0, 'and it did not burn an attempt it never used');
});

test('an account failure that is not PageSpeed still stops the run', async () => {
  const { env } = await seededEnv();
  const calls = stubFetch({
    places: () => new Response(JSON.stringify({ error: { message: 'credit balance is too low' } }), { status: 400 }),
    pagespeed: PS(10)
  });
  const out = await runLeadPipeline(env, { trigger: 'manual', limit: 4 });
  assert.equal(calls.places, 1);
  assert.equal(out.sourced, 0);
});

test('a rebuilt grid replaces the old one wholesale', async () => {
  const { env, db } = await freshEnv();
  const now = new Date().toISOString();
  // Stand in for the old 20-city grid that is still out there.
  db.prepare(`INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
              VALUES ('handyman','Bakersfield','CA','handyman',1,1,?)`).run(now);

  // A normal run leaves it alone — that is the whole point of seeding once.
  assert.equal(await seedLeadSources(env, false), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c), 1);

  const written = await seedLeadSources(env, true);
  assert.ok(written > 1000, 'the real grid is written, not a handful of rows');
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources").get().c), written);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE city='Bakersfield'").get().c), 0,
    'the old city list is gone');

  /* The symptom that started this: handymen stuck at 42 searches, which is
     14 cities x 3 queries from the grid before SoCal. After a rebuild the
     count has to reflect the grid in the code. */
  const handy = SEGMENTS.find(s => s.key === 'handyman');
  const cities = new Set(defaultSources().map(r => r.city + ',' + r.state)).size;
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) AS c FROM lead_sources WHERE segment='handyman'").get().c),
    cities * handy.queries.length);

  await setSegmentEnabled(env, 'handyman', true);
  const on = (await listSegments(env)).find(s => s.key === 'handyman');
  assert.ok(on.searches > 200, 'and switching it on offers the whole region, not 42 searches');
});
