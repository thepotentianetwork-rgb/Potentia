// Potentia backend Worker — serves three things from one place:
//  1. /chat            — the AI assistant widget (assistant.js)
//  2. /admin/*          — password-gated dashboard for the shed company
//                         partner: view submissions, edit pricing
//     /shed/pricing     — public: current pricing (for their site to read)
//     /shed/submit      — public: customer design submissions land here
//  3. /crm/*            — Potentia's own client CRM (web-design clients:
//                         pipeline, retainers, edit requests). Its own
//                         password and its own session scope — the shed
//                         partner's login does not open it. See the CRM
//                         section near the bottom of this file.
//
// See README.md for full deployment steps (secrets, D1 database, etc).
//
// worker/pricing.js holds the whole SELL/COST pricing engine — it never
// ships to a browser. This is a static import (not per-request dynamic
// import) so it's evaluated once when the isolate boots, same as every
// other module-level const here.

import { computePricing, applyPricingOverrides, SELL, interiorPrice, foundationFinishPrice, gravelFoundationPrice, porchLineFor, wallAreaFt, sellDoorUpcharge, sellPerSqft } from "./pricing.js";

// Every (style, width) combination the designer's DOOR_SIZES catalog offers
// a tile for — kept in sync with that catalog by hand, same as WINDOW_CATALOG
// is kept in sync with pricing.js. Only style+width are needed: sellDoorUpcharge
// buckets purely off those two, never off the shed's own config.
const DOOR_PRICE_ENTRIES = [
  ["basic", 36], ["craftsman", 36], ["xtrim", 36], ["arch", 36], ["panel4", 36],
  ["basic", 42], ["craftsman", 42], ["xtrim", 42], ["arch", 42], ["panel4", 42],
  ["basic", 60], ["craftsman", 60], ["xtrim", 60], ["arch", 60], ["panel4", 60],
  ["basic", 72], ["craftsman", 72], ["xtrim", 72], ["arch", 72], ["panel4", 72],
  ["basic", 84], ["craftsman", 84], ["xtrim", 84], ["arch", 84], ["panel4", 84],
  ["res6", 36], ["reshalf", 36], ["resfull", 36], ["res6B", 36], ["reshalfB", 36], ["resfullB", 36],
  ["resDouble", 72], ["resDoubleFull", 72], ["resDoubleFullB", 72],
  ["slideglass", 70], ["slideglassB", 70],
  ["rollup", 72], ["rollup", 84], ["rollup", 96],
  ["cedar", 60], ["cedar", 72], ["cedar", 84], ["cedar", 96],
  ["fairytale", 36]
];
function computeDoorPrices() {
  const out = {};
  DOOR_PRICE_ENTRIES.forEach(([style, w]) => {
    out[style + "@" + w] = sellDoorUpcharge({ style, w });
  });
  return out;
}

const ALLOWED_ORIGINS = [
  "https://potentianetwork.com",
  "https://www.potentianetwork.com",
  "https://shedpro-utah.com",
  "https://www.shedpro-utah.com",
  "http://localhost:8080"
];

const SYSTEM_PROMPT = `You are the AI assistant embedded on the Potentia Studio website (a small web design & digital growth studio). Potentia builds custom, hand-built websites — no templates, no bloated platforms. 72-hour turnaround, free domain included for the first year.

Packages:
01 — Foundation: 3-Page Essential Site. Home, About & Contact pages, 5 images, free domain (1 year). One-time build, no monthly subscription (edits after the first 7 days are billed per change request).
02 — Booking: 3-Page Booking Site. Everything in Foundation, plus a live booking calendar. Includes a monthly plan for ongoing management & edits.
03 — Gallery: 4-Page Gallery Site. 15-photo gallery page, 1 featured video, free domain (1 year). Includes a monthly plan to edit, manage & update photos.
04 — Operator: Website + Growth System. Everything in Gallery, plus an AI chat assistant (like this one!), instant lead alerts, a built-in CRM, and a monthly performance report. Includes a monthly plan for the growth system & ongoing management.

Add-ons: Promotional Video, Google Business Setup, Google Profile Management (monthly), AI Content Engine (monthly), Professional Photography, Logo Vectorization, Service Menu Design.

Important: Potentia does not publish prices publicly — every quote is custom. NEVER state or guess a dollar amount, even if asked directly or pressured. If asked about cost, explain that pricing is tailored to the project and invite them to share project details on the contact page or by calling/texting (435) 277-0764; Potentia responds within 24 hours.

Be warm, concise, and confident — a few sentences at most. You are a live example of what Potentia builds (the Operator package's AI assistant), so when it's natural you can mention that this chat is itself a sample of that add-on. Don't be pushy. If asked something unrelated to Potentia or web design, answer briefly and steer back.`;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
  });
}

// ---- base64url helpers (Workers has btoa/atob but not base64url) ----
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBuf(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function strToBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToStr(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return decodeURIComponent(escape(atob(str)));
}

// ---- session tokens: HMAC-signed, stateless, no DB lookup needed ----
async function signToken(secret, payload) {
  const dataStr = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataStr));
  return `${strToBase64Url(dataStr)}.${bufToBase64Url(sig)}`;
}
async function verifyToken(secret, token) {
  if (!token || token.indexOf(".") === -1) return null;
  const [dataB64, sigB64] = token.split(".");
  try {
    const dataStr = base64UrlToStr(dataB64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBuf(sigB64), new TextEncoder().encode(dataStr));
    if (!valid) return null;
    const payload = JSON.parse(dataStr);
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return mismatch === 0;
}
function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}
// Shed-partner admin session. Scoped: a Potentia CRM token is signed with the
// same secret, so the payload check is what keeps the two apart — logging into
// the CRM must never hand you the shed dashboard, and vice versa.
async function requireAuth(request, env) {
  const payload = await verifyToken(env.ADMIN_SESSION_SECRET, bearerToken(request));
  return payload && payload.admin === true ? payload : null;
}
// Potentia's own client CRM session — see the CRM section further down.
async function requireCrmAuth(request, env) {
  const payload = await verifyToken(env.ADMIN_SESSION_SECRET, bearerToken(request));
  return payload && payload.crm === true ? payload : null;
}

// ---- /chat: AI assistant ----
async function handleChat(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const messages = incoming
    .slice(-20)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));

  if (messages.length === 0) return json({ error: "No messages" }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Server not configured" }, 500, origin);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: SYSTEM_PROMPT, messages })
    });
  } catch (e) {
    return json({ error: "Upstream request failed" }, 502, origin);
  }
  if (!upstream.ok) return json({ error: "Upstream error" }, 502, origin);

  const data = await upstream.json();
  const reply = data && data.content && data.content[0] && data.content[0].text
    ? data.content[0].text
    : "Sorry, I didn't catch that — could you rephrase?";
  return json({ reply }, 200, origin);
}

// ---- /admin/login ----
async function handleAdminLogin(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "Server not configured" }, 500, origin);
  }
  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return json({ error: "Invalid credentials" }, 401, origin);
  }
  const token = await signToken(env.ADMIN_SESSION_SECRET, { admin: true, exp: Date.now() + SESSION_TTL_MS });
  return json({ token }, 200, origin);
}

// ---- customers: find-or-create by email/phone match ----
async function findOrCreateCustomer(env, { name, email, phone, address, city, state, zip }) {
  const now = new Date().toISOString();
  let existing = null;
  if (email) {
    existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ? LIMIT 1").bind(email).first();
  }
  if (!existing && phone) {
    existing = await env.DB.prepare("SELECT id FROM customers WHERE phone = ? LIMIT 1").bind(phone).first();
  }
  if (existing) {
    await env.DB.prepare(
      "UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?, updated_at = ? WHERE id = ?"
    )
      .bind(name || null, email || null, phone || null, address || null, city || null, state || null, zip || null, now, existing.id)
      .run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    "INSERT INTO customers (name, email, phone, address, city, state, zip, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(name || null, email || null, phone || null, address || null, city || null, state || null, zip || null, now, now)
    .run();
  return res.meta.last_row_id;
}


// ---- lead temperature: manual override + revisit date ----
// The computed temperature (days since last touch) is wrong in the one case
// that matters most: a customer who has told you their timeline. Quote someone
// in September for a build they want in March and the maths says "hot" all
// through September and "dormant" by December, when the truth is the reverse.
//
// So two fields, both optional, on the customer:
//   temp_override — pin the temperature and stop computing it
//   follow_up_at  — the date to pick them back up
//
// The revisit date is what stops a pinned temperature going stale. Marked cold
// until March, the customer surfaces on their own in March rather than sitting
// cold forever in a list nobody rereads.
//
// Added by ALTER TABLE rather than in schema.sql because the customers table is
// already live with data. SQLite has no ADD COLUMN IF NOT EXISTS, so this reads
// the table's own columns first. Cheap no-op once they exist.
let customerTempColumnsReady = false;
async function ensureCustomerTempColumns(env) {
  if (customerTempColumnsReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(customers)").all();
  const have = (results || []).map((r) => r.name);
  if (have.indexOf("temp_override") === -1) {
    await env.DB.prepare("ALTER TABLE customers ADD COLUMN temp_override TEXT").run();
  }
  if (have.indexOf("follow_up_at") === -1) {
    await env.DB.prepare("ALTER TABLE customers ADD COLUMN follow_up_at TEXT").run();
  }
  customerTempColumnsReady = true;
}

const LEAD_TEMPS = ["hot", "warm", "cold", "dormant"];

// POST /admin/customers/:id/followup — { temperature, follow_up_at }
// Either may be null to clear it: null temperature means go back to computing
// it from activity, null date means no scheduled revisit.
async function handleSetFollowUp(request, env, origin, customerId) {
  await ensureCustomerTempColumns(env);
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));

  let temperature = null;
  if (body.temperature !== null && body.temperature !== undefined && body.temperature !== "") {
    const t = String(body.temperature).toLowerCase().trim();
    if (LEAD_TEMPS.indexOf(t) === -1) return json({ error: "Invalid temperature" }, 400, origin);
    temperature = t;
  }

  let followUpAt = null;
  if (body.follow_up_at) {
    const d = String(body.follow_up_at).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "Invalid date" }, 400, origin);
    followUpAt = d;
  }

  await env.DB.prepare("UPDATE customers SET temp_override = ?, follow_up_at = ?, updated_at = ? WHERE id = ?")
    .bind(temperature, followUpAt, new Date().toISOString(), customerId)
    .run();

  return json({ ok: true, temperature: temperature, follow_up_at: followUpAt }, 200, origin);
}

