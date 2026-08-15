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

## Handing off to the Shed Co. website later

Whoever manages their site can wire up two things, whenever you're ready
to connect it — no changes needed on your end:

**Read live pricing** (e.g. to populate their design tool):
```js
fetch("https://potentia-assistant.thepotentianetwork.workers.dev/shed/pricing")
  .then(r => r.json())
  .then(data => console.log(data.pricing)); // [{label, category, price, unit}, ...]
```

**Submit a customer design request** (lands in your admin dashboard):
```js
fetch("https://potentia-assistant.thepotentianetwork.workers.dev/shed/submit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Customer name",
    email: "customer@example.com",
    phone: "555-1234",
    details: { size: "10x12", style: "Gable", color: "Barn Red" } // whatever fields their form has
  })
});
```

Before that goes live, add their real domain to the `ALLOWED_ORIGINS` list
near the top of `worker/index.js` (currently has a placeholder comment
marking where), or their site's requests will be blocked by CORS.

## Cost control already built in

- Chat replies capped at 400 tokens; history capped at last 20
  messages / 1000 characters each. Model is Claude Haiku 4.5 (cheap, fast).
- Admin sessions expire after 12 hours.
- Submission `details` capped at 5000 characters; pricing labels/units
  capped to sane lengths — all just to stop a malformed request from
  writing huge rows into the database.

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
