-- International leads Phase 2 (2026-11-03): US relevance + site audit. CRM_DB.
-- ensureLeadPipelineTables() applies this lazily; if running by hand, skip any
-- ALTER whose column already exists.
CREATE TABLE IF NOT EXISTS lead_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- lang_en usd_price us_phone us_audience airport_transfer medical_tourism foreign_buyer
                             -- audit_https audit_viewport audit_speed audit_broken_links audit_forms audit_booking
                             -- audit_analytics audit_whatsapp audit_lang_switch
  category TEXT NOT NULL,    -- us | audit
  status TEXT NOT NULL,      -- us: confirmed | needs_review; audit: confirmed_issue | opportunity_needs_review | ok | untested
  confirmed INTEGER NOT NULL DEFAULT 0,  -- 1 only when the rule is unambiguous / measured
  url TEXT,                  -- page the evidence came from
  snippet TEXT,              -- short excerpt (<=300 chars)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_evidence_client ON lead_evidence(client_id, category);
CREATE INDEX IF NOT EXISTS idx_lead_evidence_kind ON lead_evidence(kind, status);
ALTER TABLE clients ADD COLUMN lead_us_score INTEGER;           -- 0-100; capped at 25 unless >=2 confirmed non-language signals
ALTER TABLE clients ADD COLUMN lead_us_signals INTEGER;         -- confirmed non-language signal count
ALTER TABLE clients ADD COLUMN lead_opportunity_score INTEGER;  -- 0-100 rule-based
ALTER TABLE clients ADD COLUMN lead_suggested_service TEXT;
ALTER TABLE clients ADD COLUMN lead_tier TEXT;                  -- A | B | C
ALTER TABLE clients ADD COLUMN lead_talking_points TEXT;        -- JSON array, confirmed evidence only
