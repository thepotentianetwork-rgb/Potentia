/* THE INVOICE BUTTONS, IN A REAL BROWSER, AGAINST THE REAL WORKER.
 *
 * admin-customer.html is where someone taps a button and a customer gets an
 * $11,000 bill. The unit tests cover the arithmetic and the endpoint; what is
 * left, and what this file is for, is the seam between the page and the
 * worker — whether the button reaches the right endpoint, whether the figure
 * the browser draws is the figure the worker priced, and above all whether
 * anything can go out WITHOUT the preview being shown and confirmed first.
 *
 * A finalized Stripe invoice cannot be edited. A wrong one has to be voided
 * and reissued to someone who has already seen it. So "nothing sends on the
 * first click" is not a nicety, it is the whole design, and it is asserted
 * here by counting the sends the worker actually received.
 *
 * Stripe is stubbed inside this process. No key, no network, no real invoice.
 *
 * Run: node --experimental-sqlite tests/invoice-buttons.test.mjs
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { computePricing } from '../worker/pricing.js';
import { quoteLines } from '../worker/quotelines.js';
import { buildInvoice, fromCents } from '../worker/invoices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let fails = 0;
const check = (n, c, x) => { if (c) console.log('  ok   ' + n); else { fails++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 260) : '')); } };

try { readFileSync(CHROME); } catch {
  console.log('Chromium not present — this test needs a real browser by design. Skipping.');
  process.exit(0);
}

// ---- D1 stand-in ---------------------------------------------------------
function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s = db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() {
        const s = db.prepare(sql);
        if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
           async batch(st) { return st.map((s) => s.run()); } };
}

const { redline } = computePricing({ style: 'gable', w: 10, l: 16, h: 9,
  foundation: 'pad', foundationFinish: 'coated', intFinish: 'painted' });
/* The figures the page must end up showing, worked out here from the same
   function the worker uses — so this asserts against the real numbers rather
   than against whatever the page happened to render. */
const BREAKDOWN = quoteLines(redline, []);

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
           address TEXT, city TEXT, state TEXT, created_at TEXT);
         CREATE TABLE submissions (id INTEGER PRIMARY KEY, customer_id INTEGER, details TEXT,
           adjustments TEXT, price_adjustment REAL, adjustment_note TEXT, status TEXT,
           created_at TEXT, effective_price REAL);
         CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER, text TEXT, created_at TEXT);`);
db.prepare(`INSERT INTO customers (id,name,email,phone,created_at)
            VALUES (1,'Hank Ellis','hank@roof.test','4355550000','2026-08-01')`).run();
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
            VALUES (?,?,?,?,?)`)
  .run(7, 1, JSON.stringify({ redline, quotedPrice: BREAKDOWN.total,
                              config: { style: 'gable', w: 10, l: 16, h: 9 } }), 'quoted', '2026-09-01');
/* A consult request on the same customer: no price, so it must get no invoice
   buttons at all. Offering to bill a job that has not been priced is how a
   $0 invoice reaches someone. */
db.prepare(`INSERT INTO submissions (id,customer_id,details,status,created_at)
            VALUES (?,?,?,?,?)`)
  .run(8, 1, JSON.stringify({ consult: true, bestTime: 'mornings' }), 'new', '2026-09-20');

const env = { DB: makeD1(db), ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'k',
              STRIPE_SECRET_KEY: 'sk_test_fake' };

// ---- Stripe, stubbed -----------------------------------------------------
const stripeCalls = [];
const realFetch = globalThis.fetch;
/* What Stripe will say when ASKED about an invoice. The Check Stripe button
   exists for the case where the webhook never arrived, so the test has to be
   able to make Stripe disagree with the CRM — flipped by the harness, never
   by touching the database, which is what makes it a real test of the path. */
