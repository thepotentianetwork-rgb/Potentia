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

export const CAMPAIGN_STATUSES = ["draft", "approved", "scheduled", "sending", "paused", "done", "failed"];
/* Hand transitions only. scheduled->sending and sending->done|failed belong to
   the scheduler (runOutreachTick); paused->sending is resumeCampaign. */
const TRANSITIONS = { draft: ["approved"], approved: ["draft", "scheduled"], scheduled: ["approved", "paused"],
  sending: ["paused"], paused: ["approved"], done: [], failed: [] };

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
  await ensureSendSchema(db);
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
  // t1508u: provenance + personal-address review. Rows loaded without these
  // fields (legacy callers) are re-read so the gate can't be skipped.
  if (row.id && (row.source_url === undefined || row.eligibility === undefined)) {
    const full = await env.CRM_DB.prepare("SELECT source_url, eligibility FROM lead_emails WHERE id = ?").bind(row.id).first();
    if (full) row = Object.assign({}, row, full);
  }
  if (!String(row.source_url || "").trim()) return "provenance_unknown_review";
  if (row.type !== "role" && row.eligibility !== "eligible") return "personal_needs_review";
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
      "SELECT id, email, type, verification_status, opted_out, source_url, discovered_at, eligibility FROM lead_emails WHERE client_id = ? ORDER BY CASE type WHEN 'role' THEN 0 ELSE 1 END, id"
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
    await env.CRM_DB.prepare(`UPDATE campaign_messages SET business_name_at_draft = ?, website_at_draft = ?, email_source_url = ?,
        email_collected_at = ? WHERE id = ?`).bind(client.business_name || null, client.website_url || null, pick.source_url || null,
        pick.discovered_at || null, r.meta.last_row_id).run();
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

/* t1508u duplicate check: same address or domain already sent/queued in
   ANOTHER campaign in the last 90 days -> block. */
export async function duplicateContact(env, m) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = await env.CRM_DB.prepare(
    `SELECT id FROM campaign_messages WHERE campaign_id != ? AND (to_email = ? OR to_email LIKE ?)
       AND (status IN ('queued', 'sending') OR (sent_at IS NOT NULL AND sent_at >= ?)) LIMIT 1`
  ).bind(m.campaign_id, m.to_email, "%@" + emailDomain(m.to_email), since).first();
  return r ? "duplicate_recent_contact" : null;
}

export async function setCampaignStatus(env, id, to, b) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  if (CAMPAIGN_STATUSES.indexOf(to) === -1) return { error: "Invalid status" };
  if (to === "sending" || to === "done" || to === "failed") return { error: "Only the scheduler moves a campaign to " + to };
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
    // t1508u: suppression/opt-out + duplicate check before scheduling.
    const ok = await recheckCampaign(env, id);
    let dup = 0;
    for (const m of (await env.CRM_DB.prepare("SELECT id, campaign_id, to_email FROM campaign_messages WHERE campaign_id = ? AND status = 'draft'").bind(id).all()).results || []) {
      const d = await duplicateContact(env, m);
      if (d) { dup++; await env.CRM_DB.prepare("UPDATE campaign_messages SET status = 'blocked', block_reason = ? WHERE id = ?").bind(d, m.id).run(); }
    }
    if (ok - dup <= 0) return { error: "No eligible messages after suppression/duplicate check" };
  } else sched = null;
  if (to === "paused") sched = c.scheduled_for;
  await env.CRM_DB.prepare("UPDATE campaigns SET status = ?, scheduled_for = ?, approved_at = ?, updated_at = ? WHERE id = ?")
    .bind(to, sched, to === "draft" ? null : c.approved_at, now, id).run();
  // Back to draft voids Nando's send approval (copy may change).
  if (to === "draft") await env.CRM_DB.prepare("UPDATE campaigns SET nando_approved_by = NULL, nando_approved_at = NULL WHERE id = ?").bind(id).run();
  // paused -> approved: un-send the queue so nothing goes out until re-scheduled.
  if (to === "approved" && c.status === "paused")
    await env.CRM_DB.prepare("UPDATE campaign_messages SET status = 'draft' WHERE campaign_id = ? AND status = 'queued'").bind(id).run();
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
    `UPDATE campaign_messages SET status = 'blocked', block_reason = ? WHERE status IN ('draft', 'queued') AND to_email ${op} ?`
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

