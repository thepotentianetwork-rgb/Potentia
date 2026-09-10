// Exercises the manual call log on both CRMs against SQLite stand-ins for the
// two D1 bindings, including that a logged call counts as a "touch" for the
// follow-up temperature.  Run: node --experimental-sqlite worker/calls.test.mjs
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
  return { prepare(sql){ const m = shape(sql); return { ...m([]), bind:(...a)=>m(a) }; },
           async batch(st){ return st.map(s=>s.run()); } };
}

const shedDb = new DatabaseSync(":memory:");
shedDb.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
const crmDb = new DatabaseSync(":memory:");
const now = new Date().toISOString();
shedDb.prepare("INSERT INTO customers (name,email,phone,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run("Todd Greene", "todd@x.test", "8018793076", now, now);
// A quote from 40 days ago — dormant until someone rings them.
const old = new Date(Date.now() - 40*864e5).toISOString();
shedDb.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (?,?,?,?,?,?)")
  .run(1, "Todd Greene", "todd@x.test", '{"quotedPrice":23839}', "quoted", old);

const env = { DB: makeD1(shedDb), CRM_DB: makeD1(crmDb),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"cpw", ADMIN_SESSION_SECRET:"k" };
let fails = 0;
const check = (n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(method, p, body, tok) {
  const h = { Origin:"https://potentianetwork.com" };
  if (body) h["Content-Type"]="application/json";
  if (tok) h.Authorization = "Bearer "+tok;
  const res = await worker.fetch(new Request("https://x"+p,{method,headers:h,body:body?JSON.stringify(body):undefined}), env);
  return { status: res.status, data: await res.json().catch(()=>null) };
}
const shedTok = (await call("POST","/admin/login",{password:"pw"})).data.token;
const crmTok  = (await call("POST","/crm/login",{password:"cpw"})).data.token;

console.log("\n-- ShedPro call log --");
let r = await call("POST","/admin/customers/1/calls",{direction:"outbound",outcome:"connected",duration_min:12,notes:"Wants it after the fence goes in"},shedTok);
check("logged a connected call", r.status===200, r);
r = await call("POST","/admin/customers/1/calls",{direction:"outbound",outcome:"voicemail"},shedTok);
check("logged a voicemail with no duration", r.status===200, r);
r = await call("POST","/admin/customers/1/calls",{direction:"sideways",outcome:"connected"},shedTok);
check("bad direction rejected", r.status===400, r);
r = await call("POST","/admin/customers/1/calls",{direction:"outbound",outcome:"hung-up"},shedTok);
check("bad outcome rejected", r.status===400, r);
r = await call("POST","/admin/customers/1/calls",{direction:"outbound",outcome:"connected"},null);
check("requires auth", r.status===401, r);

r = await call("GET","/admin/customers/1",null,shedTok);
check("detail returns the calls", (r.data.calls||[]).length===2, r.data.calls);
check("newest first", r.data.calls[0].outcome==="voicemail", r.data.calls.map(c=>c.outcome));
check("duration kept", r.data.calls[1].duration_min===12, r.data.calls[1]);

console.log("\n-- a logged call counts as a touch --");
r = await call("GET","/admin/customers",null,shedTok);
const row = r.data.customers[0];
check("latest_call_at surfaces on the list", !!row.latest_call_at, row.latest_call_at);
const quoteDays = Math.floor((Date.now()-new Date(row.latest_submission_at).getTime())/864e5);
const callDays  = Math.floor((Date.now()-new Date(row.latest_call_at).getTime())/864e5);
check("quote is 40 days old (would read Dormant)", quoteDays>=39, quoteDays);
check("the call is today (reads Hot)", callDays===0, callDays);

console.log("\n-- deleting --");
const delId = r.data.customers[0] && (await call("GET","/admin/customers/1",null,shedTok)).data.calls[0].id;
r = await call("DELETE","/admin/calls/"+delId,null,shedTok);
check("call deleted", r.status===200, r);
r = await call("GET","/admin/customers/1",null,shedTok);
check("one call left", r.data.calls.length===1, r.data.calls.length);

console.log("\n-- Potentia call log --");
r = await call("POST","/crm/clients",{business_name:"Cedar Fork Barbers",email:"dana@x.test"},crmTok);
const clientId = r.data.id;
r = await call("POST","/crm/clients/"+clientId+"/calls",{direction:"inbound",outcome:"callback",notes:"Wants the booking page before the 1st"},crmTok);
check("logged a client call", r.status===200, r);
r = await call("POST","/crm/clients/"+clientId+"/calls",{direction:"outbound",outcome:"nope"},crmTok);
check("bad outcome rejected", r.status===400, r);
r = await call("GET","/crm/clients/"+clientId,null,crmTok);
check("client detail returns calls", (r.data.calls||[]).length===1, r.data.calls);
r = await call("GET","/crm/clients",null,crmTok);
check("latest_call_at on the client list", !!r.data.clients[0].latest_call_at, r.data.clients[0].latest_call_at);

r = await call("GET","/crm/clients/"+clientId,null,crmTok);
r = await call("DELETE","/crm/calls/"+r.data.calls[0].id,null,crmTok);
check("client call deleted", r.status===200, r);

console.log("\n-- the two databases stay separate --");
const shedTables = shedDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
const crmTables  = crmDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
check("shed has calls, not client_calls", shedTables.includes("calls") && !shedTables.includes("client_calls"), shedTables);
check("crm has client_calls, not calls", crmTables.includes("client_calls") && !crmTables.includes("calls"), crmTables);

console.log("\n-- deleting a customer takes their calls --");
await call("POST","/admin/customers/1/calls",{direction:"outbound",outcome:"connected"},shedTok);
r = await call("DELETE","/admin/customers/1",null,shedTok);
check("customer deleted", r.status===200, r);
check("no orphaned calls", shedDb.prepare("SELECT COUNT(*) AS n FROM calls").get().n===0,
      shedDb.prepare("SELECT COUNT(*) AS n FROM calls").get());

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails?1:0);
