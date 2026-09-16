/* ══════════════════════════════════════════════════════════════════════════
   LEAD ENRICHMENT PIPELINE

   Sources local businesses from Google Places, researches each one with Grok,
   scores it against Potentia's three offers with Claude, and inserts the good
   ones into the CRM's `clients` table as leads.

   Three rules shape most of the code below.

   1. PLACES CONTENT IS BORROWED, NOT KEPT. Google's terms let us store
      `place_id` indefinitely and essentially nothing else. So Places fields
      live in lead_candidates only while a candidate is being judged, and the
      row is stripped the moment it is. A qualified lead's durable contact
      details come from the business's own site (enrichment source_urls).

   2. THE PIPELINE NEVER OVERWRITES. It only ever INSERTs into `clients`. If a
      business is already there — however it got there, however stale it looks
      — the pipeline leaves it completely alone. A caller's hand-typed note is
      worth more than anything this file can work out.

   3. IT SPENDS REAL MONEY. Every run is capped, every call is logged with its
      estimated cost, and a daily ceiling is checked before each paid call.
   ══════════════════════════════════════════════════════════════════════════ */

export const LEAD_SEGMENTS = ["subcontractor", "general", "handyman", "dealer"];

/* Unit costs in USD, for the daily ceiling and the per-run log. Google Places
   text search is the only paid call left in the pipeline — the AI stages are
   gone and PageSpeed is free — so a run now costs single-digit cents however
   many businesses it judges. */
// Named LEAD_COST / LEAD_DEFAULTS, not COST / DEFAULTS: pricing.js already
// owns those at top level, and the bundler flattens both modules into one
// file where a duplicate const is a hard SyntaxError.
export const LEAD_COST = {
  placesSearchUsd: 0.035      // Text Search Enterprise, $35/1000 — VERIFIED
};                            // PageSpeed is free; there is nothing else to pay for.

export const LEAD_DEFAULTS = {
  perRun: 5,                  // websites checked per run
  dailyUsdCap: 5.0,
  maxAttempts: 3,
  sourceBatch: 2,             // Places queries per run
};

