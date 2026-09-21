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
  // The retainer that keeps the site hosted, patched and looked after.
  assert.equal(by.tier1.monthly, 20);
  assert.equal(by.tier2.monthly, 75);
  assert.equal(by.tier3.monthly, 150);
  // The two scoped builds carry FLOORS, and must say so.
  assert.equal(by.crm.price, 2000);
  assert.equal(by.crm.monthly, 250);
  assert.equal(by.crm.from, true);
  assert.equal(by.platform.price, 5000);
  assert.equal(by.platform.monthly, 350);
  assert.equal(by.platform.from, true);
  assert.equal(by.platform.seatsIncluded, 2);
  assert.equal(by.platform.perSeat, 50);
  // A website tier is a list price, not a floor. If one ever gains `from`,
  // the CRM would stop calling it a list price and the copy would be wrong.
  ["tier1", "tier2", "tier3"].forEach((k) => assert.ok(!by[k].from, k + " is a list price"));
  // Custom is what you pick when none of the above applies. It has no figure.
  assert.equal(by.custom.price, null);
});

test("a floor is never shown as if it were a price", async () => {
  /* The CRM fills 2000 into the build fee for a Custom CRM exactly as it
     fills 1200 for a Tier 2. The only thing separating "this is the price"
     from "this is where it starts" is this line, so it is worth a test. */
  /* The shipped function, lifted out of the shared file and run — not a copy
     of it rewritten here, which would pass while the real one was broken. */
  const lead = fs.readFileSync(path.join(repo, "crm-lead.js"), "utf8");
  const from = lead.indexOf("  function feeHint(row)");
  const to = lead.indexOf("  global.LeadDetail");
  assert.ok(from > -1 && to > from, "found feeHint and money in crm-lead.js");
  const feeHint = new Function(lead.slice(from, to) + "\nreturn feeHint;")();
  assert.match(feeHint({ price: 1200, monthly: 75 }), /^List: \$1,200 build · \$75\/mo$/);
  assert.match(feeHint({ price: 2000, monthly: 250, from: true }), /^Starts at — scope it: from \$2,000/);
  assert.match(feeHint({ price: 5000, monthly: 350, from: true, seatsIncluded: 2, perSeat: 50, perSeatFrom: true }),
    /2 logins included, \$50\+\/mo each after$/);
  assert.equal(feeHint({ price: null }), "");
  assert.equal(feeHint(null), "");
  // And the page that renders it is the shared one, so both CRM pages agree.
  assert.ok(lead.includes("bindFeePrefill"), "crm-lead.js owns the prefill");
});

