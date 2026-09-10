// Exercises the won-projects analytics on both CRMs against SQLite stand-ins
// for the two D1 bindings, with the arithmetic checked against hand-computed
// figures.  Run: node --experimental-sqlite worker/won.test.mjs
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
      first() { return isSelect ? (stmt.get(...args) ?? null) : (stmt.run(...args), null); },
      all() { return { results: stmt.all(...args) }; },
      run() {
        if (isSelect) return { results: stmt.all(...args) };
        const r = stmt.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql){ const m=shape(sql); return { ...m([]), bind:(...a)=>m(a) }; },
           async batch(st){ return st.map(s=>s.run()); } };
}

const shedDb = new DatabaseSync(":memory:");
shedDb.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
const crmDb = new DatabaseSync(":memory:");
const env = { DB: makeD1(shedDb), CRM_DB: makeD1(crmDb),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"cpw", ADMIN_SESSION_SECRET:"k" };

const now = new Date().toISOString();
shedDb.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES (?,?,?)").run("A", now, now);
function sub(status, price, cost, style, w, l, createdDaysAgo) {
  const created = new Date(Date.now() - createdDaysAgo*864e5).toISOString();
  const details = JSON.stringify({ quotedPrice: price, config:{ style, w, l },
                                   redline: cost != null ? { trueTotalCost: cost } : undefined });
  shedDb.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
    .run(details, status, created);
}
// three won (two with cost data), two lost, one open
sub("won",  20000, 12000, "gable", 12, 16, 60);
sub("won",  30000, 21000, "barn",  14, 20, 50);
sub("won",  10000, null,  "gable", 10, 12, 40);
sub("lost", 15000, 9000,  "leanto",10, 14, 30);
sub("lost", 25000, null,  "gable", 12, 20, 25);
sub("quoted", 18000, 11000, "gable", 12, 16, 5);
shedDb.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at) VALUES (1,?,?,?,?)")
  .run(15000, "check", now.slice(0,10), now);

let fails = 0;
const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(method,p,body,tok){
  const h={Origin:"https://potentianetwork.com"};
  if(body)h["Content-Type"]="application/json";
  if(tok)h.Authorization="Bearer "+tok;
  const res=await worker.fetch(new Request("https://x"+p,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const shedTok=(await call("POST","/admin/login",{password:"pw"})).data.token;
const crmTok =(await call("POST","/crm/login",{password:"cpw"})).data.token;

console.log("\n-- ShedPro won data --");
let r = await call("GET","/admin/analytics",null,shedTok);
const w = r.data.won;
check("won count", w.count===3, w.count);
check("won revenue = 20k+30k+10k", w.revenue===60000, w.revenue);
check("cost only over jobs that HAVE cost data", w.cost===33000 && w.costKnown===2, {cost:w.cost, known:w.costKnown});
check("gross profit = 60000-33000", w.grossProfit===27000, w.grossProfit);
check("margin % = 27000/60000", w.marginPct===45, w.marginPct);
check("avg won value", w.avgValue===20000, w.avgValue);
check("median won value", w.medianValue===20000, w.medianValue);
check("lost counted", w.lostCount===2 && w.lostRevenue===40000, {c:w.lostCount, r:w.lostRevenue});
check("win rate over DECIDED only (3 of 5)", w.winRatePct===60, w.winRatePct);
check("open job excluded from the rate", w.decided===5, w.decided);
check("won by style", w.byStyle.gable===2 && w.byStyle.barn===1, w.byStyle);
check("lost by style kept separate", w.lostByStyle.leanto===1, w.lostByStyle);
check("collected all time", w.collectedAllTime===15000, w.collectedAllTime);

console.log("\n-- won_at: historical rows stay undated --");
check("all three wins are undated so far", w.undated===3 && w.dated===0, {d:w.dated,u:w.undated});
check("no median days-to-win invented", w.medianDaysToWin===null, w.medianDaysToWin);

r = await call("POST","/admin/submissions/status",{id:6,status:"won"},shedTok);
check("marking a job won stamps won_at", r.status===200, r);
r = await call("GET","/admin/analytics",null,shedTok);
check("now one dated win", r.data.won.dated===1, {d:r.data.won.dated,u:r.data.won.undated});
check("days-to-win computed from the real dates", r.data.won.medianDaysToWin===5, r.data.won.medianDaysToWin);
check("it appears in byMonth", Object.keys(r.data.won.byMonth).length===1, r.data.won.byMonth);

r = await call("POST","/admin/submissions/status",{id:6,status:"quoted"},shedTok);
r = await call("GET","/admin/analytics",null,shedTok);
check("moving it back OUT of won clears the date", r.data.won.dated===0, r.data.won.dated);

console.log("\n-- Potentia won data --");
async function mkClient(fields){ return (await call("POST","/crm/clients",fields,crmTok)).data.id; }
await mkClient({business_name:"Live One", status:"live", source:"referral", package:"operator", build_fee:2400, monthly_fee:150, launched_at:"2026-08-15"});
await mkClient({business_name:"Building One", status:"building", source:"website", package:"gallery", build_fee:1800, monthly_fee:100});
await mkClient({business_name:"Paused One", status:"paused", source:"referral", build_fee:3000, monthly_fee:200});
await mkClient({business_name:"Lost One", status:"lost", source:"website", build_fee:1200});
await mkClient({business_name:"Just A Lead", status:"lead", source:"instagram"});

r = await call("GET","/crm/analytics",null,crmTok);
const cw = r.data.won;
check("won = building + live only", cw.count===2, cw.count);
check("paused excluded from won", r.data.byStatus.paused===1 && cw.count===2, r.data.byStatus);
check("build revenue 2400+1800", cw.buildRevenue===4200, cw.buildRevenue);
check("MRR 150+100", cw.mrr===250, cw.mrr);
check("annualised recurring", cw.annualisedRecurring===3000, cw.annualisedRecurring);
check("avg build fee", cw.avgBuildFee===2100, cw.avgBuildFee);
check("win rate 2 of 3 decided", cw.winRatePct===66.7, cw.winRatePct);
check("lead not counted as decided", cw.decided===3, cw.decided);
check("won by source", cw.bySource.referral===1 && cw.bySource.website===1, cw.bySource);
check("only the launched client is on the timeline", Object.keys(cw.byMonth).length===1, cw.byMonth);
check("build outstanding with nothing collected", cw.buildOutstanding===4200, cw.buildOutstanding);

r = await call("GET","/crm/analytics",null,shedTok);
check("shed token cannot read CRM analytics", r.status===401, r.status);

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails?1:0);
