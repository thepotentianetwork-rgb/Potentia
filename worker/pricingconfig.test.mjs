/* The pricing dashboard must show every price the quote engine will actually
   charge. Run: node --experimental-sqlite worker/pricingconfig.test.mjs */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
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
const db=new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env={DB:makeD1(db),CRM_DB:makeD1(new DatabaseSync(":memory:")),
           ADMIN_PASSWORD:"pw",CRM_PASSWORD:"c",ADMIN_SESSION_SECRET:"k"};
let fails=0;
const ck=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
const tok=await (await worker.fetch(new Request("https://x/admin/login",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json"},
  body:JSON.stringify({password:"pw"})}),env)).json();
const H={Origin:"https://shedpro-utah.com","Content-Type":"application/json",
         Authorization:"Bearer "+tok.token,"CF-Connecting-IP":"5.5.5.5"};
const getCfg = async () => (await worker.fetch(new Request("https://x/shed/pricing-config",{headers:H}),env)).json();
const saveCfg = async c => (await worker.fetch(new Request("https://x/shed/pricing-config",{method:"POST",headers:H,body:JSON.stringify(c)}),env)).json();
const quote = async cfg => (await (await worker.fetch(new Request("https://x/shed/quote",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json","CF-Connecting-IP":"5.5.5.5"},
  body:JSON.stringify({config:cfg})}),env)).json()).total;

const SHED={style:"gable",w:10,l:16,h:9};
const withAddon = a => Object.assign({}, SHED, {addons:a});

console.log("\n-- the dashboard shows nothing at all until something is saved --");
let cfg=await getCfg();
ck("a fresh install still lists the shipped prices",
   !!(cfg.SELL && cfg.SELL.options && cfg.SELL.options.flat && cfg.SELL.options.flat["Shed Removal"]!=null),
   Object.keys(cfg.SELL&&cfg.SELL.options&&cfg.SELL.options.flat||{}).slice(0,6));

/* THE BUG. A dashboard snapshot is written whenever the owner saves. Any price
   ADDED to pricing.js afterwards is charged by the quote engine — which layers
   the snapshot on top of the shipped defaults — but was never in the snapshot,
   and the editor only ever rendered the snapshot. So the owner could be
   charging for something they could not see or change. */
console.log("\n-- an old snapshot, saved before those two items existed --");
const old = { baseSheets:{}, SELL:{ options:{ flat:{ "Shutters": 60, "Skylight": 184 } } } };
await saveCfg(old);
const base=await quote(SHED);
const shed=await quote(withAddon({shedRemoval:true}));
const conc=await quote(withAddon({concreteRemoval:true}));
ck("the quote still charges $1,000 to remove a shed", Math.round(shed-base)===1000, Math.round(shed-base));
ck("and $500 to remove concrete", Math.round(conc-base)===500, Math.round(conc-base));
cfg=await getCfg();
const flat=(cfg.SELL&&cfg.SELL.options&&cfg.SELL.options.flat)||{};
ck("...and the dashboard lists Shed Removal, so it can be changed",
   flat["Shed Removal"]===1000, flat);
ck("...and Concrete Removal", flat["Concrete Removal"]===500, flat);
ck("the owner's own edits still win over the shipped price",
   flat["Shutters"]===60, flat["Shutters"]);
ck("and every other shipped price is there to edit too",
   flat["Stairs"]!=null && flat["Roof Ridge Vent"]!=null, Object.keys(flat).length);

console.log("\n-- a price the owner sets is what the customer pays --");
const edited=JSON.parse(JSON.stringify(cfg));
edited.SELL.options.flat["Shed Removal"]=1234;
await saveCfg(edited);
const shed2=await quote(withAddon({shedRemoval:true}));
ck("changing it in the dashboard changes the quote", Math.round(shed2-(await quote(SHED)))===1234,
   Math.round(shed2-base));
const back=await getCfg();
ck("and it reads back as what was set",
   back.SELL.options.flat["Shed Removal"]===1234, back.SELL.options.flat["Shed Removal"]);

console.log("\n-- Remove has to mean something --");
/* It used to delete the key from the snapshot only. The quote engine layers the
   snapshot OVER the defaults and never deletes, so the item carried on being
   charged at its shipped price: the button hid a row and changed no money. */
const del=JSON.parse(JSON.stringify(back));
del.SELL.options.flat["Shed Removal"]=null;          // how the editor marks a removal now
await saveCfg(del);
const shed3=await quote(withAddon({shedRemoval:true}));
ck("a removed option stops being charged", Math.round(shed3-(await quote(SHED)))===0,
   Math.round(shed3-base));
const after=await getCfg();
ck("and stays gone from the dashboard rather than springing back",
   after.SELL.options.flat["Shed Removal"]===undefined,
   after.SELL.options.flat["Shed Removal"]);
ck("without taking anything else with it",
   after.SELL.options.flat["Concrete Removal"]===500, after.SELL.options.flat["Concrete Removal"]);

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