// ── table setup ───────────────────────────────────────────────────────────
// Lazily created on first use, same as payments/installs/saved_designs.
export async function ensureLeadPipelineTables(env) {
  const db = env.CRM_DB;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_template TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL,
      segment TEXT NOT NULL, offer_hint INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, created_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT NOT NULL UNIQUE, segment TEXT NOT NULL, offer_hint INTEGER,
      source_id INTEGER, status TEXT NOT NULL DEFAULT 'new',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      places_json TEXT, places_fetched_at TEXT, enrichment_json TEXT,
      promise INTEGER, score INTEGER, best_offer INTEGER, reason TEXT, opener TEXT,
      crm_client_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS enrichment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT,
      sourced INTEGER NOT NULL DEFAULT 0, deduped INTEGER NOT NULL DEFAULT 0,
      enriched INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 0,
      pushed INTEGER NOT NULL DEFAULT 0, screened INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT)`
  ).run();

  /* D1 has no "ADD COLUMN IF NOT EXISTS", and a duplicate ADD throws. Read the
     table first and add only what is missing — the same lazy-migration shape
     the rest of this Worker uses. */

  // `promise` arrived after the first candidates were staged, so it has to be
  // added to an existing table as well as declared in CREATE TABLE above.
  const candCols = await db.prepare("PRAGMA table_info(lead_candidates)").all();
  if ((candCols.results || []).map((r) => r.name).indexOf("promise") === -1) {
    await db.prepare("ALTER TABLE lead_candidates ADD COLUMN promise INTEGER").run();
  }

  // Same for `screened` — free screening used to be lumped in with `rejected`.
  const runCols = await db.prepare("PRAGMA table_info(enrichment_runs)").all();
  if ((runCols.results || []).map((r) => r.name).indexOf("screened") === -1) {
    await db.prepare("ALTER TABLE enrichment_runs ADD COLUMN screened INTEGER NOT NULL DEFAULT 0").run();
  }

  const have = await db.prepare("PRAGMA table_info(clients)").all();
  const cols = (have.results || []).map((r) => r.name);
  const wanted = [
    ["do_not_contact", "INTEGER NOT NULL DEFAULT 0"],
    ["place_id", "TEXT"],
    ["lead_score", "INTEGER"],
    ["lead_segment", "TEXT"],
    ["lead_offer", "INTEGER"],
    ["lead_reason", "TEXT"],
    ["lead_opener", "TEXT"],
    ["lead_address", "TEXT"],
    ["lead_speed", "INTEGER"],
    ["lead_mobile_ready", "INTEGER"],
    ["lead_check", "TEXT"],
    ["created_by_pipeline", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [name, decl] of wanted) {
    if (cols.indexOf(name) === -1) {
      await db.prepare(`ALTER TABLE clients ADD COLUMN ${name} ${decl}`).run();
    }
  }
}

// ── dedupe helpers ────────────────────────────────────────────────────────
/* Last 10 digits. US numbers arrive from Places as "(435) 232-9516", from a
   website as "+1 435-232-9516", and from a caller's typing as "4352329516" —
   all the same business, and comparing the raw strings would miss every time. */
export function normalisePhone(v) {
  const d = String(v == null ? "" : v).replace(/\D+/g, "");
  if (d.length < 10) return null;
  return d.slice(-10);
}

/* Registrable domain, lowercased, "www." dropped. Two listings for one shop
   routinely differ only by scheme, www, a path or a tracking query. */
export function registrableDomain(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let host;
  try { host = new URL(s).hostname; } catch (e) { return null; }
  host = host.toLowerCase().replace(/^www\./, "");
  return host || null;
}

// ── Google Places ─────────────────────────────────────────────────────────
/* Places API (New) Text Search. The field mask is deliberately short: it sets
   the billing tier, and every field we ask for is one we would then have to
   delete at judgement time anyway. */
/* places.photos is a Pro-tier field and rating/userRatingCount/websiteUri/
   nationalPhoneNumber are Enterprise-tier, so this mask bills at Enterprise
   either way — the photo list rides along for nothing. We only ever COUNT the
   references; fetching an actual photo is a separate SKU we never call.

   Photo count is one of the better tells in this whole pipeline. A working
   trade business with four photos on its listing is not managing its online
   presence; one with sixty has someone who is. */
const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.photos",
  "places.businessStatus"
].join(",");

export async function placesTextSearch(env, query, signal) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(env.GOOGLE_PLACES_API_KEY),
      "X-Goog-FieldMask": PLACES_FIELDS
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 20 }),
    signal: signal || AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Places " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  return (data.places || []).map((p) => ({
    place_id: p.id,
    name: (p.displayName && p.displayName.text) || "",
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || "",
    website: p.websiteUri || "",
    rating: p.rating == null ? null : Number(p.rating),
    review_count: p.userRatingCount == null ? null : Number(p.userRatingCount),
    photo_count: Array.isArray(p.photos) ? p.photos.length : 0,
    status: p.businessStatus || ""
  }));
}

/* Is this business already known to us?
   Checked against BOTH the CRM and the candidate table, on all three keys, so
   a business sourced last week under a different query does not get paid for
   twice. A hit on `clients` is final: rule 2 says we do not touch it. */
export async function findExisting(env, cand) {
  const db = env.CRM_DB;
  const phone = normalisePhone(cand.phone);
  const domain = registrableDomain(cand.website);

  const byPlace = await db.prepare(
    "SELECT id, do_not_contact FROM clients WHERE place_id = ? LIMIT 1"
  ).bind(cand.place_id).first();
  if (byPlace) return { where: "clients", on: "place_id", row: byPlace };

  if (phone) {
    /* Compare on digits, not on the stored string: the CRM's phone column
       holds whatever a human typed into it. */
    const rows = await db.prepare(
      "SELECT id, phone, do_not_contact FROM clients WHERE phone IS NOT NULL AND phone != ''"
    ).all();
    const hit = (rows.results || []).find((r) => normalisePhone(r.phone) === phone);
    if (hit) return { where: "clients", on: "phone", row: hit };
  }
  if (domain) {
    const rows = await db.prepare(
      "SELECT id, website_url, do_not_contact FROM clients WHERE website_url IS NOT NULL AND website_url != ''"
    ).all();
    const hit = (rows.results || []).find((r) => registrableDomain(r.website_url) === domain);
    if (hit) return { where: "clients", on: "domain", row: hit };
  }

  const seen = await db.prepare(
    "SELECT id, status FROM lead_candidates WHERE place_id = ? LIMIT 1"
  ).bind(cand.place_id).first();
  if (seen) return { where: "lead_candidates", on: "place_id", row: seen };

  return null;
}

/* ── CHEAP TRIAGE, BEFORE ANY MONEY IS SPENT ────────────────────────────────
   Places gives us review count, photo count and whether a website exists for
   the price of the search we already paid for. Research costs ~$0.06 a head,
   so spending it on a business that visibly cannot fit the profile is waste —
   and worse, it fills the caller's list with near-misses.

   Two jobs here. reject() throws out the clearly-hopeless for free. promise()
   ranks what is left, so the five we DO pay to research each run are the five
   that look most like the profile, rather than whichever happened to be
   sourced first.

   Both read only free fields. Nothing here is a final verdict — the scorer
   still decides, having actually read the business. */
export function placesReject(p) {
  const rc = p.review_count;
  if (rc == null || rc < 5) {
    return "only " + (rc == null ? "no" : rc) + " reviews — no evidence of real trading";
  }
  if (rc > 150) {
    return rc + " reviews — too established to buy a cheap site";
  }
  return null;
}

export function placesPromise(p) {
  let score = 0;
  const rc = Number(p.review_count || 0);

  // A real, working business, not a giant one. 8-80 is the sweet spot.
  if (rc >= 8 && rc <= 80) score += 40;
  else if (rc > 80 && rc <= 150) score += 15;
  else score += 5;

  // No website at all is the strongest free signal we get.
  if (!p.website) score += 35;

  // Few photos means nobody is tending the listing.
  const ph = Number(p.photo_count || 0);
  if (ph <= 5) score += 25;
  else if (ph <= 15) score += 12;
  else if (ph >= 40) score -= 10;

  return Math.max(0, Math.min(100, score));
}

// ── the search grid ───────────────────────────────────────────────────────
/* Trades that sub to general contractors, the handyman end of the same
   market, and independent dealers. Second-tier cities on purpose: far more
   businesses with no web presence at all, and far less competition from other
   agencies for a $99 site than in a coastal metro.

   Utah rows ship DISABLED. "Businesses that aren't local" is the one input I
   could not resolve without knowing which town is home — enable the ones you
   want with a single UPDATE (see the README). Nothing in Utah is called until
   you do. */
const SUBCONTRACTOR_QUERIES = [
  "concrete contractor", "framing contractor", "drywall contractor",
  "electrician", "plumber", "HVAC contractor", "roofing contractor",
  "painting contractor", "flooring installer", "fencing contractor",
  "excavation contractor", "siding contractor", "masonry contractor",
  "stucco contractor", "insulation contractor", "gutter installer"
];
/* General contractors are a different animal: an established GC has a real
   site, a real crew and no interest in a $99 anything. They are searched, but
   the scorer is told to reject any that look established — so this list earns
   its place only through the small and new ones. */
const GENERAL_QUERIES = ["general contractor", "home builder", "remodeling contractor"];
const HANDYMAN_QUERIES = ["handyman", "handyman services", "home repair service"];
const DEALER_QUERIES = ["used car dealer", "auto sales", "pre-owned vehicles"];

const CITIES = [
  ["Bakersfield", "CA", 1], ["Fresno", "CA", 1], ["Visalia", "CA", 1],
  ["Modesto", "CA", 1], ["Stockton", "CA", 1], ["Chico", "CA", 1],
  ["Redding", "CA", 1], ["Merced", "CA", 1],
  ["Tucson", "AZ", 1], ["Yuma", "AZ", 1], ["Prescott", "AZ", 1],
  ["Kingman", "AZ", 1], ["Flagstaff", "AZ", 1], ["Casa Grande", "AZ", 1],
  ["Logan", "UT", 0], ["Ogden", "UT", 0], ["Provo", "UT", 0],
  ["St George", "UT", 0], ["Cedar City", "UT", 0], ["Vernal", "UT", 0]
];

export function defaultSources() {
  /* Subcontractors are the target. General contractors ride along but only
     convert when they are small; handymen and dealers are seeded so the grid
     is there to switch on, but ship DISABLED — one UPDATE turns either back on
     without re-deriving the whole city list. Utah likewise. */
  const out = [];
  for (const [city, state, on] of CITIES) {
    for (const q of SUBCONTRACTOR_QUERIES)
      out.push({ query_template: q, city, state, segment: "subcontractor", offer_hint: 2, enabled: on });
    for (const q of GENERAL_QUERIES)
      out.push({ query_template: q, city, state, segment: "general", offer_hint: 2, enabled: on });
    for (const q of HANDYMAN_QUERIES)
      out.push({ query_template: q, city, state, segment: "handyman", offer_hint: 1, enabled: 0 });
    for (const q of DEALER_QUERIES)
      out.push({ query_template: q, city, state, segment: "dealer", offer_hint: 3, enabled: 0 });
  }
  return out;
}

/* Seeds the grid on an empty table. With force=true it REPLACES the grid —
   which matters because the table is only ever seeded once, so a change to
   defaultSources() is invisible to a database that has already been seeded.
   A reseed drops manual edits with it: any row you switched on by hand goes
   back to whatever this file ships. That is why it is opt-in. */
export async function seedLeadSources(env, force) {
  const db = env.CRM_DB;
  const n = await db.prepare("SELECT COUNT(*) AS c FROM lead_sources").first();
  if (n && Number(n.c) > 0) {
    if (!force) return 0;
    await db.prepare("DELETE FROM lead_sources").run();
  }
  const now = new Date().toISOString();
  const rows = defaultSources();
  for (const r of rows) {
    await db.prepare(
      `INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(r.query_template, r.city, r.state, r.segment, r.offer_hint, r.enabled, now).run();
  }
  return rows.length;
}

