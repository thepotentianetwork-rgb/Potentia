import { porchAddsSize } from "./pricing.js";
/* GET /api/briefing/query?view=<view>&q=&days=&status=&limit=
 * "Jarvis, pull up ..." : one read-only lookup over the ShedPro CRM, shaped
 * for a screen: { view, title, columns, rows, cards?, summary }.
 *
 * Read-only, behind the same BRIEFING_API_KEY as the rest of /api/briefing.
 * Every statement here is a SELECT. A table or column that does not exist yet
 * (the worker adds some lazily) yields an empty list, never an error or a write.
 *
 * Views:
 *   customers  search customers by name/email/phone/city (q optional)
 *   customer   one customer (q = name/email/phone): profile, quotes, payments,
 *              invoices, installs, latest notes
 *   leads      customers created in the last `days` (default 14)
 *   quotes     submissions in the last `days` (default 30), status filter
 *              new|quoted|won|lost; superseded versions left out
 *   invoices   Stripe invoices; status open (default: not paid/void) | paid | all
 *   payments   payments logged in the last `days` (default 30)
 *   schedule   installs from today to today+`days` (default 14), not done
 *   revenue    payments, won quotes and open invoices over `days` (default 30)
 *   installs   install history: completed stages (done_at set) by month and by week over
 *              `days` (default 365), bucketed by install_date; won orders only; read-only
 */

export const QUERY_VIEWS = ['customers', 'customer', 'leads', 'quotes', 'invoices', 'payments', 'schedule', 'revenue', 'stats', 'installs'];
const CQ_TZ = 'America/Denver';

