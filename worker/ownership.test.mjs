/* Two rules that decide who may spend money and who owns a lead.
 *
 * Both are enforced in the Worker, not in the page. A hidden button is not a
 * lock, and an owner the browser assigns is an owner anyone can reassign.
 * Run: node --test worker/ownership.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}

async function setup() {
  const crmDb = new DatabaseSync(":memory:");
  /* Loaded from the schema file rather than left to ensureCrmTables, which
     caches "already done" in a module-level flag — so the second test in a
     process would get a database with no tables in it. */
  crmDb.exec(fs.readFileSync(path.join(here, "schema-crm.sql"), "utf8"));
  const env = { CRM_DB: makeD1(crmDb), ADMIN_PASSWORD: "adminpw", CRM_PASSWORD: "cpw",
                LEADS_PASSWORD: "leadspw", ADMIN_SESSION_SECRET: "k",
                GOOGLE_PLACES_API_KEY: "g" };

  async function call(method, p, body, tok, unlock) {
    const h = { Origin: "https://potentianetwork.com" };
    if (body) h["Content-Type"] = "application/json";
    if (tok) h.Authorization = "Bearer " + tok;
    if (unlock) h["X-Leads-Unlock"] = unlock;
    const res = await worker.fetch(new Request("https://x" + p,
      { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, data, text, headers };
  }

  const crmTok = (await call("POST", "/crm/login", { password: "cpw" })).data.token;
  await call("POST", "/crm/clients", { business_name: "Valley Drywall", phone: "9495551234" }, crmTok);
  return { env, crmDb, call, crmTok };
}

test("the lead generator is locked to a CRM login alone", async () => {
  const { call, crmTok } = await setup();

  /* Everyone working the phones has one of these. Spending money and
     rewriting the search grid is not theirs to do. */
  for (const [method, path] of [["GET", "/crm/leads/segments"],
                                ["POST", "/crm/leads/segments"],
                                ["POST", "/crm/leads/run-now?dry=1"],
                                ["GET", "/crm/leads/runs"]]) {
    const r = await call(method, path, method === "POST" ? {} : null, crmTok);
    assert.equal(r.status, 403, method + " " + path + " should be locked");
  }

  // And without any login at all it is still 401, not 403.
  assert.equal((await call("GET", "/crm/leads/segments")).status, 401);
});

test("the ShedPro price-unlock password does not open the lead generator", async () => {
  const { env, call, crmTok } = await setup();

  /* ADMIN_PASSWORD is what ShedPro staff type to see prices in the designer —
     handed around daily. It must not also unlock a thing that spends money,
     and it must not do so quietly just because the generator's own secret has
     not been set yet. */
  assert.equal((await call("POST", "/crm/leads/unlock", { password: "adminpw" }, crmTok)).status, 401);

  delete env.LEADS_PASSWORD;
  const unset = await call("POST", "/crm/leads/unlock", { password: "adminpw" }, crmTok);
  assert.equal(unset.status, 503, "no password set means shut, not open");
  assert.match(unset.data.error, /LEADS_PASSWORD/, "and it says what to go and add");

  // Nothing got through while it was unconfigured.
  assert.equal((await call("GET", "/crm/leads/segments", null, crmTok)).status, 403);
});

test("the right password unlocks it; the wrong one does not", async () => {
  const { call, crmTok } = await setup();

  assert.equal((await call("POST", "/crm/leads/unlock", { password: "nope" }, crmTok)).status, 401);
  // The unlock itself needs a CRM login — it is a second gate, not a way past the first.
  assert.equal((await call("POST", "/crm/leads/unlock", { password: "leadspw" })).status, 401);

  const ok = await call("POST", "/crm/leads/unlock", { password: "leadspw" }, crmTok);
  assert.equal(ok.status, 200);
  assert.ok(ok.data.unlock, "an unlock token comes back");

  const seg = await call("GET", "/crm/leads/segments", null, crmTok, ok.data.unlock);
  assert.equal(seg.status, 200);
  assert.ok(Array.isArray(seg.data.segments));
});

test("an unlock token is not a login, and a login is not an unlock", async () => {
  const { call, crmTok } = await setup();
  const unlock = (await call("POST", "/crm/leads/unlock", { password: "leadspw" }, crmTok)).data.unlock;

  // The unlock alone gets you nothing — it says what you may do, not who you are.
  assert.equal((await call("GET", "/crm/leads/segments", null, null, unlock)).status, 401);
  // And a CRM token in the unlock header is not an unlock.
  assert.equal((await call("GET", "/crm/leads/segments", null, crmTok, crmTok)).status, 403);
});

test("whoever gets them on the phone owns the lead", async () => {
  const { call, crmTok, crmDb } = await setup();

  await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "connected", logged_by: "Fernando M" }, crmTok);
  assert.equal(crmDb.prepare("SELECT owner FROM clients WHERE id = 1").get().owner, "Fernando M");

  /* First contact wins. A second caller opening the record later cannot take
     a lead off the person who actually earned it. */
  const second = await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "connected", logged_by: "Alejandro A" }, crmTok);
  assert.equal(second.data.claimed_by, null, "nothing to claim");
  assert.equal(crmDb.prepare("SELECT owner FROM clients WHERE id = 1").get().owner, "Fernando M");
});