// ── stage 1: source + dedupe (no AI, costs pennies) ───────────────────────
export async function sourceCandidates(env, counts, opts) {
  const db = env.CRM_DB;
  const batch = (opts && opts.sourceBatch) || LEAD_DEFAULTS.sourceBatch;
  const now = new Date().toISOString();

  /* Oldest-run-first so the grid rotates evenly instead of hammering whatever
     sorts first. NULL last_run_at sorts first, so new rows go before old. */
  const srcs = await db.prepare(
    `SELECT * FROM lead_sources WHERE enabled = 1
     ORDER BY last_run_at IS NOT NULL, last_run_at ASC LIMIT ?`
  ).bind(batch).all();

  for (const s of srcs.results || []) {
    const query = `${s.query_template} ${s.city} ${s.state}`;
    let found = [];
    try {
      found = await placesTextSearch(env, query);
      counts.est_cost_usd += LEAD_COST.placesSearchUsd;
    } catch (e) {
      counts.errors.push("source[" + query + "]: " + String(e).slice(0, 200));
      continue;
    }
    await db.prepare("UPDATE lead_sources SET last_run_at = ? WHERE id = ?").bind(now, s.id).run();

    for (const p of found) {
      if (!p.place_id) continue;
      // Permanently closed businesses are not leads.
      if (p.status && p.status !== "OPERATIONAL") { counts.deduped++; continue; }
      counts.sourced++;
      const existing = await findExisting(env, p);
      if (existing) { counts.deduped++; continue; }

      /* Free triage, before a single paid call. A hopeless candidate is still
         written down — as a tombstone carrying place_id, the verdict and the
         reason, and none of the Places content — so the next run that meets
         this business again dedupes it away instead of paying to look at it
         a second time. */
      const veto = placesReject(p);
      if (veto) {
        await db.prepare(
          `INSERT INTO lead_candidates
             (place_id, segment, offer_hint, source_id, status, promise, score, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'rejected', 0, 0, ?, ?, ?)`
        ).bind(p.place_id, s.segment, s.offer_hint, s.id, veto.slice(0, 300), now, now).run();
        counts.screened++;
        continue;
      }

      await db.prepare(
        `INSERT INTO lead_candidates
           (place_id, segment, offer_hint, source_id, status, promise, places_json, places_fetched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`
      ).bind(p.place_id, s.segment, s.offer_hint, s.id, placesPromise(p),
             JSON.stringify(p), now, now, now).run();
    }
  }
}

