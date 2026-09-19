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

/* ── NOTHING GOES MISSING ────────────────────────────────────────────────────
 * A design link is only useful if reopening it gives back the shed that was
 * saved. Flower boxes and shutters live in config.addons, several steps from
 * the end of getDesignConfig() — exactly the sort of field a truncation or a
 * field-by-field rebuild drops silently, because the shed still looks like a
 * shed without them.
 *
 * This is the whole of getDesignConfig() as designer.html writes it
 * (designer.html:13736). If a field is added there and not here, the last
 * assertion fails and says so.
 */
const FULL_CONFIG = {
  v: 1, use: 'workshop',
  style: 'barn', w: 10, l: 20, h: 8, pitch: 6,
  siding: 'board-batten', pineDir: 'vertical', pineStain: 'natural', pineWidth: 6,
  sidingColor: 3, trimColor: 1, roofColor: 2,
  roofType: 'shingle', ovh: 4, ovType: 'closed', soffit: true,
  leantoDrop: 0, leantoFrontOvh: 'match',
  porchLoc: 'front', porchDepth: 6, porchH: 8, porchDeck: 'composite', deckColor: 'grey',
  porchTier: 'Composite Awning',
  dormerL: 6, dormerR: 0,
  foundation: 'pad', foundationFinish: 'coated', foundationStain: 'walnut',
  loft: 'dual4', elec: 'essential', intFinish: 'painted', floor: 'better',
  addons: { shutters: true, flowerboxes: true, cupola: 'copper',
            fbColor: 'black', shutterColor: 'black', ridgeVent: true,
            doorAwning: true, houseWrap: true, radiantBarrier: false },
  doors: [{ w: 60, h: 76, wall: 'front', pos: 0.5, awning: true }],
  windows: [{ w: 36, h: 36, wall: 'front', pos: 0.25, type: 'Black Vinyl 36x36', cy: 52 },
            { w: 36, h: 36, wall: 'front', pos: 0.75, type: 'Black Vinyl 36x36', cy: 52 }],
  vents: [{ wall: 'front', pos: 0.5, cy: 120 }],
  shelves: [{ wall: 'left', len: 12, depth: 24 }],
  porchLights: [{ pos: 0.3 }, { pos: 0.7 }]
};

/* Decodes the way designer.html's loadDesignFromHash does. */
function decodeHash(url) {
  const blob = url.split('#d=')[1];
  assert.ok(blob, `no #d= payload in ${url}`);
  let b = blob.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
}

test('a full config survives the round trip, field for field', () => {
  const page = loadAdminPage();
  const back = decodeHash(page.designUrlFor({ config: FULL_CONFIG }));
  assert.deepEqual(back, FULL_CONFIG, 'the config that comes back is not the one that went in');
});

test('flower boxes and shutters specifically come back on', () => {
  const page = loadAdminPage();
  const back = decodeHash(page.designUrlFor({ config: FULL_CONFIG }));
  assert.equal(back.addons.flowerboxes, true);
  assert.equal(back.addons.shutters, true);
  assert.equal(back.addons.fbColor, 'black', 'and their finish, not just the flag');
  assert.equal(back.addons.shutterColor, 'black');
});

test('the things flower boxes hang on come back too', () => {
  const page = loadAdminPage();
  const back = decodeHash(page.designUrlFor({ config: FULL_CONFIG }));
  assert.equal(back.windows.length, 2, 'no windows means nowhere to hang them');
  assert.deepEqual(back.windows, FULL_CONFIG.windows);
  assert.deepEqual(back.doors, FULL_CONFIG.doors);
  assert.deepEqual(back.vents, FULL_CONFIG.vents);
  assert.deepEqual(back.shelves, FULL_CONFIG.shelves);
  assert.deepEqual(back.porchLights, FULL_CONFIG.porchLights);
});

test('a big config with many openings still round-trips', () => {
  const page = loadAdminPage();
  const big = JSON.parse(JSON.stringify(FULL_CONFIG));
  big.windows = Array.from({ length: 24 }, (_, i) => ({
    w: 36, h: 36, wall: i % 2 ? 'left' : 'right',
    pos: (i % 12) / 12, type: 'Black Vinyl 36x36', cy: 52
  }));
  const back = decodeHash(page.designUrlFor({ config: big }));
  assert.equal(back.windows.length, 24);
  assert.equal(back.addons.flowerboxes, true, 'addons survive a long payload');
});

test('non-ascii in a config does not corrupt the payload', () => {
  const page = loadAdminPage();
  const c = { ...FULL_CONFIG, use: 'atelier — café ü' };
  const back = decodeHash(page.designUrlFor({ config: c }));
  assert.equal(back.use, 'atelier — café ü');
  assert.equal(back.addons.shutters, true);
});

/* Guards the list above against drifting away from the designer. */
test('this test knows about every field the designer saves', () => {
  const dz = '/home/user/shed-pro-website/designer.html';
  if (!fs.existsSync(dz)) return;                     // ShedPro repo not checked out
  const src = fs.readFileSync(dz, 'utf8');
  const fn = src.match(/function getDesignConfig\(\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'found getDesignConfig in designer.html');
  const saved = [...fn[1].matchAll(/(?:^|[\s,{])([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)].map(m => m[1]);
  const missing = saved.filter(k => !(k in FULL_CONFIG));
  assert.deepEqual(missing, [],
    `designer.html saves fields this test does not cover: ${missing.join(', ')}`);
});
