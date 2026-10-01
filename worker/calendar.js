/* THE INSTALL DATE, AS A CALENDAR INVITE THE CUSTOMER GETS.
 *
 * No API, no OAuth, no key. A Google Calendar "template" link carries the
 * whole event in its query string: title, dates, location, description, and
 * — the part that makes this worth building — a guest list. Opening it puts a
 * filled-in event in front of whoever clicked, and the moment they press Save
 * Google emails the invite to the guests. So the customer gets a real invite
 * on their own calendar without us running a mail server or holding a token.
 *
 * THE ONE THAT WILL BITE: for an all-day event the end date is EXCLUSIVE. A
 * one-day install on the 15th is 20261015/20261016. Getting that wrong is not
 * a crash — it is an invite that quietly says the wrong days to a customer who
 * then turns up, or doesn't, on the wrong one. Every boundary case in here has
 * a test.
 *
 * All the date arithmetic is in UTC on purpose. install_date is a plain
 * calendar day with no time in it, and running it through local time is how
 * "the 15th" becomes "the 14th" for half the world on a date near a daylight
 * saving change.
 */

export const GOOGLE_CALENDAR_BASE = 'https://calendar.google.com/calendar/render';

/* Titles the install rows already use, so the calendar says what the CRM
   says. Kept here rather than imported: the bundler inlines every module at
   top level and these must not collide with the CRM's own copy. */
export const CAL_ITEM_LABELS = {
  prep: 'Site prep',
  pour: 'Concrete pour',
  gravel: 'Gravel pad',
  shop: 'Shop build',
  shed: 'Shed install',
  concrete: 'Concrete pour'
};

/* WHICH STAGES HAPPEN AT THE CUSTOMER'S PLACE.
 *
 * A shop day is a day in your own shop. Inviting the customer to it puts an
 * appointment on their calendar for a day when nothing happens at their
 * house, which is worse than not inviting them at all — they will either turn
 * up or stop trusting the invites. Only site days get the customer; the crew
 * list goes on everything, because the crew need to know about both. */
export function isOnSite(item) {
  return item !== 'shop';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* A stored install_date, as a UTC calendar day. Accepts the YYYY-MM-DD the
   form sends and the full ISO string older rows may carry; anything else is
   null, and the caller offers no invite rather than a wrong one. */
export function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  /* Rejects the 31st of a 30-day month and the 29th of a common February,
     which Date.UTC would silently roll forward into the next month. */
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function ymd(date) {
  return String(date.getUTCFullYear()) + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate());
}

/* How many calendar days an install occupies. Half a day still takes a day
   off someone's calendar, and a missing figure means one day rather than
   none — an event that ends before it starts is not a useful default. */
export function calendarDays(days) {
  const n = Number(days);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n));
}

/* start inclusive, end EXCLUSIVE — Google's format for all-day events. */
export function dayRange(installDate, days) {
  const start = parseDay(installDate);
  if (!start) return null;
  const end = new Date(start.getTime() + calendarDays(days) * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

/* Google accepts unencoded commas between guests, but encoding each address
   and joining is the version that cannot be broken by a stray character in an
   address someone typed into the CRM. */
function guestList(guests) {
  return (guests || [])
    .map((g) => String(g || '').trim())
    .filter((g) => g.indexOf('@') > 0)
    .map(encodeURIComponent)
    .join(',');
}

/* The link. Returns null rather than a half-built URL when there is no usable
   date: a button that opens an empty calendar entry is worse than no button,
   because it looks like it worked. */
export function googleCalendarUrl({ title, installDate, days, details, location, guests }) {
  const range = dayRange(installDate, days);
  if (!range) return null;
  const parts = [
    'action=TEMPLATE',
    'text=' + encodeURIComponent(title || 'Install'),
    'dates=' + range.start + '/' + range.end,
  ];
  if (details) parts.push('details=' + encodeURIComponent(details));
  if (location) parts.push('location=' + encodeURIComponent(location));
  const add = guestList(guests);
  if (add) parts.push('add=' + add);
  return GOOGLE_CALENDAR_BASE + '?' + parts.join('&');
}

/* What the event is called. The customer's name is in it because this lands
   on a calendar beside twenty other things and "Shed install" alone tells you
   nothing at 6am. */
export function installTitle(item, customerName) {
  const what = CAL_ITEM_LABELS[item] || 'Install';
  const who = String(customerName || '').trim();
  return who ? what + ' — ' + who : what;
}

/* Everything worth having on the phone when you are already in the truck. */
/* HOW LONG THE DESCRIPTION MAY RUN.
   This goes into the QUERY STRING of a Google Calendar template link, where
   every newline costs three characters encoded. A loaded build's spec plus a
   long note can run past what browsers and Google will carry, and the way
   that fails is silent truncation — the link still opens, the event still
   saves, and the back half of the spec is simply not there. Capped here, with
   a line saying so, because a spec that stops mid-sentence looks like the
   build stops there too. */
export const DETAILS_MAX = 1400;

export function installDetails({ summary, spec, designUrl, phone, note, days, orderId }) {
  const lines = [];
  /* The full spec replaces the one-line summary when there is one — the
     summary IS its first line, so printing both repeats it. */
  const body = (spec && spec.length) ? spec.slice() : (summary ? [summary] : []);
  body.forEach((l) => { if (l) lines.push(l); });
  if (orderId) lines.push('Order #' + orderId);
  if (phone) lines.push('Phone: ' + phone);
  const n = Number(days);
  if (isFinite(n) && n > 0) lines.push('Scheduled: ' + n + (n === 1 ? ' day' : ' days'));
  if (note) lines.push('Note: ' + note);
  /* Last, so a long spec pushes the link off the bottom rather than burying
     it — and so the cap below takes the spec's tail before it takes this. */
  if (designUrl) lines.push('3D build: ' + designUrl);
  return capped(lines.join('\n'));
}

/* Trims whole LINES off the end rather than cutting mid-word, and keeps the
   design link if there was one: a truncated URL is worse than no URL. */
function capped(text) {
  if (text.length <= DETAILS_MAX) return text;
  const lines = text.split('\n');
  const link = lines[lines.length - 1].indexOf('3D build: ') === 0 ? lines.pop() : null;
  const tail = (link ? '\n' + link : '');
  const room = DETAILS_MAX - tail.length - 3;
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > room) break;
    kept.push(l); used += l.length + 1;
  }
  return kept.join('\n') + '\n\u2026' + tail;
}