// ── stage 2: judge the website (free) ─────────────────────────────────────
/* This used to be two AI calls per business: Grok researched it from search
   results, then Claude scored the research. Both are gone.

   The reason is not that they worked badly — it is that they were being asked
   a question we can already answer. What qualifies a lead here is exactly one
   thing: no website, or a website that is old or performing badly. Whether a
   website exists is in the Places row we have already paid for. How old and
   how slow it is, Google will tell us for free. Paying an AI five cents to
   read search results and guess at both was spending money to be told
   something we could look up. */

/* Pasting a key into a dashboard field catches a trailing newline or a
   leading space more often than anyone admits, and the provider answers with
   a flat "API key is invalid" that sends you looking at the wrong thing. */
export function apiKey(v) { return String(v == null ? "" : v).trim(); }

/* Some failures are about the ACCOUNT, not the request: a rejected key, an
   empty credit balance, a suspended org. None of them will come right by
   trying again — the answer is identical six seconds later, on the next
   candidate, and on the one after that. Marking one lets the run stop instead
   of asking the same question of every business in the queue.
   Everything else — a timeout, a 429, a 500 — retries as before.

   A 401/403 is the obvious shape. The expensive one to miss is billing: both
   providers report an empty balance as a plain 400, which looks like any
   other bad request, so it is matched on the wording as well. */
