-- Shed Co. admin — D1 schema.
-- Run this once in the D1 console (Cloudflare dashboard) after creating
-- the database. See README.md for the exact steps.

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  category TEXT,
  price REAL NOT NULL,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
