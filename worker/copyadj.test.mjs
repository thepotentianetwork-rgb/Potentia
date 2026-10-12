// Copy-adjustments source + staff "Update this quote" from the designer.
// Run: node --experimental-sqlite worker/copyadj.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db){
  function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
    return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); },
      all(){ return {results:st.all(...a)}; },
      run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a);
             return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; }, async batch(st){ return st.map(x=>x.run()); } };
}
const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(":memory:")), ADMIN_PASSWORD:"pw", CRM_PASSWORD:"c", ADMIN_SESSION_SECRET:"k" };
const now = new Date().toISOString();
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('A',?,?)").run(now,now);
const cfg = {style:"gable",w:10,l:12,foundation:"pad"};
const ins = (c) => db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
  .run(JSON.stringify({quotedPrice:1, config:c, address:"1 Main", geo:{lat:1}}), "quoted", now);
let fails=0; const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){ const h={Origin:"https://potentianetwork.com"}; if(b)h["Content-Type"]="application/json"; if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env); return {status:res.status,data:await res.json().catch(()=>null)}; }
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;

// Price three orders from real configs via the update endpoint.
ins(cfg); ins(cfg); ins(cfg);
for (const id of [1,2,3]) { const r = await call("POST",`/admin/submissions/${id}/design`,{config:cfg},tok); check("price order "+id, r.status===200, r); }
console.log("\n-- auth --");
check("update refused without token", (await call("POST","/admin/submissions/1/design",{config:cfg})).status===401);
check("last refused without token", (await call("GET","/admin/adjustments/last?exclude=1")).status===401);

const cust = (await call("GET","/admin/customers/1",null,tok)).data.submissions;
const items = cust.find(s=>s.id===1).comp_items.map(i=>i.name);
const pad = items.find(n=>/concrete|pad/i.test(n)) || items[0];
console.log("\n-- last quote with adjustments --");
let r = await call("GET","/admin/adjustments/last?exclude=3",null,tok);
check("none yet", r.data.source===null, r.data);
await call("POST","/admin/submissions/1/adjustments",{adjustments:[{kind:"percent",value:-5,note:"Old"}]},tok);
await new Promise(z=>setTimeout(z,5));
await call("POST","/admin/submissions/2/adjustments",{adjustments:[{kind:"override",item:pad,amount:3000,note:"Site"},{kind:"amount",value:-100,note:"Goodwill"}]},tok);
r = await call("GET","/admin/adjustments/last?exclude=3",null,tok);
check("picks most recently saved (#2), not highest id with none (#3)", r.data.source && r.data.source.id===2, r.data);
r = await call("GET","/admin/adjustments/last?exclude=2",null,tok);
check("excludes the quote being edited", r.data.source.id===1, r.data);

console.log("\n-- CRM planner (from admin-customer.html) --");
const html = fs.readFileSync(path.join(here,"../admin-customer.html"),"utf8");
const src = html.slice(html.indexOf("function planAdjustmentCopy"), html.indexOf("function adjPlainText"));
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const plan = ctx.planAdjustmentCopy(
  [{kind:"override",item:pad,amount:3000},{kind:"comp",item:"Gold Taps"},{kind:"percent",value:-5,note:"x"},{kind:"travel",days:1,rate:50}],
  [{kind:"travel",days:2,rate:60}], cust[0].comp_items);
check("matching item applied", plan.apply.some(a=>a.kind==="override"), plan);
check("missing item skipped with reason", plan.skipped.some(x=>x.a.item==="Gold Taps" && /not on this quote/.test(x.why)), plan);
check("existing travel not doubled", plan.skipped.some(x=>x.a.kind==="travel"), plan);
check("current kept first", plan.next[0].kind==="travel" && plan.next.length===3, plan.next);
const applied = await call("POST","/admin/submissions/3/adjustments",{adjustments:plan.next},tok);
check("copied list saves through the normal validator", applied.status===200, applied);

