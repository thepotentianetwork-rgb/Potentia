/* THE CLIENT ONBOARDING SHEET, IN A REAL BROWSER.
 *
 * This form exists because the two intake forms were missing the things a
 * Google Business Profile actually needs. So the test is mostly about those
 * fields being present and leaving the page correctly — a sheet that looks
 * complete and arrives with the category or the payment methods missing sends
 * somebody back to the client to ask again, which is the whole thing this was
 * built to stop.
 *
 * Both destinations are checked. The sheet goes to Formspree AND to the CRM,
 * and the CRM copy is the one that is machine-readable, so that is the one
 * whose shape matters: checkbox groups have to arrive as arrays, not as a
 * single value silently overwriting its siblings.
 *
 * Chromium is driven with execFile and AWAITED, not execFileSync — the sync
 * form blocks the event loop this file's own stub server runs on, and the run
 * deadlocks. Written down twice in this project already.
 *
 * Run: node tests/onboarding-form.test.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 240) : '')); } };

const FORM = readFileSync(path.join(here, '..', 'onboardingform.html'), 'utf8');

/* ---- 1. the fields the paper sheet asks for ---------------------------- */
console.log('\n-- every field from the onboarding sheet --');
/* Named here rather than counted, so a field that quietly disappears is named
   in the failure instead of showing up as "expected 18, got 17". */
const WANT = {
  business_name: 'Business name',
  owner_name: 'Owner / contact name',
  legal_name: 'Legal / display business name',
  google_category: 'Business category',
  phone: 'Business phone',
  email: 'Business email',
  address: 'Physical address',
  service_area: 'Service area',
  location_type: 'In-shop / mobile / both',
  hours: 'Business hours',
  story: 'Business story',
  years_exp: 'Years in business',
  svc_name_1: 'Services table',
  svc_price_1: 'Service price',
  svc_included_1: "What's included",
  contact_pref: 'Preferred contact method',
  social: 'Social media handles',
  payment: 'Payment methods',
  anything_else: 'Anything else'
};
for (const [name, label] of Object.entries(WANT)) {
  check(label + ' (name="' + name + '")', FORM.includes('name="' + name + '"'));
}

/* The one field the paper sheet has that this page deliberately does NOT: the
   client's Google account. Potentia creates those accounts, so asking is both
   pointless and an invitation to type a password into a web form. */
console.log('\n-- and the one it deliberately leaves out --');
check('it does not ask for a Google account login',
  !/google_account|google_login|password/i.test(FORM));

/* ---- 2. it is the onboarding sheet, not a copy of the intake form ------- */
console.log('\n-- it is its own form --');
check('it tells Formspree which sheet this is',
  /name="form_type" value="onboarding"/.test(FORM));
check('and names the email subject for it',
  /name="_subject" value="New Potentia Client Onboarding Sheet"/.test(FORM));
check('it does not carry the intake form’s fields',
  !/name="(trade|project_type|site_goal|domain)"/.test(FORM));

