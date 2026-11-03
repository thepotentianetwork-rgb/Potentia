-- Intl Phase 4 (2026-11-03): drafts + compliance. Also created lazily by
-- ensureCampaignTables() in intlcampaigns.js. CRM_DB.
CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, lang TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (key, lang));
CREATE TABLE IF NOT EXISTS email_suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL,
  reason TEXT, source TEXT, created_at TEXT NOT NULL, UNIQUE (kind, value));
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lang TEXT NOT NULL,
  template_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, client_id INTEGER NOT NULL,
  lead_email_id INTEGER, to_email TEXT NOT NULL, lang TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, findings TEXT,
  status TEXT NOT NULL DEFAULT 'draft', block_reason TEXT, edited INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, to_email));
CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign ON campaign_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_messages_email ON campaign_messages(to_email);
