// Checks that pending-vs-installed is derived correctly from the install log.
// Run: node --experimental-sqlite worker/install.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db){
  function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
    return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); },
      all(){ return {results:st.all(...a)}; },
      run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a);
             return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; },
           async batch(st){ return st.map(x=>x.run()); } };
}
const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(":memory:")),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"c", ADMIN_SESSION_SECRET:"k" };
const now = new Date().toISOString();
const day = n => new Date(Date.now() + n*864e5).toISOString().slice(0,10);
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('A',?,?)").run(now,now);
function sub(price, status){
  db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
    .run(JSON.stringify({quotedPrice:price, config:{style:"gable",w:12,l:16}, redline:{trueTotalCost:price*0.6}}), status, now);
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
}
function install(subId, item, date){
  db.prepare("INSERT INTO installs (submission_id,item,install_date,created_at) VALUES (?,?,?,?)")
    .run(subId, item, date, now);
}
const a = sub(20000,"won");  install(a,"shed", day(-30));        // installed
const b = sub(30000,"won");  install(b,"shed", day(+7));         // scheduled
const c = sub(10000,"won");                                       // no date
const d = sub(15000,"won");  install(d,"concrete", day(-5));     // pad only
const e = sub(25000,"quoted");                                    // not won
const f = sub(40000,"won");  install(f,"shed", day(+21));        // scheduled, later

let fails=0;
const check=(n,cond,x)=>{ if(cond) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){
  const h={Origin:"https://potentianetwork.com"};
  if(b)h["Content-Type"]="application/json";
  if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;
const r = await call("GET","/admin/analytics",null,tok);
const i = r.data.install;

console.log("\n-- the three states --");
check("installed: past shed date", i.installed.count===1 && i.installed.revenue===20000, i.installed);
check("scheduled: future shed date", i.scheduled.count===2 && i.scheduled.revenue===70000, i.scheduled);
check("awaiting a date: won, nothing logged", i.unscheduled.count===2, i.unscheduled);

console.log("\n-- the distinctions that matter --");
check("a poured pad alone is NOT installed", i.installed.count===1, {installed:i.installed.count});
check("  ...it counts as awaiting a date", i.unscheduled.revenue===25000, i.unscheduled.revenue);
check("a quoted job is not counted at all", i.installed.count+i.scheduled.count+i.unscheduled.count===5, i);

console.log("\n-- pending totals --");
check("pending = scheduled + awaiting", i.pendingCount===4, i.pendingCount);
check("pending revenue = 70000 + 25000", i.pendingRevenue===95000, i.pendingRevenue);
check("next install is the SOONEST", i.nextInstall===day(+7), {got:i.nextInstall, want:day(+7)});

console.log("\n-- everything won is accounted for --");
check("counts add up to the won total",
  i.installed.count+i.scheduled.count+i.unscheduled.count === r.data.won.count, {i, won:r.data.won.count});
check("revenue adds up to won revenue",
  i.installed.revenue+i.scheduled.revenue+i.unscheduled.revenue === r.data.won.revenue,
  {sum:i.installed.revenue+i.scheduled.revenue+i.unscheduled.revenue, won:r.data.won.revenue});

console.log("\n-- logging an install moves it --");
await call("POST","/admin/submissions/"+c+"/installs",{item:"shed",install_date:day(-1)},tok);
const r2 = await call("GET","/admin/analytics",null,tok);
check("now installed", r2.data.install.installed.count===2, r2.data.install.installed);
check("pending dropped by that job", r2.data.install.pendingRevenue===85000, r2.data.install.pendingRevenue);

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
