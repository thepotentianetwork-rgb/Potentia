/* GET /api/briefing — auth, params, and that each section picks the right rows
 * out of a real SQLite standing in for D1.
 *
 * Run: node --experimental-sqlite --test worker/briefing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
import { buildBriefing, moneyWords, numberWords, parseBriefingParams as parseParams, briefingWindow, denverMidnightUtc, designSummary, QUOTES, quoteForDay, filterImportantEmails, buildDraft } from './briefing.js';
import { makeThreadFetcher, scopesAreReadOnly, gmailConfigured } from './gmail.js';

function makeD1(db) {
  const writes = [];
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    if (!isSelect) writes.push(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const s = db.prepare(sql); return isSelect ? { results: s.all(...args) } : (s.run(...args), {}); }
    });
  }
  return { writes, prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; } };
}

// 2026-10-14 13:00 Denver (MDT, UTC-6) = 19:00Z
const NOW = Date.parse('2026-10-14T19:00:00Z');
const cfg = (o) => JSON.stringify({ city: 'Provo', heardAbout: 'google', quotedPrice: 9000.4, config: { w: 10, l: 12, style: 'barn', ...o } });

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, city TEXT, created_at TEXT NOT NULL, updated_at TEXT, temp_override TEXT, follow_up_at TEXT);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, name TEXT, email TEXT, details TEXT, status TEXT, created_at TEXT, customer_id INTEGER, effective_price REAL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE calls (id INTEGER PRIMARY KEY, customer_id INTEGER, called_at TEXT);
    INSERT INTO notes (customer_id,text,created_at) VALUES (1,'Wants it before winter','2026-10-14T16:00:00Z');
    CREATE TABLE installs (id INTEGER PRIMARY KEY, submission_id INTEGER, item TEXT, install_date TEXT, days REAL, done_at TEXT, created_at TEXT);
    INSERT INTO customers (id,name,city,created_at,temp_override,follow_up_at) VALUES
      (1,'Ann New',NULL,'2026-10-14T15:00:00Z',NULL,NULL),
      (2,'Bob Lastnight','Orem','2026-10-14T05:00:00Z',NULL,NULL),
      (3,'Cal Old','Lehi','2026-09-01T00:00:00Z','dormant','2026-10-10'),
      (4,'Dee Later',NULL,'2026-09-01T00:00:00Z','dormant','2027-01-01'),
      (5,'Eve Today',NULL,'2026-09-01T00:00:00Z','warm','2026-10-14');
    INSERT INTO submissions (id,name,details,status,created_at,customer_id,effective_price) VALUES
      (10,'Ann New','${cfg({ w: 12, l: 16 })}','new','2026-10-14T15:01:00Z',1,NULL),
      (11,'x','${cfg()}','quoted','2026-10-01T00:00:00Z',3,18100),
      (12,'x','${cfg()}','quoted','2026-10-10T00:00:00Z',5,NULL),
      (13,'x','${cfg()}','superseded','2026-10-14T16:00:00Z',3,NULL),
      (14,'x','${cfg()}','won','2026-09-01T00:00:00Z',4,5000),
      (15,'x','${cfg()}','won','2026-09-02T00:00:00Z',5,5000),
      (16,'x','${cfg()}','lost','2026-09-02T00:00:00Z',2,5000),
      (17,'x','${cfg()}','quoted','2026-09-20T00:00:00Z',3,25000);
    INSERT INTO installs (id,submission_id,item,install_date,days,done_at) VALUES
      (1,14,'shed','2026-10-20',1,NULL),
      (2,14,'concrete','2026-10-13',1,NULL),
      (3,14,'pour','2026-10-28',1,NULL),
      (4,14,'prep','2026-10-15',1,'2026-10-15'),
      (5,16,'shed','2026-10-16',1,NULL);
  `);
  return db;
}
const env = (o) => ({ DB: makeD1(setup()), BRIEFING_API_KEY: 'k3y', ...o });
const req = (q = '', h = { Authorization: 'Bearer k3y' }, method = 'GET') =>
  new Request('https://w.example/api/briefing' + q, { method, headers: h });

test('auth: 503 without secret, 401 bad/missing key, 405 non-GET, no CORS', async () => {
  assert.equal((await worker.fetch(req(), env({ BRIEFING_API_KEY: undefined }))).status, 503);
  assert.equal((await worker.fetch(req('', { Authorization: 'Bearer nope' }), env())).status, 401);
  assert.equal((await worker.fetch(req('', {}), env())).status, 401);
  assert.equal((await worker.fetch(req('', { Authorization: 'Bearer k3y' }, 'POST'), env())).status, 405);
  const opt = await worker.fetch(req('', { Origin: 'https://evil.example' }, 'OPTIONS'), env());
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), null);
  const ok = await worker.fetch(req('', { Authorization: 'Bearer k3y', Origin: 'https://evil.example' }), env());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), null);
});

test('params', () => {
  const p = (q) => parseParams(new URLSearchParams(q));
  assert.equal(p('').days, 1);
  assert.equal(p('days=99').days, 30);
  assert.equal(p('days=-3').days, 1);
  assert.equal(p('days=abc').days, 1);
  assert.deepEqual(p('sections=follow_ups,bogus,new_leads').sections, ['new_leads', 'follow_ups']);
});

test('window is Denver midnight', () => {
  assert.equal(denverMidnightUtc('2026-10-14'), '2026-10-14T06:00:00.000Z');
  assert.equal(denverMidnightUtc('2026-12-01'), '2026-12-01T07:00:00.000Z');
  assert.equal(briefingWindow(NOW, 7).from, '2026-10-08T06:00:00.000Z');
});

test('money and numbers in words', () => {
  assert.equal(moneyWords(18100), 'eighteen thousand one hundred dollars');
  assert.equal(moneyWords(11180.9), 'eleven thousand one hundred eighty-one dollars');
  assert.equal(numberWords(1000000), 'one million');
  assert.equal(moneyWords(1), 'one dollar');
});

test('designSummary', () => {
  assert.equal(designSummary(cfg({ w: 12, l: 16, style: 'leanto' })), '12x16 lean-to');
  assert.equal(designSummary('not json'), null);
});

test('sections pick the right rows (days=1) and the endpoint is read-only', async () => {
  const e = env();
  const realNow = Date.now; Date.now = () => NOW;
  let body;
  try { body = await (await worker.fetch(req(), e)).json(); } finally { Date.now = realNow; }
  const d = body.display;
  assert.equal(body.timezone, 'America/Denver');
  assert.deepEqual(d.new_leads.map((x) => x.name), ['Ann New']);  // Bob was 23:00 Denver yesterday
  assert.equal(d.new_leads[0].source, 'google');
  assert.equal(d.new_leads[0].city, 'Provo');                     // falls back to submission city
  assert.deepEqual(d.new_designs.map((x) => x.submission_id), [10]); // superseded excluded
  assert.equal(d.new_designs[0].summary, '12x16 barn');
  // customer 3 has quotes 17 (older) and 11 (latest): only 11 counts
  assert.deepEqual(d.pending_proposals.map((x) => [x.quote_number, x.total, x.days_since_sent]), [[11, 18100, 13], [12, 9000.4, 4]]);
  assert.deepEqual(d.upcoming_installs.map((x) => x.install_id), [1, 3]); // not past, done, lost, or >14d
  assert.deepEqual(d.follow_ups.map((x) => [x.name, x.dormant]), [['Cal Old', true], ['Eve Today', false]]);
  assert.equal(d.counts.install_date_coverage.won_orders, 2);
  assert.equal(d.counts.install_date_coverage.won_orders_with_dates, 1);
  assert.doesNotMatch(body.spoken, /proposal|dollars/);
  assert.equal(body.requires_approval, true);
  assert.equal(body.recommended_action.kind, 'call_lead');
  assert.equal(body.recommended_action.customer_id, 1);
  assert.ok(body.spoken.endsWith('Start with this: ' + body.recommended_action.text + '.'));
  assert.equal(body.intents.tell_me_about_that_new_lead.endpoint, '/api/briefing/lead/1');
  assert.equal(body.display.emails_status, 'disabled');
  assert.ok(body.spoken.split(/\s+/).length <= 150, body.spoken);
  assert.ok(body.spoken.indexOf('Ann New') < body.spoken.indexOf('Follow ups'));
  assert.doesNotMatch(body.spoken, /[$#|*{}\[\]]/);
  assert.deepEqual(e.DB.writes, []);
});

test('days=7 widens new items; sections filter', async () => {
  const realNow = Date.now; Date.now = () => NOW;
  let body;
  try { body = await (await worker.fetch(req('?days=7&sections=new_leads'), env())).json(); } finally { Date.now = realNow; }
  assert.deepEqual(body.display.new_leads.map((x) => x.name), ['Ann New', 'Bob Lastnight']);
  assert.deepEqual(Object.keys(body.display), ['new_leads', 'counts']);
  assert.doesNotMatch(body.spoken, /Follow ups/);
});

test('empty database still answers', () => {
  const b = buildBriefing({}, { nowMs: NOW });
  assert.equal(b.display.counts.new_leads, 0);
  assert.match(b.spoken, /No new leads/);
  assert.equal(b.recommended_action.kind, 'none');
});

test('quotes rotate daily, deterministically, all attributed', () => {
  assert.ok(QUOTES.length >= 10);
  for (const q of QUOTES) assert.ok(q.text && q.author && q.source);
  assert.deepEqual(quoteForDay('2026-10-14'), quoteForDay('2026-10-14'));
  assert.notDeepEqual(quoteForDay('2026-10-14'), quoteForDay('2026-10-15'));
  const seen = new Set(); for (let i = 0; i < QUOTES.length; i++) seen.add(quoteForDay(`2026-11-${String(i + 1).padStart(2, '0')}`).text);
  assert.equal(seen.size, QUOTES.length);
});

const T = (id, msgs) => ({ id, messages: msgs.map((m, i) => ({ id: id + i, subject: 'Re: Quote', snippet: 'hi &#39;there', ...m })) });
const SELF = ['info@shedpro-utah.com'];
test('email filter: unread inbound, not self/automated/bulk, important or customer', () => {
  const threads = [
    T('a', [{ from: 'Lee <lee@x.com>', date: '2026-10-14T10:00:00Z', labelIds: ['INBOX', 'UNREAD'] }]),             // customer, not IMPORTANT
    T('b', [{ from: 'cust@y.com', date: '2026-10-13T10:00:00Z', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'] },
            { from: 'info@shedpro-utah.com', date: '2026-10-13T11:00:00Z', labelIds: ['SENT'] }]),                    // we replied last
    T('c', [{ from: 'no-reply@accounts.google.com', date: '2026-10-14T10:00:00Z', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'] }]),
    T('d', [{ from: 'deals@shop.com', date: '2026-10-14T10:00:00Z', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PROMOTIONS'] }]),
    T('e', [{ from: 'Stranger <s@z.com>', date: '2026-10-14T09:00:00Z', labelIds: ['INBOX', 'UNREAD'] }]),            // not important, not customer
    T('f', [{ from: 'Pat <pat@w.com>', date: '2026-10-14T11:00:00Z', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'] }]),
    T('g', [{ from: 'read@w.com', date: '2026-10-14T11:00:00Z', labelIds: ['INBOX', 'IMPORTANT'] }])                   // already read
  ];
  const out = filterImportantEmails(threads, { selfAddresses: SELF, customers: [{ id: 9, name: 'Lee O', email: 'LEE@x.com' }] });
  assert.deepEqual(out.map((e) => e.thread_id), ['a', 'f']);
  assert.equal(out[0].customer_id, 9);
  assert.equal(out[0].snippet, "hi 'there");
  assert.equal(out[1].from_name, 'Pat');
});

test('gmail: off without flag+secrets; refuses non-readonly tokens; reads metadata only', async () => {
  assert.equal(gmailConfigured({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' }), false);
  assert.equal(makeThreadFetcher({}), null);
  assert.equal(scopesAreReadOnly('https://www.googleapis.com/auth/gmail.readonly'), true);
  assert.equal(scopesAreReadOnly('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'), false);
  assert.equal(scopesAreReadOnly('https://mail.google.com/'), false);
  const env = { BRIEFING_EMAIL_ENABLED: 'true', GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' };
  const calls = [];
  const mk = (scope) => async (url, init = {}) => {
    calls.push([init.method || 'GET', url]);
    const j = (o) => ({ ok: true, json: async () => o });
    if (url.includes('oauth2')) return j({ access_token: 't', scope });
    if (url.includes('/threads?')) return j({ threads: [{ id: 'x1' }] });
    return j({ id: 'x1', messages: [{ id: 'm1', internalDate: String(Date.parse('2026-10-14T10:00:00Z')), labelIds: ['INBOX', 'UNREAD'], snippet: 's',
      payload: { headers: [{ name: 'From', value: 'A <a@b.com>' }, { name: 'Subject', value: 'Hi' }] } }] });
  };
  await assert.rejects(makeThreadFetcher(env, mk('https://www.googleapis.com/auth/gmail.modify'))());
  calls.length = 0;
  const threads = await makeThreadFetcher(env, mk('https://www.googleapis.com/auth/gmail.readonly'))();
  assert.equal(threads[0].messages[0].from, 'A <a@b.com>');
  assert.ok(calls.slice(1).every(([m, u]) => m === 'GET' && u.startsWith('https://gmail.googleapis.com/')));
  assert.ok(calls.some(([, u]) => u.includes('format=metadata')));
});

async function call(path, e = env()) {
  const realNow = Date.now; Date.now = () => NOW;
  try { const r = await worker.fetch(new Request('https://w.example' + path, { headers: { Authorization: 'Bearer k3y' } }), e); return [r.status, await r.json()]; }
  finally { Date.now = realNow; }
}
test('intent endpoints are read-only and flagged requires_approval', async () => {
  const e = env();
  let [st, b] = await call('/api/briefing/lead/1', e);
  assert.equal(st, 200); assert.equal(b.requires_approval, true); assert.equal(b.side_effects, 'none');
  assert.equal(b.lead.name, 'Ann New'); assert.equal(b.designs[0].summary, '12x16 barn'); assert.equal(b.recent_notes.length, 1);
  assert.match(b.spoken, /Nobody has called them yet/);
  [st] = await call('/api/briefing/lead/999', e); assert.equal(st, 404);
  [st, b] = await call('/api/briefing/follow-ups', e);
  assert.deepEqual(b.follow_ups.map((x) => x.name), ['Cal Old', 'Eve Today']); assert.equal(b.requires_approval, true);
  [st, b] = await call('/api/briefing/emails', e);
  assert.equal(b.status, 'disabled'); assert.deepEqual(b.emails, []);
  [st, b] = await call('/api/briefing/draft?kind=lead&id=1', e);
  assert.equal(st, 200); assert.equal(b.sent, false); assert.equal(b.saved, false); assert.match(b.body, /Hi Ann/);
  [st] = await call('/api/briefing/draft?kind=email&id=zz', e); assert.equal(st, 503);
  [st] = await call('/api/briefing/draft?kind=nope&id=1', e); assert.equal(st, 400);
  [st] = await call('/api/briefing/lead/1', env({ BRIEFING_API_KEY: 'other' })); assert.equal(st, 401);
  assert.deepEqual(e.DB.writes, []);
});

test('email draft quotes the subject and never claims to send', () => {
  const d = buildDraft('email', { from: 'a@b.com', from_name: 'Lee O', thread_id: 't', subject: 'Quote', snippet: 's' });
  assert.equal(d.subject, 'Re: Quote'); assert.equal(d.requires_approval, true); assert.equal(d.sent, false);
});

test('briefing with emails: priority order, spoken stays short', () => {
  const emails = { enabled: true, items: [{ thread_id: 't1', from: 'lee@x.com', from_name: 'Lee O', customer_id: 3, subject: 'Re: Your quote', received_at: '2026-10-12T10:00:00Z', snippet: 'x' }] };
  const rows = { customers: [], followups: [{ id: 3, name: 'Cal Old', follow_up_at: '2026-10-01' }],
    installs: [{ id: 1, submission_id: 1, item: 'shed', install_date: '2026-10-14', customer_name: 'Zed' }, { id: 2, submission_id: 1, item: 'pour', install_date: '2026-10-10', customer_name: 'Old' }] };
  const b = buildBriefing(rows, { nowMs: NOW, emails });
  const s = b.spoken;
  assert.equal(b.recommended_action.kind, 'reply_email');
  assert.ok(s.indexOf('No new leads') < s.indexOf('Lee O') && s.indexOf('Lee O') < s.indexOf('Cal Old') && s.indexOf('Cal Old') < s.indexOf('Today: shed for Zed'));
  assert.deepEqual(b.display.upcoming_installs.map((x) => x.install_id), [1]);   // past date excluded
  assert.deepEqual(b.display.urgent.map((x) => x.kind), ['install_today', 'customer_email_waiting']);
  assert.equal(b.intents.draft_a_response.endpoint, '/api/briefing/draft?kind=email&id=t1');
  assert.ok(s.split(/\s+/).length <= 150);
});