export function accountFailure(status, body) {
  if (status === 401 || status === 403 || status === 402) return true;
  if (status !== 400) return false;
  return /credit balance|billing|purchase credits|insufficient (funds|credit)|quota/i
    .test(String(body));
}

export function providerError(who, status, body) {
  const e = new Error(who + " " + status + ": " + String(body).slice(0, 300));
  if (accountFailure(status, body)) e.accountFailure = true;
  return e;
}


/* "Websites" that are not websites. A listing pointing at a Facebook page, a
   Linktree or a marketplace profile means the business has no site of its own
   — which is the pitch, not a disqualification.

   business.site deserves its own mention: that was Google's free website
   builder, and Google shut it down in 2024. A business still listing one has
   a website that does not load at all and may well not know. */
const NOT_A_WEBSITE = [
  "facebook.com", "m.facebook.com", "instagram.com", "linktr.ee", "yelp.com",
  "business.site", "sites.google.com", "nextdoor.com", "angi.com", "thumbtack.com",
  "houzz.com", "bbb.org", "google.com", "linkedin.com", "x.com", "twitter.com"
];

export function notARealWebsite(url) {
  const d = registrableDomain(url);
  if (!d) return null;
  for (const bad of NOT_A_WEBSITE) {
    if (d === bad || d.endsWith("." + bad)) return bad;
  }
  return null;
}

/* Google PageSpeed Insights, v5. Free, and it is Google fetching the page
   rather than us — we never request the site ourselves.

   Two things are read from it. The performance score is the "bad performing"
   half of the brief. The `viewport` audit is the "old" half: a page with no
   viewport meta tag was built before responsive design and has never been
   touched since, which on a phone is the difference between a website and a
   photograph of one.

   A real run takes ten to thirty seconds per site, which is why the run
   streams its progress. */
export async function pageSpeed(env, url, fetchImpl) {
  const key = apiKey(env.GOOGLE_PLACES_API_KEY);
  const q = new URLSearchParams({ url: url, strategy: "mobile", category: "performance" });
  if (key) q.set("key", key);

  const res = await (fetchImpl || fetch)(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q.toString(),
    { signal: AbortSignal.timeout(120000) }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw providerError("PageSpeed", res.status, body);
  }
  const data = await res.json();
  const lh = (data && data.lighthouseResult) || {};

  /* A site Google cannot fetch at all is not a healthy site. It is reported
     in-band as a runtimeError with HTTP 200, not as an error status. */
  if (lh.runtimeError && lh.runtimeError.code) {
    return { unreachable: true, code: lh.runtimeError.code, performance: null, hasViewport: null };
  }

  const perf = lh.categories && lh.categories.performance;
  const viewport = lh.audits && lh.audits.viewport;
  return {
    unreachable: false,
    code: null,
    // Lighthouse scores 0-1; a percentage is what everyone actually talks in.
    performance: perf && typeof perf.score === "number" ? Math.round(perf.score * 100) : null,
    hasViewport: viewport && typeof viewport.score === "number" ? viewport.score === 1 : null
  };
}

/* How bad a site has to be to be worth a call. 50 is Lighthouse's own
   boundary between "needs improvement" and "poor" on mobile. */
export const SLOW_AT = 50;

/* The whole qualification, in one place. Returns a verdict with a score so
   the CRM can still rank, and a reason a caller can read down the phone
   without being briefed.

   The cheap checks come first and most businesses never reach PageSpeed. */
