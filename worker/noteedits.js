/* EDITABLE NOTES (Nando, 12 Oct 2026).
   (1) CRM notes (notes table) can be edited or deleted; (2) a quote's
   Customer Notes (details.notes, printed on the customer quote) can be edited.
   Every change keeps the old text in note_edits (who, when, old -> new), and
   nothing else is touched: no re-price, the redline, quotedPrice,
   adjustments and effective_price are never read or written, so it works on
   orders with a deposit. Logins are a shared staff password, so "editor" is
   the name staff type once in the CRM (kept in their browser), else "staff". */
export const NOTE_MAX = 2000;
export const CUSTOMER_NOTES_MAX = 4000;

export async function ensureNoteEditTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS note_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- 'crm_note' | 'customer_notes'
    action TEXT NOT NULL,            -- 'edit' | 'delete'
    note_id INTEGER, submission_id INTEGER, customer_id INTEGER,
    old_text TEXT, new_text TEXT, editor TEXT, edited_at TEXT NOT NULL)`).run();
  const { results } = await env.DB.prepare("PRAGMA table_info(notes)").all();
  const have = new Set((results || []).map((r) => r.name));
  if (!have.has("edited_at")) await env.DB.prepare("ALTER TABLE notes ADD COLUMN edited_at TEXT").run();
  if (!have.has("edited_by")) await env.DB.prepare("ALTER TABLE notes ADD COLUMN edited_by TEXT").run();
}
export function editorOf(body) {
  const e = String((body && body.editor) || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  return e || "staff";
}
async function audit(env, a) {
  await env.DB.prepare("INSERT INTO note_edits (kind, action, note_id, submission_id, customer_id, old_text, new_text, editor, edited_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(a.kind, a.action, a.note_id ?? null, a.submission_id ?? null, a.customer_id ?? null, a.old_text ?? null, a.new_text ?? null, a.editor, a.at).run();
}

/* POST /admin/notes/:id { text, editor } */
export async function editCrmNote(env, id, body) {
  await ensureNoteEditTables(env);
  const row = await env.DB.prepare("SELECT id, customer_id, text FROM notes WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "Not found" } };
  const text = String((body && body.text) || "").trim().slice(0, NOTE_MAX);
  if (!text) return { status: 400, body: { error: "text required (use Delete to remove a note)" } };
  if (text === row.text) return { status: 200, body: { ok: true, id, changed: false } };
  const at = new Date().toISOString(), editor = editorOf(body);
  await audit(env, { kind: "crm_note", action: "edit", note_id: id, customer_id: row.customer_id, old_text: row.text, new_text: text, editor, at });
  await env.DB.prepare("UPDATE notes SET text = ?, edited_at = ?, edited_by = ? WHERE id = ?").bind(text, at, editor, id).run();
  return { status: 200, body: { ok: true, id, changed: true, edited_at: at, edited_by: editor } };
}

/* DELETE /admin/notes/:id { editor } — the text survives in note_edits. */
export async function deleteCrmNote(env, id, body) {
  await ensureNoteEditTables(env);
  const row = await env.DB.prepare("SELECT id, customer_id, text FROM notes WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "Not found" } };
  const at = new Date().toISOString(), editor = editorOf(body);
  await audit(env, { kind: "crm_note", action: "delete", note_id: id, customer_id: row.customer_id, old_text: row.text, new_text: null, editor, at });
  await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return { status: 200, body: { ok: true, id, deleted: true } };
}

/* POST /admin/submissions/:id/customer-notes { notes, editor }
   Rewrites details.notes only (plus details.notesEditedAt/By). */
export async function editCustomerNotes(env, id, body) {
  await ensureNoteEditTables(env);
  const row = await env.DB.prepare("SELECT id, customer_id, details FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "Not found" } };
  if (!body || typeof body.notes !== "string") return { status: 400, body: { error: "notes required" } };
  let details;
  try { details = JSON.parse(row.details) || {}; } catch (e) { return { status: 409, body: { error: "This order's details could not be read" } }; }
  const next = body.notes.replace(/\r\n/g, "\n").trim().slice(0, CUSTOMER_NOTES_MAX);
  const old = typeof details.notes === "string" ? details.notes : "";
  if (next === old) return { status: 200, body: { ok: true, id, changed: false } };
  const at = new Date().toISOString(), editor = editorOf(body);
  const nd = Object.assign({}, details, { notes: next, notesEditedAt: at, notesEditedBy: editor });
  const text = JSON.stringify(nd);
  if (text.length > 20000) return { status: 413, body: { error: "Notes too long for this order" } };
  await audit(env, { kind: "customer_notes", action: "edit", submission_id: id, customer_id: row.customer_id, old_text: old, new_text: next, editor, at });
  await env.DB.prepare("UPDATE submissions SET details = ? WHERE id = ?").bind(text, id).run();
  return { status: 200, body: { ok: true, id, changed: true, notes: next, edited_at: at, edited_by: editor } };
}

/* GET /admin/customers/:id/note-edits — the audit trail, newest first. */
export async function listNoteEdits(env, customerId) {
  await ensureNoteEditTables(env);
  const { results } = await env.DB.prepare("SELECT * FROM note_edits WHERE customer_id = ? ORDER BY edited_at DESC, id DESC LIMIT 200").bind(customerId).all();
  return { status: 200, body: { edits: results || [] } };
}
