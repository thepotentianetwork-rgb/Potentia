/* THE DATES SOMEBODY DRIVES TO.
 *
 * A schedule that is a day out does not fail — it sends a crew to a site on
 * the wrong morning, or has them building a shed in the shop for an install
 * that already happened. So every rule is checked against a named weekday,
 * and the weekend cases are enumerated rather than trusted to a formula.
 *
 * Run: node --test worker/schedule.test.mjs
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { planBuild, isWorkday, toWorkday, addWorkdays, dayFromISO, isoFromDay,
         foundationKind, anchorLabel, STAGE_LABELS, DEFAULT_INSTALL_DAYS,
         CURE_DAYS } from './schedule.js';

/* Named weekdays, so a failure says "that is a Sunday" rather than a number.
   2026-10-05 is a Monday. */
const MON = '2026-10-05', TUE = '2026-10-06', WED = '2026-10-07',
      THU = '2026-10-08', FRI = '2026-10-09', SAT = '2026-10-10', SUN = '2026-10-11';
/* The Monday AFTER that weekend. Written out because reaching for MON when
   you mean "the next working day" is off by a whole week and still looks
   plausible — which is what happened when this file was first written. */
const NEXT_MON = '2026-10-12', PREV_FRI = '2026-10-02';
const dow = (iso) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayFromISO(iso).getUTCDay()];
const plan = (iso, kind, days) => planBuild(iso, { foundation: kind, installDays: days });
const byItem = (stages) => Object.fromEntries(stages.map((s) => [s.item, s]));

