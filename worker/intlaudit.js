/* International leads, Phase 2 (2026-11-03): US relevance + site audit +
   rule-based opportunity. Pure functions over what intlcrawl.crawlSite
   already fetched (crawl.docs, present when it is called with keepHtml),
   plus one optional network step: a small HEAD sample of the homepage's
   own links for the broken-link check.

   No imports (build-bundle.mjs inlines this file). Nothing here invents a
   problem: an item is `confirmed_issue` only when it was measured on a page
   we fetched; anything inferred from absence is `opportunity_needs_review`;
   anything we could not check is `untested`.

   Evidence rows: { kind, category, status, confirmed, url, snippet }.
     category 'us'    — status 'confirmed' | 'needs_review'
     category 'audit' — status 'confirmed_issue' | 'opportunity_needs_review' | 'ok' | 'untested' */

export const AUDIT_STATUS = ["confirmed_issue", "opportunity_needs_review", "ok", "untested"];

/* Signal weights. lang_en is the only language signal; the score is capped
   unless at least INTL_US_MIN_NONLANG distinct non-language kinds are
   CONFIRMED (English alone — or English plus a guess — is not US demand). */
export const US_WEIGHTS = { lang_en: 15, usd_price: 25, us_phone: 25, us_audience: 20,
                            airport_transfer: 15, medical_tourism: 20, foreign_buyer: 20 };
export const INTL_US_MIN_NONLANG = 2;
export const US_GATE_CAP = 25;

const EN_WORDS = ["the", "and", "you", "your", "with", "our", "for", "are", "book", "now", "tour",
                  "from", "about", "contact", "we", "this", "will", "have"];
const ES_WORDS = ["el", "la", "los", "las", "y", "de", "del", "para", "con", "nuestro", "nuestros",
                  "reserva", "contacto", "somos", "es", "una", "por"];

function decode(s) {
  return String(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return " "; } });
}

