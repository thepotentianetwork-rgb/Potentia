/* COLOR-ONLY EDIT of a saved quote (Nando, 12 Oct 2026).
   Changes the stored design's colours and its renders, and NOTHING else:
   no re-price, the redline / quotedPrice / effective_price / adjustments are
   left exactly as they are, so a staff override can never be dropped by it.
   Colours are not priced (pricing.js never reads them), which is why this is
   allowed even on an order with a deposit. Door colours are NOT editable
   here: a roll-up door's colour changes its line name and upcharge. */
export const COLOR_KEYS = ["sidingColor", "trimColor", "roofColor"];
export const SOFFIT_VALUES = ["match", "trim", "white", "black", "cedar"];
const PAINT_PARTS = ["siding", "trim"];
const NAME_PARTS = ["siding", "trim", "roof"];

function cleanStr(v, n) { return typeof v === "string" ? v.slice(0, n || 80) : null; }
function cleanPaint(p) {
  if (!p || typeof p !== "object") return null;
  const o = {};
  ["brand", "code", "name", "hex", "sheen"].forEach((k) => { const s = cleanStr(p[k]); if (s) o[k] = s; });
  return Object.keys(o).length ? o : null;
}

/* Returns { error } or { config, changed } with only colour fields replaced. */
export function applyColorEdit(config, edit) {
  if (!config || typeof config !== "object") return { error: "This quote has no saved design." };
  if (!edit || typeof edit !== "object") return { error: "colors required" };
  const allowed = new Set([...COLOR_KEYS, "soffit", "paint", "colorNames"]);
  const extra = Object.keys(edit).filter((k) => !allowed.has(k));
  if (extra.length) return { error: "Only colours can be changed here: " + extra.join(", ") };
  const c = JSON.parse(JSON.stringify(config));
  const changed = [];
  for (const k of COLOR_KEYS) {
    if (edit[k] === undefined) continue;
    const v = Number(edit[k]);
    if (!Number.isInteger(v) || v < 0 || v > 0xffffff) return { error: "Bad colour for " + k };
    if (c[k] !== v) { c[k] = v; changed.push(k); }
  }
  if (edit.soffit !== undefined) {
    if (!SOFFIT_VALUES.includes(edit.soffit)) return { error: "Bad soffit" };
    if (c.soffit !== edit.soffit) { c.soffit = edit.soffit; changed.push("soffit"); }
  }
  if (edit.paint !== undefined) {
    const p = Object.assign({}, c.paint || {});
    for (const part of PAINT_PARTS) {
      if (!(part in (edit.paint || {}))) continue;
      const v = edit.paint[part] === null ? null : cleanPaint(edit.paint[part]);
      if (v) p[part] = v; else delete p[part];
    }
    if (JSON.stringify(p) !== JSON.stringify(c.paint || {})) { if (Object.keys(p).length) c.paint = p; else delete c.paint; changed.push("paint"); }
  }
  if (edit.colorNames !== undefined) {
    const n = Object.assign({}, c.colorNames || {});
    for (const part of NAME_PARTS) { const s = cleanStr((edit.colorNames || {})[part], 120); if (s) n[part] = s; }
    if (JSON.stringify(n) !== JSON.stringify(c.colorNames || {})) { c.colorNames = n; changed.push("colorNames"); }
  }
  /* Belt and braces: everything except colour fields must be byte-identical. */
  const strip = (x) => { const y = Object.assign({}, x); [...allowed].forEach((k) => delete y[k]); return JSON.stringify(y); };
  if (strip(c) !== strip(config)) return { error: "colour edit touched a non-colour field" };
  return { config: c, changed };
}

/* The new details: config + renders (+ history entry). Pricing fields untouched. */
export function detailsWithColors(details, config, renders, at) {
  const prev = { at, kind: "colors", config: details.config, renders: details.renders || null };
  const history = Array.isArray(details.history) ? details.history.slice(-9) : [];
  history.push(prev);
  const next = Object.assign({}, details, { config, renders: renders || details.renders || null,
    permalink: null, colorsUpdatedAt: at, history });
  let text = JSON.stringify(next);
  while (text.length > 20000 && next.history.length) { next.history.shift(); text = JSON.stringify(next); }
  return text;
}
