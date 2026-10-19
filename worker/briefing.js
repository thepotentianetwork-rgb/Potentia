/* GET /api/briefing — the read-only "Good morning, Jarvis" briefing for a
 * server-to-server caller (the dashboard's Node process shows it and reads
 * the `spoken` field aloud). Nothing here sends, writes, or schedules anything;
 * every response says so with requires_approval / side_effects.
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
 *   pending_proposals  submissions.status = 'quoted' (sent, neither won nor lost),
 *                      ONLY each customer's latest one (older quoted versions of
 *                      the same customer are revisions, not separate deals);
 *                      total = effective_price ?? details.quotedPrice;
 *                      "sent" = created_at (there is no separate sent stamp).
 *                      Display only; never read aloud as a count or a total.
 *   emails             Gmail, read-only, metadata + short snippet; see gmail.js.
 *                      Off unless the Gmail secrets are set. Never stored.
 *   urgent             installs scheduled today, and unanswered customer emails
 *                      older than 24 hours.
 *   upcoming_installs  installs.install_date in [today, today+14], done_at null,
 *                      order status 'won'
 *   follow_ups         customers.follow_up_at <= today (dormant included)
 */

export const BRIEFING_TZ = 'America/Denver';
export const SECTIONS = ['new_leads', 'emails', 'follow_ups', 'upcoming_installs', 'urgent', 'new_designs', 'pending_proposals'];
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

