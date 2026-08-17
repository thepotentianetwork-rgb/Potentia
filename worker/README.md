# Potentia backend — setup guide

One Cloudflare Worker (`potentia-assistant`) serves three things:

1. **`/chat`** — the AI assistant widget (`/assistant.js`) on the public site.
2. **`/admin/*`** — the password-gated dashboard (`/admin-login.html`,
   `/admin.html`) where you view Shed Co. customer submissions and edit
   their pricing.
3. **`/shed/pricing`** and **`/shed/submit`** — public endpoints the Shed
   Co. website will eventually call to read live pricing and send in
   customer design submissions (not wired up on their end yet — see the
   bottom of this doc for what to hand them).

Current deployed URL: `https://potentia-assistant.thepotentianetwork.workers.dev`

## Already done

- ✅ Worker created and code deployed
- ✅ `ANTHROPIC_API_KEY` secret set (chat widget works once billing has
  credit — see console.anthropic.com → Plans & Billing)

## Still needed for the admin dashboard

### 1. Add two more secrets

Same place as before: Worker → **Settings → Variables and Secrets** →
**Add variable**, Type = **Secret**.

| Name | Value |
|---|---|
| `ADMIN_PASSWORD` | Whatever password you want to log into `/admin-login.html` with. Pick something you don't use anywhere else. |
| `ADMIN_SESSION_SECRET` | A long random string used only to sign login sessions — not something you type in, just a secret key. Use this one, or generate your own the same way: `4c4388e3c3d35593c49cdde32df9b18cc0b6b1cc71498ad2c84be9f69de7378d` |

### 2. Create the D1 database (this is where submissions & pricing live)

1. In the Cloudflare sidebar, go to **Storage & Databases → D1 SQL Database**
   (or search "D1" in the quick search).
2. **Create database**, name it `potentia-shed` → Create.
3. Open it, go to its **Console** tab, and paste in the contents of
   `worker/schema.sql` from this repo, then run it. This creates the
   `submissions` and `pricing` tables (empty, ready to use).

### 3. Bind the database to the Worker

1. Go back to the `potentia-assistant` Worker → **Settings → Bindings**.
2. **Add binding → D1 database**.
3. Variable name: `DB` (must be exactly this — the code refers to `env.DB`).
4. Database: pick `potentia-shed`.
5. Save/Deploy.

### 4. Try it

- Visit `admin-login.html` on the live site, log in with your
  `ADMIN_PASSWORD`.
- You should land on `admin.html` with empty "Customer Submissions" and
  "Pricing" sections. Add a pricing row to confirm it saves.

If login or the dashboard doesn't work, check that all three secrets
(`ANTHROPIC_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`) and the
`DB` binding are all present on the **same** Worker.

## Shed Co. designer tool integration

The designer (`designer.html`, the 3D shed configurator) already has its
own quote-request flow and its own full pricing engine + editor screen
(`#admin` on that page). Rather than rebuild those, we connect them
straight to this backend:

**Quote requests** — change `QUOTE_ENDPOINT` near the top of the
`QUOTE REQUEST` section in `designer.html` from `/api/quote` to:
```js
var QUOTE_ENDPOINT = 'https://potentia-assistant.thepotentianetwork.workers.dev/shed/submit';
```
No other changes needed there — `submitQuote()`'s existing payload shape
(`contact`, `config`, `permalink`, `quotedPrice`, `redline`) is what the
backend expects. Every submission lands in `/admin.html` under Customer
Submissions, showing the quoted price and a link back to the exact 3D
design.

**Pricing engine** — change `PRICING_ENDPOINT` from `/api/pricing` to:
```js
var PRICING_ENDPOINT = 'https://potentia-assistant.thepotentianetwork.workers.dev/shed/pricing-config';
```
The boot-time `GET` (every visitor loading current prices) is public and
needs no changes. The `POST` from `paSave()` (saving edited prices) now
requires login — see below for the exact diff, since right now anyone
who adds `#admin` to the URL can open and save pricing changes with no
password at all.

