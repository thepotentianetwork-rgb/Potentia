-- Lead enrichment pipeline — D1 schema for the `potentia-crm` database.
--
-- Bind as CRM_DB, same database as schema-crm.sql. These tables sit alongside
-- `clients`; the pipeline's only write into that table is an INSERT.
--
-- You do not have to run this file. The Worker creates every table lazily on
-- first use, the same way payments/installs/saved_designs do. It is here so
-- the schema is readable in git and a fresh install is one paste.
--
-- ── WHAT THIS DELIBERATELY DOES NOT STORE ──────────────────────────────────
-- Google's Places API terms allow `place_id` to be kept indefinitely and
-- almost nothing else: name, phone, address and rating are content you may
-- cache only temporarily. So Places fields live in lead_candidates ONLY while
-- a candidate is being judged. The moment it is judged — pushed or rejected —
-- the row is stripped back to place_id + verdict + score + a one-line reason.
--
-- That leaves a permanent marker that costs nothing, keeps us from paying to
-- re-source the same dead end every run, and holds no Places content at all.
-- A lead that makes it to the CRM carries contact details taken from the
-- business's own site (the enrichment step's source_urls), not from Places.

-- The search grid. Rows here are the whole configuration: no query or city is
-- hardcoded in the Worker. offer_hint tells the scorer which of the three
-- offers this row was fishing for; it is a hint, not a verdict — the scorer
-- can disagree once it has seen the enrichment.
CREATE TABLE IF NOT EXISTS lead_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_template TEXT NOT NULL,   -- e.g. 'concrete contractor'
  city TEXT NOT NULL,
  state TEXT NOT NULL,            -- 'UT' | 'CA' | 'AZ'
  segment TEXT NOT NULL,          -- 'contractor' | 'handyman' | 'dealer'
  offer_hint INTEGER,             -- 1 | 2 | 3
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);

-- Working state for one business, from sourced to judged.
--
-- status: new -> enriching -> enriched -> scored -> pushed | rejected | failed
--
-- places_json / enrichment_json are NULLED OUT once status reaches a terminal
-- value. Read the header above before adding a column that outlives the
-- judgement — the short lifetime of these two fields is the point.
CREATE TABLE IF NOT EXISTS lead_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL UNIQUE,  -- the one field we may keep forever
  segment TEXT NOT NULL,
  offer_hint INTEGER,
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  -- Temporary. Nulled at judgement. Never read these for anything durable.
  places_json TEXT,
  places_fetched_at TEXT,
  enrichment_json TEXT,

  -- Kept: our own derived numbers, not Places content.
  -- promise is the free pre-screen (0-100) from the Places row alone. It
  -- decides WHICH candidates a run pays to research; score is the verdict
  -- afterwards.
  promise INTEGER,
  score INTEGER,
  best_offer INTEGER,
  reason TEXT,
  opener TEXT,
  crm_client_id INTEGER,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_status ON lead_candidates (status);

-- One row per pipeline run. The cost columns are what the daily ceiling is
-- checked against, so they are written even when a run fails part-way.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,          -- 'cron' | 'manual'
  started_at TEXT NOT NULL,
  finished_at TEXT,
  sourced INTEGER NOT NULL DEFAULT 0,
  deduped INTEGER NOT NULL DEFAULT 0,
  enriched INTEGER NOT NULL DEFAULT 0,
  scored INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0,
  screened INTEGER NOT NULL DEFAULT 0,   -- vetoed free, before any paid call
  rejected INTEGER NOT NULL DEFAULT 0,   -- researched, scored, not worth a call
  failed INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_started ON enrichment_runs (started_at);

-- ── clients: additive columns ──────────────────────────────────────────────
-- D1 has no ALTER TABLE IF NOT EXISTS, so the Worker adds these by reading
-- PRAGMA table_info first (see ensureLeadPipelineTables). Listed here so the
-- full shape of `clients` is readable in one place.
--
--   do_not_contact       INTEGER NOT NULL DEFAULT 0   -- pipeline always respects this
--   place_id             TEXT                          -- dedupe key, permanent, allowed
--   lead_score           INTEGER                       -- 0-100, within its segment
--   lead_segment         TEXT
--   lead_offer           INTEGER
--   lead_reason          TEXT
--   lead_opener          TEXT
-- What the check actually found, so a caller has the evidence in front of them
-- rather than a verdict. Reviews, photos and hours are deliberately NOT here:
-- place_id links to the live Google listing, which never goes stale.
-- lead_address  TEXT     full trading address
-- lead_area     TEXT     just the town, e.g. "Newport Beach, CA" — what the list shows
-- lead_speed    INTEGER  Google mobile performance, 0-100, null when not measured
-- lead_mobile_ready INTEGER 1/0/null — has a viewport meta tag
-- lead_check    TEXT     'places' or 'pagespeed' — which check decided it
--   created_by_pipeline  INTEGER NOT NULL DEFAULT 0   -- tells a robot row from a human one