test('the fixture weekdays are what this file claims they are', () => {
  assert.deepEqual([MON, TUE, WED, THU, FRI, SAT, SUN].map(dow),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

// ── working days ───────────────────────────────────────────────────────────

test('Monday to Friday are working days, the weekend is not', () => {
  assert.deepEqual([MON, TUE, WED, THU, FRI].map((d) => isWorkday(dayFromISO(d))),
    [true, true, true, true, true]);
  assert.deepEqual([SAT, SUN].map((d) => isWorkday(dayFromISO(d))), [false, false]);
});

test('a weekend date moves to the working day either side', () => {
  assert.equal(isoFromDay(toWorkday(dayFromISO(SAT), 1)), NEXT_MON, 'forward from Saturday');
  assert.equal(isoFromDay(toWorkday(dayFromISO(SUN), 1)), NEXT_MON, 'forward from Sunday');
  assert.equal(isoFromDay(toWorkday(dayFromISO(SAT), -1)), FRI, 'back from Saturday');
  assert.equal(isoFromDay(toWorkday(dayFromISO(SUN), -1)), FRI, 'back from Sunday');
  assert.equal(isoFromDay(toWorkday(dayFromISO(WED), 1)), WED, 'a weekday does not move');
});

test('counting working days skips the weekend', () => {
  assert.equal(isoFromDay(addWorkdays(dayFromISO(FRI), 1)), NEXT_MON, 'Friday + 1 is Monday');
  assert.equal(isoFromDay(addWorkdays(dayFromISO(MON), -1)), PREV_FRI, 'Monday - 1 is Friday');
  assert.equal(dow(isoFromDay(addWorkdays(dayFromISO(MON), -1))), 'Fri');
  assert.equal(isoFromDay(addWorkdays(dayFromISO(WED), 5)), '2026-10-14', 'five working days on');
  assert.equal(isoFromDay(addWorkdays(dayFromISO(MON), 0)), MON, 'zero stays put');
});

// ── concrete ───────────────────────────────────────────────────────────────

test('a concrete job: prep, pour, then a week, then shop and install', () => {
  const s = byItem(plan(WED, 'concrete'));
  assert.equal(s.pour.install_date, WED, 'the pour is the date entered');
  assert.equal(s.prep.install_date, TUE, 'prep is the working day before the pour');
  assert.equal(s.shed.install_date, '2026-10-14', 'install is a week after the pour');
  assert.equal(dow(s.shed.install_date), 'Wed', 'a week on is the same weekday');
  assert.equal(s.shop.install_date, '2026-10-13', 'the shop day is the day before the install');
  assert.equal(s.prep.days, 1);
  assert.equal(s.pour.days, 1);
  assert.equal(s.shop.days, 1);
  assert.equal(s.shed.days, DEFAULT_INSTALL_DAYS, 'two days on site by default');
});

test('they come back in the order they happen', () => {
  const dates = plan(WED, 'concrete').map((s) => s.install_date);
  assert.deepEqual(plan(WED, 'concrete').map((s) => s.item),
    ['prep', 'pour', 'materials', 'shop', 'shed']);
  assert.deepEqual([...dates].sort(), dates, 'a stage must never precede the one before it');
});

/* THE ONE THE WEEKEND RULE EXISTS FOR. A Monday pour means a Monday install,
   and the day before that is a Sunday. */
test('a Monday install is prepared for on the Friday, not the Sunday', () => {
  const s = byItem(plan(MON, 'concrete'));
  assert.equal(dow(s.shed.install_date), 'Mon');
  assert.equal(dow(s.shop.install_date), 'Fri', 'the shop day fell on a ' + dow(s.shop.install_date));
  assert.equal(s.shop.install_date, '2026-10-09');
});

test('a Monday pour is prepped on the Friday before', () => {
  const s = byItem(plan(MON, 'concrete'));
  assert.equal(dow(s.prep.install_date), 'Fri');
  assert.equal(s.prep.install_date, '2026-10-02');
});

test('no stage ever lands on a weekend, whatever date is entered', () => {
  for (let i = 0; i < 40; i++) {
    const d = isoFromDay(new Date(Date.UTC(2026, 9, 1 + i)));
    for (const kind of ['concrete', 'gravel', 'none']) {
      plan(d, kind).forEach((s) => {
        assert.ok(isWorkday(dayFromISO(s.install_date)),
          kind + ' from ' + d + ': ' + s.item + ' landed on ' + dow(s.install_date));
      });
    }
  }
});

/* Picking a Saturday for a pour is a slip. Honouring it quietly would put
   every later date a day out too. */
test('a weekend anchor is moved on, and everything else follows from there', () => {
  const sat = byItem(plan(SAT, 'concrete'));
  const mon = byItem(plan(NEXT_MON, 'concrete'));
  assert.equal(sat.pour.install_date, NEXT_MON, 'a Saturday pour becomes the Monday after');
  assert.deepEqual(sat, mon, 'and the rest of the plan matches that Monday exactly');
});

test('the cure is a week of calendar days, not working days', () => {
  const s = byItem(plan(WED, 'concrete'));
  const gap = (dayFromISO(s.shed.install_date) - dayFromISO(s.pour.install_date)) / 86400000;
  assert.equal(gap, CURE_DAYS, 'concrete cures over the weekend too');
});

// ── gravel ─────────────────────────────────────────────────────────────────

test('a gravel pad has no cure to wait out', () => {
  const s = byItem(plan(MON, 'gravel'));
  assert.equal(s.gravel.install_date, MON);
  assert.equal(s.shop.install_date, TUE, 'the shop day is the next working day');
  assert.equal(s.shed.install_date, WED, 'and the install the day after that');
  assert.equal(plan(MON, 'gravel').length, 4, 'no prep or pour on a gravel job');
  assert.deepEqual(plan(MON, 'gravel').map((s2) => s2.item), ['gravel', 'materials', 'shop', 'shed']);
});

/* MATERIALS HANGS OFF THE SHOP DAY, NOT THE ANCHOR, for every foundation —
   nothing can be built before the materials for it are in. On a gravel job
   that puts it on the pad day itself, because the shop day is the day after
   the pad. That is a tight week, not a bug, and it is pinned here so changing
   the rule has to be a decision rather than a side effect. */
test('materials is always the working day before the shop day', () => {
  for (const kind of ['concrete', 'gravel', 'none']) {
    for (const anchor of [MON, TUE, WED, THU, FRI]) {
      const s = byItem(plan(anchor, kind));
      assert.ok(s.materials, kind + ': no materials stage');
      assert.equal(s.materials.install_date,
        isoFromDay(addWorkdays(dayFromISO(s.shop.install_date), -1)),
        kind + ' from ' + anchor + ': materials is not the day before the shop day');
      assert.ok(s.materials.install_date < s.shop.install_date,
        kind + ': materials is not before the shop day');
    }
  }
  assert.equal(byItem(plan(MON, 'gravel')).materials.install_date, MON,
    'on a gravel job it lands on the pad day');
});

test('a gravel job late in the week runs into the next one', () => {
  const s = byItem(plan(THU, 'gravel'));
  assert.equal(s.gravel.install_date, THU);
  assert.equal(s.shop.install_date, FRI);
  assert.equal(s.shed.install_date, '2026-10-12', 'the Monday, not the Saturday');
  assert.equal(dow(s.shed.install_date), 'Mon');
});

// ── no foundation ──────────────────────────────────────────────────────────

test('with no foundation work it is a shop day and an install', () => {
  const s = byItem(plan(TUE, 'none'));
  assert.deepEqual(plan(TUE, 'none').map((x) => x.item), ['materials', 'shop', 'shed']);
  assert.equal(s.shed.install_date, TUE, 'the date entered is the install');
  assert.equal(s.shop.install_date, MON);
});

test('an install on a Monday is still built on the Friday', () => {
  assert.equal(byItem(plan(MON, 'none')).shop.install_date, '2026-10-02');
  assert.equal(dow(byItem(plan(MON, 'none')).shop.install_date), 'Fri');
});

// ── install length ─────────────────────────────────────────────────────────

test('a longer install is carried, and only on the install', () => {
  const s = byItem(plan(WED, 'concrete', 3));
  assert.equal(s.shed.days, 3);
  assert.equal(s.shop.days, 1, 'the shop day is still one day');
  assert.equal(s.prep.days, 1);
  assert.equal(s.pour.days, 1);
});

test('a nonsense length falls back to the default rather than zero days', () => {
  for (const d of [null, undefined, 0, -2, '', 'two', NaN, Infinity]) {
    assert.equal(byItem(plan(WED, 'concrete', d)).shed.days, DEFAULT_INSTALL_DAYS,
      'installDays = ' + JSON.stringify(d));
  }
  assert.equal(byItem(plan(WED, 'concrete', 1.5)).shed.days, 2, 'half days round up');
});

// ── the edges ──────────────────────────────────────────────────────────────

test('it crosses months, years and a leap day', () => {
  assert.equal(byItem(plan('2026-12-30', 'concrete')).shed.install_date, '2027-01-06');
  assert.equal(byItem(plan('2026-11-02', 'concrete')).prep.install_date, '2026-10-30');
  assert.equal(byItem(plan('2028-02-28', 'concrete')).shed.install_date, '2028-03-06');
  assert.equal(byItem(plan('2028-03-01', 'concrete')).prep.install_date, '2028-02-29');
});

/* THE ONE THIS MACHINE CANNOT SEE.
 *
 * install_date is a plain calendar day. Build it with local-time arithmetic
 * and the day shifts for anyone east of UTC — a pour on the 7th is planned
 * from the 6th, and every stage after it moves too. It never throws.
 *
 * Run in a CHILD PROCESS with TZ set, because this machine and Cloudflare
 * both run in UTC, where the wrong implementation is identical to the right
 * one. Swapping Date.UTC for local construction passed every test above. */
test('the plan is the same in every timezone on earth', () => {
  const mod = new URL('./schedule.js', import.meta.url).pathname;
  const script =
    'import { planBuild } from ' + JSON.stringify(mod) + ';' +
    'console.log(JSON.stringify([["2026-10-05","concrete"],["2026-10-07","concrete"],' +
    '["2026-10-08","gravel"],["2026-10-06","none"],["2026-12-30","concrete"]]' +
    '.map(([d,f]) => planBuild(d,{foundation:f}))));';
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();

  const utc = run('UTC');
  /* Sanity: the baseline is the plan this file asserts elsewhere. */
  assert.match(utc, /"install_date":"2026-10-14"/, utc.slice(0, 200));

  for (const tz of ['America/Denver', 'Asia/Tokyo', 'Pacific/Kiritimati',
                    'Pacific/Midway', 'Australia/Sydney', 'Europe/London']) {
    assert.equal(run(tz), utc, 'the plan moved under TZ=' + tz);
  }
});

test('a date it cannot read produces no plan at all', () => {
  for (const bad of [null, '', 'next tuesday', '05/10/2026', '2026-13-01',
                     '2026-02-30', '2026-11-31', undefined]) {
    assert.equal(planBuild(bad, { foundation: 'concrete' }), null, JSON.stringify(bad));
  }
});

test('an unknown foundation is treated as none rather than crashing', () => {
  assert.deepEqual(plan(TUE, 'mystery').map((s) => s.item), ['materials', 'shop', 'shed']);
  assert.deepEqual(planBuild(TUE, {}).map((s) => s.item), ['materials', 'shop', 'shed']);
});

// ── reading the design ─────────────────────────────────────────────────────

test('the designer’s foundation value maps to the right plan', () => {
  assert.equal(foundationKind({ foundation: 'pad' }), 'concrete', 'pad means a CONCRETE pad');
  assert.equal(foundationKind({ foundation: 'gravel' }), 'gravel');
  assert.equal(foundationKind({ foundation: 'none' }), 'none');
  assert.equal(foundationKind({}), 'none');
  assert.equal(foundationKind(null), 'none');
});

test('the form can name its own field', () => {
  assert.equal(anchorLabel('concrete'), 'Pour date');
  assert.equal(anchorLabel('gravel'), 'Pad date');
  assert.equal(anchorLabel('none'), 'Install date');
});

test('every stage a plan produces has a label to show', () => {
  for (const kind of ['concrete', 'gravel', 'none']) {
    plan(WED, kind).forEach((s) => {
      assert.ok(STAGE_LABELS[s.item], kind + ': no label for "' + s.item + '"');
    });
  }
  assert.ok(STAGE_LABELS.concrete, 'the older single entry still needs one');
});
