// Covers /shed/consult — the "talk to a designer" lead that arrives before a
// design is finished — and the field-preservation fix in findOrCreateCustomer
// that consult requests made reachable.
// Run: node --experimental-sqlite worker/consult.test.mjs
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

let fails=0;
const check=(n,cond,x)=>{ if(cond) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){
  const h={Origin:"https://potentianetwork.com"};
  if(b)h["Content-Type"]="application/json";
  if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const row = id => db.prepare("SELECT * FROM customers WHERE id=?").get(id);
const subs = () => db.prepare("SELECT * FROM submissions ORDER BY id").all();
const detailsOf = s => JSON.parse(s.details);

console.log("\n-- validation: phone is the required field, email is not --");
check("no name is rejected",
  (await call("POST","/shed/consult",{phone:"4355550101"})).status===400);
check("no phone is rejected",
  (await call("POST","/shed/consult",{name:"Dana"})).status===400);
check("a short phone is rejected",
  (await call("POST","/shed/consult",{name:"Dana",phone:"555"})).status===400);
check("name + phone alone is ACCEPTED (email optional)",
  (await call("POST","/shed/consult",{name:"Dana",phone:"(435) 555-0101"})).status===200);

console.log("\n-- what gets stored --");
let s = subs();
check("one submission was created", s.length===1, s.length);
check("it is flagged as a consult", detailsOf(s[0]).consult===true);
check("status is new, so it lands in the New count", s[0].status==="new", s[0].status);
// submissions.email is NOT NULL in the schema, so an absent email is "".
check("email stores as empty, satisfying the NOT NULL column", s[0].email==="", JSON.stringify(s[0].email));
check("the customer row keeps email null, not empty", row(1).email===null, row(1).email);
check("a customer record was created", !!row(1), row(1));
check("  matched later by phone", row(1).phone==="(435) 555-0101", row(1).phone);

console.log("\n-- the call-back context --");
await call("POST","/shed/consult",{
  name:"Rene", phone:"4355550202", bestTime:"Evening (5-8pm)",
  question:"Will a 12x20 fit two ATVs?", step:"Pick your size", stepIndex:1,
  trigger:"nudge", config:{style:"gable",w:12,l:20}
});
const d = detailsOf(subs()[1]);
check("best time is kept", d.bestTime==="Evening (5-8pm)", d.bestTime);
check("their question is kept", /two ATVs/.test(d.question||""), d.question);
check("the step they were on is kept", d.step==="Pick your size", d.step);
check("the trigger is kept", d.trigger==="nudge", d.trigger);
check("the partial design is kept", d.config && d.config.l===20, d.config);
check("an estimate was priced from it", typeof d.estimateAtRequest==="number" && d.estimateAtRequest>0, d.estimateAtRequest);

console.log("\n-- an unknown trigger cannot be injected --");
await call("POST","/shed/consult",{name:"Sam",phone:"4355550303",trigger:"<script>"});
check("anything but 'nudge' is recorded as 'button'", detailsOf(subs()[2]).trigger==="button", detailsOf(subs()[2]).trigger);

console.log("\n-- nothing designed yet means NO estimate, not a default one --");
// The pricing engine never throws. Give it the untouched step-1 defaults and it
// happily prices a default 8x12 at ~$5,000, so without the stepIndex guard a
// visitor who chose nothing at all would appear in the admin list as a build
// in progress. Showing nothing is correct; showing $5,034 is a lie.
await call("POST","/shed/consult",{name:"Kit",phone:"4355550404",
  stepIndex:0, step:"What's it for?", config:{style:"gable",w:8,l:12}});
const kit = subs()[3];
check("the lead was still stored", !!kit && kit.name==="Kit");
check("  with no estimate", detailsOf(kit).estimateAtRequest===null, detailsOf(kit).estimateAtRequest);
check("  and no config passed off as their design", detailsOf(kit).config===null, detailsOf(kit).config);
check("  but we still know where they stalled", detailsOf(kit).step==="What's it for?", detailsOf(kit).step);

console.log("\n-- a garbage config cannot smuggle in a default price either --");
await call("POST","/shed/consult",{name:"Lee",phone:"4355550606",stepIndex:4,config:"nonsense"});
const lee = subs()[4];
check("the lead was stored", !!lee && lee.name==="Lee");
// stepIndex says engaged, so this one IS priced — the guard is about intent,
// not validation. Recorded here so the behaviour is deliberate, not a surprise.
check("  a claimed step prices whatever config came with it",
  typeof detailsOf(lee).estimateAtRequest==="number", detailsOf(lee).estimateAtRequest);

console.log("\n-- a consult must NOT supersede a live quote lead --");
// /shed/submit marks a customer's older "new" submissions superseded, because a
// fresh design replaces an older one. A request to talk replaces nothing.
await call("POST","/shed/submit",{contact:{name:"Alex",email:"alex@x.com",phone:"4355550505"},
  config:{style:"gable",w:10,l:12}});
const alexId = db.prepare("SELECT id FROM customers WHERE email='alex@x.com'").get().id;
await call("POST","/shed/consult",{name:"Alex",phone:"4355550505"});
const alexSubs = db.prepare("SELECT status FROM submissions WHERE customer_id=? ORDER BY id").all(alexId);
check("the customer was matched, not duplicated", alexSubs.length===2, alexSubs);
check("their quote request is STILL new", alexSubs[0].status==="new", alexSubs[0].status);
check("the consult is new too", alexSubs[1].status==="new", alexSubs[1].status);

console.log("\n-- a blank field must never erase what we already know --");
// The consult form has no address and email is optional. Matching an existing
// customer by phone used to overwrite every column with whatever this request
// carried, so the address and email from their quote request vanished.
check("email survived the consult", row(alexId).email==="alex@x.com", row(alexId).email);
await call("POST","/shed/submit",{contact:{name:"Alex",email:"alex@x.com",phone:"4355550505",
  address:"1 Main St", city:"Cedar City", state:"UT", zip:"84720"}, config:{style:"gable",w:10,l:12}});
check("address was recorded", row(alexId).address==="1 Main St", row(alexId).address);
await call("POST","/shed/consult",{name:"Alex",phone:"4355550505"});
check("  and survives a later consult", row(alexId).address==="1 Main St", row(alexId).address);
check("  as does the city", row(alexId).city==="Cedar City", row(alexId).city);
check("a present value still overwrites",
  (await call("POST","/shed/consult",{name:"Alexandra",phone:"4355550505"})).status===200 &&
  row(alexId).name==="Alexandra", row(alexId).name);

console.log("\n-- the admin list can tell the two apart --");
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;
const list=(await call("GET","/admin/customers",null,tok)).data.customers;
const dana=list.find(c=>c.name==="Dana");
const rene=list.find(c=>c.name==="Rene");
check("a consult lead is flagged", dana.latest_is_consult===true, dana);
check("  and carries no quoted price", dana.latest_quoted_price===null, dana.latest_quoted_price);
check("  but does carry the estimate", rene.latest_consult_estimate>0, rene.latest_consult_estimate);
check("details are still not leaked to the list", list.every(c=>c.latest_details===undefined));

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
