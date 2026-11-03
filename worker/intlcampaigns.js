/* International Phase 4 (2026-11-03): drafts + compliance. LOCAL build.
 *
 * Tables (CRM_DB): email_templates (EN/ES), email_suppressions (email|domain),
 * campaigns (draft -> approved -> scheduled -> sending -> done), campaign_messages.
 *
 * Nothing here sends. There is no provider; `sending` and `done` exist in the
 * state machine for Phase 5 and cannot be entered by hand.
 *
 * Rules:
 *  - A draft is only written for a lead with at least one CONFIRMED audit
 *    finding in lead_evidence (status confirmed_issue). Needs-review findings
 *    never reach copy.
 *  - Every message gets a footer at render time: sender identity, postal
 *    address (OUTREACH_POSTAL_ADDRESS; placeholder until set), unsubscribe link.
 *    The footer is not stored in the editable body, so an edit cannot drop it.
 *  - Eligibility gate (re-run on approve): verified address or a role address
 *    on the business's own domain; not opted out; client not do_not_contact;
 *    email and domain not suppressed; country allowed by COUNTRY_RULES.
 *  - Unsubscribe: public GET /u/:token (confirm page) and POST /u/:token
 *    (RFC 8058 one-click) -> suppression + lead_emails.opted_out + clients.do_not_contact.
 *
 * No imports: build-bundle.mjs inlines this file.
 */

export const CAMPAIGN_STATUSES = ["draft", "approved", "scheduled", "sending", "done"];
const TRANSITIONS = { draft: ["approved"], approved: ["draft", "scheduled"], scheduled: ["approved"], sending: [], done: [] };

/* Country rules. MX and US: B2B cold email to a business role address is
   allowed with identity, postal address and a working opt-out (CAN-SPAM;
   MX LFPDPPP/LFPC for business contacts — to be confirmed by counsel).
   Anything else is blocked until someone writes its rule. */
export const COUNTRY_RULES = {
  MX: { allowed: true, needs: ["identity", "postal", "unsubscribe"], note: "B2B role/verified address only; pending legal review" },
  US: { allowed: true, needs: ["identity", "postal", "unsubscribe"], note: "CAN-SPAM" },
  CA: { allowed: false, note: "CASL requires consent" },
};

const PLACEHOLDER_POSTAL = "[POSTAL ADDRESS NOT SET - configure OUTREACH_POSTAL_ADDRESS]";

export const DEFAULT_TEMPLATES = [
  { key: "audit_intro", lang: "en",
    subject: "A few quick fixes for {{business}}'s website",
    body: "Hi {{business}} team,\n\nI took a look at {{website}} and noticed a few things that may be costing you bookings from US visitors:\n\n{{findings}}\n\nWe build and fix sites for businesses that serve US travelers. Happy to send a short plan if it's useful.\n\nBest,\n{{sender}}" },
  { key: "audit_intro", lang: "es",
    subject: "Algunas mejoras rápidas para el sitio de {{business}}",
    body: "Hola equipo de {{business}}:\n\nRevisé {{website}} y noté algunos puntos que podrían estar costándoles reservas de visitantes de EE. UU.:\n\n{{findings}}\n\nCreamos y mejoramos sitios para negocios que atienden a viajeros estadounidenses. Con gusto les envío un plan breve si les sirve.\n\nSaludos,\n{{sender}}" },
];

/* One line per confirmed audit finding kind. Unknown kinds are skipped. */
export const FINDING_LINES = {
  audit_https: { en: "The site doesn't load securely (no HTTPS), so browsers show a \"Not secure\" warning.", es: "El sitio no carga de forma segura (sin HTTPS) y los navegadores muestran \"No seguro\"." },
  audit_viewport: { en: "Pages aren't set up for phones, so they render zoomed-out on mobile.", es: "Las páginas no están adaptadas a celulares y se ven reducidas en móvil." },
  audit_speed: { en: "The site loads slowly on mobile.", es: "El sitio carga lento en celulares." },
  audit_broken_links: { en: "Some links on the site are broken.", es: "Algunos enlaces del sitio están rotos." },
  audit_booking: { en: "There's no clear way to book or check availability online.", es: "No hay una forma clara de reservar o consultar disponibilidad en línea." },
  audit_forms: { en: "There's no contact or inquiry form.", es: "No hay formulario de contacto o solicitud." },
  audit_lang_switch: { en: "There's no English version / language switch for US visitors.", es: "No hay versión en inglés ni selector de idioma para visitantes de EE. UU." },
  audit_whatsapp: { en: "There's no WhatsApp click-to-chat button.", es: "No hay botón de WhatsApp para chatear." },
  audit_analytics: { en: "No analytics appear to be installed, so you can't see where visitors drop off.", es: "No parece haber analítica instalada, así que no se ve dónde abandonan los visitantes." },
};

