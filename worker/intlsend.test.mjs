/* International Phase 5: sending (dryrun + stubbed Resend). No network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { ensureLeadPipelineTables } from './leadpipeline.js';
import { runOutreachTick, sendViaProvider, buildEmail, inSendWindow, svixSign, verifySvix, mxCheck, sendConfig } from './intlcampaigns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db) {
  function shape(sql) {
    const st = db.prepare(sql);
    const sel = /^\s*(select|pragma)/i.test(sql);
    return a => ({
      first() { return sel ? (st.get(...a) ?? null) : (st.run(...a), null); },
      all() { return { results: st.all(...a) }; },
      run() {
        if (sel) return { results: st.all(...a) };
        const r = st.run(...a);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map(x => x.run()); } };
}

async function setup(extra) {
  const crm = new DatabaseSync(':memory:');
  const shed = new DatabaseSync(':memory:');
  shed.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  const env = Object.assign({ DB: makeD1(shed), CRM_DB: makeD1(crm), CRM_PASSWORD: 'crm-pw', ADMIN_PASSWORD: 'shed-pw',
    ADMIN_SESSION_SECRET: 's3cr3t-test-key', OUTREACH_POSTAL_ADDRESS: 'PO Box 1, Park City, UT 84060',
    PUBLIC_API_BASE: 'https://api.test' }, extra || {});
  const raw = async (method, p, body, token) => {
    const headers = { Origin: 'https://potentianetwork.com' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    return worker.fetch(new Request('https://api.test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  };
  const call = async (...a) => { const res = await raw(...a); let data = null; try { data = await res.json(); } catch (e) {} return { status: res.status, data }; };
  const token = (await call('POST', '/crm/login', { password: 'crm-pw' })).data.token;
  await call('GET', '/crm/clients', null, token);
  await ensureLeadPipelineTables(env);
  const now = new Date().toISOString();
  const lead = (o) => {
    const id = Number(crm.prepare(`INSERT INTO clients (business_name, website_url, status, source, country, do_not_contact, created_at, updated_at)
      VALUES (?, ?, 'lead', ?, ?, ?, ?, ?)`).run(o.name, o.website || null, o.source || 'pipeline_intl', o.country || 'MX', o.dnc ? 1 : 0, now, now).lastInsertRowid);
    for (const em of o.emails || []) crm.prepare(`INSERT INTO lead_emails (client_id, email, discovered_at, type, verification_status, source_url, eligibility)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, em.email, now, em.type || 'role', em.v || 'unverified', em.src === undefined ? 'https://' + (o.website || 'x').replace(/^https?:\/\//, '') + '/contacto' : em.src, em.elig || 'pending_verification');
    for (const ev of o.evidence || []) crm.prepare(`INSERT INTO lead_evidence (client_id, kind, category, status, confirmed, created_at)
      VALUES (?, ?, 'audit', ?, ?, ?)`).run(id, ev[0], ev[1], ev[1] === 'confirmed_issue' ? 1 : 0, now);
    return id;
  };
  return { env, crm, call, raw, token, lead };
}


const good = (name, dom, extra) => Object.assign({ name, website: 'https://' + dom, emails: [{ email: 'info@' + dom }],
  evidence: [['audit_https', 'confirmed_issue']] }, extra || {});
const NOW = new Date('2026-11-04T17:00:00Z'); // Wed 10:00 Denver, 11:00 CDMX
const okDns = async (u) => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15, data: '10 mx.x' }] }));
const noop = async () => {};
const ON = { OUTREACH_SEND_ENABLED: 'true', OUTREACH_SENDER_EMAIL: 'fernando@potentianetwork.com', OUTREACH_REPLY_TO: 'fernando@potentianetwork.com' };

async function scheduledCampaign(ctx, ids, opts) {
  const { call, token, crm } = ctx;
  const c = (await call('POST', '/crm/intl/campaigns', { client_ids: ids }, token)).data.campaign_id;
  if (opts && opts.live) assert.equal((await call('POST', `/crm/intl/campaigns/${c}/dry-run`, { dry_run: 0 }, token)).status, 200);
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'approved' }, token)).status, 200);
  if (!(opts && opts.noNando)) assert.equal((await call('POST', `/crm/intl/campaigns/${c}/nando-approve`, { confirm: true }, token)).status, 200);
  assert.equal((await call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'scheduled', scheduled_for: '2099-01-01T00:00:00Z' }, token)).status, 200);
  crm.prepare("UPDATE campaigns SET scheduled_for = '2026-11-01T00:00:00Z' WHERE id = ?").run(c);
  return c;
}
const st = (crm, c) => crm.prepare('SELECT status FROM campaigns WHERE id = ?').get(c).status;
const msgs = (crm, c) => crm.prepare('SELECT * FROM campaign_messages WHERE campaign_id = ? ORDER BY id').all(c);

test('defaults: kill switch off, dryrun provider; tick is a no-op when off', async () => {
  const cfg = sendConfig({});
  assert.equal(cfg.enabled, false); assert.equal(cfg.provider, 'dryrun'); assert.equal(cfg.dailyCap, 25);
  assert.equal(sendConfig({ OUTREACH_SEND_ENABLED: 'TRUE' }).enabled, false);
  const ctx = await setup();
  const c = await scheduledCampaign(ctx, [ctx.lead(good('A', 'a.mx'))]);
  const r = await runOutreachTick(ctx.env, { now: NOW, fetch: okDns, sleep: noop });
  assert.match(r.skipped, /OUTREACH_SEND_ENABLED/);
  assert.equal(st(ctx.crm, c), 'scheduled');
});

test('hand transitions: sending/done/failed refused; new campaigns dry_run=1', async () => {
  const ctx = await setup();
  const c = await scheduledCampaign(ctx, [ctx.lead(good('A', 'a.mx'))]);
  for (const s of ['sending', 'done', 'failed']) assert.equal((await ctx.call('POST', `/crm/intl/campaigns/${c}/status`, { status: s }, ctx.token)).status, 400);
  assert.equal(ctx.crm.prepare('SELECT dry_run FROM campaigns WHERE id = ?').get(c).dry_run, 1);
  assert.equal((await ctx.call('POST', `/crm/intl/campaigns/${c}/status`, { status: 'paused' }, ctx.token)).status, 200);
  assert.equal((await ctx.call('POST', `/crm/intl/campaigns/${c}/resume`, {}, ctx.token)).data.status, 'scheduled');
  assert.equal((await ctx.call('POST', `/crm/intl/campaigns/${c}/nando-approve`, {}, ctx.token)).status, 400, 'needs confirm');
});

test('without Nando approval scheduler does not start the campaign', async () => {
  const ctx = await setup(ON);
  const c = await scheduledCampaign(ctx, [ctx.lead(good('A', 'a.mx'))], { noNando: true });
  const r = await runOutreachTick(ctx.env, { now: NOW, fetch: okDns, sleep: noop });
  assert.deepEqual(r.started, []); assert.equal(st(ctx.crm, c), 'scheduled');
});

test('dry-run campaign: full pipeline, never calls Resend, per-domain + caps, done', async () => {
  const ctx = await setup(Object.assign({}, ON, { OUTREACH_PROVIDER: 'resend', RESEND_API_KEY: 'k', OUTREACH_BATCH_SIZE: '2' }));
  const a = ctx.lead(good('A', 'a.mx')), b = ctx.lead(good('B', 'b.mx', { country: 'US' })), c2 = ctx.lead(good('C', 'c.mx'));
  const c = await scheduledCampaign(ctx, [a, b, c2]);
  const calls = [];
  const f = async (u, i) => { calls.push(String(u)); return okDns(u); };
  let r = await runOutreachTick(ctx.env, { now: NOW, fetch: f, sleep: noop });
  assert.deepEqual(r.started, [c]); assert.equal(r.dry, 2); assert.equal(r.sent, 0);
  assert.ok(calls.every(u => u.includes('cloudflare-dns.com')), 'no provider call');
  assert.equal(st(ctx.crm, c), 'sending');
  r = await runOutreachTick(ctx.env, { now: NOW, fetch: f, sleep: noop });
  assert.equal(r.dry, 1); assert.equal(st(ctx.crm, c), 'done');
  const m = msgs(ctx.crm, c);
  assert.ok(m.every(x => x.status === 'sent' && /^dryrun-/.test(x.provider_message_id) && x.dry_run === 1 && x.rendered_hash.length === 64));
  assert.equal(m[0].idempotency_key, `camp-${c}-msg-${m[0].id}`);
  assert.equal(ctx.crm.prepare("SELECT sent FROM send_ledger WHERE mode='dry'").get().sent, 3);
});

test('live (stubbed Resend): headers + idempotency; window, per-domain, daily cap; atomic claim', async () => {
  const ctx = await setup(Object.assign({}, ON, { OUTREACH_PROVIDER: 'resend', RESEND_API_KEY: 'rk', OUTREACH_DAILY_CAP: '2' }));
  const a = ctx.lead(good('A', 'a.mx')), b = ctx.lead(good('B', 'b.mx')), c2 = ctx.lead(good('C', 'c.mx'));
  const c = await scheduledCampaign(ctx, [a, b, c2], { live: true });
  // Outside window (Sunday) -> deferred.
  let r = await runOutreachTick(ctx.env, { now: new Date('2026-11-08T17:00:00Z'), fetch: okDns, sleep: noop });
  assert.equal(r.deferred, 3); assert.equal(r.sent, 0);
  const sent = [];
  const f = async (u, init) => {
    if (String(u).includes('resend.com')) { sent.push(init); return new Response(JSON.stringify({ id: 're_' + sent.length }), { status: 200 }); }
    return okDns(u);
  };
  r = await runOutreachTick(ctx.env, { now: NOW, fetch: f, sleep: noop });
  assert.equal(r.sent, 2); assert.equal(r.deferred, 1, 'daily cap');
  const body = JSON.parse(sent[0].body);
  assert.equal(body.from, 'Potentia Network <fernando@potentianetwork.com>');
  assert.equal(body.reply_to, 'fernando@potentianetwork.com');
  assert.match(body.headers['List-Unsubscribe'], /^<https:\/\/api\.test\/u\/[a-f0-9]+>, <mailto:fernando@potentianetwork\.com\?subject=unsubscribe>$/);
  assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.doesNotMatch(body.html, /<img/i, 'no tracking pixel');
  assert.match(sent[0].headers['Idempotency-Key'], /^camp-\d+-msg-\d+$/);
  // Atomic claim: a row someone else already claimed is not sent again.
  const m = msgs(ctx.crm, c);
  const q = m.find(x => x.status === 'queued');
  ctx.crm.prepare("UPDATE campaign_messages SET status = 'sending' WHERE id = ?").run(q.id);
  r = await runOutreachTick(ctx.env, { now: new Date('2026-11-05T17:00:00Z'), fetch: f, sleep: noop });
  assert.equal(r.sent, 0); assert.equal(sent.length, 2);
});

test('per-domain limit: two addresses on one domain -> one per day', async () => {
  const ctx = await setup(ON);
  const a = ctx.lead(good('A', 'same.mx')), b = ctx.lead(good('B', 'same.mx', { emails: [{ email: 'ventas@same.mx' }] }));
  await scheduledCampaign(ctx, [a, b]);
  const r = await runOutreachTick(ctx.env, { now: NOW, fetch: okDns, sleep: noop });
  assert.equal(r.dry, 1); assert.equal(r.deferred, 1);
});

test('pre-send recheck: suppression after scheduling, no MX -> skipped', async () => {
  const ctx = await setup(ON);
  const a = ctx.lead(good('A', 'a.mx')), b = ctx.lead(good('B', 'nomx.mx'));
  const c = await scheduledCampaign(ctx, [a, b]);
  ctx.crm.prepare("UPDATE clients SET do_not_contact = 1 WHERE id = ?").run(a);
  const f = async (u) => String(u).includes('nomx') ? new Response(JSON.stringify({ Status: 3 })) : okDns(u);
  const r = await runOutreachTick(ctx.env, { now: NOW, fetch: f, sleep: noop });
  assert.equal(r.skipped, 2);
  const m = msgs(ctx.crm, c);
  assert.deepEqual(m.map(x => x.block_reason).sort(), ['do_not_contact', 'no_mx']);
  assert.equal(st(ctx.crm, c), 'done');
});

test('provider errors: 429 retries with backoff then fails; 401 fails campaign', async () => {
  const ctx = await setup(Object.assign({}, ON, { OUTREACH_PROVIDER: 'resend', RESEND_API_KEY: 'rk' }));
  const c = await scheduledCampaign(ctx, [ctx.lead(good('A', 'a.mx'))], { live: true });
  const f429 = async (u) => String(u).includes('resend') ? new Response('{"message":"rate"}', { status: 429 }) : okDns(u);
  let r = await runOutreachTick(ctx.env, { now: NOW, fetch: f429, sleep: noop });
  assert.equal(r.retried, 1);
  let m = msgs(ctx.crm, c)[0]; assert.equal(m.status, 'queued'); assert.ok(m.next_attempt_at > NOW.toISOString());
  r = await runOutreachTick(ctx.env, { now: NOW, fetch: f429, sleep: noop }); assert.equal(r.retried + r.failed, 0, 'backoff respected');
  r = await runOutreachTick(ctx.env, { now: new Date('2026-11-04T17:20:00Z'), fetch: f429, sleep: noop }); assert.equal(r.retried, 1);
  r = await runOutreachTick(ctx.env, { now: new Date('2026-11-04T18:00:00Z'), fetch: f429, sleep: noop }); assert.equal(r.failed, 1);
  const ctx2 = await setup(Object.assign({}, ON, { OUTREACH_PROVIDER: 'resend', RESEND_API_KEY: 'bad' }));
  const c2 = await scheduledCampaign(ctx2, [ctx2.lead(good('A', 'a.mx'))], { live: true });
  const f401 = async (u) => String(u).includes('resend') ? new Response('{"message":"bad key"}', { status: 401 }) : okDns(u);
  r = await runOutreachTick(ctx2.env, { now: NOW, fetch: f401, sleep: noop });
  assert.equal(st(ctx2.crm, c2), 'failed'); assert.match(r.halted, /401/);
  assert.deepEqual(await sendViaProvider({}, 'resend', {}, 'k'), { fatal: true, error: 'RESEND_API_KEY not set' });
});

test('window per recipient country', () => {
  const w = [9, 17];
  assert.equal(inSendWindow('US', new Date('2026-11-04T15:30:00Z'), w), false); // 08:30 Denver
  assert.equal(inSendWindow('MX', new Date('2026-11-04T15:30:00Z'), w), true);  // 09:30 CDMX
  assert.equal(inSendWindow('US', new Date('2026-11-05T00:30:00Z'), w), false); // 17:30 Denver
});

test('webhook: signature required; bounce/complaint -> suppression; dedupe; circuit breaker', async () => {
  const secret = 'whsec_' + Buffer.from('supersecretkey-1234567890').toString('base64');
  const ctx = await setup(Object.assign({}, ON, { RESEND_WEBHOOK_SECRET: secret }));
  const ids = ['a', 'b', 'c'].map(x => ctx.lead(good(x, x + '.mx')));
  const c = await scheduledCampaign(ctx, ids);
  await runOutreachTick(ctx.env, { now: NOW, fetch: okDns, sleep: noop });
  const m = msgs(ctx.crm, c);
  const post = async (evId, payload, sigOverride) => {
    const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
    const sig = sigOverride || 'v1,' + await svixSign(secret, evId, ts, body);
    return ctx.env && (await import('./index.js')).default.fetch(new Request('https://api.test/webhooks/email/resend', {
      method: 'POST', headers: { 'svix-id': evId, 'svix-timestamp': ts, 'svix-signature': sig, 'Content-Type': 'application/json' }, body }), ctx.env);
  };
  assert.equal((await post('e0', { type: 'email.delivered', data: {} }, 'v1,AAAA')).status, 401);
  let res = await post('e1', { type: 'email.delivered', data: { email_id: m[0].provider_message_id, to: [m[0].to_email] } });
  assert.equal(res.status, 200); assert.equal(msgs(ctx.crm, c)[0].status, 'delivered');
  res = await post('e2', { type: 'email.bounced', data: { email_id: m[1].provider_message_id, to: [m[1].to_email], bounce: { type: 'Permanent' } } });
  assert.equal((await res.json()).suppressed, 'info@b.mx');
  assert.equal(ctx.crm.prepare("SELECT COUNT(*) n FROM email_suppressions WHERE value='info@b.mx' AND reason='hard_bounce'").get().n, 1);
  assert.equal(ctx.crm.prepare("SELECT verification_status v FROM lead_emails WHERE email='info@b.mx'").get().v, 'invalid');
  res = await post('e2', { type: 'email.bounced', data: { email_id: m[1].provider_message_id } });
  assert.equal((await res.json()).duplicate, true);
  res = await post('e3', { type: 'email.complained', data: { email_id: m[2].provider_message_id, to: [m[2].to_email] } });
  assert.equal(res.status, 200);
  assert.equal(ctx.crm.prepare("SELECT COUNT(*) n FROM email_suppressions WHERE kind='domain' AND value='c.mx'").get().n, 1);
  assert.equal(ctx.crm.prepare('SELECT do_not_contact d FROM clients WHERE id = ?').get(ids[2]).d, 1);
  assert.equal(msgs(ctx.crm, c)[2].status, 'complained');
  // breaker: campaign is done already; force sending to test the pause.
  ctx.crm.prepare("UPDATE campaigns SET status='sending', complaint_count = 1 WHERE id = ?").run(c);
  res = await post('e4', { type: 'email.complained', data: { email_id: m[0].provider_message_id, to: [m[0].to_email] } });
  assert.match((await res.json()).paused, /complaints 2/);
  assert.equal(st(ctx.crm, c), 'paused');
  const ctx3 = await setup();
  assert.equal((await verifySvix('', new Headers(), '')), 'no_secret');
});

test('send status + dry-run report endpoints (read-only)', async () => {
  const ctx = await setup();
  const a = ctx.lead(good('A', 'a.mx')), b = ctx.lead(good('B', 'b.mx'));
  const c = (await ctx.call('POST', '/crm/intl/campaigns', { client_ids: [a, b] }, ctx.token)).data.campaign_id;
  ctx.crm.prepare("UPDATE clients SET do_not_contact = 1 WHERE id = ?").run(b);
  const s = await ctx.call('GET', '/crm/intl/send/status', null, ctx.token);
  assert.equal(s.data.enabled, false); assert.equal(s.data.resend_key_set, false);
  ctx.env.OUTREACH_MX_CHECK = 'false';
  const r = await ctx.call('GET', `/crm/intl/campaigns/${c}/report`, null, ctx.token);
  assert.equal(r.data.would_send.length, 1); assert.equal(r.data.would_skip[0].reason, 'do_not_contact');
  assert.equal((await ctx.call('GET', '/crm/intl/send/status', null)).status, 401);
});

test('t1508u: provenance snapshot; unknown source + personal -> review; duplicate blocked at schedule', async () => {
  const ctx = await setup(ON);
  const a = ctx.lead(good('A', 'a.mx'));
  const nos = ctx.lead(good('NoSrc', 'ns.mx', { emails: [{ email: 'info@ns.mx', src: '' }] }));
  const per = ctx.lead(good('Per', 'per.mx', { emails: [{ email: 'juan@per.mx', type: 'personal', v: 'verified' }] }));
  const perOk = ctx.lead(good('PerOk', 'pok.mx', { emails: [{ email: 'ana@pok.mx', type: 'personal', v: 'verified', elig: 'eligible' }] }));
  const r = await ctx.call('POST', '/crm/intl/campaigns', { client_ids: [a, nos, per, perOk] }, ctx.token);
  const m = msgs(ctx.crm, r.data.campaign_id);
  const by = Object.fromEntries(m.map(x => [x.client_id, x]));
  assert.equal(by[nos].block_reason, 'provenance_unknown_review');
  assert.equal(by[per].block_reason, 'personal_needs_review');
  assert.equal(by[perOk].status, 'draft', 'human-reviewed personal address allowed');
  assert.equal(by[a].business_name_at_draft, 'A'); assert.equal(by[a].website_at_draft, 'https://a.mx');
  assert.match(by[a].email_source_url, /a\.mx\/contacto/); assert.ok(by[a].email_collected_at);
  // First campaign sends to a.mx; a second campaign to a.mx is blocked at schedule as duplicate.
  const c1 = await scheduledCampaign(ctx, [a]);
  await runOutreachTick(ctx.env, { now: new Date(), fetch: okDns, sleep: noop, });
  ctx.crm.prepare("UPDATE campaign_messages SET status='queued' WHERE campaign_id = ?").run(c1); // in flight
  const c2 = (await ctx.call('POST', '/crm/intl/campaigns', { client_ids: [a] }, ctx.token)).data.campaign_id;
  assert.equal((await ctx.call('POST', `/crm/intl/campaigns/${c2}/status`, { status: 'approved' }, ctx.token)).status, 200);
  const s = await ctx.call('POST', `/crm/intl/campaigns/${c2}/status`, { status: 'scheduled', scheduled_for: '2099-01-01T00:00:00Z' }, ctx.token);
  assert.equal(s.status, 400); assert.equal(msgs(ctx.crm, c2)[0].block_reason, 'duplicate_recent_contact');
});

test('t1508u: live campaign never silently dry-runs when Resend identity is missing', async () => {
  const ctx = await setup(Object.assign({}, ON, { OUTREACH_PROVIDER: 'dryrun' }));
  const c = await scheduledCampaign(ctx, [ctx.lead(good('A', 'a.mx'))], { live: true });
  const r = await runOutreachTick(ctx.env, { now: NOW, fetch: okDns, sleep: noop });
  assert.equal(r.dry + r.sent, 0); assert.equal(st(ctx.crm, c), 'failed'); assert.match(r.halted, /live send refused/);
});
