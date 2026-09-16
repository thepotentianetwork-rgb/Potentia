/* sample.html is a marketing page that looks exactly like the CRM.
 *
 * That resemblance is the whole point, and it is also the risk: the easiest
 * way to "update the sample" later is to paste in a real screen's data. These
 * checks make that fail loudly instead of quietly publishing a client's
 * customer list.
 *
 * Run: node --test worker/sample.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, "..", "sample.html"), "utf8");

test("the sample cannot reach the network", () => {
  /* No fetch, no XHR, no API base, no token. If it cannot call anything, it
     cannot show anything real, whatever anyone edits into it later. */
  for (const forbidden of ["fetch(", "XMLHttpRequest", "API_BASE", "Authorization",
                           "localStorage", "potentia_crm_token", "workers.dev"]) {
    assert.equal(page.indexOf(forbidden), -1,
      "sample.html must not contain " + forbidden);
  }
});

test("every phone number is a reserved fictional one", () => {
  /* 555-01xx is reserved for fiction. Any other shape is somebody's phone. */
  const numbers = page.match(/\(?\b\d{3}\)?[ .-]\d{3}[ .-]?\d{0,4}\b/g) || [];
  numbers.forEach((n) => {
    const digits = n.replace(/\D/g, "");
    assert.ok(/^555/.test(digits) || digits.length < 7,
      "found what looks like a real phone number: " + n);
  });
});

test("every email address is on a reserved domain", () => {
  const emails = page.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  assert.ok(emails.length > 0, "the sample is supposed to show email addresses");
  emails.forEach((e) => {
    assert.ok(/@(example\.(com|org|net)|.*\.example\.com)$/i.test(e),
      "email must be on a reserved domain (RFC 2606): " + e);
  });
});

test("the websites it shows are reserved names too", () => {
  /* A plausible-looking domain in a sample is somebody's actual website. */
  const hosts = page.match(/https?:\/\/[A-Za-z0-9.-]+/g) || [];
  hosts.forEach((h) => {
    const host = h.replace(/^https?:\/\//, "");
    assert.ok(/(^|\.)example\.com$/i.test(host) || /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(host),
      "sample sites must be example.com: " + h);
  });
});

test("it says it is a sample, above the fold and in the markup", () => {
  const bar = page.indexOf("sample-bar");
  const main = page.indexOf("<main");
  assert.ok(bar > -1 && bar < main, "the sample banner must come before the content");
  assert.match(page, /Every name, number and figure on this page is invented/);
  assert.match(page, /fabricated/);
});

test("no client of ours is named in it", () => {
  /* The sample is a made-up company. Naming a real client beside invented
     revenue figures reads as if those were theirs. */
  ["ShedPro", "shedpro", "Chonis", "chonis", "Juan's", "juansauto", "tirepros", "Tire Pros"]
    .forEach((name) => assert.equal(page.indexOf(name), -1,
      "sample.html must not name a real client: " + name));
});

test("it is reachable from the rest of the site", () => {
  /* A demo nobody can find is a file, not a demo. */
  for (const f of ["index.html", "pricing.html", "portfolio.html", "contact.html"]) {
    const src = fs.readFileSync(path.join(here, "..", f), "utf8");
    assert.ok(src.includes('href="sample.html"'), f + " must link to the sample");
  }
});
