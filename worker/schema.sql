-- ShedPro admin — D1 schema (fresh install).
-- If you already ran the older version of this file, use migrate_customers.sql
-- instead — this file's CREATE TABLE statements won't alter existing tables.

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per design/quote a customer has submitted — never overwritten, so
-- past designs stay accessible even after a customer submits changes.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

-- Interaction log per customer — append-only, newest first in the UI.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Payment log per customer. A single collection split across two methods
-- (e.g. part cash, part Venmo) is just two separate rows here. The worker
-- also creates this table lazily on first use, so this only matters for a
-- fresh install.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  note TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Install log, one row per install EVENT (e.g. the concrete pour, the shed
-- itself), tied to the specific order (submission), not the customer as a
-- whole — a repeat customer's second shed gets its own install rows. The
-- worker also creates this table lazily on first use, so this only matters
-- for a fresh install.
CREATE TABLE IF NOT EXISTS installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  item TEXT NOT NULL,        -- 'concrete' | 'shed'
  install_date TEXT NOT NULL,
  days REAL,
  note TEXT,
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

-- Single-row store for the shed designer's full pricing engine snapshot
-- (base price sheets, sell prices, costs, margin defaults) — the JSON blob
-- its own #admin screen reads/writes via /shed/pricing-config.
CREATE TABLE IF NOT EXISTS pricing_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT
);
