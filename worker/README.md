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
4. **`/shed/consult`** — public. The designer's "talk to a designer"
   call-back request. Unlike `/shed/submit` it requires a phone number
   rather than an email, does not supersede the customer's existing new
   submissions, and is not geocoded. It stores a submission flagged
   `consult: true`, which the admin list renders as a "Wants a call" badge.

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

## Floor plans and 3D view renders on the quote document

`quote.html` now also shows:
- **A floor plan** — drawn as an SVG straight from the door/window
  wall + position data the designer already captures in `config`. No
  new setup needed, this works automatically once orders come through.
- **5 building images** (perspective, front, right, back, left) —
  captured by the designer at the moment of submission and stored in
  Cloudflare R2 (object storage — images are too big to put in the D1
  database). This part needs one more piece of infrastructure.

### 1. Create an R2 bucket

1. Cloudflare dashboard → **Storage & Databases** (or search "R2") →
   **R2 Object Storage**.
2. **Create bucket**, name it `potentia-shed-renders` → Create.
3. Open the bucket → **Settings** → under **Public Development URL**,
   click **Enable**. Copy the URL it gives you — looks like
   `https://pub-xxxxxxxxxxxx.r2.dev`. Renders aren't sensitive (they're
   just shed pictures), so a public URL is fine and much simpler than
   proxying every image through the Worker.

### 2. Bind the bucket to the Worker

1. `potentia-assistant` Worker → **Settings → Bindings** → **Add binding**.
2. Type: **R2 Bucket**. Variable name: `RENDERS` (exactly that).
3. Bucket: pick `potentia-shed-renders`.
4. Save/Deploy.

### 3. Add one more variable (not a secret — it's just a URL)

1. Same Worker → **Settings → Variables and Secrets** → **Add variable**.
2. Type: **Text** (not Secret this time).
3. Name: `RENDERS_PUBLIC_BASE`. Value: the `pub-....r2.dev` URL from step 1.
4. Save/Deploy.

### 4. Redeploy the Worker code and update designer.html

- Paste the latest `worker/index.js` into Edit code and Deploy (adds the
  upload-to-R2 logic).
- Swap in the latest `designer.html` — the render capture now grabs 5
  labeled angles (front/back/left/right/perspective) instead of 3
  unlabeled ones. Ask for the updated file if you don't have it handy.

Once that's deployed, new quote submissions will include real building
images automatically — nothing else to wire up. Orders submitted before
this was set up just won't have images (floor plan still works for
those, since it doesn't depend on R2).

## Pricing moved server-side — deploy now needs one extra step

The whole price sheet (`SELL`/`COST`, every rate and cost the designer used
to compute prices with) used to live in `designer.html` itself — anyone
could view-source the page and read it. It now lives in **`worker/pricing.js`**,
a second file the Worker imports, and never ships to a browser. The
designer just POSTs the current build to `POST /shed/quote` and gets back
a total (and, for logged-in staff, the full cost/margin breakdown).

This changes how you redeploy. Cloudflare's dashboard **Edit code** box only
accepts one file, so pasting `worker/index.js` alone will fail — it can't
find `./pricing.js`. Two ways to redeploy from here:

**Easiest — paste the bundled file (same workflow as before):**
Paste the contents of **`worker/dist/index.bundle.js`** into Edit code
and Deploy, exactly like you always pasted `index.js`. That file has
`pricing.js` folded into it automatically — nothing else changes about
how you deploy.

If you ever ask me for a code change to `worker/index.js` or
`worker/pricing.js`, I'll regenerate `worker/dist/index.bundle.js` (via
`node worker/build-bundle.mjs`) as part of that change, so it's always
the one to grab and paste.

**Alternative — `wrangler deploy` from a terminal:** if you're ever set up
with Node and the `wrangler` CLI, `cd worker && wrangler deploy` reads
both files directly from `wrangler.toml`'s `main = "index.js"` and needs
no bundling step. Not required — just mentioned in case it's ever more
convenient than the dashboard.

