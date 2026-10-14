/* GET /api/briefing — a read-only morning briefing for a server-to-server
 * caller (a Node process that shows it and reads it aloud).
 *
 * Everything here is PURE: the handler in index.js fetches rows with plain
 * SELECTs and hands them in, together with "now". No clock, no database, so
 * the same functions run in tests and against live rows from a script.
 *
 * Source tables (potentia-shed, bound as DB):
 *   new_leads          customers.created_at in window; source = heardAbout of
 *                      the customer's first submission; city = customers.city
 *                      or that submission's details.city
 *   new_designs        submissions.created_at in window, excluding 'superseded'
 *   pending_proposals  submissions.status = 'quoted' (sent, neither won nor lost);
 *                      total = effective_price ?? details.quotedPrice;
 *                      "sent" = created_at (there is no separate sent stamp)
 *   upcoming_installs  installs.install_date in [today, today+14], done_at null,
 *                      order status 'won'
 *   follow_ups         customers.follow_up_at <= today (dormant included)
 */

export const BRIEFING_TZ = 'America/Denver';
export const SECTIONS = ['new_leads', 'new_designs', 'pending_proposals', 'upcoming_installs', 'follow_ups'];
export const INSTALL_HORIZON_DAYS = 14;

/* The calendar day in Denver for an instant. */
export function denverDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BRIEFING_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/* The UTC instant of Denver midnight starting `day` (YYYY-MM-DD). */
export function denverMidnightUtc(day) {
  const guess = Date.parse(day + 'T00:00:00Z');
  // Offset of Denver at that moment (in minutes); iterate once for DST edges.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: BRIEFING_TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).reduce((o, p) => (o[p.type] = p.value, o), {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    t = guess - (asUtc - t);
  }
  return new Date(t).toISOString();
}

export function shiftDay(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseParams(searchParams) {
  const raw = searchParams.get('days');
  let days = raw == null || raw === '' ? 1 : Math.floor(Number(raw));
  if (!Number.isFinite(days) || days < 1) days = 1;
  if (days > 30) days = 30;
  const s = searchParams.get('sections');
  let sections = SECTIONS.slice();
  if (s) {
    const want = s.split(',').map((x) => x.trim()).filter(Boolean);
    sections = SECTIONS.filter((k) => want.includes(k));
  }
  return { days, sections };
}

/* Window: from Denver midnight (days-1) days ago, to now. */
export function briefingWindow(nowMs, days) {
  const today = denverDay(nowMs);
  const fromDay = shiftDay(today, -(days - 1));
  return { today, from: denverMidnightUtc(fromDay), to: new Date(nowMs).toISOString() };
}

function parseDetails(d) {
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { return JSON.parse(d) || {}; } catch { return {}; }
}

const STYLE_NAMES = { barn: 'barn', gable: 'gable', leanto: 'lean-to', 'lean-to': 'lean-to', modern: 'modern', quaker: 'quaker' };
export function designSummary(details) {
  const c = parseDetails(details).config || {};
  const size = c.w && c.l ? `${c.w}x${c.l}` : null;
  const style = c.style ? (STYLE_NAMES[c.style] || String(c.style)) : null;
  const bits = [size, style].filter(Boolean);
  return bits.length ? bits.join(' ') : null;
}

export function quoteTotal(row) {
  if (row.effective_price != null && Number.isFinite(Number(row.effective_price))) return Math.round(Number(row.effective_price) * 100) / 100;
  const q = parseDetails(row.details).quotedPrice;
  return q != null && Number.isFinite(Number(q)) ? Math.round(Number(q) * 100) / 100 : null;
}

function daysSince(iso, today) {
  const d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
}

/* ---- money in words ---- */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + ' hundred'); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')); }
  else if (n > 0) out.push(ONES[n]);
  return out.join(' ');
}
export function numberWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const out = [];
  for (const [v, w] of scales) {
    if (n >= v) { out.push(under1000(Math.floor(n / v)) + ' ' + w); n %= v; }
  }
  if (n) out.push(under1000(n));
  return out.join(' ');
}
/* Whole dollars, spoken. Cents are rounded away: nobody wants them read out. */
export function moneyWords(amount) {
  const d = Math.round(Number(amount) || 0);
  return numberWords(d) + (d === 1 ? ' dollar' : ' dollars');
}

