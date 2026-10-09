/* WHAT TO BUILD, for the people building it.
 *
 * The install invite carried one line — "12x20 ft · gable · board-batten" —
 * which tells a crew where to go and nothing about what to make when they get
 * there. This turns the stored config into the spec a shop actually works
 * from: the specShell, then everything hung on it.
 *
 * NO PRICES. The customer is a guest on every on-site day, the description is
 * the same for everyone on the event, and a calendar invite is the easiest
 * thing in the world to forward. The money lives behind the CRM login where
 * it already does.
 *
 * Items are named through the SAME helpers the quote uses — doorDisplayName,
 * windowDisplayName, sidingDisplayName — so the shop reads "8' Roll-Up Garage
 * Door · Brown" and so does the customer's quote. A second set of labels here
 * would be a second thing to keep in step, and they would drift the first time
 * a product was renamed.
 */
import { doorDisplayName, doorColorLabel, windowDisplayName, sidingDisplayName } from "./pricing.js";

const SPEC_WALL = { front: "front", back: "back", left: "left", right: "right" };

const SPEC_FOUNDATION = { blocks: "Blocks", gravel: "Gravel pad", pad: "Concrete pad",
                     existing: "Customer's own slab" };
const SPEC_FOUND_FINISH = { plain: "", broom: "broom finish", coated: "coated" };
const SPEC_INTERIOR = { none: "", bare: "Bare", painted: "Painted", insulated: "Insulated" };
const SPEC_FLOOR = { none: "", good: "Good", better: "Better", best: "Best" };
const SPEC_ELEC = { none: "", basic: "Basic", core: "Core", essential: "Essential" };
const SPEC_ROOF = { shingle: "Shingle", metal: "Metal" };
const SPEC_DECK = { none: "No deck", pt: "Pressure-treated deck", composite: "Composite deck" };

function sv(v) { return String(v == null ? "" : v).trim(); }
function specCap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* "3 × Black Vinyl Window 24x36 (left)" — specGrouped, because six identical
   windows listed six times is a wall of text nobody reads to the end of. */
function specGrouped(items, label) {
  const order = [], seen = {};
  items.forEach((it) => {
    const key = label(it);
    if (!key) return;
    if (!seen[key]) { seen[key] = { n: 0, walls: [] }; order.push(key); }
    seen[key].n += 1;
    const w = SPEC_WALL[sv(it.wall)];
    if (w && seen[key].walls.indexOf(w) < 0) seen[key].walls.push(w);
  });
  return order.map((k) => {
    const g = seen[k];
    const where = g.walls.length ? " (" + g.walls.join(", ") + ")" : "";
    return (g.n > 1 ? g.n + " × " : "") + k + where;
  });
}

/* The specShell, as one line: "12x20 ft · gable · 9ft walls · 6/12 pitch". */
function specShell(c) {
  const bits = [];
  if (c.w && c.l) bits.push(c.w + "x" + c.l + " ft");
  if (c.style) bits.push(sv(c.style));
  if (c.h) bits.push(c.h + "ft walls");
  if (c.pitch) bits.push(c.pitch + "/12 pitch");
  return bits.join(" · ");
}

function specFoundationLine(c) {
  const base = SPEC_FOUNDATION[sv(c.foundation)] || "";
  if (!base) return "";
  const fin = SPEC_FOUND_FINISH[sv(c.foundationFinish)] || "";
  return "Foundation: " + base + (fin ? " (" + fin + ")" : "");
}

/* Partial porch: where along its wall it sits, as the crew standing outside
   that wall would say it. pos runs from the wall's start corner (front: the
   left end; right side: the BACK end, which is on your right as you face it),
   so the side wall reads the other way round. */
function specPorchWhere(c, span, len) {
  const off = Math.max(0, Math.min(span - len, Number(c.porchOff) || 0));
  const fromLeft = sv(c.porchLoc) === "side" ? span - len - off : off;
  const fromRight = span - len - fromLeft;
  if (fromLeft < 0.5) return "left end";
  if (fromRight < 0.5) return "right end";
  if (Math.abs(fromLeft - fromRight) < 0.5) return "centered";
  return fromLeft + "ft from the left end";
}
function specPorchLine(c) {
  const loc = sv(c.porchLoc);
  if (!loc || loc === "none") return "";
  const bits = [specCap(loc)];
  const depth = Number(c.porchDepth) || 0;
  const span = loc === "front" ? Number(c.w) || 0 : Number(c.l) || 0;
  const len = Number(c.porchLen) || 0;
  if (depth && len > 0 && len < span) {
    bits.push(depth + "ft deep × " + len + "ft long");
    bits.push(specPorchWhere(c, span, len));
  } else if (depth) bits.push(depth + "ft deep");
  const deck = SPEC_DECK[sv(c.porchDeck)];
  if (deck) bits.push(deck);
  const tier = sv(c.porchTier);
  if (tier && tier !== "standard") bits.push(tier);
  return "Porch: " + bits.join(" · ");
}

