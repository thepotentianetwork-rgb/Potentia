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

export const LEAD_SEGMENTS = ["contractor", "handyman", "dealer"];

/* Estimated unit costs, in USD, used for the daily ceiling and the per-run
   log. Only the Claude figure is derived from published per-token rates
   ($2/$10 per MTok for claude-sonnet-5) — the other two are PLACEHOLDERS
   pending a real bill, deliberately set high so the ceiling errs toward
   stopping early. Recalibrate from enrichment_runs after the first week. */
// Named LEAD_COST / LEAD_DEFAULTS, not COST / DEFAULTS: pricing.js already
// owns those at top level, and the bundler flattens both modules into one
// file where a duplicate const is a hard SyntaxError.
export const LEAD_COST = {
  placesSearchUsd: 0.035,     // per Text Search call (~20 results) — CALIBRATE
  grokEnrichUsd: 0.05,        // per candidate, incl. web_search — CALIBRATE
  claudeScoreUsd: 0.01        // per candidate — from published token rates
};

export const LEAD_DEFAULTS = {
  perRun: 5,                  // candidates enriched+scored per run
  dailyUsdCap: 5.0,
  maxAttempts: 3,
  sourceBatch: 2,             // Places queries per run
  qualifyAt: 55               // score at or above this goes to the CRM
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
      score INTEGER, best_offer INTEGER, reason TEXT, opener TEXT,
      crm_client_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS enrichment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT,
      sourced INTEGER NOT NULL DEFAULT 0, deduped INTEGER NOT NULL DEFAULT 0,
      enriched INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 0,
      pushed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT)`
  ).run();

  /* D1 has no "ADD COLUMN IF NOT EXISTS", and a duplicate ADD throws. Read the
     table first and add only what is missing — the same lazy-migration shape
     the rest of this Worker uses. */
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
const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus"
].join(",");

export async function placesTextSearch(env, query, signal) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
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

// ── the search grid ───────────────────────────────────────────────────────
/* Trades that sub to general contractors, the handyman end of the same
   market, and independent dealers. Second-tier cities on purpose: far more
   businesses with no web presence at all, and far less competition from other
   agencies for a $99 site than in a coastal metro.

   Utah rows ship DISABLED. "Businesses that aren't local" is the one input I
   could not resolve without knowing which town is home — enable the ones you
   want with a single UPDATE (see the README). Nothing in Utah is called until
   you do. */
const CONTRACTOR_QUERIES = [
  "concrete contractor", "framing contractor", "drywall contractor",
  "electrician", "plumber", "HVAC contractor", "roofing contractor",
  "painting contractor", "flooring installer", "fencing contractor",
  "excavation contractor", "landscaping contractor"
];
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
  const out = [];
  for (const [city, state, enabled] of CITIES) {
    for (const q of CONTRACTOR_QUERIES) out.push({ query_template: q, city, state, segment: "contractor", offer_hint: 2, enabled });
    for (const q of HANDYMAN_QUERIES) out.push({ query_template: q, city, state, segment: "handyman", offer_hint: 1, enabled });
    for (const q of DEALER_QUERIES) out.push({ query_template: q, city, state, segment: "dealer", offer_hint: 3, enabled });
  }
  return out;
}

export async function seedLeadSources(env) {
  const db = env.CRM_DB;
  const n = await db.prepare("SELECT COUNT(*) AS c FROM lead_sources").first();
  if (n && Number(n.c) > 0) return 0;
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
      await db.prepare(
        `INSERT INTO lead_candidates
           (place_id, segment, offer_hint, source_id, status, places_json, places_fetched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?)`
      ).bind(p.place_id, s.segment, s.offer_hint, s.id, JSON.stringify(p), now, now, now).run();
    }
  }
}

// ── stage 2: enrichment (Grok) ────────────────────────────────────────────
/* Fields split by segment, because the two segments are bought for different
   reasons. A contractor's pain is "I have no site / my site is embarrassing";
   a dealer's is "I post cars to Facebook daily and my website still lists a
   truck I sold in spring".

   mobile_friendly is nullable ON PURPOSE. We research through search results
   only — we do not fetch the site — and from search results that judgement is
   a guess. A null means unknown and the scorer is told to ignore it; asking
   for a boolean would get a confident one the caller would then repeat down
   the phone. */
const SHARED_PROPS = {
  has_website: { type: "boolean" },
  website_quality: { type: "string", enum: ["none", "poor", "ok", "good"] },
  mobile_friendly: { type: ["boolean", "null"] },
  google_rating: { type: ["number", "null"] },
  review_count: { type: ["integer", "null"] },
  notes: { type: "string" },
  source_urls: { type: "array", items: { type: "string" } },
  contact_phone: { type: ["string", "null"] },
  contact_website: { type: ["string", "null"] }
};

const TRADE_PROPS = {
  web_presence: { type: "string", enum: ["none", "facebook_only", "own_site"] },
  site_is_http_only: { type: ["boolean", "null"] },
  shows_license_or_insured: { type: ["boolean", "null"] },
  does_subcontract_work: { type: ["boolean", "null"] }
};

const DEALER_PROPS = {
  facebook_active: { type: ["boolean", "null"] },
  fb_last_post_days_ago: { type: ["integer", "null"] },
  site_lists_inventory: { type: ["boolean", "null"] },
  site_inventory_stale: { type: ["boolean", "null"] },
  inventory_gap: { type: ["string", "null"] }
};

export function enrichmentSchemaFor(segment) {
  const props = segment === "dealer"
    ? { ...SHARED_PROPS, ...DEALER_PROPS }
    : { ...SHARED_PROPS, ...TRADE_PROPS };
  return {
    type: "object",
    properties: props,
    required: Object.keys(props),
    additionalProperties: false
  };
}

function enrichPrompt(segment, p) {
  const who = `${p.name} — ${p.address}` + (p.phone ? ` — ${p.phone}` : "");
  const common =
    `Research this local business and report only what you can actually verify from ` +
    `search results. Where you cannot verify something, return null rather than a guess. ` +
    `Put the URLs you relied on in source_urls. In contact_phone and contact_website, ` +
    `give the phone and site the BUSINESS ITSELF publishes (its own website, its own ` +
    `Facebook page), not a directory listing.\n\nBusiness: ${who}\n`;
  if (segment === "dealer") {
    return common +
      `This is a used-car dealer. The thing worth establishing: are they active on ` +
      `Facebook while their own website's inventory is stale or missing? Check when ` +
      `they last posted on Facebook, whether their website lists inventory at all, and ` +
      `whether that inventory looks current. Describe any mismatch in inventory_gap.`;
  }
  return common +
    `This is a ${segment === "handyman" ? "handyman / home repair" : "contracting"} business. ` +
    `Establish whether they have a real website, only a Facebook page, or no web presence ` +
    `at all; whether the site is http-only (no padlock); whether they show a license or ` +
    `proof of insurance anywhere; and whether they take subcontract work for general ` +
    `contractors.`;
}

