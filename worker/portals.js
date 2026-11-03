/* ROLE PORTALS — sales, builder, customer on the live ShedPro CRM data.
 *
 * Owner/admin is untouched: the ADMIN_PASSWORD login still mints an "admin"
 * session that sees everything. These add one more session area, "portal",
 * whose signed payload carries the role and user id. Accounts live in D1
 * (portal_users) with PBKDF2-hashed passwords; no plaintext is stored, and a
 * password is shown exactly once, to the owner, when the account is made.
 *
 *  sales    -> may use an ALLOW-LIST of /admin/* routes (leads, calls, notes,
 *              status, designs, shop/install dates) plus assign-builder. Money
 *              routes (payments, invoices, pricing, dashboard) answer 403.
 *  builder  -> /portal/builder/*: only jobs assigned to them; clock in/out,
 *              expense photos, notes, install-date changes / delays.
 *  customer -> /portal/customer/*: only their own won order, and only once a
 *              deposit is on it. Agreement, progress, warranties. Nothing else.
 */

export const PORTAL_ROLES = ["sales", "builder", "customer"];

// ---- password hashing (PBKDF2-SHA256, 100k) ----
const ITER = 100000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}
export async function checkPassword(password, stored) {
  const [k, it, s, h] = String(stored || "").split("$");
  if (k !== "pbkdf2" || !h) return false;
  const got = b64(await pbkdf2(password, unb64(s), Number(it)));
  let d = got.length ^ h.length;
  for (let i = 0; i < Math.min(got.length, h.length); i++) d |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return d === 0;
}
export function generatePassword() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => a[x % a.length]).join("");
}

