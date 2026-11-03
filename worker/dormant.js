/* Auto-dormant: a design (submission) whose status hasn't moved in 14 days is
   set to 'dormant'. Never deletes. Only open statuses (new / contacted /
   quoted) are touched; won, lost, superseded and dormant itself are left alone.
   Age is measured from status_changed_at, falling back to updated_at, then
   created_at — whichever exists first on the row.
   Only "tried, no response" leads: the customer has at least one logged call
   and none of them connected or came in from the customer. A lead nobody has
   called yet is left alone (Nando, t1434/t1435). */

export const DORMANT_DAYS = 14;
export const DORMANT_FROM = ["new", "contacted", "quoted"];

const ready = new WeakSet();
export async function ensureStatusChangedColumn(db) {
  if (ready.has(db)) return;
  const { results } = await db.prepare("PRAGMA table_info(submissions)").all();
  const have = new Set((results || []).map((r) => r.name));
  if (!have.has("status_changed_at")) await db.prepare("ALTER TABLE submissions ADD COLUMN status_changed_at TEXT").run();
  ready.add(db);
}

async function lastChangeExpr(db) {
  const { results } = await db.prepare("PRAGMA table_info(submissions)").all();
  const have = new Set((results || []).map((r) => r.name));
  const parts = ["status_changed_at", "updated_at", "created_at"].filter((c) => have.has(c));
  return parts.length > 1 ? "COALESCE(" + parts.join(", ") + ")" : parts[0];
}

/* dryRun: returns the rows that would change, writes nothing (not even the column). */
export async function runAutoDormant(db, { now = new Date(), dryRun = false } = {}) {
  if (!dryRun) await ensureStatusChangedColumn(db);
  const cutoff = new Date(now.getTime() - DORMANT_DAYS * 86400000).toISOString();
  const expr = await lastChangeExpr(db);
  const marks = DORMANT_FROM.map(() => "?").join(",");
  const { results: tbls } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'calls'").all();
  if (!(tbls || []).length) return { cutoff, count: 0, rows: [], dryRun };
  const noAnswer = "EXISTS (SELECT 1 FROM calls c WHERE c.customer_id = submissions.customer_id)" +
    " AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.customer_id = submissions.customer_id" +
    " AND (c.outcome = 'connected' OR c.direction = 'inbound'))";
  const { results } = await db.prepare(
    "SELECT id, customer_id, name, status, " + expr + " AS last_change FROM submissions " +
    "WHERE status IN (" + marks + ") AND " + expr + " < ? AND " + noAnswer + " ORDER BY id"
  ).bind(...DORMANT_FROM, cutoff).all();
  const rows = results || [];
  if (!dryRun && rows.length) {
    const at = now.toISOString();
    await db.batch(rows.map((r) => db.prepare(
      "UPDATE submissions SET status = 'dormant', status_changed_at = ? WHERE id = ? AND status IN (" + marks + ")"
    ).bind(at, r.id, ...DORMANT_FROM)));
  }
  return { cutoff, count: rows.length, rows, dryRun };
}
