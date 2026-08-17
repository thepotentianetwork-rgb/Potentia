// Potentia backend Worker — serves two things from one place:
//  1. /chat            — the AI assistant widget (assistant.js)
//  2. /admin/*          — password-gated dashboard for the shed company
//                         partner: view submissions, edit pricing
//     /shed/pricing     — public: current pricing (for their site to read)
//     /shed/submit      — public: customer design submissions land here
//
// See README.md for full deployment steps (secrets, D1 database, etc).

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
       (SELECT COUNT(*) FROM submissions s WHERE s.customer_id = c.id) AS submission_count,
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

// ---- /admin/customers/:id: full detail — customer + all their submissions + notes ----
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

  return json({ customer, submissions, notes }, 200, origin);
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

// ---- /admin/submissions/:id: single order, for the quote document ----
async function handleGetSubmission(request, env, origin, id) {
  const submission = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!submission) return json({ error: "Not found" }, 404, origin);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(submission.customer_id).first();
  return json({ submission, customer: customer || null }, 200, origin);
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

async function handleShedSubmit(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  // Accepts either the designer tool's shape ({contact:{...}, config, permalink,
  // quotedPrice, redline, page}) or a plain {name, email, phone, details} shape.
  const contact = body.contact || {};
  const name = String(contact.name || body.name || "").slice(0, 200);
  const email = String(contact.email || body.email || "").slice(0, 200);
  const phone = String(contact.phone || body.phone || "").slice(0, 60);
  if (!name || !email) return json({ error: "name and email required" }, 400, origin);

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
          quotedPrice: body.quotedPrice != null ? body.quotedPrice : null,
          redline: body.redline || null, // internal cost/margin breakdown — admin dashboard only, never public
          page: body.page || null
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

  await env.DB.prepare("INSERT INTO submissions (customer_id, name, email, phone, details, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(customerId, name, email, phone, details, "new", new Date().toISOString())
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/pricing-config: the designer's full pricing engine snapshot ----
// GET is public (every visitor's designer loads live prices on boot).
// POST is admin-only (this is what the designer's own #admin screen saves).
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
      if (path.startsWith("/admin/customers/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetCustomer(request, env, origin, id);
      }

      if (path === "/admin/submissions/status" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleUpdateSubmissionStatus(request, env, origin);
      }
      if (path.startsWith("/admin/submissions/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetSubmission(request, env, origin, id);
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
        return await handleGetPricingConfig(request, env, origin);
      }
      if (path === "/shed/pricing-config" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleSavePricingConfig(request, env, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Server error", detail: String(e) }, 500, origin);
    }
  }
};
