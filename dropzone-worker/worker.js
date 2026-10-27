// Drop Zone API (Potentia Network CRM + website change requests). Served under
// https://www.potentianetwork.com/dropzone/api/* via Vercel rewrite.
// Approve/reject changes status ONLY — no code edits, deploys or CRM/site writes.
const MAX = 5 * 1024 * 1024, MAX_FILES = 8;
const J = (c, o) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sniff = b => (b[0]==0x89&&b[1]==0x50&&b[2]==0x4e&&b[3]==0x47) ? "png" : (b[0]==0xff&&b[1]==0xd8&&b[2]==0xff) ? "jpg"
  : (String.fromCharCode(...b.slice(0,4))=="RIFF"&&String.fromCharCode(...b.slice(8,12))=="WEBP") ? "webp" : null;
async function eq(a, b) { const e = new TextEncoder(); const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", e.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0; }
const authed = (req, env) => eq(req.headers.get("x-review-password") || "", env.REVIEW_PASSWORD || crypto.randomUUID());
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
// WEBHOOK_SECRET (optional) is sent as "Authorization: Bearer <key>", or in the
// header named by WEBHOOK_HEADER if that var is set (raw value, no Bearer).
async function notify(env, body) {
  const h = { "content-type": "application/json" };
  if (env.WEBHOOK_SECRET) { if (env.WEBHOOK_HEADER) h[env.WEBHOOK_HEADER] = env.WEBHOOK_SECRET; else h.authorization = "Bearer " + env.WEBHOOK_SECRET; }
  try { const r = await fetch(env.WEBHOOK_URL, { method: "POST", headers: h, body: JSON.stringify(body) }); if (!r.ok) console.error("webhook", r.status); }
  catch (e) { console.error("webhook failed", e); }
}
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url); const p = u.pathname.replace(/^\/dropzone/, "");
    try {
      let m = /^\/uploads\/([\w-]+\.(png|jpg|webp))$/.exec(p);
      if (m && req.method == "GET") { const o = await env.SHOTS.get(m[1]); if (!o) return new Response("not found", { status: 404 });
        return new Response(o.body, { headers: { "content-type": TYPES[m[2]], "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } }); }
      if ((p == "/api/feedback" || p == "/api/submit") && req.method == "POST") {
        const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
        const n = (await env.DB.prepare("SELECT COUNT(*) c FROM feedback WHERE ip=? AND created_at > ?").bind(ip, new Date(Date.now() - 3600e3).toISOString()).first()).c;
        if (n >= 10) return J(429, { error: "Too many submissions — please try again in an hour." });
        if (Number(req.headers.get("content-length") || 0) > MAX * MAX_FILES + 65536) return J(413, { error: "Too much data — up to 8 images, 5MB each" });
        let fd; try { fd = await req.formData(); } catch { return J(400, { error: "Expected multipart/form-data" }); }
        const g = k => (typeof fd.get(k) == "string" ? fd.get(k) : "").trim();
        // Customer gate (t1171u): shared customer password on EVERY submission
        // (source=crm is just a form field, so gating only "website" would be bypassable).
        if (!(await eq(g("access"), env.CUSTOMER_PASSWORD || crypto.randomUUID()))) return J(401, { error: "Wrong access password." });
        const business = g("business").slice(0, 200);
        if (!business) return J(400, { error: "Please enter your business name." });
        const note = g("note").slice(0, 5000); const source = ["crm", "website"].includes(g("source")) ? g("source") : "crm";
        if (!note) return J(400, { error: "Please describe the change you need." });
        const email = g("email").slice(0, 200); if (email && !/^\S+@\S+\.\S+$/.test(email)) return J(400, { error: "That email looks invalid" });
        // Multiple screenshots (t1176u): up to MAX_FILES, each <= 5MB, validated before any is stored.
        const files = fd.getAll("screenshot").filter(f => f && typeof f != "string" && f.size);
        if (files.length > MAX_FILES) return J(400, { error: `Up to ${MAX_FILES} screenshots per request.` });
        const ok = [];
        for (const f of files) {
          if (f.size > MAX) return J(413, { error: "Each image must be under 5MB" });
          const buf = new Uint8Array(await f.arrayBuffer()); const k = sniff(buf);
          const ext = (f.name.split(".").pop() || "").toLowerCase().replace("jpeg", "jpg");
          if (!k || ext !== k) return J(400, { error: "Screenshots must be PNG, JPG or WEBP images" });
          ok.push([crypto.randomUUID() + "." + k, buf, k]);
        }
        for (const [n, buf, k] of ok) await env.SHOTS.put(n, buf, { httpMetadata: { contentType: TYPES[k] } });
        const names = ok.map(x => x[0]); const file = names[0] || null;
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO feedback (id,screenshots,business_name,source,site,note,name,email,screenshot,status,created_at,ip) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)")
          .bind(id, JSON.stringify(names), business, source, g("site").slice(0, 200), note, g("name").slice(0, 120), email, file, new Date().toISOString(), ip).run();
        // Instant notify (t1187u): fire-and-forget POST to the owner's routine webhook.
        if (env.WEBHOOK_URL) ctx.waitUntil(notify(env, { id, businessName: business, note, source, screenshotCount: names.length }));
        return J(201, { ok: true, id, status: "pending" });
      }
      if (p == "/api/feedback" && req.method == "GET") {
        if (!(await authed(req, env))) return J(401, { error: "unauthorized" });
        const s = u.searchParams.get("source");
        const q = "SELECT id,screenshots,business_name businessName,source,site,note,name,email,screenshot,status,created_at createdAt,reviewed_at reviewedAt FROM feedback" + (s ? " WHERE source=?" : "") + " ORDER BY created_at DESC LIMIT 500";
        const r = await (s ? env.DB.prepare(q).bind(s) : env.DB.prepare(q)).all();
        for (const x of r.results) { try { x.screenshots = JSON.parse(x.screenshots || "null"); } catch { x.screenshots = null; } if (!x.screenshots) x.screenshots = x.screenshot ? [x.screenshot] : []; }
        return J(200, r.results);
      }
      m = /^\/api\/feedback\/([\w-]+)\/(approve|reject)$/.exec(p);
      if (m && req.method == "POST") {
        if (!(await authed(req, env))) return J(401, { error: "unauthorized" });
        const st = m[2] == "approve" ? "approved" : "rejected";
        const r = await env.DB.prepare("UPDATE feedback SET status=?, reviewed_at=? WHERE id=?").bind(st, new Date().toISOString(), m[1]).run();
        if (!r.meta.changes) return J(404, { error: "not found" });
        return J(200, { ok: true, status: st, message: st == "approved" ? "Approved for later action — nothing was changed on the live site or CRM." : "Rejected — nothing was changed." });
      }
      return J(404, { error: "not found" });
    } catch (e) { console.error(e); return J(500, { error: "Something went wrong" }); }
  }
};
