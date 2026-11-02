/* ══════════════════════════════════════════════════════════════════════════
   INTERNATIONAL LEADS — SITE CRAWL + PUBLIC ROLE-EMAIL EXTRACTION

   For an international lead the business's own website IS the value: it is
   where the durable contact details come from (not Google Places), and it is
   what Potentia would be pitching to improve.

   Rules, all enforced here:
   - Same-domain only. Homepage plus links whose URL or text looks like a
     contact / about / reservations / booking page (EN + ES), at most
     INTL_CRAWL.maxPages pages in total.
   - robots.txt is fetched once and honoured (User-agent * and our own UA).
   - Every fetch has a timeout and a byte ceiling.
   - Emails come only from mailto: links and visible text on the pages we
     fetched. Nothing is ever guessed or constructed.
   - Only ROLE addresses (info@, reservaciones@, ...) on the site's own or a
     related domain are kept as outreach candidates. A personal-looking
     address (juan.perez@) is excluded and only counted. A free-mail role-ish
     address shown on the site (cabocharters@gmail.com) is kept but flagged
     for review, since many small Mexican operators run on Gmail.

   NO IMPORTS: the bundler (build-bundle.mjs) inlines this file as-is.
   ══════════════════════════════════════════════════════════════════════════ */

export const INTL_CRAWL = {
  maxPages: 6,
  timeoutMs: 10000,
  maxBytes: 600000,
  userAgent: "PotentiaLeadBot/1.0 (+https://potentianetwork.com)"
};

/* Local parts that name a function, not a person. Matched on the whole local
   part, or the local part with a trailing digit/separator suffix stripped
   (info1@, ventas.cabo@). */
export const ROLE_LOCALPARTS = [
  "info", "contact", "contacto", "contactus", "reservations", "reservation",
  "reservaciones", "reservacion", "reservas", "booking", "bookings", "book",
  "sales", "ventas", "marketing", "hello", "hola", "office", "oficina",
  "charters", "charter", "admin", "support", "service", "servicio",
  "concierge", "inquiries", "enquiries", "team", "mail"
];

const FREEMAIL = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.mx",
  "hotmail.com.mx", "live.com", "live.com.mx", "icloud.com", "prodigy.net.mx", "aol.com", "msn.com"];

/* Paths/anchor text that are worth following. */
const FOLLOW_RE = /(contact|contacto|about|nosotros|acerca|quienes|reserv|book|booking|charter|tours?-?info)/i;

/* Asset-ish "emails" that regexes love: logo@2x.png, sprite@3x.webp. */
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|mp4|woff2?)$/i;

const SECOND_LEVEL = ["com.mx", "org.mx", "net.mx", "gob.mx", "edu.mx", "co.uk", "com.au", "com.br"];

/* example.co.uk -> example.co.uk, www.shop.example.com.mx -> example.com.mx */
export function baseDomain(hostOrUrl) {
  let h = String(hostOrUrl || "").trim().toLowerCase();
  if (!h) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) { try { h = new URL(h).hostname; } catch (e) { return null; } }
  h = h.replace(/^www\./, "").replace(/\.$/, "");
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return h || null;
  const last2 = parts.slice(-2).join(".");
  if (SECOND_LEVEL.indexOf(last2) !== -1 && parts.length >= 3) return parts.slice(-3).join(".");
  return last2;
}

/* "cabo-yachts.com" and "caboyachts.mx" are the same business. Compare the
   brand label with punctuation removed. */
function brandLabel(domain) {
  const b = baseDomain(domain);
  if (!b) return "";
  return b.split(".")[0].replace(/[^a-z0-9]/g, "");
}