**Required: add a login gate to `#admin`.** Find this block near the
bottom of `designer.html`:
```js
if(/[#&]admin/.test(location.hash||'')) setTimeout(openPricingAdmin,300);
```
Replace it, and add the small login helper above it:
```js
var ADMIN_API = 'https://potentia-assistant.thepotentianetwork.workers.dev';
var shedAdminToken = sessionStorage.getItem('shed_admin_token');
function ensureShedAdmin(cb){
  if (shedAdminToken) { cb(); return; }
  var pass = prompt('Admin password:');
  if (!pass) return;
  fetch(ADMIN_API + '/admin/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({password: pass})
  }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
    .then(function(res){
      if (!res.ok) { alert('Incorrect password.'); return; }
      shedAdminToken = res.d.token;
      sessionStorage.setItem('shed_admin_token', shedAdminToken);
      cb();
    })
    .catch(function(){ alert('Could not reach the server.'); });
}

if(/[#&]admin/.test(location.hash||'')) setTimeout(function(){ ensureShedAdmin(openPricingAdmin); },300);
```
This uses the **same** `ADMIN_PASSWORD` you set for `admin-login.html` —
one password for both.

Then update `paSave()` to send the login token, and to re-prompt if it's
expired:
```js
function paSave(){
  paCollect();
  if(typeof buildShed==='function') buildShed();
  if(typeof updateSum==='function') updateSum();
  paMsg('Saving...');
  fetch(PRICING_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+shedAdminToken},
    body:JSON.stringify(paSnapshot())})
    .then(function(r){
      if(r.status===401){ sessionStorage.removeItem('shed_admin_token'); shedAdminToken=null; throw 0; }
      if(!r.ok) throw 0;
      paMsg('Saved — live on every device.','#86EFAC');
    })
    .catch(function(){ paMsg('Applied here, but the save endpoint didn\'t answer. Use Export to keep a copy.','#ffd7a0'); });
}
```

**Required: allow their domain.** Add the shed site's real live domain to
the `ALLOWED_ORIGINS` list near the top of `worker/index.js` (there's a
placeholder comment marking where), then redeploy — otherwise the
browser blocks these requests as cross-origin.

## CRM upgrade: customers, order history, notes, quote documents

The dashboard now groups submissions by **customer** (matched by email or
phone, so the same person submitting multiple designs doesn't create
duplicate entries), keeps their **full order history**, supports
**notes** with a visible history, and can generate a **printable quote
document** per order. New pages: `admin-customer.html` (customer detail
+ notes + order history) and `quote.html` (the printable/PDF quote).

### Migrate the existing database

Since the live database already has data, run this **once** in the D1
console instead of `schema.sql` (running it twice will duplicate
customers):

Paste in the contents of `worker/migrate_customers.sql` and run it. This
adds the `customers` and `notes` tables, links your existing
submissions to a customer record, and is safe to run even with the one
test submission already in there.

### Redeploy the Worker

The code changed again — paste the latest `worker/index.js` into
**Edit code** and Deploy, same as before. No new secrets or bindings are
needed for this part.

### Using it

- `admin.html` now lists **customers**, not raw submissions — columns for
  name, email, phone, latest quote, status, and latest note.
- Click **View →** on a customer to see their full order history (every
  design they've submitted, oldest to newest) and their notes.
- **Generate Quote** on any order opens `quote.html` — a clean,
  ShedPro-branded document with customer info, design specs, and price.
  Click **Print / Save as PDF** to get a file to email or text the
  customer.
- Notes: type in the box and hit **Add Note** — the most recent shows
  first with an orange accent, older notes stay below it.

## Simple flat `/admin/pricing` table (not currently used by the designer)

The `pricing` table and the "Pricing" section in `admin.html` were built
before we saw the designer's own pricing engine. They're independent and
harmless to leave as-is, but editing them does **not** change what the
shed designer charges — that's driven entirely by `pricing_config`
above. Worth removing later to avoid confusion, once the designer
integration is confirmed working.

## Cost control already built in

- Chat replies capped at 400 tokens; history capped at last 20
  messages / 1000 characters each. Model is Claude Haiku 4.5 (cheap, fast).
- Admin sessions expire after 12 hours.
- Submission `details` capped at 20,000 characters; the pricing engine
  snapshot at 200,000; pricing labels/units capped to sane lengths — all
  just to stop a malformed request from writing huge rows into the
  database.

## Optional next steps

- **Rate limiting**: add a Cloudflare KV namespace to throttle abusive
  traffic on `/chat` or `/shed/submit`. Not included here to keep setup
  simple.
- **Email on new submission**: have `/shed/submit` also POST to your
  existing Formspree endpoint so a new lead pings your inbox instantly
  instead of only showing up in the dashboard.
- **Multiple admin accounts**: right now there's one shared password. If
  Shed Co. staff need their own logins later, this can be upgraded to a
  proper per-user accounts table in D1.
