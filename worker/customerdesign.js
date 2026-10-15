/* GET /api/briefing/customer-design?q=<name> — what a customer's shed IS,
 * read out of the CRM so Jarvis can render it ("Jarvis, render Nahui's shed").
 *
 * Read-only, behind the same BRIEFING_API_KEY as the rest of /api/briefing.
 * Source order, best first:
 *   1. saved 3D design   (saved_designs, matched by contact name/email)
 *   2. latest quote      (submissions.details.config)
 *   3. inquiry / notes   (no config: the customer's own words and CRM notes)
 * Nothing here is invented: every spec line comes from a stored field, and a
 * field that is missing is simply left out. No prices.
 */
import { buildSpecLines } from "./buildspec.js";
import { SHEET_LABEL } from "./pricing.js";

const CD_STYLE_SHEET = { gable: "aframe", barn: "barn", leanto: "leanto", hip: "poolhouse", "3peak": "3peak", "4peak": "4peak" };
const CD_WALL = { front: "front", back: "back", left: "left side", right: "right side" };
const CD_ROOF_MAT = { shingle: "asphalt shingle", metal: "metal" };

function cdStr(v) { return String(v == null ? "" : v).trim(); }
function cdJson(s) { if (s && typeof s === "object") return s; try { return JSON.parse(s); } catch { return null; } }
function cdHex(n) { const v = Number(n); return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? "#" + v.toString(16).toUpperCase().padStart(6, "0") : ""; }