// ---- tables (lazy, additive only) ----
const ensured = new WeakSet();
export async function ensurePortalTables(env) {
  if (ensured.has(env.DB)) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS portal_users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL,
       login TEXT NOT NULL UNIQUE, name TEXT, pass_hash TEXT NOT NULL, customer_id INTEGER,
       disabled_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS job_assignments (submission_id INTEGER PRIMARY KEY, builder_id INTEGER NOT NULL,
       assigned_at TEXT NOT NULL, assigned_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL,
       builder_id INTEGER NOT NULL, clock_in TEXT NOT NULL, clock_out TEXT)`,
    `CREATE TABLE IF NOT EXISTS job_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL,
       builder_id INTEGER NOT NULL, amount REAL, note TEXT, photo TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS job_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL,
       author TEXT, role TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL)`
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  /* Additive: auto-created customer logins. needs_password=1 means nobody has
     seen this account's password yet — the owner presses Reset in Team logins
     to get one (shown once). No plaintext password is ever stored. */
  for (const c of ["needs_password INTEGER", "auto_created_at TEXT"]) {
    try { await env.DB.prepare("ALTER TABLE portal_users ADD COLUMN " + c).run(); } catch (e) {}
  }
  ensured.add(env.DB);
}

// ---- what sales may touch on /admin/* ----
const N = "\\d+";
const SALES_ALLOW = [
  ["GET", `^/admin/customers$`], ["GET", `^/admin/customers/${N}$`], ["GET", `^/admin/customers/${N}/note-edits$`],
  ["GET", `^/admin/submissions/${N}$`], ["GET", `^/admin/submissions/${N}/design-status$`],
  ["GET", `^/admin/schedule$`], ["GET", `^/admin/activity$`],
  ["POST", `^/admin/customers/${N}/(notes|followup|calls)$`], ["POST", `^/admin/notes/${N}$`],
  ["POST", `^/admin/submissions/${N}/(customer-notes|design|colors|choose|track-link|installs|plan|schedule-message)$`],
  ["POST", `^/admin/submissions/(status|lost-reason)$`], ["POST", `^/admin/installs/${N}/done$`],
  ["DELETE", `^/admin/installs/${N}$`]
].map(([m, r]) => [m, new RegExp(r)]);
export function salesMayUse(method, path) {
  return SALES_ALLOW.some(([m, r]) => m === method && r.test(path));
}

/* deps: { json, issueSession, verifySession, revokeSession, bearerToken, requireAdmin, orderHasDeposit, trackPayload } */
export async function handlePortal(request, env, origin, path, deps) {
  const { json } = deps;
  const method = request.method;
  const now = () => new Date().toISOString();
  const body = async () => { try { return await request.json(); } catch (e) { return {}; } };
  await ensurePortalTables(env);

  // ---------- login / logout / me ----------
  if (path === "/portal/login" && method === "POST") {
    const b = await body();
    const login = String(b.login || "").trim().toLowerCase();
    const u = login && await env.DB.prepare("SELECT * FROM portal_users WHERE login = ? AND disabled_at IS NULL").bind(login).first();
    if (!u || !(await checkPassword(String(b.password || ""), u.pass_hash))) return json({ error: "Invalid credentials" }, 401, origin);
    /* Customers and the team sign in on separate pages. "team" (portal-login)
       refuses customer accounts; "customer" (portal-customer-login) refuses
       everyone else. Same 401 so the page reveals nothing about the account. */
    const page = String(b.portal || "");
    if (page === "team" && u.role === "customer") return json({ error: "Invalid credentials" }, 401, origin);
    if (page === "customer" && u.role !== "customer") return json({ error: "Invalid credentials" }, 401, origin);
    if (u.role === "customer" && !(await customerSub(env, u, deps))) return json({ error: "Your portal opens once your deposit is in." }, 403, origin);
    const token = await deps.issueSession(env, "portal", { role: u.role, uid: u.id, name: u.name || "" });
    if (!token) return json({ error: "Server not configured" }, 500, origin);
    return json({ token, role: u.role, name: u.name || "" }, 200, origin);
  }
  if (path === "/portal/logout" && method === "POST") {
    return json({ ok: true, revoked: await deps.revokeSession(env, "portal", deps.bearerToken(request)) }, 200, origin);
  }

  // ---------- owner: manage accounts ----------
  if (path === "/portal/users") {
    if (!(await deps.requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, origin);
    if (method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, role, login, name, customer_id, disabled_at, created_at, needs_password, auto_created_at FROM portal_users ORDER BY id").all();
      return json({ users: results || [] }, 200, origin);
    }
    if (method === "POST") {
      const b = await body();
      const role = String(b.role || "");
      const login = String(b.login || "").trim().toLowerCase();
      if (!PORTAL_ROLES.includes(role) || !/^[a-z0-9._@+-]{3,80}$/.test(login)) return json({ error: "role and login required" }, 400, origin);
      let customerId = null;
      if (role === "customer") {
        customerId = Number(b.customer_id) || null;
        const c = customerId && await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
        if (!c) return json({ error: "customer_id required" }, 400, origin);
        const u = { customer_id: customerId };
        if (!(await customerSub(env, u, deps))) return json({ error: "No won order with a deposit yet" }, 409, origin);
      }
      const password = generatePassword();
      try {
        await env.DB.prepare("INSERT INTO portal_users (role, login, name, pass_hash, customer_id, created_at) VALUES (?,?,?,?,?,?)")
          .bind(role, login, String(b.name || "").slice(0, 80), await hashPassword(password), customerId, now()).run();
      } catch (e) { return json({ error: "Login already exists" }, 409, origin); }
      /* The ONLY time the password exists in the clear. */
      return json({ ok: true, role, login, password }, 200, origin);
    }
  }
  if (path === "/portal/users/auto-sweep" && method === "POST") {
    if (!(await deps.requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, origin);
    return json({ ok: true, ...(await autoCustomerLoginSweep(env, deps)) }, 200, origin);
  }
  const um = path.match(/^\/portal\/users\/(\d+)\/(reset|disable)$/);
  if (um && method === "POST") {
    if (!(await deps.requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, origin);
    if (um[2] === "disable") {
      await env.DB.prepare("UPDATE portal_users SET disabled_at = ? WHERE id = ?").bind(now(), Number(um[1])).run();
      return json({ ok: true }, 200, origin);
    }
    const password = generatePassword();
    await env.DB.prepare("UPDATE portal_users SET pass_hash = ?, disabled_at = NULL, needs_password = NULL WHERE id = ?").bind(await hashPassword(password), Number(um[1])).run();
    return json({ ok: true, password }, 200, origin);
  }

  // everything below needs a portal session (or admin for assign/builders)
  const sess = await deps.verifySession(env, "portal", deps.bearerToken(request));
  const isAdmin = !sess && await deps.requireAdmin(request, env);
  if (!sess && !isAdmin) return json({ error: "Unauthorized" }, 401, origin);
  const role = sess ? sess.role : "admin";

  if (path === "/portal/me" && method === "GET") return json({ role, name: sess ? sess.name : "Owner" }, 200, origin);

  // ---------- sales/admin: builders list + assign ----------
  if (path === "/portal/builders" && method === "GET" && (role === "sales" || isAdmin)) {
    const { results } = await env.DB.prepare("SELECT id, name, login FROM portal_users WHERE role='builder' AND disabled_at IS NULL ORDER BY name").all();
    return json({ builders: results || [] }, 200, origin);
  }
  const am = path.match(/^\/portal\/jobs\/(\d+)\/assign$/);
  if (am && (role === "sales" || isAdmin)) {
    const sid = Number(am[1]);
    if (method === "GET") {
      const a = await env.DB.prepare("SELECT j.builder_id, u.name FROM job_assignments j LEFT JOIN portal_users u ON u.id=j.builder_id WHERE submission_id=?").bind(sid).first();
      return json({ assignment: a || null }, 200, origin);
    }
    if (method === "POST") {
      const b = await body();
      const sub = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?").bind(sid).first();
      if (!sub || sub.status !== "won") return json({ error: "Mark the order Won first" }, 409, origin);
      if (b.builder_id == null) { await env.DB.prepare("DELETE FROM job_assignments WHERE submission_id=?").bind(sid).run(); return json({ ok: true }, 200, origin); }
      const bu = await env.DB.prepare("SELECT id FROM portal_users WHERE id=? AND role='builder' AND disabled_at IS NULL").bind(Number(b.builder_id)).first();
      if (!bu) return json({ error: "Unknown builder" }, 400, origin);
      await env.DB.prepare("INSERT INTO job_assignments (submission_id, builder_id, assigned_at, assigned_by) VALUES (?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET builder_id=excluded.builder_id, assigned_at=excluded.assigned_at, assigned_by=excluded.assigned_by")
        .bind(sid, bu.id, now(), sess ? sess.name || "sales" : "owner").run();
      return json({ ok: true }, 200, origin);
    }
  }

  // ---------- builder ----------
  if (path.startsWith("/portal/builder/")) {
    if (role !== "builder") return json({ error: "Forbidden" }, 403, origin);
    const uid = sess.uid;
    if (path === "/portal/builder/jobs" && method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT s.id, s.details, c.name AS customer_name, c.address, c.city, c.phone
         FROM job_assignments j JOIN submissions s ON s.id=j.submission_id JOIN customers c ON c.id=s.customer_id
         WHERE j.builder_id=? AND s.status='won' ORDER BY s.id DESC`).bind(uid).all();
      const jobs = [];
      for (const r of results || []) {
        let d = {}; try { d = JSON.parse(r.details) || {}; } catch (e) {}
        const inst = (await env.DB.prepare("SELECT id, item, install_date, days, note, done_at FROM installs WHERE submission_id=? ORDER BY install_date").bind(r.id).all()).results || [];
        const open = await env.DB.prepare("SELECT id, clock_in FROM time_entries WHERE submission_id=? AND builder_id=? AND clock_out IS NULL").bind(r.id, uid).first();
        const notes = (await env.DB.prepare("SELECT id, author, role, text, created_at FROM job_notes WHERE submission_id=? ORDER BY id DESC LIMIT 20").bind(r.id).all()).results || [];
        const exps = (await env.DB.prepare("SELECT id, amount, note, created_at, photo IS NOT NULL AS has_photo FROM job_expenses WHERE submission_id=? AND builder_id=? ORDER BY id DESC").bind(r.id, uid).all()).results || [];
        /* Build info only: NO price, redline cost, payments or pipeline. */
        jobs.push({ id: r.id, customer: r.customer_name, address: [r.address, r.city].filter(Boolean).join(", "), phone: r.phone,
          summary: deps.configSummary ? deps.configSummary(d.config) : "", spec: deps.buildSpecLines ? deps.buildSpecLines(d.config) : [],
          design_url: deps.designLinkFor ? deps.designLinkFor(d) : null, installs: inst, clocked_in: open || null, notes, expenses: exps });
      }
      return json({ jobs }, 200, origin);
    }
    /* The quote / shop order the CRM opens (quote.html), for an assigned won job only. */
    const qm = path.match(/^\/portal\/builder\/jobs\/(\d+)\/quote$/);
    if (qm && method === "GET") {
      const sid = Number(qm[1]);
      const mine = await env.DB.prepare("SELECT 1 AS ok FROM job_assignments j JOIN submissions s ON s.id=j.submission_id WHERE j.submission_id=? AND j.builder_id=? AND s.status='won'").bind(sid, uid).first();
      if (!mine) return json({ error: "Not your job" }, 403, origin);
      if (!deps.getSubmission) return json({ error: "Not available" }, 501, origin);
      return deps.getSubmission(request, env, origin, sid);
    }
    const jm = path.match(/^\/portal\/builder\/jobs\/(\d+)\/(clock|expenses|notes|dates|undelay)$/);
    if (jm && method === "POST") {
      const sid = Number(jm[1]);
      const mine = await env.DB.prepare("SELECT 1 AS ok FROM job_assignments j JOIN submissions s ON s.id=j.submission_id WHERE j.submission_id=? AND j.builder_id=? AND s.status='won'").bind(sid, uid).first();
      if (!mine) return json({ error: "Not your job" }, 403, origin);
      const b = await body();
      if (jm[2] === "clock") {
        const open = await env.DB.prepare("SELECT id FROM time_entries WHERE builder_id=? AND clock_out IS NULL").bind(uid).first();
        if (open) { await env.DB.prepare("UPDATE time_entries SET clock_out=? WHERE id=?").bind(now(), open.id).run(); return json({ ok: true, clocked: "out" }, 200, origin); }
        await env.DB.prepare("INSERT INTO time_entries (submission_id, builder_id, clock_in) VALUES (?,?,?)").bind(sid, uid, now()).run();
        return json({ ok: true, clocked: "in" }, 200, origin);
      }
      if (jm[2] === "expenses") {
        const photo = typeof b.photo === "string" && /^data:image\/(jpeg|png|webp|heic);base64,/.test(b.photo) && b.photo.length < 1500000 ? b.photo : null;
        if (!photo && !(Number(b.amount) > 0)) return json({ error: "Photo or amount required" }, 400, origin);
        await env.DB.prepare("INSERT INTO job_expenses (submission_id, builder_id, amount, note, photo, created_at) VALUES (?,?,?,?,?,?)")
          .bind(sid, uid, Number(b.amount) || null, String(b.note || "").slice(0, 500), photo, now()).run();
        return json({ ok: true }, 200, origin);
      }
      if (jm[2] === "notes") {
        const t = String(b.text || "").trim().slice(0, 2000);
        if (!t) return json({ error: "Empty note" }, 400, origin);
        await env.DB.prepare("INSERT INTO job_notes (submission_id, author, role, text, created_at) VALUES (?,?,?,?,?)").bind(sid, sess.name || "builder", "builder", t, now()).run();
        return json({ ok: true }, 200, origin);
      }
      if (jm[2] === "undelay") {
        // Remove a delay logged with "dates" (a job note "<item>: delay[ — reason]"). Only delay notes on this job.
        const n = await env.DB.prepare("SELECT id, text FROM job_notes WHERE id=? AND submission_id=?").bind(Number(b.note_id), sid).first();
        if (!n || !isDelayNote(n.text)) return json({ error: "Not a delay on this job" }, 400, origin);
        await env.DB.prepare("DELETE FROM job_notes WHERE id=?").bind(n.id).run();
        await env.DB.prepare("INSERT INTO job_notes (submission_id, author, role, text, created_at) VALUES (?,?,?,?,?)").bind(sid, sess.name || "builder", "builder", "Delay cleared: " + String(n.text).slice(0, 300), now()).run();
        return json({ ok: true }, 200, origin);
      }
      if (jm[2] === "dates") {
        // Move a shop/install date, or log a delay against it — the owner sees it in the schedule + job notes.
        const inst = await env.DB.prepare("SELECT id, item, install_date FROM installs WHERE id=? AND submission_id=?").bind(Number(b.install_id), sid).first();
        if (!inst) return json({ error: "Unknown install" }, 400, origin);
        if (b.date && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return json({ error: "Bad date" }, 400, origin);
        if (b.date) await env.DB.prepare("UPDATE installs SET install_date=? WHERE id=?").bind(b.date, inst.id).run();
        const msg = `${inst.item}: ${b.date ? `moved ${inst.install_date} → ${b.date}` : "delay"}${b.reason ? " — " + String(b.reason).slice(0, 300) : ""}`;
        await env.DB.prepare("INSERT INTO job_notes (submission_id, author, role, text, created_at) VALUES (?,?,?,?,?)").bind(sid, sess.name || "builder", "builder", msg, now()).run();
        return json({ ok: true }, 200, origin);
      }
    }
    return json({ error: "Not found" }, 404, origin);
  }

  // ---------- customer ----------
  if (path === "/portal/customer/order" && method === "GET") {
    if (role !== "customer") return json({ error: "Forbidden" }, 403, origin);
    const u = await env.DB.prepare("SELECT * FROM portal_users WHERE id=? AND disabled_at IS NULL").bind(sess.uid).first();
    const sub = u && await customerSub(env, u, deps);
    if (!sub) return json({ error: "Your portal opens once your deposit is in." }, 403, origin);
    const data = await deps.trackPayload(env, sub.id);
    return json({ ...data, warranties: WARRANTIES }, 200, origin);
  }

  return json({ error: "Not found" }, 404, origin);
}

