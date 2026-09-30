/* THE MENU MUST BE ON THE SCREEN.
 *
 * It was not. The menu hangs off the button's RIGHT edge — correct on a
 * desktop, where the header sits at the top right. On a phone the header
 * wraps, the button lands against the LEFT margin, and a 190px menu anchored
 * to the right edge of a button 80px in runs ~90px off the side of the glass.
 * Customers, Schedule and Activity were out there. Nothing threw, nothing
 * looked broken, and every existing test passed: the panel renders, the items
 * are in the DOM, the hrefs are right, it opens and closes. They are simply
 * not where anyone can read them.
 *
 * No test could have caught it, either, because headless Chrome refuses a
 * viewport under 500px — at 500 the header does not wrap and the bug does not
 * happen. So this drives Chrome over the DevTools protocol at a real 390
 * (see tests/phone.mjs) and measures where the menu actually lands.
 *
 * Run: node tests/nav-phone.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAtWidth, CHROME } from './phone.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const nav = readFileSync(path.join(root, 'admin-nav.js'), 'utf8');

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); } };

try { readFileSync(CHROME); } catch {
  console.log('Chromium not present — skipping.');
  process.exit(0);
}

/* The real header rules, lifted from admin-customer.html rather than invented
   here — the wrap is the whole precondition, and a test carrying its own
   simplified CSS would stop wrapping the day the real page changed. */
const page = readFileSync(path.join(root, 'admin-customer.html'), 'utf8');
function rule(sel) {
  const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*\\}').exec(page);
  if (!m) throw new Error('could not find the ' + sel + ' rule in admin-customer.html');
  return m[0];
}
/* The WHOLE brand block, not just the title. The subtitle is what pushes the
   header past the width of a phone and makes it wrap, and the wrap is the
   precondition for the bug — a test carrying a trimmed-down brand does not
   wrap, measures the desktop case and passes on a broken page. Caught by the
   wrap assertion below on the first run. */
const HEADER_CSS = [rule('header'), rule('.h-actions'), rule('.h-brand'),
                    rule('.h-brand img'), rule('.h-brand-text'),
                    rule('.h-title'), rule('.h-sub')].join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--black:#040407;--chrome:#c8cdd6;--silver:#8a909e;--bright:#e8ecf4;--dim:#2a2d38;--sp-blue:#2cc0fd;--sp-orange:#f6941f}
*{box-sizing:border-box}body{margin:0;background:var(--black)}
${HEADER_CSS}
</style></head><body>
<header>
  <div class="h-brand">
    <img src="/logo.png" alt="ShedPro">
    <div class="h-brand-text">
      <span class="h-title">SHEDPRO ADMIN</span>
      <span class="h-sub">Built &amp; managed by Potentia</span>
    </div>
  </div>
  <div class="h-actions"><button class="logout" id="logout-btn">Log Out</button></div>
</header>
<script src="/admin-nav.js"></script>
<script>
var R={};
function box(el,name){var r=el.getBoundingClientRect();
  return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),w:Math.round(r.width)};}
try{
  AdminNav.render(document.querySelector('.h-actions'), { current:'admin-customer.html' });
  var btn=document.getElementById('nav-btn'), menu=document.getElementById('nav-menu');
  R.vw=document.documentElement.clientWidth;
  R.btnClosed=box(btn);
  btn.click();
  R.menu=box(menu);
  R.btn=box(btn);
  /* Did the header actually wrap? If it did not, the button is still on the
     right and this test is measuring the desktop case by accident. */
  R.wrapped = R.btn.t > box(document.querySelector('.h-brand')).t;
  R.items=[].slice.call(menu.querySelectorAll('.nav-item')).map(function(a){
    var r=a.getBoundingClientRect();
    return {href:a.getAttribute('href'),l:Math.round(r.left),r:Math.round(r.right)};
  });
  /* THE NUDGE MUST BE TAKEN BACK when it is no longer needed. Dropping the
     brand un-wraps the header and returns the button to the right, exactly as
     rotating the phone to landscape would. If the menu keeps the shift
     portrait needed, it now hangs off the RIGHT instead — the same bug,
     mirrored, and only visible on a second open. */
  /* SHRUNK, not removed. Removing the brand leaves the actions as the only
     child of a space-between row, which pins them LEFT — un-wrapped but still
     on the wrong side, so the button never returns to the right and the stale
     shift is never exercised. Making the brand narrow is what actually
     reproduces a landscape rotation. */
  document.querySelector('.h-brand-text').innerHTML = '<span class="h-title">X</span>';
  window.dispatchEvent(new Event('resize'));
  R.afterUnwrap = box(menu);
  R.btnAfter = box(btn);
}catch(e){R.threw=String(e&&e.stack||e)}
window.__R=R;
</script></body></html>`;

const r = await runAtWidth({ width: 390, html,
  files: { '/admin-nav.js': { type: 'text/javascript', body: nav } } });

console.log('\n-- the admin menu at 390px --');
check('nothing threw', !r.threw, r.threw);
check('the viewport really is a phone', r.vw === 390, r.vw);
/* The precondition. At 500px the header does not wrap, the button stays on
   the right and the menu was always fine — which is exactly why this went
   unnoticed. If this fails the rest is measuring the wrong thing. */
check('the header wraps, putting the button on the left', r.wrapped && r.btn.l < r.vw / 2,
      { wrapped: r.wrapped, btn: r.btn });

check('the menu opens', !!r.menu && r.menu.w > 0, r.menu);
check('the menu does not run off the left edge', r.menu.l >= 0, r.menu);
check('the menu does not run off the right edge', r.menu.r <= r.vw, { menu: r.menu, vw: r.vw });
check('the menu is no wider than the screen', r.menu.w <= r.vw, { w: r.menu.w, vw: r.vw });

/* Every destination readable, not just the panel on screen. The panel could
   sit inside the viewport with its items clipped out of it. */
check('all five destinations are on the screen', r.items.length === 5, r.items);
for (const it of r.items || []) {
  check(it.href + ' is readable', it.l >= 0 && it.r <= r.vw, it);
}

/* Re-laid out under it — the stale-shift case. */
check('the button returns to the right when the header un-wraps',
      r.btnAfter && r.btnAfter.r > r.vw / 2, r.btnAfter);
check('the menu is still on the screen after re-laying out',
      r.afterUnwrap && r.afterUnwrap.l >= 0 && r.afterUnwrap.r <= r.vw,
      { menu: r.afterUnwrap, vw: r.vw });
/* AND HANGING FROM THE BUTTON AGAIN. This is the assertion that catches a
   stale nudge, and "still on the screen" is not — in this geometry a menu
   carrying portrait's 91px shift lands at 196..366 on a 390 screen, which is
   entirely on the glass and entirely wrong: a panel floating 91px away from
   the control that opened it. The CSS anchor puts its right edge on the
   button's, so that is what to measure. */
check('the menu hangs from the button again, with no stale nudge',
      r.afterUnwrap && r.btnAfter && Math.abs(r.afterUnwrap.r - r.btnAfter.r) <= 1,
      { menu: r.afterUnwrap, btn: r.btnAfter });

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
