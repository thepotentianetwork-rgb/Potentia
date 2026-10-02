/* THE DASHBOARD'S ARITHMETIC, WHICH IS ALL ABOUT DAYS.
 *
 * Every number on that screen is derived from dates, and date bugs are the
 * quiet kind: a sparkline that leaves out its empty days, a job that drops off
 * the week on its second morning, "Due today" that means today in the wrong
 * timezone. None of those look broken. They just make the screen wrong, on the
 * screen decisions get made from.
 *
 * Run: node --test worker/dashboard.test.mjs
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dashDay, daysBetween, agoLabel, monthToDate, daySeries,
         stagesInWindow, pickFollowUps, renderThumb } from './dashboard.js';

// ── days ────────────────────────────────────────────────────────────────────

test('a day is read out of whatever shape the row is in', () => {
  assert.equal(dashDay('2026-10-15'), '2026-10-15');
  assert.equal(dashDay('2026-10-15T14:30:00.000Z'), '2026-10-15');
  assert.equal(dashDay(''), null);
  assert.equal(dashDay('next tuesday'), null);
  assert.equal(dashDay(null), null);
  assert.equal(dashDay(undefined), null);
});

test('days between is counted on the calendar', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-02'), 1);
  assert.equal(daysBetween('2026-10-02', '2026-10-01'), -1);
  assert.equal(daysBetween('2026-10-15', '2026-10-15'), 0);
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1, 'across a month');
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1, 'across a year');
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2, 'across a leap day');
  assert.equal(daysBetween('nonsense', '2026-10-01'), null);
});

test('a daylight saving change does not swallow a day', () => {
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-03-07', '2026-03-08'), 1, 'and the spring one');
  assert.equal(daysBetween('2026-10-25', '2026-11-05'), 11, 'straddling it');
});

/* WHAT THIS CAN AND CANNOT PROVE, stated plainly because the gap is easy to
   forget. A version of daysBetween that built LOCAL dates and divided
   milliseconds passed every assertion above, and passes this one too: the
   container's tzdata reports no DST transition for 2026 in any zone (checked —
   America/Denver reads -0700 on both sides of the March change), so the hour
   that breaks that arithmetic never happens here and cannot be made to.
   What makes it bite anyway is the 400-day sweep run INSIDE each zone, below:
   a local-time version disagrees with the UTC baseline somewhere in that year
   even here, where the hand-picked dates all agreed. */
test('every answer is the same in every timezone on earth', () => {
  const mod = new URL('./dashboard.js', import.meta.url).pathname;
  const script =
    'import { daysBetween, daySeries, monthToDate, stagesInWindow, agoLabel } from '
      + JSON.stringify(mod) + ';' +
    'console.log(JSON.stringify({' +
    'dst: [["2026-10-31","2026-11-01"],["2026-03-07","2026-03-08"],' +
         '["2026-10-25","2026-11-05"],["2026-12-31","2027-01-01"]]' +
         '.map(([a,b]) => daysBetween(a,b)),' +
    'series: daySeries(["2026-10-31T23:30:00Z","2026-11-01T00:30:00Z"],"2026-10-30","2026-11-03"),' +
    'month: monthToDate("2026-11-01"),' +
    'week: stagesInWindow([{id:1,install_date:"2026-10-31",days:2}],"2026-11-01","2026-11-02")' +
          '.map((x) => x.id),' +
    'ago: agoLabel("2026-10-31T12:00:00Z","2026-11-05",Date.parse("2026-11-05T12:00:00Z")),' +
    /* The same 400-day sweep, run INSIDE each zone. Without this the comparison
       only covered a handful of hand-picked dates, none of which straddled a
       transition this container knows about — so the broken version agreed with
       itself across every zone and the test passed. */
    'sweep: (function(){var d="2026-01-01",bad=0;' +
      'for(var i=0;i<400;i++){var t=new Date(d+"T00:00:00Z");' +
      't.setUTCDate(t.getUTCDate()+1);var n=t.toISOString().slice(0,10);' +
      'if(daysBetween(d,n)!==1)bad++;d=n;}return bad;})()' +
    '}));';
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();

  const utc = run('UTC');
  /* Sanity: the baseline really is the answer this file asserts elsewhere, so
     a run of all-nulls could not quietly agree with itself. */
  assert.match(utc, /"dst":\[1,1,11,1\]/, utc);
  assert.match(utc, /"week":\[1\]/, utc);
  assert.match(utc, /"sweep":0/, utc + ' — the baseline itself is off by a day');

  for (const tz of ['America/Denver', 'Pacific/Auckland', 'Asia/Tokyo',
                    'Pacific/Kiritimati', 'Pacific/Midway', 'Europe/London']) {
    assert.equal(run(tz), utc, 'the dashboard moved under TZ=' + tz);
  }
});

