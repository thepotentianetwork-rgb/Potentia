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
 */

export const QUERY_VIEWS = ['customers', 'customer', 'leads', 'quotes', 'invoices', 'payments', 'schedule', 'revenue'];
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
  if (c.w && c.l) bits.push(c.w + 'x' + c.l);
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
