-- Potentia's own client CRM — D1 schema for the `potentia-crm` database.
--
-- This is a DIFFERENT database from the one worker/schema.sql sets up.
-- schema.sql builds `potentia-shed`, which belongs to the shed partner and
-- holds their customers, quotes and pricing. Nothing here goes in there:
-- Potentia's client list, revenue and notes live in their own database so a
-- client's data and Potentia's own can never be read out of one place.
--
-- Bind this database to the Worker as CRM_DB (see README).
--
-- You do not have to run this file. The Worker creates all four tables lazily
-- the first time the CRM is used. It's here so the schema is readable in git
-- and so a fresh install can be set up in one paste.

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