/* The customer's newest won order that has a deposit, or null. */
/* AUTO CUSTOMER LOGIN — once a customer has a Won order with a deposit on it,
   make their portal login (email = username, linked to customer_id) so the
   owner does not have to. Idempotent: an existing login for this customer or
   this email is left alone. The password is random and never revealed here;
   the account is flagged needs_password and Team logins shows "Reset to get
   password" — Reset is the one place a password is shown, once.
   Returns { created, id, reason }. Never throws. */
export async function autoCustomerLogin(env, customerId, deps, opts = {}) {
  try {
    customerId = Number(customerId);
    if (!customerId || !env.DB) return { created: false, reason: "no customer" };
    await ensurePortalTables(env);
    const c = await env.DB.prepare("SELECT id, name, email FROM customers WHERE id = ?").bind(customerId).first();
    if (!c) return { created: false, reason: "no such customer" };
    const login = String(c.email || "").trim().toLowerCase();
    if (!/^[a-z0-9._@+-]{3,80}$/.test(login) || login.indexOf("@") < 1) return { created: false, reason: "no usable email" };
    const have = await env.DB.prepare("SELECT id, role, customer_id FROM portal_users WHERE customer_id = ? OR login = ?").bind(customerId, login).first();
    if (have) return { created: false, id: have.id, reason: have.customer_id === customerId ? "exists" : "login taken" };
    if (!opts.force && !(await customerSub(env, { customer_id: customerId }, deps))) return { created: false, reason: "no won order with a deposit" };
    const now = new Date().toISOString();
    try {
      const r = await env.DB.prepare("INSERT INTO portal_users (role, login, name, pass_hash, customer_id, created_at, needs_password, auto_created_at) VALUES ('customer',?,?,?,?,?,1,?)")
        .bind(login, String(c.name || "").slice(0, 80), await hashPassword(generatePassword()), customerId, now, now).run();
      return { created: true, id: r.meta && r.meta.last_row_id, login };
    } catch (e) { return { created: false, reason: "exists" }; }
  } catch (e) { return { created: false, reason: "error: " + (e && e.message) }; }
}
/* Safety net for missed events (hourly cron + Team logins button): every
   customer with a Won order and no portal login yet. */