/* 400 consecutive days, each one day after the last. A Math.floor over a short
   day, or a round over a long one, breaks somewhere in that year. Run here in
   the suite's own zone, and again inside six others by the test above. */
test('one day after a day is always exactly one day, all year', () => {
  let day = '2026-01-01';
  for (let i = 0; i < 400; i++) {
    const d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const next = d.toISOString().slice(0, 10);
    assert.equal(daysBetween(day, next), 1, day + ' -> ' + next + ' was not one day');
    assert.equal(daysBetween(next, day), -1, 'and backwards from ' + next);
    day = next;
  }
  assert.equal(day, '2027-02-05', 'the sweep did not cover the year it claims');
});

test('how long ago, in the words a person would use', () => {
  const now = Date.parse('2026-10-15T14:00:00Z');
  const today = '2026-10-15';
  assert.equal(agoLabel('2026-10-15T13:59:30Z', today, now), 'just now');
  assert.equal(agoLabel('2026-10-15T13:30:00Z', today, now), '30m ago');
  assert.equal(agoLabel('2026-10-15T12:00:00Z', today, now), '2h ago');
  assert.equal(agoLabel('2026-10-14T12:00:00Z', today, now), 'yesterday');
  assert.equal(agoLabel('2026-10-10T12:00:00Z', today, now), '5 days ago');
  assert.equal(agoLabel('2026-08-01T12:00:00Z', today, now), '2 months ago');
  /* 29 days stays in days: it is more use than "a month ago", and a lead that
     has been waiting four weeks should read as the number it is. */
  assert.equal(agoLabel('2026-09-16T12:00:00Z', today, now), '29 days ago');
  assert.equal(agoLabel('2026-09-10T12:00:00Z', today, now), 'a month ago');
  assert.equal(agoLabel('not a date', today, now), '');
});

test('the month runs from the first to today, not to the end of it', () => {
  assert.deepEqual(monthToDate('2026-10-15'), { start: '2026-10-01', end: '2026-10-15' });
  assert.deepEqual(monthToDate('2026-10-01'), { start: '2026-10-01', end: '2026-10-01' },
    'on the first it is one day, not an empty range');
  assert.equal(monthToDate('rubbish'), null);
});

// ── the sparkline ───────────────────────────────────────────────────────────

/* A SPARKLINE OF ONLY THE DAYS SOMETHING HAPPENED IS A DIFFERENT SHAPE, and a
   flattering one: four leads on four scattered days draws as a solid run. */
test('every day in the window gets a bar, including the empty ones', () => {
  const s = daySeries(['2026-10-01', '2026-10-01', '2026-10-04'],
                      '2026-10-01', '2026-10-05');
  assert.deepEqual(s, [2, 0, 0, 1, 0]);
  assert.equal(s.length, 5, 'one bar per day of the window');
});

test('it counts timestamps as the day they fall on', () => {
  assert.deepEqual(daySeries(['2026-10-02T23:59:00Z', '2026-10-02T00:01:00Z'],
                             '2026-10-01', '2026-10-03'), [0, 2, 0]);
});

test('anything outside the window is left out rather than piled on the edge', () => {
  assert.deepEqual(daySeries(['2026-09-30', '2026-10-02', '2026-10-06'],
                             '2026-10-01', '2026-10-03'), [0, 1, 0]);
});

test('a window of one day is one bar', () => {
  assert.deepEqual(daySeries(['2026-10-01'], '2026-10-01', '2026-10-01'), [1]);
});

test('nonsense in produces an empty series, not a wrong one', () => {
  assert.deepEqual(daySeries(['2026-10-01'], '2026-10-05', '2026-10-01'), [], 'backwards');
  assert.deepEqual(daySeries(['2026-10-01'], 'x', '2026-10-05'), []);
  assert.deepEqual(daySeries(null, '2026-10-01', '2026-10-03'), [0, 0, 0]);
  assert.deepEqual(daySeries(['junk', null, ''], '2026-10-01', '2026-10-02'), [0, 0]);
});

test('it crosses a month without losing a day', () => {
  const s = daySeries(['2026-10-31', '2026-11-01'], '2026-10-30', '2026-11-02');
  assert.deepEqual(s, [0, 1, 1, 0]);
});

// ── the week strip ──────────────────────────────────────────────────────────