const CAMPAIGN_FREEMAIL = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.mx", "live.com", "live.com.mx", "icloud.com", "prodigy.net.mx", "aol.com", "msn.com", "protonmail.com"];

export async function ensureCampaignTables(env) {
  const db = env.CRM_DB;
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, lang TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (key, lang))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL,
      reason TEXT, source TEXT, created_at TEXT NOT NULL, UNIQUE (kind, value))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lang TEXT NOT NULL,
      template_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      scheduled_for TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS campaign_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, client_id INTEGER NOT NULL,
      lead_email_id INTEGER, to_email TEXT NOT NULL, lang TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, findings TEXT,
      status TEXT NOT NULL DEFAULT 'draft',      -- draft | blocked
      block_reason TEXT, edited INTEGER NOT NULL DEFAULT 0,
      unsubscribe_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (campaign_id, to_email))`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign ON campaign_messages(campaign_id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_campaign_messages_email ON campaign_messages(to_email)").run();
  const now = new Date().toISOString();
  for (const t of DEFAULT_TEMPLATES) {
    await db.prepare("INSERT OR IGNORE INTO email_templates (key, lang, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(t.key, t.lang, t.subject, t.body, now).run();
  }
}

export function normEmail(v) { return String(v || "").trim().toLowerCase(); }
export function emailDomain(v) { const e = normEmail(v); const i = e.lastIndexOf("@"); return i > 0 ? e.slice(i + 1) : ""; }
function hostOf(url) {
  try { return new URL(/^https?:/i.test(url) ? url : "https://" + url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch (e) { return ""; }
}

export function senderConfig(env) {
  const postal = String((env && env.OUTREACH_POSTAL_ADDRESS) || "").trim();
  return {
    name: String((env && env.OUTREACH_SENDER_NAME) || "Potentia Network").trim(),
    email: String((env && env.OUTREACH_SENDER_EMAIL) || "").trim(),
    postal: postal || PLACEHOLDER_POSTAL,
    postalSet: !!postal,
    base: String((env && env.PUBLIC_API_BASE) || "").replace(/\/+$/, ""),
  };
}

export function unsubscribeUrl(env, token) { return senderConfig(env).base + "/u/" + token; }

export function footer(env, lang, token) {
  const s = senderConfig(env);
  const u = unsubscribeUrl(env, token);
  return lang === "es"
    ? `\n\n--\n${s.name}${s.email ? " <" + s.email + ">" : ""}\n${s.postal}\nSi no desea recibir más correos, dé de baja aquí: ${u}`
    : `\n\n--\n${s.name}${s.email ? " <" + s.email + ">" : ""}\n${s.postal}\nTo stop receiving these emails, unsubscribe here: ${u}`;
}

export function fill(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] == null ? "" : String(vars[k])));
}

export function findingLines(findings, lang) {
  const out = [];
  const seen = {};
  for (const f of findings || []) {
    const l = FINDING_LINES[f.kind];
    if (!l || seen[f.kind]) continue;
    seen[f.kind] = 1;
    out.push("- " + (l[lang] || l.en));
  }
  return out;
}

export async function confirmedFindings(env, clientId) {
  return (await env.CRM_DB.prepare(
    `SELECT kind, url, snippet FROM lead_evidence
      WHERE client_id = ? AND category = 'audit' AND confirmed = 1 AND status = 'confirmed_issue' ORDER BY id`
  ).bind(clientId).all()).results || [];
}

export async function isSuppressed(env, email) {
  const e = normEmail(email), d = emailDomain(e);
  const r = await env.CRM_DB.prepare(
    "SELECT kind, value FROM email_suppressions WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) LIMIT 1"
  ).bind(e, d).first();
  return r ? r.kind : null;
}

/* Pure part of the gate. row: lead_emails row; client: clients row. */
export function addressOk(row, client) {
  if (!row || !row.email) return "no_address";
  if (row.verification_status === "invalid") return "invalid_address";
  if (row.verification_status === "verified") return null;
  const d = emailDomain(row.email);
  if (CAMPAIGN_FREEMAIL.indexOf(d) !== -1) return "unverified_freemail";
  if (row.type !== "role") return "not_role_or_verified";
  const site = hostOf((client && client.website_url) || "");
  if (!site || !(site === d || site.endsWith("." + d) || d.endsWith("." + site))) return "role_off_domain";
  return null;
}

export async function checkEligibility(env, row, client) {
  if (!client || client.source !== "pipeline_intl") return "not_intl_lead";
  if (client.do_not_contact) return "do_not_contact";
  const rule = COUNTRY_RULES[String(client.country || "").toUpperCase()];
  if (!rule || !rule.allowed) return "country_blocked";
  const a = addressOk(row, client);
  if (a) return a;
  if (row.opted_out) return "opted_out";
  const s = await isSuppressed(env, row.email);
  if (s) return "suppressed_" + s;
  return null;
}

function newToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function getTemplate(env, key, lang) {
  return await env.CRM_DB.prepare("SELECT key, lang, subject, body FROM email_templates WHERE key = ? AND lang = ?").bind(key, lang).first();
}

export async function listTemplates(env) {
  await ensureCampaignTables(env);
  return (await env.CRM_DB.prepare("SELECT id, key, lang, subject, body, updated_at FROM email_templates ORDER BY key, lang").all()).results || [];
}

export async function saveTemplate(env, b) {
  await ensureCampaignTables(env);
  const key = String(b.key || "").trim(), lang = String(b.lang || "");
  if (!/^[a-z0-9_]{1,40}$/.test(key) || ["en", "es"].indexOf(lang) === -1) return { error: "Invalid key or lang" };
  const subject = String(b.subject || "").slice(0, 200), body = String(b.body || "").slice(0, 8000);
  if (!subject.trim() || !body.trim()) return { error: "Subject and body required" };
  await env.CRM_DB.prepare(
    `INSERT INTO email_templates (key, lang, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key, lang) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`
  ).bind(key, lang, subject, body, new Date().toISOString()).run();
  return { ok: true };
}

/* Build a draft campaign. Leads with no confirmed finding or no address are
   skipped (reported). Ineligible addresses get a `blocked` row with the reason
   so the gate is visible in the UI. */
export async function createDraftCampaign(env, b) {
  await ensureCampaignTables(env);
  const lang = b.lang === "es" ? "es" : "en";
  const key = String(b.template_key || "audit_intro");
  const tpl = await getTemplate(env, key, lang);
  if (!tpl) return { error: "Template not found" };
  const ids = (Array.isArray(b.client_ids) ? b.client_ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
  if (!ids.length) return { error: "No leads" };
  const now = new Date().toISOString();
  const name = String(b.name || "").trim().slice(0, 120) || `Intl ${lang.toUpperCase()} ${now.slice(0, 10)}`;
  const c = await env.CRM_DB.prepare(
    "INSERT INTO campaigns (name, lang, template_key, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)"
  ).bind(name, lang, key, now, now).run();
  const campaignId = c.meta.last_row_id;
  const s = senderConfig(env);
  const out = { ok: true, campaign_id: campaignId, drafted: 0, blocked: 0, skipped: [] };
  for (const id of ids) {
    const client = await env.CRM_DB.prepare(
      "SELECT id, business_name, website_url, source, country, do_not_contact FROM clients WHERE id = ?").bind(id).first();
    if (!client || client.source !== "pipeline_intl") { out.skipped.push({ client_id: id, reason: "not_intl_lead" }); continue; }
    const findings = await confirmedFindings(env, id);
    const lines = findingLines(findings, lang);
    if (!lines.length) { out.skipped.push({ client_id: id, reason: "no_confirmed_findings" }); continue; }
    const emails = (await env.CRM_DB.prepare(
      "SELECT id, email, type, verification_status, opted_out FROM lead_emails WHERE client_id = ? ORDER BY CASE type WHEN 'role' THEN 0 ELSE 1 END, id"
    ).bind(id).all()).results || [];
    if (!emails.length) { out.skipped.push({ client_id: id, reason: "no_address" }); continue; }
    // One address per lead: the first eligible one, else the first (blocked).
    let pick = null, reason = null;
    for (const e of emails) { const r = await checkEligibility(env, e, client); if (!r) { pick = e; reason = null; break; } if (!pick) { pick = e; reason = r; } }
    const vars = { business: client.business_name || "", website: client.website_url || "", findings: lines.join("\n"), sender: s.name };
    const r = await env.CRM_DB.prepare(
      `INSERT OR IGNORE INTO campaign_messages (campaign_id, client_id, lead_email_id, to_email, lang, subject, body, findings,
         status, block_reason, unsubscribe_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(campaignId, id, pick.id, normEmail(pick.email), lang, fill(tpl.subject, vars), fill(tpl.body, vars),
           JSON.stringify(findings.map((f) => ({ kind: f.kind, url: f.url }))), reason ? "blocked" : "draft", reason,
           newToken(), now, now).run();
    if (!r.meta.changes) { out.skipped.push({ client_id: id, reason: "duplicate_address" }); continue; }
    if (reason) out.blocked++; else out.drafted++;
  }
  return out;
}

