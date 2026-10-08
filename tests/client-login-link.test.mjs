/* THE CLIENT LOGIN LINK HAS TO BE ON EVERY PAGE WITH A NAV.
 *
 * The portal at portal.potentianetwork.com was reachable from the nav until it
 * quietly wasn't. The link went in pointing at the raw Vercel URL, got
 * repointed to the custom domain in July, and then disappeared from the markup
 * altogether — so the portal stayed up for months with no way to reach it from
 * the website. A client who lost their bookmark had nothing to click.
 *
 * Nothing catches that by reading a diff. The nav lives inline in four files
 * edited weeks apart, each of which looks perfectly fine on its own, and the
 * portal being up means no error anywhere points at the website.
 *
 * Two things are checked, and the second is the one that bit:
 *   - every nav has the link, desktop AND mobile (the mobile overlay is a
 *     separate copy of the list — half a nav is how a link goes missing on
 *     phones only)
 *   - it points at the custom domain, not the raw *.vercel.app host, which
 *     now 404s
 *
 * Run: node tests/client-login-link.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 300) : '')); } };

const PORTAL = 'https://portal.potentianetwork.com/login';
/* The raw Vercel host the link used to use. It 404s now — the deployment is
   served from the custom domain — so a link that drifts back to it is dead. */
const DEAD_HOST = /[a-z0-9-]+\.vercel\.app/i;

/* Pages carrying the public marketing nav. Found by the markup rather than
   listed, so a new page with a nav is covered the day it lands instead of the
   day someone remembers this file. */
const pages = readdirSync(root)
  .filter((f) => f.endsWith('.html'))
  .map((f) => ({ f, src: readFileSync(path.join(root, f), 'utf8') }))
  .filter((p) => p.src.includes('<div class="nav-links">'));

console.log('\n-- the portal is reachable from the site --');
check('there are pages with a public nav to check', pages.length >= 4, pages.map((p) => p.f));

for (const { f, src } of pages) {
  const desktop = (src.match(/<div class="nav-links">[\s\S]*?<\/div>/) || [''])[0];
  /* sample.html has a desktop nav and no hamburger menu at all. Checking a
     mobile menu that does not exist would just be a failure nobody can fix,
     so the menu is checked where there is one. */
  const mobMatch = src.match(/<div class="mob-overlay"[\s\S]*?<\/div>/);

  const blocks = [['desktop', desktop]];
  if (mobMatch) blocks.push(['mobile', mobMatch[0]]);

  for (const [where, block] of blocks) {
    check(f + ': ' + where + ' nav has Client Login', block.includes('Client Login'));
    /* The href has to be on the Client Login anchor itself. A page can hold
       the right URL somewhere else entirely and still have a nav link
       pointing nowhere useful. */
    const anchors = [...block.matchAll(/<a\s+href="([^"]+)"[^>]*>Client Login<\/a>/g)].map((m) => m[1]);
    check(f + ': ' + where + ' Client Login points at the portal',
      anchors.length === 1 && anchors[0] === PORTAL, anchors);
  }
}

console.log('\n-- no page links the dead Vercel host --');
for (const { f, src } of readdirSync(root).filter((x) => x.endsWith('.html'))
     .map((x) => ({ f: x, src: readFileSync(path.join(root, x), 'utf8') }))) {
  const hit = src.match(DEAD_HOST);
  check(f + ': no *.vercel.app link', !hit, hit && hit[0]);
}

/* Opening the portal must not take the client off the marketing site in the
   same tab — they come back to the site to read pricing, not to re-navigate. */
console.log('\n-- it opens in a new tab, safely --');
for (const { f, src } of pages) {
  const anchors = [...src.matchAll(/<a\s[^>]*>Client Login<\/a>/g)].map((m) => m[0]);
  /* One per nav the page has: two for a page with a hamburger menu, one for
     sample.html, which has no mobile menu. Zero would mean the page slipped
     past the checks above. */
  const want = src.includes('<div class="mob-overlay"') ? 2 : 1;
  check(f + ': has ' + want + ' Client Login link(s)', anchors.length === want, anchors.length);
  check(f + ': every Client Login link opens in a new tab',
    anchors.length === want && anchors.every((a) => a.includes('target="_blank"')), anchors);
  check(f + ': every one carries rel="noopener"',
    anchors.length === want && anchors.every((a) => a.includes('rel="noopener"')), anchors);
}

console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n');
process.exit(fails ? 1 : 0);