export function relatedDomain(emailDomain, siteUrl) {
  const a = baseDomain(emailDomain), b = baseDomain(siteUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  const la = brandLabel(a), lb = brandLabel(b);
  return la.length >= 4 && la === lb;
}

export function isRoleLocal(local) {
  const l = String(local || "").toLowerCase();
  if (ROLE_LOCALPARTS.indexOf(l) !== -1) return true;
  const stem = l.replace(/[._+-]?\d+$/, "").split(/[._+-]/)[0];
  return ROLE_LOCALPARTS.indexOf(stem) !== -1;
}

/* Classify one address against the site it was found on.
   Returns { type, eligibility } or null when it should not be stored. */
export function classifyEmail(email, siteUrl) {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(String(email || "").toLowerCase());
  if (!m) return null;
  const [, local, domain] = m;
  const role = isRoleLocal(local);
  if (FREEMAIL.indexOf(domain) !== -1) {
    // Shown on the business's own site, but not provably theirs.
    return { type: role ? "freemail_role" : "freemail", eligibility: "review" };
  }
  if (!relatedDomain(domain, siteUrl)) return null;           // someone else's address
  if (!role) return { type: "personal", eligibility: "excluded" };
  return { type: "role", eligibility: "pending_verification" };
}

/* Cloudflare "email protection" hides addresses as a hex blob XOR'd with its
   first byte. Decoding it is reading what the page shows a visitor. */
export function decodeCfEmail(hex) {
  const s = String(hex || "");
  if (!/^[0-9a-f]+$/i.test(s) || s.length < 4) return null;
  const key = parseInt(s.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < s.length; i += 2) out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16) ^ key);
  return out;
}

function htmlDecode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;

/* Every address a visitor could see or click on this page. */
export function extractEmails(html) {
  const found = new Set();
  const src = String(html || "");
  const add = (e) => {
    if (!e) return;
    const v = e.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(v)) return;
    if (ASSET_RE.test(v)) return;
    found.add(v);
  };
  let m;
  const mailto = /href\s*=\s*["']\s*mailto:([^"'?\s]+)/gi;
  while ((m = mailto.exec(src))) add(htmlDecode(decodeURIComponent(m[1])));
  const cf = /data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi;
  while ((m = cf.exec(src))) add(decodeCfEmail(m[1]));
  const cfHref = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi;
  while ((m = cfHref.exec(src))) add(decodeCfEmail(m[1]));
  // Visible text: drop scripts/styles/tags first so JS blobs don't leak in.
  const text = htmlDecode(src
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s*\[\s*(at|arroba)\s*\]\s*/gi, "@").replace(/\s*\(\s*(at|arroba)\s*\)\s*/gi, "@");
  for (const e of text.match(EMAIL_RE) || []) add(e);
  return Array.from(found);
}

/* tel: links only — the number the business itself publishes. */
export function extractPhones(html) {
  const out = new Set(), seen = new Set();
  const re = /href\s*=\s*["']\s*tel:([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const v = decodeURIComponent(m[1]).replace(/[^\d+]/g, "");
    const digits = v.replace(/\D/g, "");
    if (digits.length < 10) continue;
    // One entry per number however it is written (+1 800…, 1800…, 011 52…).
    const key = digits.slice(-10);
    if (!seen.has(key)) { seen.add(key); out.add(v); }
  }
  return Array.from(out);
}

/* WhatsApp click-to-chat (wa.me / api.whatsapp.com) — common for MX operators. */
export function extractWhatsApp(html) {
  const out = new Set();
  const re = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{10,15})/gi;
  let m;
  while ((m = re.exec(String(html || "")))) out.add(m[1].replace(/^\+/, ""));
  return Array.from(out);
}

/* Same-site links worth following, best first. */
export function candidateLinks(html, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch (e) { return []; }
  const site = baseDomain(base.hostname);
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const href = m[1].trim();
    if (/^(mailto|tel|javascript|whatsapp|sms):/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (baseDomain(u.hostname) !== site) continue;
    if (ASSET_RE.test(u.pathname) || /\.pdf$/i.test(u.pathname)) continue;
    const label = m[2].replace(/<[^>]+>/g, " ");
    if (!FOLLOW_RE.test(u.pathname) && !FOLLOW_RE.test(label)) continue;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    // contact pages first: they are where the address usually is.
    const pri = /contact|contacto/i.test(u.pathname + " " + label) ? 0 : 1;
    out.push({ url: key, pri });
  }
  out.sort((a, b) => a.pri - b.pri);
  return out.map((x) => x.url);
}

/* Minimal robots.txt: groups for "*" and our UA; Disallow prefixes; an Allow
   that is longer than the matching Disallow wins (Google's rule). */