// ---- /admin/customers: one row per customer, with their latest order + note ----
async function handleListCustomers(request, env, origin) {
  await ensureCustomerTempColumns(env);
  await ensureCallsTable(env);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.city, c.state, c.created_at, c.updated_at,
       c.temp_override, c.follow_up_at,
       (SELECT s.id FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_id,
       (SELECT s.details FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_details,
       (SELECT s.status FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_status,
       (SELECT s.created_at FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_at,
       (SELECT COUNT(*) FROM submissions s WHERE s.customer_id = c.id AND s.status != 'superseded') AS submission_count,
       (SELECT n.text FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at,
       (SELECT cl.called_at FROM calls cl WHERE cl.customer_id = c.id ORDER BY cl.called_at DESC LIMIT 1) AS latest_call_at
     FROM customers c
     ORDER BY latest_submission_at DESC
     LIMIT 200`
  ).all();

  const customers = results.map((c) => {
    let quotedPrice = null;
    try {
      const d = JSON.parse(c.latest_details);
      if (d && d.quotedPrice != null) quotedPrice = d.quotedPrice;
    } catch (e) {}
    const { latest_details, ...rest } = c;
    return { ...rest, latest_quoted_price: quotedPrice };
  });

  return json({ customers }, 200, origin);
}

// Lazily creates the payments table on first use — avoids requiring a
// manual D1 migration step for a table that didn't exist when the DB was
// first set up. Cheap no-op once it already exists.
async function ensurePaymentsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      note TEXT,
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// Lazily creates the installs table on first use — same reasoning as
// ensurePaymentsTable: avoids a manual D1 migration for a table that didn't
// exist when the DB was first set up.
// One row per install EVENT, not per order — a submission can have both a
// concrete row and a shed row (or, if a job is redone, two rows for the same
// item), so this is an append-only log like payments/notes, not a pair of
// columns on submissions. item is 'concrete' or 'shed' today but nothing
// here assumes only those two, so a third item type later is just a new
// string, no schema change.
async function ensureInstallsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS installs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      item TEXT NOT NULL,
      install_date TEXT NOT NULL,
      days REAL,
      note TEXT,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// ---- /admin/customers/:id: full detail — customer + all their submissions + notes + payments + installs ----
async function handleGetCustomer(request, env, origin, id) {
  await ensureCustomerTempColumns(env);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensureSubmissionAdjustColumns(env);
  const { results: submissions } = await env.DB.prepare(
    "SELECT id, details, status, created_at, price_adjustment, adjustment_note, adjustments, effective_price FROM submissions WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

  // Each order carries the lines that can be comped on it, priced from its own
  // redline, plus its adjustments normalised into one shape. Done here so the
  // CRM never has to parse a redline or know about the older single-adjustment
  // column.
  submissions.forEach((sub) => {
    sub.adjustment_list = adjustmentsOf(sub);
    let redline = null;
    try {
      const d = JSON.parse(sub.details);
      redline = d && d.redline;
    } catch (e) {}
    sub.comp_items = compItemsFromRedline(redline);
  });

  const { results: notes } = await env.DB.prepare(
    "SELECT id, text, created_at FROM notes WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

  await ensurePaymentsTable(env);
  const { results: payments } = await env.DB.prepare(
    "SELECT id, amount, method, note, paid_at, created_at FROM payments WHERE customer_id = ? ORDER BY paid_at DESC, id DESC"
  )
    .bind(id)
    .all();

  await ensureCallsTable(env);
  const { results: calls } = await env.DB.prepare(
    "SELECT id, direction, outcome, duration_min, notes, called_at, created_at FROM calls WHERE customer_id = ? ORDER BY called_at DESC, id DESC"
  )
    .bind(id)
    .all();

  // installs are keyed by submission (order), not customer — join through so
  // a repeat customer's install log for order A never bleeds into order B.
  await ensureInstallsTable(env);
  const { results: installs } = await env.DB.prepare(
    `SELECT i.id, i.submission_id, i.item, i.install_date, i.days, i.note, i.created_at
     FROM installs i JOIN submissions s ON i.submission_id = s.id
     WHERE s.customer_id = ? ORDER BY i.install_date DESC, i.id DESC`
  )
    .bind(id)
    .all();

  return json({ customer, submissions, notes, payments, installs, calls }, 200, origin);
}

// ---- DELETE /admin/customers/:id — permanently removes the customer and
// every submission/note/payment tied to them. No soft-delete: the admin UI
// requires typing the customer's name plus a second confirm before this
// ever fires.
async function handleDeleteCustomer(request, env, origin, id) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensurePaymentsTable(env);
  await ensureCallsTable(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM calls WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM submissions WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id)
  ]);

  return json({ ok: true }, 200, origin);
}

// ---- /admin/customers/:id/notes ----
async function handleAddNote(request, env, origin, customerId) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return json({ error: "text required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.DB.prepare("INSERT INTO notes (customer_id, text, created_at) VALUES (?,?,?)")
    .bind(customerId, text, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id, created_at: now }, 200, origin);
}


// ---- call log (ShedPro) ----
// Logged by hand, not pulled from a phone system: the useful part of a call is
// what was said and what happens next, and no API knows that. Kept separate
// from notes because these fields are answerable in one tap each — a note is
// prose, a call is a record.
//
// Lazily created on first use, same as payments and installs.
async function ensureCallsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_min REAL,
      notes TEXT,
      called_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();
}

const CALL_DIRECTIONS = ["outbound", "inbound"];
// "callback" is its own outcome rather than a note, because it is the one that
// should change what you do next — see the follow-up temperature.
const CALL_OUTCOMES = ["connected", "voicemail", "no-answer", "callback", "wrong-number"];

async function handleAddCall(request, env, origin, customerId) {
  await ensureCallsTable(env);
  const body = await request.json().catch(() => ({}));
  const direction = enumOr(String(body.direction || "").toLowerCase().trim(), CALL_DIRECTIONS, null);
  const outcome = enumOr(String(body.outcome || "").toLowerCase().trim(), CALL_OUTCOMES, null);
  if (!direction) return json({ error: "valid direction required" }, 400, origin);
  if (!outcome) return json({ error: "valid outcome required" }, 400, origin);

  const durationRaw = Number(body.duration_min);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 600) : null;
  const notes = String(body.notes || "").trim().slice(0, 2000) || null;
  const calledAt = body.called_at ? String(body.called_at).slice(0, 40) : new Date().toISOString();

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO calls (customer_id, direction, outcome, duration_min, notes, called_at, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(customerId, direction, outcome, duration, notes, calledAt, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeleteCall(request, env, origin, id) {
  await ensureCallsTable(env);
  await env.DB.prepare("DELETE FROM calls WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/customers/:id/payments ----
// A single collection is sometimes split across two methods (e.g. part cash,
// part Venmo) — the UI handles that by just logging two separate entries
// rather than needing a special multi-method row.
const PAYMENT_METHODS = ["cash", "check", "venmo", "zelle", "invoice2go", "card", "other"];
async function handleAddPayment(request, env, origin, customerId) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const method = String(body.method || "").toLowerCase().trim();
  const note = String(body.note || "").slice(0, 500);
  const paidAt = body.paid_at ? String(body.paid_at).slice(0, 40) : new Date().toISOString();
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "valid amount required" }, 400, origin);
  if (!PAYMENT_METHODS.includes(method)) return json({ error: "valid method required" }, 400, origin);

  await ensurePaymentsTable(env);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(customerId, amount, method, note || null, paidAt, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeletePayment(request, env, origin, id) {
  await ensurePaymentsTable(env);
  await env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/submissions/:id/installs ----
const INSTALL_ITEMS = ["concrete", "shed"];
async function handleAddInstall(request, env, origin, submissionId) {
  const body = await request.json().catch(() => ({}));
  const item = String(body.item || "").toLowerCase().trim();
  const installDate = body.install_date ? String(body.install_date).slice(0, 40) : "";
  const days = body.days != null && body.days !== "" ? Number(body.days) : null;
  const note = String(body.note || "").slice(0, 500);
  if (!INSTALL_ITEMS.includes(item)) return json({ error: "valid item required" }, 400, origin);
  if (!installDate) return json({ error: "install_date required" }, 400, origin);
  if (days != null && (!Number.isFinite(days) || days < 0)) return json({ error: "days must be a non-negative number" }, 400, origin);

  await ensureInstallsTable(env);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO installs (submission_id, item, install_date, days, note, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(submissionId, item, installDate, days, note || null, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeleteInstall(request, env, origin, id) {
  await ensureInstallsTable(env);
  await env.DB.prepare("DELETE FROM installs WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/submissions/:id: single order, for the quote document ----
async function handleGetSubmission(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const submission = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!submission) return json({ error: "Not found" }, 404, origin);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(submission.customer_id).first();
  // Normalised here so the quote document never has to know that older rows
  // store a single adjustment and newer ones store a list.
  submission.adjustment_list = adjustmentsOf(submission);
  return json({ submission, customer: customer || null }, 200, origin);
}

// ---- one-time cleanup: for every customer, any "new" submission that
// isn't their single most-recent submission gets superseded — even if a
// newer submission from them has already been moved to contacted/quoted/etc.
// A "new" row lingering behind a submission the admin already acted on is
// just as stale as a duplicate "new" row; both mean the customer moved on
// to something newer and this one shouldn't still read as a fresh lead.
async function handleCleanupSuperseded(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT id, customer_id, status FROM submissions ORDER BY customer_id, created_at DESC"
  ).all();

  const seenCustomer = new Set();
  const staleIds = [];
  for (const row of results) {
    if (seenCustomer.has(row.customer_id)) {
      if (row.status === "new") staleIds.push(row.id);
    } else {
      seenCustomer.add(row.customer_id);
    }
  }

  if (staleIds.length) {
    await env.DB.batch(staleIds.map((id) => env.DB.prepare("UPDATE submissions SET status = 'superseded' WHERE id = ?").bind(id)));
  }

  return json({ ok: true, updated: staleIds.length }, 200, origin);
}

// One-time fix for the hotspot map showing dots at wherever a customer's
// internet connection happened to route through instead of their actual
// address (see geocodeAddress). Every existing row's details.geo was written
// by the old IP-based logic (or is missing entirely) — this re-derives it
// from the SAME address fields already stored on the row (details.address/
// city/state/zip) and overwrites details.geo, or clears it to null if there
// still isn't a usable address. New submissions get this automatically going
// forward; this is only for the ones already in the database.
// Sequential, not parallel, and capped — polite to the free geocoding API
// and this is a run-once maintenance action, not a hot path.
async function handleRegeocodeSubmissions(request, env, origin) {
  const { results } = await env.DB.prepare("SELECT id, details FROM submissions ORDER BY id DESC LIMIT 3000").all();

  let updated = 0;
  let cleared = 0;
  let unchanged = 0;
  for (const row of results) {
    let d;
    try {
      d = JSON.parse(row.details);
    } catch (e) {
      continue;
    }
    const newGeo = await geocodeAddress({ address: d.address, city: d.city, state: d.state, zip: d.zip });
    const oldGeo = d.geo || null;
    const same =
      (newGeo == null && oldGeo == null) ||
      (newGeo != null && oldGeo != null && newGeo.lat === oldGeo.lat && newGeo.lng === oldGeo.lng);
    if (same) {
      unchanged++;
      continue;
    }
    d.geo = newGeo;
    if (newGeo == null) cleared++;
    else updated++;
    await env.DB.prepare("UPDATE submissions SET details = ? WHERE id = ?")
      .bind(JSON.stringify(d).slice(0, 20000), row.id)
      .run();
  }

  return json({ ok: true, total: results.length, updated, clearedNoAddress: cleared, unchanged }, 200, origin);
}

// One-time fix for quotes submitted while pricing was mid-migration to the
// server-side engine: /shed/submit used to store whatever redline the
// client sent, which was null for every ordinary customer (only staff with
// the redline panel open ever had one) — so those rows are missing their
// itemized breakdown (interior finish, electrical, everything quote.html
// only shows via redline). This recomputes redline from each row's own
// stored config and writes it back, but ONLY when the recomputed total
// still matches the price that customer was actually quoted — if pricing
// has changed since (an admin edited rates), backfilling would silently
// show a different total than what was promised, so those rows are left
// alone and counted separately instead. Safe to run more than once: rows
// that already have a redline are skipped.
async function handleBackfillQuoteRedline(request, env, origin) {
  const { results } = await env.DB.prepare("SELECT id, details FROM submissions ORDER BY id DESC LIMIT 3000").all();

  let updated = 0;
  let alreadyHad = 0;
  let noConfig = 0;
  let priceChanged = 0;
  let failed = 0;
  const priceChangedIds = [];

  for (const row of results) {
    let d;
    try {
      d = JSON.parse(row.details);
    } catch (e) {
      failed++;
      continue;
    }
    if (d.redline) {
      alreadyHad++;
      continue;
    }
    if (!d.config || typeof d.config !== "object" || d.quotedPrice == null) {
      noConfig++;
      continue;
    }
    let result;
    try {
      ({ result } = await computeQuoteResult(d.config, undefined, env));
    } catch (e) {
      failed++;
      continue;
    }
    // Compare to the cent — anything closer than that is float/rounding
    // noise, not an actual price difference.
    const matches = Math.abs(result.customer - Number(d.quotedPrice)) < 0.01;
    if (!matches) {
      priceChanged++;
      priceChangedIds.push(row.id);
      continue;
    }
    d.redline = result.redline;
    await env.DB.prepare("UPDATE submissions SET details = ? WHERE id = ?")
      .bind(JSON.stringify(d).slice(0, 200000), row.id)
      .run();
    updated++;
  }

  return json(
    { ok: true, total: results.length, updated, alreadyHad, noConfig, priceChanged, priceChangedIds, failed },
    200,
    origin
  );
}


// ---- won_at: when a job was actually won ----
// Status changes were never timestamped, so "how long from quote to won" and
// "wins per month" had nothing to read. This starts recording it. Rows already
// marked won before this shipped stay null — there is no way to recover a date
// that was never written, and guessing one from created_at would put every
// historical win on the day its quote came in. The analytics endpoint reports
// those separately rather than quietly folding them in.
//
// ALTER TABLE at runtime, since submissions is live and SQLite has no
// ADD COLUMN IF NOT EXISTS.
let submissionWonColumnReady = false;
async function ensureSubmissionWonColumn(env) {
  if (submissionWonColumnReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(submissions)").all();
  if ((results || []).every((r) => r.name !== "won_at")) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN won_at TEXT").run();
  }
  submissionWonColumnReady = true;
}



// ---- flexible quote adjustments ----
// Three kinds, stackable, stored as a list against one submission:
//   {kind:'comp',    item:'Skylight'}          — that line becomes free
//   {kind:'percent', value:-10}                — 10% off
//   {kind:'amount',  value:-250}               — 250 off
// value is signed throughout, matching the single adjustment this replaces:
// negative takes money off, positive adds it.
//
// ORDER IS NOT COSMETIC. comps, then percent, then amounts. Comping an item
// and then taking a percentage means the percentage is not applied to
// something already being given away — on a 20,000 quote with a 600 cupola
// comped and 10% off, comps-first is 17,460 and percent-first is 17,400. The
// first is the defensible one. Amounts land last so "250 off" is exactly 250.
//
// Several percentages add rather than compound: 10% and 5% is 15% off, not
// 14.5%. Compounding is not what anyone means when they say it out loud.
const ADJUSTMENT_KINDS = ["comp", "percent", "amount"];

// Every individually-priced, customer-visible line on a quote, by the name it
// appears under — which is exactly the set that can be given away. Read from
// the submission's own stored redline, so it reflects what THAT customer was
// quoted rather than a generic catalogue.
function compItemsFromRedline(redline) {
  if (!redline || typeof redline !== "object") return [];
  const out = [];
  const seen = {};
  function push(name, amt) {
    const n = Number(amt);
    if (!name || !Number.isFinite(n) || n <= 0) return;
    const key = String(name);
    // Two shelves of the same size are one comp-able entry at the combined
    // price — offering the same name twice in a picker would be a trap.
    if (seen[key] != null) { out[seen[key]].amt = Math.round((out[seen[key]].amt + n) * 100) / 100; return; }
    seen[key] = out.length;
    out.push({ name: key, amt: Math.round(n * 100) / 100 });
  }
  (redline.addonLines || []).forEach((l) => push(l && l.name, l && l.amt));
  (redline.doorUpLines || []).forEach((l) => push(l && l.label, l && l.up));
  (redline.windowSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.dormerSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.shelfSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  push(redline.porchSellName, redline.porchSell);
  push(redline.sidingSellName, redline.sidingSell);
  push(redline.heightSellName, redline.heightSell);
  push(redline.elecSellName, redline.elecSell);
  push(redline.loftSellName, redline.loftSell);
  push(redline.intSellName, redline.intSell);
  push(redline.foundName, redline.foundSell);
  // paintSell is deliberately absent. The quote document never sums it as its
  // own line, so comping it would take money off a total that never contained
  // it — the customer's bill would drop by an amount nothing on the page
  // accounts for. Only lines the quote actually adds up can be given away.
  return out;
}

// The arithmetic, in one place. quote.html mirrors this for display; both are
// tested against the same cases so they cannot drift apart quietly.
function applyAdjustments(subtotal, adjustments, compItems) {
  const list = Array.isArray(adjustments) ? adjustments : [];
  const priceOf = {};
  (compItems || []).forEach((i) => { priceOf[i.name] = i.amt; });

  const comped = [];
  let compTotal = 0;
  list.filter((a) => a && a.kind === "comp").forEach((a) => {
    const amt = priceOf[a.item];
    if (amt != null) { compTotal += amt; comped.push({ name: a.item, amt: amt }); }
  });

  let running = subtotal - compTotal;
  if (running < 0) running = 0;
  const afterComps = running;

  let percentTotal = 0;
  list.filter((a) => a && a.kind === "percent").forEach((a) => {
    const v = Number(a.value);
    if (Number.isFinite(v)) percentTotal += afterComps * (v / 100);
  });
  running += percentTotal;

  let amountTotal = 0;
  list.filter((a) => a && a.kind === "amount").forEach((a) => {
    const v = Number(a.value);
    if (Number.isFinite(v)) amountTotal += v;
  });
  running += amountTotal;
  if (running < 0) running = 0;

  return {
    comped: comped,
    compTotal: Math.round(compTotal * 100) / 100,
    percentTotal: Math.round(percentTotal * 100) / 100,
    amountTotal: Math.round(amountTotal * 100) / 100,
    adjusted: Math.round(running * 100) / 100
  };
}

function validateAdjustments(raw) {
  if (!Array.isArray(raw)) return { error: "adjustments must be a list" };
  if (raw.length > 20) return { error: "too many adjustments" };
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return { error: "bad adjustment entry" };
    const kind = String(a.kind || "").toLowerCase();
    if (ADJUSTMENT_KINDS.indexOf(kind) === -1) return { error: "unknown adjustment kind: " + kind };
    const note = String(a.note || "").trim().slice(0, 200) || null;
    if (kind === "comp") {
      const item = String(a.item || "").trim().slice(0, 200);
      if (!item) return { error: "comp needs an item" };
      out.push({ kind: kind, item: item, note: note });
    } else {
      const v = Number(a.value);
      if (!Number.isFinite(v) || v === 0) return { error: kind + " needs a non-zero value" };
      // A percentage past 100 either zeroes the quote or doubles it by
      // accident; both are far likelier to be a typo than an intention.
      if (kind === "percent" && (v > 100 || v < -100)) return { error: "percent must be between -100 and 100" };
      out.push({ kind: kind, value: Math.round(v * 100) / 100, note: note });
    }
  }
  return { list: out };
}

// ---- per-quote price adjustment ----
// A discount or surcharge agreed with ONE customer, stored against their
// submission so it changes that quote and nothing else. Deliberately kept as
// its own field rather than edited into quotedPrice: the original quote stays
// readable, so "we quoted 23,839 and took 1,000 off" survives as a fact instead
// of becoming an unexplained 22,839.
//
// Signed, so the same field covers a discount (negative) and a surcharge
// (positive) — a delivery a long way out, an awkward site.
//
// ALTER TABLE at runtime, since submissions is live.
let submissionAdjustColumnsReady = false;
async function ensureSubmissionAdjustColumns(env) {
  if (submissionAdjustColumnsReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(submissions)").all();
  const have = (results || []).map((r) => r.name);
  if (have.indexOf("price_adjustment") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN price_adjustment REAL").run();
  }
  if (have.indexOf("adjustment_note") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN adjustment_note TEXT").run();
  }
  // The stackable list, and the price it works out to. effective_price is
  // stored rather than recomputed on every read so the analytics never has to
  // re-derive it from a redline — one place does the arithmetic, at save time.
  if (have.indexOf("adjustments") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN adjustments TEXT").run();
  }
  if (have.indexOf("effective_price") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN effective_price REAL").run();
  }
  submissionAdjustColumnsReady = true;
}


// Reads whichever form a row is in. Rows predating the list carry a single
// signed price_adjustment; they are presented as a one-entry list so nothing
// downstream needs to know which era a row is from.
function adjustmentsOf(row) {
  if (row && row.adjustments) {
    try {
      const parsed = JSON.parse(row.adjustments);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {}
  }
  if (row && row.price_adjustment != null && Number(row.price_adjustment) !== 0) {
    return [{ kind: "amount", value: Number(row.price_adjustment), note: row.adjustment_note || null }];
  }
  return [];
}

// POST /admin/submissions/:id/adjustments — { adjustments: [...] }
// Replaces the whole list; an empty list clears it.
async function handleSetAdjustments(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const row = await env.DB.prepare("SELECT id, details FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  const v = validateAdjustments(body.adjustments);
  if (v.error) return json({ error: v.error }, 400, origin);

  let quoted = null, redline = null;
  try {
    const d = JSON.parse(row.details);
    if (d) {
      if (d.quotedPrice != null) quoted = Number(d.quotedPrice);
      redline = d.redline || null;
    }
  } catch (e) {}

  const compItems = compItemsFromRedline(redline);
  // A comp naming a line this quote does not have would silently do nothing,
  // so it is refused rather than stored as a no-op the CRM would still display.
  const names = {};
  compItems.forEach((i) => { names[i.name] = true; });
  for (const a of v.list) {
    if (a.kind === "comp" && !names[a.item]) {
      return json({ error: "This quote has no line called \"" + a.item + "\"" }, 400, origin);
    }
  }

  // With no adjustments there is no effective price — the quote stands on its
  // own. Computed and reported as null in that case rather than as the
  // unadjusted total, so the response says exactly what was stored; returning
  // a number here while writing NULL would have the caller believe a price was
  // pinned that is not.
  let effective = null;
  if (v.list.length && quoted != null && Number.isFinite(quoted)) {
    effective = applyAdjustments(quoted, v.list, compItems).adjusted;
  }

  await env.DB.prepare(
    "UPDATE submissions SET adjustments = ?, effective_price = ?, price_adjustment = NULL, adjustment_note = NULL WHERE id = ?"
  )
    .bind(v.list.length ? JSON.stringify(v.list) : null, effective, id)
    .run();

  return json({ ok: true, adjustments: v.list, effective_price: effective, compItems: compItems }, 200, origin);
}

// POST /admin/submissions/:id/adjustment — { amount, note }
// amount null or 0 clears it.
async function handleSetAdjustment(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const row = await env.DB.prepare("SELECT id, details FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  let amount = null;
  if (body.amount !== null && body.amount !== undefined && body.amount !== "") {
    const n = Number(body.amount);
    if (!Number.isFinite(n)) return json({ error: "amount must be a number" }, 400, origin);
    amount = Math.round(n * 100) / 100;
  }

  // A discount can't exceed the quote — that would produce a negative total and
  // a quote document nobody could act on. Caught here rather than in the browser
  // so it holds however the endpoint is called.
  if (amount !== null && amount < 0) {
    let quoted = null;
    try {
      const d = JSON.parse(row.details);
      if (d && d.quotedPrice != null) quoted = Number(d.quotedPrice);
    } catch (e) {}
    if (quoted != null && Number.isFinite(quoted) && amount + quoted < 0) {
      return json({ error: "Discount is larger than the quote" }, 400, origin);
    }
  }

  const note = amount === null ? null : String(body.note || "").trim().slice(0, 200) || null;
  await env.DB.prepare("UPDATE submissions SET price_adjustment = ?, adjustment_note = ? WHERE id = ?")
    .bind(amount, note, id)
    .run();
  return json({ ok: true, amount: amount, note: note }, 200, origin);
}

async function handleUpdateSubmissionStatus(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status || "").slice(0, 40);
  if (!id || !status) return json({ error: "id and status required" }, 400, origin);
  await ensureSubmissionWonColumn(env);

  // Stamped on the way in to won, and cleared on the way out — a job marked won
  // by mistake and moved back shouldn't leave a win date behind for the
  // analytics to count. Re-marking an already-won job keeps the first date:
  // that's when it was won, not when someone last clicked the dropdown.
  if (status === "won") {
    await env.DB.prepare(
      "UPDATE submissions SET status = ?, won_at = COALESCE(won_at, ?) WHERE id = ?"
    )
      .bind(status, new Date().toISOString(), id)
      .run();
  } else {
    await env.DB.prepare("UPDATE submissions SET status = ?, won_at = NULL WHERE id = ?")
      .bind(status, id)
      .run();
  }
  return json({ ok: true }, 200, origin);
}

// ---- /admin/pricing ----
async function handleListPricing(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, category, price, unit, sort_order FROM pricing ORDER BY category, sort_order, label"
  ).all();
  return json({ pricing: results }, 200, origin);
}

async function handleUpsertPricing(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = body.id ? Number(body.id) : null;
  const label = String(body.label || "").slice(0, 200);
  const category = String(body.category || "").slice(0, 100);
  const price = Number(body.price);
  const unit = String(body.unit || "").slice(0, 40);
  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
  if (!label || !Number.isFinite(price)) return json({ error: "label and numeric price required" }, 400, origin);
  const now = new Date().toISOString();
  if (id) {
    await env.DB.prepare("UPDATE pricing SET label=?, category=?, price=?, unit=?, sort_order=?, updated_at=? WHERE id=?")
      .bind(label, category, price, unit, sortOrder, now, id)
      .run();
    return json({ ok: true, id }, 200, origin);
  }
  const res = await env.DB.prepare("INSERT INTO pricing (label, category, price, unit, sort_order, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(label, category, price, unit, sortOrder, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeletePricing(request, env, origin, id) {
  await env.DB.prepare("DELETE FROM pricing WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/pricing (public) + /shed/submit (public) ----
async function handlePublicPricing(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT label, category, price, unit FROM pricing ORDER BY category, sort_order, label"
  ).all();
  return json({ pricing: results }, 200, origin);
}

// Decodes a data: URL image into raw bytes for an R2 put(). Returns null for
// anything that isn't a plain base64 JPEG/PNG data URL.
function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return null;
  const ext = match[1].toLowerCase() === "png" ? "png" : "jpg";
  let bin;
  try {
    bin = atob(match[2]);
  } catch (e) {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ext, contentType: ext === "png" ? "image/png" : "image/jpeg" };
}

const ALLOWED_RENDER_VIEWS = ["perspective", "front", "back", "left", "right"];

// Uploads submitted 3D renders to R2 and returns { view: publicUrl }. Never
// throws — a broken/oversized image is just skipped, it doesn't fail the
// whole submission.
async function uploadRenders(env, renders) {
  if (!Array.isArray(renders) || !env.RENDERS || !env.RENDERS_PUBLIC_BASE) return null;
  const out = {};
  for (const r of renders.slice(0, 6)) {
    if (!r || typeof r.view !== "string" || !ALLOWED_RENDER_VIEWS.includes(r.view)) continue;
    const decoded = dataUrlToBytes(r.dataUrl);
    if (!decoded || decoded.bytes.length > 3_000_000) continue;
    const key = `submissions/${Date.now()}-${crypto.randomUUID()}-${r.view}.${decoded.ext}`;
    try {
      await env.RENDERS.put(key, decoded.bytes, { httpMetadata: { contentType: decoded.contentType } });
      out[r.view] = env.RENDERS_PUBLIC_BASE.replace(/\/$/, "") + "/" + key;
    } catch (e) {
      // skip this image
    }
  }
  return Object.keys(out).length ? out : null;
}

// Turns the customer's OWN submitted address into a map point for the admin
// data page's hotspot map — this used to be the requester's IP-based
// geolocation instead, which puts the dot wherever their phone/ISP happened
// to route through at the moment they hit submit (often a different city
// than the actual delivery address, sometimes a different state entirely).
// Zippopotam.us is free and keyless — no signup, no API key to manage — and
// resolves to a ZIP centroid, which is the same precision the old IP
// geolocation gave anyway, just anchored to the right place. Falls back from
// zip -> city+state -> null; a submission with no usable address gets no
// dot rather than a wrong one.
async function geocodeAddress(contact) {
  const zip = String((contact && contact.zip) || "").trim().slice(0, 10);
  const state = String((contact && contact.state) || "").trim().slice(0, 2);
  const city = String((contact && contact.city) || "").trim();
  try {
    if (zip) {
      const r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(zip));
      if (r.ok) {
        const d = await r.json();
        const p = d.places && d.places[0];
        if (p && p.latitude != null && p.longitude != null) {
          return {
            lat: Number(p.latitude),
            lng: Number(p.longitude),
            city: p["place name"] || city || null,
            region: p["state abbreviation"] || state || null,
            country: "US"
          };
        }
      }
    }
    if (city && state) {
      const r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(state) + "/" + encodeURIComponent(city));
      if (r.ok) {
        const d = await r.json();
        const p = d.places && d.places[0];
        if (p && p.latitude != null && p.longitude != null) {
          return {
            lat: Number(p.latitude),
            lng: Number(p.longitude),
            city: d["place name"] || city,
            region: d["state abbreviation"] || state,
            country: "US"
          };
        }
      }
    }
  } catch (e) {
    // network hiccup — fall through to null, no dot rather than a wrong one
  }
  return null;
}

async function handleShedSubmit(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  // Accepts either the designer tool's shape ({contact:{...}, config, permalink,
  // quotedPrice, redline, renders, page}) or a plain {name, email, phone, details} shape.
  const contact = body.contact || {};
  const name = String(contact.name || body.name || "").slice(0, 200);
  const email = String(contact.email || body.email || "").slice(0, 200);
  const phone = String(contact.phone || body.phone || "").slice(0, 60);
  if (!name || !email) return json({ error: "name and email required" }, 400, origin);

  // Map point for the admin data page's hotspot map — geocoded from the
  // customer's own submitted address, not from where their connection
  // happened to be (see geocodeAddress above).
  const geo = await geocodeAddress(contact);

  // Price it ourselves rather than trusting body.quotedPrice/body.redline —
  // the client can't compute a redline any more (pricing.js never ships to
  // it), so quoteCache.redline is only ever non-null for staff who had the
  // redline panel open at submit time. Every ordinary customer quote used to
  // arrive with redline:null, which is why the stored order was missing
  // line items (electrical, interior finish) that only ever lived in the
  // redline breakdown. Computing it here means every submission gets the
  // real, current numbers regardless of what the browser sent.
  let quotedPrice = body.quotedPrice != null ? body.quotedPrice : null;
  let redline = body.redline || null;
  if (body.config) {
    try {
      const { result } = await computeQuoteResult(body.config, undefined, env);
      quotedPrice = result.customer;
      redline = result.redline;
    } catch (e) {
      // Malformed config — fall back to whatever the client sent (if anything)
      // rather than losing the submission over a pricing error.
    }
  }

  const detailsPayload =
    body.details !== undefined
      ? body.details
      : {
          address: contact.address || null,
          city: contact.city || null,
          state: contact.state || null,
          zip: contact.zip || null,
          notes: contact.notes || null,
          config: body.config || null,
          permalink: body.permalink || null,
          quotedPrice: quotedPrice,
          redline: redline, // internal cost/margin breakdown — admin dashboard only, never public
          renders: await uploadRenders(env, body.renders),
          page: body.page || null,
          geo,
          heardAbout: body.heardAbout || null,
          heardAboutOther: body.heardAboutOther || null
        };
  const details = JSON.stringify(detailsPayload).slice(0, 20000);

  const customerId = await findOrCreateCustomer(env, {
    name,
    email,
    phone,
    address: contact.address,
    city: contact.city,
    state: contact.state,
    zip: contact.zip
  });

  // A customer working through design iterations can submit several times
  // in a row. Only the newest untouched submission should ever count as a
  // "new" lead — once a fresh one lands, mark any still-"new" ones from
  // this same customer as superseded so they stop inflating the New count.
  // Submissions the admin already moved past "new" (contacted/quoted/etc.)
  // are left alone — that's real pipeline progress, not noise.
  await env.DB.prepare("UPDATE submissions SET status = 'superseded' WHERE customer_id = ? AND status = 'new'")
    .bind(customerId)
    .run();

  await env.DB.prepare("INSERT INTO submissions (customer_id, name, email, phone, details, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(customerId, name, email, phone, details, "new", new Date().toISOString())
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/analytics: aggregated stats + geo points for the data dashboard ----
async function handleAnalytics(request, env, origin) {
  await ensureSubmissionWonColumn(env);
  await ensureSubmissionAdjustColumns(env);
  const { results } = await env.DB.prepare(
    "SELECT id, customer_id, details, status, created_at, won_at, price_adjustment, effective_price FROM submissions ORDER BY created_at DESC LIMIT 3000"
  ).all();

  // ---- install state of won jobs ----
  // Derived from the install log, not from a status anyone has to remember to
  // set. The dates are already recorded per order; asking for a second,
  // separate "installed" flag would mean two records of the same fact, free to
  // disagree — a job marked installed with no date, or a date logged against a
  // job still reading pending.
  //
  // The SHED install is what counts as done. A poured pad on its own is not a
  // delivered job, and treating it as one would report revenue as complete
  // while the building is still to come.
  await ensureInstallsTable(env);
  const { results: shedInstalls } = await env.DB.prepare(
    "SELECT submission_id, MAX(install_date) AS install_date FROM installs WHERE item = 'shed' GROUP BY submission_id"
  ).all();
  const shedInstallBy = {};
  (shedInstalls || []).forEach((r) => { shedInstallBy[r.submission_id] = r.install_date; });
  const todayISO = new Date().toISOString().slice(0, 10);

  const install = {
    installed: { count: 0, revenue: 0 },
    scheduled: { count: 0, revenue: 0 },
    unscheduled: { count: 0, revenue: 0 },
    nextDates: []
  };

  // ---- won jobs ----
  // Everything here is derived from what is genuinely stored. Revenue is the
  // quoted price of jobs marked won; cost is that job's own redline
  // trueTotalCost, which the pricing engine computed at submission — so the
  // margin is the real one, not a percentage assumption.
  // Discounts given, tracked separately so the effect on takings is visible
  // rather than just quietly absent from the revenue line.
  const adjustments = { total: 0, count: 0, wonTotal: 0, wonCount: 0 };
  const won = {
    count: 0, revenue: 0, cost: 0, costKnown: 0,
    byMonth: {}, byStyle: {}, bySize: {}, values: [],
    dated: 0, undated: 0, daysToWin: []
  };
  const lost = { count: 0, revenue: 0, byStyle: {} };

  const byDay = {};
  const statusCounts = {};
  const styleCounts = {};
  const sidingCounts = {};
  const points = [];
  const prices = [];
  const sizeCounts = {};
  const heardCounts = {};

  for (const row of results) {
    const day = (row.created_at || "").slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
    const status = row.status || "new";
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    let d = null;
    try {
      d = JSON.parse(row.details);
    } catch (e) {}
    if (d) {
      const config = d.config || {};
      if (config.style) styleCounts[config.style] = (styleCounts[config.style] || 0) + 1;
      if (config.siding) sidingCounts[config.siding] = (sidingCounts[config.siding] || 0) + 1;
      if (config.w && config.l) {
        const key = config.w + "x" + config.l;
        sizeCounts[key] = (sizeCounts[key] || 0) + 1;
      }
      if (d.heardAbout) {
        const key = d.heardAbout === "other" && d.heardAboutOther ? "other: " + d.heardAboutOther : d.heardAbout;
        heardCounts[key] = (heardCounts[key] || 0) + 1;
      }
      // Every figure below uses the price actually agreed — the quote plus any
      // adjustment made for this customer. Reporting won revenue at the
      // pre-discount number would overstate the takings, and worse, overstate
      // the margin: a discount comes straight out of profit, since the build
      // costs the same either way.
      const rawPrice = d.quotedPrice != null ? Number(d.quotedPrice) : null;
      // effective_price is written at save time by the adjustment endpoint,
      // which is the only place the comp/percent/amount arithmetic runs. Older
      // rows carrying a single signed price_adjustment still work.
      let price = null;
      if (row.effective_price != null && isFinite(Number(row.effective_price))) {
        price = Number(row.effective_price);
      } else if (rawPrice != null && isFinite(rawPrice)) {
        const legacy = row.price_adjustment != null ? Number(row.price_adjustment) : 0;
        price = rawPrice + (isFinite(legacy) ? legacy : 0);
      }
      const adjust = (price != null && rawPrice != null && isFinite(rawPrice)) ? price - rawPrice : 0;
      if (price != null && isFinite(price)) prices.push(price);
      if (adjust && isFinite(adjust)) {
        adjustments.total += adjust;
        adjustments.count++;
        if (status === "won") { adjustments.wonTotal += adjust; adjustments.wonCount++; }
      }

      if (status === "won") {
        won.count++;
        // Three states, because "pending" covers two situations that need
        // different things from you: one needs a date in the diary, the other
        // needs the crew to turn up.
        const shedDate = shedInstallBy[row.id];
        const bucket = !shedDate ? "unscheduled"
          : (String(shedDate).slice(0, 10) <= todayISO ? "installed" : "scheduled");
        install[bucket].count++;
        if (price != null && isFinite(price)) install[bucket].revenue += price;
        if (bucket === "scheduled") install.nextDates.push(String(shedDate).slice(0, 10));
        if (price != null && isFinite(price)) {
          won.revenue += price;
          won.values.push(price);
        }
        // trueTotalCost is this job's own costed build. Counted separately from
        // the job count so a margin is never reported over a mix of jobs that
        // had cost data and jobs that didn't.
        const tc = d.redline && d.redline.trueTotalCost;
        if (tc != null && isFinite(Number(tc))) {
          won.cost += Number(tc);
          won.costKnown++;
        }
        if (config.style) won.byStyle[config.style] = (won.byStyle[config.style] || 0) + 1;
        if (config.w && config.l) {
          const k = config.w + "x" + config.l;
          won.bySize[k] = (won.bySize[k] || 0) + 1;
        }
        // Grouped by the month it was WON where that's known. Rows won before
        // won_at existed are counted apart rather than dropped into the month
        // their quote arrived, which would be a different fact.
        if (row.won_at) {
          won.dated++;
          const m = String(row.won_at).slice(0, 7);
          won.byMonth[m] = (won.byMonth[m] || 0) + 1;
          if (row.created_at) {
            const days = Math.round((new Date(row.won_at) - new Date(row.created_at)) / 86400000);
            if (isFinite(days) && days >= 0) won.daysToWin.push(days);
          }
        } else {
          won.undated++;
        }
      } else if (status === "lost") {
        lost.count++;
        if (price != null && isFinite(price)) lost.revenue += price;
        if (config.style) lost.byStyle[config.style] = (lost.byStyle[config.style] || 0) + 1;
      }
      if (d.geo && d.geo.lat != null && d.geo.lng != null) {
        points.push({
          lat: d.geo.lat,
          lng: d.geo.lng,
          city: d.geo.city || null,
          region: d.geo.region || null,
          status,
          price
        });
      }
    }
  }

  prices.sort((a, b) => a - b);
  const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  const custRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first();
  // Superseded rows are earlier, never-actioned resubmissions from the same
  // customer — they stay in the DB for history but shouldn't inflate the
  // headline submission count.
  const activeSubmissionCount = results.filter((row) => row.status !== "superseded").length;

  // Collected across all customers. Deliberately NOT presented as "collected
  // against won jobs": payments are recorded per customer, not per submission,
  // so tying a payment to a specific job isn't something the data supports.
  await ensurePaymentsTable(env);
  const paidRow = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments").first();

  won.values.sort((a, b) => a - b);
  won.daysToWin.sort((a, b) => a - b);
  const decided = won.count + lost.count;
  const wonBlock = {
    count: won.count,
    revenue: Math.round(won.revenue),
    // Only over the jobs whose cost is actually known — see costKnown.
    cost: Math.round(won.cost),
    costKnown: won.costKnown,
    grossProfit: won.costKnown ? Math.round(won.revenue - won.cost) : null,
    marginPct: won.costKnown && won.revenue > 0
      ? Math.round(((won.revenue - won.cost) / won.revenue) * 1000) / 10
      : null,
    avgValue: won.values.length ? Math.round(won.revenue / won.values.length) : null,
    medianValue: won.values.length ? won.values[Math.floor(won.values.length / 2)] : null,
    // Of decided jobs only. Open ones haven't been lost, and counting them
    // against the rate would make a busy pipeline look like failure.
    winRatePct: decided ? Math.round((won.count / decided) * 1000) / 10 : null,
    decided,
    lostCount: lost.count,
    lostRevenue: Math.round(lost.revenue),
    byMonth: won.byMonth,
    byStyle: won.byStyle,
    bySize: won.bySize,
    lostByStyle: lost.byStyle,
    dated: won.dated,
    undated: won.undated,
    medianDaysToWin: won.daysToWin.length ? won.daysToWin[Math.floor(won.daysToWin.length / 2)] : null,
    collectedAllTime: Math.round(paidRow ? paidRow.total : 0),
    // Negative for discounts given. Shown so a thin margin can be traced to
    // what was given away rather than looking like a pricing problem.
    adjustedWonTotal: Math.round(adjustments.wonTotal),
    adjustedWonCount: adjustments.wonCount
  };

  install.nextDates.sort();
  const installBlock = {
    installed: { count: install.installed.count, revenue: Math.round(install.installed.revenue) },
    scheduled: { count: install.scheduled.count, revenue: Math.round(install.scheduled.revenue) },
    unscheduled: { count: install.unscheduled.count, revenue: Math.round(install.unscheduled.revenue) },
    // Everything won but not yet in the ground — the work still owed.
    pendingCount: install.scheduled.count + install.unscheduled.count,
    pendingRevenue: Math.round(install.scheduled.revenue + install.unscheduled.revenue),
    nextInstall: install.nextDates.length ? install.nextDates[0] : null
  };

  return json(
    {
      won: wonBlock,
      install: installBlock,
      totalSubmissions: activeSubmissionCount,
      totalCustomers: custRow ? custRow.n : 0,
      byDay,
      statusCounts,
      styleCounts,
      sidingCounts,
      sizeCounts,
      heardCounts,
      avgPrice,
      medianPrice,
      pricedCount: prices.length,
      points
    },
    200,
    origin
  );
}

// ---- /shed/pricing-config: the designer's full pricing engine snapshot ----
// GATED — this is the entire SELL/COST sheet (every price, every margin
// number). It used to be public ("every visitor's designer loads live
// prices on boot"), which was the actual hole: view-source hid nothing a
// competitor couldn't just fetch directly. Now the designer no longer has
// its own SELL/COST at all (see /shed/quote below, which computes off
// pricing.js server-side) so this endpoint has exactly one legitimate
// caller left — admin-pricing.html — and it's authenticated like every
// other admin route.
async function handleGetPricingConfig(request, env, origin) {
  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  if (!row) return json({}, 200, origin);
  let data;
  try {
    data = JSON.parse(row.data);
  } catch (e) {
    data = {};
  }
  return json(data, 200, origin);
}

async function handleSavePricingConfig(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400, origin);
  const data = JSON.stringify(body).slice(0, 200000);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO pricing_config (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  )
    .bind(data, now)
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/quote: the ONLY place a price is computed. SELL/COST live in
// pricing.js, which never ships to a browser — this endpoint is how the
// designer gets a number instead. Loads the admin-edited pricing snapshot
// fresh on every call (D1 reads are cheap; a stale cached snapshot serving
// a price the admin just corrected would be worse) and applies it on top
// of pricing.js's hardcoded defaults before computing. ----
const SHED_STYLES = ["gable", "barn", "leanto", "hip", "3peak", "4peak"];
const SHED_SIDING = ["vertical", "horizontal", "board-batten", "pine"];
const SHED_ROOFTYPE = ["shingle", "metal"];
const SHED_OVTYPE = ["gable", "all4"];
const SHED_PORCHLOC = ["none", "front", "side"];
const SHED_FOUNDATION = ["blocks", "pad", "existing", "gravel"];
const SHED_FOUNDATION_FINISH = ["plain", "broom", "coated"];
// "standard" is deliberately absent — that tier was retired Sep 2026 and has
// no entry in pricing.js's ELEC_MAP any more. Leaving it here let an old
// permalink or a stale cached designer submit elec:"standard", which passed
// validation and then priced electrical at $0 because the map lookup missed:
// a quote that silently omitted $1,500 of work. Now it falls back to "none",
// so a retired tier reads as no electrical package rather than a free one.
const SHED_ELEC = ["none", "basic", "core", "essential"];
const SHED_INT_FINISH = ["none", "drywall", "painted"];

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function enumOr(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}
function capArray(a, max) {
  return Array.isArray(a) ? a.slice(0, max) : [];
}
// Matches the designer's own sliders/pickers — see the wsteps markup in
// designer.html (width/length/height ranges) and the style/siding/etc.
// option lists. A request outside these isn't a build the designer could
// actually produce, so it's clamped rather than trusted.
function validateShedConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    style: enumOr(raw.style, SHED_STYLES, "gable"),
    w: clampNum(raw.w, 6, 20, 8),
    l: clampNum(raw.l, 6, 32, 12),
    h: clampNum(raw.h, 6, 12, 8),
    pitch: clampNum(raw.pitch, 3, 12, 6),
    siding: enumOr(raw.siding, SHED_SIDING, "vertical"),
    roofType: enumOr(raw.roofType, SHED_ROOFTYPE, "shingle"),
    ovType: enumOr(raw.ovType, SHED_OVTYPE, "gable"),
    ovh: clampNum(raw.ovh, 0, 24, 4),
    porchLoc: enumOr(raw.porchLoc, SHED_PORCHLOC, "none"),
    porchDepth: clampNum(raw.porchDepth, 0, 20, 0),
    porchTier: typeof raw.porchTier === "string" ? raw.porchTier.slice(0, 60) : "standard",
    dormerL: clampNum(raw.dormerL, 0, 12, 0),
    dormerR: clampNum(raw.dormerR, 0, 12, 0),
    foundation: enumOr(raw.foundation, SHED_FOUNDATION, "blocks"),
    foundationFinish: enumOr(raw.foundationFinish, SHED_FOUNDATION_FINISH, "plain"),
    loft: typeof raw.loft === "string" ? raw.loft.slice(0, 20) : "none",
    elec: enumOr(raw.elec, SHED_ELEC, "none"),
    intFinish: enumOr(raw.intFinish, SHED_INT_FINISH, "none"),
    addons: raw.addons && typeof raw.addons === "object" ? raw.addons : {},
    doors: capArray(raw.doors, 30),
    windows: capArray(raw.windows, 30),
    vents: capArray(raw.vents, 30),
    shelves: capArray(raw.shelves, 30)
  };
}

// The handful of prices the client needs a NUMBER for before the customer
// has finished a build — dormer width buttons, interior finish buttons,
// foundation finish buttons, and every window catalog tile — computed off
// the real (possibly admin-overridden) tables, so the client never needs
// SELL itself to render a label. Porch prices are the shed's own current
// width/length at the 'standard' depth ladder, plus every finish tier at
// whatever depth is currently selected (the two moments the porch page
// actually shows a price for).
function computeOptionPrices(cfg) {
  const encEat = cfg.style === "gable" && cfg.porchLoc !== "none" && cfg.porchDepth > 0
    ? (cfg.porchLoc === "front" ? { w: 0, l: cfg.porchDepth } : { w: cfg.porchDepth, l: 0 })
    : { w: 0, l: 0 };
  const encW = Math.max(6, cfg.w - encEat.w), encD = Math.max(6, cfg.l - encEat.l);

  const windows = Object.assign({}, SELL.windows);

  const interior = { drywall: interiorPrice("drywall", encW, encD), painted: interiorPrice("painted", encW, encD) };

  const padSqft = Math.round(encW * encD);
  const foundationFinish = {
    plain: foundationFinishPrice("plain", 0),
    coated: foundationFinishPrice("coated", 0),
    broom: foundationFinishPrice("broom", padSqft)
  };

  // Depth buttons price at the shed's CURRENTLY selected finish tier (the
  // tier ladder itself is priced separately below, at the current depth) —
  // both pages read the same build, just holding a different dimension fixed.
  const curTier = cfg.porchTier || "standard";
  const maxPorchFront = Math.max(0, cfg.l - 6);
  const maxPorchSide = Math.max(0, cfg.w - 6);
  const frontDepths = {};
  [4, 6, 8].filter((ft) => ft <= maxPorchFront).forEach((ft) => {
    const line = porchLineFor("front", ft, curTier, cfg.w);
    if (line) frontDepths[ft] = line.price;
  });
  const sideDepths = {};
  [4, 6, 8].filter((ft) => ft <= maxPorchSide).forEach((ft) => {
    const line = porchLineFor("side", ft, "standard", cfg.l);
    if (line) sideDepths[ft] = line.price;
  });
  const frontTiers = {};
  if (cfg.porchLoc === "front" && cfg.porchDepth > 0) {
    Object.keys(SELL.porchFrontSqft).forEach((tier) => {
      const line = porchLineFor("front", cfg.porchDepth, tier, cfg.w);
      if (line) frontTiers[tier] = line.price;
    });
  }

  const wallHeight = {};
  Object.keys(SELL.wallHeight).forEach((h) => {
    const rate = SELL.wallHeight[h];
    wallHeight[h] = rate > 0 ? rate * wallAreaFt(cfg.w, cfg.l, Number(h)) : 0;
  });

  // Add-ons list (Upgrades step): flat items pass the SELL.options.flat price
  // straight through; per-sqft items are computed against THIS shed's own
  // floor/roof/wall area, same as wallHeight above — the client never gets
  // handed the $/sqft rate itself, only what it comes to for this build.
  const ADDON_FLAT_KEYS = {
    shutters: "Shutters", flowerboxes: "Flowerboxes", ridgeVent: "Roof Ridge Vent",
    skylight: "Skylight", stairs: "Stairs", statLadder: "Stationary Ladder",
    shedRemoval: "Shed Removal", concreteRemoval: "Concrete Removal",
    atticLadder: "Attic Pull-Down Ladder"
  };
  const ADDON_PERSQFT_KEYS = {
    weatherGuard: "Floor Weather Guard", radiantBarrier: "Radiant Roof Barrier",
    houseWrap: "House Wrap", hurricaneTies: "Hurricane Ties"
  };
  const addons = {};
  Object.keys(ADDON_FLAT_KEYS).forEach((k) => { addons[k] = SELL.options.flat[ADDON_FLAT_KEYS[k]] || 0; });
  Object.keys(ADDON_PERSQFT_KEYS).forEach((k) => {
    addons[k] = sellPerSqft(ADDON_PERSQFT_KEYS[k], cfg.w, cfg.l, cfg.h);
  });
  addons.cupola = {
    black: SELL.options.flat['Cupola 16" Black Roof'] || 0,
    copper: SELL.options.flat['Cupola 16" Copper Roof'] || 0
  };

  // Siding upcharge, computed against THIS shed's own wall area — the
  // client used to hardcode the $/sqft rates straight into the Siding
  // step's markup (a rate table baked into served HTML, worse than an
  // option price). Now it's a dollar amount per siding choice, like wallHeight.
  const siding = {};
  Object.keys(SELL.siding).forEach((k) => {
    const rate = SELL.siding[k];
    siding[k] = rate > 0 ? rate * wallAreaFt(cfg.w, cfg.l, cfg.h) : 0;
  });

  // Electrical tiers are flat (no size dependency). "Standard" is retired
  // from the designer's own tier list (ShedPro's real packages are now just
  // Basic/Core/Essential — see gallery page) but stays priceable in
  // pricing.js/SELL.electrical so an old permalink or stored quote with
  // elec:'standard' still prices correctly; it's just not offered here any
  // more, so there's no reason to hand the client a price for it.
  const ELEC_MAP = { basic: "Basic", core: "Core", essential: "Essential" };
  const electrical = {};
  Object.keys(ELEC_MAP).forEach((k) => { electrical[k] = SELL.electrical[ELEC_MAP[k]] || 0; });

  // Shelving: rate × length, capped to the wall it's on — same as
  // computePricing's own SHELVES block. One {16, 24} pair per placed shelf
  // (index-matched to cfg.shelves) so the depth picker can show what
  // switching depth would cost THIS shelf at its own current length,
  // without the client ever holding the $/ft rate itself.
  const shelfRate16 = SELL.options.perLinFt['16" Deep Shelving'] || 0;
  const shelfRate24 = SELL.options.perLinFt['24" Deep Shelving'] || 0;
  const shelving = (cfg.shelves || []).map((sd) => {
    const wallLen = (sd.wall === "front" || sd.wall === "back") ? cfg.w : cfg.l;
    const lenFt = Math.min(sd.len || wallLen, wallLen);
    return { 16: lenFt * shelfRate16, 24: lenFt * shelfRate24 };
  });

  return {
    dormers: Object.assign({}, SELL.dormers),
    windows: windows,
    doors: computeDoorPrices(),
    interior: interior,
    // 'gravel' isn't a flat SELL.foundation entry — it's tiered by THIS
    // shed's own footprint (gravelTiers), same as foundationFinish.broom
    // below is tiered by pad sqft. Computed fresh here so the tile always
    // shows what this exact build would actually be charged.
    foundation: Object.assign({}, SELL.foundation, { gravel: gravelFoundationPrice(padSqft) }),
    foundationFinish: foundationFinish,
    wallHeight: wallHeight,
    siding: siding,
    electrical: electrical,
    shelving: shelving,
    addons: addons,
    porch: { frontDepths: frontDepths, sideDepths: sideDepths, frontTiers: frontTiers }
  };
}

// Shared by /shed/quote and /shed/submit: validate the raw config, layer in
// whatever admin overrides are currently saved in D1, and price it. Both
// callers need the same "what would this build actually cost right now"
// answer — /shed/submit should never trust a client-supplied price or
// redline (the client can't compute either any more, and even if it could,
// a submitted quote's numbers need to be the real ones, not whatever the
// browser was told to send).
async function computeQuoteResult(rawConfig, overrides, env) {
  const cfg = validateShedConfig(rawConfig);

  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  if (row) {
    let saved;
    try {
      saved = JSON.parse(row.data);
    } catch (e) {
      saved = null;
    }
    if (saved) applyPricingOverrides(saved);
  }

  const opts = overrides && typeof overrides === "object" ? overrides : undefined;
  const result = computePricing(cfg, opts);
  return { cfg, result };
}

async function handleShedQuote(request, env, origin) {
  const body = await request.json().catch(() => ({}));

  let cfg, result;
  try {
    ({ cfg, result } = await computeQuoteResult(body.config, body.overrides, env));
  } catch (e) {
    return json({ error: "Could not price this build" }, 400, origin);
  }

  const url = new URL(request.url);
  const wantsRedline = url.searchParams.get("redline") === "1";
  if (wantsRedline) {
    if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
    return json({ total: result.customer, redline: result.redline }, 200, origin);
  }

  return json({ total: result.customer, optionPrices: computeOptionPrices(cfg) }, 200, origin);
}

// ---- /shed/design: short shareable links for a saved 3D design ----
// The designer used to build its own "share this design" link by encoding
// the ENTIRE config into the URL itself — every dimension, door, window,
// color, addon — which is why that link was enormous. This stores the
// config server-side under a short random code instead, so the link is just
// .../designer.html?d=<8 hex chars>. Works for ANY design, not only ones
// that have gone through /shed/submit — staff can hand a customer a link
// before they've filled out contact info at all.
// Lazily creates the table on first use — same reasoning as
// ensurePaymentsTable/ensureInstallsTable: avoids a manual D1 migration for
// a table that didn't exist when the DB was first set up.
async function ensureSavedDesignsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS saved_designs (
      code TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// Random, not sequential — a saved design can carry the customer's name/
// email/phone (whatever the designer had on hand when it was saved), and a
// guessable code would let anyone page through other people's designs by
// incrementing it.
function randomDesignCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function handleSaveDesign(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.config) {
    return json({ error: "config required" }, 400, origin);
  }
  const config = JSON.stringify(body.config).slice(0, 40000);
  const contact = body.contact || {};
  const name = String(contact.name || "").slice(0, 200) || null;
  const email = String(contact.email || "").slice(0, 200) || null;
  const phone = String(contact.phone || "").slice(0, 60) || null;

  await ensureSavedDesignsTable(env);

  // Collisions are astronomically unlikely at 8 hex chars (32 bits) but cost
  // nothing to guard — retry a few times with a fresh code rather than
  // failing the save outright.
  let code = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomDesignCode();
    const existing = await env.DB.prepare("SELECT 1 FROM saved_designs WHERE code = ?").bind(candidate).first();
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) return json({ error: "Could not generate a code, try again" }, 500, origin);

  await env.DB.prepare(
    "INSERT INTO saved_designs (code, config, contact_name, contact_email, contact_phone, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(code, config, name, email, phone, new Date().toISOString())
    .run();

  return json({ code }, 200, origin);
}

async function handleGetDesign(request, env, origin, code) {
  await ensureSavedDesignsTable(env);
  const row = await env.DB.prepare("SELECT config FROM saved_designs WHERE code = ?").bind(code).first();
  if (!row) return json({ error: "Not found" }, 404, origin);
  let config;
  try {
    config = JSON.parse(row.config);
  } catch (e) {
    return json({ error: "Corrupt saved design" }, 500, origin);
  }
  return json({ config }, 200, origin);
}

// ============================================================================
// Potentia's own client CRM — /crm/*
//
// Separate from the /admin/* shed dashboard above in every way that matters:
// its own password, its own session scope, and — the part worth being loud
// about — its own DATABASE. Everything here reads and writes env.CRM_DB (the
// `potentia-crm` D1 database), never env.DB (`potentia-shed`, which belongs to
// the shed partner). Potentia's client list, revenue and notes are not rows in
// a client's database.
//
// That means every query below must use env.CRM_DB. A stray env.DB in this
// section would silently write Potentia's data into the shed's database, which
// is exactly what the split exists to prevent — worker/crm.test.mjs asserts the
// shed database ends up with none of these tables.
//
// Tables are created lazily on first use (same pattern as ensurePaymentsTable)
// so there's no migration to paste — worker/schema-crm.sql carries them too,
// for reference.
// ============================================================================

const CRM_STATUSES = ["lead", "contacted", "proposal", "building", "live", "paused", "lost"];
// Statuses that count as a paying client for MRR — a build in progress is
// already on its monthly plan, a paused or lost one is not.
const CRM_ACTIVE_STATUSES = ["building", "live"];
const CRM_PACKAGES = ["", "foundation", "booking", "gallery", "operator", "custom"];
const CRM_SOURCES = ["", "website", "referral", "instagram", "facebook", "google", "outreach", "repeat", "other"];
const CRM_PAYMENT_METHODS = ["cash", "check", "venmo", "zelle", "card", "stripe", "paypal", "invoice", "other"];
// What a payment was for. Keeps a $150/mo retainer from being read as another
// build fee when totalling what a client has actually paid.
const CRM_PAYMENT_KINDS = ["build", "monthly", "addon", "other"];

let crmTablesReady = false;
async function ensureCrmTables(env) {
  if (crmTablesReady) return;
  await env.CRM_DB.batch([
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT,
        contact_name TEXT,
        email TEXT,
        phone TEXT,
        website_url TEXT,
        package TEXT,
        status TEXT NOT NULL DEFAULT 'lead',
        source TEXT,
        service TEXT,
        message TEXT,
        build_fee REAL,
        monthly_fee REAL,
        domain TEXT,
        domain_renews_at TEXT,
        launched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'build',
        note TEXT,
        paid_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_min REAL,
        notes TEXT,
        called_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        due_date TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        created_at TEXT NOT NULL
      )`
    )
  ]);
  crmTablesReady = true;
}

function crmStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === "" ? null : s;
}
function crmMoney(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function crmEnum(v, allowed, fallback) {
  const s = v == null ? "" : String(v).toLowerCase().trim();
  return allowed.includes(s) ? s : fallback;
}
// Accepts a plain YYYY-MM-DD from a date input, and tolerates a full ISO
// timestamp by keeping just the date part. Anything else becomes null rather
// than a string that would sort strangely against the others.
function crmDate(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---- POST /crm/login ----
// CRM_PASSWORD only — deliberately no fall back to ADMIN_PASSWORD. The shed
// partner knows that one, and it must not open Potentia's client list. Until
// the secret is set this endpoint refuses every attempt, which is the safe
// direction to fail in: the CRM stays shut rather than quietly answering to
// the partner's password.
async function handleCrmLogin(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!env.CRM_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "CRM password not configured" }, 503, origin);
  }
  if (!timingSafeEqual(password, env.CRM_PASSWORD)) {
    return json({ error: "Invalid credentials" }, 401, origin);
  }
  const token = await signToken(env.ADMIN_SESSION_SECRET, { crm: true, exp: Date.now() + SESSION_TTL_MS });
  return json({ token }, 200, origin);
}