export async function websiteVerdict(env, places, deps) {
  const reviews = places.review_count == null ? null : Number(places.review_count);
  const trading = reviews == null ? "" : ", " + reviews + " Google reviews";

  if (!places.website) {
    return { qualified: true, score: 95, checked: "places", speed: null, mobileReady: null,
             reason: "No website at all" + trading + "." };
  }

  const impostor = notARealWebsite(places.website);
  if (impostor) {
    const dead = impostor === "business.site";
    return { qualified: true, score: dead ? 95 : 90, checked: "places",
             speed: null, mobileReady: null,
             reason: dead
               ? "Their only site is a Google business.site page, which Google shut down — it does not load" + trading + "."
               : "No site of their own, just a " + impostor + " page" + trading + "." };
  }

  // Plain HTTP in 2026 means nobody has touched it in a decade, and every
  // browser tells their customers it is not secure.
  if (/^http:\/\//i.test(String(places.website).trim())) {
    return { qualified: true, score: 85, checked: "places", speed: null, mobileReady: null,
             reason: "Site is still on plain http — browsers mark it not secure" + trading + "." };
  }

  const ps = await (deps && deps.pageSpeed ? deps.pageSpeed : pageSpeed)(env, places.website);

  if (ps.unreachable) {
    return { qualified: true, score: 90, checked: "pagespeed", speed: null, mobileReady: null,
             reason: "Google cannot load their website (" + ps.code + ")" + trading + "." };
  }
  if (ps.hasViewport === false) {
    return { qualified: true, score: 88, checked: "pagespeed",
             speed: ps.performance, mobileReady: false,
             reason: "Site has no mobile viewport — it was built before phones mattered and is unusable on one" + trading + "." };
  }
  if (ps.performance != null && ps.performance < SLOW_AT) {
    return { qualified: true, score: 75, checked: "pagespeed",
             speed: ps.performance, mobileReady: ps.hasViewport,
             reason: "Website scores " + ps.performance + "/100 on Google's mobile speed test" + trading + "." };
  }

  return { qualified: false, score: ps.performance == null ? 20 : ps.performance,
           checked: "pagespeed", speed: ps.performance, mobileReady: ps.hasViewport,
           reason: ps.performance == null
             ? "Has a working site; Google returned no score for it."
             : "Website is fine — " + ps.performance + "/100 on mobile. Nothing to sell them." };
}

// ── stage 4: push to the CRM ──────────────────────────────────────────────
/* INSERT ONLY. There is no UPDATE path in this function and there should never
   be one — see rule 2 at the top of the file. findExisting() has already run;
   if it found anything, we never get here.

   status stays 'lead'. The CRM validates status against a fixed list in both
   the Worker and crm.html, and "ready to call" is not in it — a row with that
   status would fail validation and not render. Ranking is lead_score, which
   is what a caller actually sorts by. */
export async function pushLeadToCrm(env, cand, places, verdict) {
  const now = new Date().toISOString();
  /* Contact details are what the caller needs in front of them for a business
     we are about to ring — not a durable copy of a Places record. */
  const phone = places.phone || null;
  const website = places.website || null;

  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients
       (business_name, phone, website_url, status, source, service,
        place_id, lead_score, lead_segment, lead_offer, lead_reason,
        lead_address, lead_speed, lead_mobile_ready, lead_check,
        created_by_pipeline, do_not_contact, created_at, updated_at)
     VALUES (?, ?, ?, 'lead', 'pipeline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).bind(
    places.name || "",
    phone,
    website,
    offerName(cand.offer_hint),
    cand.place_id,
    verdict.score,
    cand.segment,
    cand.offer_hint,
    verdict.reason || "",
    /* Name, phone, website and address are what it takes to actually ring a
       business; they live here because we are working the lead, not because
       we are keeping a copy of a Places record. Everything else a caller
       wants — reviews, photos, hours — is one click away on the live Google
       listing via place_id, which is better than a stale copy anyway. */
    places.address || "",
    verdict.speed == null ? null : verdict.speed,
    verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
    verdict.checked || null,
    now,
    now
  ).run();
  // `message` is left alone on purpose: it is the human's note field, and a
  // pipeline lead never wrote us an inquiry to put in it.
  return (res && res.meta && res.meta.last_row_id) || null;
}

export function offerName(n) {
  if (n === 1) return "$99 Website";
  if (n === 2) return "Credibility Website";
  if (n === 3) return "Dealership CRM";
  return "Unknown";
}

// ── judgement: strip the candidate row ────────────────────────────────────
/* The row keeps place_id (storable forever), our own score and a one-line
   reason, and loses every byte of Places and research content. That is enough
   to never re-source the business and to tell a 15 from a 65 later, and it is
   not a copy of anyone's data. */
export async function stripCandidate(env, id, status, score, reason, crmId) {
  await env.CRM_DB.prepare(
    `UPDATE lead_candidates
        SET status = ?, score = ?, reason = ?, crm_client_id = ?,
            places_json = NULL, enrichment_json = NULL, opener = NULL,
            updated_at = ?
      WHERE id = ?`
  ).bind(status, score == null ? null : score, (reason || "").slice(0, 300),
         crmId == null ? null : crmId, new Date().toISOString(), id).run();
}