/* xAI Responses API. Verified against docs.x.ai (Sept 2026):
     - endpoint POST /v1/responses, model grok-4.6
     - server-side search is tools: [{type:"web_search"}]
     - the old search_parameters field is gone
     - strict JSON nests under text.format and DOES compose with web_search
   Long timeout: a web_search turn routinely runs past a minute. */
export async function enrichWithGrok(env, segment, places) {
  const schema = enrichmentSchemaFor(segment);
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.XAI_API_KEY
    },
    body: JSON.stringify({
      model: "grok-4.6",
      input: [{ role: "user", content: enrichPrompt(segment, places) }],
      tools: [{ type: "web_search" }],
      text: { format: { type: "json_schema", name: "lead_enrichment", strict: true, schema } }
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("xAI " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  return parseGrokJson(data);
}

/* The Responses API returns a list of output items; the assistant's text can
   arrive alongside tool-call items, so pull the text out rather than assuming
   a position. Exported to be testable without a network call. */
export function parseGrokJson(data) {
  if (data && typeof data.output_text === "string" && data.output_text.trim()) {
    return JSON.parse(data.output_text);
  }
  const items = (data && data.output) || [];
  for (const item of items) {
    for (const c of (item && item.content) || []) {
      const t = c && (c.text != null ? c.text : c.output_text);
      if (typeof t === "string" && t.trim()) return JSON.parse(t);
    }
  }
  throw new Error("xAI: no JSON in response");
}

// ── stage 3: score + opener (Claude) ──────────────────────────────────────
/* Structured outputs on the Messages API. Note what is NOT in this schema:
   minimum/maximum on score. Anthropic's structured outputs reject numerical
   constraints, so the range is stated in the prompt and clamped in code. */
export const SCORING_SCHEMA = {
  type: "object",
  properties: {
    best_offer: { type: "integer", enum: [1, 2, 3] },
    score: { type: "integer" },
    reason: { type: "string" },
    opener: { type: "string" }
  },
  required: ["best_offer", "score", "reason", "opener"],
  additionalProperties: false
};

const OFFERS = `
1. A $99 website — for a business with no website at all, or one so poor it is
   costing them work.
2. A credibility website for a subcontractor — the pitch is looking legitimate
   to the general contractors who hire them: licence, insurance, real photos of
   finished work. For a handyman the same product sells to HOMEOWNERS instead,
   on trust rather than bid-list credibility.
3. Dealership CRM / inventory software — for an independent used-car dealer who
   is active on Facebook while their own website's inventory sits stale. The
   gap between the two IS the pitch.`;

export function scorePrompt(segment, places, enrichment) {
  return `You score inbound cold-call leads for a small web studio. Pick the ONE offer that fits best, score it, and write the caller an opener.

THE OFFERS${OFFERS}

SCORING. 0-100, and score WITHIN this business's segment ("${segment}") — do not
discount a dealer because a handyman has a worse website. 100 means the pain is
obvious and the offer lands squarely. Below 55 means do not spend a call on it.
A business with a good, current website scores low: there is nothing to sell them.

Ignore any field that is null — null means the researcher could not verify it,
not that the answer is no. Do not infer anything the research does not support.

THE OPENER. One or two sentences a real person would say on the phone, naming
something specific and verifiable about this business. No "Hi, I hope you're
doing well", no invented facts, no claims about their site you were not told.

BUSINESS: ${places.name} — ${places.address}
RESEARCH: ${JSON.stringify(enrichment)}`;
}

export async function scoreWithClaude(env, segment, places, enrichment) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: SCORING_SCHEMA } },
      messages: [{ role: "user", content: scorePrompt(segment, places, enrichment) }]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Anthropic " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  return parseClaudeJson(data);
}

