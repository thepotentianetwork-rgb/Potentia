/* THE INVITE, AS THE CRM ACTUALLY RECEIVES IT.
 *
 * calendar.test.mjs checks the link on its own. This checks the seam: that
 * the worker attaches one to every scheduled install, built from the right
 * customer and the right order, with the customer on the guest list — which
 * is the part that makes it an invite rather than a note to self.
 *
 * Run: node --experimental-sqlite --test worker/installcalendar.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computePricing } from './pricing.js';
import worker from './index.js';

function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() {
        const s = db.prepare(sql);
        if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}

const { redline } = computePricing({ style: 'barn', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', siding: 'vertical' });

function setup(extraEnv = {}, customer = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
             address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
             adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
             created_at TEXT, effective_price REAL);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
  const c = { name: 'Hank Ellis', email: 'hank@roof.test', phone: '4355550000',
              address: '123 Main St', city: 'Eagle Mountain', state: 'UT', zip: '84005', ...customer };
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
              VALUES (1,?,?,?,?,?,?,?,?)`)
    .run(c.name, c.email, c.phone, c.address, c.city, c.state, c.zip, '2026-08-01');
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (7,1,?,'won','2026-09-01')`)
    .run(JSON.stringify({ redline, quotedPrice: 9000,
                          permalink: 'https://shedpro-utah.com/designer.html?d=a1b2c3d4',
                          /* Enough of a build to tell a real SPEC from the
                             one-line summary that used to be all the invite
                             carried — a foundation and a door are things the
                             summary never mentioned. */
                          config: { w: 10, l: 16, h: 9, style: 'barn', siding: 'vertical',
                                    foundation: 'pad', foundationFinish: 'coated',
                                    doors: [{ wall: 'front', w: 96, style: 'rollup', color: 'brown' }],
                                    windows: [{ wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' },
                                              { wall: 'left', w: 24, h: 36, type: 'Black Vinyl 24x36' }] } }));
  return { db, env: { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k', ...extraEnv } };
}

async function api(env, method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://local' + path, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function token(env) {
  return (await api(env, 'POST', '/admin/login', { password: 'pw' })).data.token;
}
async function schedule(env, t, body = {}) {
  const { submission_id = 7, ...rest } = body;
  return api(env, 'POST', `/admin/submissions/${submission_id}/installs`,
    { item: 'shed', install_date: '2026-10-15', days: 2, ...rest }, t);
}
function params(url) {
  const out = {};
  url.slice(url.indexOf('?') + 1).split('&').forEach((p) => {
    const i = p.indexOf('=');
    out[p.slice(0, i)] = p.slice(i + 1);
  });
  return out;
}
async function firstInstall(env, t) {
  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  return r.data.installs[0];
}

test('a scheduled install comes back with an invite link', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t);
  const i = await firstInstall(env, t);
  assert.ok(i.calendar_url, 'no link on the install');
  const p = params(i.calendar_url);
  assert.equal(p.action, 'TEMPLATE');
  assert.equal(p.dates, '20261015/20261017', 'two days, exclusive end');
  assert.equal(decodeURIComponent(p.text), 'Shed install — Hank Ellis');
});

/* Without this it is a note to self, not an invite. */
test('the customer is on the guest list', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t);
  const i = await firstInstall(env, t);
  assert.equal(decodeURIComponent(params(i.calendar_url).add), 'hank@roof.test');
});

test('extra crew addresses can be added without touching the code', async () => {
  const { env } = setup({ INSTALL_CALENDAR_GUESTS: 'crew@shedpro.test, boss@shedpro.test' });
  const t = await token(env);
  await schedule(env, t);
  const i = await firstInstall(env, t);
  assert.equal(decodeURIComponent(params(i.calendar_url).add),
    'hank@roof.test,crew@shedpro.test,boss@shedpro.test');
});