export function normName(s) {
  return cdStr(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['’]s\b/g, "").replace(/[^a-z0-9@. ]+/g, " ").replace(/\s+/g, " ").trim();
}
/* 0 = no match. Higher is better. "nahui" matches "Nahui Lopez"; "nahui lopes"
   still matches by one-edit tolerance on tokens of 5+ letters. */
function cdLev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function nameScore(query, name) {
  const q = normName(query), n = normName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  const qt = q.split(" "), nt = n.split(" ");
  let hit = 0;
  for (const t of qt) {
    if (nt.includes(t)) { hit += 2; continue; }
    if (t.length >= 3 && nt.some((x) => x.startsWith(t))) { hit += 1.5; continue; }
    if (t.length >= 5 && nt.some((x) => Math.abs(x.length - t.length) <= 1 && cdLev(t, x) <= 1)) { hit += 1; continue; }
    return 0; // every query word must land
  }
  return Math.round((hit / (2 * qt.length)) * 90);
}

function cdColorLine(label, name, paint, num) {
  const bits = [];
  if (paint && paint.brand && paint.code) {
    bits.push(paint.brand + " " + paint.code + (paint.name ? " " + paint.name : ""));
  } else if (name) bits.push(name);
  const h = (paint && paint.hex) || cdHex(num);
  if (!bits.length && !h) return "";
  return label + ": " + (bits.join(" ") || "custom color") + (h ? " (" + h + ")" : "");
}

function cdPlaceOn(item) {
  const w = CD_WALL[cdStr(item.wall)];
  if (!w) return "";
  const p = Number(item.pos);
  let where = "";
  if (Number.isFinite(p)) where = p < 0.2 ? "near the left end of the " : p > 0.8 ? "near the right end of the " : (Math.abs(p - 0.5) < 0.08 ? "centered on the " : "on the ");
  else where = "on the ";
  return where + w + " wall";
}

/* The plain-English spec, and a render prompt built only from it. */
export function describeDesign(config) {
  const c = config && typeof config === "object" ? config : null;
  if (!c) return null;
  const style = cdStr(c.style);
  const styleLabel = SHEET_LABEL[CD_STYLE_SHEET[style]] || (style ? style : "");
  const lines = [];
  const size = c.w && c.l ? c.w + "' wide x " + c.l + "' deep" : "";
  if (size) lines.push("Size: " + size + (c.h ? ", " + c.h + "' walls" : "") + (c.pitch ? ", " + c.pitch + "/12 roof pitch" : ""));
  if (styleLabel) lines.push("Style: " + styleLabel);
  const names = c.colorNames || {}, paint = c.paint || {};
  const sid = cdColorLine("Siding color", names.siding, paint.siding, c.sidingColor); if (sid) lines.push(sid);
  const trim = cdColorLine("Trim color", names.trim, paint.trim, c.trimColor); if (trim) lines.push(trim);
  const roofMat = CD_ROOF_MAT[cdStr(c.roofType)];
  const roof = cdColorLine("Roof", names.roof, null, c.roofColor);
  if (roof || roofMat) lines.push((roof || "Roof: ") + (roofMat ? (roof ? ", " : "") + roofMat : ""));
  if (cdStr(c.soffit)) lines.push("Soffit: " + (c.soffit === "trim" ? "matches trim" : c.soffit === "match" ? "matches siding" : c.soffit));
  if (c.addons && c.addons.ridgeVent === true) lines.push("Ridge vent: yes");
  /* Shop spec (siding type, doors, windows, porch, loft, add-ons...) from the
     same helper the install invite uses, so names never drift. */
  /* Drop the shell line (said above) and the bare "Roof:" line (said with its
     colour above); keep only add-ons that are actually switched on —
     fbColor/shutterColor are colour settings, not add-ons. */
  const ad = c.addons && typeof c.addons === "object" ? Object.fromEntries(Object.entries(c.addons).filter(([k, v]) => v === true || (typeof v === "string" && v !== "none" && !/Color$/.test(k)))) : c.addons;
  const shop = buildSpecLines({ ...c, addons: ad }).filter((l) => !/^\d/.test(l) && !/^Roof: /.test(l));
  for (const l of shop) lines.push(l);
  const doors = (Array.isArray(c.doors) ? c.doors : []).map((d) => cdPlaceOn(d)).filter(Boolean);
  if (doors.length) lines.push("Door placement: " + doors.join("; "));
  const wins = (Array.isArray(c.windows) ? c.windows : []).map((w) => cdPlaceOn(w)).filter(Boolean);
  if (wins.length) lines.push("Window placement: " + wins.join("; "));
  return { style: styleLabel, lines, text: lines.join("\n") };
}

export function renderPrompt(name, spec) {
  if (!spec || !spec.lines.length) return "";
  return "Photorealistic exterior render of a custom backyard storage shed, built exactly to this spec. " +
    "Front wall faces the viewer at a three-quarter angle; show the front and right side. Keep proportions true to the dimensions. " +
    "Do not add features that are not listed.\n" + spec.text;
}

const CD_SQL = {
  designs: "SELECT code, config, contact_name, contact_email, created_at FROM saved_designs ORDER BY created_at DESC LIMIT 2000",
  customers: "SELECT id, name, email FROM customers ORDER BY id DESC LIMIT 5000",
  subs: "SELECT id, details, status, created_at FROM submissions WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 20",
  notes: "SELECT text, created_at FROM notes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5"
};
async function cdAll(db, sql, ...args) {
  try { const r = await db.prepare(sql).bind(...args).all(); return (r && r.results) || []; } catch { return []; }
}

export async function findCustomerDesign(db, q) {
  const query = cdStr(q).slice(0, 120);
  if (normName(query).length < 2) return { error: "q required", status: 400 };
  const customers = (await cdAll(db, CD_SQL.customers)).map((r) => ({ ...r, score: nameScore(query, r.name) })).filter((r) => r.score > 0);
  const designs = (await cdAll(db, CD_SQL.designs)).map((r) => ({ ...r, score: nameScore(query, r.contact_name) })).filter((r) => r.score > 0);
  const best = Math.max(0, ...customers.map((r) => r.score), ...designs.map((r) => r.score));
  if (!best) return { found: false, query, error: "No customer matches" };
  const cust = customers.filter((r) => r.score === best);
  const customer = cust[0] || null;
  const name = customer ? customer.name : designs.find((d) => d.score === best).contact_name;
  const email = customer && cdStr(customer.email).toLowerCase();
  const ambiguous = [...new Set([...cust.map((r) => r.name), ...designs.filter((d) => d.score === best).map((d) => d.contact_name)]
    .map(cdStr))].filter((n) => normName(n) !== normName(name));
  const base = { found: true, query, customer: { id: customer ? customer.id : null, name }, other_matches: ambiguous.slice(0, 5) };

  /* Which design? A WON quote is what is being built, so it wins outright.
     Otherwise the newest of saved 3D designs and quotes: saved designs are
     often earlier drafts of a quote that came later. Ties go to the saved
     design. */
  const savedAll = designs.filter((d) => d.score === best && cdJson(d.config));
  if (email) for (const d of await cdAll(db, CD_SQL.designs)) if (cdStr(d.contact_email).toLowerCase() === email && cdJson(d.config) && !savedAll.some((x) => x.code === d.code)) savedAll.push(d);
  const subs = customer ? await cdAll(db, CD_SQL.subs, customer.id) : [];
  const quotes = subs.map((q) => ({ q, d: cdJson(q.details) })).filter((x) => x.d && x.d.config && typeof x.d.config === "object");
  const won = quotes.find((x) => x.q.status === "won");
  const saved = savedAll.sort((x, y) => cdStr(y.created_at).localeCompare(cdStr(x.created_at)))[0];
  const quote = won || quotes[0];
  const useQuote = quote && (won || !saved || cdStr(quote.q.created_at) > cdStr(saved.created_at));
  if (useQuote) return cdFinish(base, "quote", quote.d.config, { submission_id: quote.q.id, status: quote.q.status, created_at: quote.q.created_at });
  if (saved) return cdFinish(base, "saved_design", cdJson(saved.config), { code: saved.code, created_at: saved.created_at });

  // 3. inquiry / lead notes: no config to render from, only the words.
  const words = [];
  for (const s of subs) { const d = cdJson(s.details); if (d) for (const k of ["notes", "message", "description"]) if (cdStr(d[k])) words.push(cdStr(d[k])); }
  const notes = customer ? (await cdAll(db, CD_SQL.notes, customer.id)).map((n) => cdStr(n.text)).filter(Boolean) : [];
  if (words.length || notes.length) return { ...base, source: "inquiry", config: null, spec: null, spec_text: "", inquiry: words.slice(0, 3), notes: notes.slice(0, 5) };
  return { ...base, source: null, config: null, spec: null, spec_text: "", error: "No saved design, quote or inquiry notes" };
}

function cdFinish(base, source, config, ref) {
  const spec = describeDesign(config);
  return { ...base, source, ref, config, spec: spec.lines, style: spec.style, spec_text: spec.text, prompt: renderPrompt(base.customer.name, spec) };
}
