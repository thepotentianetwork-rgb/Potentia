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

const cust=(e)=>db.prepare("SELECT * FROM customers WHERE email=?").get(e);
const subsOf=(id)=>db.prepare("SELECT status FROM submissions WHERE customer_id=? ORDER BY id").all(id).map(r=>r.status);
const cfg={style:"gable",w:10,l:12};
console.log("\n-- placeholder phone + new email -> NEW customer, Dan untouched --");
await call("POST","/shed/submit",{contact:{name:"Dan",email:"dand@x.com",phone:"000-000-0000"},config:cfg});
const dan=cust("dand@x.com");
await call("POST","/shed/submit",{contact:{name:"Jack Lo",email:"jacklo@x.com",phone:"000-000-0000"},config:cfg});
const jack=cust("jacklo@x.com");
check("Jack got his own record", jack && jack.id!==dan.id, jack);
check("Dan's quote is still new", subsOf(dan.id).join()==="new", subsOf(dan.id));
check("Dan's name unchanged", cust("dand@x.com").name==="Dan");
for (const p of ["555-555-5555","(123) 456-7890","1111111111","801-555"]) {
  const e=`f${p.replace(/\D/g,"")}@x.com`;
  await call("POST","/shed/submit",{contact:{name:"A",email:"a"+e,phone:p},config:cfg});
  await call("POST","/shed/submit",{contact:{name:"B",email:"b"+e,phone:p},config:cfg});
  check(`fake/short ${p} does not merge`, cust("a"+e).id!==cust("b"+e).id);
}
console.log("\n-- same email -> same customer + supersede --");
await call("POST","/shed/submit",{contact:{name:"Dan",email:"dand@x.com",phone:"000-000-0000"},config:{style:"leanto",w:8,l:10}});
check("same customer", subsOf(dan.id).length===2, subsOf(dan.id));
check("older quote superseded, newest new", subsOf(dan.id).join()==="superseded,new", subsOf(dan.id));
console.log("\n-- real phone, existing customer with no email -> merge --");
await call("POST","/shed/consult",{name:"Pat",phone:"801-555-1234"});
const pat=db.prepare("SELECT id,email FROM customers WHERE name='Pat'").get();
check("consult created email-less customer", pat && !pat.email, pat);
await call("POST","/shed/submit",{contact:{name:"Pat",email:"pat@x.com",phone:"(801) 555 1234"},config:cfg});
check("submit merged by normalized phone", subsOf(pat.id).length===2, subsOf(pat.id));
check("phone-only match does not supersede", subsOf(pat.id).join()==="new,new", subsOf(pat.id));
check("email filled in", cust("pat@x.com")?.id===pat.id);
console.log("\n-- real phone but DIFFERENT emails -> never merge --");
await call("POST","/shed/submit",{contact:{name:"Q",email:"q1@x.com",phone:"4355550101"},config:cfg});
await call("POST","/shed/submit",{contact:{name:"Q",email:"q2@x.com",phone:"4355550101"},config:cfg});
check("two customers", cust("q1@x.com").id!==cust("q2@x.com").id);
check("q1's quote not superseded", subsOf(cust("q1@x.com").id).join()==="new");
console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
