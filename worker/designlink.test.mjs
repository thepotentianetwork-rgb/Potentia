/* Opening an old design from the admin.
 *
 * The designer page was called "designer 3.html" until it was renamed on
 * 5 Sep 2026. A permalink stores whatever path it was minted from, so every
 * design saved before that rename points at a file that 404s now — which is
 * what "can't view old 3D designs" was. The stored path is worthless; the
 * PAYLOAD it carries (a ?d= short code or a #d= config blob) is what matters
 * and stays valid forever.
 *
 * Run: node --test worker/designlink.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'admin-customer.html');

/* Loads the page's inline script far enough to call the link builders. The
   page bails out early without a customer id in the URL, so every function it
   declared is left on the context for us. */
function loadAdminPage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'admin-customer.html has an inline <script>');
  const el = {
    innerHTML: '', textContent: '', className: '', style: {}, value: '',
    appendChild() {}, setAttribute() {}, addEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
  };
  const ctx = {
    console, URLSearchParams, btoa, atob, unescape, escape, encodeURIComponent,
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: '', pathname: '/admin-customer.html' },
    document: {
      getElementById: () => el, createElement: () => Object.create(el),
      querySelector: () => el, querySelectorAll: () => [], addEventListener() {},
      body: el,
    },
    navigator: {},
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(m[1], ctx); } catch (e) { /* page boot bails without an id */ }
  return ctx;
}

const CONFIG = { style: 'barn', w: 10, l: 20, h: 8, siding: 'board-batten' };

test('the dead pre-rename path is not reused', () => {
  const page = loadAdminPage();
  const url = page.designUrlFor({
    permalink: 'https://shedpro-utah.com/designer%203.html#d=eyJhIjoxfQ',
    config: CONFIG
  });
  assert.ok(!/designer%203|designer 3/.test(url), `still points at the old page: ${url}`);
  assert.match(url, /designer\.html/);
});

test('a short ?d= code is carried across to the current page', () => {
  const page = loadAdminPage();
  const url = page.designUrlFor({ permalink: 'https://shedpro-utah.com/designer%203.html?d=a1b2c3d4' });
  assert.equal(url, 'https://www.shedpro-utah.com/designer.html?d=a1b2c3d4');
});

test('a #d= config blob is carried across too', () => {
  const page = loadAdminPage();
  const blob = 'eyJzdHlsZSI6ImJhcm4ifQ';
  const url = page.designUrlFor({ permalink: 'https://shedpro-utah.com/designer%203.html#d=' + blob });
  assert.equal(url, 'https://www.shedpro-utah.com/designer.html#d=' + blob);
});

/* The oldest orders have no permalink at all, but every order carries the
   config it was priced from — so the design was always recoverable. */
test('an order with no permalink still gets a link, built from its config', () => {
  const page = loadAdminPage();
  const url = page.designUrlFor({ config: CONFIG });
  assert.match(url, /^https:\/\/www\.shedpro-utah\.com\/designer\.html#d=/);

  const blob = url.split('#d=')[1];
  const json = Buffer.from(blob.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(json), CONFIG, 'the blob round-trips to the saved config');
});

test('the blob is base64url, which is what the designer decodes', () => {
  const page = loadAdminPage();
  /* '~~~?' encodes to bytes that force both + and / in standard base64 */
  const url = page.designUrlFor({ config: { n: '~~~?' + 'ÿþ' } });
  const blob = url.split('#d=')[1];
  assert.ok(!/[+/=]/.test(blob), `not url-safe: ${blob}`);
});

test('an order with neither gets no link rather than a broken one', () => {
  const page = loadAdminPage();
  assert.equal(page.designUrlFor({}), '');
  assert.equal(page.designUrlFor(null), '');
  assert.equal(page.designUrlFor({ permalink: 'https://shedpro-utah.com/designer.html' }), '');
});

test('the customer link is minted against the current page, not a stored path', () => {
  const page = loadAdminPage();
  assert.equal(page.designerBase(), 'https://www.shedpro-utah.com/designer.html');
});

test('contact prefill lands before the hash, so the payload survives', () => {
  const page = loadAdminPage();
  const url = page.appendContactParams(
    'https://www.shedpro-utah.com/designer.html#d=abc',
    { name: 'Jo Ono', email: 'jo@example.com', phone: '' },
    { city: 'Provo' }
  );
  assert.ok(url.endsWith('#d=abc'), `hash payload lost: ${url}`);
  assert.match(url, /\?prefill_name=Jo%20Ono/);
  assert.match(url, /prefill_city=Provo/);
});