/* ===================== Phase 5: sending (LOCAL build) =====================
 * Kill switch OUTREACH_SEND_ENABLED must be exactly "true" for the scheduler to
 * do anything. Campaigns default dry_run = 1, which never calls a provider even
 * with the switch on. A campaign leaves `scheduled` only with Nando's approval
 * record (nando_approved_by/at). No open/click tracking.
 */

const SEND_COLS_CAMPAIGN = [
  ["nando_approved_by", "TEXT"], ["nando_approved_at", "TEXT"], ["dry_run", "INTEGER NOT NULL DEFAULT 1"],
  ["sent_count", "INTEGER NOT NULL DEFAULT 0"], ["bounce_count", "INTEGER NOT NULL DEFAULT 0"],
  ["complaint_count", "INTEGER NOT NULL DEFAULT 0"], ["started_at", "TEXT"], ["finished_at", "TEXT"], ["fail_reason", "TEXT"],
];
const SEND_COLS_MESSAGE = [
  ["provider_message_id", "TEXT"], ["idempotency_key", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["last_error", "TEXT"], ["next_attempt_at", "TEXT"], ["queued_at", "TEXT"], ["sent_at", "TEXT"], ["delivered_at", "TEXT"],
  ["bounced_at", "TEXT"], ["bounce_type", "TEXT"], ["complained_at", "TEXT"], ["rendered_hash", "TEXT"], ["dry_run", "INTEGER"],
  // t1508u provenance snapshot, written at draft time.
  ["business_name_at_draft", "TEXT"], ["website_at_draft", "TEXT"], ["email_source_url", "TEXT"], ["email_collected_at", "TEXT"],
];

async function addCols(db, table, cols) {
  const have = new Set(((await db.prepare(`PRAGMA table_info(${table})`).all()).results || []).map((r) => r.name));
  for (const [n, t] of cols) if (!have.has(n)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${n} ${t}`).run();
}

async function ensureSendSchema(db) {
  await addCols(db, "campaigns", SEND_COLS_CAMPAIGN);
  await addCols(db, "campaign_messages", SEND_COLS_MESSAGE);
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_provider_id ON campaign_messages(provider_message_id)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_idem ON campaign_messages(idempotency_key)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL UNIQUE,
      provider_message_id TEXT, type TEXT NOT NULL, to_email TEXT, payload_json TEXT, received_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS send_ledger (
      day TEXT NOT NULL, mode TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, mode))`).run();
}

export function sendConfig(env) {
  const e = env || {};
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  const w = String(e.OUTREACH_SEND_WINDOW || "09-17").match(/^(\d{1,2})-(\d{1,2})$/);
  return {
    enabled: String(e.OUTREACH_SEND_ENABLED || "false") === "true",
    provider: e.OUTREACH_PROVIDER === "resend" ? "resend" : "dryrun",
    dailyCap: int(e.OUTREACH_DAILY_CAP, 25), batch: int(e.OUTREACH_BATCH_SIZE, 10),
    perDomain: int(e.OUTREACH_PER_DOMAIN_DAILY, 1),
    window: w ? [Number(w[1]), Number(w[2])] : [9, 17],
    replyTo: String(e.OUTREACH_REPLY_TO || e.OUTREACH_SENDER_EMAIL || "").trim(),
    delayMs: int(e.OUTREACH_SEND_DELAY_MS, 1500),
    mxCheck: String(e.OUTREACH_MX_CHECK || "true") !== "false",
    hasResendKey: !!e.RESEND_API_KEY, hasWebhookSecret: !!e.RESEND_WEBHOOK_SECRET,
  };
}

export const COUNTRY_TZ = { MX: "America/Mexico_City", US: "America/Denver" };

/* Recipient-local Mon–Fri [from, to) hour window. */
export function inSendWindow(country, now, win) {
  const tz = COUNTRY_TZ[String(country || "").toUpperCase()] || "America/Denver";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24;
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  return h >= win[0] && h < win[1];
}

export function idempotencyKey(campaignId, messageId) { return `camp-${campaignId}-msg-${messageId}`; }

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

function htmlEscape(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
export function toHtml(text) {
  const esc = htmlEscape(text).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc}</div>`;
}

/* Exact email that would go out. No tracking pixels or rewritten links. */
export function buildEmail(env, m) {
  const r = renderMessage(env, m);
  const s = senderConfig(env), c = sendConfig(env);
  const lu = [r.list_unsubscribe];
  if (c.replyTo) lu.push(`<mailto:${c.replyTo}?subject=unsubscribe>`);
  return {
    from: s.email ? `${s.name} <${s.email}>` : "", to: m.to_email, reply_to: c.replyTo || undefined,
    subject: r.subject, text: r.body, html: toHtml(r.body),
    headers: { "List-Unsubscribe": lu.join(", "), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/* Provider adapter. Returns { ok, id } | { retry, error } | { fatal, error } | { failed, error }.
   provider: "dryrun" never touches the network. */
export async function sendViaProvider(env, provider, email, idemKey, fetchImpl) {
  if (provider !== "resend") return { ok: true, id: "dryrun-" + newToken() };
  if (!env.RESEND_API_KEY) return { fatal: true, error: "RESEND_API_KEY not set" };
  if (!email.from) return { fatal: true, error: "OUTREACH_SENDER_EMAIL not set" };
  const f = fetchImpl || fetch;
  let res;
  try {
    res = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": idemKey },
      body: JSON.stringify({ from: email.from, to: [email.to], reply_to: email.reply_to, subject: email.subject,
        text: email.text, html: email.html, headers: email.headers }),
    });
  } catch (e) { return { retry: true, error: "network: " + String(e && e.message || e).slice(0, 200) }; }
  let data = null; try { data = await res.json(); } catch (e) {}
  const msg = `${res.status} ${(data && (data.message || data.name)) || ""}`.trim().slice(0, 300);
  if (res.status >= 200 && res.status < 300 && data && data.id) return { ok: true, id: data.id };
  if (res.status === 401 || res.status === 403) return { fatal: true, error: msg };
  if (res.status === 429 || res.status >= 500 || (res.status >= 200 && res.status < 300)) return { retry: true, error: msg };
  if (res.status === 409) return { retry: true, error: msg }; // idempotent request still in flight
  return { failed: true, error: msg };
}

/* Free DoH MX check (Cloudflare 1.1.1.1). true = has MX (or A fallback), false =
   NXDOMAIN / no MX and no A, null = could not tell (never blocks). */
export async function mxCheck(domain, fetchImpl) {
  const f = fetchImpl || fetch;
  const q = async (type) => {
    const r = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { Accept: "application/dns-json" } });
    if (!r.ok) throw new Error("doh " + r.status);
    return await r.json();
  };
  try {
    const mx = await q("MX");
    if (mx.Status === 3) return false;
    if ((mx.Answer || []).some((a) => a.type === 15)) return true;
    const a = await q("A");
    return (a.Answer || []).some((x) => x.type === 1);
  } catch (e) { return null; }
}

function utcDay(now) { return now.toISOString().slice(0, 10); }

async function ledgerSent(db, day, mode) {
  const r = await db.prepare("SELECT sent FROM send_ledger WHERE day = ? AND mode = ?").bind(day, mode).first();
  return r ? r.sent : 0;
}
async function ledgerBump(db, day, mode) {
  await db.prepare("INSERT INTO send_ledger (day, mode, sent) VALUES (?, ?, 1) ON CONFLICT(day, mode) DO UPDATE SET sent = sent + 1").bind(day, mode).run();
}

/* Full pre-send gate for one queued message. Returns a block reason or null. */
async function sendRecheck(env, m, mxCache, opts) {
  const row = await env.CRM_DB.prepare("SELECT id, email, type, verification_status, opted_out FROM lead_emails WHERE id = ?").bind(m.lead_email_id).first()
    || { email: m.to_email, opted_out: 0 };
  const client = await env.CRM_DB.prepare("SELECT id, website_url, source, country, do_not_contact FROM clients WHERE id = ?").bind(m.client_id).first();
  let r = await checkEligibility(env, row, client);
  if (!r && !(await confirmedFindings(env, m.client_id)).length) r = "no_confirmed_findings";
  if (!r) r = await duplicateContact(env, m);
  if (!r && sendConfig(env).mxCheck) {
    const d = emailDomain(m.to_email);
    if (!(d in mxCache)) mxCache[d] = await mxCheck(d, opts.fetch);
    if (mxCache[d] === false) r = "no_mx";
  }
  return r;
}

/* One scheduler tick (hourly cron). opts: { now: Date, fetch, sleep } for tests. */
export async function runOutreachTick(env, opts) {
  opts = opts || {};
  const cfg = sendConfig(env);
  if (!cfg.enabled) return { skipped: "OUTREACH_SEND_ENABLED is not true" };
  await ensureCampaignTables(env);
  const db = env.CRM_DB;
  const now = opts.now || new Date();
  const nowIso = now.toISOString();
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = { started: [], sent: 0, dry: 0, skipped: 0, retried: 0, failed: 0, finished: [], halted: null, deferred: 0 };

  // 1. Due, Nando-approved scheduled campaigns -> sending; queue eligible drafts.
  const due = (await db.prepare(
    "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_for <= ? AND nando_approved_at IS NOT NULL ORDER BY scheduled_for, id"
  ).bind(nowIso).all()).results || [];
  for (const c of due) {
    const u = await db.prepare("UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .bind(nowIso, nowIso, c.id).run();
    if (!u.meta.changes) continue;
    await db.prepare(`UPDATE campaign_messages SET status = 'queued', queued_at = ?, updated_at = ?,
        idempotency_key = 'camp-' || campaign_id || '-msg-' || id WHERE campaign_id = ? AND status = 'draft'`).bind(nowIso, nowIso, c.id).run();
    out.started.push(c.id);
  }

  // 2. Caps. Real sends count toward the daily cap; dry-run sends have their own ledger row.
  const day = utcDay(now);
  const dayStart = day + "T00:00:00.000Z";
  let realLeft = Math.max(0, cfg.dailyCap - await ledgerSent(db, day, "live"));
  let dryLeft = Math.max(0, cfg.dailyCap - await ledgerSent(db, day, "dry"));
  let batchLeft = cfg.batch;
  const domainToday = {};
  const mxCache = {};
  const halted = new Set();

  const queued = (await db.prepare(
    `SELECT m.*, c.dry_run AS c_dry, cl.country AS country FROM campaign_messages m
       JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN clients cl ON cl.id = m.client_id
      WHERE c.status = 'sending' AND m.status = 'queued' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
      ORDER BY m.campaign_id, m.id LIMIT 500`).bind(nowIso).all()).results || [];

  let first = true;
  for (const m of queued) {
    if (batchLeft <= 0) break;
    if (halted.has(m.campaign_id)) continue;
    const dry = m.c_dry !== 0;
    if (!dry && (cfg.provider !== "resend" || !env.RESEND_API_KEY || !senderConfig(env).email)) {
      // t1508u: live campaigns send only via the authenticated Resend identity; never silently dry.
      const why = "live send refused: OUTREACH_PROVIDER=resend, RESEND_API_KEY and OUTREACH_SENDER_EMAIL required";
      await db.prepare("UPDATE campaigns SET status = 'failed', fail_reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
        .bind(why, nowIso, nowIso, m.campaign_id).run();
      halted.add(m.campaign_id); out.halted = why; continue;
    }
    if (dry ? dryLeft <= 0 : realLeft <= 0) { out.deferred++; continue; }
    if (!inSendWindow(m.country, now, cfg.window)) { out.deferred++; continue; }
    const dom = emailDomain(m.to_email);
    if (!(dom in domainToday)) {
      domainToday[dom] = (await db.prepare("SELECT COUNT(*) AS n FROM campaign_messages WHERE to_email LIKE ? AND sent_at >= ?")
        .bind("%@" + dom, dayStart).first()).n;
    }
    if (domainToday[dom] >= cfg.perDomain) { out.deferred++; continue; }

    const reason = await sendRecheck(env, m, mxCache, opts);
    if (reason) {
      await db.prepare("UPDATE campaign_messages SET status = 'skipped', block_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .bind(reason, nowIso, m.id).run();
      out.skipped++; continue;
    }
    // Atomic claim: only one overlapping tick can win this row.
    const cl = await db.prepare("UPDATE campaign_messages SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
      .bind(nowIso, m.id).run();
    if (!cl.meta.changes) continue;

    if (!first && cfg.delayMs) await sleep(cfg.delayMs);
    first = false;
    const email = buildEmail(env, m);
    const hash = await sha256Hex(email.subject + "\n" + email.text);
    const key = m.idempotency_key || idempotencyKey(m.campaign_id, m.id);
    const res = await sendViaProvider(env, dry ? "dryrun" : "resend", email, key, opts.fetch);
    batchLeft--;
    if (res.ok) {
      await db.prepare(`UPDATE campaign_messages SET status = 'sent', provider_message_id = ?, sent_at = ?, rendered_hash = ?,
          dry_run = ?, last_error = NULL, updated_at = ? WHERE id = ?`).bind(res.id, nowIso, hash, dry ? 1 : 0, nowIso, m.id).run();
      await db.prepare("UPDATE campaigns SET sent_count = sent_count + 1, updated_at = ? WHERE id = ?").bind(nowIso, m.campaign_id).run();
      await ledgerBump(db, day, dry ? "dry" : "live");
      if (dry) { dryLeft--; out.dry++; } else { realLeft--; out.sent++; }
      domainToday[dom]++;
    } else if (res.fatal) {
      await db.prepare("UPDATE campaign_messages SET status = 'queued', last_error = ?, updated_at = ? WHERE id = ?").bind(res.error, nowIso, m.id).run();
      await db.prepare("UPDATE campaigns SET status = 'failed', fail_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .bind("provider: " + res.error, nowIso, nowIso, m.campaign_id).run();
      halted.add(m.campaign_id);
      out.halted = res.error;
      if (!dry) break; // auth/config problem hits every live campaign
    } else if (res.retry && (m.attempts + 1) < 3) {
      const next = new Date(now.getTime() + 15 * 60000 * (m.attempts + 1)).toISOString();
      await db.prepare("UPDATE campaign_messages SET status = 'queued', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
        .bind(res.error, next, nowIso, m.id).run();
      out.retried++;
    } else {
      await db.prepare("UPDATE campaign_messages SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").bind(res.error, nowIso, m.id).run();
      out.failed++;
    }
  }

  // 3. Finish campaigns with nothing left in flight.
  const active = (await db.prepare("SELECT id FROM campaigns WHERE status = 'sending'").all()).results || [];
  for (const c of active) {
    const left = (await db.prepare("SELECT COUNT(*) AS n FROM campaign_messages WHERE campaign_id = ? AND status IN ('queued', 'sending')").bind(c.id).first()).n;
    if (!left) {
      await db.prepare("UPDATE campaigns SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(nowIso, nowIso, c.id).run();
      out.finished.push(c.id);
    }
  }
  return out;
}

/* Nando's explicit send approval. Required for scheduled -> sending. */
export async function nandoApprove(env, id, b) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  if (["approved", "scheduled"].indexOf(c.status) === -1) return { error: "Campaign must be approved or scheduled" };
  if (b && b.revoke) {
    await env.CRM_DB.prepare("UPDATE campaigns SET nando_approved_by = NULL, nando_approved_at = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    return { ok: true, revoked: true };
  }
  if (!b || b.confirm !== true) return { error: "Send confirm: true to record Nando's approval" };
  const by = String((b && b.by) || "Nando").trim().slice(0, 80) || "Nando";
  const now = new Date().toISOString();
  await env.CRM_DB.prepare("UPDATE campaigns SET nando_approved_by = ?, nando_approved_at = ?, updated_at = ? WHERE id = ?").bind(by, now, now, id).run();
  return { ok: true, nando_approved_by: by, nando_approved_at: now, dry_run: c.dry_run };
}

/* dry_run toggle; only before scheduling. Turning dry-run OFF voids Nando's approval. */
export async function setDryRun(env, id, b) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  if (["draft", "approved"].indexOf(c.status) === -1) return { error: "dry_run can only change in draft/approved" };
  const v = b && (b.dry_run === 0 || b.dry_run === false || b.dry_run === "0") ? 0 : 1;
  await env.CRM_DB.prepare(`UPDATE campaigns SET dry_run = ?, updated_at = ?${v === 0 ? ", nando_approved_by = NULL, nando_approved_at = NULL" : ""} WHERE id = ?`)
    .bind(v, new Date().toISOString(), id).run();
  return { ok: true, dry_run: v };
}

export async function resumeCampaign(env, id) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  if (c.status !== "paused") return { error: "Campaign is not paused" };
  if (!c.nando_approved_at) return { error: "Nando approval missing" };
  // Back to sending if it had started, else back to scheduled.
  const to = c.started_at ? "sending" : "scheduled";
  await env.CRM_DB.prepare("UPDATE campaigns SET status = ?, fail_reason = NULL, updated_at = ? WHERE id = ? AND status = 'paused'").bind(to, new Date().toISOString(), id).run();
  return { ok: true, status: to };
}

export async function sendStatus(env) {
  await ensureCampaignTables(env);
  const c = sendConfig(env), now = new Date(), day = utcDay(now);
  return { enabled: c.enabled, provider: c.provider, daily_cap: c.dailyCap, batch: c.batch, per_domain_daily: c.perDomain,
    window: c.window, resend_key_set: c.hasResendKey, webhook_secret_set: c.hasWebhookSecret, mx_check: c.mxCheck,
    sender: senderConfig(env).email, reply_to: c.replyTo,
    // Caps are env-only; code never raises them (ramp needs Nando's OK).
    metrics_30d: await env.CRM_DB.prepare(`SELECT
        SUM(CASE WHEN sent_at IS NOT NULL AND dry_run = 0 THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard_bounces,
        SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complaints,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
        FROM campaign_messages WHERE sent_at >= ?`).bind(new Date(Date.now() - 30 * 86400000).toISOString()).first(),
    replies_tracked: false, domain_reputation: "not tracked in-app; check Resend dashboard + Google Postmaster Tools for the sending domain",
    sent_today: await ledgerSent(env.CRM_DB, day, "live"), dry_today: await ledgerSent(env.CRM_DB, day, "dry"),
    window_open: { US: inSendWindow("US", now, c.window), MX: inSendWindow("MX", now, c.window) } };
}

/* Read-only "who would be sent / skipped and why" report. Changes nothing. */
export async function dryRunReport(env, id, opts) {
  await ensureCampaignTables(env);
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!c) return { error: "Not found", status: 404 };
  const msgs = (await env.CRM_DB.prepare(
    `SELECT m.*, cl.business_name, cl.country FROM campaign_messages m LEFT JOIN clients cl ON cl.id = m.client_id
      WHERE m.campaign_id = ? ORDER BY m.id`).bind(id).all()).results || [];
  const mx = {}, would = [], skip = [], other = [];
  for (const m of msgs) {
    if (["draft", "queued"].indexOf(m.status) === -1) { other.push({ id: m.id, to: m.to_email, status: m.status, reason: m.block_reason }); continue; }
    const r = await sendRecheck(env, m, mx, opts || {});
    if (r) skip.push({ id: m.id, to: m.to_email, business: m.business_name, reason: r });
    else {
      const e = buildEmail(env, m);
      would.push({ id: m.id, to: m.to_email, business: m.business_name, country: m.country, subject: e.subject, text: e.text,
        headers: e.headers, idempotency_key: idempotencyKey(id, m.id) });
    }
  }
  const cfg = sendConfig(env);
  return { campaign: { id: c.id, name: c.name, status: c.status, dry_run: c.dry_run, nando_approved_at: c.nando_approved_at },
    from: buildEmail(env, { to_email: "", subject: "", body: "", lang: c.lang, unsubscribe_token: "x" }).from, reply_to: cfg.replyTo,
    would_send: would, would_skip: skip, not_pending: other };
}

/* ---- Resend webhook (Svix) ---- */
function b64ToBytes(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u) { let s = ""; for (const x of new Uint8Array(u)) s += String.fromCharCode(x); return btoa(s); }

export async function svixSign(secret, id, ts, body) {
  const key = await crypto.subtle.importKey("raw", b64ToBytes(String(secret).replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToB64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
}

export async function verifySvix(secret, headers, body, nowSec) {
  if (!secret) return "no_secret";
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sig = headers.get("svix-signature");
  if (!id || !ts || !sig) return "missing_headers";
  const n = nowSec != null ? nowSec : Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(ts) || Math.abs(n - Number(ts)) > 300) return "timestamp";
  let expect;
  try { expect = await svixSign(secret, id, ts, body); } catch (e) { return "bad_secret"; }
  for (const part of sig.split(" ")) {
    const [v, s] = part.split(",");
    if (v === "v1" && s && s.length === expect.length) {
      let d = 0; for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ expect.charCodeAt(i);
      if (!d) return null;
    }
  }
  return "bad_signature";
}

/* Pause a sending campaign if bounces > 5% (min 3 bounces or 10 sent) or 2+ complaints. */
async function circuitBreaker(env, campaignId) {
  const c = await env.CRM_DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!c || ["sending", "scheduled"].indexOf(c.status) === -1) return null;
  let why = null;
  if (c.complaint_count >= 2) why = "complaints " + c.complaint_count;
  else if (c.sent_count && c.bounce_count / c.sent_count > 0.05 && (c.bounce_count >= 3 || c.sent_count >= 10))
    why = `bounce rate ${c.bounce_count}/${c.sent_count}`;
  if (!why) return null;
  await env.CRM_DB.prepare("UPDATE campaigns SET status = 'paused', fail_reason = ?, updated_at = ? WHERE id = ?")
    .bind("auto-paused: " + why, new Date().toISOString(), campaignId).run();
  return why;
}

/* Returns { status, body }. */
export async function handleResendWebhook(env, headers, raw, opts) {
  opts = opts || {};
  const v = await verifySvix(env.RESEND_WEBHOOK_SECRET, headers, raw, opts.nowSec);
  if (v) return { status: v === "no_secret" ? 503 : 401, body: { error: v } };
  await ensureCampaignTables(env);
  let ev; try { ev = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: "bad json" } }; }
  const db = env.CRM_DB, now = new Date().toISOString();
  const type = String(ev.type || ""), data = ev.data || {};
  const pid = data.email_id || data.id || null;
  const to = normEmail(Array.isArray(data.to) ? data.to[0] : data.to);
  const ins = await db.prepare(`INSERT OR IGNORE INTO email_events (provider, provider_event_id, provider_message_id, type, to_email, payload_json, received_at)
      VALUES ('resend', ?, ?, ?, ?, ?, ?)`).bind(headers.get("svix-id"), pid, type, to || null, raw.slice(0, 20000), now).run();
  if (!ins.meta.changes) return { status: 200, body: { ok: true, duplicate: true } };
  const m = pid ? await db.prepare("SELECT * FROM campaign_messages WHERE provider_message_id = ?").bind(pid).first() : null;
  const addr = (m && m.to_email) || to;
  const out = { ok: true, type, message_id: m ? m.id : null };
  if (type === "email.delivered" && m) {
    await db.prepare("UPDATE campaign_messages SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END, delivered_at = ?, updated_at = ? WHERE id = ?").bind(now, now, m.id).run();
  } else if (type === "email.bounced") {
    const b = data.bounce || {};
    const hard = !/transient|soft|temporary/i.test(String(b.type || data.bounce_type || "Permanent"));
    if (m) {
      await db.prepare("UPDATE campaign_messages SET status = ?, bounced_at = ?, bounce_type = ?, updated_at = ? WHERE id = ?")
        .bind(hard ? "bounced" : m.status, now, hard ? "hard" : "soft", now, m.id).run();
      if (hard) await db.prepare("UPDATE campaigns SET bounce_count = bounce_count + 1 WHERE id = ?").bind(m.campaign_id).run();
    }
    if (hard && addr) {
      await addSuppression(env, "email", addr, "hard_bounce", "resend_webhook");
      await db.prepare("UPDATE lead_emails SET verification_status = 'invalid' WHERE lower(email) = ?").bind(addr).run();
      out.suppressed = addr;
    } else if (addr) {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM email_events WHERE type = 'email.bounced' AND to_email = ? AND received_at >= ? AND payload_json NOT LIKE '%Permanent%'")
        .bind(addr, since).first()).n;
      if (n >= 3) { await addSuppression(env, "email", addr, "soft_bounce_x3", "resend_webhook"); out.suppressed = addr; }
    }
    if (m) out.paused = await circuitBreaker(env, m.campaign_id);
  } else if (type === "email.complained") {
    if (m) {
      await db.prepare("UPDATE campaign_messages SET status = 'complained', complained_at = ?, updated_at = ? WHERE id = ?").bind(now, now, m.id).run();
      await db.prepare("UPDATE campaigns SET complaint_count = complaint_count + 1 WHERE id = ?").bind(m.campaign_id).run();
      await db.prepare("UPDATE clients SET do_not_contact = 1, updated_at = ? WHERE id = ? AND source = 'pipeline_intl'").bind(now, m.client_id).run();
    }
    if (addr) {
      await addSuppression(env, "email", addr, "complaint", "resend_webhook");
      // Domain too, unless it is a shared mailbox provider.
      const d = emailDomain(addr);
      if (d && CAMPAIGN_FREEMAIL.indexOf(d) === -1) await addSuppression(env, "domain", d, "complaint", "resend_webhook");
      out.suppressed = addr;
    }
    if (m) out.paused = await circuitBreaker(env, m.campaign_id);
  }
  return { status: 200, body: out };
}