function specEnclosedLine(c) {
  const loc = sv(c.porchLoc), depth = Number(c.porchDepth) || 0;
  const w = Number(c.w) || 0, l = Number(c.l) || 0;
  if (!w || !l || (loc !== "front" && loc !== "side") || !(depth > 0)) return "";
  if (c.style && sv(c.style) !== "gable") return "";
  const span = loc === "front" ? w : l;
  const len = (Number(c.porchLen) > 0 && Number(c.porchLen) < span) ? Number(c.porchLen) : span;
  const porch = depth * len;
  const room = w * l - porch;
  const shape = len < span ? "" : (loc === "front" ? " (" + w + "x" + (l - depth) + ")" : " (" + (w - depth) + "x" + l + ")");
  return "Enclosed: " + room + " sq ft" + shape + " · Porch: " + depth + "x" + len + " ft (" + porch + " sq ft)";
}

/* Interior, floor and electrical on one line — they are three short answers
   and three lines of "Interior: none" is how a description stops being read. */
function specInsideLine(c) {
  const bits = [];
  const i = SPEC_INTERIOR[sv(c.intFinish)]; if (i) bits.push("Interior " + i.toLowerCase());
  const f = SPEC_FLOOR[sv(c.floor)];        if (f) bits.push("floor " + f.toLowerCase());
  const e = SPEC_ELEC[sv(c.elec)];          if (e) bits.push("electrical " + e.toLowerCase());
  return bits.length ? specCap(bits.join(" · ")) : "";
}

function specAddonLine(c) {
  const a = c.addons;
  if (!a || typeof a !== "object") return "";
  const names = Object.keys(a)
    .filter((k) => a[k] === true || (a[k] && a[k] !== "none"))
    /* camelCase to words: shedRemoval -> shed removal. The keys are the
       designer's own and there is no table of labels for them, so this is a
       transformation rather than a lookup that would silently miss new ones. */
    .map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase().trim());
  return names.length ? "Add-ons: " + names.join(", ") : "";
}

/* Every line the shop needs, shortest first. Empty entries drop out, so a
   plain shed is four lines and a loaded one is a dozen. */
export function buildSpecLines(config) {
  const c = config && typeof config === "object" ? config : null;
  if (!c) return [];
  const out = [];

  const s = specShell(c); if (s) out.push(s);
  /* With a porch, the footprint is not the room: say both, because the crew
     frames the room and the customer bought the footprint. */
  const enc = specEnclosedLine(c); if (enc) out.push(enc);
  /* sidingDisplayName already ends in "Siding" — "Siding: Board & Batten
     Siding" is the kind of thing that reads fine in code and looks careless on
     a page someone else is working from. */
  const sid = sidingDisplayName(sv(c.siding)).replace(/\s*Siding$/, "");
  if (sid) out.push("Siding: " + sid);
  const roof = SPEC_ROOF[sv(c.roofType)]; if (roof) out.push("Roof: " + roof);
  const f = specFoundationLine(c); if (f) out.push(f);

  const doors = Array.isArray(c.doors) ? c.doors : [];
  /* Name AND colour, joined exactly as the quote's own door line does — a
     brown roll-up and a white one are different things to pull off the rack,
     and the quote has always said which. */
  const dl = specGrouped(doors, (d) => doorDisplayName(d) + doorColorLabel(d));
  if (dl.length) out.push("Doors: " + dl.join(", "));

  const wins = Array.isArray(c.windows) ? c.windows : [];
  const wl = specGrouped(wins, (w) => (w && w.type ? windowDisplayName(w.type) : "Window"));
  if (wl.length) out.push("Windows: " + wl.join(", "));

  const vents = Array.isArray(c.vents) ? c.vents.length : 0;
  if (vents) out.push("Vents: " + vents);

  const p = specPorchLine(c); if (p) out.push(p);

  const loft = sv(c.loft);
  if (loft && loft !== "none") out.push("Loft: " + loft.replace("-", "ft "));

  const shelves = Array.isArray(c.shelves) ? c.shelves : [];
  if (shelves.length) {
    out.push("Shelves: " + specGrouped(shelves, (sh) =>
      (sh.len ? sh.len + "ft " : "") + (sh.depth || 16) + '" deep').join(", "));
  }

  const inside = specInsideLine(c); if (inside) out.push(inside);
  const ad = specAddonLine(c); if (ad) out.push(ad);

  return out;
}

/* THE 3D BUILD, openable by anyone on the invite.
 *
 * Only ever the SHORT ?d= code. The other thing a permalink can carry is the
 * whole config base64'd into the fragment, which runs to thousands of
 * characters — and this is going into the query string of a Google Calendar
 * template link, where it would push the URL past what browsers and Google
 * will carry and truncate the description with it. A missing link costs a
 * click; a truncated one silently eats the spec above it.
 */
export function designLinkFor(details, base) {
  const pl = sv(details && details.permalink);
  const short = /[?&]d=([A-Za-z0-9]+)/.exec(pl);
  if (!short) return "";
  return (base || "https://www.shedpro-utah.com/designer.html") + "?d=" + short[1];
}
