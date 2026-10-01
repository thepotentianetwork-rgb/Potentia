/* THE OFF-BY-ONE THAT REACHES A CUSTOMER.
 *
 * An all-day Google Calendar event ends on an EXCLUSIVE date: a one-day
 * install on the 15th is 20261015/20261016. Get it wrong and nothing crashes
 * — the customer just receives an invite for the wrong days and turns up, or
 * doesn't, accordingly. So the boundaries are checked one at a time rather
 * than trusted to a formula that looks right.
 *
 * Run: node --test worker/calendar.test.mjs
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseDay, ymd, calendarDays, dayRange, googleCalendarUrl,
         installTitle, installDetails, isOnSite, CAL_ITEM_LABELS,
         GOOGLE_CALENDAR_BASE } from './calendar.js';
import { planBuild } from './schedule.js';

/* ---- the stage vocabulary, which lives in two files ---------------------- */

/* schedule.js names the stages and calendar.js titles them, and they are
   deliberately separate copies (the bundler inlines every module into one
   scope). Separate copies drift: a stage added to the planner and not here
   would title its invite "Install — Hank Ellis" and look fine. */
test('every stage the planner can produce has a calendar title', () => {
  for (const kind of ['concrete', 'gravel', 'none']) {
    planBuild('2026-10-07', { foundation: kind }).forEach((s) => {
      assert.ok(CAL_ITEM_LABELS[s.item], kind + ': no calendar title for "' + s.item + '"');
    });
  }
});

/* WHICH WAY THE DEFAULT FAILS. Inviting a customer to a day at the shop or at
   a supplier is the expensive mistake — they drive over and nothing is
   happening. Leaving the crew off is noticed by the crew that morning. So an
   unlisted stage must come back false, not true. */
test('only days at the customer\u2019s place count as on site', () => {
  ['prep', 'pour', 'gravel', 'shed', 'concrete'].forEach((item) => {
    assert.equal(isOnSite(item), true, item + ' happens at their address');
  });
  ['shop', 'materials'].forEach((item) => {
    assert.equal(isOnSite(item), false, item + ' does not happen at their address');
  });
  assert.equal(isOnSite('warranty-visit'), false,
    'a stage nobody has classified must not invite the customer by default');
  assert.equal(isOnSite(''), false);
  assert.equal(isOnSite(undefined), false);
});

test('a one-day install ends on the NEXT day, because the end is exclusive', () => {
  assert.deepEqual(dayRange('2026-10-15', 1), { start: '20261015', end: '20261016' });
});

test('a multi-day install spans exactly that many days', () => {
  assert.deepEqual(dayRange('2026-10-15', 2), { start: '20261015', end: '20261017' });
  assert.deepEqual(dayRange('2026-10-15', 3), { start: '20261015', end: '20261018' });
});

test('half a day still takes a whole day off the calendar', () => {
  assert.deepEqual(dayRange('2026-10-15', 0.5), { start: '20261015', end: '20261016' });
  assert.deepEqual(dayRange('2026-10-15', 1.5), { start: '20261015', end: '20261017' });
  assert.deepEqual(dayRange('2026-10-15', 3.5), { start: '20261015', end: '20261019' });
});

/* days is nullable in the table. An event that ends before it starts is not a
   useful default, and neither is one Google silently rejects. */
test('a missing or nonsense duration means one day, never zero', () => {
  for (const d of [null, undefined, 0, -3, '', 'soon', NaN, Infinity]) {
    assert.deepEqual(dayRange('2026-10-15', d), { start: '20261015', end: '20261016' },
      'days = ' + JSON.stringify(d));
  }
  assert.equal(calendarDays(null), 1);
  assert.equal(calendarDays(0), 1);
});