test('a customer with no email still gets a usable link', async () => {
  const { env } = setup({ INSTALL_CALENDAR_GUESTS: 'crew@shedpro.test' }, { email: null });
  const t = await token(env);
  await schedule(env, t);
  const i = await firstInstall(env, t);
  assert.ok(i.calendar_url, 'the crew still need to know');
  assert.equal(decodeURIComponent(params(i.calendar_url).add), 'crew@shedpro.test');
});

test('the address goes on it, so it opens in maps', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t);
  const i = await firstInstall(env, t);
  /* WITH THE ZIP. This is the address a crew types into a phone on the
     morning of an install, and it went out without one — the line read
     "123 Main St, Eagle Mountain, UT" and looked complete. A space before the
     ZIP, not a comma: "UT, 84005" is what a hand-rolled join produces and it
     is wrong on every delivery label. */
  assert.equal(decodeURIComponent(params(i.calendar_url).location),
    '123 Main St, Eagle Mountain, UT 84005');
});

test('the description carries the build, the phone and the note', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t, { note: 'gate code 1234' });
  const i = await firstInstall(env, t);
  const d = decodeURIComponent(params(i.calendar_url).details);
  assert.match(d, /10x16 ft/);
  assert.match(d, /barn/);
  assert.match(d, /Order #7/);
  assert.match(d, /Phone: 4355550000/);
  assert.match(d, /Note: gate code 1234/);

  /* THE SPEC REACHES THE INVITE. Every check above passes on the one line the
     invite used to carry — "10x16 ft · barn · vertical" has the size and the
     style in it. These are the things only the full spec says, and removing
     the wiring that puts it there left all of the above green. */
  assert.match(d, /9ft walls/, 'the wall height is missing — this is the old one-line summary');
  assert.match(d, /Foundation: Concrete pad \(coated\)/);
  assert.match(d, /8' Roll-Up Garage Door \u00b7 Brown \(front\)/);
  assert.match(d, /2 \u00d7 Black Vinyl Window 24x36 \(left\)/);
  // The 3D build, last, as a short link anyone on the invite can open.
  assert.match(d, /\n3D build: https:\/\/www\.shedpro-utah\.com\/designer\.html\?d=a1b2c3d4$/);
  // And no money on it — the customer is a guest on this event.
  assert.ok(!/\$|9000|[Qq]uoted/.test(d), `a price reached the invite: ${d}`);
});

test('concrete and shed are named apart', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t, { item: 'concrete', install_date: '2026-10-10', days: 1 });
  await schedule(env, t, { item: 'shed' });
  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  const titles = r.data.installs.map((i) => decodeURIComponent(params(i.calendar_url).text));
  assert.ok(titles.includes('Concrete pour — Hank Ellis'), titles.join(' | '));
  assert.ok(titles.includes('Shed install — Hank Ellis'), titles.join(' | '));
});

/* Two customers, two jobs. An invite built from the wrong order sends someone
   else's address and phone number to a customer. */
