/* ══════════════════════════════════════════════════════════════════════════
   LEAD ENRICHMENT PIPELINE

   Sources local businesses from Google Places, judges each one's website with
   free checks (Places fields, then Google PageSpeed), and inserts the ones
   that qualify into the CRM's `clients` table as leads. (The Grok research
   and Claude scoring stages described in older notes were removed.)

   Two PROFILES share this file and the `lead_sources` grid:
   - 'domestic' (default) — US trades/detailers/dealers with no or weak sites.
     Its behaviour is pinned by leadpipeline.test.mjs and must not change.
   - 'intl' — established tourism businesses abroad (first slice: Cabo San
     Lucas yacht charters). Inverted qualifying rules (website required, no
     review ceiling), and contacts come from crawling the business's own
     site (intlcrawl.js) into `lead_emails`. See runIntlPipeline().

   Three rules shape most of the code below.

   1. PLACES CONTENT IS BORROWED, NOT KEPT. Google's terms let us store
      `place_id` indefinitely and essentially nothing else. So Places fields
      live in lead_candidates only while a candidate is being judged, and the
      row is stripped the moment it is.
      KNOWN GAP (domestic): pushLeadToCrm still copies the Places name, phone,
      website and address onto the `clients` row so a caller can ring the
      lead. That is a deliberate, documented exception pending Nando's call
      (audit 2026-11-02, question 8) and is left unchanged here. The intl
      profile does better: phone/email come from the business's own website
      where it publishes them, and the full Places address is not stored.

   2. THE PIPELINE NEVER OVERWRITES. It only ever INSERTs into `clients`. If a
      business is already there — however it got there, however stale it looks
      — the pipeline leaves it completely alone. A caller's hand-typed note is
      worth more than anything this file can work out.

   3. IT SPENDS REAL MONEY. Every run is capped, every call is logged with its
      estimated cost, and a daily ceiling is checked before each paid call.
   ══════════════════════════════════════════════════════════════════════════ */


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
  /* Websites checked per run. This was 5 when each one cost six cents of AI
     research; checking is free now, so the only cost is the ten to thirty
     seconds Google takes per site that actually has one. At 20 the run drains
     its queue at roughly the rate sourcing fills it, instead of paying Places
     for candidates that pile up unjudged. */
  perRun: 20,
  dailyUsdCap: 5.0,
  maxAttempts: 3,
  sourceBatch: 2,             // Places queries per run
  /* Star rating a business has to clear to be worth calling. Tunable without
     a deploy via LEADS_MIN_RATING, because where exactly the line sits is a
     judgement about who you want as a customer, not a fact about the code. */
  minRating: 4.0,
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
      /* status: new -> enriching -> pushed | rejected | failed, or 'screened'
         for a business vetoed on the free Places fields without ever being
         checked. 'screened' is the only one ?rescreen=1 will clear. */
      place_id TEXT NOT NULL UNIQUE, segment TEXT NOT NULL, trade TEXT, offer_hint INTEGER,
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
  const candNames = (candCols.results || []).map((r) => r.name);
  if (candNames.indexOf("promise") === -1) {
    await db.prepare("ALTER TABLE lead_candidates ADD COLUMN promise INTEGER").run();
  }
  // Which search found them — "roofing contractor", not just "subcontractor".
  if (candNames.indexOf("trade") === -1) {
    await db.prepare("ALTER TABLE lead_candidates ADD COLUMN trade TEXT").run();
  }

  /* Profiles (2026-11-02). Existing rows are all domestic, which is exactly
     what the defaults say, so adding the columns changes nothing for them.
     `region` is the generic name for what `state` holds; `state` stays for
     compatibility and is still what the domestic query string uses. */
  const srcCols = (await db.prepare("PRAGMA table_info(lead_sources)").all()).results || [];
  const srcNames = srcCols.map((r) => r.name);
  for (const [name, decl] of [["profile", "TEXT NOT NULL DEFAULT 'domestic'"],
                              ["country", "TEXT NOT NULL DEFAULT 'US'"],
                              ["region", "TEXT"],
                              ["tier", "INTEGER"],
                              ["language", "TEXT"]]) {
    if (srcNames.indexOf(name) === -1) {
      await db.prepare(`ALTER TABLE lead_sources ADD COLUMN ${name} ${decl}`).run();
    }
  }

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      source_url TEXT,
      discovered_at TEXT NOT NULL,
      type TEXT,                       -- role | freemail_role | freemail
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      eligibility TEXT NOT NULL DEFAULT 'pending_verification', -- pending_verification | review | eligible | ineligible
      last_contacted_at TEXT,
      opted_out INTEGER NOT NULL DEFAULT 0,
      UNIQUE (client_id, email))`
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_emails_email ON lead_emails(email)").run();

  /* Phase 2 (2026-11-03, migrations/0006_lead_evidence.sql): every US-
     relevance signal and audit finding, with the page it came from. */
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      kind TEXT NOT NULL,              -- usd_price | us_phone | ... | audit_https | audit_viewport | ...
      category TEXT NOT NULL,          -- us | audit
      status TEXT NOT NULL,            -- us: confirmed | needs_review; audit: confirmed_issue | opportunity_needs_review | ok | untested
      confirmed INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      snippet TEXT,
      created_at TEXT NOT NULL)`
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_evidence_client ON lead_evidence(client_id, category)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_evidence_kind ON lead_evidence(kind, status)").run();

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
    ["lead_area", "TEXT"],
    ["lead_speed", "INTEGER"],
    ["lead_mobile_ready", "INTEGER"],
    ["lead_check", "TEXT"],
    ["lead_trade", "TEXT"],
    ["created_by_pipeline", "INTEGER NOT NULL DEFAULT 0"],
    // International profile. NULL on every domestic row.
    ["country", "TEXT"],
    ["city", "TEXT"],
    // Intl Phase 2 (0006). NULL on every domestic row.
    ["lead_us_score", "INTEGER"],          // 0-100, capped unless >=2 confirmed non-language signals
    ["lead_us_signals", "INTEGER"],        // confirmed non-language US signals
    ["lead_opportunity_score", "INTEGER"], // 0-100, rule-based
    ["lead_suggested_service", "TEXT"],    // website_rebuild | bilingual_site | booking_ux | speed_tuneup | analytics_tracking | growth_retainer
    ["lead_tier", "TEXT"],                 // A | B | C
    ["lead_talking_points", "TEXT"]        // JSON array; confirmed evidence only
  ];
  for (const [name, decl] of wanted) {
    if (cols.indexOf(name) === -1) {
      await db.prepare(`ALTER TABLE clients ADD COLUMN ${name} ${decl}`).run();
    }
  }

  /* Subcontractors, general contractors and handymen used to be three
     categories. Renaming
     them in place keeps every row's last_run_at and enabled flag, which a
     rebuild would throw away — and rebuilds are the thing that loses track of
     which cities have already been searched. Idempotent: once nothing matches
     it does nothing.

     Runs last on purpose: it writes clients.lead_segment, which only exists
     after the loop above has added it. */
  for (const [table, col] of [["lead_sources", "segment"],
                              ["lead_candidates", "segment"],
                              ["clients", "lead_segment"]]) {
    await db.prepare(
      `UPDATE ${table} SET ${col} = 'home_service'
        WHERE ${col} IN ('subcontractor', 'general', 'handyman')`
    ).run();
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

/* opts (intl only): { regionCode: 'mx', languageCode: 'es' }. Called with no
   opts the request body is byte-identical to what domestic always sent. */
export async function placesTextSearch(env, query, signal, opts) {
  const req = { textQuery: query, maxResultCount: 20 };
  if (opts && opts.regionCode) req.regionCode = opts.regionCode;
  if (opts && opts.languageCode) req.languageCode = opts.languageCode;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(env.GOOGLE_PLACES_API_KEY),
      "X-Goog-FieldMask": PLACES_FIELDS
    },
    body: JSON.stringify(req),
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
export function placesReject(p, minRating) {
  const rc = p.review_count;
  if (rc == null || rc < 5) {
    return "only " + (rc == null ? "no" : rc) + " reviews — no evidence of real trading";
  }
  if (rc > 150) {
    return rc + " reviews — too established to buy a cheap site";
  }

  /* A badly-reviewed business is the wrong customer, not a keener one. A
     website does not fix whatever the reviews are about, the job is more
     likely to end in an argument over the invoice, and it goes in the
     portfolio either way.

     Only applied when Google has a rating to give. The review floor above
     already means anything reaching this line has enough reviews for the
     average to mean something. */
  const floor = minRating == null ? LEAD_DEFAULTS.minRating : Number(minRating);
  const r = p.rating == null ? null : Number(p.rating);
  if (r != null && isFinite(r) && isFinite(floor) && r < floor) {
    return r + " stars from " + rc + " reviews — below the " + floor + " cut-off";
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
/* One entry per category. Everything about a segment lives here — the
   searches, the offer it maps to, whether it ships on, and the name the CRM
   shows — so adding a category is one entry rather than four edits in four
   places that have to agree with each other.

   `on` is only the shipped default. Which categories are actually being
   worked is whatever lead_sources says, and that is what the CRM toggles. */
export const SEGMENTS = [
  {
    /* Everyone who turns up at a house in a van. Specialty trades who sub to
       general contractors, the small GCs who hire them, and handymen — one
       category because they are the same sales conversation: looking
       legitimate to whoever is deciding who gets the job. For a trade that is
       a general contractor picking a bid list; for a handyman it is a
       homeowner choosing who to let through the door. Same product.

       Established general contractors are not the target and never were, but
       nothing here has to know that: the review ceiling in placesReject sends
       anyone big enough to have an agency straight out. */
    key: "home_service", label: "Home Services", offer: 2, on: true,
    queries: [
      "concrete contractor", "framing contractor", "drywall contractor",
      "electrician", "plumber", "HVAC contractor", "roofing contractor",
      "painting contractor", "flooring installer", "fencing contractor",
      "excavation contractor", "siding contractor", "masonry contractor",
      "stucco contractor", "insulation contractor", "gutter installer",
      "general contractor", "home builder", "remodeling contractor",
      "handyman", "handyman services", "home repair service"
    ]
  },
  {
    /* Detailers live or die on being findable and looking the part, and a
       striking number run the whole business off an Instagram account. */
    key: "detailer", label: "Auto detailers", offer: 1, on: false,
    queries: [
      "auto detailing", "mobile detailing", "car detailing",
      "ceramic coating", "auto detailing service"
    ]
  },
  {
    key: "dealer", label: "Car dealerships", offer: 3, on: false,
    queries: ["used car dealer", "auto sales", "pre-owned vehicles", "car dealership"]
  }
];

export const LEAD_SEGMENTS = SEGMENTS.map((s) => s.key);

/* Home. Never called, and never switched on by a category toggle either —
   turning on "Auto detailers" should not start ringing the shop down the road. */
export const HOME_STATE = "UT";

/* Wealthy metros, searched at suburb level rather than by metro name.

   "Los Angeles" as a query returns the same few hundred businesses however
   many times you ask, because Places ranks on prominence — and prominence is
   exactly what our target does not have. A business with no website is not
   winning "drywall contractor Los Angeles". It IS findable under the town it
   actually works in, which is why this list is suburbs: Torrance, Whittier,
   Anaheim, Mesa. Twenty-odd searches across a metro reach twenty different
   sets of businesses; one search on the metro reaches one.

   Money is the point of the list. A subcontractor in Newport Beach or
   Scottsdale is bidding on work where looking legitimate to a GC is worth
   real money, which is the whole pitch of offer 2.

   Utah rows are the home state and stay off. */
const CITIES = [
  // Greater Los Angeles
  ["Pasadena", "CA", 1], ["Glendale", "CA", 1], ["Burbank", "CA", 1],
  ["Santa Monica", "CA", 1], ["Torrance", "CA", 1], ["Long Beach", "CA", 1],
  ["Whittier", "CA", 1], ["Pomona", "CA", 1], ["Santa Clarita", "CA", 1],
  ["Thousand Oaks", "CA", 1], ["Woodland Hills", "CA", 1], ["Downey", "CA", 1],
  ["West Covina", "CA", 1], ["Redondo Beach", "CA", 1], ["Calabasas", "CA", 1],

  // Orange County
  ["Anaheim", "CA", 1], ["Irvine", "CA", 1], ["Santa Ana", "CA", 1],
  ["Huntington Beach", "CA", 1], ["Newport Beach", "CA", 1],
  ["Costa Mesa", "CA", 1], ["Fullerton", "CA", 1], ["Mission Viejo", "CA", 1],
  ["Laguna Niguel", "CA", 1], ["Yorba Linda", "CA", 1], ["Orange", "CA", 1],

  // Inland Empire
  ["Riverside", "CA", 1], ["Temecula", "CA", 1], ["Murrieta", "CA", 1],
  ["Rancho Cucamonga", "CA", 1], ["Corona", "CA", 1], ["Chino Hills", "CA", 1],
  ["Ontario", "CA", 1], ["Redlands", "CA", 1], ["Eastvale", "CA", 1],
  ["San Bernardino", "CA", 1],

  // San Diego County
  ["Carlsbad", "CA", 1], ["Encinitas", "CA", 1], ["Del Mar", "CA", 1],
  ["Poway", "CA", 1], ["Escondido", "CA", 1], ["Oceanside", "CA", 1],
  ["Vista", "CA", 1], ["San Marcos", "CA", 1], ["Chula Vista", "CA", 1],
  ["La Mesa", "CA", 1], ["El Cajon", "CA", 1], ["Coronado", "CA", 1],

  // Ventura County
  ["Ventura", "CA", 1], ["Camarillo", "CA", 1], ["Simi Valley", "CA", 1],
  ["Oxnard", "CA", 1], ["Westlake Village", "CA", 1],

  // Coachella Valley
  ["Palm Springs", "CA", 1], ["Palm Desert", "CA", 1], ["La Quinta", "CA", 1],
  ["Rancho Mirage", "CA", 1], ["Indio", "CA", 1],

  // Greater Phoenix
  ["Scottsdale", "AZ", 1], ["Mesa", "AZ", 1], ["Chandler", "AZ", 1],
  ["Gilbert", "AZ", 1], ["Tempe", "AZ", 1], ["Glendale", "AZ", 1],
  ["Peoria", "AZ", 1], ["Surprise", "AZ", 1], ["Goodyear", "AZ", 1],
  ["Paradise Valley", "AZ", 1], ["Queen Creek", "AZ", 1], ["Avondale", "AZ", 1],

  // Home state. Off.
  ["Logan", "UT", 0], ["Ogden", "UT", 0], ["Provo", "UT", 0],
  ["St George", "UT", 0], ["Cedar City", "UT", 0], ["Vernal", "UT", 0]
];
export function defaultSources() {
  /* Every segment is seeded for every city whether or not it ships on, so
     switching a category on later is one UPDATE rather than a reseed — and a
     reseed would throw away which cities have already been searched.

     ROW ORDER IS LOAD-BEARING. A run takes the two least-recently-searched
     sources, and on a freshly seeded grid nothing has been searched, so they
     come back in insert order. Grouping by city — every query for Pasadena,
     then every query for Glendale — meant the first ten runs in a row all
     searched Pasadena, and the leads all came from one town. It looked like
     the city list was wrong when the city list was fine.

     So the rows are laid out query-major with the city start rotated each
     round: consecutive rows are different towns AND different trades, and a
     single run's two searches never land in the same place. */
  const plan = [];
  for (const seg of SEGMENTS)
    for (const q of seg.queries) plan.push([q, seg.key, seg.offer, seg.on]);

  /* Stepping through CITIES one at a time would still walk the regions in
     blocks — fifteen LA runs, then the Inland Empire, then San Diego. A stride
     jumps across the list instead, so consecutive runs land in different parts
     of Southern California and you see the whole map from the first day.

     The stride has to be coprime with the number of cities or the walk visits
     a subset and repeats it forever, silently never searching the rest. Rather
     than trust a hand-picked number to stay coprime as cities are added, it is
     checked here and falls back to 1, which is always safe. */
  const n = CITIES.length;
  const stride = coprimeStride(17, n);

  const out = [];
  plan.forEach(([query_template, segment, offer_hint, live], round) => {
    for (let i = 0; i < n; i++) {
      const [city, state, on] = CITIES[(i * stride + round) % n];
      out.push({ query_template, city, state, segment, offer_hint,
                 enabled: live ? on : 0 });
    }
  });
  return out;
}

export function coprimeStride(want, n) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  if (n < 2) return 1;
  for (let s = want; s < want + n; s++) {
    const v = ((s - 1) % (n - 1)) + 1;      // keep it in 1..n-1
    if (gcd(v, n) === 1) return v;
  }
  return 1;
}

/* Seeds the grid on an empty table. With force=true it REPLACES the grid —
   which matters because the table is only ever seeded once, so a change to
   defaultSources() is invisible to a database that has already been seeded.
   A reseed drops manual edits with it: any row you switched on by hand goes
   back to whatever this file ships. That is why it is opt-in. */
export async function seedLeadSources(env, force) {
  const db = env.CRM_DB;
  /* Domestic rows only. An intl grid in the same table must neither stop the
     domestic grid seeding nor be wiped by a domestic ?reseed=1. */
  const n = await db.prepare(
    "SELECT COUNT(*) AS c FROM lead_sources WHERE COALESCE(profile, 'domestic') = 'domestic'").first();
  if (n && Number(n.c) > 0) {
    if (!force) return 0;
    await db.prepare("DELETE FROM lead_sources WHERE COALESCE(profile, 'domestic') = 'domestic'").run();
  }
  const now = new Date().toISOString();
  const rows = defaultSources();

  /* Batched. The grid is nearly two thousand rows now, and one statement at a
     time is one network round trip at a time — tens of seconds of doing
     nothing but waiting, for a request a browser is sitting on. */
  const insert = db.prepare(
    `INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(rows.slice(i, i + CHUNK).map((r) =>
      insert.bind(r.query_template, r.city, r.state, r.segment, r.offer_hint, r.enabled, now)));
  }
  return rows.length;
}

// ── stage 1: source + dedupe (no AI, costs pennies) ───────────────────────
export async function sourceCandidates(env, counts, opts) {
  const db = env.CRM_DB;
  const batch = (opts && opts.sourceBatch) || LEAD_DEFAULTS.sourceBatch;
  const minRating = env.LEADS_MIN_RATING == null || env.LEADS_MIN_RATING === ""
    ? LEAD_DEFAULTS.minRating : Number(env.LEADS_MIN_RATING);
  const now = new Date().toISOString();

  /* Oldest-run-first so the grid rotates evenly instead of hammering whatever
     sorts first. NULL last_run_at sorts first, so new rows go before old. */
  const srcs = await db.prepare(
    `SELECT * FROM lead_sources WHERE enabled = 1 AND COALESCE(profile, 'domestic') = 'domestic'
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

      /* Triage on the free fields. A business that fails is still written
         down — a tombstone carrying place_id, the verdict and the reason, and
         none of the Places content — so the next run that meets it dedupes it
         away instead of queueing it up to be checked all over again.

         That tombstone is also how a cut-off gets baked in, which is why
         ?rescreen=1 exists: it clears them so a changed threshold is applied
         to everything, not just to businesses found after the change. */
      const veto = placesReject(p, minRating);
      if (veto) {
        await db.prepare(
          `INSERT INTO lead_candidates
             (place_id, segment, offer_hint, source_id, status, promise, score, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'screened', 0, 0, ?, ?, ?)`
        ).bind(p.place_id, s.segment, s.offer_hint, s.id, veto.slice(0, 300), now, now).run();
        counts.screened++;
        continue;
      }

      await db.prepare(
        `INSERT INTO lead_candidates
           (place_id, segment, trade, offer_hint, source_id, status, promise, places_json, places_fetched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`
      ).bind(p.place_id, s.segment, s.query_template, s.offer_hint, s.id, placesPromise(p),
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


/* "Newport Beach, CA" out of "1401 Dove St Ste 220, Newport Beach, CA 92660,
   USA". The full address belongs on the lead, but what someone scanning a
   list wants is the town — it is how you decide which five to ring this
   morning.

   Worked backwards from the state-and-zip part rather than by counting
   commas from the front, because a suite line adds a comma and a rural
   address drops the street one, so no fixed index is right for both. */
export function placeArea(address) {
  const parts = String(address == null ? "" : address)
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";

  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^([A-Z]{2})\s+\d{5}(-\d{4})?$/.exec(parts[i]);
    if (m) {
      const city = i > 0 ? parts[i - 1] : "";
      return city ? city + ", " + m[1] : m[1];
    }
  }

  // No zip to anchor on — drop a trailing country and take what is left.
  const trimmed = /^(USA|United States)$/i.test(parts[parts.length - 1])
    ? parts.slice(0, -1) : parts;
  if (!trimmed.length) return "";
  return trimmed.length >= 2
    ? trimmed[trimmed.length - 2] + ", " + trimmed[trimmed.length - 1]
    : trimmed[0];
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
  const go = async (withKey) => {
    const q = new URLSearchParams({ url: url, strategy: "mobile", category: "performance" });
    if (withKey && key) q.set("key", key);
    return (fetchImpl || fetch)(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q.toString(),
      { signal: AbortSignal.timeout(120000) }
    );
  };

  let res = await go(true);

  /* PageSpeed is one of the few Google APIs that works with no key at all —
     the key only buys a higher rate limit. So a key the project will not
     accept for this API is a reason to drop the key, not to stop working.
     This is the difference between a misconfigured restriction costing you a
     setting to fix later and costing you every lead in the meantime. */
  if (res.status === 403 && key) {
    res = await go(false);
  }

  /* Keyless requests share one quota with everyone on the internet who has not
     set a key, and it is usually spent. Worth trying as a fallback, not worth
     reporting as though the project itself were out of quota — so if the
     keyless attempt is the thing that hit the limit, say what the KEYED
     attempt said, which is the failure there is something to do about. */
  if (res.status === 429 && key) {
    const body = await res.text().catch(() => "");
    throw providerError("PageSpeed", 403,
      "the API key is not allowed to call PageSpeed, and the keyless fallback is out of shared quota: " +
      String(body).slice(0, 160));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    /* A page Lighthouse could not load comes back as a 400, not as a result —
       and that is a lead, not a failure. A business whose website does not
       answer is the best call on the list after one with no website at all,
       and it was being counted as "could not be researched" and retried until
       the candidate retired. */
    const broken = brokenSiteCode(body);
    if (broken) return { unreachable: true, code: broken, performance: null, hasViewport: null };

    throw providerError("PageSpeed", res.status, body);
  }
  const data = await res.json();
  const lh = (data && data.lighthouseResult) || {};

  /* The same thing said the other way: sometimes it is HTTP 200 with a
     runtimeError in the body instead. Both shapes mean the site is broken. */
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

/* Lighthouse's names for "I could not load this page". Each one is a website
   that does not work for the business's customers either, which is the thing
   being sold against — so they qualify rather than error.

   Matched on the body text because the code arrives in different places
   depending on whether Google answers 200 or 400. */
const BROKEN_SITE_CODES = [
  "FAILED_DOCUMENT_REQUEST",     // the page never loaded
  "ERRORED_DOCUMENT_REQUEST",    // it loaded an error
  "DNS_FAILURE",                 // the domain does not resolve at all
  "INSECURE_DOCUMENT_REQUEST",   // https asked for, http given
  "NO_FCP"                       // nothing ever rendered
];

export function brokenSiteCode(body) {
  const text = String(body == null ? "" : body);
  for (const code of BROKEN_SITE_CODES) {
    if (text.indexOf(code) !== -1) return code;
  }
  return null;
}

/* Something a caller can read out. "FAILED_DOCUMENT_REQUEST" is not. */
const BROKEN_SITE_WORDS = {
  FAILED_DOCUMENT_REQUEST: "their website does not load",
  ERRORED_DOCUMENT_REQUEST: "their website returns an error",
  DNS_FAILURE: "their domain does not resolve — the site is gone",
  INSECURE_DOCUMENT_REQUEST: "their website is not served securely",
  NO_FCP: "their website never finishes loading"
};

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

  /* No speed test available — the key is refused and keyless failed too.
     Everything above this line still worked, so businesses with no usable
     site keep qualifying; this one is simply put back for a later run rather
     than guessed at in either direction. */
  if (deps && deps.noPageSpeed) return { defer: true };

  const ps = await (deps && deps.pageSpeed ? deps.pageSpeed : pageSpeed)(env, places.website);

  if (ps.unreachable) {
    const words = BROKEN_SITE_WORDS[ps.code] || "their website could not be loaded";
    return { qualified: true, score: 92, checked: "pagespeed", speed: null, mobileReady: null,
             reason: "Google could not test it \u2014 " + words + trading + "." };
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
        lead_address, lead_area, lead_speed, lead_mobile_ready, lead_check, lead_trade,
        created_by_pipeline, do_not_contact, created_at, updated_at)
     VALUES (?, ?, ?, 'lead', 'pipeline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
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
    placeArea(places.address),
    verdict.speed == null ? null : verdict.speed,
    verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
    verdict.checked || null,
    cand.trade || null,
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
  if (n === 4) return "International Website";
  return "Unknown";
}

/* A search term is not a label. "gutter installer" is what you type into
   Places; "Gutters" is what you want at the top of a column of leads.

   Explicit where the tidy name is not derivable — Electrical from
   electrician, Handyman from home repair service — and a general rule for
   everything else, so adding a search term does not mean remembering to add
   a label alongside it. */
const TRADE_LABELS = {
  "electrician": "Electrical",
  "plumber": "Plumbing",
  "HVAC contractor": "HVAC",
  "gutter installer": "Gutters",
  "flooring installer": "Flooring",
  "general contractor": "General Contracting",
  "home builder": "General Contracting",
  "remodeling contractor": "Remodeling",
  "handyman": "Handyman",
  "handyman services": "Handyman",
  "home repair service": "Handyman",
  "auto detailing": "Detailing",
  "auto detailing service": "Detailing",
  "car detailing": "Detailing",
  "mobile detailing": "Mobile Detailing",
  "ceramic coating": "Ceramic Coating",
  "used car dealer": "Used Cars",
  "auto sales": "Used Cars",
  "pre-owned vehicles": "Used Cars",
  "car dealership": "Dealership"
};

export function tradeLabel(query) {
  const q = String(query == null ? "" : query).trim();
  if (!q) return "";
  if (TRADE_LABELS[q]) return TRADE_LABELS[q];
  // "drywall contractor" -> "Drywall", "masonry contractor" -> "Masonry".
  const base = q.replace(/\s+(contractor|installer|services?|service)$/i, "");
  return base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* Every search term the grid can produce, mapped to its label. Served to the
   CRM so the sub-categories it offers are the ones the pipeline can actually
   generate, rather than a second list that has to be kept in step. */
export function tradeLabels() {
  const out = {};
  for (const seg of SEGMENTS)
    for (const q of seg.queries) out[q] = tradeLabel(q);
  return out;
}

export function segmentLabel(key) {
  const s = SEGMENTS.find((x) => x.key === key);
  return s ? s.label : key;
}

/* What the CRM's category toggles read and write. Counting rows rather than
   storing a flag keeps one source of truth: lead_sources IS the setting. */
export async function listSegments(env) {
  const rows = await env.CRM_DB.prepare(
    `SELECT segment,
            SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS on_count,
            COUNT(*) AS total
       FROM lead_sources WHERE COALESCE(profile, 'domestic') = 'domestic' GROUP BY segment`
  ).all();
  const bySeg = {};
  for (const r of rows.results || []) bySeg[r.segment] = r;

  return SEGMENTS.map((s) => {
    const r = bySeg[s.key];
    return {
      key: s.key,
      label: s.label,
      searches: Number((r && r.on_count) || 0),
      total: Number((r && r.total) || 0),
      enabled: Number((r && r.on_count) || 0) > 0
    };
  });
}

export async function setSegmentEnabled(env, segment, enabled) {
  if (LEAD_SEGMENTS.indexOf(segment) === -1) throw new Error("unknown category: " + segment);
  const res = await env.CRM_DB.prepare(
    `UPDATE lead_sources SET enabled = ? WHERE segment = ? AND state <> ?
        AND COALESCE(profile, 'domestic') = 'domestic'`
  ).bind(enabled ? 1 : 0, segment, HOME_STATE).run();
  return (res && res.meta && res.meta.changes) || 0;
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

// ── recheck: leads that were never actually speed-tested ──────────────────
/* A lead with a real website should carry a speed score. One that does not
   was judged while the speed test was unavailable, and the only honest thing
   to say about it is that nobody has looked.

   Only untouched leads are considered: status still 'lead', no owner, no
   calls logged. The moment a person has engaged with a business, what the
   pipeline thinks about their website stops being the deciding fact — same
   never-overwrite rule as everywhere else. */
export async function recheckLeads(env, opts) {
  const o = opts || {};
  const db = env.CRM_DB;
  await ensureLeadPipelineTables(env);

  const limit = Math.max(1, Math.min(200, Number(o.limit) || 50));
  const rows = await db.prepare(
    `SELECT c.id, c.business_name, c.website_url, c.lead_reason
       FROM clients c
      WHERE c.created_by_pipeline = 1
        AND c.status = 'lead'
        AND (c.owner IS NULL OR c.owner = '')
        AND c.website_url IS NOT NULL AND c.website_url != ''
        AND c.lead_speed IS NULL
        AND substr(COALESCE(c.lead_segment, ''), 1, 5) <> 'intl_'
        AND NOT EXISTS (SELECT 1 FROM client_calls cl WHERE cl.client_id = c.id)
      ORDER BY c.id ASC LIMIT ?`
  ).bind(limit).all();

  const counts = { looked: 0, kept: 0, retired: 0, skipped: 0, errors: [] };
  const emit = async (evt) => {
    if (!o.onProgress) return;
    try { await o.onProgress(evt); } catch (e) { /* client gone */ }
  };

  const queue = rows.results || [];
  await emit({ event: "recheck_start", total: queue.length });

  let position = 0;
  for (const row of queue) {
    position++;

    /* The free checks already settled these: a Facebook page, a dead
       business.site, plain http. They never needed a speed test and re-running
       one would only risk overturning a correct verdict. */
    if (notARealWebsite(row.website_url) || /^http:\/\//i.test(String(row.website_url).trim())) {
      counts.skipped++;
      continue;
    }

    await emit({ event: "rechecking", position: position, total: queue.length,
                 name: row.business_name || null, website: row.website_url });

    let verdict;
    try {
      verdict = await websiteVerdict(env, { website: row.website_url, review_count: null }, o.deps);
    } catch (e) {
      counts.errors.push((row.business_name || row.id) + ": " + String(e.message || e).slice(0, 160));
      if (e && e.accountFailure) {
        counts.errors.push("stopped: the speed test is still unavailable");
        break;
      }
      continue;
    }
    if (verdict.defer) { counts.errors.push("stopped: the speed test is still unavailable"); break; }

    counts.looked++;
    const now = new Date().toISOString();

    if (verdict.qualified) {
      // Still a lead — now with the evidence it should have had all along.
      await db.prepare(
        `UPDATE clients SET lead_score = ?, lead_reason = ?, lead_speed = ?,
                lead_mobile_ready = ?, lead_check = ?, updated_at = ?
          WHERE id = ?`
      ).bind(verdict.score, verdict.reason || "",
             verdict.speed == null ? null : verdict.speed,
             verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
             verdict.checked || null, now, row.id).run();
      counts.kept++;
    } else {
      /* Marked lost rather than deleted. It was put in front of someone as a
         lead, and a row that quietly disappears is worse than one that says
         why it is no longer worth a call. */
      await db.prepare(
        `UPDATE clients SET status = 'lost', lead_score = ?, lead_reason = ?,
                lead_speed = ?, lead_mobile_ready = ?, lead_check = ?, updated_at = ?
          WHERE id = ?`
      ).bind(verdict.score, "Rechecked: " + (verdict.reason || "their site is fine."),
             verdict.speed == null ? null : verdict.speed,
             verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
             verdict.checked || null, now, row.id).run();
      counts.retired++;
    }

    await emit({ event: "rechecked", position: position, total: queue.length,
                 name: row.business_name || null, kept: verdict.qualified,
                 speed: verdict.speed == null ? null : verdict.speed,
                 reason: verdict.reason || null });
  }

  return counts;
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
/* One run: source a couple of queries, then check up to `perRun`
   candidates. Every paid call is preceded by a ceiling check, so a run that
   starts under budget and crosses it mid-way stops cleanly rather than
   finishing the batch.

   opts.dryRun sources and dedupes and makes NO paid AI calls — the cheap mode
   for looking at what the grid actually returns before spending on it. */
export async function runLeadPipeline(env, opts) {
  const o = opts || {};
  // The intl profile has its own run; everything below is domestic, unchanged.
  if (o.profile === "intl") return runIntlPipeline(env, o);
  const perRun = Math.max(1, Math.min(25, Number(o.limit) || LEAD_DEFAULTS.perRun));
  const cap = Number(env.LEADS_DAILY_USD_CAP || LEAD_DEFAULTS.dailyUsdCap);
  const db = env.CRM_DB;

  await ensureLeadPipelineTables(env);
  await seedLeadSources(env, !!o.reseed);

  const counts = {
    sourced: 0, deduped: 0, enriched: 0, scored: 0,
    pushed: 0, screened: 0, rejected: 0, failed: 0, est_cost_usd: 0, errors: []
  };
  /* A screening tombstone records a cut-off as much as a business, so moving
     the cut-off has to be able to reach back. Only rows screened at sourcing
     are cleared — status 'screened', holding no Places content and never
     checked, so there is nothing to lose. A candidate actually checked and
     turned down is status 'rejected' and keeps its verdict. */
  if (o.rescreen) {
    const gone = await db.prepare(
      "DELETE FROM lead_candidates WHERE status = 'screened' AND substr(segment, 1, 5) <> 'intl_'"
    ).run();
    counts.rescreened = (gone && gone.meta && gone.meta.changes) || 0;
  }

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

      /* Only categories that are switched on. The toggles used to govern what
         got SOURCED and nothing else, so switching everything to Auto
         detailers and pressing run worked through a backlog of roofers and
         handymen staged weeks earlier — the categories said one thing and the
         leads said another. Candidates from a category that is off are not
         discarded, just parked until it is on again. */
      const live = await db.prepare(
        "SELECT DISTINCT segment FROM lead_sources WHERE enabled = 1 AND COALESCE(profile, 'domestic') = 'domestic'"
      ).all();
      const liveSegments = (live.results || []).map((r) => r.segment);

      const batch = liveSegments.length
        ? await db.prepare(
            `SELECT * FROM lead_candidates
              WHERE status IN ('new','enriched') AND attempts < ?
                AND segment IN (${liveSegments.map(() => "?").join(",")})
              ORDER BY COALESCE(promise, -1) DESC, id ASC LIMIT ?`
          ).bind(LEAD_DEFAULTS.maxAttempts, ...liveSegments, perRun).all()
        : { results: [] };

      const queue = batch.results || [];
      await emit({ event: "batch", total: queue.length });

      let position = 0;
      let noPageSpeed = false;
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
          const verdict = await websiteVerdict(env, places,
            Object.assign({}, o.deps, { noPageSpeed: noPageSpeed }));

          if (verdict.defer) {
            /* Put it back exactly as it was, attempt included: it was never
               looked at, and it must not burn its way to 'failed' while the
               speed test is unavailable. */
            await db.prepare(
              "UPDATE lead_candidates SET status = 'new', attempts = ?, updated_at = ? WHERE id = ?"
            ).bind(Number(cand.attempts || 0), new Date().toISOString(), cand.id).run();
            counts.deferred = (counts.deferred || 0) + 1;
            continue;
          }
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
            /* A refused PageSpeed only costs us the speed test. The rest of
               the queue — every business with no website, a Facebook-only
               page, a dead builder page or plain http — is still judgeable
               for free, so the run carries on without it. Anything else that
               fails on the account stops the run. */
            if (/^PageSpeed /.test(String(e.message || e))) {
              if (!noPageSpeed) {
                noPageSpeed = true;
                counts.errors.push("speed test unavailable: " + String(e.message || e).slice(0, 160));
                await emit({ event: "no_pagespeed" });
              }
              // failCandidate has already put it back untouched; report it the
              // same way as the ones deferred without even trying.
              counts.deferred = (counts.deferred || 0) + 1;
              continue;
            }
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

/* ══════════════════════════════════════════════════════════════════════════
   INTERNATIONAL PROFILE (profile = 'intl')

   Same grid table, same candidate table, same cost log — different rules.
   Domestic hunts small US trades with no or weak websites; intl hunts
   established tourism businesses abroad whose WEBSITE is the asset (it is
   where the contact email lives and what Potentia would improve). So:
   - website REQUIRED (a Facebook-only listing is rejected, not a lead);
   - NO review ceiling (a 900-review charter company is the target);
   - contacts are crawled from the business's own site into lead_emails.

   Everything is seeded DISABLED except the first slice: Cabo San Lucas ×
   yacht/boat charter. Switch more on with POST /crm/leads/sources.
   ══════════════════════════════════════════════════════════════════════════ */

export const INTL_DEFAULTS = {
  perRun: 5,          // crawls up to ~7 fetches each; keeps a run well under Worker subrequest limits
  maxPerRun: 10,
  sourceBatch: 2,
  dailyUsdCap: 2.0,   // LEADS_INTL_DAILY_USD_CAP; intl spend also counts toward the domestic cap
  minReviews: 5,
  trigger: "manual_intl"
};

/* Each query carries its language so Places is asked in the language the
   business would list itself in. `on` is only the shipped default. */
export const INTL_SEGMENTS = [
  { key: "intl_yacht_charter", label: "Yacht & boat charters", on: true, queries: [
      ["yacht charter", "en"], ["boat charter", "en"], ["fishing charter", "en"],
      ["sunset cruise", "en"], ["renta de yates", "es"], ["renta de barcos", "es"],
      ["pesca deportiva", "es"] ] },
  { key: "intl_tours", label: "Tours & excursions", on: false, queries: [
      ["tour operator", "en"], ["excursions", "en"], ["tours", "es"], ["excursiones", "es"] ] },
  { key: "intl_dental", label: "Dental clinics (medical tourism)", on: false, queries: [
      ["dental clinic", "en"], ["dentist", "en"], ["clínica dental", "es"], ["dentista", "es"] ] },
  { key: "intl_medical", label: "Medical & cosmetic clinics", on: false, queries: [
      ["plastic surgery clinic", "en"], ["medical spa", "en"], ["cirugía plástica", "es"] ] },
  { key: "intl_real_estate", label: "Real estate agencies", on: false, queries: [
      ["real estate agency", "en"], ["inmobiliaria", "es"], ["bienes raíces", "es"] ] },
  { key: "intl_property_mgmt", label: "Vacation rental & property management", on: false, queries: [
      ["vacation rental management", "en"], ["property management", "en"], ["administración de propiedades", "es"] ] },
  { key: "intl_boutique_hotel", label: "Boutique hotels", on: false, queries: [
      ["boutique hotel", "en"], ["hotel boutique", "es"] ] },
  { key: "intl_restaurant", label: "Restaurants", on: false, queries: [
      ["fine dining restaurant", "en"], ["restaurante", "es"] ] },
  { key: "intl_spa", label: "Spas & wellness", on: false, queries: [
      ["day spa", "en"], ["spa", "es"], ["wellness retreat", "en"] ] },
  { key: "intl_wedding", label: "Wedding planners & venues", on: false, queries: [
      ["wedding planner", "en"], ["destination wedding venue", "en"], ["organizador de bodas", "es"] ] },
  { key: "intl_dive", label: "Dive & surf schools", on: false, queries: [
      ["scuba diving", "en"], ["surf school", "en"], ["buceo", "es"], ["escuela de surf", "es"] ] },
  { key: "intl_transport", label: "Airport transfers & transport", on: false, queries: [
      ["airport transportation", "en"], ["private transfers", "en"], ["transporte aeropuerto", "es"] ] },
  { key: "intl_golf", label: "Golf", on: false, queries: [
      ["golf course", "en"], ["campo de golf", "es"] ] },
  { key: "intl_adventure", label: "Adventure (ATV, ziplines)", on: false, queries: [
      ["atv tours", "en"], ["zipline", "en"], ["tirolesa", "es"], ["cuatrimotos", "es"] ] },
  { key: "intl_legal", label: "Lawyers & notaries (foreign buyers)", on: false, queries: [
      ["real estate lawyer", "en"], ["abogado inmobiliario", "es"], ["notaría", "es"] ] }
];
export const INTL_SEGMENT_KEYS = INTL_SEGMENTS.map((s) => s.key);

/* [city, region (state), country ISO, tier, on]. Tier 1 = tourism hubs with
   the most US visitors. Only Cabo San Lucas ships on. */
export const INTL_CITIES = [
  ["Cabo San Lucas", "Baja California Sur", "MX", 1, 1],
  ["San José del Cabo", "Baja California Sur", "MX", 1, 0],
  ["Puerto Vallarta", "Jalisco", "MX", 1, 0],
  ["Cancún", "Quintana Roo", "MX", 1, 0],
  ["Playa del Carmen", "Quintana Roo", "MX", 1, 0],
  ["Tulum", "Quintana Roo", "MX", 1, 0],
  ["Nuevo Vallarta", "Nayarit", "MX", 1, 0],
  ["Mazatlán", "Sinaloa", "MX", 2, 0],
  ["La Paz", "Baja California Sur", "MX", 2, 0],
  ["Cozumel", "Quintana Roo", "MX", 2, 0],
  ["San Miguel de Allende", "Guanajuato", "MX", 2, 0],
  ["Tijuana", "Baja California", "MX", 2, 0],
  ["Ensenada", "Baja California", "MX", 2, 0],
  ["Mérida", "Yucatán", "MX", 2, 0],
  ["Mexico City", "Ciudad de México", "MX", 2, 0]
];

export function intlDefaultSources() {
  const out = [];
  for (const seg of INTL_SEGMENTS) {
    for (const [q, lang] of seg.queries) {
      for (const [city, region, country, tier, on] of INTL_CITIES) {
        out.push({ profile: "intl", query_template: q, language: lang, city, region,
                   state: region, country, tier, segment: seg.key, offer_hint: 4,
                   enabled: seg.on && on ? 1 : 0 });
      }
    }
  }
  return out;
}

/* Inserts any intl row the table does not have yet (so new cities/industries
   added in code appear without a reseed, and existing toggles/last_run_at are
   kept). force=true replaces the intl grid ONLY — domestic rows are untouched. */
export async function seedIntlSources(env, force) {
  const db = env.CRM_DB;
  if (force) await db.prepare("DELETE FROM lead_sources WHERE profile = 'intl'").run();
  const have = await db.prepare(
    "SELECT segment, query_template, city FROM lead_sources WHERE profile = 'intl'").all();
  const key = (r) => r.segment + "|" + r.query_template + "|" + r.city;
  const seen = new Set((have.results || []).map(key));
  const rows = intlDefaultSources().filter((r) => !seen.has(key(r)));
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at,
                               profile, country, region, tier, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'intl', ?, ?, ?, ?)`);
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map((r) =>
      insert.bind(r.query_template, r.city, r.state, r.segment, r.offer_hint, r.enabled, now,
                  r.country, r.region, r.tier, r.language)));
  }
  return rows.length;
}

export async function listIntlSegments(env) {
  const rows = await env.CRM_DB.prepare(
    `SELECT segment, city, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS on_count, COUNT(*) AS total
       FROM lead_sources WHERE profile = 'intl' GROUP BY segment, city`).all();
  const bySeg = {};
  for (const r of rows.results || []) {
    const b = bySeg[r.segment] || (bySeg[r.segment] = { on: 0, total: 0, cities: [] });
    b.on += Number(r.on_count || 0); b.total += Number(r.total || 0);
    if (Number(r.on_count) > 0) b.cities.push(r.city);
  }
  return INTL_SEGMENTS.map((s) => {
    const b = bySeg[s.key] || { on: 0, total: 0, cities: [] };
    return { key: s.key, label: s.label, profile: "intl", searches: b.on, total: b.total,
             enabled: b.on > 0, cities: b.cities.sort() };
  });
}

export function intlCityList() {
  return INTL_CITIES.map(([city, region, country, tier, on]) => ({ city, region, country, tier, default_on: !!on }));
}

/* Toggle intl rows. segment required; city optional (omit = every city that
   ships on, i.e. the same scope the category chip means). Never touches a
   domestic row. */
export async function setIntlSourcesEnabled(env, segment, enabled, city) {
  if (INTL_SEGMENT_KEYS.indexOf(segment) === -1) throw new Error("unknown intl category: " + segment);
  let res;
  if (city) {
    if (!INTL_CITIES.some((c) => c[0] === city)) throw new Error("unknown intl city: " + city);
    res = await env.CRM_DB.prepare(
      "UPDATE lead_sources SET enabled = ? WHERE profile = 'intl' AND segment = ? AND city = ?"
    ).bind(enabled ? 1 : 0, segment, city).run();
  } else {
    const live = INTL_CITIES.filter((c) => c[4]).map((c) => c[0]);
    if (!enabled) {
      res = await env.CRM_DB.prepare(
        "UPDATE lead_sources SET enabled = 0 WHERE profile = 'intl' AND segment = ?").bind(segment).run();
    } else {
      res = await env.CRM_DB.prepare(
        `UPDATE lead_sources SET enabled = 1 WHERE profile = 'intl' AND segment = ?
           AND city IN (${live.map(() => "?").join(",")})`).bind(segment, ...live).run();
    }
  }
  return (res && res.meta && res.meta.changes) || 0;
}

/* Free-field screen for intl. Separate from placesReject on purpose: no
   review ceiling, and a website is mandatory. */
export function intlReject(p, minRating) {
  if (!p.website) return "no website — an intl lead's value is its site";
  const fake = notARealWebsite(p.website);
  if (fake) return "only a " + fake + " page, no site of its own";
  const rc = p.review_count;
  if (rc == null || rc < INTL_DEFAULTS.minReviews) {
    return "only " + (rc == null ? "no" : rc) + " reviews — no evidence of real trading";
  }
  const floor = minRating == null ? LEAD_DEFAULTS.minRating : Number(minRating);
  const r = p.rating == null ? null : Number(p.rating);
  if (r != null && isFinite(r) && isFinite(floor) && r < floor) {
    return r + " stars from " + rc + " reviews — below the " + floor + " cut-off";
  }
  return null;
}

/* Established is GOOD here: more reviews = more US visitors = more budget. */
export function intlPromise(p) {
  const rc = Number(p.review_count || 0);
  let s = rc >= 200 ? 50 : rc >= 50 ? 40 : rc >= 15 ? 25 : 10;
  const r = Number(p.rating || 0);
  if (r >= 4.7) s += 25; else if (r >= 4.4) s += 15; else if (r >= 4.0) s += 5;
  if (/^https:\/\//i.test(String(p.website || ""))) s += 10;
  s += Math.min(15, Math.round(Number(p.photo_count || 0) / 2));
  return Math.max(0, Math.min(100, s));
}

/* Verdict from a crawl. A site that will not load is rejected (nothing to
   crawl for contacts); every reachable site is a lead, ranked by whether we
   found a usable public role address. */
export function intlVerdict(places, crawl) {
  const reviews = places.review_count == null ? "" : ", " + places.review_count + " Google reviews";
  if (!crawl || !crawl.ok) {
    return { qualified: false, score: 10, checked: "crawl",
             reason: "Website did not load (" + ((crawl && crawl.error) || "unknown") + ")" + reviews + "." };
  }
  const role = crawl.emails.filter((e) => e.type === "role");
  const review = crawl.emails.filter((e) => e.type !== "role");
  let score = 50 + Math.round(intlPromise(places) / 5);
  if (role.length) score += 20; else if (review.length) score += 8;
  if (crawl.whatsapp.length) score += 3;
  const bits = [];
  bits.push(role.length ? role.length + " public role email" + (role.length > 1 ? "s" : "") + " (" + role.map((e) => e.email).join(", ") + ")"
                        : review.length ? "free-mail address on site needs review (" + review[0].email + ")"
                        : "no public email on site");
  if (crawl.whatsapp.length) bits.push("WhatsApp on site");
  bits.push(crawl.pages.length + " page" + (crawl.pages.length > 1 ? "s" : "") + " crawled");
  return { qualified: true, score: Math.min(100, score), checked: "crawl",
           reason: bits.join("; ") + reviews + "." };
}

/* INSERT ONLY, like pushLeadToCrm. Durable contacts come from the site:
   the first own-domain role email, a tel:/WhatsApp number the site
   publishes (Places phone only as a fallback so the lead can be dialled and
   deduped), and the city/country from the grid row — the Places street
   address is not stored. */
export async function pushIntlLeadToCrm(env, cand, places, verdict, crawl, src) {
  const now = new Date().toISOString();
  const role = (crawl.emails || []).find((e) => e.type === "role");
  const phone = (crawl.phones && crawl.phones[0]) ||
                (crawl.whatsapp && crawl.whatsapp[0] ? "+" + crawl.whatsapp[0] : null) ||
                places.phone || null;
  const home = (crawl.pages && crawl.pages[0] && crawl.pages[0].url) || places.website || null;
  const city = (src && src.city) || null;
  const country = (src && src.country) || "MX";
  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients
       (business_name, email, phone, website_url, status, source, service,
        place_id, lead_score, lead_segment, lead_offer, lead_reason,
        lead_address, lead_area, lead_check, lead_trade, country, city,
        created_by_pipeline, do_not_contact, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'lead', 'pipeline_intl', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).bind(places.name || "", role ? role.email : null, phone, home, offerName(4),
         cand.place_id, verdict.score, cand.segment, 4, verdict.reason || "",
         city ? city + ", " + country : country, verdict.checked, cand.trade || null,
         country, city, now, now).run();
  const id = (res && res.meta && res.meta.last_row_id) || null;
  if (id) await saveLeadEmails(env, id, crawl.emails || []);
  return id;
}

export async function saveLeadEmails(env, clientId, emails) {
  const now = new Date().toISOString();
  let n = 0;
  for (const e of emails) {
    const r = await env.CRM_DB.prepare(
      `INSERT OR IGNORE INTO lead_emails (client_id, email, source_url, discovered_at, type,
         verification_status, eligibility, opted_out)
       VALUES (?, ?, ?, ?, ?, 'unverified', ?, 0)`
    ).bind(clientId, e.email, e.source_url || null, now, e.type || null,
           e.eligibility || "pending_verification").run();
    n += (r && r.meta && r.meta.changes) || 0;
  }
  return n;
}

/* Phase 2: evidence rows + the summary columns on clients. */
export async function saveLeadEvidence(env, clientId, analysis) {
  const now = new Date().toISOString();
  let n = 0;
  for (const e of (analysis && analysis.evidence) || []) {
    await env.CRM_DB.prepare(
      `INSERT INTO lead_evidence (client_id, kind, category, status, confirmed, url, snippet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clientId, e.kind, e.category, e.status, e.confirmed ? 1 : 0, e.url || null,
           String(e.snippet || "").slice(0, 300), now).run();
    n++;
  }
  const us = analysis.us || {}, op = analysis.opportunity || {};
  await env.CRM_DB.prepare(
    `UPDATE clients SET lead_us_score = ?, lead_us_signals = ?, lead_opportunity_score = ?,
            lead_suggested_service = ?, lead_tier = ?, lead_talking_points = ? WHERE id = ?`
  ).bind(us.score == null ? null : us.score, us.non_language_confirmed == null ? null : us.non_language_confirmed,
         op.score == null ? null : op.score, op.service || null, op.tier || null,
         JSON.stringify(op.talking_points || []), clientId).run();
  return n;
}

export async function intlSpentToday(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await env.CRM_DB.prepare(
    "SELECT COALESCE(SUM(est_cost_usd), 0) AS c FROM enrichment_runs WHERE started_at >= ? AND trigger = ?"
  ).bind(since, INTL_DEFAULTS.trigger).first();
  return Number((row && row.c) || 0);
}

function intlQuery(s) { return `${s.query_template} ${s.city}, ${s.region || s.state}`; }

/* The intl run.
   opts.plan   — FREE. No network at all: lists the Places searches the next
                 run would make and what is already queued.
   opts.dryRun — Places search (≈$0.035 × sourceBatch) + screen, then CRAWLS
                 (free) up to `limit` queued candidates and reports what it
                 would push and which emails it found. Writes nothing to
                 clients or lead_emails; candidates stay queued.
   otherwise   — the same, and qualifying sites are INSERTed into clients
                 with their emails in lead_emails.
   opts.deps.crawlSite is the crawler (index.js passes intlcrawl.crawlSite;
   tests pass a stub). opts.deps.placesTextSearch can stub Places. */
export async function runIntlPipeline(env, opts) {
  const o = opts || {};
  const db = env.CRM_DB;
  const deps = o.deps || {};
  const perRun = Math.max(1, Math.min(INTL_DEFAULTS.maxPerRun, Number(o.limit) || INTL_DEFAULTS.perRun));
  const batchN = o.sourceBatch || INTL_DEFAULTS.sourceBatch;
  const capAll = Number(env.LEADS_DAILY_USD_CAP || LEAD_DEFAULTS.dailyUsdCap);
  const capIntl = Number(env.LEADS_INTL_DAILY_USD_CAP || INTL_DEFAULTS.dailyUsdCap);
  const minRating = env.LEADS_MIN_RATING == null || env.LEADS_MIN_RATING === ""
    ? LEAD_DEFAULTS.minRating : Number(env.LEADS_MIN_RATING);
  const emit = async (evt) => { if (o.onProgress) { try { await o.onProgress(evt); } catch (e) {} } };

  await ensureLeadPipelineTables(env);
  await seedIntlSources(env, !!o.reseed);

  const srcs = ((await db.prepare(
    `SELECT * FROM lead_sources WHERE enabled = 1 AND profile = 'intl'
      ORDER BY last_run_at IS NOT NULL, last_run_at ASC, id ASC LIMIT ?`).bind(batchN).all()).results) || [];
  const liveSegs = ((await db.prepare(
    "SELECT DISTINCT segment FROM lead_sources WHERE enabled = 1 AND profile = 'intl'").all()).results || [])
    .map((r) => r.segment);

  if (o.plan) {
    const queued = liveSegs.length ? await db.prepare(
      `SELECT COUNT(*) AS c FROM lead_candidates WHERE status IN ('new','enriched')
         AND segment IN (${liveSegs.map(() => "?").join(",")})`).bind(...liveSegs).first() : { c: 0 };
    const out = { profile: "intl", plan: true, searches: srcs.map((s) => ({
                    id: s.id, query: intlQuery(s), language: s.language, segment: s.segment, city: s.city })),
                  est_cost_usd: Number((srcs.length * LEAD_COST.placesSearchUsd).toFixed(4)),
                  queued: Number((queued && queued.c) || 0), live_segments: liveSegs,
                  has_places_key: !!apiKey(env.GOOGLE_PLACES_API_KEY) };
    await emit({ event: "plan", ...out });
    return out;
  }

  const counts = { sourced: 0, deduped: 0, enriched: 0, scored: 0, pushed: 0, screened: 0,
                   rejected: 0, failed: 0, est_cost_usd: 0, emails_found: 0, emails_saved: 0,
                   errors: [], preview: [] };
  const started = new Date().toISOString();
  const run = await db.prepare("INSERT INTO enrichment_runs (trigger, started_at) VALUES (?, ?)")
    .bind(INTL_DEFAULTS.trigger, started).run();
  const runId = (run && run.meta && run.meta.last_row_id) || null;
  const spentAll = await spentToday(env), spentIntl = await intlSpentToday(env);
  // Checked against the NEXT search's cost too, so intl never goes over its cap.
  const overBudget = () => {
    const next = counts.est_cost_usd + LEAD_COST.placesSearchUsd;
    return spentAll + next > capAll + 1e-9 || spentIntl + next > capIntl + 1e-9;
  };
  const search = deps.placesTextSearch || placesTextSearch;
  const crawl = deps.crawlSite;

  try {
    // ── source ──
    await emit({ event: "sourcing", profile: "intl", searches: srcs.map(intlQuery) });
    const srcById = {};
    for (const s of srcs) {
      srcById[s.id] = s;
      if (overBudget()) { counts.errors.push("daily cost ceiling reached before sourcing"); break; }
      const q = intlQuery(s);
      let found;
      try {
        found = await search(env, q, undefined, { regionCode: String(s.country || "MX").toLowerCase(),
                                                   languageCode: s.language || "es" });
        counts.est_cost_usd += LEAD_COST.placesSearchUsd;
      } catch (e) { counts.errors.push("source[" + q + "]: " + String(e).slice(0, 200)); continue; }
      await db.prepare("UPDATE lead_sources SET last_run_at = ? WHERE id = ?").bind(started, s.id).run();
      for (const p of found) {
        if (!p.place_id) continue;
        if (p.status && p.status !== "OPERATIONAL") { counts.deduped++; continue; }
        counts.sourced++;
        if (await findExisting(env, p)) { counts.deduped++; continue; }
        const veto = intlReject(p, minRating);
        const now = new Date().toISOString();
        if (veto) {
          await db.prepare(
            `INSERT INTO lead_candidates (place_id, segment, trade, offer_hint, source_id, status, promise, score, reason, created_at, updated_at)
             VALUES (?, ?, ?, 4, ?, 'screened', 0, 0, ?, ?, ?)`
          ).bind(p.place_id, s.segment, s.query_template, s.id, veto.slice(0, 300), now, now).run();
          counts.screened++;
          await emit({ event: "screened", name: p.name, reason: veto });
          continue;
        }
        await db.prepare(
          `INSERT INTO lead_candidates (place_id, segment, trade, offer_hint, source_id, status, promise, places_json, places_fetched_at, created_at, updated_at)
           VALUES (?, ?, ?, 4, ?, 'new', ?, ?, ?, ?, ?)`
        ).bind(p.place_id, s.segment, s.query_template, s.id, intlPromise(p), JSON.stringify(p), now, now, now).run();
      }
    }
    await emit({ event: "sourced", sourced: counts.sourced, deduped: counts.deduped, screened: counts.screened });

    // ── crawl + judge ──
    const queue = liveSegs.length ? ((await db.prepare(
      `SELECT * FROM lead_candidates WHERE status IN ('new','enriched') AND attempts < ?
         AND segment IN (${liveSegs.map(() => "?").join(",")})
       ORDER BY COALESCE(promise, -1) DESC, id ASC LIMIT ?`
    ).bind(LEAD_DEFAULTS.maxAttempts, ...liveSegs, perRun).all()).results || []) : [];
    await emit({ event: "batch", total: queue.length });
    if (queue.length && typeof crawl !== "function") throw new Error("no crawler wired (deps.crawlSite)");

    let pos = 0;
    for (const cand of queue) {
      pos++;
      const places = safeParse(cand.places_json);
      if (!places) { await failCandidate(env, cand, "no places_json", counts); continue; }
      let src = srcById[cand.source_id];
      if (!src && cand.source_id) src = await db.prepare("SELECT * FROM lead_sources WHERE id = ?").bind(cand.source_id).first();
      await emit({ event: "checking", position: pos, total: queue.length, name: places.name, website: places.website });
      let c;
      try { c = await crawl(places.website); }
      catch (e) { await failCandidate(env, cand, "crawl: " + String(e).slice(0, 200), counts); continue; }
      /* A homepage that timed out or refused the connection may well load
         next time: retry (up to maxAttempts) instead of tombstoning it. A
         site that answered with an error status is judged below. */
      if (!c.ok && !c.home_status) {
        await failCandidate(env, cand, "crawl: " + (c.error || "no response"), counts);
        await emit({ event: "candidate_failed", position: pos, total: queue.length, name: places.name });
        continue;
      }
      counts.enriched++;
      counts.emails_found += (c.emails || []).length;
      const v = intlVerdict(places, c);
      counts.scored++;
      const item = { name: places.name, website: places.website, city: src && src.city,
                     kept: v.qualified, score: v.score, reason: v.reason,
                     emails: (c.emails || []).map((e) => ({ email: e.email, type: e.type, source_url: e.source_url })),
                     phones: c.phones, whatsapp: c.whatsapp };
      /* Phase 2: US relevance + audit + opportunity, on qualifying sites only.
         Free (PageSpeed + a few HEADs). A failure here never loses the lead. */
      let analysis = null;
      if (v.qualified && typeof deps.analyzeLead === "function") {
        let ps = null;
        if (o.pagespeed !== false) {
          try { ps = await (deps.pageSpeed || pageSpeed)(env, (c.docs && c.docs[0] && c.docs[0].url) || places.website); }
          catch (e) { ps = null; counts.errors.push("pagespeed[" + places.name + "]: " + String(e).slice(0, 120)); }
        }
        try { analysis = await deps.analyzeLead(c, { segment: cand.segment, pagespeed: ps }); }
        catch (e) { counts.errors.push("analyze[" + places.name + "]: " + String(e).slice(0, 160)); }
        if (analysis) {
          counts.analyzed = (counts.analyzed || 0) + 1;
          item.us_score = analysis.us.score;
          item.us_gate = analysis.us.gate;
          item.us_signals = analysis.us.non_language_confirmed;
          item.opportunity_score = analysis.opportunity.score;
          item.suggested_service = analysis.opportunity.service;
          item.tier = analysis.opportunity.tier;
          item.talking_points = analysis.opportunity.talking_points;
          if (o.dryRun) item.evidence = analysis.evidence;
        }
      }
      if (o.dryRun) {
        counts.preview.push(item);
      } else if (v.qualified) {
        const id = await pushIntlLeadToCrm(env, cand, places, v, c, src);
        if (id && analysis) counts.evidence_saved = (counts.evidence_saved || 0) + await saveLeadEvidence(env, id, analysis);
        counts.emails_saved += id ? ((await db.prepare("SELECT COUNT(*) AS c FROM lead_emails WHERE client_id = ?").bind(id).first()) || {}).c || 0 : 0;
        await stripCandidate(env, cand.id, "pushed", v.score, v.reason, id);
        counts.pushed++;
        item.client_id = id;
      } else {
        await stripCandidate(env, cand.id, "rejected", v.score, v.reason, null);
        counts.rejected++;
      }
      await emit({ event: "judged", position: pos, total: queue.length, ...item });
    }
  } catch (e) {
    counts.errors.push("run: " + String(e).slice(0, 300));
  }

  if (runId) {
    await db.prepare(
      `UPDATE enrichment_runs SET finished_at = ?, sourced = ?, deduped = ?, enriched = ?, scored = ?,
              pushed = ?, screened = ?, rejected = ?, failed = ?, est_cost_usd = ?, error = ? WHERE id = ?`
    ).bind(new Date().toISOString(), counts.sourced, counts.deduped, counts.enriched, counts.scored,
           counts.pushed, counts.screened, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)),
           counts.errors.length ? counts.errors.join(" | ").slice(0, 900) : null, runId).run();
  }
  return { run_id: runId, profile: "intl", dry_run: !!o.dryRun, ...counts };
}
