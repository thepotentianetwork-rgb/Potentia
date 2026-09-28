/* ONE NUMBER ON THE POTENTIA SITE.
 *
 * It drifted once already: contact.html said one number and both intake forms
 * said another, so which number a customer got depended on which page they
 * happened to be on. Nothing catches that by reading a diff — the two pages
 * are edited months apart and each looks right on its own.
 *
 * quote.html is deliberately exempt. It is a ShedPro page that happens to live
 * in this repo, and ShedPro's number is not Potentia's.
 *
 * Run: node tests/site-phone.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 220) : '')); } };

const POTENTIA = { e164: '+14352910979', display: '435-291-0979', pretty: '(435) 291-0979' };
/* ShedPro's own pages, served from this repo but not this business. */
const NOT_OURS = new Set(['quote.html', 'sample.html']);

const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
const digits = (s) => s.replace(/\D/g, '');

console.log('\n-- one number, every page --');

const found = {};
for (const f of pages) {
  if (NOT_OURS.has(f)) continue;
  const src = readFileSync(path.join(root, f), 'utf8');
  /* Any US 10-digit run written as a phone number, however it is punctuated,
     plus whatever tel:/sms: actually dials. */
  const hits = new Set();
  for (const m of src.matchAll(/(?:tel:|sms:)\+?(\d{10,11})/g)) hits.add(digits(m[1]).slice(-10));
  for (const m of src.matchAll(/\(?\b(\d{3})\)?[ .-](\d{3})[ .-](\d{4})\b/g)) hits.add(m[1] + m[2] + m[3]);
  if (hits.size) found[f] = [...hits];
}

const want = digits(POTENTIA.e164).slice(-10);
const wrong = Object.entries(found).filter(([, ns]) => ns.some((n) => n !== want));
check('every Potentia page carries only ' + POTENTIA.display, wrong.length === 0, wrong);
check('and at least the pages that should have it, do',
  ['contact.html', 'contractorform.html', 'businessform.html'].every((f) => found[f]),
  Object.keys(found));

console.log('\n-- the links open the phone, not a web app --');
const contact = readFileSync(path.join(root, 'contact.html'), 'utf8');
check('Call is a tel: link', contact.includes('href="tel:' + POTENTIA.e164 + '"'));
check('Text is an sms: link', contact.includes('href="sms:' + POTENTIA.e164 + '"'));
/* Google Voice belongs in the CRM, where the business line is wanted. A
   customer-facing page must hand off to the phone itself. */
check('no Google Voice on a customer-facing page', !/voice\.google\.com/.test(contact));

for (const f of ['contractorform.html', 'businessform.html']) {
  const src = readFileSync(path.join(root, f), 'utf8');
  check(f + ' texts photos to the same number',
    src.includes('href="sms:' + POTENTIA.e164 + '"'), false);
}

console.log('\n-- and ShedPro keeps its own --');
const quote = readFileSync(path.join(root, 'quote.html'), 'utf8');
check('quote.html was not swept up in it', !quote.includes(POTENTIA.display),
  quote.includes(POTENTIA.display));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