test('the invite is built from that install’s own order', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (8,1,?,'won','2026-09-20')`)
    .run(JSON.stringify({ redline, config: { w: 12, l: 20, style: 'gable' } }));
  await schedule(env, t, { submission_id: 7 });
  await schedule(env, t, { submission_id: 8, install_date: '2026-11-02', days: 1 });

  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  const bySub = {};
  r.data.installs.forEach((i) => { bySub[i.submission_id] = params(i.calendar_url); });
  assert.match(decodeURIComponent(bySub[7].details), /10x16 ft · barn/);
  assert.match(decodeURIComponent(bySub[8].details), /12x20 ft · gable/);
  assert.equal(bySub[8].dates, '20261102/20261103');
});

/* A date the link builder cannot read must produce no link, so the CRM shows
   no button — rather than one that opens an empty calendar entry and looks
   like it worked. */
test('an unreadable install date yields no link at all', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await schedule(env, t);
  db.prepare("UPDATE installs SET install_date = 'sometime next week'").run();
  const i = await firstInstall(env, t);
  assert.equal(i.calendar_url, null);
});

/* ---- the schedule page's data ------------------------------------------ */

test('the schedule lists installs across every customer, by date', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,zip,created_at)
              VALUES (2,'Dana Reed','dana@reed.test','4355551111','9 Oak Ave','Lehi','UT','84043','2026-08-02')`).run();
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (9,2,?,'won','2026-09-02')`)
    .run(JSON.stringify({ redline, config: { w: 12, l: 20, style: 'gable' } }));

  await schedule(env, t, { install_date: '2026-10-20', days: 1 });
  await api(env, 'POST', '/admin/submissions/9/installs',
    { item: 'concrete', install_date: '2026-10-05', days: 1 }, t);

  const r = await api(env, 'GET', '/admin/schedule', null, t);
  assert.equal(r.status, 200);
  const rows = r.data.installs;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((i) => i.install_date), ['2026-10-05', '2026-10-20'],
    'soonest first — this is a schedule, not a log');
  assert.deepEqual(rows.map((i) => i.customer_name), ['Dana Reed', 'Hank Ellis']);
  assert.equal(rows[0].item, 'concrete');
  /* The schedule's address needs the ZIP for the same reason the calendar
     invite does — it is what a crew navigates to. Its query did not even
     SELECT the column, so no amount of formatting downstream could have put
     one on the line. */
  assert.equal(rows[0].address, '9 Oak Ave, Lehi, UT 84043');
  assert.equal(rows[1].address, '123 Main St, Eagle Mountain, UT 84005');
  assert.equal(rows[1].summary, '10x16 ft · barn · vertical');
  assert.ok(rows[0].calendar_url && rows[1].calendar_url, 'each row can be invited from here too');
  /* And those invites carry the SPEC, not just a date and a name. The schedule
     builds its own invite separately from the customer page's, so wiring one
     says nothing about the other — removing it here left every check above
     green. Row 1 is Hank, whose fixture has the full build on it. */
  const sd = decodeURIComponent(params(rows[1].calendar_url).details);
  assert.match(sd, /9ft walls/, 'the schedule invite is still the old one-line summary');
  assert.match(sd, /Foundation: Concrete pad/);
  assert.match(sd, /3D build: https:/);
});

test('it can be bounded to a date range, inclusive at both ends', async () => {
  const { env } = setup();
  const t = await token(env);
  for (const d of ['2026-10-01', '2026-10-15', '2026-10-31', '2026-11-05']) {
    await schedule(env, t, { install_date: d, days: 1 });
  }
  const within = await api(env, 'GET', '/admin/schedule?from=2026-10-15&to=2026-10-31', null, t);
  assert.deepEqual(within.data.installs.map((i) => i.install_date),
    ['2026-10-15', '2026-10-31'], 'both ends are included');

  const after = await api(env, 'GET', '/admin/schedule?from=2026-11-01', null, t);
  assert.deepEqual(after.data.installs.map((i) => i.install_date), ['2026-11-05']);

  const before = await api(env, 'GET', '/admin/schedule?to=2026-10-01', null, t);
  assert.deepEqual(before.data.installs.map((i) => i.install_date), ['2026-10-01']);
});

/* A range the page did not send, or a hand-typed one, must not quietly become
   a filter on something else — or open the door to anything being pasted into
   the query. */
test('a range it cannot read is ignored, not obeyed', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t);
  for (const q of ['?from=lastweek', '?to=2026/10/15', "?from=' OR 1=1 --", '?from=&to=']) {
    const r = await api(env, 'GET', '/admin/schedule' + q, null, t);
    assert.equal(r.status, 200, q);
    assert.equal(r.data.installs.length, 1, q + ' changed what came back');
  }
});

test('the schedule needs an admin token', async () => {
  const { env } = setup();
  assert.equal((await api(env, 'GET', '/admin/schedule')).status, 401);
});

test('it carries the phone and the price, so the page needs no second call', async () => {
  const { env } = setup();
  const t = await token(env);
  await schedule(env, t, { note: 'gate code 1234' });
  const r = await api(env, 'GET', '/admin/schedule', null, t);
  const i = r.data.installs[0];
  assert.equal(i.customer_phone, '4355550000');
  assert.equal(i.note, 'gate code 1234');
  assert.equal(i.order_status, 'won');
  assert.equal(i.customer_id, 1);
  assert.equal(i.submission_id, 7);
});

/* ---- an order that stops being won -------------------------------------- */

/* THE ONE THAT SENT SOMEONE TO A JOB THAT WAS NOT HAPPENING.
 *
 * Install rows outlive the order they belong to. Mark a won order lost, or
 * replace it with a newer design, and the booking stays in the table — so the
 * schedule kept listing it, and the customer showed up twice. */
test('the schedule drops installs whose order is no longer won', async () => {
  const { db, env } = setup();
  const t = await token(env);
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (9,1,?,'won','2026-09-02')`)
    .run(JSON.stringify({ redline, config: { w: 12, l: 20, style: 'gable' } }));
  await schedule(env, t, { submission_id: 7, install_date: '2026-10-15' });
  await schedule(env, t, { submission_id: 9, install_date: '2026-10-20' });

  assert.equal((await api(env, 'GET', '/admin/schedule', null, t)).data.installs.length, 2);

  for (const gone of ['superseded', 'lost', 'quoted', 'new', 'contacted']) {
    db.prepare('UPDATE submissions SET status = ? WHERE id = 9').run(gone);
    const r = await api(env, 'GET', '/admin/schedule', null, t);
    assert.deepEqual(r.data.installs.map((i) => i.submission_id), [7],
      'order 9 is ' + gone + ' — it must not be on the schedule');
  }
});

