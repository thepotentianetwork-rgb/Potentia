// Potentia AI Assistant — Cloudflare Worker backend.
// Holds the Anthropic API key server-side and proxies chat requests from
// the widget in /assistant.js. See README.md for deployment steps.

// Add every origin the widget will be served from (your live domain,
// GitHub Pages URL, and localhost while testing).
const ALLOWED_ORIGINS = [
  "https://potentianetwork.com",
  "https://www.potentianetwork.com",
  "http://localhost:8080"
];

const SYSTEM_PROMPT = `You are the AI assistant embedded on the Potentia Studio website (a small web design & digital growth studio). Potentia builds custom, hand-built websites — no templates, no bloated platforms. 72-hour turnaround, free domain included for the first year.

Packages:
01 — Foundation: 3-Page Essential Site. Home, About & Contact pages, 5 images, free domain (1 year). One-time build, no monthly subscription (edits after the first 7 days are billed per change request).
02 — Booking: 3-Page Booking Site. Everything in Foundation, plus a live booking calendar. Includes a monthly plan for ongoing management & edits.
03 — Gallery: 4-Page Gallery Site. 15-photo gallery page, 1 featured video, free domain (1 year). Includes a monthly plan to edit, manage & update photos.
04 — Operator: Website + Growth System. Everything in Gallery, plus an AI chat assistant (like this one!), instant lead alerts, a built-in CRM, and a monthly performance report. Includes a monthly plan for the growth system & ongoing management.

Add-ons: Promotional Video, Google Business Setup, Google Profile Management (monthly), AI Content Engine (monthly), Professional Photography, Logo Vectorization, Service Menu Design.

Important: Potentia does not publish prices publicly — every quote is custom. NEVER state or guess a dollar amount, even if asked directly or pressured. If asked about cost, explain that pricing is tailored to the project and invite them to share project details on the contact page or by calling/texting (435) 277-0764; Potentia responds within 24 hours.

Be warm, concise, and confident — a few sentences at most. You are a live example of what Potentia builds (the Operator package's AI assistant), so when it's natural you can mention that this chat is itself a sample of that add-on. Don't be pushy. If asked something unrelated to Potentia or web design, answer briefly and steer back.`;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "Not found" }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400, origin);
    }

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const messages = incoming
      .slice(-20)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));

    if (messages.length === 0) {
      return json({ error: "No messages" }, 400, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Server not configured" }, 500, origin);
    }

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages
        })
      });
    } catch (e) {
      return json({ error: "Upstream request failed" }, 502, origin);
    }

    if (!upstream.ok) {
      return json({ error: "Upstream error" }, 502, origin);
    }

    const data = await upstream.json();
    const reply = data && data.content && data.content[0] && data.content[0].text
      ? data.content[0].text
      : "Sorry, I didn't catch that — could you rephrase?";

    return json({ reply }, 200, origin);
  }
};
