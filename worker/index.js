// Potentia backend Worker — serves two things from one place:
//  1. /chat            — the AI assistant widget (assistant.js)
//  2. /admin/*          — password-gated dashboard for the shed company
//                         partner: view submissions, edit pricing
//     /shed/pricing     — public: current pricing (for their site to read)
//     /shed/submit      — public: customer design submissions land here
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
async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return await verifyToken(env.ADMIN_SESSION_SECRET, token);
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

// ---- /admin/customers: one row per customer, with their latest order + note ----
async function handleListCustomers(request, env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.city, c.state, c.created_at, c.updated_at,
       (SELECT s.id FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_id,
       (SELECT s.details FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_details,
       (SELECT s.status FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_status,
       (SELECT s.created_at FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_at,
       (SELECT COUNT(*) FROM submissions s WHERE s.customer_id = c.id AND s.status != 'superseded') AS submission_count,
       (SELECT n.text FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at
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
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  const { results: submissions } = await env.DB.prepare(
    "SELECT id, details, status, created_at FROM submissions WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

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

  return json({ customer, submissions, notes, payments, installs }, 200, origin);
}

// ---- DELETE /admin/customers/:id — permanently removes the customer and
// every submission/note/payment tied to them. No soft-delete: the admin UI
// requires typing the customer's name plus a second confirm before this
// ever fires.
async function handleDeleteCustomer(request, env, origin, id) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensurePaymentsTable(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE customer_id = ?").bind(id),
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
  const submission = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!submission) return json({ error: "Not found" }, 404, origin);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(submission.customer_id).first();
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

async function handleUpdateSubmissionStatus(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status || "").slice(0, 40);
  if (!id || !status) return json({ error: "id and status required" }, 400, origin);
  await env.DB.prepare("UPDATE submissions SET status = ? WHERE id = ?").bind(status, id).run();
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
  const { results } = await env.DB.prepare(
    "SELECT customer_id, details, status, created_at FROM submissions ORDER BY created_at DESC LIMIT 3000"
  ).all();

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
      const price = d.quotedPrice != null ? Number(d.quotedPrice) : null;
      if (price != null && isFinite(price)) prices.push(price);
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

  return json(
    {
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
const SHED_ELEC = ["none", "basic", "standard", "core", "essential"];
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

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Server error", detail: String(e) }, 500, origin);
    }
  }
};