/* ---- 3. in a browser ---------------------------------------------------- */
let haveChrome = true;
try { readFileSync(CHROME); } catch { haveChrome = false; }
if (!haveChrome) {
  console.log('\n  (Chromium not present — skipping the live half)');
} else {
  const posts = [];
  const srv = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'POST') {
      const ch = []; for await (const c of req) ch.push(c);
      posts.push({ url: req.url, body: Buffer.concat(ch).toString() });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  const page = FORM
    .replace(/action="[^"]*"/, 'action="' + BASE + '/formspree"')
    .replace(/var CRM_INTAKE_URL = '[^']*';/, "var CRM_INTAKE_URL = '" + BASE + "/crm/intake';")
    .replace('</body>', `<script>
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function txt(e){return (e&&e.textContent||'').replace(/\\s+/g,' ').trim()}
(async function(){var R={};try{
  R.sections = [].slice.call(document.querySelectorAll('.section-title')).map(txt);
  R.required = [].slice.call(document.querySelectorAll('[required]')).map(function(e){return e.name});
  R.payment = [].slice.call(document.querySelectorAll('input[name="payment"]')).map(function(e){return e.value});
  R.locType = [].slice.call(document.querySelectorAll('input[name="location_type"]')).map(function(e){return e.value});
  /* THE BUG THIS IS FOR: an element declared translatable whose text never
     arrives, which renders as an empty box. Scoped to [data-en] rather than to
     every label — the first version also flagged #photoCount, a status line the
     script fills only once a photo is picked, and reported a working page as
     broken. */
  function blanks(){
    return [].slice.call(document.querySelectorAll('[data-en]'))
      .filter(function(e){ return !txt(e) && !e.value; })
      .map(function(e){ return e.getAttribute('data-en').slice(0, 40); });
  }
  R.blankLabels = blanks();
  R.scrollW = document.documentElement.scrollWidth;
  R.vw = document.documentElement.clientWidth;

  /* Spanish really switches, and leaves nothing blank. */
  setLang('es'); await sleep(200);
  R.esHeading = txt(document.querySelector('h1'));
  R.esBlank = blanks();
  setLang('en'); await sleep(200);
  R.enHeading = txt(document.querySelector('h1'));

  document.getElementById('f_business_name').value='Rivera Auto Detail';
  document.getElementById('f_owner_name').value='Luis Rivera';
  document.getElementById('f_legal_name').value='Rivera Auto Detail LLC';
  document.getElementById('f_category').value='Auto Detailing Service';
  document.getElementById('f_phone').value='4355551234';
  document.getElementById('f_email').value='luis@rivera.test';
  document.getElementById('f_story').value='Family run since 2014.';
  document.getElementById('f_hours').value='Mon-Fri 8-6, Sat 9-2. Closed Jan-Feb.';
  document.querySelector('input[name="location_type"][value="both"]').checked=true;
  document.querySelector('input[name="payment"][value="cash"]').checked=true;
  document.querySelector('input[name="payment"][value="zelle_cashapp"]').checked=true;
  document.querySelector('input[name="payment"][value="deposit"]').checked=true;
  document.querySelector('#onboardingForm button[type=submit]').click();
  await sleep(2000);
  R.formHidden = document.getElementById('onboardingForm').style.display === 'none';
}catch(e){R.threw=String((e&&e.stack)||e)}
fetch('${BASE}/__result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(R)});
})();
</script></body>`);

  await new Promise((res) => execFile(CHROME,
    ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
     '--virtual-time-budget=15000', '--dump-dom', BASE + '/'],
    { maxBuffer: 32 * 1024 * 1024, timeout: 90000 }, () => res()));
  srv.close();

  const result = posts.filter((p) => p.url === '/__result')[0];
  const R = result ? JSON.parse(result.body) : {};

  console.log('\n-- the page in a browser --');
  check('the browser reported back', !!result, posts.map((p) => p.url));
  check('nothing threw', !R.threw, R.threw);
  check('the four sections are there',
    JSON.stringify(R.sections) === JSON.stringify(
      ['Google Business Profile', 'Business Details', 'Services & Pricing', 'Contact & Payment']),
    R.sections);
  /* The sheet marks these REQUIRED, and they are the ones a profile cannot be
     built without. */
  check('the required fields are the ones the sheet marks required',
    JSON.stringify((R.required || []).sort()) === JSON.stringify(
      ['business_name', 'email', 'google_category', 'legal_name', 'owner_name', 'phone', 'story'].sort()),
    R.required);
  check('all four payment options',
    JSON.stringify(R.payment) === JSON.stringify(['cash', 'card', 'zelle_cashapp', 'deposit']),
    R.payment);
  check('all three location types',
    JSON.stringify(R.locType) === JSON.stringify(['in_shop', 'mobile', 'both']), R.locType);
  check('no label or hint renders empty', (R.blankLabels || []).length === 0, R.blankLabels);

  console.log('\n-- Spanish --');
  check('the heading switches', R.esHeading === 'Vamos a configurarlo.', R.esHeading);
  check('and switches back', R.enHeading === "Let's get you set up.", R.enHeading);
  /* A field with data-en but no data-es renders as an empty box in Spanish —
     invisible in English, and the whole page in Spanish. */
  check('nothing is left untranslated', (R.esBlank || []).length === 0, R.esBlank);

  console.log('\n-- where the sheet goes --');
  const crm = posts.filter((p) => p.url === '/crm/intake')[0];
  const spree = posts.filter((p) => p.url === '/formspree')[0];
  check('it reaches the CRM', !!crm);
  check('and Formspree', !!spree);
  check('and the form is put away afterwards', R.formHidden === true);

  if (crm) {
    let p = {};
    try { p = JSON.parse(crm.body); } catch (e) {}
    check('the CRM copy carries the Google category', p.google_category === 'Auto Detailing Service', p.google_category);
    check('the seasonal hours survive', /Closed Jan-Feb/.test(p.hours || ''), p.hours);
    check('and the location type', p.location_type === 'both', p.location_type);
    /* THE ONE THAT BREAKS QUIETLY. Several checkboxes share one name; if the
       payload builder keeps only the last, three of the four answers vanish
       and the sheet still looks complete. */
    check('every ticked payment method arrives, not just the last',
      JSON.stringify(p.payment) === JSON.stringify(['cash', 'zelle_cashapp', 'deposit']), p.payment);
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