/* Filtered, not deleted. Un-winning an order by mistake must not destroy the
   date that was booked. */
test('re-winning the order puts the same date back', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await schedule(env, t, { install_date: '2026-10-15', days: 2, note: 'gate code 1234' });

  db.prepare("UPDATE submissions SET status = 'lost' WHERE id = 7").run();
  assert.equal((await api(env, 'GET', '/admin/schedule', null, t)).data.installs.length, 0);

  db.prepare("UPDATE submissions SET status = 'won' WHERE id = 7").run();
  const back = (await api(env, 'GET', '/admin/schedule', null, t)).data.installs;
  assert.equal(back.length, 1);
  assert.equal(back[0].install_date, '2026-10-15');
  assert.equal(back[0].days, 2);
  assert.equal(back[0].note, 'gate code 1234');
});

/* The customer page still has to show it, or there is no way to remove it —
   which is how one got stranded in the first place. */
test('a stranded install is still returned on the customer', async () => {
  const { db, env } = setup();
  const t = await token(env);
  await schedule(env, t, { install_date: '2026-10-15' });
  db.prepare("UPDATE submissions SET status = 'superseded' WHERE id = 7").run();

  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  assert.equal(r.data.installs.length, 1,
    'the customer page must still see it, or it cannot be deleted');
  assert.equal((await api(env, 'GET', '/admin/schedule', null, t)).data.installs.length, 0,
    'but the schedule must not');
});

/* ---- planning a build from one date ------------------------------------- */

async function planned(env, t, body, subId = 7) {
  return api(env, 'POST', `/admin/submissions/${subId}/plan`, body, t);
}
function withFoundation(foundation) {
  const s = setup();
  s.db.prepare('UPDATE submissions SET details = ? WHERE id = 7')
    .run(JSON.stringify({ redline, config: { w: 10, l: 16, style: 'barn', foundation } }));
  return s;
}