test("every tier carries a retainer, because the page now says so", async () => {
  /* pricing.html used to promise Tier 1 "No monthly subscription" and the
     home page "no monthly ransom to keep it online". Both are gone. If a tier
     ever loses its retainer, that copy has to change back — so fail here
     rather than leave the site making a promise the CRM contradicts. */
  const { call, crmTok } = await setup();
  const r = await call("GET", "/crm/packages", null, crmTok);
  r.data.packages.forEach((p) => {
    if (!/^tier\d$/.test(p.key)) return;
    assert.ok(p.monthly > 0, p.key + " must have a monthly retainer");
  });
  for (const f of ["pricing.html", "index.html"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    ["No monthly subscription", "no monthly fee to keep it online", "no monthly ransom"]
      .forEach((claim) => assert.equal(src.indexOf(claim), -1, f + " still claims: " + claim));
  }
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
    /* Plus a structural check below: the number scan only catches figures it
       knows, and the real mistake is pasting the table in. */
    for (const price of ["1200", "1800"]) {
      /* The number on its own, not part of a longer one and not a CSS length —
         max-width:1200px is a layout, not a price. */
      const hit = new RegExp("(?<![\\d.])" + price + "(?![\\d.]|px|ms|s\\b)").exec(src);
      assert.equal(hit, null,
        f + " looks like it contains the price " + price + " near: " +
        (hit ? JSON.stringify(src.slice(Math.max(0, hit.index - 40), hit.index + 40)) : ""));
    }
    /* Catches the figures no scan knows about — 2000 and 5000 cannot be
       searched for literally, because z-index:2000 is a real line in
       index.html. What cannot be innocent is the shape of the table. */
    for (const shape of [/price\s*:\s*\d/, /monthly\s*:\s*\d/, /perSeat\s*:\s*\d/]) {
      assert.equal(shape.test(src), false,
        f + " contains a price table (" + shape + ") — it belongs in the Worker");
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
  // The gallery is 12 photos. It was 15 in both places, and they must agree.
  assert.ok(page.includes("12-photo gallery page"), "pricing.html says 12 photos");
  assert.ok(prompt.includes("12 photos"), "the assistant says 12 photos");
  ["15-photo", "15 photos"].forEach((old) => {
    assert.equal(page.indexOf(old), -1, "pricing.html still says " + old);
    assert.equal(prompt.indexOf(old), -1, "the assistant still says " + old);
  });
  ["3-Page Essential", "4-Page Gallery", "Operator: Website"].forEach((gone) => {
    assert.equal(prompt.indexOf(gone), -1, "the assistant still quotes " + gone);
    assert.equal(page.indexOf(gone), -1, "pricing.html still shows " + gone);
  });
});

/* ── TURNAROUND ─────────────────────────────────────────────────────
 * Every turnaround is a promise with a condition attached: the clock starts
 * when the last thing we are waiting on arrives, not when someone says yes.
 * "48–72 hours" quoted without "from form, deposit and gallery photos" is a
 * different promise from the one being made, so the two live in one string and
 * these tests keep them there.
 */
async function packagesByKey() {
  const { call, crmTok } = await setup();
  const r = await call("GET", "/crm/packages", null, crmTok);
  assert.equal(r.status, 200);
  const by = {};
  r.data.packages.forEach((p) => { by[p.key] = p; });
  return by;
}

test("every sellable package says how long it takes", async () => {
  const by = await packagesByKey();
  Object.values(by)
    .filter((p) => !p.retired && p.key !== "custom")
    .forEach((p) => assert.ok(p.turnaround, `${p.key} has no turnaround`));
});

test("a turnaround in hours always carries what starts the clock", async () => {
  const by = await packagesByKey();
  Object.values(by)
    .filter((p) => p.turnaround && /\bhrs?\b|hour/i.test(p.turnaround))
    .forEach((p) => assert.match(p.turnaround, /\bfrom\b/i,
      `"${p.turnaround}" states hours without saying from what`));
});

test("the gallery tiers wait on photos and a deposit, and say so", async () => {
  const by = await packagesByKey();
  for (const key of ["tier2", "tier3"]) {
    assert.match(by[key].turnaround, /photo/i, `${key} must name the photos it waits on`);
    assert.match(by[key].turnaround, /deposit/i, `${key} must name the deposit`);
  }
});

test("tier 1 waits on payment, not a deposit or photos", async () => {
  const by = await packagesByKey();
  assert.match(by.tier1.turnaround, /payment/i);
  assert.ok(!/photo/i.test(by.tier1.turnaround), "tier 1 has no gallery to wait on");
});

/* Scoped work must not carry an hours figure at all - a number next to a build
   whose shape is not known yet is the one that gets held against you. */
test("the scoped builds quote no hours", async () => {
  const by = await packagesByKey();
  for (const key of ["crm", "platform"]) {
    assert.ok(!/\d/.test(by[key].turnaround),
      `${key}: "${by[key].turnaround}" puts a number on scoped work`);
  }
});

test("the public page states the condition wherever it states the hours", () => {
  const page = fs.readFileSync(path.join(repo, "pricing.html"), "utf8");
  const lines = [...page.matchAll(/<p class="plan-turnaround">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  assert.equal(lines.length, 3, "the three website tiers each state one");
  lines.forEach((line) => {
    assert.match(line, /hours/i);
    assert.match(line, /From your/i, `"${line}" gives hours with no condition`);
  });
});

/* The page carried "72-Hour Turnaround / as little as 3 days" long before the
   per-tier times existed, and the two disagreed in both directions: the floor
   is 24 hours, not 3 days. One page must not quote two different fastest
   times, so the headline is checked against the tiers under it. */
test("the headline turnaround agrees with the tiers beneath it", () => {
  const page = fs.readFileSync(path.join(repo, "pricing.html"), "utf8");
  const label = page.match(/<p class="perk-label">([^<]*Turnaround[^<]*)<\/p>/);
  const sub = page.match(/<p class="perk-label">[^<]*Turnaround[^<]*<\/p>\s*<p class="perk-sub">([^<]*)<\/p>/);
  assert.ok(label && sub, "the turnaround perk is still on the page");

  const tierHours = [...page.matchAll(/<p class="plan-turnaround">[\s\S]*?(\d+)\u2013(\d+) hours/g)];
  assert.equal(tierHours.length, 3, "three tiers state an hour range");
  const fastest = Math.min(...tierHours.map((m) => Number(m[1])));
  const slowest = Math.max(...tierHours.map((m) => Number(m[2])));

  assert.ok(label[1].includes(String(slowest)),
    `headline "${label[1]}" does not carry the slowest tier (${slowest}h)`);
  assert.ok(sub[1].includes(String(fastest)),
    `subtitle "${sub[1]}" does not carry the fastest tier (${fastest}h)`);
  assert.ok(!/\bdays?\b/i.test(sub[1]),
    `subtitle "${sub[1]}" still talks in days while the tiers talk in hours`);
});