// ---- GET /crm/clients — the whole list plus the headline numbers ----
async function handleCrmListClients(request, env, origin) {
  await ensureCrmTables(env);
  const { results } = await env.CRM_DB.prepare(
    `SELECT c.*,
       (SELECT n.text FROM client_notes n WHERE n.client_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM client_notes n WHERE n.client_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at,
       (SELECT cl.called_at FROM client_calls cl WHERE cl.client_id = c.id ORDER BY cl.called_at DESC LIMIT 1) AS latest_call_at,
       (SELECT COUNT(*) FROM client_tasks t WHERE t.client_id = c.id AND t.done = 0) AS open_tasks,
       (SELECT MIN(t.due_date) FROM client_tasks t WHERE t.client_id = c.id AND t.done = 0 AND t.due_date IS NOT NULL) AS next_due,
       (SELECT COALESCE(SUM(p.amount), 0) FROM client_payments p WHERE p.client_id = c.id) AS collected
     FROM clients c
     ORDER BY c.updated_at DESC
     LIMIT 500`
  ).all();

  const activeList = CRM_ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");
  const mrrRow = await env.CRM_DB.prepare(
    `SELECT COALESCE(SUM(monthly_fee), 0) AS mrr, COUNT(*) AS active
     FROM clients WHERE status IN (${activeList}) AND monthly_fee IS NOT NULL`
  ).first();
  const activeRow = await env.CRM_DB.prepare(
    `SELECT COUNT(*) AS n FROM clients WHERE status IN (${activeList})`
  ).first();
  const leadRow = await env.CRM_DB.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'lead'").first();

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const collectedRow = await env.CRM_DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM client_payments WHERE paid_at >= ?"
  )
    .bind(cutoff)
    .first();

  return json(
    {
      clients: results,
      stats: {
        mrr: mrrRow ? mrrRow.mrr : 0,
        active_clients: activeRow ? activeRow.n : 0,
        open_leads: leadRow ? leadRow.n : 0,
        collected_30d: collectedRow ? collectedRow.total : 0
      }
    },
    200,
    origin
  );
}

