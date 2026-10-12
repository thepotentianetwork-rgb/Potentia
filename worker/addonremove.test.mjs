// Remove an add-on from a saved quote (CRM x) via the update-design path.
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


// Remove one add-on from a saved quote (CRM x), through the "Update this quote" path.
const cfgA = {style:"gable",w:10,l:12,foundation:"pad",addons:{shutters:true,ridgeVent:true,cupola:"black"},sprinklers:[5,8]};
ins(cfgA);
let r = await call("POST","/admin/submissions/1/design",{config:cfgA},tok); check("priced with add-ons", r.status===200, r);
const p0 = r.data.quotedPrice;
const names = () => JSON.parse(db.prepare("SELECT details FROM submissions WHERE id=1").get().details).redline.addonLines.map(l=>l.name);
check("lines present", names().some(n=>n==="Shutters") && names().some(n=>/^Cupola/.test(n)) && names().some(n=>/^Sprinkler/.test(n)), names());
await call("POST","/admin/submissions/1/adjustments",{adjustments:[{kind:"comp",item:"Shutters"},{kind:"amount",value:-50,note:"x"}]},tok);
check("needs staff", (await call("POST","/admin/submissions/1/design",{removeAddon:"Shutters"})).status===401);
r = await call("POST","/admin/submissions/1/design",{removeAddon:"Shutters"},tok);
check("remove Shutters ok", r.status===200 && r.data.removed==="Shutters", r);
check("price drops", r.data.quotedPrice < p0, [p0, r.data.quotedPrice]);
check("comp on Shutters flagged stale", r.data.stale.some(a=>a.item==="Shutters"), r.data.stale);
let d = JSON.parse(db.prepare("SELECT details, adjustments FROM submissions WHERE id=1").get().details);
check("saved design has shutters off (3D follows)", d.config.addons.shutters===false && d.config.addons.ridgeVent===true, d.config.addons);
check("permalink cleared so the CRM re-encodes the new config", d.permalink===null);
check("history kept", d.history.length===2 && d.history[1].config.addons.shutters===true);
check("adjustments kept", JSON.parse(db.prepare("SELECT adjustments FROM submissions WHERE id=1").get().adjustments).length===2);
check("CRM note", /Add-on removed.*Shutters/.test(db.prepare("SELECT text FROM notes ORDER BY id DESC").get().text));
r = await call("POST","/admin/submissions/1/design",{removeAddon:names().find(n=>/^Cupola/.test(n))},tok);
check("cupola -> none", r.status===200 && JSON.parse(db.prepare("SELECT details FROM submissions WHERE id=1").get().details).config.addons.cupola==="none");
r = await call("POST","/admin/submissions/1/design",{removeAddon:names().find(n=>/^Sprinkler/.test(n))},tok);
check("sprinklers cleared", r.status===200 && JSON.parse(db.prepare("SELECT details FROM submissions WHERE id=1").get().details).config.sprinklers.length===0);
check("not on quote -> 400", (await call("POST","/admin/submissions/1/design",{removeAddon:"Shutters"},tok)).status===400);
check("non add-on line -> 400", (await call("POST","/admin/submissions/1/design",{removeAddon:"Concrete Pad"},tok)).status===400);
db.exec("CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, customer_id INTEGER, submission_id INTEGER, kind TEXT, amount REAL, status TEXT, created_at TEXT, paid_at TEXT)");
try { db.exec("ALTER TABLE payments ADD COLUMN submission_id INTEGER"); } catch(e) {}
const before = db.prepare("SELECT details FROM submissions WHERE id=1").get().details;
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,500,'cash',?,?,1)").run(now,now);
r = await call("POST","/admin/submissions/1/design",{removeAddon:names().find(n=>/^Roof Ridge Vent/.test(n))},tok);
check("deposit blocks removal (409)", r.status===409 && r.data.locked, r);
check("blocked order untouched", db.prepare("SELECT details FROM submissions WHERE id=1").get().details===before);
console.log(fails? `\n${fails} FAILED` : "\nall passed"); process.exit(fails?1:0);