Either way, `GET /shed/pricing-config` (the admin pricing editor's data
endpoint) is now behind the same login as everything else in `/admin/*` —
it used to be public, which made moving the designer's own copy
server-side pointless (the same numbers were one fetch away).

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

# Potentia's own client CRM (`/crm/*`)

Everything above this line belongs to the **shed partner**. This section is
Potentia's own CRM — the web-design clients, from first inquiry through
launch and into their monthly plan.

It runs in the same Worker, but on **its own D1 database** (`potentia-crm`,
bound as `CRM_DB`) with its own login page and its own password. No Potentia
client data is stored in `potentia-shed`. The one thing still shared is the
Worker itself — same code deploy, same `ANTHROPIC_API_KEY`, same bill.

New pages: `crm-login.html`, `crm.html` (client list + headline numbers),
`crm-client.html` (one client: details, work, notes, payments).

## Setup

### 1. Add one secret — required, the CRM will not open without it

Worker → **Settings → Variables and Secrets** → **Add variable**,
Type = **Secret**.

| Name | Value |
|---|---|
| `CRM_PASSWORD` | The password for `crm-login.html`. Make it different from `ADMIN_PASSWORD` — that's the whole point. |

The CRM has its **own** password. It does not accept `ADMIN_PASSWORD`, not
even as a fallback: the shed partner knows that one, and it must never open
Potentia's client list, revenue or notes. Until `CRM_PASSWORD` is set,
`crm-login.html` refuses every attempt and tells you the secret is missing.
Failing shut is the right direction here.

The separation runs both ways and is enforced by the Worker on every
request, not just in the browser:

| | `/admin/*` (ShedPro) | `/crm/*` (Potentia) |
|---|---|---|
| `ADMIN_PASSWORD` | opens it | rejected |
| `CRM_PASSWORD` | rejected | opens it |
| a logged-in shed session | works | 401 |
| a logged-in CRM session | 401 | works |

Different login page, different password, different session. Losing one
password does not expose the other side.

## The packages, and what a build costs

The website tiers and their build prices live in **one** place:
`CRM_PACKAGE_LIST` in `worker/index.js`.

| Key | Shown as | Build | Monthly |
|---|---|---|---|
| `tier1` | Tier 1 — Home & Contact | $500 | $20 |
| `tier2` | Tier 2 — Home, Gallery & Contact | $1,200 | $75 |
| `tier3` | Tier 3 — Gallery + Scheduling | $1,800 | $150 |
| `crm` | Custom CRM | from $2,000 | from $250 |
| `platform` | Sales Platform | from $5,000 | from $350 |
| `custom` | Custom | — | — |

The last two carry `from: true`, which means the figure is a **floor, not a
price**. Both are scoped per business. The CRM fills the box with 2000 either
way, so without that flag the difference is invisible and someone quotes a
custom CRM at exactly $2,000 — which is why the page prints *"Starts at —
scope it"* beside those two and *"List:"* beside the website tiers.

The Sales Platform includes **2 logins**; further logins are `perSeat` $50+
per month each. That is on `pricing.html` as a feature (the count, not the
price) because it shapes what a customer expects before they call.

Every tier carries a retainer — hosting, patching and upkeep. That is load-
bearing copy: `pricing.html` used to promise Tier 1 *"No monthly
subscription"* and the home page *"no monthly ransom to keep it online"*, and
both lines are now gone. A test fails if a tier loses its retainer while that
copy stays deleted, or if either claim comes back.

**The prices are internal.** Nothing on the public site quotes a figure —
every plan on `pricing.html` says *Request Info*, and the site's assistant is
told in its system prompt never to state a dollar amount. That is why the
list is served from `GET /crm/packages` (CRM login required) rather than
written into `crm.html`: **crm.html is a public file.** A login gates the data
a page fetches, not the page itself, so anything typed into one is published.
`worker/packages.test.mjs` fails the build if a price appears in a page or in
the assistant's prompt.

