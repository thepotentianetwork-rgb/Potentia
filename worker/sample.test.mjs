/* sample.html is the public page about the platform.
 *
 * It used to be a working sample of the real CRM, and the problem with that
 * was not the invented data — it was everything the interface gave away for
 * free. Pipeline stages, job specs, what gets flagged and when: a competitor
 * reading it learns how the software is put together and how our clients run
 * their shops. So the page is now capability-level only, and these checks
 * keep it there.
 *
 * Run: node --test worker/sample.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const page = fs.readFileSync(path.join(repo, "sample.html"), "utf8");

test("the page cannot reach the network", () => {
  /* No fetch, no XHR, no API base, no token. If it cannot call anything it
     cannot show anything real, whatever anyone edits into it later. */
  for (const forbidden of ["fetch(", "XMLHttpRequest", "API_BASE", "Authorization",
                           "localStorage", "potentia_crm_token", "workers.dev"]) {
    assert.equal(page.indexOf(forbidden), -1, "sample.html must not contain " + forbidden);
  }
});

test("it holds no customer records of any kind", () => {
  /* Not "no real records" — none at all. Invented ones still show the shape
     of the thing: what fields exist, what a row carries, what gets tracked
     against a customer. The page names no people and keeps no contact
     details, so there is nothing to read off it. */
  assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(page), false,
    "no email addresses");
  assert.equal(/\(\d{3}\)\s?\d{3,4}/.test(page), false, "no phone numbers");
  assert.equal(/\$[\d,]+/.test(page), false, "no money figures");
});

test("it does not lay out how the software works inside", () => {
  /* The stage names, the flags and the field labels are the design of the
     product and of a client's process. Describing what the software is FOR
     is the job of this page; showing its working parts is not. */
  /* Named stages, a status control and a record table are the three ways
     this has crept back before. "Enquiry" as an ordinary English word is
     fine — a NAMED SEQUENCE of stages is not, and that is what a table of
     records with a status picker amounts to. */
  const insides = ["proofing", "on press", "pipeline stage", "status-sel",
                   "<table", "<th>", "data-label", "<select"];
  insides.forEach((bit) => assert.equal(page.toLowerCase().indexOf(bit.toLowerCase()), -1,
    "sample.html gives away an internal: " + JSON.stringify(bit)));
});

test("it says nothing about website performance", () => {
  /* How we find leads is our own tooling, it is not what this page sells,
     and to a visitor it reads as "we are grading your website" — a different
     conversation from the one the page is for. */
  ["PageSpeed", "pagespeed", "mobile speed", "/100", "No website", "no website",
   "Lighthouse", "no https", "speed test", "SEO", "load time"]
    .forEach((word) => assert.equal(page.indexOf(word), -1,
      "sample.html must not mention " + JSON.stringify(word)));
  /* Not a count of the word: "viewport" appears in the meta tag every page
     carries, and in the comment explaining why no viewport is sent to a tile
     host. What must not appear is the lead-scoring phrasing. */
  [/no mobile viewport/i, /missing viewport/i, /mobile view\b/i]
    .forEach((re) => assert.equal(re.test(page), false, "lead-scoring phrasing: " + re));
});

test("the map is drawn here, not fetched from a map service", () => {
  ["leaflet", "Leaflet", "mapbox", "openstreetmap", "OpenStreetMap", "tile.",
   "arcgis", "google.com/maps"]
    .forEach((dep) => assert.equal(page.indexOf(dep), -1, "the map must not depend on " + dep));
  assert.match(page, /createElementNS/);
  assert.match(page, /outline:/);
});

test("the map says it is an illustration, and plots nothing findable", () => {
  assert.match(page, /the points are made up/i);
  /* Two decimals is about a kilometre. The real product plots the address on
     the job; this page must not look like it could. */
  const coords = page.match(/lat: (-?\d+\.\d+)/g) || [];
  assert.ok(coords.length > 0, "the map has points");
  coords.forEach((c) => {
    const decimals = /\.(\d+)/.exec(c)[1];
    assert.ok(decimals.length <= 3, "coordinate precise enough to be a building: " + c);
  });
});

test("no client of ours is named", () => {
  ["ShedPro", "shedpro", "Chonis", "chonis", "Juan's", "juansauto", "tirepros", "Tire Pros"]
    .forEach((name) => assert.equal(page.indexOf(name), -1,
      "sample.html must not name a client: " + name));
});

test("it stays short", () => {
  /* Every version of this page has grown back. The point of it is to say
     what we build, not to demonstrate it. */
  const lines = page.split("\n").length;
  assert.ok(lines < 320, "sample.html has grown to " + lines + " lines");
});

test("it is reachable from the rest of the site", () => {
  for (const f of ["index.html", "pricing.html", "portfolio.html", "contact.html"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    assert.ok(src.includes('href="sample.html"'), f + " must link to it");
  }
});
