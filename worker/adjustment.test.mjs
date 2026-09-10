// Exercises the per-quote price adjustment: the endpoint, its guards, and that
// won revenue and margin follow the adjusted price rather than the original.
// Run: node --experimental-sqlite worker/adjustment.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db) {
  function shape(sql) {
    const stmt = db.prepare(sql);
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first(){ return isSelect ? (stmt.get(...args) ?? null) : (stmt.run(...args), null); },
      all(){ return { results: stmt.all(...args) }; },
      run(){ if(isSelect) return { results: stmt.all(...args) };
             const r=stmt.run(...args); return { meta:{ last_row_id:Number(r.lastInsertRowid), changes:Number(r.changes) } }; }
    });
  }
  return { prepare(sql){ const m=shape(sql); return { ...m([]), bind:(...a)=>m(a) }; },
           async batch(st){ return st.map(s=>s.run()); } };
}
const shedDb = new DatabaseSync(":memory:");
shedDb.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env = { DB: makeD1(shedDb), CRM_DB: makeD1(new DatabaseSync(":memory:")),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"c", ADMIN_SESSION_SECRET:"k" };
const now = new Date().toISOString();
shedDb.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('A',?,?)").run(now, now);
shedDb.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
  .run(JSON.stringify({quotedPrice:20000, config:{style:"gable",w:12,l:16}, redline:{trueTotalCost:12000}}), "won", now);

let fails=0;
const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){
  const h={Origin:"https://potentianetwork.com"};
  if(b)h["Content-Type"]="application/json";
  if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;

console.log("\n-- setting an adjustment --");
let r = await call("GET","/admin/analytics",null,tok);
check("won revenue starts at the quoted price", r.data.won.revenue===20000, r.data.won.revenue);
check("margin before any discount", r.data.won.marginPct===40, r.data.won.marginPct);

r = await call("POST","/admin/submissions/1/adjustment",{amount:-2000,note:"Repeat customer discount"},tok);
check("discount applied", r.status===200 && r.data.amount===-2000, r);

r = await call("GET","/admin/submissions/1",null,tok);
check("stored on the submission", r.data.submission.price_adjustment===-2000, r.data.submission.price_adjustment);
check("note stored", r.data.submission.adjustment_note==="Repeat customer discount", r.data.submission.adjustment_note);
check("original quote untouched", JSON.parse(r.data.submission.details).quotedPrice===20000, "quotedPrice changed");

console.log("\n-- the discount comes out of profit, not thin air --");
r = await call("GET","/admin/analytics",null,tok);
check("won revenue now 18000", r.data.won.revenue===18000, r.data.won.revenue);
check("cost unchanged — the build costs the same", r.data.won.cost===12000, r.data.won.cost);
check("gross profit 18000-12000", r.data.won.grossProfit===6000, r.data.won.grossProfit);
check("margin fell 40% -> 33.3%", r.data.won.marginPct===33.3, r.data.won.marginPct);
check("discounts given are reported", r.data.won.adjustedWonTotal===-2000, r.data.won.adjustedWonTotal);

console.log("\n-- guards --");
r = await call("POST","/admin/submissions/1/adjustment",{amount:-50000},tok);
check("discount bigger than the quote rejected", r.status===400, r);
r = await call("POST","/admin/submissions/1/adjustment",{amount:"lots"},tok);
check("non-numeric rejected", r.status===400, r);
r = await call("POST","/admin/submissions/999/adjustment",{amount:-100},tok);
check("unknown submission 404s", r.status===404, r);
r = await call("POST","/admin/submissions/1/adjustment",{amount:-100},null);
check("requires auth", r.status===401, r);

console.log("\n-- surcharge and clearing --");
r = await call("POST","/admin/submissions/1/adjustment",{amount:1500,note:"Long haul delivery"},tok);
check("surcharge accepted", r.status===200, r);
r = await call("GET","/admin/analytics",null,tok);
check("won revenue 21500", r.data.won.revenue===21500, r.data.won.revenue);
r = await call("POST","/admin/submissions/1/adjustment",{amount:null},tok);
check("cleared", r.status===200 && r.data.amount===null, r);
r = await call("GET","/admin/analytics",null,tok);
check("back to the quoted price", r.data.won.revenue===20000, r.data.won.revenue);

console.log("\n-- it only touches THIS quote --");
shedDb.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
  .run(JSON.stringify({quotedPrice:30000, config:{style:"barn",w:14,l:20}, redline:{trueTotalCost:20000}}), "won", now);
await call("POST","/admin/submissions/1/adjustment",{amount:-2000,note:"Discount"},tok);
r = await call("GET","/admin/submissions/2",null,tok);
check("the other quote has no adjustment", r.data.submission.price_adjustment===null, r.data.submission.price_adjustment);
r = await call("GET","/admin/analytics",null,tok);
check("revenue = 18000 + 30000", r.data.won.revenue===48000, r.data.won.revenue);

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
