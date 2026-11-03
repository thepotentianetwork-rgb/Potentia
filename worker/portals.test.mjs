// Role portals: sales allow-list, builder jobs, customer deposit gate.
// generic 500s.   node --experimental-sqlite worker/sessions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import worker from "./index.js";
const SCHEMA = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

function makeD1(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const sel = /^\s*select/i.test(sql);
    const mk = (a) => ({
      first() { return sel ? (stmt.get(...a) ?? null) : (stmt.run(...a), null); },
      all() { return { results: stmt.all(...a) }; },
      run() { if (sel) return { results: stmt.all(...a) }; const r = stmt.run(...a); return { meta: { changes: Number(r.changes) } }; }
    });
    return { ...mk([]), bind: (...a) => mk(a) };
  };
  return { prepare, async batch(s) { return s.map((x) => x.run()); } };
}
function mkEnv(extra = {}) {
  const shed = new DatabaseSync(":memory:"), crm = new DatabaseSync(":memory:");
  shed.exec(SCHEMA);
  return { _shed: shed, _crm: crm, env: { DB: makeD1(shed), CRM_DB: makeD1(crm), ADMIN_PASSWORD: "a", CRM_PASSWORD: "c",
    LEADS_PASSWORD: "l", ADMIN_SESSION_SECRET: "admin-secret", ...extra } };
}
async function call(env, method, path, { body, token, unlock } = {}) {
  const headers = { Origin: "https://potentianetwork.com", "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (unlock) headers["X-Leads-Unlock"] = unlock;
  const r = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
async function setup() {
  const e = mkEnv(); const { env, _shed: db } = e;
  const now = new Date().toISOString();
  db.exec(`INSERT INTO customers (id,name,email,created_at,updated_at) VALUES (1,'Ana Buyer','ana@x.com','${now}','${now}'),(2,'Bo Other','bo@x.com','${now}','${now}')`);
  db.exec(`INSERT INTO submissions (id,customer_id,name,email,details,status,created_at) VALUES (10,1,'Ana','ana@x.com','{}','won','${now}'),(11,2,'Bo','bo@x.com','{}','won','${now}'),(12,2,'Bo','bo@x.com','{}','quoted','${now}')`);
  const admin = (await call(env, "POST", "/admin/login", { body: { password: "a" } })).data.token;
  return { env, db, admin };
}
const mk = async (env, admin, body) => (await call(env, "POST", "/portal/users", { token: admin, body })).data;
const login = async (env, l, p) => call(env, "POST", "/portal/login", { body: { login: l, password: p } });

test("only the owner can create accounts; password is returned once and stored hashed", async () => {
  const { env, db, admin } = await setup();
  const r = await mk(env, admin, { role: "sales", login: "nando", name: "Nando" });
  assert.equal(r.ok, true); assert.ok(r.password.length >= 16);
  const row = db.prepare("SELECT pass_hash FROM portal_users WHERE login='nando'").get();
  assert.ok(row.pass_hash.startsWith("pbkdf2$") && !row.pass_hash.includes(r.password));
  const s = (await login(env, "nando", r.password)).data.token;
  assert.equal((await call(env, "POST", "/portal/users", { token: s, body: { role: "sales", login: "evil" } })).status, 401);
  assert.equal((await login(env, "nando", "wrong")).status, 401);
});

test("sales: CRM lead routes allowed, money/pricing routes 403 (not 401)", async () => {
  const { env, admin } = await setup();
  const r = await mk(env, admin, { role: "sales", login: "nando", name: "Nando" });
  const s = (await login(env, "nando", r.password)).data.token;
  assert.equal((await call(env, "GET", "/admin/customers", { token: s })).status, 200);
  assert.equal((await call(env, "GET", "/admin/pricing", { token: s })).status, 403);
  assert.equal((await call(env, "GET", "/admin/dashboard", { token: s })).status, 403);
  assert.equal((await call(env, "POST", "/admin/customers/1/payments", { token: s, body: {} })).status, 403);
  assert.equal((await call(env, "GET", "/admin/pricing", { token: admin })).status, 200); // owner unchanged
});

test("builder sees only assigned won jobs, can clock, note, expense; not others", async () => {
  const { env, admin, db } = await setup();
  const sales = (await login(env, "nando", (await mk(env, admin, { role: "sales", login: "nando" })).password)).data.token;
  const b = await mk(env, admin, { role: "builder", login: "cristian", name: "Cristian" });
  const bid = db.prepare("SELECT id FROM portal_users WHERE login='cristian'").get().id;
  assert.equal((await call(env, "POST", "/portal/jobs/12/assign", { token: sales, body: { builder_id: bid } })).status, 409); // not won
  assert.equal((await call(env, "POST", "/portal/jobs/10/assign", { token: sales, body: { builder_id: bid } })).status, 200);
  const t = (await login(env, "cristian", b.password)).data.token;
  const jobs = (await call(env, "GET", "/portal/builder/jobs", { token: t })).data.jobs;
  assert.deepEqual(jobs.map((j) => j.id), [10]);
  assert.equal(JSON.stringify(jobs).includes("redline"), false);
  assert.equal((await call(env, "POST", "/portal/builder/jobs/10/clock", { token: t })).data.clocked, "in");
  assert.equal((await call(env, "POST", "/portal/builder/jobs/10/clock", { token: t })).data.clocked, "out");
  assert.equal((await call(env, "POST", "/portal/builder/jobs/10/notes", { token: t, body: { text: "Framing done" } })).status, 200);
  assert.equal((await call(env, "POST", "/portal/builder/jobs/10/expenses", { token: t, body: { amount: 42.5, photo: "data:image/png;base64,AAAA" } })).status, 200);
  assert.equal((await call(env, "POST", "/portal/builder/jobs/11/notes", { token: t, body: { text: "x" } })).status, 403);
  assert.equal((await call(env, "GET", "/admin/customers", { token: t })).status, 403);
});

test("customer account only after deposit; sees own order only", async () => {
  const { env, admin, db } = await setup();
  assert.equal((await call(env, "POST", "/portal/users", { token: admin, body: { role: "customer", login: "ana@x.com", customer_id: 1 } })).status, 409);
  db.exec(`INSERT INTO payments (customer_id,amount,method,paid_at,created_at) VALUES (1,500,'cash','2026-11-01','2026-11-01')`);
  const c = await mk(env, admin, { role: "customer", login: "ana@x.com", customer_id: 1, name: "Ana" });
  const t = (await login(env, "ana@x.com", c.password)).data.token;
  const o = await call(env, "GET", "/portal/customer/order", { token: t });
  assert.equal(o.status, 200); assert.equal(o.data.order_id, 10); assert.ok(o.data.warranties.length);
  assert.equal((await call(env, "GET", "/portal/builder/jobs", { token: t })).status, 403);
  assert.equal((await call(env, "GET", "/admin/customers/2", { token: t })).status, 403);
});
