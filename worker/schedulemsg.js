/* THE "HERE IS YOUR BUILD SCHEDULE" MESSAGE, WRITTEN IN ONE PLACE.
 *
 * The CRM's "Send build schedule" button asks the worker for this and then
 * hands it to the phone's own text app (sms:), to email (mailto:), or to the
 * clipboard. When Twilio is set up, the same message is what gets sent
 * automatically — only the delivery changes, never the words, so a text sent
 * by hand today and one sent by Twilio tomorrow say the same thing.
 *
 * WHAT GOES IN: the customer's first name, each booked stage in plain words
 * with its date ("Gravel pad: Wed Oct 7"), their private tracking link, and an
 * "add to your calendar" link for each day that happens AT THEIR PLACE.
 *
 * WHAT STAYS OUT: the shop's own calendar links. Those carry the crew's guest
 * list and the shop's internal notes; a customer who opened one and pressed
 * Save would invite the crew from their own account. The customer gets their
 * own links instead — no guests, no notes, just the day and the address.
 *
 * PLAIN ASCII in the text body on purpose. One curly quote or bullet switches
 * a text message to a different encoding that fits 70 characters per segment
 * instead of 160, which more than doubles what an automated text costs.
 *
 * Dates are plain calendar days, formatted in UTC so "the 7th" never becomes
 * "the 6th" on the way through anyone's clock.
 */
import { googleCalendarUrl, isOnSite } from "./calendar.js";

/* What each stage is called in a message to a customer. Off-site days say
   where they happen, so nobody waits at home for a shop day. */
export const SM_STAGE_WORDS = {
  prep: 'Site prep',
  pour: 'Concrete pour',
  concrete: 'Concrete pad',
  gravel: 'Gravel pad',
  materials: 'Materials gathered',
  shop: 'Shed built in our shop',
  shed: 'Shed install'
};

/* The order stages are listed in when two fall on the same day. */
const SM_ORDER = ['prep', 'pour', 'concrete', 'materials', 'shop', 'gravel', 'shed'];

const SM_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SM_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* "Wed Oct 7", or null for anything that is not a real YYYY-MM-DD day. */
export function smDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return SM_DOW[d.getUTCDay()] + ' ' + SM_MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

/* One row per stage, the newest booking of each, in the order they happen.
   A job that was re-done can have two rows for one stage; the customer only
   needs the one that stands. Rows with no readable date are left out — a
   schedule line that says "Shed install: undefined" is worse than none. */
export function smStages(installs) {
  const latest = {};
  (Array.isArray(installs) ? installs : []).forEach((r) => {
    const item = String((r && r.item) || '');
    if (!SM_STAGE_WORDS[item] || !smDay(r.install_date)) return;
    const prev = latest[item];
    if (!prev || Number(r.id || 0) > Number(prev.id || 0)) latest[item] = r;
  });
  return Object.keys(latest).map((k) => latest[k]).sort((a, b) => {
    const da = String(a.install_date).slice(0, 10), db = String(b.install_date).slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return SM_ORDER.indexOf(a.item) - SM_ORDER.indexOf(b.item);
  }).map((r) => {
    const n = Number(r.days);
    return {
      item: r.item,
      label: SM_STAGE_WORDS[r.item],
      date: String(r.install_date).slice(0, 10),
      when: smDay(r.install_date),
      days: isFinite(n) && n > 1 ? Math.ceil(n) : 1,
      on_site: isOnSite(r.item),
      done: !!r.done_at
    };
  });
}

/* Strips what would push a text into the expensive encoding. Names and
   addresses are the customer's own and are left alone; this is for our
   words, which should never need it. */
function smAscii(s) {
  return String(s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u00b7/g, '-');
}

/* The whole message.
 *   firstName  greeting; optional
 *   installs   the order's install rows (item, install_date, days, done_at, id)
 *   trackUrl   their private tracking page
 *   address    where on-site days happen, for the calendar links
 *   shopPhone  how to reach the shop
 * Returns { stages, calendar, text, subject } — text is the same body for a
 * text message and an email. */
export function scheduleMessage({ firstName, installs, trackUrl, address, shopPhone }) {
  const stages = smStages(installs);
  const name = String(firstName || '').trim();

  /* Kept short: every character here is in the text message too, twice
     over once encoded. The tracking link is already in the message body. */
  const calendar = stages.filter((s) => s.on_site && !s.done).map((s) => ({
    item: s.item,
    label: s.label,
    url: googleCalendarUrl({
      title: 'ShedPro: ' + s.label,
      installDate: s.date,
      days: s.days,
      details: smAscii((s.item === 'shed'
        ? 'Our crew delivers and sets up your shed.'
        : 'Our crew will be at your place for the ' + s.label.toLowerCase() + '.') +
        (shopPhone ? '\nQuestions? ' + shopPhone : '')),
      location: address || '',
      guests: []
    })
  })).filter((c) => c.url);

  const lines = [];
  lines.push((name ? 'Hi ' + name + '! ' : 'Hi! ') + "Here's your ShedPro build schedule:");
  lines.push('');
  stages.forEach((s) => {
    let line = '- ' + s.label + ': ' + s.when;
    if (s.days > 1) line += ' (' + s.days + ' days)';
    if (s.on_site) line += ' - at your place';
    if (s.done) line += ' (done)';
    lines.push(line);
  });
  if (trackUrl) {
    lines.push('');
    lines.push('Follow your build anytime: ' + trackUrl);
  }
  if (calendar.length) {
    lines.push('');
    lines.push('Add to your calendar:');
    calendar.forEach((c) => lines.push(c.label + ': ' + c.url));
  }
  lines.push('');
  lines.push('Dates can shift a day with weather; we will let you know.' +
    (shopPhone ? ' Questions? Call or text ' + shopPhone + '.' : ''));
  lines.push('- ShedPro');

  return {
    stages,
    calendar,
    text: smAscii(lines.join('\n')),
    subject: 'Your ShedPro build schedule'
  };
}