`crm.html`, `crm-client.html` and `crm-data.html` all read that endpoint, so
changing a price is one edit here and a bundle paste — no page changes.

Selecting a package in the CRM fills in **both** the build fee and the monthly
retainer, and **clears** either one when the new package has no list price — so
a Custom CRM is never left quoted at the price of a two-page website. It never
touches a number someone typed, and the two fields are tracked separately: a
negotiated retainer survives changing the tier. The rules live once in
`crm-lead.js`, which both CRM pages load.

Four package names are **retired**: `foundation`, `booking`, `gallery` and
`operator`, from the old four-tier lineup. They are still in the list and
marked `retired: true` — not offered for new work, but still shown on the
clients who have one. They are deliberately **not** migrated onto the new
tiers: a client who bought a 4-Page Gallery Site bought that, and rewriting
their row would falsify what they paid for.

### 2. Create a second D1 database — Potentia's own

The CRM does **not** share the shed partner's database. `potentia-shed`
holds their customers, quotes and renders; Potentia's client list, revenue
and notes go somewhere else entirely, so the two can never be read out of
one place.

1. Cloudflare sidebar → **Storage & Databases → D1 SQL Database**.
2. **Create database**, name it `potentia-crm` → Create.

You do **not** need to paste any SQL into its console. The Worker creates
its four tables the first time you use the CRM. (`worker/schema-crm.sql`
has them written out if you ever want to read or recreate the schema by
hand — it is a different file from `schema.sql`, which builds
`potentia-shed`.)

### 3. Bind it to the Worker

1. `potentia-assistant` Worker → **Settings → Bindings** → **Add binding**.
2. Type: **D1 database**. Variable name: `CRM_DB` (exactly that — the code
   refers to `env.CRM_DB`).
3. Database: pick `potentia-crm`.
4. Save/Deploy.

The Worker now has two D1 bindings, and they are not interchangeable:

| Binding | Database | Used by |
|---|---|---|
| `DB` | `potentia-shed` | `/admin/*`, `/shed/*` — the shed partner |
| `CRM_DB` | `potentia-crm` | `/crm/*` — Potentia's clients |

If `CRM_DB` is missing, the CRM refuses with "CRM database not connected"
rather than quietly falling back to the shed database — and the login page
tells you so. Failing shut, again.

### 4. Redeploy the Worker

Paste `worker/dist/index.bundle.js` into **Edit code** and Deploy, same as
always.

Then open `crm-login.html` on the live site and sign in.

## Using it

**`crm.html`** — every client in one table, with four numbers across the
top: monthly recurring revenue (the sum of the monthly plans for clients
who are building or live), active clients, open leads, and everything
collected in the last 30 days. Filter by pipeline stage, search by name /
email / domain, change a client's stage straight from the row, or add a
client by hand with **+ New Client**.

The stages are `lead → contacted → proposal → building → live`, plus
`paused` and `lost`. A client sitting at `lead` is highlighted so a fresh
inquiry can't be missed.

**`crm-client.html`** — one client's whole picture:

- **Details** — contact info, package, build fee, monthly fee, live URL,
  domain, domain renewal date, launch date. Editing the renewal date is what
  makes "when does this domain come up for renewal?" answerable a year from
  now.
- **Original Inquiry** — what they actually typed into the contact form,
  kept verbatim.
- **Work & Edit Requests** — the running to-do list per client, with due
  dates. Open items sort to the top, overdue ones go red, and the count
  shows on the main list so you can see at a glance who's waiting on you.
- **Notes** — call notes, decisions, follow-ups. Newest first.
- **Payments** — each one tagged as a build payment, a monthly retainer, an
  add-on, or other. The totals show what's been collected all time, how much
  of that was retainers, and what's still outstanding on the build fee.

