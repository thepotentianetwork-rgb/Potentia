// Covers the rate limiter: counting, window rollover, per-IP and per-endpoint
// isolation, the honeypot, and — most important — that it fails OPEN.
// Run: node --experimental-sqlite worker/ratelimit.test.mjs
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
async function call(p, body, ip, e){
  const h={ Origin:"https://shedpro-utah.com", "Content-Type":"application/json" };
  if(ip) h["CF-Connecting-IP"]=ip;
  const res=await worker.fetch(new Request("https://x"+p,{method:"POST",headers:h,body:JSON.stringify(body||{})}), e||env);
  return { status:res.status, retryAfter:res.headers.get("Retry-After"),
           data:await res.json().catch(()=>null) };
}
const lead = n => ({ contact:{name:n,email:n+"@x.com",phone:"4355550000"}, config:{style:"gable",w:10,l:12} });
const rows = () => db.prepare("SELECT bucket,count FROM rate_limits ORDER BY bucket").all();
const subs = () => db.prepare("SELECT COUNT(*) c FROM submissions").get().c;

console.log("\n-- it counts, and stops at the limit --");
// /shed/submit is capped at 10/hour.
let last;
for (let i=0;i<10;i++) last = await call("/shed/submit", lead("A"+i), "1.1.1.1");
check("the first ten are accepted", last.status===200, last.status);
const over = await call("/shed/submit", lead("A11"), "1.1.1.1");
check("the eleventh is refused with 429", over.status===429, over.status);
check("  and says when to come back", Number(over.retryAfter)>0, over.retryAfter);
check("  and stored nothing extra", subs()===10, subs());

console.log("\n-- one visitor's limit is not another's --");
const other = await call("/shed/submit", lead("B"), "2.2.2.2");
check("a different IP is unaffected", other.status===200, other.status);

console.log("\n-- endpoints are counted separately --");
const consult = await call("/shed/consult", {name:"C",phone:"4355551111"}, "1.1.1.1");
check("submit's ceiling does not block consult", consult.status===200, consult.status);

console.log("\n-- the window rolls over --");
db.prepare("UPDATE rate_limits SET window_start = window_start - 3601 WHERE bucket='submit:1.1.1.1'").run();
const after = await call("/shed/submit", lead("D"), "1.1.1.1");
check("allowed again once the hour has passed", after.status===200, after.status);
check("  and the counter restarted", rows().find(r=>r.bucket==='submit:1.1.1.1').count===1,
  rows().find(r=>r.bucket==='submit:1.1.1.1'));

console.log("\n-- the expensive endpoint is the tightest --");
let chatLast;
for (let i=0;i<30;i++) chatLast = await call("/chat", {messages:[{role:"user",content:"hi"}]}, "3.3.3.3");
// No API key configured here, so a permitted call fails at the upstream step —
// what matters is that it got PAST the limiter (500, not 429).
check("thirty chat calls get through the limiter", chatLast.status!==429, chatLast.status);
const chatOver = await call("/chat", {messages:[{role:"user",content:"hi"}]}, "3.3.3.3");
check("the thirty-first is refused", chatOver.status===429, chatOver.status);

console.log("\n-- the designer is not rationed while someone designs --");
let q;
for (let i=0;i<150;i++) q = await call("/shed/quote", {config:{style:"gable",w:10,l:12}}, "4.4.4.4");
check("150 re-prices in a session are fine", q.status!==429, q.status);

console.log("\n-- the honeypot --");
const before = subs();
const bot = await call("/shed/submit", {...lead("Bot"), website:"http://spam.example"}, "5.5.5.5");
check("a filled honeypot is answered 200, not an error", bot.status===200, bot.status);
check("  but nothing is stored", subs()===before, {before, after:subs()});
const botC = await call("/shed/consult", {name:"Bot",phone:"4355559999",website:"x"}, "5.5.5.5");
check("same on the consult form", botC.status===200 && subs()===before, {status:botC.status});

console.log("\n-- it fails OPEN, which matters more than it fails closed --");
// A DB that throws on everything: a real customer must still get through.
const brokenEnv = { ...env, DB: { prepare(){ throw new Error("d1 is down"); } } };
const broken = await call("/shed/quote", {config:{style:"gable",w:10,l:12}}, "6.6.6.6", brokenEnv);
check("a broken database does not refuse the request", broken.status!==429, broken.status);

console.log("\n-- staff are never rate limited --");
const tok=(await call("/admin/login",{password:"pw"},"7.7.7.7")).data.token;
let adminLast;
for (let i=0;i<40;i++){
  const res=await worker.fetch(new Request("https://x/admin/customers",{
    headers:{Origin:"https://shedpro-utah.com",Authorization:"Bearer "+tok,"CF-Connecting-IP":"7.7.7.7"}}), env);
  adminLast=res.status;
}
check("40 admin requests in a row all pass", adminLast===200, adminLast);

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