test('it crosses month, year and leap boundaries correctly', () => {
  assert.deepEqual(dayRange('2026-10-31', 1), { start: '20261031', end: '20261101' });
  assert.deepEqual(dayRange('2026-12-31', 1), { start: '20261231', end: '20270101' });
  assert.deepEqual(dayRange('2026-12-30', 3), { start: '20261230', end: '20270102' });
  assert.deepEqual(dayRange('2028-02-28', 1), { start: '20280228', end: '20280229' });
  assert.deepEqual(dayRange('2028-02-29', 1), { start: '20280229', end: '20280301' });
  assert.deepEqual(dayRange('2027-02-28', 1), { start: '20270228', end: '20270301' });
});

/* THE ONE THAT WOULD NOT LOOK LIKE A BUG.
 *
 * install_date is a plain calendar day. Build it with local-time arithmetic
 * and the day shifts for anyone east of UTC — an install on the 15th goes out
 * as the 14th — and it never crashes, it just tells a customer the wrong day.
 *
 * Run in a CHILD PROCESS with TZ set, because this machine and Cloudflare
 * both run in UTC, where the wrong implementation looks exactly like the
 * right one. Swapping Date.UTC for local construction passed every test in
 * this file until this existed. */
test('the date is the same in every timezone on earth', () => {
  const here = new URL('./calendar.js', import.meta.url).pathname;
  const script =
    'import { dayRange } from ' + JSON.stringify(here) + ';' +
    'console.log(JSON.stringify([["2026-10-15",1],["2026-01-01",1],["2026-12-31",2],' +
    '["2026-03-08",1],["2026-11-01",3]].map(([d,n]) => dayRange(d,n))));';
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();

  const utc = run('UTC');
  assert.equal(utc, JSON.stringify([
    { start: '20261015', end: '20261016' },
    { start: '20260101', end: '20260102' },
    { start: '20261231', end: '20270102' },
    { start: '20260308', end: '20260309' },
    { start: '20261101', end: '20261104' },
  ]), utc);

  /* Kiritimati is +14 and Midway is -11 — the two ends of the inhabited
     range, and either side of the date line from UTC. */
  for (const tz of ['America/Denver', 'Asia/Tokyo', 'Pacific/Kiritimati',
                    'Pacific/Midway', 'Australia/Sydney', 'Europe/London']) {
    assert.equal(run(tz), utc, 'the dates moved under TZ=' + tz);
  }
});

test('daylight saving does not move the date', () => {
  const around = ['2026-03-07', '2026-03-08', '2026-03-09',
                  '2026-10-31', '2026-11-01', '2026-11-02'];
  for (const d of around) {
    const r = dayRange(d, 1);
    assert.equal(r.start, d.replace(/-/g, ''), d + ' start drifted');
  }
  /* And a span across the change is still the right number of nights. */
  assert.deepEqual(dayRange('2026-03-07', 3), { start: '20260307', end: '20260310' });
  assert.deepEqual(dayRange('2026-10-31', 3), { start: '20261031', end: '20261103' });
});

test('a date it cannot read produces no link at all, rather than a wrong one', () => {
  for (const bad of [null, '', 'tomorrow', '15/10/2026', '2026-13-01', '2026-02-30',
                     '2026-11-31', '2026-04-31', 'undefined']) {
    assert.equal(parseDay(bad), null, JSON.stringify(bad) + ' should not parse');
    assert.equal(dayRange(bad, 1), null);
    assert.equal(googleCalendarUrl({ title: 'x', installDate: bad, days: 1 }), null,
      'a button that opens an empty event looks like it worked');
  }
});

test('a full ISO timestamp still reads as its calendar day', () => {
  assert.equal(ymd(parseDay('2026-10-15T00:00:00.000Z')), '20261015');
  assert.equal(ymd(parseDay('2026-10-15T23:59:59-06:00')), '20261015',
    'the stored day is the day, whatever time rode along with it');
});

// ── the link ───────────────────────────────────────────────────────────────