let stripeSays = { status: 'open', amount_paid: 0 };
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (!u.startsWith('https://api.stripe.com')) return realFetch(url, init);
  const p = new URL(u).pathname;
  const method = (init && init.method) || 'POST';
  stripeCalls.push({ path: p, method,
    params: Object.fromEntries(new URLSearchParams((init && init.body) || '')) });
  if (method === 'GET' && /^\/v1\/invoices\/in_/.test(p)) {
    return { ok: true, status: 200, json: async () => ({
      id: 'in_test', hosted_invoice_url: 'https://pay.stripe.test/hank', ...stripeSays }) };
  }
  const id = p === '/v1/customers' ? 'cus_test' : p.includes('invoiceitems') ? 'ii_test' : 'in_test';
  return { ok: true, status: 200, json: async () => ({
    id, status: 'open', hosted_invoice_url: 'https://pay.stripe.test/hank' }) };
};

// ---- the page and the worker, over real HTTP -----------------------------
let pageSrc = readFileSync(path.join(here, '..', 'admin-customer.html'), 'utf8');

/* Every POST /admin/invoices the worker really received, split by whether it
   was a preview. The page cannot fake this number. */
const invoicePosts = [];
let report = null;

const srv = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*',
                 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  /* Test fixture, not part of the worker: does to the database exactly what
     the Stripe webhook does when a deposit clears, so the page can be seen
     rendering a PAID invoice. Reaching for the real webhook here would mean
     signing a payload, which stripewebhook.test.mjs already covers. */
  if (req.method === 'POST' && req.url === '/__stripe-paid') {
    /* Stripe now says paid. The CRM's own row is untouched — exactly the
       state a missed webhook leaves behind. */
    stripeSays = { status: 'paid', amount_paid: Math.round(
      db.prepare("SELECT amount FROM invoices WHERE kind='deposit'").get().amount * 100) };
    res.writeHead(204, cors); return res.end();
  }
  if (req.method === 'POST' && req.url === '/__paid') {
    /* Idempotent, exactly as the real webhook is: by this point in the run
       Check Stripe may already have recorded the payment, and a fixture that
       inserted a second one would report a doubled deposit and look like a
       bug in the code it is meant to be testing. */
    const inv = db.prepare("SELECT * FROM invoices WHERE kind='deposit'").get();
    if (inv.status !== 'paid') {
      db.prepare("UPDATE invoices SET status='paid', paid_at=? WHERE id=?").run('2026-09-15', inv.id);
      db.prepare(`INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at, submission_id)
                  VALUES (1,?,'stripe','Deposit paid on Stripe',?,?,7)`)
        .run(inv.amount, '2026-09-15', '2026-09-15');
    }
    res.writeHead(204, cors); return res.end();
  }
  if (req.method === 'POST' && req.url === '/__result') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { report = JSON.parse(b); } catch {} res.writeHead(204).end(); });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageSrc);
  }

  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (req.method === 'POST' && req.url === '/admin/invoices') {
    let parsed = {}; try { parsed = JSON.parse(String(body)); } catch {}
    invoicePosts.push(parsed);
  }
  const out = await worker.fetch(new Request('https://local' + req.url, {
    method: req.method, headers: req.headers, body }), env);
  const text = await out.text();
  res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
  res.end(text);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

