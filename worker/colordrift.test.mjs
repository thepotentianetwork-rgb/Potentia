/* Colour drift between a quote and the customer's latest saved design.
 *
 * Quote #73 (Oct 2026): the 3D designer paints Brown Asphalt (roofColor
 * 0x453A2F) but a design reopened from a saved link restored the hex and kept
 * the default 'Black Asphalt' label. The label then travelled into the quote
 * when it was copied. Three guards:
 *   1. normalizeColorNames rewrites roof/trim labels from the hex, on every
 *      public submit and every staff design update.
 *   2. The customer view reports color_drift where a quote's roof, siding or
 *      trim hex differs from the customer's latest saved design.
 *   3. The CRM warns (and asks) before marking such a quote won/quoted or
 *      billing it.
 *
 * Run: node --experimental-sqlite --test worker/colordrift.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { roofColorName, trimColorName, normalizeColorNames, designColorDiffs } from './quotelines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWN = 0x453A2F, BLACK = 0x28282A, BEIGE = 0xC9BDA4, WHITE = 0xF2F0EC;

function makeD1(db){
  function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
    return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); },
      all(){ return {results:st.all(...a)}; },
      run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a);
             return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; }, async batch(st){ return st.map(x=>x.run()); } };
}
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(HERE,'schema.sql'),'utf8'));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(':memory:')), ADMIN_PASSWORD:'pw', CRM_PASSWORD:'c', ADMIN_SESSION_SECRET:'k' };
async function call(m,p,b,t){ const h={Origin:'https://potentianetwork.com'}; if(b)h['Content-Type']='application/json'; if(t)h.Authorization='Bearer '+t;
  const res=await worker.fetch(new Request('https://x'+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env); return {status:res.status,data:await res.json().catch(()=>null)}; }
const tok = (await call('POST','/admin/login',{password:'pw'})).data.token;

const cfg = (roof, label) => ({ style:'barn', w:10, l:12, h:8, roofType:'shingle', roofColor:roof,
  sidingColor:BEIGE, trimColor:WHITE, colorNames:{ siding:'Beige', trim:'White', roof:label } });

test('hex names the colour, and the label is rewritten to match', () => {
  assert.equal(roofColorName({ roofType:'shingle', roofColor:BROWN }), 'Brown Asphalt');
  assert.equal(roofColorName({ roofType:'shingle', roofColor:BLACK }), 'Black Asphalt');
  assert.equal(roofColorName({ roofType:'metal', roofColor:0x5A4636 }), 'Brown');
  assert.equal(trimColorName({ trimColor:WHITE }), 'White');
  const c = cfg(BROWN, 'Black Asphalt');
  const fixed = normalizeColorNames(c);
  assert.deepEqual(fixed, [{ part:'roof', was:'Black Asphalt', now:'Brown Asphalt' }]);
  assert.equal(c.colorNames.roof, 'Brown Asphalt');
  assert.deepEqual(normalizeColorNames(c), [], 'already correct: nothing to fix');
});

test('a label that matches the hex is left alone, and an unknown hex is left alone', () => {
  const c = cfg(BROWN, 'Brown Asphalt');
  assert.deepEqual(normalizeColorNames(c), []);
  const odd = cfg(0x123456, 'Custom');
  assert.deepEqual(normalizeColorNames(odd), []);
  assert.equal(odd.colorNames.roof, 'Custom');
});

test('diffs compare the painted hex, not the label', () => {
  const quote = cfg(BROWN, 'Black Asphalt');
  const design = cfg(BROWN, 'Brown Asphalt');
  assert.deepEqual(designColorDiffs(quote, design), [], 'same hex, drifted label: no drift');
  const other = cfg(BLACK, 'Black Asphalt');
  const diffs = designColorDiffs(other, design);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].part, 'roof');
  assert.equal(diffs[0].quote, 'Black Asphalt');
  assert.equal(diffs[0].design, 'Brown Asphalt');
  const siding = { ...cfg(BROWN, 'Brown Asphalt'), sidingColor:0x7C8A6E, colorNames:{ siding:'Sage', trim:'White', roof:'Brown Asphalt' } };
  assert.equal(designColorDiffs(siding, design).map((d) => d.part).join(','), 'siding');
});

test('a public submit stores the hex name, not the drifted label', async () => {
  const r = await call('POST','/shed/submit',{ contact:{ name:'Nahui Lopez', email:'nahui@x.com', phone:'4355550100' }, config:cfg(BROWN,'Black Asphalt'), quotedPrice:9000 });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get();
  const stored = JSON.parse(row.details).config;
  assert.equal(stored.colorNames.roof, 'Brown Asphalt');
  assert.equal(stored.roofColor, BROWN);
});

test('a staff design update stores the hex name too', async () => {
  const id = db.prepare('SELECT id FROM submissions ORDER BY id DESC LIMIT 1').get().id;
  const r = await call('POST','/admin/submissions/'+id+'/design',{ config:cfg(BROWN,'Black Asphalt') }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stored = JSON.parse(db.prepare('SELECT details FROM submissions WHERE id=?').get(id).details).config;
  assert.equal(stored.colorNames.roof, 'Brown Asphalt');
});

test('the customer view reports drift against the latest saved design only', async () => {
  const id = db.prepare('SELECT id FROM submissions ORDER BY id DESC LIMIT 1').get().id;
  const cust = db.prepare('SELECT customer_id FROM submissions WHERE id=?').get(id).customer_id;
  db.exec(`CREATE TABLE IF NOT EXISTS saved_designs (
    code TEXT PRIMARY KEY, config TEXT NOT NULL, contact_name TEXT, contact_email TEXT, contact_phone TEXT, created_at TEXT NOT NULL)`);
  const save = (code, c, at) => db.prepare('INSERT INTO saved_designs (code,config,contact_email,created_at) VALUES (?,?,?,?)')
    .run(code, JSON.stringify(c), 'nahui@x.com', at);
  save('older001', cfg(BLACK, 'Black Asphalt'), '2026-10-01T00:00:00Z');
  save('latest01', cfg(BROWN, 'Brown Asphalt'), '2026-10-14T00:00:00Z');
  const view = await call('GET','/admin/customers/'+cust, null, tok);
  const sub = view.data.submissions.find((s) => s.id === id);
  assert.deepEqual(sub.color_drift, [], 'quote matches the latest design: no warning');

  db.prepare('UPDATE saved_designs SET config=? WHERE code=?').run(JSON.stringify(cfg(BLACK,'Black Asphalt')), 'latest01');
  const view2 = await call('GET','/admin/customers/'+cust, null, tok);
  const drift = view2.data.submissions.find((s) => s.id === id).color_drift;
  assert.equal(drift.length, 1);
  assert.equal(drift[0].part, 'roof');
  assert.equal(drift[0].quote, 'Brown Asphalt');
  assert.equal(drift[0].design, 'Black Asphalt');
  assert.equal(drift[0].design_code, 'latest01', 'compared to the newest design, not the older one');
});

test('a saved design stores the hex name too', async () => {
  const r = await call('POST','/shed/design',{ config:cfg(BROWN,'Black Asphalt'), contact:{ email:'nahui@x.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stored = JSON.parse(db.prepare('SELECT config FROM saved_designs WHERE code=?').get(r.data.code).config);
  assert.equal(stored.colorNames.roof, 'Brown Asphalt');
});

test('the CRM warns, and asks, before won/quoted or billing when colours differ', () => {
  const html = fs.readFileSync(path.join(HERE,'..','admin-customer.html'),'utf8');
  for (const fn of ['colorDriftText', 'colorDriftConfirm', 'colorDriftBanner']) assert.match(html, new RegExp('function ' + fn));
  const status = html.slice(html.indexOf("select.addEventListener('change'"), html.indexOf("select.addEventListener('change'") + 700);
  assert.match(status, /select.value === 'won'/);
  assert.match(status, /select.value === 'quoted'/);
  assert.match(status, /colorDriftConfirm/);
  const bill = html.slice(html.indexOf("var parts = picked()"), html.indexOf("var parts = picked()") + 300);
  assert.match(bill, /colorDriftConfirm\(s, 'Bill'\)/);
  assert.match(html, /colorDriftBanner\(s\)/);
});
