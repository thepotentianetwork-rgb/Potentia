// CRM brand paint colours (crm-paint.js) saved through the colours-only endpoint.
// Run: node --experimental-sqlite worker/brandcolors.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import worker from "./index.js";
import { quoteLines } from "./quotelines.js";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CrmPaint = require("../crm-paint.js");
let fails=0; const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };

console.log("crm-paint.js");
// The designer's list (paint-codes.js BRANDS on Shed-Pro-Website), order matters for ranking.
check("same brands, same order as the designer", JSON.stringify(CrmPaint.BRANDS.map(b=>[b.b,b.brand])) === JSON.stringify(
  [["sw","Sherwin-Williams"],["bm","Benjamin Moore"],["behr","Behr"],["valspar","Valspar"],["ppg","PPG / Glidden"],["de","Dunn-Edwards"]]));
check("reads the designer's colour books", CrmPaint.BASE === "https://www.shedpro-utah.com/paint-colors/");
const sample = JSON.parse(fs.readFileSync(path.join(here,"fixtures","paint-sample.json"),"utf8"));
Object.keys(sample).forEach(b => CrmPaint.setData(b, sample[b]));
const ng = CrmPaint.search("SW 7073")[0];
check("code search: SW 7073 Network Gray", ng && ng.name === "Network Gray" && ng.brand === "Sherwin-Williams", ng);
check("pick shape = designer's {brand,code,name,hex:'#RRGGBB'}", JSON.stringify(Object.keys(ng)) === '["brand","code","name","hex"]' && /^#[0-9A-F]{6}$/.test(ng.hex));
check("label = designer's 'Brand CODE Name'", CrmPaint.label(ng) === "Sherwin-Williams SW 7073 Network Gray");
check("name search: 'network gray'", CrmPaint.search("network gray")[0].code === "SW 7073");
check("brand + name: 'behr ultra pure white'", CrmPaint.search("behr ultra pure white").every(p => p.brand === "Behr") && CrmPaint.search("behr ultra pure white").length > 0);
check("bare code digits: '7006'", CrmPaint.search("7006")[0].code === "SW 7006");
check("brand word alone returns nothing", CrmPaint.search("sw").length === 0);

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
async function call(m,p,b,t){ const h={Origin:"https://potentianetwork.com"}; if(b)h["Content-Type"]="application/json"; if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env); return {status:res.status,data:await res.json().catch(()=>null)}; }
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('Lee',?,?)").run(now,now);
const fx = JSON.parse(fs.readFileSync(path.join(here,"fixtures","q71-like.json"),"utf8"));
await call("POST","/admin/submissions/1/adjustments",{adjustments:[]},tok);
db.prepare("INSERT INTO submissions (id,customer_id,name,email,details,status,created_at) VALUES (71,1,'Lee','l@x',?,?,?)").run(fx.details,"quoted",now);
await call("GET","/admin/submissions/71/design-status",null,tok);
db.prepare("UPDATE submissions SET adjustments=?, effective_price=? WHERE id=71").run(fx.adjustments, fx.effective_price);
try { db.exec("ALTER TABLE payments ADD COLUMN submission_id INTEGER"); } catch(e) {}
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,1000,'cash',?,?,71)").run(now,now);
const row = () => db.prepare("SELECT details,adjustments,effective_price FROM submissions WHERE id=71").get();
const total = (r) => { const d=JSON.parse(r.details); const b=quoteLines(d.redline, JSON.parse(r.adjustments)); return { t:b.total.toFixed(2), c:b.cashDiscount.cashTotal.toFixed(2), ph:JSON.stringify(b.rows.map(x=>x.amt)) }; };
const before = row(), tb = total(before);

console.log("#71-like row, brand picks (order has a deposit)");
check("before: $18,151.27", tb.t === "18151.27", tb.t);
const sidingPick = CrmPaint.search("SW 6244")[0], trimPick = CrmPaint.search("SW 7006")[0];
// Exactly what the CRM Colours row sends.
const colors = { soffit:"trim", sidingColor:CrmPaint.hexInt(sidingPick), trimColor:CrmPaint.hexInt(trimPick),
  paint:{ siding:sidingPick, trim:trimPick }, colorNames:{ siding:CrmPaint.label(sidingPick), trim:CrmPaint.label(trimPick) } };
const r = await call("POST","/admin/submissions/71/colors",{colors},tok);
check("saved (200) despite the deposit", r.status === 200, r);
const after = row(), ta = total(after), c = JSON.parse(after.details).config;
check("sidingColor = SW 6244 hex as int", c.sidingColor === parseInt(sidingPick.hex.slice(1),16));
check("config.paint.siding stored as the designer stores it", JSON.stringify(c.paint.siding) === JSON.stringify(sidingPick), c.paint.siding);
check("config.paint.trim = SW 7006", c.paint.trim.code === "SW 7006" && c.paint.trim.hex === trimPick.hex);
check("colorNames 'Sherwin-Williams SW 6244 Naval'", c.colorNames.siding === "Sherwin-Williams SW 6244 Naval", c.colorNames);
check("roof name kept", c.colorNames.roof === "Black Asphalt");
check("designer restore rule holds (paint hex == colour int)", parseInt(c.paint.siding.hex.slice(1),16)===c.sidingColor && parseInt(c.paint.trim.hex.slice(1),16)===c.trimColor);
check("total unchanged $18,151.27", ta.t === "18151.27" && ta.t === tb.t, ta.t);
check("cash total + phases unchanged", ta.c === tb.c && ta.ph === tb.ph);
check("adjustments byte-identical (pad override kept)", after.adjustments === before.adjustments);
check("effective_price unchanged", after.effective_price === before.effective_price);
check("redline + quotedPrice unchanged", JSON.stringify(JSON.parse(after.details).redline) === JSON.stringify(JSON.parse(before.details).redline) && JSON.parse(after.details).quotedPrice === JSON.parse(before.details).quotedPrice);

console.log("refusals");
const bad = await call("POST","/admin/submissions/71/colors",{colors:{ sidingColor:0x123456, paint:{siding:sidingPick} }},tok);
check("brand paint that is not the colour is refused", bad.status === 400, bad);
const bad2 = await call("POST","/admin/submissions/71/colors",{colors:{ paint:{trim:{brand:"Behr",name:"x",hex:"#zz"}} }},tok);
check("malformed brand paint refused", bad2.status === 400);
check("row untouched by refusals", row().details === after.details);

console.log(fails ? fails+" FAILED" : "ALL PASS"); process.exit(fails?1:0);
