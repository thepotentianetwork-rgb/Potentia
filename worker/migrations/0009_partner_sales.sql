-- Partner sales teams (e.g. Absolute Built). Additive only; portals.js
-- ensurePortalTables also adds these lazily. Nothing is shared by default.
ALTER TABLE portal_users ADD COLUMN sales_team TEXT;
ALTER TABLE customers ADD COLUMN shared_team TEXT;
ALTER TABLE customers ADD COLUMN shared_at TEXT;