export function visibleText(html) {
  return decode(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function snip(text, idx, len) {
  const s = Math.max(0, idx - 50);
  return text.slice(s, Math.min(text.length, idx + (len || 0) + 70)).trim().slice(0, 200);
}

function firstMatch(text, re) {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? { m, snippet: snip(text, m.index, m[0].length) } : null;
}

/* Share of common English vs Spanish function words in the text. */
export function languageMix(text) {
  const words = String(text || "").toLowerCase().match(/[a-záéíóúñü]+/g) || [];
  let en = 0, es = 0;
  for (const w of words) { if (EN_WORDS.indexOf(w) !== -1) en++; if (ES_WORDS.indexOf(w) !== -1) es++; }
  return { en, es, words: words.length };
}

const RE = {
  usdExplicit: /(US\s?\$\s?\d[\d,.]*|\$\s?\d[\d,.]*\s?(USD|US dollars|dlls?\.?)\b|\bUSD\s?\$?\s?\d[\d,.]*)/i,
  dollarBare: /\$\s?\d[\d,]*(\.\d{2})?/,
  usPhoneTel: /href\s*=\s*["']tel:\s*\+?1[\s.\-()]*([2-9]\d{2})[\s.\-()]*(\d{3})[\s.\-]*(\d{4})/i,
  usPhoneText: /\+1[\s.\-]?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b/,
  usAudience: /\b(from the (US|USA|U\.S\.|United States|States)|American (guests|clients|customers|tourists|travell?ers|patients|visitors|families)|(guests|clients|patients|visitors|travell?ers) from (the )?(US|USA|U\.S\.|United States|Canada and the US)|Estados Unidos|norteamericanos|estadounidenses)\b/i,
  usaBare: /\b(USA|U\.S\.A?\.)\b/,
  airport: /\b(airport (pick[\s-]?up|transfers?|shuttle|transportation)|(pick[\s-]?up|transfers?) (from|to) (the )?(SJD |Los Cabos |Cancun |CUN |PVR )?airport|hotel pick[\s-]?up|traslados? (al|del|desde el) aeropuerto|transporte (al|del) aeropuerto)\b/i,
  medical: /\b(medical tourism|dental tourism|patients? (from|traveling from|coming from) (the )?(US|USA|U\.S\.|United States|Canada|abroad)|international patients|(save|ahorr\w*) (up to )?\d{2}\s?%|compared (to|with) (US|U\.S\.|American) (prices|costs)|cross[\s-]border)\b/i,
  foreignBuyer: /\b(foreign (buyers?|nationals?|investors?)|fideicomiso|bank trust|buying (real estate|property) in mexico|for (americans|canadians)|non[\s-]residents?|title insurance|restricted zone)\b/i
};

/* US-relevance evidence from fetched docs [{url, html}]. One row per kind
   (the first, clearest hit), confirmed only for unambiguous rules. */
export function extractUsSignals(docs) {
  const found = {};
  const put = (kind, status, url, snippet) => {
    const prev = found[kind];
    if (prev && (prev.status === "confirmed" || status !== "confirmed")) return;
    found[kind] = { kind, category: "us", status, confirmed: status === "confirmed", url, snippet: String(snippet || "").slice(0, 200) };
  };
  for (const d of docs || []) {
    const html = String(d.html || "");
    const text = visibleText(html);
    const url = d.url || null;

    const langAttr = /<html[^>]*\blang\s*=\s*["']?([a-z]{2})/i.exec(html);
    const mix = languageMix(text);
    if (langAttr && langAttr[1].toLowerCase() === "en" && mix.en >= 5) put("lang_en", "confirmed", url, "<html lang=\"en\"> · " + text.slice(0, 120));
    else if (mix.words >= 40 && mix.en >= 8 && mix.en > mix.es) put("lang_en", "needs_review", url, "mostly English text: " + text.slice(0, 120));

    let h = firstMatch(text, RE.usdExplicit);
    if (h) put("usd_price", "confirmed", url, h.snippet);
    else if ((h = firstMatch(text, RE.dollarBare))) put("usd_price", "needs_review", url, "$ price, currency not stated (MXN also uses $): " + h.snippet);

    h = firstMatch(html, RE.usPhoneTel);
    if (h) put("us_phone", "confirmed", url, "tel: +1 " + h.m[1] + " " + h.m[2] + " " + h.m[3]);
    else if ((h = firstMatch(text, RE.usPhoneText))) put("us_phone", "confirmed", url, h.snippet);

    if ((h = firstMatch(text, RE.usAudience))) put("us_audience", "confirmed", url, h.snippet);
    else if ((h = firstMatch(text, RE.usaBare))) put("us_audience", "needs_review", url, h.snippet);

    if ((h = firstMatch(text, RE.airport))) put("airport_transfer", "confirmed", url, h.snippet);
    if ((h = firstMatch(text, RE.medical))) put("medical_tourism", "confirmed", url, h.snippet);
    if ((h = firstMatch(text, RE.foreignBuyer))) put("foreign_buyer", "confirmed", url, h.snippet);
  }
  return Object.values(found);
}

/* 0–100. Confirmed rows count fully, needs_review rows half. Gate: fewer
   than INTL_US_MIN_NONLANG confirmed non-language kinds caps the score. */
export function usScore(signals) {
  let raw = 0, nonLang = 0, nonLangAny = 0;
  for (const s of signals || []) {
    if (s.category && s.category !== "us") continue;
    const w = US_WEIGHTS[s.kind] || 0;
    raw += s.confirmed ? w : w / 2;
    if (s.kind !== "lang_en") { nonLangAny++; if (s.confirmed) nonLang++; }
  }
  const gate = nonLang >= INTL_US_MIN_NONLANG;
  const score = Math.min(100, Math.round(raw));
  return { score: gate ? score : Math.min(US_GATE_CAP, score), raw: score, gate,
           non_language_confirmed: nonLang, non_language_total: nonLangAny };
}

const BOOKING_RE = /(fareharbor|peek\.com|peekpro|rezdy|bokun|checkfront|calendly|xola|trekksoft|cloudbeds|opentable|resy\.com|acuityscheduling|simplybook|setmore|booksy|zocdoc|doctoralia|getyourguide|viator|bookeo|regiondo|tripadvisor\.com\/widget|bookingkit|vagaro|square\.site\/book|squareup\.com\/appointments|youcanbook\.me|booking\.com\/widget|mews|sirvoy|little ?hotelier)/i;
const ANALYTICS_RE = /(googletagmanager\.com|google-analytics\.com|gtag\(|\bga\(\s*['"]create|fbq\(|connect\.facebook\.net\/[^"']*fbevents|clarity\.ms|hotjar|plausible\.io|matomo|static\.cloudflareinsights|tiktok\.com\/i18n\/pixel|analytics\.js)/i;

function sameSiteLinks(html, pageUrl, max) {
  const out = [];
  let base;
  try { base = new URL(pageUrl); } catch (e) { return out; }
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(String(html || ""))) && out.length < max) {
    const raw = m[1].trim();
    if (/^(mailto|tel|javascript|whatsapp|sms):/i.test(raw)) continue;
    let u;
    try { u = new URL(raw, base); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4)$/i.test(u.pathname)) continue;
    u.hash = "";
    const k = u.toString();
    if (seen.has(k) || k === base.toString()) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/* HEAD (then GET on 405/501) a sample of same-site links. Returns
   [{url, status, error}]. status 0 = network error/timeout. */
export async function sampleLinks(html, pageUrl, opts) {
  const o = opts || {};
  const f = o.fetchImpl || fetch;
  const links = sameSiteLinks(html, pageUrl, o.max || 6);
  const out = [];
  for (const url of links) {
    try {
      let r = await f(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs || 6000) });
      if (r.status === 405 || r.status === 501) r = await f(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs || 6000) });
      out.push({ url, status: r.status });
    } catch (e) { out.push({ url, status: 0, error: String((e && e.message) || e).slice(0, 80) }); }
  }
  return out;
}

function auditRow(kind, status, url, snippet) {
  return { kind: "audit_" + kind, category: "audit", status, confirmed: status === "confirmed_issue",
           url: url || null, snippet: String(snippet || "").slice(0, 200) };
}

/* input: { crawl, docs, pagespeed: {performance, hasViewport, unreachable}|null|undefined,
            links: [{url,status}]|null, siteUrl, usSignals } */
export function auditSite(input) {
  const i = input || {};
  const crawl = i.crawl || {};
  const docs = i.docs || [];
  const home = docs[0];
  const homeUrl = (home && home.url) || (crawl.pages && crawl.pages[0] && crawl.pages[0].url) || i.siteUrl || null;
  const rows = [];
  const allHtml = docs.map((d) => String(d.html || "")).join("\n");

  // HTTPS — where the homepage actually landed after redirects.
  if (!home) rows.push(auditRow("https", "untested", homeUrl, "homepage not fetched"));
  else if (/^https:/i.test(home.url)) rows.push(auditRow("https", "ok", home.url, "served over https"));
  else rows.push(auditRow("https", "confirmed_issue", home.url, "homepage served over plain http (no redirect to https)"));

  // Viewport — meta tag in the fetched homepage; PageSpeed corroborates.
  if (!home) rows.push(auditRow("viewport", "untested", homeUrl, "homepage not fetched"));
  else {
    const vp = /<meta[^>]+name\s*=\s*["']?viewport["']?[^>]*>/i.exec(String(home.html || ""));
    if (vp) rows.push(auditRow("viewport", "ok", home.url, vp[0]));
    else if (i.pagespeed && i.pagespeed.hasViewport === true) rows.push(auditRow("viewport", "ok", home.url, "PageSpeed: viewport present (set by script)"));
    else rows.push(auditRow("viewport", "confirmed_issue", home.url, "no <meta name=\"viewport\"> in homepage HTML" + (i.pagespeed && i.pagespeed.hasViewport === false ? "; PageSpeed agrees" : "")));
  }

  // Speed — PageSpeed mobile performance.
  const ps = i.pagespeed;
  if (!ps || ps.performance == null) rows.push(auditRow("speed", "untested", homeUrl, ps && ps.unreachable ? "PageSpeed could not load the page (" + (ps.code || "") + ")" : "PageSpeed not run"));
  else if (ps.performance < 50) rows.push(auditRow("speed", "confirmed_issue", homeUrl, "PageSpeed mobile performance " + ps.performance + "/100"));
  else if (ps.performance < 90) rows.push(auditRow("speed", "opportunity_needs_review", homeUrl, "PageSpeed mobile performance " + ps.performance + "/100"));
  else rows.push(auditRow("speed", "ok", homeUrl, "PageSpeed mobile performance " + ps.performance + "/100"));

  // Broken links — crawled pages that 404'd plus a HEAD sample.
  const tested = (i.links || []).concat((crawl.pages || []).slice(1).filter((p) => p.status > 0).map((p) => ({ url: p.url, status: p.status })));
  const hard = tested.filter((l) => l.status === 404 || l.status === 410 || l.status >= 500);
  const soft = tested.filter((l) => l.status === 0);
  if (!tested.length) rows.push(auditRow("broken_links", "untested", homeUrl, "no internal links sampled"));
  else if (hard.length) rows.push(auditRow("broken_links", "confirmed_issue", hard[0].url, hard.length + " of " + tested.length + " sampled links broken (" + hard.slice(0, 3).map((l) => l.status + " " + l.url).join(", ") + ")"));
  else if (soft.length) rows.push(auditRow("broken_links", "opportunity_needs_review", soft[0].url, soft.length + " of " + tested.length + " sampled links timed out / refused"));
  else rows.push(auditRow("broken_links", "ok", homeUrl, tested.length + " sampled links all answered"));

  if (!docs.length) {
    for (const k of ["forms", "booking", "analytics", "whatsapp", "lang_switch"]) rows.push(auditRow(k, "untested", homeUrl, "no pages fetched"));
    return rows;
  }
  const where = (re) => { for (const d of docs) { re.lastIndex = 0; const m = re.exec(String(d.html || "")); if (m) return { url: d.url, snippet: snip(String(d.html), m.index, m[0].length) }; } return null; };

  let w = where(/<form\b[^>]*>/i);
  rows.push(w ? auditRow("forms", "ok", w.url, w.snippet.replace(/\s+/g, " "))
              : auditRow("forms", "opportunity_needs_review", homeUrl, "no <form> on " + docs.length + " crawled page(s); may be script-rendered"));

  w = where(BOOKING_RE);
  rows.push(w ? auditRow("booking", "ok", w.url, "booking widget: " + w.snippet.replace(/\s+/g, " "))
              : auditRow("booking", "opportunity_needs_review", homeUrl, "no known booking widget on " + docs.length + " crawled page(s)"));

  w = where(ANALYTICS_RE);
  rows.push(w ? auditRow("analytics", "ok", w.url, "tag: " + w.snippet.replace(/\s+/g, " "))
              : auditRow("analytics", "opportunity_needs_review", homeUrl, "no analytics tag in fetched HTML (could be server-side)"));

  w = where(/(wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/)/i);
  rows.push(w || (crawl.whatsapp && crawl.whatsapp.length)
    ? auditRow("whatsapp", "ok", w ? w.url : homeUrl, w ? w.snippet.replace(/\s+/g, " ") : "WhatsApp " + crawl.whatsapp[0])
    : auditRow("whatsapp", "opportunity_needs_review", homeUrl, "no WhatsApp link on crawled pages"));

  w = where(/<link[^>]+hreflang\s*=\s*["']?(en|es)/i) ||
      where(/<a\b[^>]*href\s*=\s*["'][^"']*\/(en|es)(\/|["'?])[^>]*>/i) ||
      where(/>\s*(English|Español|EN\s*\|\s*ES|ES\s*\|\s*EN)\s*</i) ||
      where(/(gtranslate|weglot|translatepress|wpml|google_translate_element)/i);
  const hasEn = (i.usSignals || []).some((s) => s.kind === "lang_en");
  rows.push(w ? auditRow("lang_switch", "ok", w.url, w.snippet.replace(/\s+/g, " "))
              : auditRow("lang_switch", "opportunity_needs_review", homeUrl,
                         "no EN/ES switcher found; site reads as " + (hasEn ? "English only" : "Spanish only / no English detected")));
  return rows;
}

const TOURISM = ["intl_yacht_charter", "intl_tours", "intl_dive", "intl_adventure", "intl_golf",
                 "intl_boutique_hotel", "intl_property_mgmt", "intl_spa", "intl_transport",
                 "intl_restaurant", "intl_wedding", "intl_dental", "intl_medical"];

const TALK = {
  usd_price: "Prices are shown in USD",
  us_phone: "Publishes a US (+1) phone number",
  us_audience: "Site speaks directly to US/American visitors",
  airport_transfer: "Offers airport pickup / transfers",
  medical_tourism: "Markets to cross-border / international patients",
  foreign_buyer: "Markets to foreign buyers",
  lang_en: "Site has English content",
  audit_https: "Homepage is not on https — browsers flag it as Not Secure",
  audit_viewport: "No mobile viewport — the site does not adapt to phones",
  audit_speed: "Slow on mobile",
  audit_broken_links: "Broken internal links"
};

/* Rule-based opportunity. Talking points cite only confirmed rows. */
export function opportunity(us, evidence, segment) {
  const ev = evidence || [];
  const st = (k) => { const r = ev.find((e) => e.kind === "audit_" + k); return r ? r.status : "untested"; };
  let gaps = 0;
  for (const e of ev) if (e.category === "audit") gaps += e.status === "confirmed_issue" ? 18 : e.status === "opportunity_needs_review" ? 5 : 0;
  const usPart = us ? us.score : 0;
  const score = Math.min(100, Math.round(usPart * 0.5 + gaps));

  let service;
  if (st("https") === "confirmed_issue" || st("viewport") === "confirmed_issue" || st("speed") === "confirmed_issue" || st("broken_links") === "confirmed_issue")
    service = "website_rebuild";
  else if (st("lang_switch") === "opportunity_needs_review") service = "bilingual_site";
  else if (st("booking") === "opportunity_needs_review" && TOURISM.indexOf(segment) !== -1) service = "booking_ux";
  else if (st("speed") === "opportunity_needs_review") service = "speed_tuneup";
  else if (st("analytics") === "opportunity_needs_review") service = "analytics_tracking";
  else service = "growth_retainer";

  const gate = !!(us && us.gate);
  // A US-irrelevant site is never above C, however many gaps it has.
  const tier = gate && score >= 60 ? "A" : (gate || (score >= 50 && usPart >= 15)) ? "B" : "C";

  const points = [];
  for (const e of ev) {
    if (!(e.status === "confirmed" || e.status === "confirmed_issue")) continue;
    if (e.kind === "lang_en") continue;
    const head = TALK[e.kind];
    if (!head) continue;
    points.push(head + (e.kind === "audit_speed" ? " (" + e.snippet + ")" : "") + " — " + (e.url || ""));
  }
  return { score, service, tier, talking_points: points.slice(0, 6) };
}

export const SERVICE_LABELS = {
  website_rebuild: "Website rebuild (mobile-first, https, fast)",
  bilingual_site: "Bilingual EN/ES site",
  booking_ux: "Online booking UX",
  speed_tuneup: "Speed & performance tune-up",
  analytics_tracking: "Analytics & conversion tracking",
  growth_retainer: "Growth / care retainer"
};

/* Whole Phase 2 pass for one crawled site. opts: { segment, pagespeed (result
   or null), fetchImpl, linkSample (bool, default true) }. Never throws. */
export async function analyzeIntlLead(crawl, opts) {
  const o = opts || {};
  const docs = (crawl && crawl.docs) || [];
  const us = extractUsSignals(docs);
  const usS = usScore(us);
  let links = null;
  if (o.linkSample !== false && docs[0]) {
    try { links = await sampleLinks(docs[0].html, docs[0].url, { fetchImpl: o.fetchImpl, max: o.linkMax || 6 }); }
    catch (e) { links = null; }
  }
  const audit = auditSite({ crawl, docs, pagespeed: o.pagespeed, links, usSignals: us });
  const evidence = us.concat(audit);
  const opp = opportunity(usS, evidence, o.segment);
  return { evidence, us: usS, opportunity: opp, suggested_service_label: SERVICE_LABELS[opp.service] };
}