## Leads arrive on their own

`contact.html` now posts every inquiry to `POST /crm/lead` alongside its
existing Formspree email — so a form submission becomes a lead in the CRM
without anyone typing it in. The Formspree email still goes out exactly as
before; the CRM call is fire-and-forget, so if the Worker were ever down the
form still works normally.

If the email or phone matches someone already in the CRM, the new inquiry is
logged as a **note on their existing record** rather than creating a
duplicate — and their current stage is left alone, so a repeat inquiry from
a live client doesn't knock them back to "lead".

## Checking a change didn't break it

`worker/crm.test.mjs` runs every CRM route against **two** real SQLite
databases standing in for the two D1 bindings, so the separation is
actually exercised rather than assumed:

```
node --experimental-sqlite worker/crm.test.mjs
```

It exits non-zero if anything fails. Worth running after any change to the
`/crm/*` half of `worker/index.js`. Among the 64 checks:

- the shed password is refused by the CRM login, and the CRM password is
  refused by the shed login
- with `CRM_PASSWORD` unset, nothing gets into the CRM at all
- after a full run of CRM activity, the shed database contains **none** of
  the four CRM tables and not one new row
- with `CRM_DB` unbound, a CRM write returns 503 instead of landing in the
  shed database

That fourth one is the guard rail worth keeping: if a query in the CRM half
of the file ever reaches for `env.DB` instead of `env.CRM_DB`, these checks
fail loudly.

---

## Lead enrichment pipeline

Sources local businesses from Google Places, researches each with Grok, scores
it, and inserts the good ones into the CRM `clients` table as leads ranked by
`lead_score`.

Qualification is one question: do they have a usable website? A business with
no site, with nothing but a Facebook page, with a dead `business.site` page,
with a site still on plain http, or with one that fails Google's own mobile
speed test, is a lead. Everything else is not. The first four are answered by
the Places row the search already paid for; the last is answered by PageSpeed
Insights, which is free and which has Google fetch the page rather than us.

### Environment variables

All server-side, set as Worker secrets — none of these reach the browser.

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | yes | Places API (New) Text Search, and PageSpeed Insights |
| `LEADS_DAILY_USD_CAP` | no | rolling 24h ceiling, default `5.00` |
| `LEADS_MIN_RATING` | no | star rating a business must clear, default `4.0` |
| `LEADS_PASSWORD` | yes, to use the generator | unlocks the lead generator |
| `CRM_CALLERS` | no | who is on the phones, comma-separated |

Moving `LEADS_MIN_RATING` only affects businesses found after the change: one
already screened out carries a tombstone that dedupes it away. To apply a new
cut-off to everything already seen, run once with `?rescreen=1`, which clears
the screening tombstones and puts those businesses back in the queue. It never
touches a business that was actually checked and turned down on its website.

One key, two APIs: both must be enabled on the Cloud project, and if the key
carries an API restriction both must be listed on it. PageSpeed is free and
needs no key at all — the key is passed only because Google asks for one on
automated traffic. A run with the key restricted to Places alone still works;
the businesses with no website still qualify, and the run stops cleanly at the
first one that needs a speed test and says so.

Set the key with `wrangler secret put NAME`, or in the dashboard under
Settings → Variables and Secrets. `scheduled()` returns immediately if
`GOOGLE_PLACES_API_KEY` is unset.

### The lock

Everyone working the phones gets a CRM login. The lead generator spends money
and rewrites the search grid, so it sits behind a second password,
`LEADS_PASSWORD`.

That is its own secret, with no fall back to `ADMIN_PASSWORD` — the password
ShedPro staff type to see prices in the designer. Those are two different jobs
for two different businesses, and one password doing both means the one handed
out daily is also the one guarding the spending. Until `LEADS_PASSWORD` is set
nobody can unlock the generator at all, which is the right way round to fail.