// Field whitelist shared by create and update — anything not listed here can't
// be written from the browser, so a stray key in a POST body can't reach a
// column it has no business touching.
function crmClientFields(body) {
  return {
    business_name: crmStr(body.business_name, 160),
    contact_name: crmStr(body.contact_name, 120),
    email: crmStr(body.email, 200),
    phone: crmStr(body.phone, 40),
    website_url: crmStr(body.website_url, 300),
    package: crmEnum(body.package, CRM_PACKAGES, "") || null,
    status: crmEnum(body.status, CRM_STATUSES, "lead"),
    source: crmEnum(body.source, CRM_SOURCES, "") || null,
    service: crmStr(body.service, 120),
    message: crmStr(body.message, 5000),
    build_fee: crmMoney(body.build_fee),
    monthly_fee: crmMoney(body.monthly_fee),
    domain: crmStr(body.domain, 200),
    domain_renews_at: crmDate(body.domain_renews_at),
    launched_at: crmDate(body.launched_at)
  };
}
const CRM_CLIENT_COLUMNS = [
  "business_name", "contact_name", "email", "phone", "website_url", "package",
  "status", "source", "service", "message", "build_fee", "monthly_fee",
  "domain", "domain_renews_at", "launched_at"
];

// ---- POST /crm/clients ----
async function handleCrmCreateClient(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const f = crmClientFields(body);
  if (!f.business_name && !f.contact_name && !f.email) {
    return json({ error: "Give the client at least a name or an email" }, 400, origin);
  }
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients (${CRM_CLIENT_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES (${CRM_CLIENT_COLUMNS.map(() => "?").join(",")},?,?)`
  )
    .bind(...CRM_CLIENT_COLUMNS.map((k) => f[k]), now, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

// ---- GET /crm/clients/:id ----
async function handleCrmGetClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const client = await env.CRM_DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  if (!client) return json({ error: "Not found" }, 404, origin);

  const { results: notes } = await env.CRM_DB.prepare(
    "SELECT id, text, created_at FROM client_notes WHERE client_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();
  const { results: payments } = await env.CRM_DB.prepare(
    "SELECT id, amount, method, kind, note, paid_at, created_at FROM client_payments WHERE client_id = ? ORDER BY paid_at DESC, id DESC"
  )
    .bind(id)
    .all();
  // Open work first and by due date, because that's the order it gets done in;
  // finished items fall to the bottom as a record.
  const { results: tasks } = await env.CRM_DB.prepare(
    `SELECT id, title, due_date, done, done_at, created_at FROM client_tasks
     WHERE client_id = ?
     ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, id DESC`
  )
    .bind(id)
    .all();
  const { results: calls } = await env.CRM_DB.prepare(
    "SELECT id, direction, outcome, duration_min, notes, called_at, created_at FROM client_calls WHERE client_id = ? ORDER BY called_at DESC, id DESC"
  )
    .bind(id)
    .all();

  return json({ client, notes, payments, tasks, calls }, 200, origin);
}

// ---- POST /crm/clients/:id — update (POST, not PATCH: the CORS allow-list
// above only advertises GET/POST/DELETE) ----
async function handleCrmUpdateClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  // A status-only change (the dropdown on the list page) shouldn't have to
  // resend every other field and risk blanking them.
  if (Object.keys(body).length === 1 && typeof body.status === "string") {
    const status = crmEnum(body.status, CRM_STATUSES, null);
    if (!status) return json({ error: "Invalid status" }, 400, origin);
    await env.CRM_DB.prepare("UPDATE clients SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), id)
      .run();
    return json({ ok: true }, 200, origin);
  }

  const f = crmClientFields(body);
  await env.CRM_DB.prepare(
    `UPDATE clients SET ${CRM_CLIENT_COLUMNS.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`
  )
    .bind(...CRM_CLIENT_COLUMNS.map((k) => f[k]), new Date().toISOString(), id)
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- DELETE /crm/clients/:id — removes the client and everything hanging off
// them. The UI makes you type the client's name first.
async function handleCrmDeleteClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404, origin);
  await env.CRM_DB.batch([
    env.CRM_DB.prepare("DELETE FROM client_notes WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_payments WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_tasks WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_calls WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM clients WHERE id = ?").bind(id)
  ]);
  return json({ ok: true }, 200, origin);
}

// Every child write touches the parent's updated_at so the list page's
// "last activity" ordering reflects notes and payments, not just edits.
async function touchClient(env, id) {
  await env.CRM_DB.prepare("UPDATE clients SET updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

// ---- notes ----
async function handleCrmAddNote(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim().slice(0, 4000);
  if (!text) return json({ error: "text required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
    .bind(clientId, text, now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id, created_at: now }, 200, origin);
}
async function handleCrmDeleteNote(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_notes WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- payments ----
async function handleCrmAddPayment(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const method = crmEnum(body.method, CRM_PAYMENT_METHODS, null);
  const kind = crmEnum(body.kind, CRM_PAYMENT_KINDS, "build");
  const note = crmStr(body.note, 500);
  const paidAt = crmDate(body.paid_at) || new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "valid amount required" }, 400, origin);
  if (!method) return json({ error: "valid method required" }, 400, origin);

  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_payments (client_id, amount, method, kind, note, paid_at, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(clientId, Math.round(amount * 100) / 100, method, kind, note, paidAt, now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}
async function handleCrmDeletePayment(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_payments WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- tasks: the running list of edit requests / to-dos per client ----
async function handleCrmAddTask(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || "").trim().slice(0, 300);
  if (!title) return json({ error: "title required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_tasks (client_id, title, due_date, done, done_at, created_at) VALUES (?,?,?,0,NULL,?)"
  )
    .bind(clientId, title, crmDate(body.due_date), now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}
async function handleCrmToggleTask(request, env, origin, id) {
  await ensureCrmTables(env);
  const task = await env.CRM_DB.prepare("SELECT id, client_id, done FROM client_tasks WHERE id = ?").bind(id).first();
  if (!task) return json({ error: "Not found" }, 404, origin);
  const body = await request.json().catch(() => ({}));
  const done = typeof body.done === "boolean" ? body.done : !task.done;
  await env.CRM_DB.prepare("UPDATE client_tasks SET done = ?, done_at = ? WHERE id = ?")
    .bind(done ? 1 : 0, done ? new Date().toISOString() : null, id)
    .run();
  await touchClient(env, task.client_id);
  return json({ ok: true, done: done }, 200, origin);
}
async function handleCrmDeleteTask(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_tasks WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}


// ---- GET /crm/analytics — Potentia's own won-clients data ----
// "Won" for an agency is a signed client, so it maps to the stages where work
// is actually happening or live. Paused and lost are excluded: a paused client
// was won once but isn't revenue now, and folding them in would flatter the
// numbers.
const CRM_WON_STATUSES = ["building", "live"];

async function handleCrmAnalytics(request, env, origin) {
  await ensureCrmTables(env);
  const { results: clients } = await env.CRM_DB.prepare(
    "SELECT id, status, source, package, build_fee, monthly_fee, launched_at, created_at FROM clients LIMIT 2000"
  ).all();
  const { results: payments } = await env.CRM_DB.prepare(
    "SELECT amount, kind, paid_at FROM client_payments LIMIT 5000"
  ).all();

  const byStatus = {};
  const wonBySource = {};
  const allBySource = {};
  const wonByPackage = {};
  const wonByMonth = {};
  const buildFees = [];
  let wonCount = 0, wonBuild = 0, mrr = 0, lostCount = 0;

  for (const c of clients) {
    const status = c.status || "lead";
    byStatus[status] = (byStatus[status] || 0) + 1;
    const source = c.source || "unknown";
    allBySource[source] = (allBySource[source] || 0) + 1;
    if (status === "lost") lostCount++;

    if (CRM_WON_STATUSES.indexOf(status) !== -1) {
      wonCount++;
      wonBySource[source] = (wonBySource[source] || 0) + 1;
      if (c.package) wonByPackage[c.package] = (wonByPackage[c.package] || 0) + 1;
      if (c.build_fee != null) { wonBuild += Number(c.build_fee); buildFees.push(Number(c.build_fee)); }
      if (c.monthly_fee != null) mrr += Number(c.monthly_fee);
      // Launch date is the closest thing to a "won on" date the CRM records.
      // Clients still building have none yet, so they are counted but not
      // placed on the timeline rather than being dated by their signup.
      if (c.launched_at) {
        const m = String(c.launched_at).slice(0, 7);
        wonByMonth[m] = (wonByMonth[m] || 0) + 1;
      }
    }
  }

  let collected = 0, collectedBuild = 0, collectedMonthly = 0;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let collected30 = 0;
  for (const p of payments) {
    const amt = Number(p.amount || 0);
    collected += amt;
    if (p.kind === "monthly") collectedMonthly += amt;
    if (p.kind === "build") collectedBuild += amt;
    if (String(p.paid_at || "") >= cutoff) collected30 += amt;
  }

  buildFees.sort((a, b) => a - b);
  const decided = wonCount + lostCount;

  return json(
    {
      totalClients: clients.length,
      byStatus,
      won: {
        count: wonCount,
        buildRevenue: Math.round(wonBuild),
        mrr: Math.round(mrr),
        // What the retainers are worth over a year, alongside the one-time
        // build work. The two are different kinds of money and are kept apart.
        annualisedRecurring: Math.round(mrr * 12),
        avgBuildFee: buildFees.length ? Math.round(wonBuild / buildFees.length) : null,
        medianBuildFee: buildFees.length ? buildFees[Math.floor(buildFees.length / 2)] : null,
        winRatePct: decided ? Math.round((wonCount / decided) * 1000) / 10 : null,
        decided,
        lostCount,
        bySource: wonBySource,
        allBySource,
        byPackage: wonByPackage,
        byMonth: wonByMonth,
        // Build fee agreed vs build money actually in the bank.
        buildOutstanding: Math.round(Math.max(0, wonBuild - collectedBuild))
      },
      collected: {
        allTime: Math.round(collected),
        build: Math.round(collectedBuild),
        monthly: Math.round(collectedMonthly),
        last30: Math.round(collected30)
      }
    },
    200,
    origin
  );
}

// ---- client call log ----
// Same shape as the shed side's calls table, logged by hand for the same
// reason: what was said and what happens next is the part worth keeping, and
// no phone system knows it.
async function handleCrmAddCall(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const direction = crmEnum(body.direction, CALL_DIRECTIONS, null);
  const outcome = crmEnum(body.outcome, CALL_OUTCOMES, null);
  if (!direction) return json({ error: "valid direction required" }, 400, origin);
  if (!outcome) return json({ error: "valid outcome required" }, 400, origin);

  const durationRaw = Number(body.duration_min);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 600) : null;
  const notes = crmStr(body.notes, 2000);
  const calledAt = body.called_at ? String(body.called_at).slice(0, 40) : new Date().toISOString();

  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_calls (client_id, direction, outcome, duration_min, notes, called_at, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(clientId, direction, outcome, duration, notes, calledAt, now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleCrmDeleteCall(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_calls WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- POST /crm/lead — public. The contact form posts here alongside its
// existing Formspree submit, so an inquiry becomes a CRM lead on its own.
// An inquiry from someone already in the CRM is logged as a note on their
// record instead of creating a second one.
async function handleCrmLead(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const name = crmStr(body.name, 120);
  const email = crmStr(body.email, 200);
  const phone = crmStr(body.phone, 40);
  const service = crmStr(body.service, 120);
  const message = crmStr(body.message, 5000);
  if (!email && !phone) return json({ error: "email or phone required" }, 400, origin);

  const now = new Date().toISOString();
  let existing = null;
  if (email) existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE email = ? LIMIT 1").bind(email).first();
  if (!existing && phone) {
    existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE phone = ? LIMIT 1").bind(phone).first();
  }

  if (existing) {
    const parts = ["New website inquiry"];
    if (service) parts.push("Interested in: " + service);
    if (message) parts.push(message);
    await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
      .bind(existing.id, parts.join(" — "), now)
      .run();
    await touchClient(env, existing.id);
    return json({ ok: true, id: existing.id, existing: true }, 200, origin);
  }

  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients (business_name, contact_name, email, phone, status, source, service, message, created_at, updated_at)
     VALUES (?,?,?,?,'lead','website',?,?,?,?)`
  )
    .bind(name, name, email, phone, service, message, now, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (path === "/chat" && request.method === "POST") {
        return await handleChat(request, env, origin);
      }

      if (path === "/admin/login" && request.method === "POST") {
        return await handleAdminLogin(request, env, origin);
      }

      if (path === "/admin/customers" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleListCustomers(request, env, origin);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/notes") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/notes".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddNote(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/followup") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/followup".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetFollowUp(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/calls") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/calls".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddCall(request, env, origin, id);
      }
      if (path.startsWith("/admin/calls/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/calls/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteCall(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/payments") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/payments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddPayment(request, env, origin, id);
      }
      if (path.startsWith("/admin/payments/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/payments/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeletePayment(request, env, origin, id);
      }
      if (path.startsWith("/admin/submissions/") && path.endsWith("/installs") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/installs".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddInstall(request, env, origin, id);
      }
      if (path.startsWith("/admin/installs/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/installs/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteInstall(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetCustomer(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteCustomer(request, env, origin, id);
      }

      if (path.startsWith("/admin/submissions/") && path.endsWith("/adjustments") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/adjustments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetAdjustments(request, env, origin, id);
      }
      if (path.startsWith("/admin/submissions/") && path.endsWith("/adjustment") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/adjustment".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetAdjustment(request, env, origin, id);
      }
      if (path === "/admin/submissions/status" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleUpdateSubmissionStatus(request, env, origin);
      }
      if (path === "/admin/submissions/cleanup-superseded" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCleanupSuperseded(request, env, origin);
      }
      if (path === "/admin/submissions/regeocode" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleRegeocodeSubmissions(request, env, origin);
      }
      if (path === "/admin/submissions/backfill-redline" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleBackfillQuoteRedline(request, env, origin);
      }
      if (path.startsWith("/admin/submissions/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetSubmission(request, env, origin, id);
      }

      if (path === "/admin/analytics" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleAnalytics(request, env, origin);
      }

      if (path === "/admin/pricing" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleListPricing(request, env, origin);
      }
      if (path === "/admin/pricing" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleUpsertPricing(request, env, origin);
      }
      if (path.startsWith("/admin/pricing/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/pricing/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeletePricing(request, env, origin, id);
      }

      // ---- Potentia client CRM ----
      // Every CRM route but login needs the CRM's own database. Failing here
      // with a clear message beats a confusing "no such table" from D1 if the
      // binding was missed during setup.
      if (path.startsWith("/crm/") && path !== "/crm/login" && !env.CRM_DB) {
        return json({ error: "CRM database not connected" }, 503, origin);
      }
      if (path === "/crm/login" && request.method === "POST") {
        return await handleCrmLogin(request, env, origin);
      }
      if (path === "/crm/lead" && request.method === "POST") {
        return await handleCrmLead(request, env, origin);
      }
      if (path === "/crm/analytics" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmAnalytics(request, env, origin);
      }
      if (path === "/crm/clients" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmListClients(request, env, origin);
      }
      if (path === "/crm/clients" && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmCreateClient(request, env, origin);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/notes") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/notes".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddNote(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/payments") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/payments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddPayment(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/calls") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/calls".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddCall(request, env, origin, id);
      }
      if (path.startsWith("/crm/calls/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/calls/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteCall(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/tasks") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/tasks".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddTask(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmGetClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmUpdateClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/notes/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/notes/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteNote(request, env, origin, id);
      }
      if (path.startsWith("/crm/payments/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/payments/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeletePayment(request, env, origin, id);
      }
      if (path.startsWith("/crm/tasks/") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/tasks/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmToggleTask(request, env, origin, id);
      }
      if (path.startsWith("/crm/tasks/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/tasks/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteTask(request, env, origin, id);
      }

      if (path === "/shed/pricing" && request.method === "GET") {
        return await handlePublicPricing(request, env, origin);
      }
      if (path === "/shed/submit" && request.method === "POST") {
        return await handleShedSubmit(request, env, origin);
      }
      if (path === "/shed/pricing-config" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleGetPricingConfig(request, env, origin);
      }
      if (path === "/shed/pricing-config" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleSavePricingConfig(request, env, origin);
      }
      if (path === "/shed/quote" && request.method === "POST") {
        return await handleShedQuote(request, env, origin);
      }
      if (path === "/shed/design" && request.method === "POST") {
        return await handleSaveDesign(request, env, origin);
      }
      if (path.startsWith("/shed/design/") && request.method === "GET") {
        const code = path.slice("/shed/design/".length);
        if (!code) return json({ error: "Invalid code" }, 400, origin);
        return await handleGetDesign(request, env, origin, code);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Server error", detail: String(e) }, 500, origin);
    }
  }
};
