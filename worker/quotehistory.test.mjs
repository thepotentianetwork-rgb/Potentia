// Quote history: resubmits never overwrite, staff can choose a quote, quoted-only average.
// Run: node --experimental-sqlite worker/quotehistory.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
import { quoteLines } from "./quotelines.js";
import { quotedAverage } from "./quotehistory.js";
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

const contact = (o={}) => ({ name:"Lee O'Shields", email:"lee@x.com", phone:"4355551234", address:"9 Oak Rd", city:"Cedar City", state:"UT", zip:"84720", ...o });
const subs = () => db.prepare("SELECT * FROM submissions ORDER BY id").all();

console.log("resubmit = new quote, old one untouched");
const r1 = await call("POST","/shed/submit",{contact:contact(), config:{style:"gable",w:10,l:12}, quotedPrice:9000});
check("first submit ok", r1.status===200, r1);
const first = subs()[0];
const firstSnap = JSON.stringify(first);
const r2 = await call("POST","/shed/submit",{contact:contact({name:"Someone Else", address:"1 Fake St"}), config:{style:"barn",w:12,l:16}, quotedPrice:14000, resubmitOf:first.id});
check("resubmit ok, no password needed", r2.status===200, r2);
const all = subs();
check("two rows, same customer", all.length===2 && all[0].customer_id===all[1].customer_id, all.map(s=>s.customer_id));
const old = all[0];
check("old quote's design/price untouched", old.details===first.details && old.effective_price===first.effective_price && old.adjustments===first.adjustments);
check("old row only changed status (new -> superseded)", JSON.stringify({...old,status:first.status})===firstSnap && old.status==="superseded", old.status);
check("resubmitOf linked for the same customer", JSON.parse(all[1].details).resubmitOf===first.id);
const c = db.prepare("SELECT * FROM customers WHERE id=?").get(first.customer_id);
check("contact details NOT overwritten by a public submit", c.name==="Lee O'Shields" && c.address==="9 Oak Rd", [c.name,c.address]);

console.log("resubmitOf cannot link to someone else's order");
await call("POST","/shed/submit",{contact:contact({name:"Pat", email:"pat@x.com", phone:"4355559999"}), config:{style:"gable",w:8,l:10}, quotedPrice:5000, resubmitOf:first.id});
const pat = subs().at(-1);
check("Pat is a different customer", pat.customer_id!==first.customer_id);
check("resubmitOf dropped", JSON.parse(pat.details).resubmitOf===undefined, JSON.parse(pat.details).resubmitOf);
check("Lee's rows untouched by Pat", subs()[0].details===first.details && subs()[1].status!=="superseded");

console.log("choose a quote");
check("choose without login -> 401", (await call("POST","/admin/submissions/"+first.id+"/choose",{})).status===401);
check("unknown -> 404", (await call("POST","/admin/submissions/9999/choose",{},tok)).status===404);
const before = JSON.stringify(subs().map(s=>[s.id,s.details,s.adjustments,s.effective_price,s.price_adjustment]));
const ch = await call("POST","/admin/submissions/"+all[1].id+"/choose",{},tok);
check("choose newer ok", ch.status===200 && !!subs()[1].chosen_at, ch);
const ch2 = await call("POST","/admin/submissions/"+first.id+"/choose",{},tok);
const after = subs();
check("choose older: it is chosen, the newer is cleared", ch2.status===200 && !!after[0].chosen_at && !after[1].chosen_at);
check("superseded older quote becomes 'quoted'", after[0].status==="quoted", after[0].status);
check("no price/design/adjustment changed", JSON.stringify(after.map(s=>[s.id,s.details,s.adjustments,s.effective_price,s.price_adjustment]))===before);
check("Pat's row not affected", !after[2].chosen_at);
const cust = await call("GET","/admin/customers/"+first.customer_id,null,tok);
check("customer view lists both quotes with chosen_at", cust.data.submissions.length===2 && cust.data.submissions.some(s=>s.id===first.id && s.chosen_at), cust.data.submissions.map(s=>[s.id,s.chosen_at]));
check("audit note written", db.prepare("SELECT COUNT(*) n FROM notes WHERE customer_id=? AND text LIKE '%chosen%'").get(first.customer_id).n>=2);
await call("POST","/admin/submissions/"+first.id+"/choose",{chosen:false},tok);
check("unmark", !subs()[0].chosen_at);

console.log("quotedAverage rule");
const q = quotedAverage([
  {id:1,customer_id:1,status:"new",created_at:"2026-01-01",price:99999},           // designer-only: out
  {id:2,customer_id:2,status:"quoted",created_at:"2026-01-01",price:10000},
  {id:3,customer_id:2,status:"quoted",created_at:"2026-02-01",price:12000},         // latest sent
  {id:4,customer_id:2,status:"new",created_at:"2026-03-01",price:50000},            // resubmit not sent
  {id:5,customer_id:3,status:"won",created_at:"2026-01-01",price:20000},            // won beats later quoted
  {id:6,customer_id:3,status:"quoted",created_at:"2026-02-01",price:30000},
  {id:7,customer_id:4,status:"quoted",created_at:"2026-01-01",price:8000,chosen_at:"x"}, // chosen beats all
  {id:8,customer_id:4,status:"won",created_at:"2026-02-01",price:40000},
  {id:9,customer_id:5,status:"lost",created_at:"2026-01-01",price:6000},            // lost was quoted
  {id:10,customer_id:6,status:"new",created_at:"2026-01-01",price:7000,chosen_at:"x"}, // chosen but never sent: out
]);
check("4 quoted customers, once each (designer-only and never-sent excluded)", q.count===4, q);
check("picks: 12000, 20000, 8000, 6000", JSON.stringify(q.perCustomer.map(p=>p.price))==="[12000,20000,8000,6000]", q.perCustomer);
check("avg 11500", q.avg===11500, q.avg);

console.log("#71 unchanged");
db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('Lee71',?,?)").run(now,now);
const lee = db.prepare("SELECT max(id) id FROM customers").get().id;
const fx = JSON.parse(fs.readFileSync(path.join(here,"fixtures","q71-like.json"),"utf8"));
db.prepare("INSERT INTO submissions (id,customer_id,name,email,details,status,created_at,adjustments,effective_price) VALUES (71,?,'Lee','l71@x',?,?,?,?,?)").run(lee,fx.details,"quoted",now,fx.adjustments,fx.effective_price);
const tot = () => { const r=db.prepare("SELECT details,adjustments FROM submissions WHERE id=71").get(); const b=quoteLines(JSON.parse(r.details).redline, JSON.parse(r.adjustments)); return b.total.toFixed(2)+"|"+b.cashDiscount.cashTotal.toFixed(2); };
check("#71 $18,151.27 before", tot()==="18151.27|17622.59", tot());
await call("POST","/admin/submissions/71/choose",{},tok);
await call("POST","/shed/submit",{contact:{name:"Lee",email:"l71@x",phone:""}, config:{style:"gable",w:10,l:12}, quotedPrice:1, resubmitOf:71});
check("#71 still $18,151.27 after choose + resubmit", tot()==="18151.27|17622.59", tot());

console.log(fails ? fails+" FAILED" : "all passed"); if (fails) process.exit(1);
