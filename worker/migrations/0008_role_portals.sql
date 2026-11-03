-- Role portals (sales / builder / customer). Additive only; the worker also
-- creates these lazily (portals.js ensurePortalTables). Run against the shed DB (env.DB).
CREATE TABLE IF NOT EXISTS portal_users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, login TEXT NOT NULL UNIQUE, name TEXT, pass_hash TEXT NOT NULL, customer_id INTEGER, disabled_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_assignments (submission_id INTEGER PRIMARY KEY, builder_id INTEGER NOT NULL, assigned_at TEXT NOT NULL, assigned_by TEXT);
CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL, builder_id INTEGER NOT NULL, clock_in TEXT NOT NULL, clock_out TEXT);
CREATE TABLE IF NOT EXISTS job_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL, builder_id INTEGER NOT NULL, amount REAL, note TEXT, photo TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL, author TEXT, role TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
