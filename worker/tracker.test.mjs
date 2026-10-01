/* THE FOUR PHASES, AND THE WAYS A DERIVED STATUS LIES.
 *
 * Every phase here is read off install rows the shop books and ticks by hand,
 * which means the input is messy: stages missed, stages ticked out of order,
 * orders with no foundation, orders with nothing booked at all. A tracker that
 * is confidently wrong is worse than no tracker — the customer stops asking and
 * starts turning up — so each of those shapes is pinned.
 *
 * Run: node --test worker/tracker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPhases, trackComplete, trackChangeWindow, trackStageLabel,
         setTrackNow } from './tracker.js';

/* A concrete job, in the order planBuild produces it. */
function build(done = []) {
  return [
    { item: 'prep',      install_date: '2026-10-06', done_at: tick('prep', done) },
    { item: 'pour',      install_date: '2026-10-07', done_at: tick('pour', done) },
    { item: 'materials', install_date: '2026-10-12', done_at: tick('materials', done) },
    { item: 'shop',      install_date: '2026-10-13', done_at: tick('shop', done) },
    { item: 'shed',      install_date: '2026-10-14', done_at: tick('shed', done) }
  ];
}
function tick(item, done) {
  return done.indexOf(item) !== -1 ? '2026-10-20T15:00:00.000Z' : null;
}
function states(installs) {
  const out = {};
  trackPhases(installs).forEach((p) => { out[p.key] = p.state; });
  return out;
}

test('four phases, always, in the order they happen', () => {
  const p = trackPhases(build());
  assert.deepEqual(p.map((x) => x.key), ['prebuild', 'materials', 'shop', 'install']);
  assert.deepEqual(p.map((x) => x.label),
    ['Pre-build', 'Gathering materials', 'Building in the shop', 'Build day']);
});

/* An order with nothing booked yet still has to draw four steps. */
test('an order with no bookings at all is in phase one', () => {
  assert.deepEqual(states([]), { prebuild: 'active', materials: 'upcoming',
                                 shop: 'upcoming', install: 'upcoming' });
  assert.equal(trackPhases([]).length, 4);
  assert.deepEqual(trackPhases([])[0].stages, [], 'invented a stage out of nothing');
});

test('nothing ticked off yet means phase one, however far ahead the dates are', () => {
  assert.deepEqual(states(build()), { prebuild: 'active', materials: 'upcoming',
                                      shop: 'upcoming', install: 'upcoming' });
});

/* THE WHOLE POINT. A date going past is not progress. */
test('a booked date in the past is still not progress', () => {
  const past = build().map((r) => ({ ...r, install_date: '2020-01-02' }));
  assert.deepEqual(states(past), { prebuild: 'active', materials: 'upcoming',
                                   shop: 'upcoming', install: 'upcoming' });
  assert.equal(trackComplete(past), false);
});

test('the foundation belongs to phase one, with its own ticks', () => {
  const p = trackPhases(build(['prep']));
  assert.deepEqual(p[0].stages.map((s) => [s.item, s.done]),
    [['prep', true], ['pour', false]]);
  assert.equal(p[0].state, 'active', 'phase one finished with the pour still to do');
  assert.equal(p[0].stages[0].label, 'Site preparation');
  assert.deepEqual(p[1].stages.map((s) => s.item), ['materials'],
    'the foundation leaked into the materials phase');
});

test('phase one closes when the foundation is in', () => {
  assert.deepEqual(states(build(['prep', 'pour'])),
    { prebuild: 'done', materials: 'active', shop: 'upcoming', install: 'upcoming' });
});

test('the phases advance one tick at a time', () => {
  assert.deepEqual(states(build(['prep', 'pour', 'materials'])),
    { prebuild: 'done', materials: 'done', shop: 'active', install: 'upcoming' });
  assert.deepEqual(states(build(['prep', 'pour', 'materials', 'shop'])),
    { prebuild: 'done', materials: 'done', shop: 'done', install: 'active' });
  assert.deepEqual(states(build(['prep', 'pour', 'materials', 'shop', 'shed'])),
    { prebuild: 'done', materials: 'done', shop: 'done', install: 'done' });
});

