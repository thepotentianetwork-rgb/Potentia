/* THE EMAIL THAT SENDS A QUOTE.
 *
 * Sending one was: print it, go back to the CRM, copy the address, open Mail,
 * type it out, attach the PDF. This writes everything but the attaching —
 * which a browser genuinely cannot do, because mailto has no attachment field.
 * That limit is why the button prints FIRST: the body says the quote is
 * attached, so the file has to exist before the draft opens.
 *
 * Run: node --test worker/quoteemail.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'quote.html');
const HTML = fs.readFileSync(PAGE, 'utf8');

function page() {
  const src = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
  const btn = { textContent: '', title: '', disabled: false, style: {} };
  const ctx = {
    console, Math, JSON, Date, String, Number, Boolean, Array, Object, RegExp,
    isFinite, encodeURIComponent, URLSearchParams,
    localStorage: { getItem: () => 'tok' },
    document: { getElementById: (id) => (id === 'email-btn' ? btn : null), querySelector: () => null },
    fetch: () => new Promise(() => {}),
    __btn: btn, __printed: 0
  };
  /* ORDER, not just occurrence. Both things happening says nothing about
     which happened first, and first is the whole point — swapping them left
     every assertion green. So each records itself in one list. */
  const seq = [];
  let href = '';
  ctx.location = { search: '?id=7',
    get href() { return href; },
    set href(v) { href = v; seq.push('mail'); } };
  ctx.__seq = seq;
  ctx.window = ctx;
  ctx.print = () => { ctx.__printed += 1; seq.push('print'); };
  vm.createContext(ctx);
  try { vm.runInContext(src, ctx); } catch (e) { /* the page's own boot work needs a DOM */ }
  return ctx;
}

const CUST = { name: 'Katie Nelson', email: 'katie@example.com' };
const CFG = { w: 12, l: 20, style: 'barn' };

test('the draft is addressed, titled and written', () => {
  const d = page().quoteEmailDraft(CUST, CFG, 18441.37);
  assert.equal(d.to, 'katie@example.com');
  assert.equal(d.subject, 'Your ShedPro quote — 12x20 ft barn');
  assert.match(d.body, /^Hi Katie,/);
  assert.match(d.body, /12x20 ft barn/);
  assert.match(d.body, /Total: \$18,441 \(including tax\)/);
  assert.match(d.body, /attached/);
  assert.match(d.body, /ShedPro$/);
});

test('the phone number is ShedPro’s own, and only written down once', () => {
  const d = page().quoteEmailDraft(CUST, CFG, 1000);
  /* The quote header above already carries the number. A second copy typed
     into the email body is how a business ends up with two in circulation. */
  assert.match(d.body, /435-277-0764/);
  /* ONCE in the file. The header and the footer of the quote each carried
     their own copy, and this email would have been a third — three places to
     miss on the day the number changes. They all read one constant now. */
  assert.equal((HTML.match(/435-277-0764/g) || []).length, 1,
    'the number is written down more than once again');
  assert.equal((HTML.match(/shedprollc\.utah@gmail\.com/g) || []).length, 1,
    'the address is written down more than once again');
  assert.match(HTML, /var SHEDPRO_PHONE = '435-277-0764'/);
});

test('no email on file means no draft, not an empty one', () => {
  const p = page();
  assert.equal(p.quoteEmailDraft({ name: 'Katie' }, CFG, 100), null);
  assert.equal(p.quoteEmailDraft({ name: 'Katie', email: '   ' }, CFG, 100), null);
  assert.equal(p.quoteEmailDraft(null, CFG, 100), null);
  // And the button says so rather than vanishing.
  p.syncEmailBtn({ name: 'Katie' }, CFG, 100);
  assert.match(p.__btn.textContent, /No email on file/);
  assert.equal(p.__btn.disabled, true);
  assert.match(p.__btn.title, /customer page/);
});

test('with an address, the button offers to send to it', () => {
  const p = page();
  p.syncEmailBtn(CUST, CFG, 18441);
  assert.equal(p.__btn.textContent, 'Email quote');
  assert.equal(p.__btn.disabled, false);
  assert.match(p.__btn.title, /katie@example\.com/);
  assert.match(p.__btn.title, /attach the PDF/);
});

test('a missing total or build does not produce a half-written sentence', () => {
  const p = page();
  const noTotal = p.quoteEmailDraft(CUST, CFG, null);
  assert.ok(!/Total:/.test(noTotal.body), noTotal.body);
  assert.match(noTotal.body, /here is your quote for the 12x20 ft barn\./);

  const noBuild = p.quoteEmailDraft(CUST, {}, 500);
  assert.equal(noBuild.subject, 'Your ShedPro quote');
  assert.match(noBuild.body, /here is your quote\./);
  assert.ok(!/for the \./.test(noBuild.body), noBuild.body);

  // A name that is not a name does not become "Hi 12345,".
  assert.match(p.quoteEmailDraft({ name: '12345', email: 'x@y.z' }, CFG, 1).body, /^Hi,/);
  assert.match(p.quoteEmailDraft({ email: 'x@y.z' }, CFG, 1).body, /^Hi,/);
});

test('the mailto carries all three parts, encoded', () => {
  const p = page();
  const href = p.mailtoHref(p.quoteEmailDraft(CUST, CFG, 18441));
  assert.match(href, /^mailto:katie%40example\.com\?subject=/);
  assert.match(href, /&body=/);
  // The em dash and the newlines survive encoding rather than truncating it.
  assert.ok(href.indexOf('%0A') > 0, 'the body lost its line breaks');
  assert.ok(!/\s/.test(href), 'the href has raw whitespace in it and will truncate');
  assert.equal(p.mailtoHref(null), '');
});

test('it prints BEFORE it opens the draft', () => {
  /* The body says the quote is attached, so the PDF has to exist first.
     Opening the mail client first puts the print dialog behind a window the
     operating system has just switched away from. */
  const p = page();
  p.syncEmailBtn(CUST, CFG, 18441);
  p.emailQuote();
  assert.equal(p.__printed, 1, 'the PDF was never saved');
  assert.match(p.location.href, /^mailto:katie%40example\.com/);
  assert.deepEqual(p.__seq, ['print', 'mail'],
    'the draft opened before the PDF was saved \u2014 the body says it is attached');
});

test('with no address, the button does nothing at all', () => {
  const p = page();
  p.syncEmailBtn({ name: 'Katie' }, CFG, 100);
  p.emailQuote();
  assert.equal(p.__printed, 0, 'it printed a PDF for an email it cannot send');
  assert.equal(p.location.href, '');
  assert.deepEqual(p.__seq, []);
});
