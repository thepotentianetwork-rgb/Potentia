/* GET /api/briefing/potentia — Jarvis report over Potentia's OWN CRM
 * (env.CRM_DB, D1 potentia-crm). Read-only: every statement is a SELECT.
 * Separate from briefing.js on purpose: that one reads the ShedPro shed DB
 * (env.DB) and must never be pointed at CRM_DB, nor this at DB.
 * Missing tables (lead_emails etc. are created lazily) read as empty.
 * Nothing here sends mail or touches OUTREACH_* / campaigns.
 */
export const POTENTIA_CRM_SQL = {
  byStatus: `SELECT COALESCE(status,'unknown') AS k, COUNT(*) AS n FROM clients GROUP BY 1 ORDER BY n DESC`,
  bySource: `SELECT COALESCE(NULLIF(source,''),'unknown') AS k, COUNT(*) AS n FROM clients GROUP BY 1 ORDER BY n DESC`,
  newClients: `SELECT id, business_name, contact_name, status, source, created_at FROM clients WHERE created_at >= ? ORDER BY created_at DESC LIMIT 25`,
  newBySource: `SELECT COALESCE(NULLIF(source,''),'unknown') AS k, COUNT(*) AS n FROM clients WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC`,
  recentNotes: `SELECT n.client_id, n.text, n.created_at, c.business_name FROM client_notes n LEFT JOIN clients c ON c.id = n.client_id WHERE n.created_at >= ? ORDER BY n.created_at DESC LIMIT 15`,
  tasksDue: `SELECT t.id, t.client_id, t.title, t.due_date, c.business_name FROM client_tasks t LEFT JOIN clients c ON c.id = t.client_id WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date LIMIT 25`,
  mrr: `SELECT COALESCE(SUM(monthly_fee),0) AS mrr, COUNT(*) AS live FROM clients WHERE status = 'live'`,
  emails: `SELECT eligibility AS k, COUNT(*) AS n FROM lead_emails GROUP BY 1`
};

async function q(db, sql, ...args) {
  try { return (await db.prepare(sql).bind(...args).all()).results || []; }
  catch { return []; }
}
const toMap = (rows) => Object.fromEntries(rows.map(r => [r.k, r.n]));

export function buildPotentiaReport(rows, { nowMs, days }) {
  const by_status = toMap(rows.byStatus), by_source = toMap(rows.bySource);
  const total = Object.values(by_status).reduce((a, b) => a + b, 0);
  const newN = rows.newClients.length;
  const m = rows.mrr[0] || {};
  const src = Object.entries(toMap(rows.newBySource)).map(([k, n]) => `${n} from ${k.replace(/_/g, ' ')}`).join(', ');
  const spoken = [
    `Potentia CRM: ${total} clients in total, ${by_status.lead || 0} open leads, ${m.live || 0} live.`,
    newN ? `${newN} new in the last ${days === 1 ? 'day' : days + ' days'}${src ? ': ' + src : ''}.` : `No new clients in the last ${days === 1 ? 'day' : days + ' days'}.`,
    rows.tasksDue.length ? `${rows.tasksDue.length} task${rows.tasksDue.length === 1 ? '' : 's'} due.` : ''
  ].filter(Boolean).join(' ');
  return {
    crm: 'potentia', database: 'potentia-crm', generated_at: new Date(nowMs).toISOString(), days,
    totals: { clients: total, by_status, by_source, live: m.live || 0, mrr: m.mrr || 0 },
    new_clients: rows.newClients, new_by_source: toMap(rows.newBySource),
    recent_notes: rows.recentNotes.map(n => ({ ...n, text: String(n.text || '').slice(0, 200) })),
    tasks_due: rows.tasksDue, lead_emails_by_eligibility: toMap(rows.emails), spoken
  };
}

export async function loadPotentiaReport(db, { nowMs, days = 1 }) {
  if (!db) return { crm: 'potentia', error: 'CRM_DB not bound' };
  const from = new Date(nowMs - days * 86400000).toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(nowMs));
  const S = POTENTIA_CRM_SQL;
  const [byStatus, bySource, newClients, newBySource, recentNotes, tasksDue, mrr, emails] = await Promise.all([
    q(db, S.byStatus), q(db, S.bySource), q(db, S.newClients, from), q(db, S.newBySource, from),
    q(db, S.recentNotes, from), q(db, S.tasksDue, today), q(db, S.mrr), q(db, S.emails)]);
  return buildPotentiaReport({ byStatus, bySource, newClients, newBySource, recentNotes, tasksDue, mrr, emails }, { nowMs, days });
}
