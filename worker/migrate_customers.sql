-- One-time migration: adds customers + notes, and links existing
-- submissions to a customer. Run this ONCE in the D1 console — running it
-- twice will create duplicate customer rows.

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

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE submissions ADD COLUMN customer_id INTEGER;

INSERT INTO customers (name, email, phone, created_at, updated_at)
SELECT name, email, phone, MIN(created_at), MAX(created_at)
FROM submissions
GROUP BY email;

UPDATE submissions
SET customer_id = (SELECT id FROM customers WHERE customers.email = submissions.email)
WHERE customer_id IS NULL;
