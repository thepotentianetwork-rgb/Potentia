# Potentia AI Assistant — backend setup

The chat widget on the site (`/assistant.js`) needs a small backend that
holds your Anthropic API key and calls Claude on the widget's behalf — a
key can never live in the site's front-end code, since anyone could open
dev tools and steal it. This folder is that backend, built to run on
Cloudflare Workers (free tier is plenty for this).

## 1. Get an Anthropic API key

1. Go to https://console.anthropic.com and sign up / log in.
2. Add billing (usage is pay-as-you-go; a chat widget like this typically
   costs a few dollars a month at small-business traffic levels).
3. Create an API key under **Settings → API Keys**. Copy it — you'll paste
   it into Cloudflare in step 3.

## 2. Create the Worker

**Dashboard (no command line needed):**

1. Log into https://dash.cloudflare.com → **Workers & Pages** → **Create**
   → **Create Worker**.
2. Name it `potentia-assistant` → **Deploy** (deploys a placeholder first).
3. Click **Edit code**, delete the placeholder contents, and paste in the
   full contents of `worker/index.js` from this repo.
4. Click **Deploy**.

**Or with the CLI** (if you have Node installed):

```
cd worker
npx wrangler login
npx wrangler deploy
```

## 3. Add your API key as a secret

Never put the key directly in the code. In the dashboard:

1. Open your Worker → **Settings → Variables and Secrets**.
2. Add a secret named `ANTHROPIC_API_KEY`, value = the key from step 1.
3. Save (this redeploys automatically).

Or via CLI: `npx wrangler secret put ANTHROPIC_API_KEY`.

## 4. Set your allowed domain

Open `worker/index.js` and check the `ALLOWED_ORIGINS` list near the top —
it should include the exact domain(s) the site is served from (e.g.
`https://potentianetwork.com`). Update and redeploy if your domain differs
from what's already listed.

## 5. Point the widget at your Worker

1. Copy your Worker's URL from the Cloudflare dashboard (it looks like
   `https://potentia-assistant.<your-subdomain>.workers.dev`).
2. Open `/assistant.js` in the site and set:
   ```js
   var WORKER_URL = "https://potentia-assistant.<your-subdomain>.workers.dev/chat";
   ```
3. Commit and push — the widget will start calling your live backend.

Until step 5 is done, the widget still works and looks fully live, but
replies with a friendly "not connected yet" message instead of calling
the AI — so it's safe to ship the front-end before the backend is ready.

## Cost control already built in

- Each reply is capped at 400 tokens and conversation history sent per
  request is capped at the last 20 messages / 1000 characters each.
- Model used is Claude Haiku 4.5 — fast and inexpensive, well suited to a
  site FAQ/lead-qualifying assistant. To upgrade quality later, change
  `model: "claude-haiku-4-5-20251001"` in `index.js` to `"claude-sonnet-5"`.

## Optional next steps

- **Rate limiting**: add a Cloudflare KV namespace to throttle by IP if
  the widget gets abused. Not included here to keep initial setup simple.
- **Lead capture**: have the Worker also POST a summary to your Formspree
  endpoint (already used by contact.html) when a visitor shares contact
  info in the chat, so leads land in your inbox automatically.
