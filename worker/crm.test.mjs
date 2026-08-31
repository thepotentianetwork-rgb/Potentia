// Exercises every /crm/* route against a real SQLite database standing in for
// D1, so the SQL and the handlers actually run rather than just parsing.
// Node 22 needs the flag; Node 24 has node:sqlite unflagged:
//
//   node --experimental-sqlite worker/crm.test.mjs
//
// Exits non-zero if any check fails.
// End-to-end exercise of the /crm/* routes against a real SQLite standing in
// for D1, so the SQL and the handlers are actually run, not just parsed.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// TWO databases, exactly like production: `potentia-shed` (the shed partner's,
// bound as DB) and `potentia-crm` (Potentia's own, bound as CRM_DB). Keeping
// them apart here is the point of the test — if a CRM query ever reaches for
// env.DB, the shed database will end up with CRM tables in it and the
// "shed database stays clean" checks at the bottom fail.
function makeD1(db) {
  function shape(sql) {
    const stmt = db.prepare(sql);
    const isSelect = /^\s*select/i.test(sql);
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
  function prepare(sql) {
    const make = shape(sql);
    return { ...make([]), bind: (...args) => ({ ...make(args), _sql: sql }), _sql: sql };
  }
  return { prepare, async batch(stmts) { return stmts.map((s) => s.run()); } };
}
function tablesIn(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
}

// The shed database gets the real schema.sql, so this runs against the same
// DDL a live install has. The CRM database starts EMPTY on purpose — its
// tables should be created lazily by the Worker, with no migration step.
const shedDb = new DatabaseSync(":memory:");
shedDb.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
const crmDb = new DatabaseSync(":memory:");

const env = {
  DB: makeD1(shedDb),
  CRM_DB: makeD1(crmDb),
  ADMIN_PASSWORD: "shed-pw",
  CRM_PASSWORD: "crm-pw",
  ADMIN_SESSION_SECRET: "s3cr3t-test-key"
};

const CRM_TABLES = ["clients", "client_notes", "client_payments", "client_tasks"];
const SHED_TABLES = ["customers", "submissions", "installs", "pricing_config"];

const ORIGIN = "https://potentianetwork.com";
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
async function call(method, path, body, token) {
  const headers = { Origin: ORIGIN };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(
    new Request("https://api.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env
  );
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

console.log("\n-- login & scoping --");
let r = await call("POST", "/crm/login", { password: "wrong" });
check("wrong password rejected", r.status === 401, r);

// The whole point of the separate password: the shed partner's password must
// not open the CRM, and the CRM password must not open the shed dashboard.
r = await call("POST", "/crm/login", { password: "shed-pw" });
check("SHED password rejected by the CRM login", r.status === 401, r);

r = await call("POST", "/crm/login", { password: "crm-pw" });
check("crm password accepted", r.status === 200 && !!r.data.token, r);
const crmToken = r.data.token;

r = await call("POST", "/admin/login", { password: "shed-pw" });
const adminToken = r.data.token;
check("shed admin login still works", r.status === 200 && !!adminToken, r);

r = await call("POST", "/admin/login", { password: "crm-pw" });
check("CRM password rejected by the shed login", r.status === 401, r);

// With CRM_PASSWORD unset the CRM must refuse everything — no silent fall back
// to ADMIN_PASSWORD, which the shed partner knows.
const noCrmPw = { ...env, CRM_PASSWORD: undefined };
async function callWith(e, method, path, body, tok) {
  const res = await worker.fetch(
    new Request("https://api.test" + path, {
      method,
      headers: Object.assign({ Origin: ORIGIN, "Content-Type": "application/json" },
        tok ? { Authorization: "Bearer " + tok } : {}),
      body: JSON.stringify(body)
    }), e
  );
  return { status: res.status, data: await res.json().catch(() => null) };
}
r = await callWith(noCrmPw, "POST", "/crm/login", { password: "shed-pw" });
check("no CRM_PASSWORD set → shed password still refused", r.status === 503 && r.data.error === "CRM password not configured", r);
r = await callWith(noCrmPw, "POST", "/crm/login", { password: "crm-pw" });
check("no CRM_PASSWORD set → nothing gets in at all", r.status === 503, r);

r = await call("GET", "/crm/clients", null, adminToken);
check("shed token cannot read the CRM", r.status === 401, r);
r = await call("GET", "/admin/customers", null, crmToken);
check("crm token cannot read the shed dashboard", r.status === 401, r);
r = await call("GET", "/crm/clients", null, null);
check("no token rejected", r.status === 401, r);

console.log("\n-- clients --");
r = await call("GET", "/crm/clients", null, crmToken);
check("empty list", r.status === 200 && r.data.clients.length === 0 && r.data.stats.mrr === 0, r);

r = await call("POST", "/crm/clients", {}, crmToken);
check("nameless client rejected", r.status === 400, r);

r = await call("POST", "/crm/clients", {
  business_name: "Cedar Fork Barbers", contact_name: "Dana Ruiz", email: "dana@cedarfork.test",
  phone: "435-555-0110", package: "operator", status: "building", source: "referral",
  build_fee: "2400", monthly_fee: "150"
}, crmToken);
check("client created", r.status === 200 && r.data.id === 1, r);
const id = r.data.id;

r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("client fetched", r.status === 200 && r.data.client.business_name === "Cedar Fork Barbers", r.data && r.data.client);
check("fees stored as numbers", r.data.client.build_fee === 2400 && r.data.client.monthly_fee === 150, r.data.client);

r = await call("POST", "/crm/clients/" + id, { status: "live" }, crmToken);
check("status-only update accepted", r.status === 200, r);
r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("status-only update kept other fields", r.data.client.status === "live" && r.data.client.email === "dana@cedarfork.test", r.data.client);

r = await call("POST", "/crm/clients/" + id, { status: "banana" }, crmToken);
check("bad status rejected", r.status === 400, r);

r = await call("POST", "/crm/clients/" + id, {
  business_name: "Cedar Fork Barbers", contact_name: "Dana Ruiz", email: "dana@cedarfork.test",
  phone: "435-555-0110", package: "operator", status: "live", source: "referral",
  build_fee: "2400", monthly_fee: "175", website_url: "https://cedarfork.test",
  domain: "cedarfork.test", domain_renews_at: "2027-03-04", launched_at: "2026-08-15"
}, crmToken);
check("full update accepted", r.status === 200, r);
r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("dates + monthly saved", r.data.client.domain_renews_at === "2027-03-04" && r.data.client.monthly_fee === 175, r.data.client);

console.log("\n-- notes, tasks, payments --");
r = await call("POST", "/crm/clients/" + id + "/notes", { text: "Kickoff call — wants booking page by Sept." }, crmToken);
check("note added", r.status === 200, r);
r = await call("POST", "/crm/clients/" + id + "/notes", { text: "   " }, crmToken);
check("blank note rejected", r.status === 400, r);

r = await call("POST", "/crm/clients/" + id + "/tasks", { title: "Swap hero photo", due_date: "2026-09-05" }, crmToken);
check("task added", r.status === 200, r);
const taskId = r.data.id;
r = await call("POST", "/crm/clients/" + id + "/tasks", { title: "Add booking calendar" }, crmToken);
check("task without due date added", r.status === 200, r);
r = await call("POST", "/crm/tasks/" + taskId, { done: true }, crmToken);
check("task toggled done", r.status === 200 && r.data.done === true, r);

r = await call("POST", "/crm/clients/" + id + "/payments", { amount: 1200, method: "zelle", kind: "build", paid_at: "2026-08-20", note: "Deposit" }, crmToken);
check("payment logged", r.status === 200, r);
const payId = r.data.id;
r = await call("POST", "/crm/clients/" + id + "/payments", { amount: 150, method: "card", kind: "monthly" }, crmToken);
check("retainer logged (date defaults to today)", r.status === 200, r);
r = await call("POST", "/crm/clients/" + id + "/payments", { amount: 0, method: "cash" }, crmToken);
check("zero payment rejected", r.status === 400, r);
r = await call("POST", "/crm/clients/" + id + "/payments", { amount: 50, method: "bitcoin" }, crmToken);
check("unknown method rejected", r.status === 400, r);

r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("detail returns children", r.data.notes.length === 1 && r.data.tasks.length === 2 && r.data.payments.length === 2, {
  notes: r.data.notes.length, tasks: r.data.tasks.length, payments: r.data.payments.length
});
check("open task sorts above the done one", r.data.tasks[0].done === 0 && r.data.tasks[1].done === 1, r.data.tasks);

console.log("\n-- list aggregates --");
r = await call("GET", "/crm/clients", null, crmToken);
const row = r.data.clients[0];
check("latest note surfaces on the list", row.latest_note.indexOf("Kickoff call") === 0, row.latest_note);
check("open task count", row.open_tasks === 1, row);
check("next_due ignores completed tasks", row.next_due === null || row.next_due === undefined, row.next_due);
check("collected total", row.collected === 1350, row.collected);
check("MRR counts the live client", r.data.stats.mrr === 175, r.data.stats);
check("active client count", r.data.stats.active_clients === 1, r.data.stats);
check("collected in last 30d", r.data.stats.collected_30d === 150 || r.data.stats.collected_30d === 1350, r.data.stats);

console.log("\n-- public lead capture --");
r = await call("POST", "/crm/lead", { name: "Marisol Vega", email: "marisol@vega.test", service: "Website", message: "Need a 3-page site." });
check("new lead created", r.status === 200 && !r.data.existing, r);
const leadId = r.data.id;
r = await call("GET", "/crm/clients/" + leadId, null, crmToken);
check("lead has website source + status lead", r.data.client.status === "lead" && r.data.client.source === "website", r.data.client);
check("inquiry text kept", r.data.client.message === "Need a 3-page site.", r.data.client);

r = await call("POST", "/crm/lead", { name: "Dana Ruiz", email: "dana@cedarfork.test", service: "Social Media", message: "Second inquiry." });
check("repeat inquiry matched to existing client", r.status === 200 && r.data.existing === true && r.data.id === id, r);
r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("repeat inquiry logged as a note, not a duplicate client", r.data.notes.length === 2 && r.data.notes[0].text.indexOf("New website inquiry") === 0, r.data.notes[0]);
check("existing client's status untouched by the new inquiry", r.data.client.status === "live", r.data.client.status);

r = await call("POST", "/crm/lead", { name: "No Contact" });
check("lead with no email or phone rejected", r.status === 400, r);

console.log("\n-- deletes --");
r = await call("DELETE", "/crm/payments/" + payId, null, crmToken);
check("payment deleted", r.status === 200, r);
r = await call("DELETE", "/crm/tasks/" + taskId, null, crmToken);
check("task deleted", r.status === 200, r);
r = await call("GET", "/crm/clients/" + id, null, crmToken);
check("children gone", r.data.payments.length === 1 && r.data.tasks.length === 1, r.data);

r = await call("DELETE", "/crm/clients/" + leadId, null, crmToken);
check("client deleted", r.status === 200, r);
r = await call("GET", "/crm/clients/" + leadId, null, crmToken);
check("deleted client is gone", r.status === 404, r);
r = await call("DELETE", "/crm/clients/9999", null, crmToken);
check("deleting a missing client 404s", r.status === 404, r);

console.log("\n-- the two databases stay separate --");
const shedTables = tablesIn(shedDb);
const crmTables = tablesIn(crmDb);
CRM_TABLES.forEach(function (t) {
  check("shed database has NO " + t + " table", shedTables.indexOf(t) === -1, shedTables);
});
SHED_TABLES.forEach(function (t) {
  check("CRM database has NO " + t + " table", crmTables.indexOf(t) === -1, crmTables);
});
check("CRM tables were created lazily in the CRM database",
  CRM_TABLES.every(function (t) { return crmTables.indexOf(t) !== -1; }), crmTables);
check("no shed row was written by any CRM call",
  shedDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n === 0, "customers table not empty");

// Missing binding must fail loudly rather than falling back to the shed DB.
const noCrmDb = { ...env, CRM_DB: undefined };
r = await callWith(noCrmDb, "POST", "/crm/clients", { business_name: "Should Not Land" }, crmToken);
check("CRM_DB unbound → 503, not a write into the shed database",
  r.status === 503 && r.data.error === "CRM database not connected", r);
check("still nothing in the shed database after that",
  tablesIn(shedDb).indexOf("clients") === -1, tablesIn(shedDb));

console.log("\n-- shed side still intact --");
r = await call("GET", "/admin/customers", null, adminToken);
check("shed customers list still reachable", r.status === 200 && Array.isArray(r.data.customers), r);

console.log(failures === 0 ? "\nAll checks passed.\n" : "\n" + failures + " check(s) FAILED.\n");
process.exit(failures === 0 ? 0 : 1);
