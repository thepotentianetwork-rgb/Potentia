// Concrete scope of work (Nando, 12 Oct 2026): saved per order, additive column,
// shown on the concrete phase of the bill; never changes an amount.
import test from 'node:test'; import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { quoteLines } from './quotelines.js';
import { buildInvoice, addConcreteScope } from './invoices.js';
import { computePricing } from './pricing.js';
const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db){ function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
  return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); }, all(){ return {results:st.all(...a)}; },
    run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a); return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; }, async batch(st){ return st.map(x=>x.run()); } }; }
const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(path.join(here,'schema.sql'),'utf8'));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')), ADMIN_PASSWORD:'pw', CRM_PASSWORD:'c', ADMIN_SESSION_SECRET:'k' };
const now = new Date().toISOString();
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('A',?,?)").run(now,now);
const cfg = { style:'gable', w:12, l:16, h:9, foundation:'pad' };
const redline = computePricing(cfg).redline;
db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)").run(JSON.stringify({quotedPrice:1, config:cfg, redline}),'quoted',now);
async function api(method, p, body){ const tok=(await (await worker.fetch(new Request('https://l/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'pw'})}),env)).json()).token;
  const r=await worker.fetch(new Request('https://l'+p,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:body?JSON.stringify(body):undefined}),env); return {status:r.status,data:await r.json()}; }
test('save adds the column (additive) and stores multi-line text; blank clears it', async () => {
  const cols0 = db.prepare('PRAGMA table_info(submissions)').all().map(c=>c.name);
  assert.ok(!cols0.includes('concrete_scope'));
  const r = await api('POST','/admin/submissions/1/concrete-scope',{text:'12x16 x 4" slab\n3000 PSI, broom finish  \n'});
  assert.equal(r.status,200); assert.equal(r.data.concrete_scope,'12x16 x 4" slab\n3000 PSI, broom finish');
  const cols1 = db.prepare('PRAGMA table_info(submissions)').all().map(c=>c.name);
  assert.deepEqual(cols1.slice(0, cols0.length), cols0, 'existing columns untouched');
  const g = await api('GET','/admin/submissions/1'); assert.match(JSON.stringify(g.data), /3000 PSI/);
  assert.equal((await api('POST','/admin/submissions/1/concrete-scope',{text:'   '})).data.concrete_scope, '', 'blank = this order shows none');
  const d = await api('POST','/admin/submissions/1/concrete-scope',{useDefault:true});
  assert.equal(d.data.concrete_scope, null); assert.match(d.data.concrete_scope_effective, /4,000 PSI/);
  const g2 = await api('GET','/admin/submissions/1'); assert.match(JSON.stringify(g2.data), /3\/4\\" compacted gravel/);
  assert.equal((await api('POST','/admin/submissions/99/concrete-scope',{text:'x'})).status, 404);
  assert.equal((await api('POST','/admin/submissions/1/concrete-scope',{text:'x'.repeat(4001)})).status, 400);
});
test('the bill names the scope on the concrete line only; amounts unchanged', () => {
  const bd = quoteLines(redline, []);
  const a = buildInvoice(bd,'deposit',[],{}), b = addConcreteScope(buildInvoice(bd,'deposit',[],{}), bd, 'Slab\n3000 PSI', cfg);
  assert.deepEqual(b.lines.map(l=>l.amountCents), a.lines.map(l=>l.amountCents)); assert.equal(b.totalCents, a.totalCents);
  const hit = b.lines.filter(l=>/Scope of work: Slab 3000 PSI/.test(l.label));
  assert.equal(hit.length,1); assert.match(hit[0].label,/Concrete/);
  assert.ok(hit[0].label.length <= 250);
});
test('no concrete, no scope', () => {
  const c2 = { ...cfg, foundation:'blocks' }, bd = quoteLines(computePricing(c2).redline, []);
  const b = addConcreteScope(buildInvoice(bd,'deposit',[],{}), bd, 'Slab', c2);
  assert.ok(!b.lines.some(l=>/Scope of work/.test(l.label)));
});
test('ridge vent: $15 x the ridge (shed length), on barns too, never on a lean-to', () => {
  for (const st of ['gable','3peak','4peak','barn']) {
    const l = computePricing({ style:st, w:12, l:16, h:9, addons:{ ridgeVent:true } }).redline.addonLines.find(x=>/Ridge Vent/.test(x.name));
    assert.deepEqual([l.name, l.amt], ['Roof Ridge Vent 16 ft \u00d7 $15', 240], st);
  }
  assert.ok(!computePricing({ style:'leanto', w:12, l:16, h:9, addons:{ ridgeVent:true } }).redline.addonLines.some(x=>/Ridge/.test(x.name)));
  const a = computePricing({ style:'gable', w:12, l:16, h:9 }).customer, b = computePricing({ style:'gable', w:12, l:16, h:9, addons:{ ridgeVent:true } }).customer;
  assert.ok(b > a);
});

test('the standard text says exactly what Nando said, and nothing more', async () => {
  const { CONCRETE_SCOPE_DEFAULT: t } = await import('./pricing.js');
  for (const must of [/grub, level and grade/, /excessive vegetation/, /outside this scope, is billed separately/, /3\/4" compacted gravel/, /4,000 PSI/, /slightly raised/, /runoff/, /4" thick slab/, /wire mesh/, /control joints/, /Vapor barrier: not included; available as an add-on/])
    assert.match(t, must);
  assert.doesNotMatch(t, /rebar|warrant|inch slab/i);
  assert.doesNotMatch(t.replace(/Vapor barrier: not included; available as an add-on\./,''), /vapor/i, 'vapor barrier is an add-on, not standard');
});