test("voicemail and no answer claim nothing", async () => {
  const { call, crmTok, crmDb } = await setup();

  for (const outcome of ["voicemail", "no-answer", "wrong-number"]) {
    const r = await call("POST", "/crm/clients/1/calls",
      { direction: "outbound", outcome, logged_by: "Maya" }, crmTok);
    assert.equal(r.data.claimed_by, null, outcome + " is not contact");
  }
  assert.equal(crmDb.prepare("SELECT owner FROM clients WHERE id = 1").get().owner, null,
    "you can leave five voicemails and have spoken to nobody");

  // A callback request is contact — they picked up and asked to be rung back.
  const cb = await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "callback", logged_by: "Chris" }, crmTok);
  assert.equal(cb.data.claimed_by, "Chris");
});

test("a call with no name logged claims nothing, and is still logged", async () => {
  const { call, crmTok, crmDb } = await setup();
  const r = await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "connected" }, crmTok);
  assert.equal(r.status, 200);
  assert.equal(r.data.claimed_by, null);
  assert.equal(crmDb.prepare("SELECT owner FROM clients WHERE id = 1").get().owner, null);
  assert.equal(Number(crmDb.prepare("SELECT COUNT(*) AS c FROM client_calls").get().c), 1);
});

test("the roster is there before anyone has made a call", async () => {
  const { call, crmTok } = await setup();
  const r = await call("GET", "/crm/callers", null, crmTok);
  assert.deepEqual(r.data.roster, ["Fernando M", "Alejandro A"],
    "a new CRM offers the people on the phones, not an empty list");
});

test("the roster changes without a deploy", async () => {
  const { env, call, crmTok } = await setup();
  env.CRM_CALLERS = " Dana R , Sam T ,, ";
  const r = await call("GET", "/crm/callers", null, crmTok);
  assert.deepEqual(r.data.roster, ["Dana R", "Sam T"], "trimmed, and blanks dropped");
});

test("names already in the call log survive leaving the roster", async () => {
  const { env, call, crmTok } = await setup();
  await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "connected", logged_by: "Fernando M" }, crmTok);
  await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "voicemail", logged_by: "Alejandro A" }, crmTok);

  /* Someone leaving the roster must not make the leads they own unattributable
     in the list they are picked from. */
  env.CRM_CALLERS = "Dana R";
  const r = await call("GET", "/crm/callers", null, crmTok);
  assert.deepEqual(r.data.callers, ["Alejandro A", "Dana R", "Fernando M"],
    "including whoever only left a voicemail, and whoever has since left");
  assert.deepEqual(r.data.roster, ["Dana R"]);
});

test("who logged a call is returned with it", async () => {
  const { call, crmTok } = await setup();
  await call("POST", "/crm/clients/1/calls",
    { direction: "outbound", outcome: "connected", logged_by: "Maya", notes: "wants a quote" }, crmTok);
  const r = await call("GET", "/crm/clients/1", null, crmTok);
  assert.equal(r.data.calls[0].logged_by, "Maya");
});

test("the preflight allows every custom header the pages actually send", async () => {
  const { call } = await setup();
  const r = await call("OPTIONS", "/crm/leads/segments");
  const allowed = String(r.headers["access-control-allow-headers"] || "")
    .split(",").map((h) => h.trim().toLowerCase());

  /* Scanned from the pages rather than listed here, so the next custom header
     someone adds is caught by this test instead of by a browser reporting
     "Load failed" and sending everyone to look at the server. */
  const fs = await import("node:fs");
  const sent = new Set();
  for (const f of ["crm.html", "crm-client.html", "crm-data.html", "crm-lead.js"]) {
    let src; try { src = fs.readFileSync(path.join(here, "..", f), "utf8"); } catch (e) { continue; }
    for (const m of src.matchAll(/['"]([Xx]-[A-Za-z0-9-]+)['"]\s*:/g)) sent.add(m[1].toLowerCase());
  }

  assert.ok(sent.has("x-leads-unlock"), "the scan found the header the CRM sends");
  for (const h of sent) {
    assert.ok(allowed.includes(h), h + " is sent by the CRM but blocked at the preflight");
  }
});

test("category names are readable without unlocking the generator", async () => {
  const { call, crmTok } = await setup();

  /* Someone working the phones never unlocks the generator, and the list is
     unreadable if a category shows as "home_service". Names are not the
     privileged part — the counts and the toggles are. */
  const r = await call("GET", "/crm/segment-names", null, crmTok);
  assert.equal(r.status, 200);

  const byKey = {};
  r.data.segments.forEach((s) => { byKey[s.key] = s.label; });
  assert.equal(byKey.home_service, "Home Services",
    "the exact wording, served rather than guessed at in the page");
  assert.ok(r.data.trades["roofing contractor"], "trade names come with them");

  // Still a CRM login, just not the generator's password.
  assert.equal((await call("GET", "/crm/segment-names")).status, 401);
  // And it hands out nothing privileged.
  assert.equal(r.data.segments[0].searches, undefined, "no counts");
  assert.equal(r.data.segments[0].enabled, undefined, "and nothing about what is switched on");
});
