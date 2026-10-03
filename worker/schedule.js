/* PLANNING A BUILD FROM ONE DATE.
 *
 * A shed is not one day in a diary. Concrete needs a prep day and a pour day,
 * the shed is built in the shop before it goes anywhere, and the on-site build
 * takes a day or more. Typing five dates by hand is how two of them end up on
 * the same day, or the shop day ends up after the install.
 *
 * So one date is entered and the rest follow:
 *
 *   CONCRETE — the pour date is the anchor
 *     prep       the working day before the pour
 *     pour       the date entered
 *     materials  the working day before the shop day
 *     shop       the working day before the install
 *     install    one week after the pour, 2 days by default
 *
 *   GRAVEL — the pad date is the anchor, and the order is NOT the concrete
 *     order. Gravel has no cure to wait out, so it goes in last: the shed is
 *     already built in the shop by the time the pad is laid, and the crew
 *     starts setting the shed the same afternoon when they can.
 *     materials  the working day before the shop day
 *     shop       the working day before the pad
 *     gravel     the date entered — the working day before the install
 *     install    the next working day, 2 days by default
 *
 *     (Until 2026-10-03 this was pad, shop, install — the pad first, as if it
 *     were concrete. Plans booked before then keep their dates; only newly
 *     generated plans follow this order.)
 *
 *   NO FOUNDATION — the install date is the anchor, with a shop day before it.
 *
 * MATERIALS IS ALWAYS THE WORKING DAY BEFORE THE SHOP DAY, for every
 * foundation — one rule, no special cases. Nothing can be built in the shop
 * before the materials for it are in, so it hangs off the shop day rather than
 * off the anchor.
 *
 * WORKING DAYS ARE MONDAY TO FRIDAY. Saturday is a catch-up day, not a day to
 * start something on, so nothing is ever SCHEDULED onto a weekend — which
 * matters most for the shop day, since an install on a Monday would otherwise
 * be prepared for on the Sunday.
 *
 * Every date is computed in UTC on a plain calendar day. Local-time arithmetic
 * shifts the day for anyone east of UTC, and a schedule that is a day out is
 * one nobody notices until somebody drives somewhere.
 */

export const WORK_START = 1;   // Monday
export const WORK_END = 5;     // Friday

/* The vocabulary of a build. 'concrete' is the older single entry, kept so
   rows booked before any of this still read properly. */
export const STAGE_LABELS = {
  prep: 'Site prep',
  pour: 'Concrete pour',
  gravel: 'Gravel pad',
  materials: 'Materials',
  shop: 'Shop build',
  shed: 'Shed install',
  concrete: 'Concrete'
};

export const DEFAULT_INSTALL_DAYS = 2;
export const CURE_DAYS = 7;

/* Named apart from calendar.js's identical helper on purpose: the bundler
   inlines every module at TOP level, so two `function pad2` is a SyntaxError
   that stops the whole worker. Caught by bundle.test.mjs, not by reading. */
function pad2sched(n) { return (n < 10 ? '0' : '') + n; }

export function dayFromISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function isoFromDay(date) {
  return date.getUTCFullYear() + '-' + pad2sched(date.getUTCMonth() + 1) +
    '-' + pad2sched(date.getUTCDate());
}

export function isWorkday(date) {
  const d = date.getUTCDay();
  return d >= WORK_START && d <= WORK_END;
}

function shift(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/* The nearest working day, searching in one direction. Seven steps is always
   enough to find one and bounds the loop — an unbounded while() here would
   hang the worker on a bad calendar rather than return a wrong date. */
export function toWorkday(date, direction) {
  const step = direction < 0 ? -1 : 1;
  let d = date;
  for (let i = 0; i < 7; i++) {
    if (isWorkday(d)) return d;
    d = shift(d, step);
  }
  return date;
}

export function addWorkdays(date, n) {
  let d = toWorkday(date, n < 0 ? -1 : 1);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d = shift(d, step);
    if (isWorkday(d)) left--;
  }
  return d;
}

/* What kind of foundation a saved design describes. The designer stores the
   CONCRETE pad as foundation:'pad', which reads like any pad — hence the
   mapping rather than passing the raw value around. */
export function foundationKind(config) {
  const f = config && config.foundation;
  if (f === 'pad') return 'concrete';
  if (f === 'gravel') return 'gravel';
  return 'none';
}

function stage(item, date, days) {
  return { item: item, install_date: isoFromDay(date), days: days };
}

/* Returns the stages in the order they happen, or null for a date it cannot
   read — a plan built on a date nobody can parse is worse than no plan. */
export function planBuild(anchorISO, opts = {}) {
  const anchor = dayFromISO(anchorISO);
  if (!anchor) return null;

  const kind = opts.foundation || 'none';
  const raw = Number(opts.installDays);
  const installDays = isFinite(raw) && raw > 0 ? Math.max(1, Math.ceil(raw)) : DEFAULT_INSTALL_DAYS;

  /* The anchor itself is moved onto a working day. Picking a Saturday for a
     pour is a slip, and quietly honouring it would put every later date a day
     out as well. */
  const start = toWorkday(anchor, 1);

  if (kind === 'concrete') {
    const pour = start;
    const prep = addWorkdays(pour, -1);
    /* A week from the pour. Counted in calendar days, because concrete cures
       over the weekend too — then moved onto a working day, which only bites
       if the pour itself was dragged off a weekend. */
    const install = toWorkday(shift(pour, CURE_DAYS), 1);
    const shop = addWorkdays(install, -1);
    return [
      stage('prep', prep, 1),
      stage('pour', pour, 1),
      stage('materials', addWorkdays(shop, -1), 1),
      stage('shop', shop, 1),
      stage('shed', install, installDays)
    ];
  }

  if (kind === 'gravel') {
    /* The shed is finished in the shop BEFORE the gravel goes in, and the pad
       is laid the working day before the install — so a Friday pad means a
       Monday install, and a shop day before it on the Thursday. */
    const pad = start;
    const install = addWorkdays(pad, 1);
    const shop = addWorkdays(pad, -1);
    return [
      stage('materials', addWorkdays(shop, -1), 1),
      stage('shop', shop, 1),
      stage('gravel', pad, 1),
      stage('shed', install, installDays)
    ];
  }

  const install = start;
  const shop = addWorkdays(install, -1);
  return [
    stage('materials', addWorkdays(shop, -1), 1),
    stage('shop', shop, 1),
    stage('shed', install, installDays)
  ];
}

/* What the anchor date means for a given foundation, so the form can label
   its one field honestly instead of saying "date". */
export function anchorLabel(kind) {
  if (kind === 'concrete') return 'Pour date';
  if (kind === 'gravel') return 'Pad date';
  return 'Install date';
}
