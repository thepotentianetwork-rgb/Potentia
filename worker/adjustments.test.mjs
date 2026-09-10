// Exercises the stackable quote adjustments: comps, percentages and flat
// amounts, the order they apply in, and that won revenue follows the result.
// Run: node --experimental-sqlite worker/adjustments.test.mjs
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
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('A',?,?)").run(now,now);
// A quote with real, comp-able lines
const redline = {
  trueTotalCost: 12000,
  addonLines: [{name:"Skylight", amt:184}, {name:"Cupola (Black Roof)", amt:600}],
  elecSell: 2300, elecSellName: "Core Electrical",
  intSell: 1500, intSellName: "Drywall & Mud",
  paintSell: 900, paintSellName: "Exterior Paint",
  shelfSellLines: [{label:'16" Shelf 8ft', price:120}]
};
db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (1,'A','a@x',?,?,?)")
  .run(JSON.stringify({quotedPrice:20000, config:{style:"gable",w:12,l:16}, redline}), "won", now);

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
const set = adj => call("POST","/admin/submissions/1/adjustments",{adjustments:adj},tok);

console.log("\n-- what can be comped --");
let r = await call("GET","/admin/customers/1",null,tok);
const items = r.data.submissions[0].comp_items;
const names = items.map(i=>i.name);
check("add-ons offered", names.includes("Skylight") && names.includes("Cupola (Black Roof)"), names);
check("named options offered", names.includes("Core Electrical") && names.includes("Drywall & Mud"), names);
check("shelf lines offered", names.includes('16" Shelf 8ft'), names);
check("exterior paint NOT offered — the quote never sums it", !names.includes("Exterior Paint"), names);
check("prices come with them", items.find(i=>i.name==="Skylight").amt===184, items);

console.log("\n-- comping a line --");
r = await set([{kind:"comp",item:"Cupola (Black Roof)"}]);
check("comp accepted", r.status===200, r);
check("effective price 20000-600", r.data.effective_price===19400, r.data.effective_price);
r = await set([{kind:"comp",item:"Gold Taps"}]);
check("comping something not on the quote is refused", r.status===400, r);

console.log("\n-- the order that matters --");
r = await set([{kind:"comp",item:"Cupola (Black Roof)"},{kind:"percent",value:-10}]);
check("comps then percent = 17,460", r.data.effective_price===17460, r.data.effective_price);
check("  (percent first would be 17,400)", r.data.effective_price!==17400);

console.log("\n-- stacking all three --");
r = await set([{kind:"comp",item:"Skylight"},{kind:"percent",value:-10},{kind:"amount",value:-250,note:"Goodwill"}]);
check("19,816 → −1,981.60 → −250 = 17,584.40", r.data.effective_price===17584.4, r.data.effective_price);

console.log("\n-- won revenue follows --");
r = await call("GET","/admin/analytics",null,tok);
check("revenue is the adjusted price", r.data.won.revenue===17584, r.data.won.revenue);
check("cost unchanged", r.data.won.cost===12000, r.data.won.cost);
check("margin reflects what was given away", r.data.won.marginPct===31.8, r.data.won.marginPct);

console.log("\n-- guards --");
r = await set([{kind:"percent",value:-150}]);
check("percent beyond -100 refused", r.status===400, r);
r = await set([{kind:"amount",value:0}]);
check("zero-value entry refused", r.status===400, r);
r = await set([{kind:"free-shed"}]);
check("unknown kind refused", r.status===400, r);
r = await call("POST","/admin/submissions/1/adjustments",{adjustments:[{kind:"amount",value:-1}]},null);
check("requires auth", r.status===401, r);

console.log("\n-- clearing --");
r = await set([]);
check("empty list clears", r.status===200 && r.data.effective_price===null, r.data);
r = await call("GET","/admin/analytics",null,tok);
check("revenue back to the quoted price", r.data.won.revenue===20000, r.data.won.revenue);

console.log("\n-- an older single-adjustment row still reads --");
db.prepare("UPDATE submissions SET price_adjustment=-2000, adjustment_note='Legacy', adjustments=NULL, effective_price=NULL WHERE id=1").run();
r = await call("GET","/admin/submissions/1",null,tok);
check("presented as a one-entry list", r.data.submission.adjustment_list.length===1
      && r.data.submission.adjustment_list[0].kind==="amount"
      && r.data.submission.adjustment_list[0].value===-2000, r.data.submission.adjustment_list);
r = await call("GET","/admin/analytics",null,tok);
check("still priced correctly at 18,000", r.data.won.revenue===18000, r.data.won.revenue);

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