export function renderMessage(env, m) {
  return { subject: m.subject, body: m.body + footer(env, m.lang, m.unsubscribe_token),
           list_unsubscribe: "<" + unsubscribeUrl(env, m.unsubscribe_token) + ">",
           list_unsubscribe_post: "List-Unsubscribe=One-Click" };
}

export async function listCampaigns(env) {
  await ensureCampaignTables(env);
  return (await env.CRM_DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'draft') AS drafts,
            (SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'blocked') AS blocked
       FROM campaigns c ORDER BY c.id DESC LIMIT 200`).all()).results || [];
}

export async function getCampaign(env, id) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return null;
  const msgs = (await env.CRM_DB.prepare(
    `SELECT m.*, cl.business_name FROM campaign_messages m LEFT JOIN clients cl ON cl.id = m.client_id
      WHERE m.campaign_id = ? ORDER BY m.status DESC, m.id`).bind(id).all()).results || [];
  const s = senderConfig(env);
  return { campaign: c, sender: { name: s.name, email: s.email, postal: s.postal, postal_set: s.postalSet },
           messages: msgs.map((m) => Object.assign({}, m, { preview: renderMessage(env, m) })) };
}

export async function editMessage(env, id, b) {
  await ensureCampaignTables(env);
  const m = await env.CRM_DB.prepare(
    "SELECT m.id, c.status AS cstatus FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = ?").bind(id).first();
  if (!m) return { error: "Not found", status: 404 };
  if (m.cstatus !== "draft") return { error: "Campaign is not a draft" };
  const subject = String(b.subject || "").slice(0, 200), body = String(b.body || "").slice(0, 8000);
  if (!subject.trim() || !body.trim()) return { error: "Subject and body required" };
  await env.CRM_DB.prepare("UPDATE campaign_messages SET subject = ?, body = ?, edited = 1, updated_at = ? WHERE id = ?")
    .bind(subject, body, new Date().toISOString(), id).run();
  return { ok: true };
}

/* Re-run the gate on every draft row (state may have changed since drafting). */
export async function recheckCampaign(env, id) {
  const msgs = (await env.CRM_DB.prepare(
    "SELECT m.id, m.client_id, m.lead_email_id, m.to_email, m.status FROM campaign_messages m WHERE m.campaign_id = ?").bind(id).all()).results || [];
  let ok = 0;
  for (const m of msgs) {
    const row = await env.CRM_DB.prepare("SELECT id, email, type, verification_status, opted_out FROM lead_emails WHERE id = ?").bind(m.lead_email_id).first()
      || { email: m.to_email, opted_out: 0 };
    const client = await env.CRM_DB.prepare("SELECT id, website_url, source, country, do_not_contact FROM clients WHERE id = ?").bind(m.client_id).first();
    let r = await checkEligibility(env, row, client);
    if (!r && !(await confirmedFindings(env, m.client_id)).length) r = "no_confirmed_findings";
    await env.CRM_DB.prepare("UPDATE campaign_messages SET status = ?, block_reason = ?, updated_at = ? WHERE id = ?")
      .bind(r ? "blocked" : "draft", r, new Date().toISOString(), m.id).run();
    if (!r) ok++;
  }
  return ok;
}

export async function setCampaignStatus(env, id, to, b) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  if (CAMPAIGN_STATUSES.indexOf(to) === -1) return { error: "Invalid status" };
  if (to === "sending" || to === "done") return { error: "No send provider yet (Phase 5)" };
  if ((TRANSITIONS[c.status] || []).indexOf(to) === -1) return { error: `Cannot go from ${c.status} to ${to}` };
  const now = new Date().toISOString();
  if (to === "approved" && c.status === "draft") {
    if (!senderConfig(env).postalSet) return { error: "Postal address not configured (OUTREACH_POSTAL_ADDRESS)" };
    if (!senderConfig(env).base) return { error: "Unsubscribe base URL not configured (PUBLIC_API_BASE)" };
    const ok = await recheckCampaign(env, id);
    if (!ok) return { error: "No eligible messages" };
    await env.CRM_DB.prepare("UPDATE campaigns SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?").bind(now, now, id).run();
    return { ok: true, status: "approved", eligible: ok };
  }
  let sched = c.scheduled_for;
  if (to === "scheduled") {
    const t = Date.parse((b && b.scheduled_for) || "");
    if (!t || t < Date.now()) return { error: "scheduled_for must be a future time" };
    sched = new Date(t).toISOString();
  } else sched = null;
  await env.CRM_DB.prepare("UPDATE campaigns SET status = ?, scheduled_for = ?, approved_at = ?, updated_at = ? WHERE id = ?")
    .bind(to, sched, to === "draft" ? null : c.approved_at, now, id).run();
  return { ok: true, status: to };
}

export async function listSuppressions(env) {
  await ensureCampaignTables(env);
  return (await env.CRM_DB.prepare("SELECT * FROM email_suppressions ORDER BY id DESC LIMIT 1000").all()).results || [];
}

export async function addSuppression(env, kind, value, reason, source) {
  await ensureCampaignTables(env);
  let v = String(value || "").trim().toLowerCase();
  if (kind === "email") { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { error: "Invalid email" }; }
  else if (kind === "domain") { v = v.replace(/^@/, ""); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return { error: "Invalid domain" }; }
  else return { error: "kind must be email or domain" };
  await env.CRM_DB.prepare("INSERT OR IGNORE INTO email_suppressions (kind, value, reason, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(kind, v, reason || null, source || "manual", new Date().toISOString()).run();
  const pat = kind === "email" ? v : "%@" + v;
  const op = kind === "email" ? "=" : "LIKE";
  await env.CRM_DB.prepare(`UPDATE lead_emails SET opted_out = 1 WHERE lower(email) ${op} ?`).bind(pat).run();
  await env.CRM_DB.prepare(
    `UPDATE campaign_messages SET status = 'blocked', block_reason = ? WHERE status = 'draft' AND to_email ${op} ?`
  ).bind("suppressed_" + kind, pat).run();
  return { ok: true, kind, value: v };
}

/* Public unsubscribe. Returns { html, status }. GET only shows a confirm
   page (mail scanners prefetch links); POST applies it. */
export async function handleUnsubscribe(env, token, method) {
  await ensureCampaignTables(env);
  const t = String(token || "");
  const m = /^[a-f0-9]{16,64}$/.test(t)
    ? await env.CRM_DB.prepare("SELECT id, client_id, to_email, lang FROM campaign_messages WHERE unsubscribe_token = ?").bind(t).first()
    : null;
  const es = m && m.lang === "es";
  const page = (title, msg, form) => `<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px"><h1 style="font-size:22px">${title}</h1><p>${msg}</p>${form || ""}</body></html>`;
  if (!m) return { status: 404, html: page("Link not valid", "This unsubscribe link is not valid. / Este enlace no es válido.") };
  const shown = m.to_email.replace(/[<>&"]/g, "");
  if (method === "GET") {
    return { status: 200, html: page(es ? "Darse de baja" : "Unsubscribe",
      es ? `¿Dejar de enviar correos a <b>${shown}</b>?` : `Stop emails to <b>${shown}</b>?`,
      `<form method="post"><button type="submit" style="font-size:16px;padding:10px 18px">${es ? "Confirmar baja" : "Unsubscribe"}</button></form>`) };
  }
  await addSuppression(env, "email", m.to_email, "unsubscribe", "unsubscribe_link");
  await env.CRM_DB.prepare("UPDATE clients SET do_not_contact = 1, updated_at = ? WHERE id = ? AND source = 'pipeline_intl'")
    .bind(new Date().toISOString(), m.client_id).run();
  return { status: 200, html: page(es ? "Listo" : "Done",
    es ? `<b>${shown}</b> no recibirá más correos de nosotros.` : `<b>${shown}</b> will not receive any more emails from us.`) };
}