test('a concrete order plans prep, pour, shop and install from the pour date', async () => {
  const { env } = withFoundation('pad');
  const t = await token(env);
  const r = await planned(env, t, { anchor_date: '2026-10-07' });
  assert.equal(r.status, 200);
  assert.equal(r.data.preview, true, 'nothing is written without confirm');
  assert.equal(r.data.foundation, 'concrete');
  assert.equal(r.data.anchor_label, 'Pour date');
  assert.deepEqual(r.data.stages.map((s) => [s.item, s.install_date, s.days]), [
    ['prep', '2026-10-06', 1],
    ['pour', '2026-10-07', 1],
    ['shop', '2026-10-13', 1],
    ['shed', '2026-10-14', 2],
  ]);
  assert.deepEqual(r.data.stages.map((s) => s.label),
    ['Site prep', 'Concrete pour', 'Shop build', 'Shed install']);
});

test('a gravel order plans pad, shop and install with no cure week', async () => {
  const { env } = withFoundation('gravel');
  const t = await token(env);
  const r = await planned(env, t, { anchor_date: '2026-10-05' });
  assert.equal(r.data.foundation, 'gravel');
  assert.equal(r.data.anchor_label, 'Pad date');
  assert.deepEqual(r.data.stages.map((s) => [s.item, s.install_date]), [
    ['gravel', '2026-10-05'], ['shop', '2026-10-06'], ['shed', '2026-10-07'],
  ]);
});

test('an order with no foundation work plans a shop day and an install', async () => {
  const { env } = withFoundation('none');
  const t = await token(env);
  const r = await planned(env, t, { anchor_date: '2026-10-06', install_days: 3 });
  assert.equal(r.data.anchor_label, 'Install date');
  assert.deepEqual(r.data.stages.map((s) => [s.item, s.install_date, s.days]), [
    ['shop', '2026-10-05', 1], ['shed', '2026-10-06', 3],
  ]);
});

test('a preview writes nothing at all', async () => {
  const { db, env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM installs').get().n, 0);
});

test('confirming books every stage, in order', async () => {
  const { db, env } = withFoundation('pad');
  const t = await token(env);
  const r = await planned(env, t, { anchor_date: '2026-10-07', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.booked, 4);
  const rows = db.prepare('SELECT item, install_date, days FROM installs ORDER BY install_date').all();
  assert.deepEqual(rows.map((x) => x.item), ['prep', 'pour', 'shop', 'shed']);
  assert.equal(rows[3].days, 2);
});

/* The dates are recomputed on confirm. A plan the browser worked out is not
   one the worker should be inserting — and the browser is where a stale page,
   a wrong clock or a hand-edited request comes from. */
test('the dates come from the worker, never from the request', async () => {
  const { db, env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true,
    stages: [{ item: 'shed', install_date: '1999-01-01', days: 99 }] });
  const rows = db.prepare('SELECT install_date, days FROM installs').all();
  assert.ok(!rows.some((x) => x.install_date === '1999-01-01'), 'it took dates from the caller');
  assert.ok(!rows.some((x) => x.days === 99));
});

/* Replacing throws away what was booked, so it is never the default. */
test('it refuses to overwrite existing bookings unless told to', async () => {
  const { db, env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });

  const again = await planned(env, t, { anchor_date: '2026-10-21', confirm: true });
  assert.equal(again.status, 409);
  assert.equal(again.data.replaces, 4);
  assert.match(again.data.error, /already has 4 booking/);
  assert.equal(db.prepare("SELECT install_date FROM installs WHERE item='pour'").get().install_date,
    '2026-10-07', 'the original dates survived the refusal');

  const replaced = await planned(env, t, { anchor_date: '2026-10-21', confirm: true, replace: true });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.replaced, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM installs').get().n, 4, 'replaced, not added to');
  assert.equal(db.prepare("SELECT install_date FROM installs WHERE item='pour'").get().install_date,
    '2026-10-21');
});