const WEEK = [
  { id: 1, item: 'shed',      install_date: '2026-10-12', days: 2 },
  { id: 2, item: 'shop',      install_date: '2026-10-14', days: 1 },
  { id: 3, item: 'materials', install_date: '2026-10-16', days: 1 },
  { id: 4, item: 'prep',      install_date: '2026-10-20', days: 1 },
  { id: 5, item: 'pour',      install_date: '2026-10-05', days: 1 }
];

test('the week shows the jobs that fall in it, in order', () => {
  assert.deepEqual(stagesInWindow(WEEK, '2026-10-12', '2026-10-18').map((x) => x.id),
    [1, 2, 3]);
});

/* THE ONE THAT MATTERS. A two-day install that began yesterday is still
   happening today — filtering on the start date alone drops exactly the job
   somebody is standing on. */
test('a job already underway is still on the screen on its second day', () => {
  const found = stagesInWindow(WEEK, '2026-10-13', '2026-10-19').map((x) => x.id);
  assert.ok(found.indexOf(1) !== -1,
    'the two-day install starting the 12th vanished on the 13th: ' + found.join(','));
});

test('a job that finished yesterday is gone', () => {
  assert.deepEqual(stagesInWindow(WEEK, '2026-10-14', '2026-10-20').map((x) => x.id),
    [2, 3, 4], 'the install ended on the 13th and should not be here');
});

test('a length that makes no sense is treated as one day', () => {
  const odd = [{ id: 9, install_date: '2026-10-12', days: 0 },
               { id: 8, install_date: '2026-10-12', days: null },
               { id: 7, install_date: '2026-10-12', days: 'ages' }];
  assert.deepEqual(stagesInWindow(odd, '2026-10-12', '2026-10-12').map((x) => x.id), [7, 8, 9]);
  assert.deepEqual(stagesInWindow(odd, '2026-10-13', '2026-10-13'), [],
    'a nonsense length stretched the job into the next day');
});

test('a half day still covers its day', () => {
  const half = [{ id: 1, install_date: '2026-10-12', days: 0.5 }];
  assert.deepEqual(stagesInWindow(half, '2026-10-12', '2026-10-12').map((x) => x.id), [1]);
});

test('a booking with no readable date is left out', () => {
  assert.deepEqual(stagesInWindow([{ id: 1, install_date: 'soon', days: 1 }],
                                  '2026-10-12', '2026-10-18'), []);
  assert.deepEqual(stagesInWindow(null, '2026-10-12', '2026-10-18'), []);
  assert.deepEqual(stagesInWindow(WEEK, 'x', '2026-10-18'), []);
});

// ── who to ring ─────────────────────────────────────────────────────────────

const TODAY = '2026-10-15';
function cust(over) {
  return Object.assign({ id: 1, name: 'Hank Ellis', phone: '4355550000',
                         follow_up_at: null, latest_status: 'quoted',
                         latest_note: null, last_call_at: null,
                         latest_submission_at: '2026-10-14T09:00:00Z' }, over);
}

test('a revisit date that has arrived comes up', () => {
  const r = pickFollowUps([cust({ follow_up_at: TODAY })], TODAY);
  assert.equal(r.length, 1);
  assert.equal(r[0].when, 'Due today');
  assert.equal(r[0].urgent, true);
  assert.equal(r[0].phone, '4355550000', 'nothing to ring them on');
});

test('a revisit date still ahead does not', () => {
  assert.deepEqual(pickFollowUps([cust({ follow_up_at: '2026-10-20' })], TODAY), []);
});

test('an overdue one says how late it is', () => {
  assert.equal(pickFollowUps([cust({ follow_up_at: '2026-10-14' })], TODAY)[0].when, '1 day late');
  assert.equal(pickFollowUps([cust({ follow_up_at: '2026-10-11' })], TODAY)[0].when, '4 days late');
});

/* AN UNANSWERED LEAD IS THE ROW THAT COSTS MONEY, and nothing puts it there —
   no date was ever set on it, which is the whole problem. */
test('a lead nobody has called comes up on its own', () => {
  const r = pickFollowUps([cust({ latest_status: 'new' })], TODAY);
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /New lead/);
  assert.equal(r[0].urgent, false);
});

test('a lead that has been called does not', () => {
  assert.deepEqual(pickFollowUps([cust({ latest_status: 'new',
    last_call_at: '2026-10-14T10:00:00Z' })], TODAY), []);
});

/* Writing something down about a customer is not the same as having spoken to
   them, and treating it as contact is how a lead goes quiet for a fortnight. */
