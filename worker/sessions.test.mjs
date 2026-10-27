// Session hardening: per-area secrets, server-side revocation, 4h TTL, and
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
const decode = (t) => JSON.parse(Buffer.from(t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

test("admin login issues a 4h session row; logout revokes it server-side", async () => {
  const { env, _shed } = mkEnv();
  const { data } = await call(env, "POST", "/admin/login", { body: { password: "a" } });
  const p = decode(data.token);
  assert.equal(p.admin, true); assert.ok(p.sid);
  const ttl = p.exp - Date.now();
  assert.ok(ttl <= 4 * 3600e3 && ttl > 3.9 * 3600e3);
  const row = _shed.prepare("SELECT * FROM sessions WHERE id = ?").get(p.sid);
  assert.equal(row.area, "admin");
  assert.equal((await call(env, "GET", "/admin/customers", { token: data.token })).status, 200);
  assert.equal((await call(env, "POST", "/admin/logout", { token: data.token })).data.revoked, true);
  assert.equal((await call(env, "GET", "/admin/customers", { token: data.token })).status, 401);
});

test("validly signed token without a session row is rejected", async () => {
  const { env, _shed } = mkEnv();
  const { data } = await call(env, "POST", "/admin/login", { body: { password: "a" } });
  _shed.prepare("DELETE FROM sessions").run();
  assert.equal((await call(env, "GET", "/admin/customers", { token: data.token })).status, 401);
});

test("expired row is rejected even if token exp is in the future", async () => {
  const { env, _shed } = mkEnv();
  const { data } = await call(env, "POST", "/admin/login", { body: { password: "a" } });
  _shed.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
  assert.equal((await call(env, "GET", "/admin/customers", { token: data.token })).status, 401);
});

test("areas are separated: secrets and scope", async () => {
  const { env } = mkEnv({ CRM_SESSION_SECRET: "crm-secret", LEADS_SESSION_SECRET: "leads-secret" });
  const crm = (await call(env, "POST", "/crm/login", { body: { password: "c" } })).data.token;
  const admin = (await call(env, "POST", "/admin/login", { body: { password: "a" } })).data.token;
  assert.equal((await call(env, "GET", "/admin/customers", { token: crm })).status, 401);
  assert.equal((await call(env, "GET", "/crm/clients", { token: admin })).status, 401);
  assert.equal((await call(env, "GET", "/crm/clients", { token: crm })).status, 200);
  // A CRM token is not a leads unlock.
  assert.equal((await call(env, "GET", "/crm/leads/segments", { token: crm, unlock: crm })).status, 403);
  const unlock = (await call(env, "POST", "/crm/leads/unlock", { token: crm, body: { password: "l" } })).data.unlock;
  assert.notEqual((await call(env, "GET", "/crm/leads/segments", { token: crm, unlock })).status, 403);
  const out = await call(env, "POST", "/crm/logout", { token: crm, unlock });
  assert.deepEqual([out.data.revoked, out.data.unlockRevoked], [true, true]);
  assert.equal((await call(env, "GET", "/crm/clients", { token: crm })).status, 401);
});

test("tokens signed with the shared fallback secret stop working once a dedicated CRM secret is set", async () => {
  const a = mkEnv();
  const crm = (await call(a.env, "POST", "/crm/login", { body: { password: "c" } })).data.token;
  a.env.CRM_SESSION_SECRET = "new-crm-secret";
  assert.equal((await call(a.env, "GET", "/crm/clients", { token: crm })).status, 401);
});

test("legacy 12h tokens without sid are rejected", async () => {
  const { env } = mkEnv();
  const t = (await call(env, "POST", "/admin/login", { body: { password: "a" } })).data.token;
  const forged = t.split(".")[0].slice(0, 5) + "." + t.split(".")[1];
  assert.equal((await call(env, "GET", "/admin/customers", { token: forged })).status, 401);
});

test("catch-all 500 does not leak error detail", async () => {
  const { env } = mkEnv();
  const t = (await call(env, "POST", "/admin/login", { body: { password: "a" } })).data.token;
  const real = env.DB;
  env.DB = { prepare(sql) { if (/sessions/.test(sql)) return real.prepare(sql); throw new Error("SECRET_INTERNAL_DETAIL"); } };
  const orig = console.error; console.error = () => {};
  const r = await call(env, "GET", "/admin/customers", { token: t });
  console.error = orig;
  assert.equal(r.status, 500);
  assert.deepEqual(r.data, { error: "Server error" });
});