test('a preview says how many bookings it would replace', async () => {
  const { env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });
  const r = await planned(env, t, { anchor_date: '2026-10-21' });
  assert.equal(r.data.replaces, 4, 'so the CRM can say what is about to be lost');
});

test('a date it cannot read is refused, with the right field named', async () => {
  const { db, env } = withFoundation('gravel');
  const t = await token(env);
  for (const bad of ['', 'next week', '07/10/2026', '2026-02-30']) {
    const r = await planned(env, t, { anchor_date: bad, confirm: true });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.anchor_label, 'Pad date');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM installs').get().n, 0);
});

test('planning needs an admin token, and a real order', async () => {
  const { env } = withFoundation('pad');
  const t = await token(env);
  assert.equal((await api(env, 'POST', '/admin/submissions/7/plan', { anchor_date: '2026-10-07' })).status, 401);
  assert.equal((await planned(env, t, { anchor_date: '2026-10-07' }, 9999)).status, 404);
});

/* A planned build has to reach the schedule, which only lists won orders. */
test('a planned build shows up on the schedule', async () => {
  const { db, env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });
  db.prepare("UPDATE submissions SET status = 'won' WHERE id = 7").run();
  const r = await api(env, 'GET', '/admin/schedule', null, t);
  assert.deepEqual(r.data.installs.map((i) => i.item), ['prep', 'pour', 'shop', 'shed']);
  assert.ok(r.data.installs.every((i) => i.calendar_url), 'each stage can be invited from');
});

/* ---- who gets invited to what ------------------------------------------- */

/* A shop day is a day in your own shop. An invite for it on the customer's
   calendar is an appointment for a day when nothing happens at their house —
   they either turn up, or they stop trusting the invites. */
test('the customer is invited to site days, not to shop days', async () => {
  const { env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });

  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  const guests = {};
  r.data.installs.forEach((i) => {
    guests[i.item] = decodeURIComponent(params(i.calendar_url).add || '');
  });

  assert.equal(guests.prep, 'hank@roof.test', 'prep is at their place');
  assert.equal(guests.pour, 'hank@roof.test', 'so is the pour');
  assert.equal(guests.shed, 'hank@roof.test', 'and the install');
  assert.equal(guests.shop, '', 'but the shop day is not');
});

test('the crew are on every stage, including the shop day', async () => {
  const { env } = withFoundation('pad');
  env.INSTALL_CALENDAR_GUESTS = 'crew@shedpro.test';
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });

  const r = await api(env, 'GET', '/admin/schedule', null, t);
  const sub = await api(env, 'GET', '/admin/customers/1', null, t);
  assert.ok(sub.data.installs.length, 'fixture produced no installs');
  sub.data.installs.forEach((i) => {
    const add = decodeURIComponent(params(i.calendar_url).add || '');
    assert.ok(add.indexOf('crew@shedpro.test') !== -1,
      i.item + ' left the crew off: "' + add + '"');
  });
  /* And the shop day carries the crew and ONLY the crew. */
  const shop = sub.data.installs.find((i) => i.item === 'shop');
  assert.equal(decodeURIComponent(params(shop.calendar_url).add), 'crew@shedpro.test');
  assert.ok(r.data.installs.length >= 0);
});

test('each stage is named for what it is, on its own invite', async () => {
  const { env } = withFoundation('pad');
  const t = await token(env);
  await planned(env, t, { anchor_date: '2026-10-07', confirm: true });
  const r = await api(env, 'GET', '/admin/customers/1', null, t);
  const titles = {};
  r.data.installs.forEach((i) => {
    titles[i.item] = decodeURIComponent(params(i.calendar_url).text);
  });
  assert.equal(titles.prep, 'Site prep — Hank Ellis');
  assert.equal(titles.pour, 'Concrete pour — Hank Ellis');
  assert.equal(titles.shop, 'Shop build — Hank Ellis');
  assert.equal(titles.shed, 'Shed install — Hank Ellis');
});