// ── cost ceiling ──────────────────────────────────────────────────────────
export async function spentToday(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await env.CRM_DB.prepare(
    "SELECT COALESCE(SUM(est_cost_usd), 0) AS c FROM enrichment_runs WHERE started_at >= ?"
  ).bind(since).first();
  return Number((row && row.c) || 0);
}

// ── the run ───────────────────────────────────────────────────────────────
/* One run: source a couple of queries, then enrich+score up to `perRun`
   candidates. Every paid call is preceded by a ceiling check, so a run that
   starts under budget and crosses it mid-way stops cleanly rather than
   finishing the batch.

   opts.dryRun sources and dedupes and makes NO paid AI calls — the cheap mode
   for looking at what the grid actually returns before spending on it. */
export async function runLeadPipeline(env, opts) {
  const o = opts || {};
  const perRun = Math.max(1, Math.min(25, Number(o.limit) || LEAD_DEFAULTS.perRun));
  const cap = Number(env.LEADS_DAILY_USD_CAP || LEAD_DEFAULTS.dailyUsdCap);
  const db = env.CRM_DB;

  await ensureLeadPipelineTables(env);
  await seedLeadSources(env, !!o.reseed);

  const counts = {
    sourced: 0, deduped: 0, enriched: 0, scored: 0,
    pushed: 0, screened: 0, rejected: 0, failed: 0, est_cost_usd: 0, errors: []
  };
  const started = new Date().toISOString();
  const run = await db.prepare(
    "INSERT INTO enrichment_runs (trigger, started_at) VALUES (?, ?)"
  ).bind(o.trigger || "manual", started).run();
  const runId = (run && run.meta && run.meta.last_row_id) || null;

  const already = await spentToday(env);
  const overBudget = () => already + counts.est_cost_usd >= cap;

  /* A caller that is streaming the run to a browser passes onProgress. It is
     never allowed to break the run: the client can hang up at any moment, and
     a failed write must not cost a candidate that is already paid for. */
  const emit = async (evt) => {
    if (!o.onProgress) return;
    try { await o.onProgress(evt); } catch (e) { /* client gone; keep going */ }
  };

  /* Write what has been spent so far back to the run row after every paid
     candidate, instead of only at the end. A run that is cut off halfway --
     the tab closed, the Worker killed -- has still spent that money, and the
     daily ceiling has to know about it or it silently under-counts. */
  const checkpoint = async () => {
    if (!runId) return;
    await db.prepare(
      `UPDATE enrichment_runs SET sourced = ?, deduped = ?, enriched = ?, scored = ?,
              pushed = ?, screened = ?, rejected = ?, failed = ?, est_cost_usd = ? WHERE id = ?`
    ).bind(counts.sourced, counts.deduped, counts.enriched, counts.scored,
           counts.pushed, counts.screened, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)), runId).run();
  };

  try {
    await emit({ event: "sourcing" });
    if (!overBudget()) await sourceCandidates(env, counts, o);
    else counts.errors.push("daily cost ceiling reached before sourcing");
    await checkpoint();
    await emit({ event: "sourced", sourced: counts.sourced,
                 deduped: counts.deduped, screened: counts.screened });

    if (!o.dryRun) {
      /* Recover anything a killed run left mid-flight. A candidate is set to
         'enriching' before the paid call and moved on after it, so a row still
         sitting in 'enriching' long afterwards belongs to a run that died --
         the tab closed, the request cut off. Nothing picks those up again,
         because the batch query only looks at 'new' and 'enriched', so without
         this they are stranded for good.

         Half an hour is well past the longest a live candidate can take (three
         attempts at a three-minute ceiling) so this cannot steal a row from a
         run that is still working. The attempt it burned stays burned: if the
         call really is what is killing the run, it still retires after three. */
      /* Anything an earlier billing or key lapse retired comes back. It was
         never the candidate's fault, and its research is usually still banked
         on the row, so reviving costs nothing and recovers what was paid for. */
      await db.prepare(
        `UPDATE lead_candidates SET status = 'new', attempts = 0, updated_at = ?
          WHERE status = 'failed' AND last_error LIKE ?`
      ).bind(new Date().toISOString(), ACCOUNT_FAIL + "%").run();

      const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await db.prepare(
        `UPDATE lead_candidates SET status = 'new', updated_at = ?
          WHERE status = 'enriching' AND updated_at < ?`
      ).bind(new Date().toISOString(), staleBefore).run();

      const batch = await db.prepare(
        `SELECT * FROM lead_candidates
          WHERE status IN ('new','enriched') AND attempts < ?
          ORDER BY COALESCE(promise, -1) DESC, id ASC LIMIT ?`
      ).bind(LEAD_DEFAULTS.maxAttempts, perRun).all();

      const queue = batch.results || [];
      await emit({ event: "batch", total: queue.length });

      let position = 0;
      for (const cand of queue) {
        position++;
        if (overBudget()) { counts.errors.push("daily cost ceiling reached"); break; }
        const places = safeParse(cand.places_json);
        if (!places) {
          await failCandidate(env, cand, "no places_json", counts);
          continue;
        }
        try {
          await db.prepare("UPDATE lead_candidates SET attempts = attempts + 1, status = 'enriching', updated_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), cand.id).run();

          await emit({ event: "checking", position: position, total: queue.length,
                       name: places.name || null, website: places.website || null });

          /* No retry wrapper. The expensive, flaky, worth-retrying step was
             the AI research; a PageSpeed run that fails is either a site that
             will not load — which is itself a qualification — or an account
             problem, which stops the run. */
          const verdict = await websiteVerdict(env, places, o.deps);
          counts.scored++;

          if (verdict.qualified) {
            const crmId = await pushLeadToCrm(env, cand, places, verdict);
            await stripCandidate(env, cand.id, "pushed", verdict.score, verdict.reason, crmId);
            counts.pushed++;
          } else {
            await stripCandidate(env, cand.id, "rejected", verdict.score, verdict.reason, null);
            counts.rejected++;
          }
          await checkpoint();
          /* The name is safe to send down the wire and gone from the row a
             line later -- the candidate was just stripped. It is here so the
             person watching sees a business, not a row id. */
          await emit({ event: "judged", position: position, total: queue.length,
                       name: places.name || null, score: verdict.score,
                       kept: verdict.qualified, reason: verdict.reason || null,
                       checked: verdict.checked,
                       spent: Number(counts.est_cost_usd.toFixed(4)) });
        } catch (e) {
          const account = !!(e && e.accountFailure);
          await failCandidate(env, cand, String(e).slice(0, 300), counts, account);
          await checkpoint();
          await emit({ event: "candidate_failed", position: position,
                       total: queue.length, name: (places && places.name) || null,
                       account: account });
          /* A rejected key or an empty balance is the same answer for every
             candidate in the queue. Carrying on costs five cents a head to be
             told it five times, so the run stops and says what to go and fix. */
          if (account) {
            counts.errors.push("stopped: " + String(e.message || e).slice(0, 200));
            break;
          }
        }
      }
    }
  } catch (e) {
    counts.errors.push("run: " + String(e).slice(0, 300));
  }

  if (runId) {
    await db.prepare(
      `UPDATE enrichment_runs SET finished_at = ?, sourced = ?, deduped = ?, enriched = ?,
              scored = ?, pushed = ?, screened = ?, rejected = ?, failed = ?, est_cost_usd = ?, error = ?
        WHERE id = ?`
    ).bind(new Date().toISOString(), counts.sourced, counts.deduped, counts.enriched,
           counts.scored, counts.pushed, counts.screened, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)),
           counts.errors.length ? counts.errors.join(" | ").slice(0, 900) : null,
           runId).run();
  }
  return { run_id: runId, dry_run: !!o.dryRun, ...counts };
}

/* A candidate that has burned its attempts is marked failed and left alone;
   the batch query filters on attempts so it never comes back.

   Unless the failure was the account's. A rejected key or an empty balance
   says nothing about the business, and three runs during a billing lapse
   would otherwise retire perfectly good candidates for good. Those give the
   attempt back and carry the ACCOUNT_FAIL marker, which the next run reads to
   revive anything an earlier lapse already retired. */
export const ACCOUNT_FAIL = "[account] ";

async function failCandidate(env, cand, msg, counts, account) {
  const attempts = account ? Number(cand.attempts || 0) : Number(cand.attempts || 0) + 1;
  const terminal = !account && attempts >= LEAD_DEFAULTS.maxAttempts;
  if (terminal) counts.failed++;
  const text = (account ? ACCOUNT_FAIL : "") + msg;
  counts.errors.push("candidate " + cand.id + ": " + msg);
  await env.CRM_DB.prepare(
    `UPDATE lead_candidates SET status = ?, attempts = ?, last_error = ?, updated_at = ?
      WHERE id = ?`
  ).bind(terminal ? "failed" : "new", attempts, text.slice(0, 300),
         new Date().toISOString(), cand.id).run();
}


function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