Unlocking returns a separate token sent as `X-Leads-Unlock`, not in
`Authorization`: it says what you may do, not who you are, so unlocking never
swaps out a caller's identity. Every `/crm/leads/*` endpoint checks it. The
page hides the section too, but that is a convenience — a hidden button is not
a lock, and the endpoints are one fetch away from anyone with a login.

`401` and `403` are kept apart on purpose: a `401` sends someone to the login
screen, a `403` shows the unlock box. Collapsing them would bounce a signed-in
caller to a login they have already done.

### Lead ownership

Whoever first gets the customer on the phone owns the lead. The call log takes
a `logged_by` name; an outcome of `connected` or `callback` writes it to
`clients.owner`, but only into an empty one — a later caller opening the record
cannot take a lead off the person who earned it. Voicemail, no answer and wrong
number claim nothing; you can leave five voicemails and have spoken to nobody.

The name is picked from a list, not typed: "Fernando M", "fernando" and
"Fernando" are three owners of the same lead, and nobody notices until someone
asks whose it is. `GET /crm/callers` returns `roster` — from `CRM_CALLERS`, so
the people on the phones change in Cloudflare rather than in a deploy — merged
with every name already in the call log, so someone leaving the roster never
makes the leads they own unattributable.

### Rechecking

A lead with a real website should carry a speed score. One that does not was
judged while PageSpeed was unavailable, so nobody ever looked at its site.
`POST /crm/leads/recheck` re-runs the website check on those: the ones that
still fail keep their place and gain the evidence they should have had, and the
ones whose site turns out to be fine are marked `lost` with a reason.

Only untouched leads are considered — status still `lead`, no owner, no calls
logged. Once a person has engaged with a business, what the pipeline thinks
about their website stops being the deciding fact.

Marked, not deleted. It was put in front of someone as a lead, and a row that
quietly disappears is worse than one that says why it is no longer worth a
call.

### Categories

Every category is seeded for every city whether or not it ships switched on,
so turning one on is an `UPDATE`, not a reseed — a reseed would throw away
which cities have already been searched.

| Category | Ships | Offer |
|---|---|---|
| Home Services | on | Credibility Website |
| Auto detailers | off | $99 Website |
| Car dealerships | off | Dealership CRM |

Home Services covers the specialty trades that sub to general contractors, the
small GCs who hire them, and handymen — one category because it is one sales
conversation. For a trade that is a general contractor picking a bid list; for
a handyman it is a homeowner deciding who to let through the door. Same
product. Established GCs are not the target, but nothing needs to know that:
the review ceiling sends anyone big enough to have an agency straight out.

The `subcontractor`, `general` and `handyman` categories it replaces are
renamed in place on startup, in `lead_sources`, `lead_candidates` and
`clients`, so no rebuild is needed and no row loses its `last_run_at`.

The CRM's Lead Pipeline section has a chip per category; clicking one calls
`POST /crm/leads/segments` with `{segment, enabled}`. There is no separate
setting to keep in step — a category is on when its searches are on, and
`lead_sources` is the only place that is recorded.

A category toggle never switches on the home state (`HOME_STATE`, currently
`UT`). Turning on "Auto detailers" should not start ringing the shop down the
road.

A new category is one entry in `SEGMENTS`: key, label, offer, default, and its
search terms. Everything else — the seed grid, the key list, the CRM's toggles
and filters — derives from it.

### Running it

```
# dry run — sources and dedupes, makes NO paid AI calls. Start here.
curl -X POST "$WORKER/crm/leads/run-now?dry=1" -H "Authorization: Bearer $CRM_TOKEN"

# real run, 5 leads
curl -X POST "$WORKER/crm/leads/run-now?limit=5" -H "Authorization: Bearer $CRM_TOKEN"

# what the last 30 runs did, and what they cost
curl "$WORKER/crm/leads/runs" -H "Authorization: Bearer $CRM_TOKEN"
```