/* A structured-output response is still a normal Messages response: thinking
   blocks can precede the text, so find the text block rather than index into
   content[0]. A refusal never matches the schema — check stop_reason first. */
export function parseClaudeJson(data) {
  if (data && data.stop_reason === "refusal") {
    throw new Error("Anthropic declined to score this lead");
  }
  const blocks = (data && data.content) || [];
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const out = JSON.parse(b.text);
      // The schema cannot express 0-100, so enforce it here.
      out.score = Math.max(0, Math.min(100, Math.round(Number(out.score) || 0)));
      return out;
    }
  }
  throw new Error("Anthropic: no JSON in response");
}

// ── stage 4: push to the CRM ──────────────────────────────────────────────
/* INSERT ONLY. There is no UPDATE path in this function and there should never
   be one — see rule 2 at the top of the file. findExisting() has already run;
   if it found anything, we never get here.

   status stays 'lead'. The CRM validates status against a fixed list in both
   the Worker and crm.html, and "ready to call" is not in it — a row with that
   status would fail validation and not render. Ranking is lead_score, which
   is what a caller actually sorts by. */
export async function pushLeadToCrm(env, cand, places, enrichment, scored) {
  const now = new Date().toISOString();
  /* Contact details come from what the business publishes about itself, with
     the Places values used only as a fallback for a lead we are about to call
     anyway — never written as a durable copy of a Places record. */
  const phone = (enrichment && enrichment.contact_phone) || places.phone || null;
  const website = (enrichment && enrichment.contact_website) || places.website || null;

  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients
       (business_name, phone, website_url, status, source, service, message,
        place_id, lead_score, lead_segment, lead_offer, lead_reason, lead_opener,
        created_by_pipeline, do_not_contact, created_at, updated_at)
     VALUES (?, ?, ?, 'lead', 'pipeline', ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).bind(
    places.name || "",
    phone,
    website,
    offerName(scored.best_offer),
    (enrichment && enrichment.notes) || "",
    cand.place_id,
    scored.score,
    cand.segment,
    scored.best_offer,
    scored.reason || "",
    scored.opener || "",
    now,
    now
  ).run();
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
  const qualifyAt = Number(env.LEADS_QUALIFY_AT || LEAD_DEFAULTS.qualifyAt);
  const db = env.CRM_DB;

  await ensureLeadPipelineTables(env);
  await seedLeadSources(env);

  const counts = {
    sourced: 0, deduped: 0, enriched: 0, scored: 0,
    pushed: 0, rejected: 0, failed: 0, est_cost_usd: 0, errors: []
  };
  const started = new Date().toISOString();
  const run = await db.prepare(
    "INSERT INTO enrichment_runs (trigger, started_at) VALUES (?, ?)"
  ).bind(o.trigger || "manual", started).run();
  const runId = (run && run.meta && run.meta.last_row_id) || null;

  const already = await spentToday(env);
  const overBudget = () => already + counts.est_cost_usd >= cap;

  try {
    if (!overBudget()) await sourceCandidates(env, counts, o);
    else counts.errors.push("daily cost ceiling reached before sourcing");

    if (!o.dryRun) {
      const batch = await db.prepare(
        `SELECT * FROM lead_candidates
          WHERE status IN ('new','enriched') AND attempts < ?
          ORDER BY id ASC LIMIT ?`
      ).bind(LEAD_DEFAULTS.maxAttempts, perRun).all();

      for (const cand of batch.results || []) {
        if (overBudget()) { counts.errors.push("daily cost ceiling reached"); break; }
        const places = safeParse(cand.places_json);
        if (!places) {
          await failCandidate(env, cand, "no places_json", counts);
          continue;
        }
        try {
          await db.prepare("UPDATE lead_candidates SET attempts = attempts + 1, status = 'enriching', updated_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), cand.id).run();

          const enrichment = await withRetry(() => enrichWithGrok(env, cand.segment, places));
          counts.enriched++; counts.est_cost_usd += LEAD_COST.grokEnrichUsd;

          if (overBudget()) {
            await db.prepare("UPDATE lead_candidates SET status = 'enriched', enrichment_json = ?, updated_at = ? WHERE id = ?")
              .bind(JSON.stringify(enrichment), new Date().toISOString(), cand.id).run();
            counts.errors.push("ceiling reached after enrichment; scoring deferred");
            break;
          }

          const scored = await withRetry(() => scoreWithClaude(env, cand.segment, places, enrichment));
          counts.scored++; counts.est_cost_usd += LEAD_COST.claudeScoreUsd;

          if (scored.score >= qualifyAt) {
            const crmId = await pushLeadToCrm(env, cand, places, enrichment, scored);
            await stripCandidate(env, cand.id, "pushed", scored.score, scored.reason, crmId);
            counts.pushed++;
          } else {
            await stripCandidate(env, cand.id, "rejected", scored.score, scored.reason, null);
            counts.rejected++;
          }
        } catch (e) {
          await failCandidate(env, cand, String(e).slice(0, 300), counts);
        }
      }
    }
  } catch (e) {
    counts.errors.push("run: " + String(e).slice(0, 300));
  }

  if (runId) {
    await db.prepare(
      `UPDATE enrichment_runs SET finished_at = ?, sourced = ?, deduped = ?, enriched = ?,
              scored = ?, pushed = ?, rejected = ?, failed = ?, est_cost_usd = ?, error = ?
        WHERE id = ?`
    ).bind(new Date().toISOString(), counts.sourced, counts.deduped, counts.enriched,
           counts.scored, counts.pushed, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)),
           counts.errors.length ? counts.errors.join(" | ").slice(0, 900) : null,
           runId).run();
  }
  return { run_id: runId, dry_run: !!o.dryRun, ...counts };
}

/* A candidate that has burned its attempts is marked failed and left alone;
   the batch query filters on attempts so it never comes back. */
async function failCandidate(env, cand, msg, counts) {
  const attempts = Number(cand.attempts || 0) + 1;
  const terminal = attempts >= LEAD_DEFAULTS.maxAttempts;
  if (terminal) counts.failed++;
  counts.errors.push("candidate " + cand.id + ": " + msg);
  await env.CRM_DB.prepare(
    "UPDATE lead_candidates SET status = ?, last_error = ?, updated_at = ? WHERE id = ?"
  ).bind(terminal ? "failed" : "new", msg, new Date().toISOString(), cand.id).run();
}

/* Two retries, 2s then 6s. Deliberately small: the run is on a schedule, so a
   candidate that fails now is picked up next hour with its attempt counter
   intact rather than being hammered inside one invocation. */
export async function withRetry(fn, sleep) {
  const waits = [2000, 6000];
  let last;
  for (let i = 0; i <= waits.length; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < waits.length) await (sleep || defaultSleep)(waits[i]);
    }
  }
  throw last;
}
function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
