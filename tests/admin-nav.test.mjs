/* ONE NAV, SIX PAGES.
 *
 * Every admin page used to write its own header bar, and they had drifted:
 * Activity had no link to Data, Pricing appeared on two pages out of six, and
 * the same destination was called "Customers" on one and "All Customers" on
 * another. Nothing failed — you just could not get somewhere from somewhere.
 *
 * The first half of this reads the pages as files and fails if any of them
 * starts hand-writing links again. The second drives the real menu in a real
 * browser, because a dropdown that will not open is a nav bar with nothing
 * in it.
 *
 * Run: node tests/admin-nav.test.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 240) : '')); } };

const PAGES = ['admin-dashboard.html', 'admin.html', 'admin-customer.html',
               'admin-schedule.html', 'admin-activity.html', 'admin-data.html',
               'admin-pricing.html'];

console.log('\n-- every page uses the shared nav --');
const files = {};
for (const f of PAGES) files[f] = readFileSync(path.join(root, f), 'utf8');

for (const f of PAGES) {
  const src = files[f];
  check(f + ' loads admin-nav.js', src.includes('<script src="admin-nav.js"></script>'));
  check(f + ' renders it', /AdminNav\.render\(/.test(src));

  /* The thing that drifted. A hand-written <a> in the header is how six
     different navs happened in the first place. */
  const bar = (/<div class="h-actions">([\s\S]*?)<\/div>/.exec(src) || [])[1] || '';
  check(f + ' hand-writes no links', !/<a\s/.test(bar), bar.trim().slice(0, 120));
}

/* ---- nobody hand-rolls a phone link ------------------------------------
   This shop works off Google Voice. tel: dials from whatever SIM is in the
   phone and sms: texts from the handset's own number, so both are the wrong
   number to a customer — and both were sitting on three pages at once before
   admin-voice.js existed. The same drift as the nav, caught the same way. */
console.log('\n-- calls and texts go through Google Voice --');
for (const f of PAGES) {
  const src = files[f];
  check(f + ' hand-writes no tel: or sms: link',
    !/["']tel:|["']sms:/.test(src),
    (/["'](?:tel|sms):[^"']*/.exec(src) || [''])[0]);
  /* A page that dials has to load the shared helpers, or AdminVoice is
     undefined and the control silently never renders. */
  if (/AdminVoice/.test(src)) {
    check(f + ' loads admin-voice.js',
      src.includes('<script src="admin-voice.js"></script>'));
  }
}
check('the helpers themselves are one file',
  readFileSync(path.join(root, 'admin-voice.js'), 'utf8').includes('voice.google.com'));

/* The list of pages lives in one file; every page in it must exist, or the
   menu offers a 404. */
const nav = readFileSync(path.join(root, 'admin-nav.js'), 'utf8');
const listed = [...nav.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
console.log('\n-- the menu points at pages that exist --');
check('six destinations', listed.length === 6, listed);
for (const href of listed) {
  check(href + ' is a real page', PAGES.includes(href), listed);
}
/* And every admin page is reachable from it — a page nobody can navigate to
   is a page nobody uses. admin-login is deliberately not in the menu. */
for (const f of PAGES) {
  if (f === 'admin-customer.html') continue;   // reached from the customer list
  check(f + ' is reachable from the menu', listed.includes(f), listed);
}

try { readFileSync(CHROME); } catch {
  console.log('\nChromium not present — skipping the live half.');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
}

// ---- the menu, opened and closed by a browser ---------------------------
let report = null;
const srv = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__result') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { report = JSON.parse(b); } catch {} res.writeHead(204).end(); });
    return;
  }
  if (req.url === '/admin-nav.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(nav);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--black:#040407;--chrome:#c8cdd6;--silver:#8a909e;--bright:#e8ecf4;--dim:#2a2d38;--sp-blue:#2cc0fd;--sp-orange:#f6941f}
    body{background:var(--black)}</style></head><body>
    <header><div class="h-actions"><button class="logout" id="logout-btn">Log Out</button></div></header>
    <script src="/admin-nav.js"></script>
    <script>
    var R = {};
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
    function txt(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim()}
    try{
      /* Pretending to be the schedule page, so "current" has something to find. */
      AdminNav.render(document.querySelector('.h-actions'), { current: 'admin-schedule.html' });
      var btn = document.getElementById('nav-btn');
      var menu = document.getElementById('nav-menu');

      R.buttonSaysWhereYouAre = txt(btn);
      R.startsClosed = menu.hidden;
      R.logoutSurvived = !!document.getElementById('logout-btn');

      btn.click(); await0();
      function await0(){}
      R.opensOnTap = !menu.hidden;
      R.items = [].slice.call(menu.querySelectorAll('.nav-item')).map(txt);
      R.hrefs = [].slice.call(menu.querySelectorAll('.nav-item'))
        .map(function(a){return a.getAttribute('href')});
      R.currentMarked = [].slice.call(menu.querySelectorAll('.nav-item.current'))
        .map(function(a){return a.getAttribute('href')});

      AdminNav.setCount(3);
      R.badges = [].slice.call(document.querySelectorAll('.act-badge'))
        .map(function(b){return b.style.display === 'none' ? null : txt(b)});
      AdminNav.setCount(0);
      R.badgesCleared = [].slice.call(document.querySelectorAll('.act-badge'))
        .every(function(b){return b.style.display === 'none'});

      document.body.click();
      R.closesOnOutsideTap = menu.hidden;
      btn.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      R.closesOnEscape = menu.hidden;
    }catch(e){R.threw=String((e&&e.stack)||e)}
    fetch('/__result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(R)});
    </script></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

await new Promise((resolve) => {
  execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--virtual-time-budget=12000', '--dump-dom', 'http://127.0.0.1:' + PORT + '/'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 }, () => resolve());
});
srv.close();

const R = report || {};
console.log('\n-- the menu, in a browser --');
check('it reported back', !!report, '(nothing)');
check('nothing threw', !R.threw, R.threw);
check('the button names the page you are on',
  /^Schedule/.test(R.buttonSaysWhereYouAre || ''), R.buttonSaysWhereYouAre);
check('it starts closed', R.startsClosed === true);
check('and the page’s own buttons survive', R.logoutSurvived === true);
check('tapping opens it', R.opensOnTap === true);
check('with every page on it',
  JSON.stringify(R.items || []).replace(/\d+/g, '') ===
  JSON.stringify(['Dashboard', 'Customers', 'Schedule', 'Activity', 'Data', 'Pricing']), R.items);
check('the page you are on is marked, once',
  JSON.stringify(R.currentMarked) === '["admin-schedule.html"]', R.currentMarked);
/* Two badges, one number: the button and the menu item must not disagree
   about how much is waiting. */
check('the count shows on the button and in the menu',
  (R.badges || []).filter((b) => b === '3').length === 2, R.badges);
check('and clears from both', R.badgesCleared === true);
check('tapping away closes it', R.closesOnOutsideTap === true);
check('and so does Escape', R.closesOnEscape === true);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