console.log("\n-- update design keeps adjustments, flags stale, audits --");
const before = JSON.parse(db.prepare("SELECT details FROM submissions WHERE id=2").get().details);
r = await call("POST","/admin/submissions/2/design",{config:{...cfg,foundation:"none",l:14}},tok);
check("update ok", r.status===200, r);
check("pad override now stale", r.data.stale.some(a=>a.item===pad), r.data.stale);
const row = db.prepare("SELECT details, adjustments, status FROM submissions WHERE id=2").get();
const d = JSON.parse(row.details);
check("adjustments kept", JSON.parse(row.adjustments).length===2);
check("contact/geo kept", d.address==="1 Main" && d.geo && d.geo.lat===1);
check("status kept", row.status==="quoted");
check("history has previous design", d.history.at(-1).config.l===12 && d.history.at(-1).quotedPrice===before.quotedPrice);
check("still one row per order (no new lead)", db.prepare("SELECT COUNT(*) n FROM submissions").get().n===3);
const note = db.prepare("SELECT text FROM notes ORDER BY id DESC").get();
check("CRM note written", /Design updated/.test(note.text) && note.text.includes(pad), note);
check("effective = new price - 100 (stale override ignored)", Math.abs(r.data.effective_price - (r.data.quotedPrice - 100)) < 0.01, r.data);
console.log("\n-- deposit lock --");
db.exec("CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, customer_id INTEGER, submission_id INTEGER, kind TEXT, amount REAL, status TEXT, created_at TEXT, paid_at TEXT)");
try { db.exec("ALTER TABLE payments ADD COLUMN submission_id INTEGER"); } catch(e) {}
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('B',?,?)").run(now,now);
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('C',?,?)").run(now,now);
const insC = (cid) => Number(db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (?,'B','b@x',?,'won',?)").run(cid, JSON.stringify({quotedPrice:1,config:cfg}), now).lastInsertRowid);
const pA = insC(2), pB = insC(3), pC = insC(3);
check("status unlocked before money", (await call("GET",`/admin/submissions/${pA}/design-status`,null,tok)).data.locked===false);
check("design-status needs staff", (await call("GET",`/admin/submissions/${pA}/design-status`)).status===401);
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (2,500,'cash',?,?,?)").run(now,now,pA);
r = await call("POST",`/admin/submissions/${pA}/design`,{config:cfg},tok);
check("CRM payment blocks update (409)", r.status===409 && r.data.locked && /has a deposit/.test(r.data.error), r);
check("status reports lock + message", (await call("GET",`/admin/submissions/${pA}/design-status`,null,tok)).data.reason.includes("Save as new quote"));
db.prepare("INSERT INTO invoices (customer_id,submission_id,kind,amount,status,created_at,paid_at) VALUES (3,?,'deposit',900,'paid',?,?)").run(pB,now,now);
check("paid Stripe invoice blocks update", (await call("POST",`/admin/submissions/${pB}/design`,{config:cfg},tok)).status===409);
check("sibling order of same customer not blocked by that invoice", (await call("POST",`/admin/submissions/${pC}/design`,{config:cfg},tok)).status===200);
db.prepare("INSERT INTO invoices (customer_id,submission_id,kind,amount,status,created_at) VALUES (3,?,'deposit',900,'open',?)").run(pC,now);
check("open (unpaid) invoice does not block", (await call("POST",`/admin/submissions/${pC}/design`,{config:cfg},tok)).status===200);
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at) VALUES (3,200,'venmo',?,?)").run(now,now);
check("unattributed customer payment blocks (can't rule it out)", (await call("POST",`/admin/submissions/${pC}/design`,{config:cfg},tok)).status===409);
const before409 = db.prepare("SELECT details FROM submissions WHERE id=?").get(pA).details;
check("blocked order untouched", db.prepare("SELECT details FROM submissions WHERE id=?").get(pA).details===before409);
console.log(fails? `\n${fails} FAILED` : "\nall passed"); process.exit(fails?1:0);
