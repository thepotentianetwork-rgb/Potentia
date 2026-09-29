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
              address: '123 Main St', city: 'Eagle Mountain', state: 'UT', ...customer };
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,created_at)
              VALUES (1,?,?,?,?,?,?,?)`)
    .run(c.name, c.email, c.phone, c.address, c.city, c.state, '2026-08-01');
  db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
              VALUES (7,1,?,'won','2026-09-01')`)
    .run(JSON.stringify({ redline, quotedPrice: 9000,
                          config: { w: 10, l: 16, style: 'barn', siding: 'vertical' } }));
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
  assert.equal(decodeURIComponent(params(i.calendar_url).location),
    '123 Main St, Eagle Mountain, UT');
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
  db.prepare(`INSERT INTO customers (id,name,email,phone,address,city,state,created_at)
              VALUES (2,'Dana Reed','dana@reed.test','4355551111','9 Oak Ave','Lehi','UT','2026-08-02')`).run();
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
  assert.equal(rows[0].address, '9 Oak Ave, Lehi, UT');
  assert.equal(rows[1].summary, '10x16 ft · barn · vertical');
  assert.ok(rows[0].calendar_url && rows[1].calendar_url, 'each row can be invited from here too');
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