/* STAGES ARE TICKED OFF BY HAND IN A YARD, so one will get missed. A shed
   cannot be installed without having been built, so a later tick stands in for
   the earlier ones — otherwise the customer reads "built ✓ / materials ✗". */
test('a later tick proves the stages nobody remembered to tick', () => {
  assert.deepEqual(states(build(['shed'])),
    { prebuild: 'done', materials: 'done', shop: 'done', install: 'done' });
  assert.deepEqual(states(build(['shop'])),
    { prebuild: 'done', materials: 'done', shop: 'done', install: 'active' });
});

test('an order with no foundation work still moves through the phases', () => {
  const noFoundation = [
    { item: 'materials', install_date: '2026-10-02', done_at: null },
    { item: 'shop', install_date: '2026-10-05', done_at: null },
    { item: 'shed', install_date: '2026-10-06', done_at: null }
  ];
  assert.deepEqual(states(noFoundation), { prebuild: 'active', materials: 'upcoming',
                                           shop: 'upcoming', install: 'upcoming' });
  assert.deepEqual(trackPhases(noFoundation)[0].stages, [],
    'phase one claimed a foundation this order does not have');

  noFoundation[0].done_at = '2026-10-02T12:00:00Z';
  assert.deepEqual(states(noFoundation), { prebuild: 'done', materials: 'done',
                                           shop: 'active', install: 'upcoming' });
});

test('a gravel pad counts as the foundation', () => {
  const gravel = [{ item: 'gravel', install_date: '2026-10-05', done_at: '2026-10-05T12:00:00Z' },
                  { item: 'materials', install_date: '2026-10-05', done_at: null }];
  assert.equal(states(gravel).prebuild, 'done');
  assert.equal(trackPhases(gravel)[0].stages[0].label, 'Gravel pad laid');
});

/* Rows booked before the stages were split carry item 'concrete', and such an
   order has no materials or shop row at all. Those phases cannot be ticked off
   because there is nothing in them to tick, so the build sits at "gathering
   materials" until the shed itself is done, which then smooths the lot. Being
   stuck one phase early is the right way round: it never claims progress the
   shop has not confirmed. */
test('an old single foundation row still lands in phase one', () => {
  const old = [{ item: 'concrete', install_date: '2026-10-05', done_at: '2026-10-05T12:00:00Z' },
               { item: 'shed', install_date: '2026-10-12', done_at: null }];
  assert.equal(states(old).prebuild, 'done');
  assert.equal(trackPhases(old)[0].stages[0].label, 'Foundation');
  assert.equal(states(old).materials, 'active', 'it ran ahead of what was confirmed');
  assert.equal(states(old).install, 'upcoming');

  old[1].done_at = '2026-10-12T16:00:00Z';
  assert.deepEqual(states(old), { prebuild: 'done', materials: 'done',
                                  shop: 'done', install: 'done' });
});

/* A job redone books a second row for the same stage. */
test('a stage booked twice is only done when both are', () => {
  const twice = [{ item: 'shop', install_date: '2026-10-13', done_at: '2026-10-13T12:00:00Z' },
                 { item: 'shop', install_date: '2026-10-20', done_at: null }];
  const p = trackPhases(twice);
  assert.equal(p[2].stages.length, 1, 'the same stage was listed twice to the customer');
  assert.equal(p[2].stages[0].done, false, 'a redo was reported as finished');
  assert.equal(p[2].stages[0].date, '2026-10-13', 'the earlier date is the one shown');
});

test('the date shown for a phase is the first day of it', () => {
  const p = trackPhases(build());
  assert.equal(p[0].date, '2026-10-06', 'phase one starts with the prep day');
  assert.equal(p[3].date, '2026-10-14');
  assert.equal(trackPhases([])[0].date, null, 'a date out of nowhere');
});

