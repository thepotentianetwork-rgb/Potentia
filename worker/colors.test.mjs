// Colour-only edit of a saved quote: no re-price, adjustments untouched, works with a deposit.
// Run: node --experimental-sqlite worker/colors.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
import { quoteLines } from "./quotelines.js";
import { applyColorEdit } from "./colors.js";
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
let fails=0; const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){ const h={Origin:"https://potentianetwork.com"}; if(b)h["Content-Type"]="application/json"; if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env); return {status:res.status,data:await res.json().catch(()=>null)}; }
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;

db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('Lee',?,?)").run(now,now);
const fx = JSON.parse(fs.readFileSync(path.join(here,"fixtures","q71-like.json"),"utf8"));
await call("POST","/admin/submissions/1/adjustments",{adjustments:[]},tok); // let the worker add its columns
db.prepare("INSERT INTO submissions (id,customer_id,name,email,details,status,created_at) VALUES (71,1,'Lee','l@x',?,?,?)").run(fx.details,"quoted",now);
await call("GET","/admin/submissions/71/design-status",null,tok);
db.prepare("UPDATE submissions SET adjustments=?, effective_price=? WHERE id=71").run(fx.adjustments, fx.effective_price);
const totals = () => { const r=db.prepare("SELECT details,adjustments,effective_price FROM submissions WHERE id=71").get();
  const d=JSON.parse(r.details); const b=quoteLines(d.redline, JSON.parse(r.adjustments));
  return { d, adj:r.adjustments, eff:r.effective_price, total:b.total.toFixed(2), cash:b.cashDiscount?b.cashDiscount.cashTotal.toFixed(2):null,
    phases:b.rows.map(x=>[x.label,x.amt]), redline:JSON.stringify(d.redline), qp:d.quotedPrice }; };
const before = totals();
console.log("#71-like row");
check("fixture total is $18,151.27", before.total === "18151.27", before.total);

// A deposit on the order: Update-this-quote is locked, colours are not.
try { db.exec("ALTER TABLE payments ADD COLUMN submission_id INTEGER"); } catch(e) {}
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,1000,'cash',?,?,71)").run(now,now);
const lock = await call("POST","/admin/submissions/71/design",{config:before.d.config},tok);
check("design update refused with a deposit (409)", lock.status === 409, lock.status);

const r = await call("POST","/admin/submissions/71/colors",{colors:{ sidingColor:0x2f4f4f, trimColor:0xffffff, roofColor:0x3a3a3a, soffit:"white",
  paint:{ siding:{brand:"Sherwin-Williams",code:"SW 6244",name:"Naval",hex:"#2F3D4C"} }, colorNames:{siding:"Sherwin-Williams SW 6244 Naval", trim:"White"} }},tok);
check("colour edit accepted with a deposit (200)", r.status === 200, r);
const after = totals();
check("config colours changed", after.d.config.sidingColor===0x2f4f4f && after.d.config.trimColor===0xffffff && after.d.config.soffit==="white" && after.d.config.paint.siding.code==="SW 6244");
check("old trim paint kept", after.d.config.paint.trim && after.d.config.paint.trim.code==="SW 7073");
check("total unchanged $18,151.27", after.total === before.total, after.total);
check("cash total unchanged", after.cash === before.cash, after.cash);
check("phase amounts unchanged", JSON.stringify(after.phases) === JSON.stringify(before.phases), after.phases);
check("redline byte-identical", after.redline === before.redline);
check("quotedPrice unchanged", after.qp === before.qp);
check("adjustments byte-identical (pad override kept)", after.adj === before.adj && /"override"/.test(after.adj));
check("effective_price unchanged", after.eff === before.eff, after.eff);
const strip = (c)=>{ const y={...c}; ["sidingColor","trimColor","roofColor","soffit","paint","colorNames"].forEach(k=>delete y[k]); return JSON.stringify(y); };
check("every non-colour config field identical", strip(after.d.config) === strip(before.d.config));
check("previous design kept in history", after.d.history.at(-1).kind === "colors" && after.d.history.at(-1).config.sidingColor === before.d.config.sidingColor);
check("CRM note written", !!db.prepare("SELECT 1 FROM notes WHERE text LIKE 'Colours changed on quote #71%'").get());

console.log("refusals");
const bad1 = await call("POST","/admin/submissions/71/colors",{colors:{ addons:{houseWrap:true} }},tok);
check("non-colour key refused", bad1.status === 400, bad1);
const bad2 = await call("POST","/admin/submissions/71/colors",{colors:{ sidingColor:"red" }},tok);
check("bad colour refused", bad2.status === 400);
const bad3 = await call("POST","/admin/submissions/71/colors",{colors:{ soffit:"pine" }},tok);
check("bad soffit refused", bad3.status === 400);
const noauth = await call("POST","/admin/submissions/71/colors",{colors:{ trimColor:1 }});
check("needs staff login", noauth.status === 401);
check("refusals left the row alone", totals().adj === before.adj && totals().d.config.trimColor === 0xffffff);
check("pure fn: door colours not accepted", !!applyColorEdit({doors:[]}, {doors:[{color:"red"}]}).error);

console.log(fails ? fails+" FAILED" : "ALL PASS"); process.exit(fails?1:0);
