-- Server-side, revocable sessions (Oct 26 2026 security review).
-- Run against BOTH databases: potentia-shed (DB: admin sessions) and
-- potentia-crm (CRM_DB: crm + leads sessions). The Worker also creates this
-- table lazily (CREATE TABLE IF NOT EXISTS), so this is belt-and-braces.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,            -- 'admin' | 'crm' | 'leads'
  issued_at INTEGER NOT NULL,    -- epoch ms
  expires_at INTEGER NOT NULL,   -- epoch ms
  revoked_at INTEGER             -- epoch ms, NULL while live
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