function cqStr(v) { return String(v == null ? '' : v).trim(); }
function cqJson(s) { if (s && typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } }
function cqDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CQ_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function cqMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function cqTotal(s) {
  if (s.effective_price != null && Number.isFinite(Number(s.effective_price))) return Math.round(Number(s.effective_price) * 100) / 100;
  const d = cqJson(s.details) || {};
  const p = Number(d.quotedPrice);
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) / 100 : null;
}
function cqDesign(details) {
  const c = (cqJson(details) || {}).config || {};
  const bits = [];
  const pa = porchAddsSize(c);
  if (pa) bits.push(pa.w + 'x' + pa.l + ' + ' + pa.porch);
  else if (c.w && c.l) bits.push(c.w + 'x' + c.l);
  if (c.style) bits.push(String(c.style));
  return bits.join(' ');
}
function cqInt(v, def, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
async function cqAll(db, sql, ...args) {
  try {
    const st = db.prepare(sql);
    const r = await (args.length ? st.bind(...args) : st).all();
    return (r && r.results) || [];
  } catch { return []; } // missing table/column: nothing to show yet
}
const cqCols = (pairs) => pairs.map(([key, label]) => ({ key, label }));
function cqTokens(q) {
  return cqStr(q).toLowerCase().replace(/['\u2019]s\b/g, '').replace(/[^a-z0-9@. ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
}
/* Every token must appear in name, email, phone or city. */
function cqMatch(c, toks) {
  const hay = [c.name, c.email, c.phone, c.city].map(cqStr).join(' ').toLowerCase();
  const digits = hay.replace(/\D/g, '');
  return toks.every((t) => hay.includes(t) || (/^\d{3,}$/.test(t) && digits.includes(t)));
}

export function parseQueryParams(sp) {
  const view = cqStr(sp.get('view')).toLowerCase();
  return { view, q: cqStr(sp.get('q')).slice(0, 100), status: cqStr(sp.get('status')).toLowerCase(), days: sp.get('days'), limit: cqInt(sp.get('limit'), 25, 100) };
}

export async function runQuery(db, p, { nowMs }) {
  const today = cqDay(nowMs);
  const since = (days) => new Date(nowMs - days * 86400000).toISOString();
  const base = { view: p.view, generated_at: new Date(nowMs).toISOString() };

  if (!QUERY_VIEWS.includes(p.view)) return { status: 400, error: 'view must be one of ' + QUERY_VIEWS.join(', ') };
  if (p.view === 'stats') return statsView(db, nowMs);

  if (p.view === 'customers' || p.view === 'customer') {
    const toks = cqTokens(p.q);
    if (p.view === 'customer' && !toks.length) return { status: 400, error: 'q is required' };
    let list = await cqAll(db, 'SELECT id, name, email, phone, city, created_at FROM customers ORDER BY created_at DESC LIMIT 2000');
    if (toks.length) list = list.filter((c) => cqMatch(c, toks));
    if (p.view === 'customers') {
      const rows = list.slice(0, p.limit).map((c) => ({ id: c.id, name: c.name, city: c.city, phone: c.phone, email: c.email, since: cqStr(c.created_at).slice(0, 10) }));
      return { ...base, title: p.q ? 'CUSTOMERS: ' + p.q.toUpperCase() : 'CUSTOMERS', columns: cqCols([['name', 'Name'], ['city', 'City'], ['phone', 'Phone'], ['email', 'Email'], ['since', 'Since']]), rows,
        summary: list.length ? (list.length === 1 ? 'One customer matches.' : list.length + ' customers match.') : 'No customers match.' };
    }
    if (!list.length) return { status: 404, ...base, found: false, error: 'No customer matches ' + p.q, summary: 'I couldn\u2019t find a customer called ' + p.q + '.' };
    const c = list[0];
    const [subs, pays, invs, notes] = await Promise.all([
      cqAll(db, 'SELECT * FROM submissions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20', c.id),
      cqAll(db, 'SELECT amount, method, note, paid_at FROM payments WHERE customer_id = ? ORDER BY paid_at DESC LIMIT 20', c.id),
      cqAll(db, 'SELECT kind, amount, status, created_at, paid_at FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20', c.id),
      cqAll(db, 'SELECT text, created_at FROM notes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5', c.id),
    ]);
    const ids = subs.map((s) => Number(s.id)).filter(Number.isInteger);
    const installs = ids.length ? await cqAll(db, 'SELECT submission_id, item, install_date, done_at FROM installs WHERE submission_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY install_date', ...ids) : [];
    const live = subs.filter((s) => s.status !== 'superseded');
    const paid = pays.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const won = live.find((s) => s.status === 'won');
    const cards = [
      { title: 'PROFILE', lines: [c.name, c.city, c.phone, c.email, 'Customer since ' + cqStr(c.created_at).slice(0, 10)].filter(Boolean) },
      { title: 'QUOTES', lines: live.map((s) => '#' + s.id + ' ' + (cqDesign(s.details) || 'design') + ' \u2014 ' + s.status + (cqTotal(s) != null ? ', ' + cqMoney(cqTotal(s)) : '')) },
      { title: 'PAYMENTS', lines: pays.map((x) => cqStr(x.paid_at).slice(0, 10) + ' ' + cqMoney(x.amount) + ' ' + cqStr(x.method)).concat(pays.length ? ['Total paid: ' + cqMoney(paid)] : []) },
      { title: 'INVOICES', lines: invs.map((x) => cqStr(x.kind) + ' ' + cqMoney(x.amount) + ' \u2014 ' + cqStr(x.status)) },
      { title: 'INSTALLS', lines: installs.map((x) => cqStr(x.install_date) + ' ' + cqStr(x.item) + (x.done_at ? ' (done)' : '')) },
      { title: 'LATEST NOTES', lines: notes.map((n) => cqStr(n.created_at).slice(0, 10) + ': ' + cqStr(n.text).slice(0, 200)) },
    ].filter((k) => k.lines.length);
    return { ...base, found: true, title: 'CUSTOMER: ' + cqStr(c.name).toUpperCase(), customer: { id: c.id, name: c.name }, cards, other_matches: list.slice(1, 5).map((x) => x.name),
      summary: c.name + (won ? ' has a won order' + (cqTotal(won) != null ? ' at ' + cqMoney(cqTotal(won)) : '') : live.length ? ' has ' + live.length + (live.length === 1 ? ' quote' : ' quotes') : ' has no quotes yet') + (pays.length ? ', with ' + cqMoney(paid) + ' paid.' : '.') };
  }

  if (p.view === 'leads') {
    const days = cqInt(p.days, 14, 365);
    const list = await cqAll(db, 'SELECT id, name, city, phone, email, created_at FROM customers WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?', since(days), p.limit);
    return { ...base, title: 'NEW LEADS (LAST ' + days + ' DAYS)', columns: cqCols([['name', 'Name'], ['city', 'City'], ['phone', 'Phone'], ['created', 'Came in']]),
      rows: list.map((c) => ({ id: c.id, name: c.name, city: c.city, phone: c.phone, created: cqStr(c.created_at).slice(0, 10) })),
      summary: list.length ? list.length + (list.length === 1 ? ' new lead' : ' new leads') + ' in the last ' + days + ' days.' : 'No new leads in the last ' + days + ' days.' };
  }

  if (p.view === 'quotes') {
    const days = cqInt(p.days, 30, 365);
    const st = ['new', 'quoted', 'won', 'lost'].includes(p.status) ? p.status : '';
    let list = await cqAll(db, "SELECT s.*, c.name AS customer_name FROM submissions s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.created_at >= ? AND s.status != 'superseded' ORDER BY s.created_at DESC LIMIT 500", since(days));
    if (st) list = list.filter((s) => s.status === st);
    const sum = list.reduce((a, s) => a + (cqTotal(s) || 0), 0);
    return { ...base, title: (st ? st.toUpperCase() + ' ' : '') + 'QUOTES (LAST ' + days + ' DAYS)', columns: cqCols([['customer', 'Customer'], ['design', 'Design'], ['status', 'Status'], ['total', 'Total'], ['date', 'Date']]),
      rows: list.slice(0, p.limit).map((s) => ({ id: s.id, customer: s.customer_name || s.name, design: cqDesign(s.details), status: s.status, total: cqMoney(cqTotal(s)), date: cqStr(s.created_at).slice(0, 10) })),
      summary: list.length ? list.length + (list.length === 1 ? ' quote' : ' quotes') + ' totalling ' + cqMoney(sum) + '.' : 'No quotes in that window.' };
  }

  if (p.view === 'invoices') {
    const st = ['paid', 'all'].includes(p.status) ? p.status : 'open';
    let list = await cqAll(db, 'SELECT i.kind, i.amount, i.status, i.created_at, i.paid_at, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id ORDER BY i.created_at DESC LIMIT 500');
    if (st === 'open') list = list.filter((x) => x.status !== 'paid' && x.status !== 'void' && !x.paid_at);
    if (st === 'paid') list = list.filter((x) => x.status === 'paid' || x.paid_at);
    const sum = list.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    return { ...base, title: st === 'open' ? 'OPEN INVOICES (DEPOSITS & BALANCES DUE)' : st.toUpperCase() + ' INVOICES', columns: cqCols([['customer', 'Customer'], ['kind', 'Type'], ['amount', 'Amount'], ['status', 'Status'], ['date', 'Created']]),
      rows: list.slice(0, p.limit).map((x) => ({ customer: x.customer_name, kind: x.kind, amount: cqMoney(x.amount), status: x.status, date: cqStr(x.created_at).slice(0, 10) })),
      summary: list.length ? list.length + (list.length === 1 ? ' invoice' : ' invoices') + ', ' + cqMoney(sum) + ' in total.' : (st === 'open' ? 'Nothing outstanding.' : 'No invoices.') };
  }

  if (p.view === 'payments') {
    const days = cqInt(p.days, 30, 365);
    const list = await cqAll(db, 'SELECT p.amount, p.method, p.paid_at, c.name AS customer_name FROM payments p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.paid_at >= ? ORDER BY p.paid_at DESC LIMIT 500', since(days).slice(0, 10));
    const sum = list.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    return { ...base, title: 'PAYMENTS (LAST ' + days + ' DAYS)', columns: cqCols([['date', 'Date'], ['customer', 'Customer'], ['amount', 'Amount'], ['method', 'Method']]),
      rows: list.slice(0, p.limit).map((x) => ({ date: cqStr(x.paid_at).slice(0, 10), customer: x.customer_name, amount: cqMoney(x.amount), method: x.method })),
      summary: list.length ? cqMoney(sum) + ' collected across ' + list.length + (list.length === 1 ? ' payment' : ' payments') + '.' : 'No payments logged in the last ' + days + ' days.' };
  }

  if (p.view === 'installs') {
    const days = cqInt(p.days, 365, 730);
    const from = cqDay(nowMs - days * 86400000);
    const list = await cqAll(db, "SELECT i.install_date, i.item, i.done_at FROM installs i JOIN submissions s ON s.id = i.submission_id WHERE s.status = 'won' AND i.install_date >= ? AND i.install_date <= ? ORDER BY i.install_date", from, today);
    const wk = (d) => { const t = new Date(d + 'T00:00:00Z'); return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); };
    const months = {}, weeks = {};
    const bump = (o, k, x) => { const b = o[k] || (o[k] = { period: k, completed: 0, sheds: 0, missed: 0 });
      if (x.done_at) { b.completed++; if (x.item === 'shed') b.sheds++; } else b.missed++; };
    for (const x of list) { const d = cqStr(x.install_date).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; bump(months, d.slice(0, 7), x); bump(weeks, wk(d), x); }
    const done = list.filter((x) => x.done_at);
    return { ...base, title: 'INSTALL HISTORY (LAST ' + days + ' DAYS)', timezone: CQ_TZ, week_starts: 'Monday', columns: cqCols([['period', 'Month'], ['completed', 'Stages done'], ['sheds', 'Sheds installed'], ['missed', 'Past, not marked done']]),
      rows: Object.values(months), months: Object.values(months), weeks: Object.values(weeks),
      totals: { completed: done.length, sheds: done.filter((x) => x.item === 'shed').length, missed: list.length - done.length },
      summary: done.length ? done.length + (done.length === 1 ? ' install stage' : ' install stages') + ' completed in the last ' + days + ' days, ' + done.filter((x) => x.item === 'shed').length + ' of them shed installs.' : 'No completed installs in the last ' + days + ' days.' };
  }

  if (p.view === 'schedule') {
    const days = cqInt(p.days, 14, 120);
    const end = cqDay(nowMs + days * 86400000);
    const list = await cqAll(db, 'SELECT i.install_date, i.item, i.days, i.done_at, s.id AS submission_id, c.name AS customer_name, c.city FROM installs i JOIN submissions s ON s.id = i.submission_id LEFT JOIN customers c ON c.id = s.customer_id WHERE i.install_date >= ? AND i.install_date <= ? AND i.done_at IS NULL ORDER BY i.install_date LIMIT ?', today, end, p.limit);
    return { ...base, title: 'UPCOMING INSTALLS (NEXT ' + days + ' DAYS)', columns: cqCols([['date', 'Date'], ['customer', 'Customer'], ['city', 'City'], ['item', 'Stage']]),
      rows: list.map((x) => ({ date: x.install_date, customer: x.customer_name, city: x.city, item: x.item })),
      summary: list.length ? list.length + (list.length === 1 ? ' install' : ' installs') + ' on the calendar, first on ' + list[0].install_date + '.' : 'Nothing on the install calendar for the next ' + days + ' days.' };
  }

  // revenue
  const days = cqInt(p.days, 30, 365);
  const [pays, subs, invs] = await Promise.all([
    cqAll(db, 'SELECT amount FROM payments WHERE paid_at >= ?', since(days).slice(0, 10)),
    cqAll(db, "SELECT * FROM submissions WHERE status = 'won' ORDER BY created_at DESC LIMIT 1000"),
    cqAll(db, 'SELECT amount, status, paid_at FROM invoices'),
  ]);
  const cutoff = since(days);
  const wonIn = subs.filter((s) => cqStr(s.won_at || s.created_at) >= cutoff);
  const collected = pays.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const booked = wonIn.reduce((a, s) => a + (cqTotal(s) || 0), 0);
  const open = invs.filter((x) => x.status !== 'paid' && x.status !== 'void' && !x.paid_at);
  const owed = open.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  return { ...base, title: 'REVENUE (LAST ' + days + ' DAYS)', columns: cqCols([['metric', 'Metric'], ['value', 'Value']]),
    rows: [
      { metric: 'Collected (payments logged)', value: cqMoney(collected) },
      { metric: 'Payments', value: String(pays.length) },
      { metric: 'Booked (won orders)', value: cqMoney(booked) },
      { metric: 'Won orders', value: String(wonIn.length) },
      { metric: 'Open invoices outstanding', value: cqMoney(owed) + ' (' + open.length + ')' },
    ],
    summary: cqMoney(collected) + ' collected and ' + cqMoney(booked) + ' booked in the last ' + days + ' days.' };
}

/* ---- stats: monthly + weekly (Mon-Sun, America/Denver) funnel, all history. Pure. ----
   leads = new customers; requests = non-superseded submissions; quotes = non-superseded
   submissions past 'new' with a price; quoted customers counted once, in the period of their
   first quote (cohort), converted if any of their submissions is won (ever);
   revenue/avg sale = won totals by won date; collected = payments by paid date. */
const ST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
function stDay(iso) { const t = Date.parse(iso || ''); return isNaN(t) ? null : ST_FMT.format(new Date(t)); }
function stWeek(day) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function stPrice(s) { if (s.effective_price != null && isFinite(Number(s.effective_price))) return Number(s.effective_price);
  try { const q = JSON.parse(s.details || '{}').quotedPrice; return isFinite(Number(q)) ? Number(q) : 0; } catch { return 0; } }
export function computeStats(subs, custs, pays) {
  const live = subs.filter((s) => s.status !== 'superseded');
  const isQuote = (s) => s.status !== 'new' && stPrice(s) > 0;
  const firstQuote = new Map(), wonCust = new Set();
  for (const s of live.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (isQuote(s) && !firstQuote.has(s.customer_id)) firstQuote.set(s.customer_id, stDay(s.created_at));
    if (s.status === 'won') wonCust.add(s.customer_id);
  }
  const build = (key) => {
    const m = new Map(); const g = (k) => { if (!m.has(k)) m.set(k, { period: k, leads: 0, requests: 0, quotes: 0, quoted_customers: 0, converted_customers: 0, won_quotes: 0, revenue: 0, collected: 0, lost: 0, lost_value: 0, lost_by_reason: {} }); return m.get(k); };
    for (const c of custs) { const d = stDay(c.created_at); if (d) g(key(d)).leads++; }
    for (const s of live) { const d = stDay(s.created_at); if (!d) continue; g(key(d)).requests++; if (isQuote(s)) g(key(d)).quotes++;
      if (s.status === 'won') { const w = g(key(stDay(s.won_at || s.created_at))); w.won_quotes++; w.revenue += stPrice(s); }
      if (s.status === 'lost') { const l = g(key(stDay(s.lost_at || s.created_at))); l.lost++; l.lost_value += stPrice(s); const rk = s.lost_reason || 'unknown'; l.lost_by_reason[rk] = (l.lost_by_reason[rk] || 0) + 1; } }
    for (const [cid, d] of firstQuote) { const r = g(key(d)); r.quoted_customers++; if (wonCust.has(cid)) r.converted_customers++; }
    for (const p of pays) { const d = stDay(p.paid_at); if (d) g(key(d)).collected += Number(p.amount) || 0; }
    return [...m.values()].sort((a, b) => a.period.localeCompare(b.period)).map(fin);
  };
  const fin = (r) => ({ ...r, lost_value: Math.round((r.lost_value || 0) * 100) / 100, revenue: Math.round(r.revenue * 100) / 100, collected: Math.round(r.collected * 100) / 100,
    customer_conversion_pct: r.quoted_customers ? Math.round(1000 * r.converted_customers / r.quoted_customers) / 10 : null,
    quote_win_pct: r.quotes ? Math.round(1000 * r.won_quotes / r.quotes) / 10 : null,
    avg_sale: r.won_quotes ? Math.round(r.revenue / r.won_quotes) : null });
  const all = build(() => 'all')[0] || fin({ period: 'all', leads: 0, requests: 0, quotes: 0, quoted_customers: 0, converted_customers: 0, won_quotes: 0, revenue: 0, collected: 0, lost: 0, lost_value: 0, lost_by_reason: {} });
    const lost_quotes = live.filter((s) => s.status === 'lost').map((s) => ({ quote_id: s.id, customer_id: s.customer_id, total: Math.round(stPrice(s) * 100) / 100,
    quoted_on: stDay(s.created_at), lost_on: s.lost_at ? stDay(s.lost_at) : null, reason: s.lost_reason || 'unknown', competitor: s.lost_competitor || null, note: s.lost_note || null }));
  return { totals: all, months: build((d) => d.slice(0, 7)), weeks: build(stWeek), lost_quotes };
}
export async function statsView(db, nowMs) {
  const [subs, custs, pays] = await Promise.all([
    cqAll(db, 'SELECT * FROM submissions'),
    cqAll(db, 'SELECT id, name, created_at FROM customers'), cqAll(db, 'SELECT amount, paid_at FROM payments')]);
  const st = computeStats(subs, custs, pays); const t = st.totals;
  const nm = new Map(custs.map((c) => [c.id, c.name])); for (const l of st.lost_quotes) l.customer = nm.get(l.customer_id) || null;
  const why = Object.entries(t.lost_by_reason || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + ' ' + k).join(', ');
  return { view: 'stats', generated_at: new Date(nowMs).toISOString(), timezone: 'America/Denver', week_starts: 'Monday', ...st,
    summary: `${t.converted_customers} of ${t.quoted_customers} quoted customers bought (${t.customer_conversion_pct}%). ${t.won_quotes} sales, ${cqMoney(t.revenue)} booked, ${cqMoney(t.collected)} collected, average sale ${cqMoney(t.avg_sale || 0)}. ${t.lost} lost${why ? ' (' + why + ')' : ''}.` };
}