The cron trigger runs the same code hourly. **Keep the interval at an hour or
more** — see the comment in `wrangler.toml` for why.

### Adding or changing search queries

Everything the pipeline searches for lives in `lead_sources`. Nothing is
hardcoded.

```sql
-- add one
INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
VALUES ('gutter installer', 'Boise', 'ID', 'contractor', 2, 1, datetime('now'));

-- turn a whole state on or off
UPDATE lead_sources SET enabled = 1 WHERE state = 'UT';

-- stop one query without deleting its history
UPDATE lead_sources SET enabled = 0 WHERE query_template = 'landscaping contractor';
```

`segment` is one of `subcontractor` / `general` / `handyman` / `dealer` and
decides which research questions get asked. `offer_hint` is a starting guess
(1 = $99 site, 2 = credibility site, 3 = dealership CRM); the scorer can
overrule it.

**Who is targeted, as shipped:** specialty trades who sub to general
contractors, plus general contractors that turn out to be small or new.
Handyman and dealer rows are seeded but `enabled = 0` — one UPDATE brings
either back without rebuilding the city list.

**How established a business looks is a hard gate**, not a tiebreaker. The
research step judges it from review volume, years trading, crew and fleet size,
multiple locations and how polished their current site is; the scorer then caps
`growing` at 70 and `established` at 30, which puts the latter below the
qualifying score. General contractors are held to a stricter bar again. A big
settled firm does not buy a cheap website, and calling one wastes the call.

### Changing which segments or cities ship

`lead_sources` is written ONCE, on the first run against an empty table. Editing
`defaultSources()` in the code therefore does nothing to a database that has
already been seeded. To apply a change to the shipped grid:

```
POST /crm/leads/run-now?dry=1&reseed=1
```

That replaces the grid from the code's defaults. **It drops manual edits with
it** — any row you enabled by hand goes back to what the file ships, so re-apply
those afterwards. For a one-off change, the UPDATE statements above are safer.

**Utah ships disabled.** Every UT row has `enabled = 0`, because "businesses
that aren't local" needs a home town to be meaningful. Enable whichever you
want with the UPDATE above.

### What it stores, and what it deliberately doesn't

Google's Places terms allow `place_id` to be stored indefinitely and little
else. So Places fields live in `lead_candidates` only while a candidate is being
judged. On judgement — pushed or rejected — the row is stripped to
`place_id` + status + score + a one-line reason, and the Places and research
blobs are nulled.

That tombstone stops the pipeline paying to re-source the same dead end every
hour, and holds no Places content. A lead that reaches the CRM carries the
phone and website the **business itself publishes**, taken from the enrichment
step's `source_urls`, not a copy of the Places record.

One consequence worth knowing: once a lead is rejected you cannot see the
detail behind it. The score and reason survive; nothing else does. To
re-examine a rejected business you have to re-source it, and pay for it again.

### Safety rails

- **Never overwrites.** The only write to `clients` is an INSERT. A business
  already in the CRM — matched on `place_id`, phone digits, or website domain —
  is skipped entirely, so a caller's hand-typed notes are never touched.
- **`do_not_contact`** on a `clients` row keeps that business out of any future
  run, because dedupe finds it before anything is spent on it.
- **Per-run cap** (`?limit=`, default 5) and a **rolling 24-hour cost ceiling**
  checked before every paid call, so a run that crosses the line mid-batch
  stops cleanly instead of finishing.
- **Three attempts** per candidate, then `status='failed'` and it is left alone.

### Costs

`enrichment_runs.est_cost_usd` is an estimate from `LEAD_COST` in
`leadpipeline.js`. Only the Claude figure is derived from published per-token
rates; the Places and xAI numbers are **placeholders set deliberately high**.
Compare them against a real bill after the first week and correct them —
the daily ceiling is only as good as those constants.