function params(url) {
  const q = url.slice(url.indexOf('?') + 1).split('&');
  const out = {};
  for (const p of q) {
    const i = p.indexOf('=');
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

test('the link carries the event Google needs', () => {
  const url = googleCalendarUrl({
    title: 'Shed install — Hank Ellis', installDate: '2026-10-15', days: 2,
    details: '10x16 ft · barn\nPhone: 435-555-0000',
    location: '123 Main St, Eagle Mountain, UT',
    guests: ['hank@roof.test'],
  });
  assert.ok(url.startsWith(GOOGLE_CALENDAR_BASE + '?'), url);
  const p = params(url);
  assert.equal(p.action, 'TEMPLATE');
  assert.equal(p.dates, '20261015/20261017');
  assert.equal(decodeURIComponent(p.text), 'Shed install — Hank Ellis');
  assert.match(decodeURIComponent(p.details), /10x16 ft · barn/);
  assert.equal(decodeURIComponent(p.location), '123 Main St, Eagle Mountain, UT');
  assert.equal(decodeURIComponent(p.add), 'hank@roof.test');
});

/* The guest list is the whole point — without it the customer is never
   invited and this is just a note to self. */
test('every guest with a real address is invited, and nothing else is', () => {
  const url = googleCalendarUrl({ title: 'x', installDate: '2026-10-15', days: 1,
    guests: ['hank@roof.test', '  crew@shedpro.test  ', '', null, 'not-an-email', '@nope'] });
  assert.equal(decodeURIComponent(params(url).add), 'hank@roof.test,crew@shedpro.test');
});

test('no usable address means no guest list, not an empty one', () => {
  for (const g of [[], null, [''], ['nope']]) {
    const p = params(googleCalendarUrl({ title: 'x', installDate: '2026-10-15', days: 1, guests: g }));
    assert.equal(p.add, undefined, JSON.stringify(g));
  }
});

/* An address with a + in it is a real address, and a raw + in a query string
   decodes to a space — which would invite a stranger, or nobody. */
test('an address with a plus in it survives', () => {
  const url = googleCalendarUrl({ title: 'x', installDate: '2026-10-15', days: 1,
    guests: ['hank+sheds@roof.test'] });
  assert.equal(params(url).add, 'hank%2Bsheds%40roof.test');
  assert.equal(decodeURIComponent(params(url).add), 'hank+sheds@roof.test');
});

test('an ampersand in a note cannot break the rest of the link', () => {
  const url = googleCalendarUrl({ title: 'Shed & porch', installDate: '2026-10-15', days: 1,
    details: 'gate code 1234 & dog is friendly', location: 'Smith & Sons Rd' });
  const p = params(url);
  assert.equal(p.dates, '20261015/20261016', 'the dates survived');
  assert.equal(decodeURIComponent(p.text), 'Shed & porch');
  assert.equal(decodeURIComponent(p.details), 'gate code 1234 & dog is friendly');
  assert.equal(decodeURIComponent(p.location), 'Smith & Sons Rd');
});

test('the title says which job and whose', () => {
  assert.equal(installTitle('shed', 'Hank Ellis'), 'Shed install — Hank Ellis');
  assert.equal(installTitle('concrete', 'Hank Ellis'), 'Concrete pour — Hank Ellis');
  assert.equal(installTitle('shed', ''), 'Shed install');
  assert.equal(installTitle('shed', null), 'Shed install');
  assert.equal(installTitle('mystery', 'Hank'), 'Install — Hank');
});

test('the description carries what you need in the truck', () => {
  const d = installDetails({ summary: '10x16 ft · barn', phone: '435-555-0000',
    note: 'gate code 1234', days: 2, orderId: 42 });
  assert.match(d, /10x16 ft · barn/);
  assert.match(d, /Order #42/);
  assert.match(d, /Phone: 435-555-0000/);
  assert.match(d, /Scheduled: 2 days/);
  assert.match(d, /Note: gate code 1234/);

  assert.match(installDetails({ days: 1 }), /Scheduled: 1 day$/, 'one day, not "1 days"');
  assert.equal(installDetails({}), '', 'nothing known, nothing invented');
});