test('a date nobody can parse is left out rather than guessed at', () => {
  const junk = [{ item: 'shop', install_date: 'sometime next week', done_at: null },
                { item: 'shed', install_date: '', done_at: null }];
  assert.equal(trackPhases(junk)[2].date, null);
  assert.equal(trackPhases(junk)[2].stages[0].date, null);
});

// ── finished ────────────────────────────────────────────────────────────────

test('an order with nothing booked is not a finished one', () => {
  assert.equal(trackComplete([]), false, 'all of nothing counted as done');
});

test('finished means every phase done', () => {
  assert.equal(trackComplete(build(['prep', 'pour', 'materials', 'shop'])), false);
  assert.equal(trackComplete(build(['prep', 'pour', 'materials', 'shop', 'shed'])), true);
  assert.equal(trackComplete(build(['shed'])), true, 'a later tick finishes it');
});

// ── the change window ───────────────────────────────────────────────────────

test('changes are open while nothing is booked, with no deadline to name', () => {
  setTrackNow('2026-09-01T00:00:00Z');
  assert.deepEqual(trackChangeWindow([]), { open: true, until: null, reason: 'unscheduled' });
});

test('once a build is booked, changes close the day before it starts', () => {
  setTrackNow('2026-09-01T00:00:00Z');
  assert.deepEqual(trackChangeWindow(build()),
    { open: true, until: '2026-10-05', reason: 'scheduled' });
});

/* THE ONE A PER-PHASE RULE WOULD HAVE GOT WRONG: the concrete is in, the
   customer is still inside "phase 1", and the size of the shed it was poured
   for is no longer up for discussion. */
test('anything ticked off shuts the window, even in phase one', () => {
  setTrackNow('2026-09-01T00:00:00Z');
  assert.deepEqual(trackChangeWindow(build(['prep'])),
    { open: false, until: null, reason: 'started' });
  assert.deepEqual(trackChangeWindow(build(['pour'])),
    { open: false, until: null, reason: 'started' });
});

test('a build starting today leaves no window to offer', () => {
  setTrackNow('2026-10-06T09:00:00Z');
  assert.deepEqual(trackChangeWindow(build()),
    { open: false, until: null, reason: 'started' });
});

test('a build starting tomorrow offers today, not yesterday', () => {
  setTrackNow('2026-10-05T09:00:00Z');
  assert.deepEqual(trackChangeWindow(build()),
    { open: true, until: '2026-10-05', reason: 'scheduled' });
});

test('an unreadable date is treated as nothing booked, not as a deadline', () => {
  setTrackNow('2026-09-01T00:00:00Z');
  assert.deepEqual(trackChangeWindow([{ item: 'shed', install_date: 'soon', done_at: null }]),
    { open: true, until: null, reason: 'unscheduled' });
});

test('it crosses a month boundary backwards', () => {
  setTrackNow('2026-09-01T00:00:00Z');
  assert.equal(trackChangeWindow([{ item: 'prep', install_date: '2026-11-01', done_at: null }]).until,
    '2026-10-31');
  assert.equal(trackChangeWindow([{ item: 'prep', install_date: '2027-01-01', done_at: null }]).until,
    '2026-12-31', 'and a year boundary');
});

// ── labels ──────────────────────────────────────────────────────────────────

test('every stage the planner books has a customer-facing name', () => {
  ['prep', 'pour', 'gravel', 'materials', 'shop', 'shed', 'concrete'].forEach((item) => {
    const label = trackStageLabel(item);
    assert.ok(label && label !== item, 'no customer wording for "' + item + '"');
  });
});

test('an unknown stage falls back to its own name rather than vanishing', () => {
  assert.equal(trackStageLabel('warranty-visit'), 'warranty-visit');
  assert.equal(trackStageLabel(''), '');
  assert.equal(trackStageLabel(undefined), '');
});
