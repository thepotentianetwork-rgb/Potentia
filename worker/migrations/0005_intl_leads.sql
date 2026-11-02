-- International lead profile (Phase 0 + Phase 1, 2026-11-02). CRM_DB (potentia-crm).
-- Belt-and-braces: ensureLeadPipelineTables() applies all of this lazily on the
-- first /crm/leads/* request. If running by hand, skip any ALTER whose column
-- already exists (D1 has no ADD COLUMN IF NOT EXISTS).
ALTER TABLE lead_sources ADD COLUMN profile TEXT NOT NULL DEFAULT 'domestic'; -- domestic | intl
ALTER TABLE lead_sources ADD COLUMN country TEXT NOT NULL DEFAULT 'US';
ALTER TABLE lead_sources ADD COLUMN region TEXT;   -- generic name for `state` (kept for compat)
ALTER TABLE lead_sources ADD COLUMN tier INTEGER;
ALTER TABLE lead_sources ADD COLUMN language TEXT; -- en | es (intl queries)
ALTER TABLE clients ADD COLUMN country TEXT;        -- NULL on domestic rows
ALTER TABLE clients ADD COLUMN city TEXT;

-- Public business emails found on a lead's own website. Nothing here is sent;
-- verification, eligibility and opt-out are for Phases 4-5.
CREATE TABLE IF NOT EXISTS lead_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  source_url TEXT,                 -- the page it was published on
  discovered_at TEXT NOT NULL,
  type TEXT,                       -- role | freemail_role | freemail
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  eligibility TEXT NOT NULL DEFAULT 'pending_verification', -- pending_verification | review | eligible | ineligible
  last_contacted_at TEXT,
  opted_out INTEGER NOT NULL DEFAULT 0,
  UNIQUE (client_id, email)
);
CREATE INDEX IF NOT EXISTS idx_lead_emails_email ON lead_emails(email);
