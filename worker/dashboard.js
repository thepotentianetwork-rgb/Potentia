/* WHAT THE SHOP SEES WHEN IT OPENS THE CRM.
 *
 * Six questions, answered in one screen: what is happening this week, who needs
 * calling, what is sold with no date on it, what has not been paid, how the
 * month is going.
 *
 * All of it is DERIVED. Nothing here is a status somebody has to remember to
 * set, because a dashboard that has to be maintained by hand is one that is
 * quietly wrong by the second week — and a wrong dashboard is worse than none,
 * since it is the screen decisions get made from without checking.
 *
 * TODAY IS PASSED IN, never read from the clock. The worker runs in UTC and the
 * shop is in Utah, which are on different calendar days for seven hours of
 * every day. "Due today" computed in the wrong zone is wrong for a third of the
 * working afternoon, and nobody would ever notice it was the timezone.
 */

/* A plain YYYY-MM-DD, or null for anything that is not one. Everything here
   compares dates as strings: they are zero-padded ISO days, so string order is
   date order and no Date object — and therefore no timezone — is involved. */
export function dashDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? m[0].slice(0, 10) : null;
}

function dashShift(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* Whole calendar days between two days, by the calendar and not by dividing
   milliseconds — the subtraction is an hour out across a daylight saving
   change, which rounds "yesterday" into "today". Both are UTC midnights here,
   so the arithmetic is exact. */
export function daysBetween(fromISO, toISO) {
  const a = dashDay(fromISO), b = dashDay(toISO);
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/* "2h ago", "3 days ago". Given a timestamp and the day the shop is having. */
export function agoLabel(iso, todayISO, nowMs) {
  const t = Date.parse(String(iso || ''));
  if (isNaN(t)) return '';
  const mins = Math.floor((Number(nowMs) - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 24 * 60) return Math.floor(mins / 60) + 'h ago';
  const days = daysBetween(dashDay(iso), todayISO);
  if (days === null) return '';
  if (days <= 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : months + ' months ago';
}

/* The calendar month `todayISO` is in, up to and including today. */
export function monthToDate(todayISO) {
  const day = dashDay(todayISO);
  if (!day) return null;
  return { start: day.slice(0, 8) + '01', end: day };
}

/* A COUNT PER DAY ACROSS THE WHOLE WINDOW, including the days nothing happened.
   Leaving the empty days out would draw a sparkline of the days that had
   something — which is a different shape, and a flattering one. */
export function daySeries(dates, startISO, endISO) {
  const start = dashDay(startISO), end = dashDay(endISO);
  if (!start || !end || start > end) return [];
  const counts = {};
  (dates || []).forEach((d) => {
    const day = dashDay(d);
    if (day && day >= start && day <= end) counts[day] = (counts[day] || 0) + 1;
  });
  const out = [];
  /* Bounded: a bad pair of dates must not spin here. A year of daily bars is
     already far more than a sparkline can show. */
  for (let day = start, i = 0; day && day <= end && i < 400; day = dashShift(day, 1), i++) {
    out.push(counts[day] || 0);
  }
  return out;
}

/* THE WEEK, as a job list rather than a date list.
 *
 * A booking spans its length, so a two-day install that started yesterday is
 * still happening today and belongs on the screen. Filtering on install_date
 * alone drops exactly the job somebody is standing on. */
export function stagesInWindow(installs, fromISO, toISO) {
  const from = dashDay(fromISO), to = dashDay(toISO);
  if (!from || !to) return [];
  return (installs || []).filter((i) => {
    const start = dashDay(i.install_date);
    if (!start) return false;
    const len = Number(i.days);
    const span = Number.isFinite(len) && len >= 1 ? Math.ceil(len) : 1;
    const last = dashShift(start, span - 1) || start;
    return last >= from && start <= to;
  }).sort((a, b) => {
    const d = String(a.install_date).localeCompare(String(b.install_date));
    return d !== 0 ? d : Number(a.id || 0) - Number(b.id || 0);
  });
}

/* WHO TO RING, AND WHY.
 *
 * Two kinds of row, because they are two different jobs:
 *   - a customer with a revisit date that has arrived, which somebody chose
 *   - a lead nobody has answered yet, which nothing chose and which is the one
 *     that actually costs money
 *
 * Ordered by how late it is, not by how new. A follow-up four days overdue
 * outranks one due today, and both outrank an unanswered lead from this
 * morning — the overdue one is the promise already broken.
 *
 * reason is the customer's own latest note when there is one, because "Asked
 * about delivery timing" tells you what to say when they pick up and "Follow up
 * due" does not. */
export function pickFollowUps(rows, todayISO, limit) {
  const today = dashDay(todayISO);
  if (!today) return [];
  const max = Number.isFinite(limit) && limit > 0 ? limit : 6;

  const out = [];
  (rows || []).forEach((c) => {
    const due = dashDay(c.follow_up_at);
    const overdue = due ? daysBetween(due, today) : null;

    if (due && overdue !== null && overdue >= 0) {
      out.push({
        customer_id: c.id,
        name: c.name || 'Unnamed customer',
        phone: c.phone || '',
        reason: String(c.latest_note || '').trim() || 'Follow up due',
        when: overdue === 0 ? 'Due today' : overdue + (overdue === 1 ? ' day late' : ' days late'),
        urgent: true,
        /* Sorted on, not shown. Later is more urgent, so it sorts first. */
        rank: 1000 + overdue,
        at: c.follow_up_at
      });
      return;
    }

    /* An untouched lead: an order still sitting at 'new', and nobody has
       logged a call. A note on its own is not contact — writing something down
       about a customer is not the same as having spoken to them. */
    if (c.latest_status === 'new' && !c.last_call_at) {
      out.push({
        customer_id: c.id,
        name: c.name || 'Unnamed customer',
        phone: c.phone || '',
        reason: String(c.latest_note || '').trim() || 'New lead · not called yet',
        when: '',
        urgent: false,
        rank: 1,
        at: c.latest_submission_at || c.created_at
      });
    }
  });

  out.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    /* Within a rank, oldest first — the one that has been waiting longest. */
    return String(a.at || '').localeCompare(String(b.at || ''));
  });
  return out.slice(0, max);
}

/* The one view of a build the dashboard shows. Null rather than a stand-in
   when the order predates the designer capturing renders: a picture of a shed
   that is not theirs, on a build-day row, is the wrong shed in front of the
   crew. */
export function renderThumb(details) {
  const r = details && details.renders;
  if (!r || typeof r !== 'object') return null;
  const url = r.perspective || r.front || r.left || r.right || r.back;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}
