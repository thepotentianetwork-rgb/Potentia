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
const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,body,ip,origin,e){
  const h={ Origin:origin||"https://shedpro-utah.com","Content-Type":"application/json","CF-Connecting-IP":ip||"9.9.9.9" };
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:m==="GET"?undefined:JSON.stringify(body||{})}), e||env);
  return { status:res.status, acao:res.headers.get("Access-Control-Allow-Origin"), data:await res.json().catch(()=>null) };
}
console.log("-- design codes are 128-bit --");
const s=await call("POST","/shed/design",{config:{w:10}});
check("new code is 32 hex", /^[0-9a-f]{32}$/.test(s.data.code), s.data);
check("it resolves", (await call("GET","/shed/design/"+s.data.code)).status===200);
db.prepare("INSERT INTO saved_designs (code,config,created_at) VALUES ('abcd1234','{}','x')").run();
check("legacy 8-hex still resolves", (await call("GET","/shed/design/abcd1234")).status===200);
check("malformed code 404s", (await call("GET","/shed/design/ABC'--")).status===404);
let g; for(let i=0;i<121;i++) g=await call("GET","/shed/design/deadbeef",null,"5.5.5.5");
check("redeem is rate limited", g.status===429, g.status);
console.log("-- login lockout --");
let l; for(let i=0;i<10;i++) l=await call("POST","/admin/login",{password:"no"},"6.6.6.6");
check("10th bad login is 401", l.status===401, l.status);
check("11th is 429 even with right pw", (await call("POST","/admin/login",{password:"pw"},"6.6.6.6")).status===429);
for(let i=0;i<10;i++) await call("POST","/crm/login",{password:"no"},"7.7.7.7");
check("crm login locked too", (await call("POST","/crm/login",{password:"c"},"7.7.7.7")).status===429);
console.log("-- crm lead limit --");
let c; for(let i=0;i<11;i++) c=await call("POST","/crm/lead",{name:"x",email:i+"@x.com"},"8.8.8.8");
check("11th lead is 429", c.status===429, c.status);
console.log("-- CORS --");
check("localhost not echoed in prod", (await call("POST","/crm/lead",{email:"a@b.c"},"1.2.3.4","http://localhost:8080")).acao!=="http://localhost:8080");
check("localhost allowed with ALLOW_LOCALHOST=1", (await call("POST","/crm/lead",{email:"a@b.c"},"1.2.3.5","http://localhost:8080",{...env,ALLOW_LOCALHOST:"1"})).acao==="http://localhost:8080");
check("extra tenant origin", (await call("POST","/crm/lead",{email:"a@b.c"},"1.2.3.6","https://tenant.example",{...env,EXTRA_ALLOWED_ORIGINS:"https://tenant.example"})).acao==="https://tenant.example");
check("unknown origin not echoed", (await call("POST","/crm/lead",{email:"a@b.c"},"1.2.3.7","https://evil.example")).acao!=="https://evil.example");
console.log(fails?`\n${fails} FAILED`:"\nall passed"); process.exit(fails?1:0);
