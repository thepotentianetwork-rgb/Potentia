/* GOOGLE VOICE LINK BUILDING.
 *
 * Two rules here are load-bearing and neither is obvious from reading the URLs:
 *
 *   A TEXT LINK CARRIES NO NUMBER. voice.google.com/calls WITH a number opens
 *   the DIALLER on it, so a button labelled Text that carries one places a
 *   call instead — from a page where the next thing you do is tap away. The
 *   number goes to the clipboard instead.
 *
 *   A NUMBER THAT CANNOT BE DIALLED RETURNS NULL, rather than being padded into
 *   something that looks valid. A seven-digit number with +1 glued on is a real
 *   phone number somewhere; dialling it is worse than offering no button.
 *
 * The three admin pages that call or text a customer all go through this, so
 * a break here is a break on all of them at once.
 *
 * Run: node --test tests/voice.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* The module is browser code that hangs itself off window. Loaded by running
   it against a stub rather than by importing, because that is exactly how the
   pages get it and it keeps the file free of a module system it does not need. */
const win = {};
new Function('window', readFileSync(path.join(here, '..', 'admin-voice.js'), 'utf8'))(win);
const V = win.AdminVoice;

test('the module hangs its helpers off window', () => {
  assert.ok(V, 'AdminVoice was never defined');
  ['toE164', 'callHref', 'textHref', 'attach'].forEach((k) => {
    assert.equal(typeof V[k], 'function', k + ' is missing');
  });
});

// ── E.164 ───────────────────────────────────────────────────────────────────

test('a ten digit US number gets a +1', () => {
  assert.equal(V.toE164('4355550000'), '+14355550000');
  assert.equal(V.toE164('(435) 555-0000'), '+14355550000', 'punctuation is stripped');
  assert.equal(V.toE164('435.555.0000'), '+14355550000');
  assert.equal(V.toE164(' 435 555 0000 '), '+14355550000');
});

test('an eleven digit number already starting with 1 just gets the plus', () => {
  assert.equal(V.toE164('14355550000'), '+14355550000');
  assert.equal(V.toE164('+1 435 555 0000'), '+14355550000');
});

test('something longer is passed through as international', () => {
  assert.equal(V.toE164('441632960000'), '+441632960000');
});

/* PADDING A SHORT NUMBER DIALS A STRANGER. Seven digits with +1 glued on is a
   real number in some area code — just not this customer's. */
test('anything it cannot dial comes back null, never padded', () => {
  ['5550000', '555', '0', '', '   ', 'call me', 'n/a', '+', '--'].forEach((bad) => {
    assert.equal(V.toE164(bad), null, JSON.stringify(bad) + ' was turned into a number');
  });
  assert.equal(V.toE164(null), null);
  assert.equal(V.toE164(undefined), null);
});

/* An eleven digit number NOT starting with 1 is not a US number with a country
   code — it is a typo, most likely an extra digit. */
test('eleven digits not starting with 1 is refused', () => {
  assert.equal(V.toE164('24355550000'), null);
});

// ── the links ───────────────────────────────────────────────────────────────

test('a call link points Voice at the number', () => {
  assert.equal(V.callHref('4355550000'),
    'https://voice.google.com/calls?a=nc,%2B14355550000');
});

/* THE TRAP. /calls WITH a number opens the dialler, so a Text button carrying
   one places a call. */
test('a text link carries no number at all', () => {
  const href = V.textHref('4355550000');
  assert.equal(href, 'https://voice.google.com/calls');
  assert.ok(href.indexOf('4355550000') === -1, 'the number is in the text link');
  assert.ok(href.indexOf('%2B1') === -1, 'the encoded number is in the text link');
  assert.ok(href.indexOf('a=nc') === -1, 'the text link carries a call action');
});

test('neither link is offered for a number that cannot be dialled', () => {
  assert.equal(V.callHref('5550000'), null);
  assert.equal(V.textHref('5550000'), null);
  assert.equal(V.callHref(''), null);
  assert.equal(V.textHref(null), null);
});

/* No /u/0/ account index on either: tested on iOS, the index hands the link to
   Safari instead of the Google Voice app. */
test('no account index, which would trade the app for the browser', () => {
  assert.ok(V.callHref('4355550000').indexOf('/u/0/') === -1);
  assert.ok(V.textHref('4355550000').indexOf('/u/0/') === -1);
});

// ── attaching to an anchor ──────────────────────────────────────────────────

function fakeAnchor() {
  return { href: '', rel: '', title: '', listeners: [],
           addEventListener(ev, fn) { this.listeners.push([ev, fn]); } };
}

test('attaching sets the link and says so', () => {
  const a = fakeAnchor();
  assert.equal(V.attach(a, '4355550000', 'call'), true);
  assert.equal(a.href, 'https://voice.google.com/calls?a=nc,%2B14355550000');
  assert.match(a.title, /Google Voice/);
});

/* The number rides onto the clipboard, because no link can land on a thread. */
test('a text attaches a copy of the number to the tap', () => {
  const a = fakeAnchor();
  assert.equal(V.attach(a, '(435) 555-0000', 'text'), true);
  assert.equal(a.href, 'https://voice.google.com/calls');
  assert.match(a.title, /\+14355550000/, 'the title does not say what gets copied');
  assert.equal(a.listeners.length, 1, 'nothing was wired to the tap');
  assert.equal(a.listeners[0][0], 'click');
});

/* A failed copy must never stop the app opening — the tap is the point. */
test('a clipboard that refuses does not break the tap', () => {
  const a = fakeAnchor();
  V.attach(a, '4355550000', 'text');
  /* navigator is a getter on the Node global, so it is swapped with
     defineProperty and put back, not assigned to. */
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText() { throw new Error('denied'); } } }
  });
  try {
    assert.doesNotThrow(() => a.listeners[0][1]());
  } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else delete globalThis.navigator;
  }
});

test('a call does not wire a clipboard copy', () => {
  const a = fakeAnchor();
  V.attach(a, '4355550000', 'call');
  assert.equal(a.listeners.length, 0);
});

/* Returns false and leaves the element alone, so each page decides whether that
   means hiding the control or showing it disabled. */
test('an undialable number leaves the element untouched', () => {
  const a = fakeAnchor();
  assert.equal(V.attach(a, '5550000', 'call'), false);
  assert.equal(a.href, '', 'it set a href anyway');
  assert.equal(a.listeners.length, 0);
  assert.equal(V.attach(null, '4355550000', 'call'), false);
});
