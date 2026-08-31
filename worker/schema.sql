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

-- ============================================================================
-- Potentia's own client CRM (/crm/*) — separate from everything above, which
-- belongs to the shed partner. The Worker also creates all four of these
-- lazily on first use, so this section only matters for a fresh install.
-- ============================================================================

-- One row per Potentia web-design client, from first inquiry through launch
-- and into their monthly plan. status: lead | contacted | proposal | building
-- | live | paused | lost. build_fee is the one-time site build, monthly_fee
-- the recurring plan — kept as separate columns because a client can have
-- either, both, or neither.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website_url TEXT,
  package TEXT,
  status TEXT NOT NULL DEFAULT 'lead',
  source TEXT,
  service TEXT,             -- what they picked on the contact form
  message TEXT,             -- their original inquiry, kept verbatim
  build_fee REAL,
  monthly_fee REAL,
  domain TEXT,
  domain_renews_at TEXT,
  launched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Interaction log per client — append-only, newest first in the UI.
CREATE TABLE IF NOT EXISTS client_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Payment log per client. kind ('build' | 'monthly' | 'addon' | 'other') is
-- what keeps a $150 retainer from reading as another slice of the build fee.
CREATE TABLE IF NOT EXISTS client_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'build',
  note TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The running list of edit requests and build milestones per client.
CREATE TABLE IF NOT EXISTS client_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL
);