export function parseRobots(text, ua) {
  const want = String(ua || "").toLowerCase().split("/")[0];
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (k === "disallow" || k === "allow") cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && want && want.indexOf(a) === 0));
  const use = mine.length ? mine : groups.filter((g) => g.agents.indexOf("*") !== -1);
  const rules = [].concat(...use.map((g) => g.rules)).filter((r) => r.path !== "" || r.allow);
  return function allowed(pathname) {
    let best = null;
    for (const r of rules) {
      if (!r.path) continue;
      const p = r.path.replace(/\*$/, "");
      if (r.path.endsWith("$") ? pathname === p.slice(0, -1) : pathname.indexOf(p) === 0) {
        if (!best || p.length > best.len || (p.length === best.len && r.allow)) best = { len: p.length, allow: r.allow };
      }
    }
    return best ? best.allow : true;
  };
}

async function fetchText(fetchImpl, url, timeoutMs, maxBytes, ua) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8",
               "Accept-Language": "en,es;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const ctype = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
  let text = await res.text();
  if (text.length > maxBytes) text = text.slice(0, maxBytes);
  return { ok: res.ok, status: res.status, url: res.url || url, ctype, text };
}

/* Crawl one site. Never throws: a site that will not load is a result.
   Returns {
     ok, home_status, pages: [{url,status}], emails: [{email,source_url,type,eligibility}],
     excluded: n (personal / off-domain addresses seen), phones: [...], whatsapp: [...],
     robots_blocked: n, error
   } */
export async function crawlSite(siteUrl, opts) {
  const o = Object.assign({}, INTL_CRAWL, opts || {});
  const fetchImpl = o.fetchImpl || fetch;
  const result = { ok: false, home_status: null, pages: [], emails: [], excluded: 0,
                   phones: [], whatsapp: [], robots_blocked: 0, error: null };
  let home;
  try {
    let s = String(siteUrl || "").trim();
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    home = new URL(s);
  } catch (e) { result.error = "bad url"; return result; }

  let allowed = () => true;
  try {
    const r = await fetchText(fetchImpl, home.origin + "/robots.txt", o.timeoutMs, 100000, o.userAgent);
    if (r.ok && !/html/i.test(r.ctype)) allowed = parseRobots(r.text, o.userAgent);
  } catch (e) { /* no robots.txt reachable: default allow */ }

  const siteRefs = [home.toString()];
  const queue = [home.toString()];
  const visited = new Set();
  const emailMap = new Map();
  const phones = new Set(), wa = new Set();
  let excluded = new Set();

  while (queue.length && result.pages.length < o.maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let path;
    try { path = new URL(url).pathname || "/"; } catch (e) { continue; }
    if (!allowed(path)) { result.robots_blocked++; continue; }
    let page;
    try {
      page = await fetchText(fetchImpl, url, o.timeoutMs, o.maxBytes, o.userAgent);
    } catch (e) {
      result.pages.push({ url, status: 0 });
      if (result.pages.length === 1) result.error = String((e && e.message) || e).slice(0, 160);
      continue;
    }
    result.pages.push({ url, status: page.status });
    if (result.pages.length === 1) {
      /* A redirect to another domain (brand.com -> brandsportfishing.com) is
         still the business's site: judge email domains against where we
         actually landed as well as where we started. */
      try { if (page.url) siteRefs.push(new URL(page.url).toString()); } catch (e) {}
      result.home_status = page.status;
      result.ok = page.ok;
      if (!page.ok) { result.error = "homepage " + page.status; break; }
    }
    if (!page.ok || (page.ctype && !/html|text/i.test(page.ctype))) continue;

    for (const e of extractEmails(page.text)) {
      let c = null;
      for (const ref of siteRefs) { c = classifyEmail(e, ref); if (c && c.eligibility !== "excluded") break; }
      if (!c || c.eligibility === "excluded") { excluded.add(e); continue; }
      if (!emailMap.has(e)) emailMap.set(e, { email: e, source_url: page.url || url, type: c.type, eligibility: c.eligibility });
    }
    for (const p of extractPhones(page.text)) phones.add(p);
    for (const w of extractWhatsApp(page.text)) wa.add(w);

    if (result.pages.length === 1) {
      for (const l of candidateLinks(page.text, page.url || url)) if (!visited.has(l)) queue.push(l);
    }
  }
  // Own-domain role addresses first, then free-mail ones awaiting review.
  result.emails = Array.from(emailMap.values()).sort((a, b) =>
    (a.type === "role" ? 0 : 1) - (b.type === "role" ? 0 : 1));
  result.excluded = excluded.size;
  result.phones = Array.from(phones);
  result.whatsapp = Array.from(wa);
  return result;
}