export function parseBriefingParams(searchParams) {
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

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function firstName(n) { return speakable(String(n || '').split(/\s+/)[0]); }

/* Every response carries this. The dashboard must ask the user before doing
   anything the briefing suggests; the endpoint itself never does anything. */
export const NO_SIDE_EFFECTS = Object.freeze({ requires_approval: true, side_effects: 'none' });

/* ---- the daily quote ----
   Curated, real, and attributed to where each one is actually documented.
   Rotation is deterministic by Denver calendar date. Do not add a quote here
   without a verifiable source; popular misattributions (Twain, Edison's
   "overalls", "Aristotle" on habit) are deliberately left out. */
export const QUOTES = [
  { text: 'Well done is better than well said.', author: 'Benjamin Franklin', source: "Poor Richard's Almanack, 1737" },
  { text: 'Lost time is never found again.', author: 'Benjamin Franklin', source: "Poor Richard's Almanack, 1748" },
  { text: 'Diligence is the mother of good luck.', author: 'Benjamin Franklin', source: "Poor Richard's Almanack, 1736" },
  { text: 'Little strokes fell great oaks.', author: 'Benjamin Franklin', source: "Poor Richard's Almanack, 1750" },
  { text: 'Plans are worthless, but planning is everything.', author: 'Dwight D. Eisenhower', source: 'Speech to the National Defense Executive Reserve Conference, 1957' },
  { text: 'Far and away the best prize that life offers is the chance to work hard at work worth doing.', author: 'Theodore Roosevelt', source: 'Labor Day address, Syracuse, 1903' },
  { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt', source: 'Theodore Roosevelt: An Autobiography, 1913, quoting Squire Bill Widener' },
  { text: 'The best way out is always through.', author: 'Robert Frost', source: 'A Servant to Servants, 1914' },
  { text: 'Nothing will ever be attempted, if all possible objections must be first overcome.', author: 'Samuel Johnson', source: 'Rasselas, 1759' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Will Durant', source: 'The Story of Philosophy, 1926, summarizing Aristotle' },
  { text: 'Well begun is half done.', author: 'Aristotle', source: 'Politics, Book V, citing the proverb' },
  { text: 'Either write something worth reading or do something worth writing.', author: 'Benjamin Franklin', source: "Poor Richard's Almanack, 1738" }
];
export function quoteForDay(day) {
  const n = Math.floor(Date.parse(day + 'T00:00:00Z') / 86400000);
  return QUOTES[((n % QUOTES.length) + QUOTES.length) % QUOTES.length];
}

/* ---- email filtering (pure; gmail.js does the fetching) ----
   Input: threads [{ id, messages:[{ id, from, subject, date, labelIds, snippet }] }]
   in oldest-first order. Output: threads whose LAST message is an unread inbound
   message that plausibly wants a reply. Metadata + a short snippet only. */
const AUTOMATED = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|newsletter|news|marketing|updates?|billing|receipts?|info-?noreply|bounce)([._+-]|@)/i;
const AUTOMATED_DOMAIN = /(^|\.)(google\.com|googlemail\.com|docusign\.(net|com)|acquisition\.com|facebookmail\.com|linkedin\.com|mailchimp\.com|hubspot\.com|stripe\.com|paypal\.com|intuit\.com|amazon\.com)$/i;
const AUTOMATED_SUBJECT = /(security alert|verification code|your code is|new device|password|account (was )?recovered|delivery status notification|newsletter|webinar|product update|receipt|completed:|viewed .*agreement)/i;
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM', 'TRASH'];
export function emailAddress(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
export function emailDisplayName(from) {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(String(from || ''));
  return m ? m[1].trim() : null;
}
function cleanSnippet(s) {
  const t = String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[\u034f\u200b-\u200d\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 137).trimEnd() + '...' : t;
}
export function filterImportantEmails(threads, { selfAddresses = [], customers = [] } = {}) {
  const self = new Set(selfAddresses.map((a) => a.toLowerCase()));
  const byEmail = new Map(customers.filter((c) => c.email).map((c) => [String(c.email).trim().toLowerCase(), c]));
  const out = [];
  for (const t of threads || []) {
    const msgs = (t.messages || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    const addr = emailAddress(last.from);
    const labels = last.labelIds || [];
    if (self.has(addr)) continue;                          // we spoke last: no reply owed
    if (!labels.includes('INBOX')) continue;                // read or unread: the last message is theirs, so a reply is owed
    if (last.list_unsubscribe || last.list_id) continue;     // mailing lists / newsletters
    if (AUTOMATED_DOMAIN.test(addr.split('@')[1] || '') || AUTOMATED_SUBJECT.test(String(last.subject || ''))) continue;
    if (BULK_LABELS.some((l) => labels.includes(l))) continue;
    if (AUTOMATED.test(addr)) continue;
    const customer = byEmail.get(addr) || null;
    if (!labels.includes('IMPORTANT') && !customer) continue;
    out.push({ thread_id: t.id, message_id: last.id, from: addr,
      from_name: customer ? customer.name : emailDisplayName(last.from),
      customer_id: customer ? customer.id : null,
      subject: String(last.subject || '').trim(), received_at: last.date,
      snippet: cleanSnippet(last.snippet), unread: labels.includes('UNREAD'), important: labels.includes('IMPORTANT'),
      we_replied_before: msgs.some((m) => self.has(emailAddress(m.from))) });
  }
  return out.sort((a, b) => (b.customer_id != null) - (a.customer_id != null) || String(b.received_at).localeCompare(String(a.received_at)));
}
function spokenSubject(s) { return speakable(String(s || '').replace(/^((re|fwd?)\s*:\s*)+/i, '')); }

/**
 * rows: { customers, submissions, installs, followups, won_orders, won_with_dates }
 * emails: { enabled, items, error? } (already filtered) or undefined.
 */
export function buildBriefing(rows, { nowMs, days = 1, sections = SECTIONS, emails } = {}) {
  const win = briefingWindow(nowMs, days);
  const today = win.today, tomorrow = shiftDay(today, 1);
  const horizon = shiftDay(today, INSTALL_HORIZON_DAYS);
  const inWindow = (iso) => { const t = Date.parse(iso || ''); return !isNaN(t) && t >= Date.parse(win.from) && t <= nowMs; };
  const subs = (rows.submissions || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const firstSub = new Map(), latestSub = new Map();
  for (const s of subs) {
    if (s.customer_id == null) continue;
    if (!firstSub.has(s.customer_id)) firstSub.set(s.customer_id, s);
    if (s.status !== 'superseded') latestSub.set(s.customer_id, s);
  }
  const want = new Set(sections);
  const display = {}, counts = {};

  const leads = (rows.customers || []).filter((c) => inWindow(c.created_at))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((c) => {
      const f = firstSub.get(c.id), l = latestSub.get(c.id) || f;
      const d = f ? parseDetails(f.details) : {};
      return { customer_id: c.id, name: c.name || null, source: d.heardAbout || null,
        city: c.city || d.city || null, phone: c.phone || null, created_at: c.created_at,
        design: l ? designSummary(l.details) : null, latest_status: l ? l.status : null,
        detail_endpoint: `/api/briefing/lead/${c.id}` };
    });
  if (want.has('new_leads')) display.new_leads = leads;

  const emailState = emails || { enabled: false, items: [] };
  if (want.has('emails')) {
    display.emails = emailState.items || [];
    display.emails_status = emailState.enabled ? (emailState.error ? 'error' : 'ok') : 'disabled';
  }

  const followUps = (rows.followups || [])
    .filter((c) => c.follow_up_at && String(c.follow_up_at).slice(0, 10) <= today)
    .sort((a, b) => String(a.follow_up_at).localeCompare(String(b.follow_up_at)))
    .map((c) => ({ customer_id: c.id, name: c.name || null, phone: c.phone || null,
      follow_up_at: String(c.follow_up_at).slice(0, 10), days_overdue: daysSince(c.follow_up_at, today),
      dormant: c.temp_override === 'dormant', temp_override: c.temp_override || null }));
  if (want.has('follow_ups')) display.follow_ups = followUps;

  const allInstalls = rows.installs || [];
  const installs = allInstalls
    .filter((i) => !i.done_at && i.install_date >= today && i.install_date <= horizon)
    .sort((a, b) => String(a.install_date).localeCompare(String(b.install_date)) || a.id - b.id)
    .map((i) => ({ install_id: i.id, submission_id: i.submission_id, customer: i.customer_name || null,
      customer_id: i.customer_id ?? null, city: i.city || null, item: i.item, install_date: i.install_date,
      days: i.days ?? null, when: i.install_date === today ? 'today' : i.install_date === tomorrow ? 'tomorrow' : 'later' }));
  if (want.has('upcoming_installs')) {
    display.upcoming_installs = installs;
    counts.install_date_coverage = { won_orders: rows.won_orders ?? null,
      won_orders_with_dates: rows.won_with_dates ?? null, install_rows: allInstalls.length,
      past_dates_excluded: allInstalls.filter((i) => !i.done_at && i.install_date < today).length };
  }

  const urgent = [];
  for (const i of installs.filter((x) => x.when === 'today')) urgent.push({ kind: 'install_today', ...i });
  for (const e of (emailState.items || [])) {
    const t = Date.parse(e.received_at || '');
    if (e.customer_id != null && !isNaN(t) && nowMs - t > 86400000) urgent.push({ kind: 'customer_email_waiting', ...e });
  }
  if (want.has('urgent')) display.urgent = urgent;

  if (want.has('new_designs')) {
    display.new_designs = subs.filter((s) => s.status !== 'superseded' && inWindow(s.created_at)).reverse()
      .map((s) => ({ submission_id: s.id, customer_id: s.customer_id, customer: s.customer_name || s.name || null,
        summary: designSummary(s.details), status: s.status, total: quoteTotal(s), created_at: s.created_at }));
  }
  if (want.has('pending_proposals')) {
    const latestQuoted = new Map();
    for (const s of subs) if (s.status === 'quoted') latestQuoted.set(s.customer_id ?? ('s' + s.id), s);
    display.pending_proposals = [...latestQuoted.values()]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((s) => ({ submission_id: s.id, quote_number: s.id, customer_id: s.customer_id, customer: s.customer_name || s.name || null,
        total: quoteTotal(s), sent_at: s.created_at, days_since_sent: daysSince(s.created_at, today) }));
  }
  for (const k of SECTIONS) if (Array.isArray(display[k])) counts[k] = display[k].length;
  display.counts = counts;

  const quote = quoteForDay(today);
  const recommended_action = recommend({ leads, emails: emailState.items || [], followUps, installs, want });
  const spoken = buildSpoken({ leads, emails: emailState.items || [], followUps, installs, urgent, want, quote, recommended_action, days, today });

  return { ...NO_SIDE_EFFECTS, generated_at: new Date(nowMs).toISOString(), timezone: BRIEFING_TZ,
    window: { from: win.from, to: win.to, days, today }, quote, recommended_action,
    display, spoken, intents: buildIntents({ leads, emails: emailState.items || [], followUps, recommended_action }) };
}

/* One thing to do first, in the same priority order the briefing is read in. */
export function recommend({ leads, emails, followUps, installs, want }) {
  const on = (k) => !want || want.has(k);
  const l = on('new_leads') && leads[0];
  if (l) return { kind: 'call_lead', customer_id: l.customer_id, text: `Call ${l.name || 'the new lead'}${l.design ? ` about their ${l.design.replace(/(\d+)x(\d+)/, '$1 by $2')} design` : ''}`,
    endpoint: `/api/briefing/lead/${l.customer_id}` };
  const e = on('emails') && emails[0];
  if (e) return { kind: 'reply_email', thread_id: e.thread_id, customer_id: e.customer_id,
    text: `Reply to ${e.from_name || e.from} about ${spokenSubject(e.subject) || 'their email'}`,
    endpoint: `/api/briefing/draft?kind=email&id=${encodeURIComponent(e.thread_id)}` };
  const f = on('follow_ups') && followUps[0];
  if (f) return { kind: 'follow_up', customer_id: f.customer_id, text: `Follow up with ${f.name || 'your oldest follow up'}`,
    endpoint: `/api/briefing/draft?kind=follow_up&id=${f.customer_id}` };
  const i = on('upcoming_installs') && installs.find((x) => x.when !== 'later');
  if (i) return { kind: 'confirm_install', customer_id: i.customer_id, text: `Confirm ${i.when}'s ${i.item} job for ${i.customer || 'the customer'}`, endpoint: null };
  return { kind: 'none', text: 'Check in on your open proposals', endpoint: null };
}

function names(list, key, max) {
  const n = list.slice(0, max).map((x) => speakable(x[key]) || 'someone');
  if (list.length > max) n.push(`${numberWords(list.length - max)} more`);
  return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}

/* Short, action-first, read aloud. Target: under about 150 words. */
export function buildSpoken({ leads, emails, followUps, installs, urgent, want, quote, recommended_action, days, today }) {
  const on = (k) => want.has(k);
  const out = [`Good morning. As ${quote.author} put it, ${quote.text}`];
  const span = days === 1 ? 'overnight' : `in the last ${numberWords(days)} days`;
  if (on('new_leads')) {
    if (leads.length) {
      const l = leads[0];
      const bits = [l.city ? `from ${speakable(l.city)}` : '', l.source ? `found us through ${speakable(l.source.replace(/-/g, ' '))}` : ''].filter(Boolean).join(', ');
      out.push(leads.length === 1
        ? `One new lead ${span}: ${speakable(l.name) || 'a new customer'}${bits ? ', ' + bits : ''}${l.design ? `, looking at a ${l.design.replace(/(\d+)x(\d+)/, '$1 by $2')}` : ''}.`
        : `${cap(numberWords(leads.length))} new leads ${span}, newest is ${speakable(l.name) || 'a new customer'}${l.city ? ' from ' + speakable(l.city) : ''}.`);
    } else out.push(`No new leads ${span}.`);
  }
  if (on('emails') && emails.length) {
    const e = emails[0];
    out.push(`${cap(plural(emails.length, 'email needs', 'emails need'))} a reply, starting with ${speakable(e.from_name) || 'a customer'} about ${spokenSubject(e.subject) || 'their message'}.`);
  }
  if (on('follow_ups') && followUps.length) {
    const late = followUps[0].days_overdue > 0 ? `, the oldest ${plural(followUps[0].days_overdue, 'day', 'days')} overdue` : '';
    out.push(`Follow ups due: ${names(followUps, 'name', 2)}${late}.`);
  }
  if (on('upcoming_installs')) {
    const soon = installs.filter((i) => i.when !== 'later');
    if (soon.length) {
      for (const w of ['today', 'tomorrow']) {
        const g = soon.filter((i) => i.when === w);
        if (g.length) out.push(`${cap(w)}: ${g.slice(0, 3).map((i) => `${speakable(i.item)} for ${speakable(i.customer) || 'a customer'}`).join(', ')}.`);
      }
    } else if (installs.length) {
      out.push(`Next on the schedule is ${speakable(installs[0].item)} for ${speakable(installs[0].customer)} on ${spokenDate(installs[0].install_date, today)}.`);
    }
  }
  if (on('urgent')) {
    const waiting = urgent.filter((u) => u.kind === 'customer_email_waiting' && !(emails[0] && emails[0].thread_id === u.thread_id));
    if (waiting.length) out.push(`Also, ${speakable(waiting[0].from_name)} has been waiting over a day for a reply.`);
  }
  out.push(`Start with this: ${recommended_action.text}.`);
  return out.join(' ');
}

/* Phrases the dashboard should map to follow-up calls, with ids pre-resolved
   so "that new lead" means the top lead from THIS briefing. */
export function buildIntents({ leads, emails, followUps, recommended_action }) {
  const lead = leads[0], email = emails[0];
  const draftTarget = recommended_action.kind === 'call_lead' ? `/api/briefing/draft?kind=lead&id=${lead.customer_id}`
    : recommended_action.kind === 'reply_email' ? recommended_action.endpoint
    : recommended_action.kind === 'follow_up' ? recommended_action.endpoint : null;
  return {
    tell_me_about_that_new_lead: { phrases: ['tell me about that new lead', 'who is the new lead', 'more on that lead'],
      method: 'GET', endpoint: lead ? `/api/briefing/lead/${lead.customer_id}` : null, resolves_to: lead ? { customer_id: lead.customer_id, name: lead.name } : null },
    draft_a_response: { phrases: ['draft a response', 'write them back', 'draft a reply'],
      method: 'GET', endpoint: draftTarget, resolves_to: draftTarget ? recommended_action : null,
      note: 'Returns draft text only. Nothing is sent or saved; the user must approve and send it themselves.' },
    what_follow_ups_do_i_have: { phrases: ['what follow-ups do I have', 'who do I need to call'],
      method: 'GET', endpoint: '/api/briefing/follow-ups', count: followUps.length },
    read_my_important_emails: { phrases: ['read my important emails', 'any emails I need to answer'],
      method: 'GET', endpoint: '/api/briefing/emails', count: emails.length, top_thread_id: email ? email.thread_id : null }
  };
}

/* ---- follow-up endpoints (pure builders) ---- */
export function buildLeadDetail({ customer, submissions = [], notes = [], calls = [] }, { nowMs }) {
  if (!customer) return null;
  const today = denverDay(nowMs);
  const subs = submissions.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const first = subs[subs.length - 1];
  const d = first ? parseDetails(first.details) : {};
  return { ...NO_SIDE_EFFECTS,
    lead: { customer_id: customer.id, name: customer.name, email: customer.email || null, phone: customer.phone || null,
      city: customer.city || d.city || null, source: d.heardAbout || null, created_at: customer.created_at,
      days_since_created: daysSince(customer.created_at, today), temp_override: customer.temp_override || null,
      follow_up_at: customer.follow_up_at || null },
    designs: subs.map((s) => ({ submission_id: s.id, status: s.status, summary: designSummary(s.details), total: quoteTotal(s), created_at: s.created_at })),
    recent_notes: notes.slice(0, 3).map((n) => ({ created_at: n.created_at, text: String(n.text || '').slice(0, 280) })),
    calls: { count: calls.length, last_called_at: calls.length ? calls.map((c) => c.called_at).sort().pop() : null },
    spoken: leadSpoken(customer, subs, d, calls) };
}
function leadSpoken(c, subs, d, calls) {
  const s = subs.find((x) => x.status !== 'superseded') || subs[0];
  const bits = [`${speakable(c.name) || 'This lead'}${(c.city || d.city) ? ' is in ' + speakable(c.city || d.city) : ''}`];
  if (d.heardAbout) bits.push(`and found us through ${speakable(d.heardAbout.replace(/-/g, ' '))}`);
  let t = bits.join(' ') + '.';
  if (s) t += ` They designed a ${String(designSummary(s.details) || 'shed').replace(/(\d+)x(\d+)/, '$1 by $2')}${quoteTotal(s) ? ` priced at ${moneyWords(quoteTotal(s))}` : ''}.`;
  t += calls.length ? ` You have called them ${plural(calls.length, 'time', 'times')}.` : ' Nobody has called them yet.';
  return t;
}

/* Draft text only. Never sent, never saved. Signed generically on purpose. */
export function buildDraft(kind, target) {
  const base = { ...NO_SIDE_EFFECTS, sent: false, saved: false, kind };
  if (!target) return { ...base, error: 'Not found' };
  const first = firstName(target.name || target.from_name) || 'there';
  if (kind === 'lead') {
    return { ...base, to: target.email || null, phone: target.phone || null,
      subject: 'Your ShedPro shed design',
      body: `Hi ${first},\n\nThanks for designing your ${target.design ? target.design + ' ' : ''}shed with ShedPro. I would love to go over it with you and answer any questions. When is a good time for a quick call?\n\nThanks,\nShedPro` };
  }
  if (kind === 'follow_up') {
    return { ...base, to: target.email || null, phone: target.phone || null,
      subject: 'Checking in on your shed',
      body: `Hi ${first},\n\nJust checking in on your shed project. Are you still thinking about moving forward? Happy to adjust the design or answer any questions.\n\nThanks,\nShedPro` };
  }
  if (kind === 'email') {
    return { ...base, to: target.from, thread_id: target.thread_id,
      subject: /^re:/i.test(target.subject || '') ? target.subject : `Re: ${target.subject || ''}`.trim(),
      in_reply_to_snippet: target.snippet,
      body: `Hi ${first},\n\nThanks for your message. [Your reply here]\n\nThanks,\nShedPro` };
  }
  return { ...base, error: 'Unknown kind' };
}

/* ---- SQL (SELECT only), shared by the worker and the live-data script ---- */
export const BRIEFING_SQL = {
  customers: `SELECT id, name, phone, city, created_at FROM customers WHERE created_at >= ?`,
  submissions: `SELECT s.id, s.customer_id, s.name, s.status, s.created_at, s.effective_price, s.details,
                       c.name AS customer_name
                FROM submissions s LEFT JOIN customers c ON c.id = s.customer_id
                WHERE s.status = 'quoted' OR s.created_at >= ?
                   OR s.customer_id IN (SELECT id FROM customers WHERE created_at >= ?)`,
  installs: `SELECT i.id, i.submission_id, i.item, i.install_date, i.days, i.done_at,
                    c.id AS customer_id, c.name AS customer_name, c.city
             FROM installs i JOIN submissions s ON s.id = i.submission_id
             LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.status = 'won'`,
  coverage: `SELECT COUNT(*) AS won_orders,
                    SUM(EXISTS(SELECT 1 FROM installs i WHERE i.submission_id = s.id)) AS won_with_dates
             FROM submissions s WHERE s.status = 'won'`,
  followups: `SELECT id, name, phone, email, follow_up_at, temp_override FROM customers
              WHERE follow_up_at IS NOT NULL AND follow_up_at <> '' AND substr(follow_up_at,1,10) <= ?`,
  customerEmails: `SELECT id, name, email FROM customers WHERE email IS NOT NULL AND email <> ''`,
  customer: `SELECT id, name, email, phone, city, created_at, temp_override, follow_up_at FROM customers WHERE id = ?`,
  customerSubs: `SELECT id, status, created_at, effective_price, details FROM submissions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`,
  customerNotes: `SELECT created_at, text FROM notes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 3`,
  customerCalls: `SELECT called_at FROM calls WHERE customer_id = ?`
};

async function q(db, sql, ...args) {
  try { return (await db.prepare(sql).bind(...args).all()).results || []; }
  catch { return []; }   // a table that does not exist yet is an empty section
}

export async function loadRows(db, { nowMs, days }) {
  const win = briefingWindow(nowMs, days);
  const [customers, submissions, installs, cov, followups] = await Promise.all([
    q(db, BRIEFING_SQL.customers, win.from),
    q(db, BRIEFING_SQL.submissions, win.from, win.from),
    q(db, BRIEFING_SQL.installs),
    q(db, BRIEFING_SQL.coverage),
    q(db, BRIEFING_SQL.followups, win.today)
  ]);
  const c = cov[0] || {};
  return { customers, submissions, installs, followups, won_orders: c.won_orders ?? null, won_with_dates: c.won_with_dates ?? null };
}

/* fetchThreads: async () => threads (see gmail.js) or null when email is off. */
export async function loadEmails(db, fetchThreads, selfAddresses) {
  if (!fetchThreads) return { enabled: false, items: [] };
  try {
    const [threads, customers] = await Promise.all([fetchThreads(), q(db, BRIEFING_SQL.customerEmails)]);
    return { enabled: true, items: filterImportantEmails(threads, { selfAddresses, customers }) };
  } catch (e) {
    return { enabled: true, items: [], error: 'Email fetch failed' };
  }
}

export async function loadBriefing(db, { nowMs, days, sections, fetchThreads, selfAddresses = [] }) {
  const [rows, emails] = await Promise.all([loadRows(db, { nowMs, days }), loadEmails(db, fetchThreads, selfAddresses)]);
  return buildBriefing(rows, { nowMs, days, sections, emails });
}

export async function loadLeadDetail(db, id, { nowMs }) {
  const [customer] = await q(db, BRIEFING_SQL.customer, id);
  if (!customer) return null;
  const [submissions, notes, calls] = await Promise.all([
    q(db, BRIEFING_SQL.customerSubs, id), q(db, BRIEFING_SQL.customerNotes, id), q(db, BRIEFING_SQL.customerCalls, id)]);
  return buildLeadDetail({ customer, submissions, notes, calls }, { nowMs });
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
