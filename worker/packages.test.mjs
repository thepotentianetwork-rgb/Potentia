/* The website tiers and what a build of each costs.
 *
 * The prices are internal. Everything here is about two things: they are
 * never served without a CRM login, and they are never baked into a page —
 * crm.html is a public file, so anything written in it is published.
 *
 * Run: node --test worker/packages.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

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
  crmDb.exec(fs.readFileSync(path.join(here, "schema-crm.sql"), "utf8"));
  const env = { CRM_DB: makeD1(crmDb), ADMIN_PASSWORD: "adminpw", CRM_PASSWORD: "cpw",
                ADMIN_SESSION_SECRET: "k" };
  async function call(method, p, body, tok) {
    const h = { Origin: "https://potentianetwork.com" };
    if (body) h["Content-Type"] = "application/json";
    if (tok) h.Authorization = "Bearer " + tok;
    const res = await worker.fetch(new Request("https://x" + p,
      { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    return { status: res.status, data, text };
  }
  const crmTok = (await call("POST", "/crm/login", { password: "cpw" })).data.token;
  return { env, crmDb, call, crmTok };
}

test("the prices are only served to someone logged in", async () => {
  const { call } = await setup();
  const out = await call("GET", "/crm/packages");
  assert.equal(out.status, 401);
  assert.equal(out.text.indexOf("500"), -1, "no price may appear in the refusal");
});

test("the three tiers carry the prices we sell them at", async () => {
  const { call, crmTok } = await setup();
  const r = await call("GET", "/crm/packages", null, crmTok);
  assert.equal(r.status, 200);
  const by = {};
  r.data.packages.forEach((p) => { by[p.key] = p; });
  assert.equal(by.tier1.price, 500);
  assert.equal(by.tier2.price, 1200);
  assert.equal(by.tier3.price, 1800);
  // Scoped per business — a figure here would be a guess quoted as a price.
  assert.equal(by.crm.price, null);
  assert.equal(by.platform.price, null);
});

test("a retired package is still offered to the client who has one", async () => {
  const { call, crmTok } = await setup();
  const r = await call("GET", "/crm/packages", null, crmTok);
  const by = {};
  r.data.packages.forEach((p) => { by[p.key] = p; });
  /* Not removed from the list: a client who bought a 4-Page Gallery Site
     bought that, and dropping the key would make their row unreadable. */
  ["foundation", "booking", "gallery", "operator"].forEach((k) => {
    assert.ok(by[k], k + " must still be known");
    assert.equal(by[k].retired, true, k + " must be marked retired");
  });
  ["tier1", "tier2", "tier3"].forEach((k) => {
    assert.ok(!by[k].retired, k + " is what we sell now");
  });
});

test("a client can be saved onto a tier, and a retired one still saves", async () => {
  const { call, crmTok } = await setup();
  const made = await call("POST", "/crm/clients",
    { business_name: "Valley Drywall", package: "tier2", build_fee: 1200 }, crmTok);
  assert.equal(made.status, 200);
  const id = made.data.id;
  const got = await call("GET", "/crm/clients/" + id, null, crmTok);
  assert.equal(got.data.client.package, "tier2");
  assert.equal(Number(got.data.client.build_fee), 1200);

  const oldId = (await call("POST", "/crm/clients",
    { business_name: "Old Client", package: "gallery" }, crmTok)).data.id;
  const oldGot = await call("GET", "/crm/clients/" + oldId, null, crmTok);
  assert.equal(oldGot.data.client.package, "gallery");

  // And a key that is not a package at all is refused rather than stored.
  const bad = await call("PATCH", "/crm/clients/" + id, { package: "tier9" }, crmTok);
  const after = await call("GET", "/crm/clients/" + id, null, crmTok);
  assert.notEqual(after.data.client.package, "tier9");
});

test("no price is written into a page anyone can read", async () => {
  /* The reason /crm/packages exists. These files are served to the open
     internet; a login gates the DATA they fetch, not the file itself. */
  for (const f of ["crm.html", "crm-client.html", "crm-data.html", "pricing.html", "index.html"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    /* 1200 and 1800 only. 500 is font-weight, a flex basis and half the
       colour ramp — checking it flags the stylesheet, not a leak, and a
       test that cries wolf gets deleted. The two distinctive figures are
       enough to catch the mistake this guards against: pasting the price
       table into a page. */
    for (const price of ["1200", "1800"]) {
      /* The number on its own, not part of a longer one and not a CSS length —
         max-width:1200px is a layout, not a price. */
      const hit = new RegExp("(?<![\\d.])" + price + "(?![\\d.]|px|ms|s\\b)").exec(src);
      assert.equal(hit, null,
        f + " looks like it contains the price " + price + " near: " +
        (hit ? JSON.stringify(src.slice(Math.max(0, hit.index - 40), hit.index + 40)) : ""));
    }
  }
});

test("the assistant is never told a price", async () => {
  /* It talks to the public. It is told to refuse dollar amounts, but the
     surest way for it not to leak one is for it never to have been given
     one. */
  const src = fs.readFileSync(path.join(here, "index.js"), "utf8");
  const prompt = src.slice(src.indexOf("const SYSTEM_PROMPT"), src.indexOf("const SESSION_TTL_MS"));
  assert.ok(prompt.length > 500, "found the prompt");
  ["500", "1200", "1800", "$"].forEach((bit) => {
    assert.equal(prompt.indexOf(bit), -1, "the prompt must not contain " + bit);
  });
});

test("the tier names on the page and in the assistant are the same names", async () => {
  const page = fs.readFileSync(path.join(repo, "pricing.html"), "utf8");
  const src = fs.readFileSync(path.join(here, "index.js"), "utf8");
  /* The prompt only. The file itself mentions the retired names in comments
     explaining why their keys are kept — that is not what the bot says. */
  const prompt = src.slice(src.indexOf("const SYSTEM_PROMPT"), src.indexOf("const SESSION_TTL_MS"));
  /* Two places is one too many already; at least make them disagree loudly.
     A visitor reading Tier 2 must not be told about a Gallery package. */
  ["Home &amp; Contact Site", "Home, Gallery &amp; Contact Site", "Gallery Site + Scheduling"]
    .forEach((name) => assert.ok(page.includes(name), "pricing.html names " + name));
  ["Home & Contact Site", "Home, Gallery & Contact Site", "Gallery Site + Scheduling"]
    .forEach((name) => assert.ok(prompt.includes(name), "the assistant names " + name));
  ["3-Page Essential", "4-Page Gallery", "Operator: Website"].forEach((gone) => {
    assert.equal(prompt.indexOf(gone), -1, "the assistant still quotes " + gone);
    assert.equal(page.indexOf(gone), -1, "pricing.html still shows " + gone);
  });
});