function plural(n, one, many) { return `${numberWords(n)} ${n === 1 ? one : many}`; }
function spokenDate(day, today) {
  if (day === today) return 'today';
  if (day === shiftDay(today, 1)) return 'tomorrow';
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}
/* Strip anything a TTS engine would read as a symbol. */
function speakable(s) { return String(s || '').replace(/[^\p{L}\p{N}\s'’.,-]/gu, ' ').replace(/\s+/g, ' ').trim(); }

/**
 * rows: { customers, submissions, installs, followups } as returned by the
 * queries in index.js. Returns the full response body.
 */
export function buildBriefing(rows, { nowMs, days = 1, sections = SECTIONS } = {}) {
  const win = briefingWindow(nowMs, days);
  const today = win.today;
  const horizon = shiftDay(today, INSTALL_HORIZON_DAYS);
  const inWindow = (iso) => { const t = Date.parse(iso || ''); return !isNaN(t) && t >= Date.parse(win.from) && t <= nowMs; };
  const subs = rows.submissions || [];
  const firstSubByCustomer = new Map();
  for (const s of subs.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (s.customer_id != null && !firstSubByCustomer.has(s.customer_id)) firstSubByCustomer.set(s.customer_id, s);
  }

  const display = {};
  const counts = {};
  const want = new Set(sections);

  if (want.has('new_leads')) {
    display.new_leads = (rows.customers || []).filter((c) => inWindow(c.created_at))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((c) => {
        const first = firstSubByCustomer.get(c.id);
        const d = first ? parseDetails(first.details) : {};
        return { customer_id: c.id, name: c.name || null, source: d.heardAbout || null,
          city: c.city || d.city || null, created_at: c.created_at };
      });
  }
  if (want.has('new_designs')) {
    display.new_designs = subs.filter((s) => s.status !== 'superseded' && inWindow(s.created_at))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((s) => ({ submission_id: s.id, customer: s.customer_name || s.name || null,
        summary: designSummary(s.details), status: s.status, total: quoteTotal(s), created_at: s.created_at }));
  }
  if (want.has('pending_proposals')) {
    display.pending_proposals = subs.filter((s) => s.status === 'quoted')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((s) => ({ submission_id: s.id, quote_number: s.id, customer: s.customer_name || s.name || null,
        total: quoteTotal(s), sent_at: s.created_at, days_since_sent: daysSince(s.created_at, today) }));
  }
  if (want.has('upcoming_installs')) {
    const all = rows.installs || [];
    display.upcoming_installs = all
      .filter((i) => !i.done_at && i.install_date >= today && i.install_date <= horizon)
      .sort((a, b) => String(a.install_date).localeCompare(String(b.install_date)) || a.id - b.id)
      .map((i) => ({ install_id: i.id, submission_id: i.submission_id, customer: i.customer_name || null,
        city: i.city || null, item: i.item, install_date: i.install_date, days: i.days ?? null }));
    const ids = new Set(all.map((i) => i.submission_id));
    counts.install_date_coverage = {
      won_orders: rows.won_orders ?? null,
      won_orders_with_dates: rows.won_orders == null ? null : (rows.won_with_dates ?? ids.size),
      install_rows: all.length
    };
  }
  if (want.has('follow_ups')) {
    display.follow_ups = (rows.followups || [])
      .filter((c) => c.follow_up_at && String(c.follow_up_at).slice(0, 10) <= today)
      .sort((a, b) => String(a.follow_up_at).localeCompare(String(b.follow_up_at)))
      .map((c) => ({ customer_id: c.id, name: c.name || null, phone: c.phone || null,
        follow_up_at: String(c.follow_up_at).slice(0, 10), days_overdue: daysSince(c.follow_up_at, today),
        dormant: c.temp_override === 'dormant', temp_override: c.temp_override || null }));
  }
  for (const k of SECTIONS) if (display[k]) counts[k] = display[k].length;
  if (display.pending_proposals) {
    counts.pending_proposals_total = Math.round(display.pending_proposals.reduce((a, p) => a + (p.total || 0), 0) * 100) / 100;
  }
  display.counts = counts;

  return { generated_at: new Date(nowMs).toISOString(), timezone: BRIEFING_TZ,
    window: { from: win.from, to: win.to, days, today }, display, spoken: buildSpoken(display, { today, days }) };
}

export function buildSpoken(display, { today, days }) {
  const span = days === 1 ? 'since midnight' : `in the last ${numberWords(days)} days`;
  const out = [];
  if (display.new_leads) {
    const l = display.new_leads;
    if (!l.length) out.push(`No new leads ${span}.`);
    else {
      const top = l[0];
      const where = top.city ? ` from ${speakable(top.city)}` : '';
      out.push(`${cap(plural(l.length, 'new lead', 'new leads'))} ${span}, the latest is ${speakable(top.name) || 'an unnamed customer'}${where}.`);
    }
  }
  if (display.new_designs) {
    const d = display.new_designs;
    if (!d.length) out.push('No new designs came in.');
    else {
      const top = d.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
      const what = top.summary ? ` a ${speakable(top.summary.replace(/(\d+)x(\d+)/, '$1 by $2'))}` : ' a design';
      const price = top.total ? ` at ${moneyWords(top.total)}` : '';
      out.push(`${cap(plural(d.length, 'new design', 'new designs'))}, the biggest is${what} for ${speakable(top.customer) || 'a customer'}${price}.`);
    }
  }
  if (display.pending_proposals) {
    const p = display.pending_proposals;
    if (!p.length) out.push('No proposals are waiting on an answer.');
    else {
      const total = p.reduce((a, x) => a + (x.total || 0), 0);
      const o = p[0];
      out.push(`${cap(plural(p.length, 'proposal is', 'proposals are'))} still open, worth ${moneyWords(total)} together. The oldest is ${speakable(o.customer) || 'a customer'}, sent ${o.days_since_sent === 1 ? 'one day' : numberWords(o.days_since_sent || 0) + ' days'} ago${o.total ? ` for ${moneyWords(o.total)}` : ''}.`);
    }
  }
  if (display.upcoming_installs) {
    const u = display.upcoming_installs;
    if (!u.length) out.push('Nothing is on the install calendar for the next two weeks.');
    else {
      const n = u[0];
      out.push(`${cap(plural(u.length, 'scheduled job', 'scheduled jobs'))} in the next two weeks. Next up is ${speakable(n.item)} for ${speakable(n.customer) || 'a customer'} ${spokenDate(n.install_date, today)}.`);
    }
  }
  if (display.follow_ups) {
    const f = display.follow_ups;
    if (!f.length) out.push('No follow ups are due.');
    else {
      const dormant = f.filter((x) => x.dormant).length;
      const o = f[0];
      const late = o.days_overdue > 0 ? `, ${plural(o.days_overdue, 'day', 'days')} overdue` : ', due today';
      out.push(`${cap(plural(f.length, 'follow up is', 'follow ups are'))} due${dormant ? `, including ${plural(dormant, 'dormant customer', 'dormant customers')}` : ''}. Start with ${speakable(o.name) || 'a customer'}${late}.`);
    }
  }
  return out.join(' ');
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* The SQL, kept here so the live-data script runs exactly the same reads. */
export const BRIEFING_SQL = {
  customers: `SELECT id, name, city, created_at FROM customers WHERE created_at >= ?`,
  submissions: `SELECT s.id, s.customer_id, s.name, s.status, s.created_at, s.effective_price, s.details,
                       c.name AS customer_name
                FROM submissions s LEFT JOIN customers c ON c.id = s.customer_id
                WHERE s.status = 'quoted' OR s.created_at >= ?
                   OR s.id IN (SELECT MIN(id) FROM submissions WHERE customer_id IN
                               (SELECT id FROM customers WHERE created_at >= ?) GROUP BY customer_id)`,
  installs: `SELECT i.id, i.submission_id, i.item, i.install_date, i.days, i.done_at,
                    c.name AS customer_name, c.city
             FROM installs i JOIN submissions s ON s.id = i.submission_id
             LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.status = 'won'`,
  coverage: `SELECT COUNT(*) AS won_orders,
                    SUM(EXISTS(SELECT 1 FROM installs i WHERE i.submission_id = s.id)) AS won_with_dates
             FROM submissions s WHERE s.status = 'won'`,
  followups: `SELECT id, name, phone, follow_up_at, temp_override FROM customers
              WHERE follow_up_at IS NOT NULL AND follow_up_at <> '' AND substr(follow_up_at,1,10) <= ?`
};

/* Run the reads through any D1-shaped `db` and build the response. */
export async function loadBriefing(db, { nowMs, days, sections }) {
  const win = briefingWindow(nowMs, days);
  const all = async (sql, ...args) => {
    try { return (await db.prepare(sql).bind(...args).all()).results || []; }
    catch { return []; }   // a table that does not exist yet is an empty section
  };
  const [customers, submissions, installs, cov, followups] = await Promise.all([
    all(BRIEFING_SQL.customers, win.from),
    all(BRIEFING_SQL.submissions, win.from, win.from),
    all(BRIEFING_SQL.installs),
    all(BRIEFING_SQL.coverage),
    all(BRIEFING_SQL.followups, win.today)
  ]);
  const c = cov[0] || {};
  return buildBriefing({ customers, submissions, installs, followups,
    won_orders: c.won_orders ?? null, won_with_dates: c.won_with_dates ?? null }, { nowMs, days, sections });
}

/* Per-isolate rate limit. In memory on purpose: the endpoint is read-only and
   must not write a counter row to D1. Coarse, but it stops a runaway loop. */
const _hits = new Map();
export function briefingRateOk(key, nowMs, limit = 30, windowMs = 60000) {
  const h = _hits.get(key);
  if (!h || nowMs - h.start >= windowMs) { _hits.set(key, { start: nowMs, n: 1 }); return true; }
  if (h.n >= limit) return false;
  h.n++;
  return true;
}