export async function autoCustomerLoginSweep(env, deps) {
  await ensurePortalTables(env);
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT s.customer_id AS cid FROM submissions s WHERE s.status='won' AND s.customer_id IS NOT NULL AND s.customer_id NOT IN (SELECT customer_id FROM portal_users WHERE customer_id IS NOT NULL)"
  ).all();
  const created = [];
  for (const r of results || []) {
    const out = await autoCustomerLogin(env, r.cid, deps);
    if (out.created) created.push({ customer_id: r.cid, login: out.login });
  }
  return { checked: (results || []).length, created };
}

async function customerSub(env, u, deps) {
  const { results } = await env.DB.prepare("SELECT id, customer_id FROM submissions WHERE customer_id=? AND status='won' ORDER BY id DESC").bind(u.customer_id).all();
  for (const s of results || []) if (await deps.orderHasDeposit(env, s)) return s;
  return null;
}

/* Placeholder wording — Nando to confirm the real warranty terms before launch. */
export const WARRANTIES = [
  { item: "Workmanship", term: "Shed Pro workmanship warranty (terms to be confirmed by Shed Pro)" },
  { item: "Manufacturer materials", term: "Siding, roofing, doors and windows carry their manufacturers' warranties" }
];

/* A delay logged by the builder portal's "dates" action with no new date. */
export function isDelayNote(text) { return /^[\w ]+: delay( — |$)/.test(String(text || "")); }