const login = await worker.fetch(new Request('https://local/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'pw' }) }), env);
const TOKEN = (await login.json()).token;

/* The page redirects to the login screen the moment it finds no token, which
   happens before anything else runs — so the token has to be in localStorage
   before the page's own script does. A script injected into <head> is. */
pageSrc = pageSrc
  .replace(/var API_BASE = "[^"]*";/, `var API_BASE = "${BASE}";`)
  .replace('<head>', `<head><script>localStorage.setItem('potentia_admin_token', ${JSON.stringify(TOKEN)});</script>`)
  .replace('</body>', `<script>
/* Drives the page the way a person would: look, click, look again. Each step
   waits for the render rather than assuming a fixed delay. */
var R = { steps: [] };
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) {
  var t = Date.now();
  while (Date.now() - t < (ms || 6000)) { var v = fn(); if (v) return v; await sleep(60); }
  return null;
}
function cards() { return [].slice.call(document.querySelectorAll('.order-card')); }
function txt(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }

(async function () {
  try {
    var card = await until(function () { return cards()[0]; });
    R.cardCount = cards().length;

    var blocks = cards().map(function (c) { return c.querySelectorAll('.inv-block').length; });
    R.blocksPerCard = blocks;

    var priced = cards()[0];                     // newest first: #8 consult, #7 priced
    R.orderOfCards = cards().map(function (c) { return txt(c.querySelector('.order-price')); });

    var quoted = cards().filter(function (c) { return c.querySelector('.inv-block'); })[0];
    R.kinds = [].slice.call(quoted.querySelectorAll('.inv-kind')).map(txt);

    var btns = [].slice.call(quoted.querySelectorAll('.inv-btn'));
    R.buttonLabels = btns.map(txt);

    // ---- press the deposit button -------------------------------------
    var deposit = btns.filter(function (b) { return /deposit/i.test(txt(b)); })[0];
    deposit.click();
    var panel = await until(function () { return quoted.querySelector('.inv-preview'); });
    R.previewAppeared = !!panel;
    R.previewLines = [].slice.call(panel.querySelectorAll('.inv-pline')).map(function (l) {
      return [].slice.call(l.children).map(txt);
    });
    R.previewTotal = txt(panel.querySelector('.inv-ptotal'));
    R.previewNote = txt(panel.querySelector('.inv-note'));
    R.previewButtons = [].slice.call(panel.querySelectorAll('.inv-btn')).map(txt);
    /* The whole document, not just the total: phases, tax, the build detail
       and the footer the customer reads. */
    R.previewLabels = [].slice.call(panel.querySelectorAll('.inv-pline'))
      .map(function (l) { return txt(l.children[0]); });
    var doc = panel.querySelector('.inv-doc');
    R.docShown = !!doc;
    R.memo = doc && doc.querySelector('.inv-memo') ? doc.querySelector('.inv-memo').textContent : null;
    R.footer = doc ? txt(doc.querySelector('.inv-note')) : null;
    R.fields = doc ? [].slice.call(doc.querySelectorAll('.inv-pline'))
      .map(function (l) { return txt(l.children[0]) + '=' + txt(l.children[1]); }) : [];
    R.warnings = [].slice.call(panel.querySelectorAll('.inv-warn')).map(txt);

    // ---- cancel puts it back, unsent ----------------------------------
    panel.querySelectorAll('.inv-btn')[1].click();
    await sleep(120);
    R.cancelledAway = !quoted.querySelector('.inv-preview');
    R.depositButtonBack = !!([].slice.call(quoted.querySelectorAll('.inv-btn'))
      .filter(function (b) { return /deposit/i.test(txt(b)); })[0]);

    // ---- now actually send it ------------------------------------------
    [].slice.call(quoted.querySelectorAll('.inv-btn'))
      .filter(function (b) { return /deposit/i.test(txt(b)); })[0].click();
    var panel2 = await until(function () { return quoted.querySelector('.inv-preview'); });
    panel2.querySelectorAll('.inv-btn')[0].click();

    /* The page reloads its data after a send, so wait for the row to come
       back as a sent invoice rather than a button. */
    var pill = await until(function () {
      var c = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
      return c && c.querySelector('.inv-state');
    }, 8000);
    R.sentPill = txt(pill);
    var after = cards().filter(function (c) { return c.querySelector('.inv-block'); })[0];
    R.rowAfterSend = txt(after.querySelector('.inv-block'));
    var link = after.querySelector('.inv-link');
    R.payLink = link ? link.href : null;
    R.payLinkOpensNewTab = link ? link.target : null;
    R.voidOffered = [].slice.call(after.querySelectorAll('.inv-btn')).map(txt);
    /* The deposit is sent; the balance must still be offered, and it must now
       net off the deposit rather than bill the whole shed again. */
    var balanceBtn = [].slice.call(after.querySelectorAll('.inv-btn'))
      .filter(function (b) { return /balance/i.test(txt(b)); })[0];
    R.balanceStillOffered = !!balanceBtn;
    if (balanceBtn) {
      balanceBtn.click();
      var bp = await until(function () { return after.querySelector('.inv-preview'); });
      R.balanceTotal = bp ? txt(bp.querySelector('.inv-ptotal')) : null;
      R.balanceNote = bp ? txt(bp.querySelector('.inv-note')) : null;
      R.balanceWarnings = bp ? [].slice.call(bp.querySelectorAll('.inv-warn')).map(txt) : [];
      /* A send from here must stop at a confirm(). Headless Chrome answers
         confirm() with false unless told otherwise, so refusing it is what a
         cautious person does — and nothing may go out. */
      R.confirmAsked = false;
      window.confirm = function (m) { R.confirmAsked = true; R.confirmText = m; return false; };
      bp.querySelectorAll('.inv-btn')[0].click();
      await sleep(400);
      R.stillOnPreview = !!after.querySelector('.inv-preview');
    }

    // ---- the webhook never arrived; press Check Stripe -----------------
    var beforeCheck = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
    var checkBtn = [].slice.call(beforeCheck.querySelectorAll('.inv-btn'))
      .filter(function (b) { return /check stripe/i.test(txt(b)); })[0];
    R.checkOffered = !!checkBtn;
    if (checkBtn) {
      /* First press: Stripe agrees it is unpaid. Nothing should move. */
      checkBtn.click();
      await until(function () { return /agrees/i.test(txt(beforeCheck.querySelector('.inv-block'))); }, 6000);
      R.agreesText = txt(beforeCheck.querySelector('.inv-block'));
      R.stillUnpaidAfterAgree = /Sent . unpaid|Sent — unpaid/.test(txt(beforeCheck.querySelector('.inv-state')));

      /* Now Stripe says paid and the CRM does not know. */
      await fetch('${BASE}/__stripe-paid', { method: 'POST' });
      var card2 = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
      [].slice.call(card2.querySelectorAll('.inv-btn'))
        .filter(function (b) { return /check stripe/i.test(txt(b)); })[0].click();
      var flipped = await until(function () {
        var c = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
        var pill = c && c.querySelector('.inv-state');
        return pill && /^Paid$/.test(txt(pill)) ? pill : null;
      }, 8000);
      R.checkFlippedIt = !!flipped;
      var after = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
      R.buttonsAfterCheck = [].slice.call(after.querySelectorAll('.inv-btn')).map(txt);
    }

    // ---- once the deposit actually clears ------------------------------
    await fetch('${BASE}/__paid', { method: 'POST' });
    loadCustomer();
    var paidPill = await until(function () {
      var c = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
      var p = c && c.querySelector('.inv-state');
      return p && /paid/i.test(txt(p)) && !/unpaid/i.test(txt(p)) ? p : null;
    }, 8000);
    R.paidPill = paidPill ? txt(paidPill) : null;
    var paidCard = cards().filter(function (x) { return x.querySelector('.inv-block'); })[0];
    R.buttonsWhenPaid = [].slice.call(paidCard.querySelectorAll('.inv-btn')).map(txt);
    var balAfter = [].slice.call(paidCard.querySelectorAll('.inv-btn'))
      .filter(function (b) { return /balance/i.test(txt(b)); })[0];
    if (balAfter) {
      balAfter.click();
      var bp2 = await until(function () { return paidCard.querySelector('.inv-preview'); });
      R.balanceAfterPaidTotal = bp2 ? txt(bp2.querySelector('.inv-ptotal')) : null;
      R.balanceAfterPaidNote = bp2 ? txt(bp2.querySelector('.inv-note')) : null;
      R.balanceAfterPaidWarnings = bp2 ? [].slice.call(bp2.querySelectorAll('.inv-warn')).map(txt) : [];
    }
  } catch (e) { R.threw = String((e && e.stack) || e); }
  fetch('${BASE}/__result', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(R) });
})();
</script></body>`);

await new Promise((resolve) => {
  execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--virtual-time-budget=30000', '--dump-dom', BASE + '/?id=1'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 }, () => resolve());
});
srv.close();
globalThis.fetch = realFetch;

const R = report || {};
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Built with the same function the worker uses, so the expected figures carry
   the same cent-level rounding. Adding raw floats here instead was off by a
   penny against what the page showed — and a penny is enough to make a real
   mismatch invisible behind a tolerance nobody would remember to remove. */
const depositDue = fromCents(buildInvoice(BREAKDOWN, 'deposit', []).totalCents);
const balanceUncredited = fromCents(buildInvoice(BREAKDOWN, 'balance', []).totalCents);

console.log('\n-- the page loaded and drew the block --');
check('the browser reported back', !!report, '(nothing came back)');
check('nothing threw', !R.threw, R.threw);
check('both orders rendered', R.cardCount === 2, R.cardCount);
/* The consult has no price. One block, not two. */
check('only the priced order offers invoicing',
  JSON.stringify(R.blocksPerCard) === '[0,1]', { blocks: R.blocksPerCard, prices: R.orderOfCards });
check('with a row for each kind',
  JSON.stringify(R.kinds) === '["Deposit","Balance"]', R.kinds);
check('and a button for each, before anything is sent',
  JSON.stringify(R.buttonLabels) === '["Work out the deposit","Work out the balance"]', R.buttonLabels);

console.log('\n-- the preview, which is the whole safety story --');
check('pressing the button shows a preview', R.previewAppeared === true);
check('THE FIRST CLICK SENDS NOTHING — it only asks for a preview',
  invoicePosts.length > 0 && invoicePosts[0].preview === true, invoicePosts[0]);
check('and Stripe was not called for it',
  stripeCalls.filter((c) => c.path === '/v1/invoices').length === 1,
  stripeCalls.map((c) => c.path));
check('the lines are itemised', (R.previewLines || []).length >= 2, R.previewLines);
check('the total shown is the deposit the worker priced',
  (R.previewTotal || '').indexOf(money(depositDue)) !== -1,
  { shown: R.previewTotal, expected: money(depositDue) });
check('the job total is spelled out too, so the figure makes sense',
  (R.previewNote || '').indexOf(money(BREAKDOWN.total)) !== -1,
  { note: R.previewNote, expected: money(BREAKDOWN.total) });
check('nothing is paid yet, and it says so',
  /already paid \$0\.00/.test(R.previewNote || ''), R.previewNote);
check('no warnings on a clean customer', (R.warnings || []).length === 0, R.warnings);
check('the panel offers send and cancel, in that order',
  (R.previewButtons || []).length === 2 && /^Send/.test(R.previewButtons[0]) &&
  R.previewButtons[1] === 'Cancel', R.previewButtons);

console.log('\n-- cancel really cancels --');
check('the panel goes away', R.cancelledAway === true);
check('the button comes back', R.depositButtonBack === true);
check('and still nothing has been sent',
  invoicePosts.filter((p) => !p.preview).length === 1,
  invoicePosts.map((p) => (p.preview ? 'preview' : 'SEND') + ':' + p.kind));

console.log('\n-- sending it --');
check('exactly one real send reached the worker',
  invoicePosts.filter((p) => !p.preview).length === 1,
  invoicePosts.map((p) => (p.preview ? 'preview' : 'SEND') + ':' + p.kind));
check('and it was the deposit',
  (invoicePosts.filter((p) => !p.preview)[0] || {}).kind === 'deposit');
check('Stripe was asked to send it', stripeCalls.some((c) => /\/send$/.test(c.path)),
  stripeCalls.map((c) => c.path));
check('the row now shows it as sent and unpaid', R.sentPill === 'Sent — unpaid', R.sentPill);
check('with the amount on it', (R.rowAfterSend || '').indexOf(money(depositDue)) !== -1, R.rowAfterSend);
check('and a link to the page the customer pays on',
  R.payLink === 'https://pay.stripe.test/hank', R.payLink);
check('which opens in a new tab', R.payLinkOpensNewTab === '_blank', R.payLinkOpensNewTab);
check('void is offered on an unpaid invoice',
  (R.voidOffered || []).indexOf('Void') !== -1, R.voidOffered);
check('the deposit button is gone — one live deposit per shed',
  !(R.voidOffered || []).some((t) => /work out the deposit/i.test(t)), R.voidOffered);

console.log('\n-- the balance, while the deposit is still unpaid --');
check('the balance is still offered', R.balanceStillOffered === true);
/* The deposit has been INVOICED, not PAID. Crediting it would be crediting
   money that has not arrived, so the figure is deliberately the whole job —
   and that is exactly why the warning below has to be there. Between the two
   outstanding invoices the customer is being asked for job total + deposit. */
check('it does not credit money that has not arrived',
  (R.balanceTotal || '').indexOf(money(balanceUncredited)) !== -1,
  { shown: R.balanceTotal, jobTotal: money(balanceUncredited) });
check('already paid still reads zero, because nothing has been paid',
  /already paid \$0\.00/.test(R.balanceNote || ''), R.balanceNote);
check('THE DOUBLE-BILL IS CALLED OUT — two outstanding invoices on one shed',
  (R.balanceWarnings || []).some((w) => /deposit invoice for .* is still unpaid/i.test(w)),
  R.balanceWarnings);
check('and it says what the two come to together',
  (R.balanceWarnings || []).some((w) => w.indexOf(money(balanceUncredited + depositDue)) !== -1),
  { warnings: R.balanceWarnings, expected: money(balanceUncredited + depositDue) });
check('sending it takes a second confirmation', R.confirmAsked === true);
check('and saying no sends nothing',
  R.stillOnPreview === true &&
  invoicePosts.filter((p) => !p.preview).length === 1,
  invoicePosts.map((p) => (p.preview ? 'preview' : 'SEND') + ':' + p.kind));

console.log('\n-- the whole quote, on the invoice --');
/* The point of all of it: nothing gets retyped, and the customer reads one
   document rather than checking the invoice against the quote. */
check('the phases are listed by name',
  BREAKDOWN.rows.every((r) => (R.previewLabels || []).indexOf(r.label) !== -1),
  { shown: R.previewLabels, phases: BREAKDOWN.rows.map((r) => r.label) });
check('sales tax is its own line, named with the rate',
  (R.previewLabels || []).some((l) => /^Sales Tax \(7\.25%\)$/.test(l)), R.previewLabels);
check('and the deferral explains what is NOT being collected yet',
  (R.previewLabels || []).some((l) => /Less balance due on completion/.test(l)), R.previewLabels);
check('the build detail is there to read', R.docShown === true);
check('the memo itemises what is in the shed',
  !!R.memo && BREAKDOWN.rows.every((r) => R.memo.indexOf(r.label) !== -1), R.memo);
check('including the parts that make up the shed phase',
  !!R.memo && BREAKDOWN.rows.some((r) => (r.subLines || []).length &&
    r.subLines.every((s) => R.memo.indexOf(s.label) !== -1)), R.memo);
check('the footer explains the two payments',
  /balance is invoiced on completion/.test(R.footer || ''), R.footer);
check('and says the amounts already include tax',
  /include Utah sales tax/i.test(R.footer || ''), R.footer);
check('the header fields carry the order and the build',
  (R.fields || []).some((f) => /^Order=#/.test(f)) &&
  (R.fields || []).some((f) => /^Job total=/.test(f)), R.fields);

console.log('\n-- Check Stripe, for when the webhook never came --');
check('the button is on the row', R.checkOffered === true);
check('when Stripe agrees, it says so and moves nothing',
  /agrees/i.test(R.agreesText || '') && R.stillUnpaidAfterAgree === true,
  { text: R.agreesText, stillUnpaid: R.stillUnpaidAfterAgree });
check('and when Stripe knows better, the row catches up',
  R.checkFlippedIt === true, R.buttonsAfterCheck);

console.log('\n-- and once the deposit clears --');
check('the row flips to paid', R.paidPill === 'Paid', R.paidPill);
/* Stripe will not void a paid invoice and the money has moved: that is a
   refund, done in Stripe, not a button here. */
check('void is NOT offered on it',
  (R.buttonsWhenPaid || []).indexOf('Void') === -1, R.buttonsWhenPaid);
check('the balance is the rest of the job now',
  (R.balanceAfterPaidTotal || '').indexOf(money(balanceUncredited - depositDue)) !== -1,
  { shown: R.balanceAfterPaidTotal, expected: money(balanceUncredited - depositDue) });
check('and the deposit shows as money received',
  (R.balanceAfterPaidNote || '').indexOf('already paid ' + money(depositDue)) !== -1,
  R.balanceAfterPaidNote);
check('with the double-bill warning gone',
  (R.balanceAfterPaidWarnings || []).length === 0, R.balanceAfterPaidWarnings);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);