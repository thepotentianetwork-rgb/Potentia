// Exercises the lead-temperature override against a SQLite stand-in for D1,
// including the ALTER TABLE migration running on a customers table that
// already holds rows.  Run: node --experimental-sqlite worker/followup.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import worker from "./index.js";

const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(new URL("schema.sql", import.meta.url), "utf8"));
// A customer that already exists BEFORE the new columns — the real situation.
const now = new Date().toISOString();
db.prepare("INSERT INTO customers (name,email,phone,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run("Todd Greene", "greene.todd.c3@gmail.com", "8018793076", now, now);
db.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (?,?,?,?,?,?)")
  .run(1, "Todd Greene", "greene.todd.c3@gmail.com", '{"quotedPrice":23839}', "quoted", now);

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
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map(s => s.run()); }
  };
}
const env = { DB: makeD1(db), ADMIN_PASSWORD: "pw", ADMIN_SESSION_SECRET: "k" };
let fails = 0;
const check = (n, c, x) => { if (c) console.log("  ok   " + n); else { fails++; console.log("  FAIL " + n + (x ? "  " + JSON.stringify(x) : "")); } };

async function call(method, path, body, tok) {
  const h = { Origin: "https://potentianetwork.com" };
  if (body) h["Content-Type"] = "application/json";
  if (tok) h.Authorization = "Bearer " + tok;
  const res = await worker.fetch(new Request("https://x" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

const tok = (await call("POST", "/admin/login", { password: "pw" })).data.token;

console.log("\n-- migration on a table that already has rows --");
const before = db.prepare("PRAGMA table_info(customers)").all().map(r => r.name);
check("columns absent before", !before.includes("temp_override") && !before.includes("follow_up_at"), before);

let r = await call("GET", "/admin/customers", null, tok);
check("list still works (migration ran)", r.status === 200 && r.data.customers.length === 1, r.status);
const after = db.prepare("PRAGMA table_info(customers)").all().map(r => r.name);
check("columns added", after.includes("temp_override") && after.includes("follow_up_at"), after);
check("existing customer data intact", r.data.customers[0].name === "Todd Greene", r.data.customers[0]);
check("override starts null", r.data.customers[0].temp_override === null, r.data.customers[0].temp_override);

console.log("\n-- setting it --");
r = await call("POST", "/admin/customers/1/followup", { temperature: "cold", follow_up_at: "2027-03-01" }, tok);
check("set cold + revisit date", r.status === 200, r);
r = await call("GET", "/admin/customers", null, tok);
check("override persisted", r.data.customers[0].temp_override === "cold", r.data.customers[0]);
check("date persisted", r.data.customers[0].follow_up_at === "2027-03-01", r.data.customers[0]);

r = await call("GET", "/admin/customers/1", null, tok);
check("detail returns both", r.data.customer.temp_override === "cold" && r.data.customer.follow_up_at === "2027-03-01", r.data.customer);

console.log("\n-- clearing and validation --");
r = await call("POST", "/admin/customers/1/followup", { temperature: null, follow_up_at: null }, tok);
check("cleared back to auto", r.status === 200, r);
r = await call("GET", "/admin/customers", null, tok);
check("both null again", r.data.customers[0].temp_override === null && r.data.customers[0].follow_up_at === null, r.data.customers[0]);

r = await call("POST", "/admin/customers/1/followup", { temperature: "lukewarm" }, tok);
check("bad temperature rejected", r.status === 400, r);
r = await call("POST", "/admin/customers/1/followup", { follow_up_at: "next march" }, tok);
check("bad date rejected", r.status === 400, r);
r = await call("POST", "/admin/customers/999/followup", { temperature: "hot" }, tok);
check("unknown customer 404s", r.status === 404, r);
r = await call("POST", "/admin/customers/1/followup", { temperature: "hot" }, null);
check("requires auth", r.status === 401, r);

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
