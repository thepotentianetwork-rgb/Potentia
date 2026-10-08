/* THE PORTAL HAS TO BE REACHABLE AT EVERY WIDTH, NOT JUST PRESENT IN THE HTML.
 *
 * tests/client-login-link.test.mjs checks the markup. That stopped being
 * enough the moment the link went behind a hamburger: below 1025px the nav
 * links are display:none and the overlay is the ONLY way to the portal, so a
 * link that is in the file can still be unreachable by anyone.
 *
 * It also guards the other half. Six items do not fit a tablet - flexbox
 * squeezes them until "Client Login" wraps onto two lines and the links touch
 * the logo and the buttons. That reads as broken while measuring as fine: the
 * nav's scrollWidth never exceeds its clientWidth, and every anchor keeps the
 * same top, because the wrap happens INSIDE one anchor. Two checks that do see
 * it: a minimum clearance either side (touching at exactly 0 is the failure
 * mode, not overlapping), and an anchor taller than one line.
 *
 * Run: node tests/nav-client-login.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAtWidth, CHROME } from './phone.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); } };

try { readFileSync(CHROME); } catch {
  console.log('Chromium not present — skipping.');
  process.exit(0);
}

const PORTAL = 'https://portal.potentianetwork.com/login';
const MIN_GAP = 12;  // tighter than this reads as collided whatever the maths says

/* Widths chosen around the two breakpoints the nav now has, plus one either
   side of each: a phone, the old breakpoint, the last hamburger width, the
   first full-nav width, and a normal laptop. */
const WIDTHS = [390, 769, 900, 1024, 1025, 1100, 1280];

/* Found by markup, so a new page with a nav is covered the day it lands. */
const PAGES = readdirSync(root).filter((f) => f.endsWith('.html'))
  .filter((f) => readFileSync(path.join(root, f), 'utf8').includes('<div class="nav-links">'));

/* Appended to the real page: opens the menu if there is one, then reports what
   a visitor could actually reach. Runs in the page, so it sees computed styles
   and real boxes. */
const PROBE = `<script>
(function(){
  var vis = function(e){ if(!e) return false; var s=getComputedStyle(e), b=e.getBoundingClientRect();
    return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0 && b.width>0 && b.height>0; };
  var links = document.querySelector('.nav-links');
  var ham   = document.querySelector('.nav-ham');
  var out   = { mode:null, href:null, reachable:false };
  if (vis(ham)) {
    out.mode = 'hamburger';
    ham.click();
    var ov = document.querySelector('.mob-overlay');
    var a = [].slice.call(ov ? ov.querySelectorAll('a') : [])
             .filter(function(x){ return /client login/i.test(x.innerText); })[0];
    if (a && vis(ov) && vis(a)) {
      var b = a.getBoundingClientRect();
      // What is actually on top at the middle of the link: an overlay sitting
      // behind something hands back the other element.
      var hit = document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
      out.href = a.getAttribute('href');
      out.onTop = hit===a || a.contains(hit);
      out.inView = b.top>=0 && b.bottom<=innerHeight && b.left>=0 && b.right<=innerWidth;
      out.reachable = !!(out.onTop && out.inView);
    }
  } else if (vis(links)) {
    out.mode = 'full nav';
    var a2 = [].slice.call(links.querySelectorAll('a'))
              .filter(function(x){ return /client login/i.test(x.innerText); })[0];
    var right = document.querySelector('.nav-right') || document.querySelector('.nav-cta');
    var logo  = document.querySelector('.nav-logo');
    var L = links.getBoundingClientRect();
    out.gapRight = (right && vis(right)) ? Math.round(right.getBoundingClientRect().left - L.right) : null;
    out.gapLogo  = logo ? Math.round(L.left - logo.getBoundingClientRect().right) : null;
    // A label wrapping inside ONE anchor keeps its neighbours' top, so height
    // against line-height is what sees it.
    out.wrapped = [].slice.call(links.querySelectorAll('a')).filter(function(x){
      var b=x.getBoundingClientRect(), cs=getComputedStyle(x);
      var lh=parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.2;
      return b.height > lh*1.5; }).map(function(x){ return x.innerText.trim(); });
    if (a2 && vis(a2)) { out.href = a2.getAttribute('href'); out.reachable = true; }
  }
  out.sideScroll = Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth);
  window.__R = out;
})();
</script>`;

/* sample.html has no hamburger and no mobile menu - it has never had one, so
   below its 861px breakpoint it shows no navigation at all. That predates the
   Client Login link (the same widths were bare with five items) and giving the
   page a menu is a design change, not a fix to make here.
   The exception is kept honest by deriving it from the markup rather than
   naming pages: the day sample.html gets a hamburger it stops being exempt
   automatically, and the day another page LOSES one, that page starts failing
   instead of silently joining the list. */
const hasMenu = (f) => readFileSync(path.join(root, f), 'utf8').includes('class="nav-ham"');
const NO_MENU = PAGES.filter((f) => !hasMenu(f));

console.log('\n-- pages without a mobile menu (known, pre-existing) --');
check('only sample.html lacks one', NO_MENU.length === 1 && NO_MENU[0] === 'sample.html', NO_MENU);

console.log('\n-- the portal is reachable at every width --');
for (const f of PAGES) {
  const html = readFileSync(path.join(root, f), 'utf8').replace('</body>', PROBE + '</body>');
  for (const width of WIDTHS) {
    const r = await runAtWidth({ width, height: 820, html });
    const at = `${f} @${width}`;

    /* Either route is fine; having neither is a page with no way to the
       portal, which is the whole failure this guards - except on a page that
       has no mobile menu to reach it with, below the width its nav hides at. */
    const exempt = NO_MENU.includes(f) && r.mode === null;
    if (exempt) { console.log(`  --   ${at}: no nav here, and no menu on this page (known)`); }
    else check(`${at}: reachable (${r.mode || 'NO NAV'})`, r.reachable, r);
    if (r.reachable && !exempt) check(`${at}: points at the portal`, r.href === PORTAL, r.href);
    if (r.mode === 'full nav') {
      check(`${at}: nothing wrapped`, !r.wrapped.length, r.wrapped);
      if (r.gapRight !== null) check(`${at}: clear of the buttons`, r.gapRight >= MIN_GAP, r.gapRight);
      if (r.gapLogo !== null) check(`${at}: clear of the logo`, r.gapLogo >= MIN_GAP, r.gapLogo);
    }
    check(`${at}: no side-scroll`, r.sideScroll <= 0, r.sideScroll);
  }
}

console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n');
process.exit(fails ? 1 : 0);
