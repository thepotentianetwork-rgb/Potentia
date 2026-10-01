/* WHAT THE CUSTOMER SEES, DERIVED FROM WHAT THE SHOP ALREADY RECORDS.
 *
 * Four phases, in the customer's words:
 *
 *   1  Pre-build            the order is in; changes are still possible
 *   2  Gathering materials  buying the lumber, siding, doors and windows
 *   3  Building in the shop the shed is assembled off site
 *   4  Build day            it is delivered and set on its foundation
 *
 * NOTHING HERE IS A STORED STATUS. The phase is read off the install rows the
 * shop already books and ticks off, because a second status field would have to
 * be kept in step by hand and would therefore be wrong — and a tracker that is
 * wrong is worse than no tracker, since the customer stops asking and starts
 * turning up.
 *
 * THE FOUNDATION LIVES IN PHASE 1 on purpose. Site prep and the pour happen
 * before the materials are bought (the shed is built during the concrete's cure
 * week), so they belong to the run-up, not to build day. They are listed inside
 * phase 1 with their own ticks, so a customer whose pad went in yesterday sees
 * that rather than a bare "pre-build".
 *
 * A PHASE IS NEVER DONE WHILE A LATER ONE IS. Stages are ticked off by hand in
 * a yard, so one WILL get missed; a shed cannot be installed without having
 * been built, so a later tick is taken as proof of the earlier ones. Smoothing
 * it here means the customer never sees "built ✓ / materials ✗".
 */

/* Which install stages make up each phase, in the order they happen. 'concrete'
   is the old single foundation row, from before the stages were split. */
const TRACK_PHASE_DEFS = [
  { key: 'prebuild',  label: 'Pre-build',            stages: ['prep', 'pour', 'gravel', 'concrete'] },
  { key: 'materials', label: 'Gathering materials',  stages: ['materials'] },
  { key: 'shop',      label: 'Building in the shop', stages: ['shop'] },
  { key: 'install',   label: 'Build day',            stages: ['shed'] }
];

/* Customer-facing stage names. The CRM's own labels are terser ("Materials"),
   and one of them — "Shed install" — is the name of a phase here. */
const TRACK_STAGE_LABELS = {
  prep: 'Site preparation',
  pour: 'Concrete poured',
  gravel: 'Gravel pad laid',
  concrete: 'Foundation',
  materials: 'Materials gathered',
  shop: 'Shed built in the shop',
  shed: 'Delivery and set-up'
};

export function trackStageLabel(item) {
  return TRACK_STAGE_LABELS[item] || String(item || '');
}

function doneOf(row) {
  return !!(row && row.done_at);
}

/* The earliest install_date in a set, as a plain YYYY-MM-DD, or null. Dates are
   compared as strings: they are already zero-padded ISO days, so that sorts
   correctly and avoids a timezone ever entering into it. */
function firstDate(rows) {
  const days = rows.map((r) => String(r.install_date || '').slice(0, 10))
                   .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
                   .sort();
  return days.length ? days[0] : null;
}

/* THE FOUR PHASES, each with its own stages.
 *
 * state is one of:
 *   'done'      everything in it has been ticked off (or something later has)
 *   'active'    the first phase that is not done — where the build is now
 *   'upcoming'  still ahead
 *
 * Phases the order has no stages for are still returned, so the page always
 * draws four steps and a customer with no foundation does not see a gap. */
export function trackPhases(installs) {
  const rows = Array.isArray(installs) ? installs : [];
  const byPhase = TRACK_PHASE_DEFS.map((def) => {
    const mine = rows.filter((r) => def.stages.indexOf(String(r.item || '')) !== -1);
    return {
      key: def.key,
      label: def.label,
      date: firstDate(mine),
      /* In the order they happen, which is the order the stage list is
         written in, not the order the rows came out of the database. */
      stages: def.stages
        .map((item) => mine.filter((r) => r.item === item))
        .filter((group) => group.length)
        .map((group) => ({
          item: group[0].item,
          label: trackStageLabel(group[0].item),
          date: firstDate(group),
          done: group.every(doneOf)
        })),
      /* Held separately from state: "every stage I have is ticked" is a fact
         about this phase, while state also depends on the phases after it. */
      selfDone: mine.length > 0 && mine.every(doneOf)
    };
  });

  /* A later tick proves the earlier phases, so sweep backwards. */
  let laterDone = false;
  for (let i = byPhase.length - 1; i >= 0; i--) {
    byPhase[i].done = byPhase[i].selfDone || laterDone;
    if (byPhase[i].done) laterDone = true;
  }

  let active = -1;
  for (let i = 0; i < byPhase.length; i++) {
    if (!byPhase[i].done) { active = i; break; }
  }

  return byPhase.map((p, i) => ({
    key: p.key,
    label: p.label,
    date: p.date,
    stages: p.stages,
    state: p.done ? 'done' : (i === active ? 'active' : 'upcoming')
  }));
}

/* WHETHER THE BUILD IS FINISHED — every phase done, and at least one stage
   actually ticked. Without the second half an order with no bookings at all
   would read as complete, because "all of nothing is done" is true. */
export function trackComplete(installs) {
  const rows = Array.isArray(installs) ? installs : [];
  if (!rows.some(doneOf)) return false;
  return trackPhases(rows).every((p) => p.state === 'done');
}

/* CAN THEY STILL CHANGE THE BUILD?
 *
 * One rule, not a per-phase one: changes are open until the first booked stage
 * of any kind, and shut the moment anything has been done. Tying it to the
 * phase would have told a customer whose concrete went in on Monday that they
 * were still free to change the size of the shed it was poured for.
 *
 * until is the day before the first booked stage — the last day a change is
 * free — or null when nothing is booked yet and there is no deadline to name. */
export function trackChangeWindow(installs) {
  const rows = Array.isArray(installs) ? installs : [];
  if (rows.some(doneOf)) {
    return { open: false, until: null, reason: 'started' };
  }
  const first = firstDate(rows);
  if (!first) return { open: true, until: null, reason: 'unscheduled' };
  const d = new Date(first + 'T00:00:00Z');
  if (isNaN(d.getTime())) return { open: true, until: null, reason: 'unscheduled' };
  d.setUTCDate(d.getUTCDate() - 1);
  const until = d.toISOString().slice(0, 10);
  /* A build starting today or tomorrow leaves no window to name; saying
     "changes until yesterday" would be worse than saying it has started. */
  return until < todayISO() ? { open: false, until: null, reason: 'started' }
                            : { open: true, until: until, reason: 'scheduled' };
}

/* Injectable so the tests are not a calendar away from failing. */
let trackNow = null;
export function setTrackNow(iso) { trackNow = iso || null; }
function todayISO() {
  return (trackNow || new Date().toISOString()).slice(0, 10);
}