test('a note is not a phone call', () => {
  const r = pickFollowUps([cust({ latest_status: 'new', latest_note: 'left a note' })], TODAY);
  assert.equal(r.length, 1, 'a note counted as having contacted them');
  assert.equal(r[0].reason, 'left a note', 'and the note is what it says');
});

test('a customer further along is not chased for no reason', () => {
  ['contacted', 'quoted', 'won', 'lost'].forEach((status) => {
    assert.deepEqual(pickFollowUps([cust({ latest_status: status })], TODAY), [],
      status + ' was put on the call list');
  });
});

/* THE PROMISE ALREADY BROKEN OUTRANKS THE ONE JUST MADE. */
test('the latest is first, and a due date beats a new lead', () => {
  const rows = [
    cust({ id: 1, name: 'Due today', follow_up_at: TODAY }),
    cust({ id: 2, name: 'Four days late', follow_up_at: '2026-10-11' }),
    cust({ id: 3, name: 'A new lead', latest_status: 'new' }),
    cust({ id: 4, name: 'One day late', follow_up_at: '2026-10-14' })
  ];
  assert.deepEqual(pickFollowUps(rows, TODAY).map((x) => x.name),
    ['Four days late', 'One day late', 'Due today', 'A new lead']);
});

test('two leads the same age come up oldest first', () => {
  const rows = [
    cust({ id: 1, name: 'Newer', latest_status: 'new', latest_submission_at: '2026-10-14T12:00:00Z' }),
    cust({ id: 2, name: 'Older', latest_status: 'new', latest_submission_at: '2026-10-09T12:00:00Z' })
  ];
  assert.deepEqual(pickFollowUps(rows, TODAY).map((x) => x.name), ['Older', 'Newer']);
});

test('the note is the reason, because it says what to talk about', () => {
  const r = pickFollowUps([cust({ follow_up_at: TODAY,
    latest_note: 'Asked about delivery timing' })], TODAY);
  assert.equal(r[0].reason, 'Asked about delivery timing');
});

test('with no note it still says why it is on the list', () => {
  assert.equal(pickFollowUps([cust({ follow_up_at: TODAY })], TODAY)[0].reason, 'Follow up due');
  assert.equal(pickFollowUps([cust({ follow_up_at: TODAY, latest_note: '   ' })], TODAY)[0].reason,
    'Follow up due', 'a note of spaces is not a reason');
});

test('the list is capped, so a bad month does not become the whole screen', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(cust({ id: i, follow_up_at: '2026-10-01' }));
  assert.equal(pickFollowUps(many, TODAY).length, 6);
  assert.equal(pickFollowUps(many, TODAY, 3).length, 3);
});

test('nothing to do produces an empty list, not a crash', () => {
  assert.deepEqual(pickFollowUps([], TODAY), []);
  assert.deepEqual(pickFollowUps(null, TODAY), []);
  assert.deepEqual(pickFollowUps([cust()], 'rubbish'), []);
  assert.equal(pickFollowUps([cust({ name: null, phone: null, follow_up_at: TODAY })], TODAY)[0].name,
    'Unnamed customer');
});

// ── the thumbnail ───────────────────────────────────────────────────────────

test('the perspective view is the one shown', () => {
  assert.equal(renderThumb({ renders: { perspective: 'https://r2.test/p.jpg',
                                        front: 'https://r2.test/f.jpg' } }),
    'https://r2.test/p.jpg');
});

test('any view is better than none', () => {
  assert.equal(renderThumb({ renders: { front: 'https://r2.test/f.jpg' } }), 'https://r2.test/f.jpg');
  assert.equal(renderThumb({ renders: { back: 'https://r2.test/b.jpg' } }), 'https://r2.test/b.jpg');
});

/* A SHED THAT IS NOT THEIRS, ON A BUILD-DAY ROW, IS THE WRONG SHED IN FRONT OF
   THE CREW. An order with no render gets no picture. */
test('an order with no renders gets nothing rather than a stand-in', () => {
  assert.equal(renderThumb({}), null);
  assert.equal(renderThumb({ renders: null }), null);
  assert.equal(renderThumb({ renders: {} }), null);
  assert.equal(renderThumb(null), null);
  assert.equal(renderThumb({ renders: 'https://r2.test/x.jpg' }), null, 'not an object');
});

test('only a real https url is used', () => {
  assert.equal(renderThumb({ renders: { perspective: 'javascript:alert(1)' } }), null);
  assert.equal(renderThumb({ renders: { perspective: 'http://r2.test/p.jpg' } }), null);
  assert.equal(renderThumb({ renders: { perspective: '/local/p.jpg' } }), null);
  assert.equal(renderThumb({ renders: { perspective: 42 } }), null);
});
