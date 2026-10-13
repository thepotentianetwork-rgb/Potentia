/* QUOTE HISTORY (Nando, 13 Oct 2026).
   Every submission a customer makes is its own quote and is kept as it was:
   a resubmit INSERTs a new row and never rewrites an older one (prices,
   design, adjustments and history on older quotes are untouched). Staff can
   mark ONE quote per customer as the chosen / accepted one (submissions.chosen_at),
   e.g. when the customer goes back to an older design. */

export async function ensureChosenColumn(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(submissions)").all();
  if (!(results || []).some((r) => r.name === "chosen_at")) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN chosen_at TEXT").run();
  }
}

/* POST /admin/submissions/:id/choose { chosen: true|false }
   Marks this quote as the customer's chosen one and clears the mark on their
   other quotes. Only chosen_at (and, for a quote that was auto-"superseded" by
   a later resubmit, status back to 'quoted') is written: no re-price, no
   adjustments, no effective_price. Works on orders with deposits. */
export async function chooseQuote(env, id, body) {
  await ensureChosenColumn(env);
  const row = await env.DB.prepare("SELECT id, customer_id, status, chosen_at FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "Not found" } };
  const on = !(body && body.chosen === false);
  const at = new Date().toISOString();
  if (on) {
    if (row.customer_id != null) {
      await env.DB.prepare("UPDATE submissions SET chosen_at = NULL WHERE customer_id = ? AND id != ? AND chosen_at IS NOT NULL").bind(row.customer_id, id).run();
    }
    await env.DB.prepare("UPDATE submissions SET chosen_at = ?, status = CASE WHEN status = 'superseded' THEN 'quoted' ELSE status END WHERE id = ?").bind(at, id).run();
  } else {
    await env.DB.prepare("UPDATE submissions SET chosen_at = NULL WHERE id = ?").bind(id).run();
  }
  try {
    await env.DB.prepare("INSERT INTO notes (customer_id, text, created_at) VALUES (?,?,?)")
      .bind(row.customer_id, on ? "Quote #" + id + " marked as the chosen quote (staff)." : "Quote #" + id + " no longer marked as chosen (staff).", at).run();
  } catch (e) {}
  return { status: 200, body: { ok: true, id, chosen: on, chosen_at: on ? at : null } };
}

/* AVERAGE QUOTED PRICE — only customers ShedPro actually quoted.
   A customer counts once, and only if staff sent them a quote. There is no
   "quote sent" record in the data, so "sent" is read from the pipeline status
   staff set: quoted, won or lost (a lost customer was still quoted). Designer
   submissions still at new / contacted / superseded / consult never got a
   quote from us and are left out.
   Each counted customer contributes ONE price:
     (a customer with no quoted/won/lost row is skipped even if one is marked chosen)
     1. their chosen quote, if staff marked one (that is the one they went with);
     2. else their won quote (the newest, if several);
     3. else their newest quoted/lost quote.
   Every resubmit is NOT a data point: averaging six iterations of one shed
   would let the loudest customer set the number.
   rows: { id, customer_id, status, created_at, chosen_at, price } (price =
   effective price after adjustments). Returns { avg, median, count, perCustomer }. */
export const SENT_STATUSES = ["quoted", "won", "lost"];
export function quotedAverage(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const p = Number(r.price);
    if (r.price == null || !isFinite(p)) continue;
    const key = r.customer_id != null ? "c" + r.customer_id : "row" + r.id;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const picked = [];
  for (const [key, list] of by) {
    const newest = (xs) => xs.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || (b.id - a.id))[0];
    const chosen = list.filter((r) => r.chosen_at);
    const won = list.filter((r) => r.status === "won");
    const sent = list.filter((r) => SENT_STATUSES.includes(r.status));
    const pick = !sent.length && !chosen.some((r) => SENT_STATUSES.includes(r.status)) ? null : chosen.length ? newest(chosen) : won.length ? newest(won) : sent.length ? newest(sent) : null;
    if (pick) picked.push({ key, id: pick.id, price: Number(pick.price), rule: chosen.length ? "chosen" : won.length ? "won" : "latest sent" });
  }
  const prices = picked.map((x) => x.price).sort((a, b) => a - b);
  const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const median = prices.length ? Math.round(prices[Math.floor(prices.length / 2)]) : null;
  return { avg, median, count: prices.length, perCustomer: picked };
}
