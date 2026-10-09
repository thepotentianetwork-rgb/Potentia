/* THE QUOTE'S OWN ARITHMETIC, LIFTED OUT OF THE PAGE.
 *
 * Every figure a customer is billed — the phase rows, the 7.25% tax, the 30%
 * deposit against each phase, and the way a discount scales through those
 * deposits — was computed in quote.html and nowhere else. That was fine while
 * the only thing that needed it was the page rendering it. It stops being fine
 * the moment a Stripe invoice has to carry the same numbers: the server cannot
 * ask a browser what to charge someone.
 *
 * So this is a PORT, not a rewrite. It is quote.html's taxBreakdown() with the
 * two module-level globals it read (ADJUSTMENTS, COMPED) turned into arguments
 * and the DOM left behind. Same order of operations, same rounding, same
 * clamps. tests/quotelines.test.mjs runs this and the page's own copy against
 * the same redlines and fails on any difference, because a port that is merely
 * close would bill a customer a different number than the quote they agreed to.
 *
 * Why it matters that there is now ONE of these: this repo has been bitten
 * repeatedly by a value living in two places with only one of them reachable —
 * addVent vs ventCyIn, the lighting rig, the rail heights, the Google Voice
 * URLs. quote.html's own comment says the adjustment arithmetic "mirrors
 * applyAdjustments() in worker/index.js ... if you change one, change the
 * other". A deposit figure is the worst candidate in the codebase for that
 * arrangement.
 */

/* Utah sales tax — applied to the shed and to each separately-billed item
   (concrete, interior finishing) since each is invoiced as its own sale. */
export const TAX_RATE = 0.0725;
/* 30% of each phase's tax-included price, collected before THAT phase begins;
   the rest of the phase is due once it is complete (billed by phase from the
   CRM — see buildPhaseInvoice in invoices.js). The quote's note says exactly
   this, and invoices.test.mjs fails if the two drift apart again. The
   whole-job deposit invoice still exists for a job someone wants billed in
   one go. */
export const DEPOSIT_RATE = 0.30;

/* What the base shed price covers, named under the Base Shed line. NAMES ONLY,
   no figures: the shed line is a SELL price and the money behind these headings
   is cost, so printing both would let a customer read the margin off the page. */
export const BASE_SHED_INCLUDES = [
  'Materials & lumber',
  'Shop labor',
  'Build labor & assembly'
];
/* 'Fuel & delivery' was the fourth heading until 9 Oct 2026. Taken out on
   Nando's word ("we will charge more if needed"): the base price must not
   read as covering travel, which is billed as its own Travel & fuel line when
   a job needs it. The quote carries a neutral note instead. */

export const REMOVAL_NAMES = ['Shed Removal', 'Concrete Removal'];

/* SITE PREP: what is done to the site before the pad goes down, billed as its
   own phase in front of the concrete. The two removals, plus sprinkler
   relocation, whose line carries the head count in its name
   ("Sprinkler Relocation — 3 heads"), so it is matched by prefix. */
export function isSitePrep(name) {
  const n = String(name == null ? '' : name);
  return REMOVAL_NAMES.indexOf(n) !== -1 || /^Sprinkler Relocation\b/.test(n);
}

/* TRAVEL & FUEL SURCHARGE — an adjustment of kind "travel" ({days, rate}),
   added from the CRM. Unlike a discount it is real work billed, so it lands
   INSIDE the Shed phase as its own sub-line (the crew's driving happens over
   the build days) and is taxed with that phase, the same way every other
   line on the quote is. Percentage adjustments are worked out on the
   subtotal WITHOUT it: "10% off" is off the shed, not off the fuel. */
export function travelAmount(a) {
  if (!a || a.kind !== 'travel') return 0;
  const d = Number(a.days), r = Number(a.rate);
  if (!isFinite(d) || !isFinite(r) || d <= 0 || r <= 0) return 0;
  return Math.round(d * r * 100) / 100;
}
function qlNum(n) {
  const v = Number(n) || 0;
  return (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
export function travelLabel(a) {
  const d = Number(a && a.days) || 0;
  return 'Travel & fuel surcharge \u2014 ' + qlNum(d) + ' day' + (d === 1 ? '' : 's') +
    ' \u00d7 $' + qlNum(a && a.rate);
}

/* WHAT A CUSTOMER CALLS THE STYLE. Gable and A-Frame are the same shed: the
   designer stores it as "gable", the price sheet calls it "A-Frame", and
   quotes saved before this carry "A-Frame" in their redline. Everything a
   customer reads says "Gable / A-Frame", whichever of the three it was given.
   Anything else passes through unchanged. */
export function shedStyleName(s) {
  const v = String(s == null ? '' : s).trim();
  return /^(gable|a-?frame)$/i.test(v) ? 'Gable / A-Frame' : v;
}

function num(n) { return Number(n) || 0; }

function sumLines(lines, amtKey) {
  return (lines || []).reduce(function (t, l) { return t + num(l[amtKey]); }, 0);
}

/* Mirrors compItemsFromRedline() in the worker: the individually-priced lines
   this quote actually sums, which is exactly the set that can be given away. */
export function compItemPrices(redline) {
  const out = {};
  if (!redline || typeof redline !== 'object') return out;
  function push(name, amt) {
    const n = Number(amt);
    if (!name || !isFinite(n) || n <= 0) return;
    out[name] = (out[name] || 0) + Math.round(n * 100) / 100;
  }
  (redline.addonLines || []).forEach((l) => push(l && l.name, l && l.amt));
  (redline.doorUpLines || []).forEach((l) => push(l && l.label, l && l.up));
  (redline.windowSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.dormerSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.shelfSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  push(redline.porchSellName, redline.porchSell);
  push(redline.porchDeckSellName, redline.porchDeckSell);
  push(redline.sidingSellName, redline.sidingSell);
  push(redline.heightSellName, redline.heightSell);
  push(redline.elecSellName, redline.elecSell);
  push(redline.loftSellName, redline.loftSell);
  push(redline.intSellName, redline.intSell);
  push(redline.foundName, redline.foundSell);
  return out;
}

/* Which comp-able names belong to which quote row. Interior finishing and the
   foundation are their own phases; everything else rolls into the shed. */
export function nameList(redline, which) {
  if (!redline) return [];
  if (which === 'interior') return [redline.intSellName].filter(Boolean);
  if (which === 'foundation') return [redline.foundName].filter(Boolean);
  const out = [];
  (redline.addonLines || []).forEach(function (l) {
    if (l && l.name && !isSitePrep(l.name)) out.push(l.name);
  });
  (redline.doorUpLines || []).forEach(function (l) { if (l && l.label) out.push(l.label); });
  (redline.windowSellLines || []).forEach(function (l) { if (l && l.label) out.push(l.label); });
  (redline.dormerSellLines || []).forEach(function (l) { if (l && l.label) out.push(l.label); });
  (redline.shelfSellLines || []).forEach(function (l) { if (l && l.label) out.push(l.label); });
  [redline.porchSellName, redline.porchDeckSellName, redline.sidingSellName,
   redline.heightSellName, redline.elecSellName, redline.loftSellName]
    .forEach(function (n) { if (n) out.push(n); });
  return out;
}

/* PRICE OVERRIDES — an adjustment {kind:'override', item, amount, note} that
   sets one line to a different price for THIS quote: the concrete pad or the
   sprinkler relocation once the site has been seen ("price may vary depending
   on conditions of the site"), or any other line on the quote. Returns
   name -> {was, amt, delta, note}; delta (was - amt) comes off the phase the
   line belongs to, exactly where a comp would. A line that is comped is free,
   and a comp wins over an override. */
export function overrideMap(redline, adjustments) {
  const prices = compItemPrices(redline);
  const comped = compedMap(redline, adjustments);
  const out = {};
  (adjustments || []).forEach(function (a) {
    if (!a || a.kind !== 'override' || prices[a.item] == null || comped[a.item] != null) return;
    const amt = Math.max(0, Math.round(Number(a.amount) * 100) / 100);
    if (!isFinite(amt)) return;
    out[a.item] = { was: prices[a.item], amt: amt, delta: prices[a.item] - amt, note: a.note || null };
  });
  return out;
}

/* The comped lines for this submission, as name -> amount. quote.html builds
   this in render() before calling taxBreakdown; here it is derived inside, so
   a caller cannot forget to. */
export function compedMap(redline, adjustments) {
  const prices = compItemPrices(redline);
  const out = {};
  (adjustments || []).forEach(function (a) {
    if (a && a.kind === 'comp' && prices[a.item] != null) out[a.item] = prices[a.item];
  });
  return out;
}

function removalLines(redline) {
  if (!redline || !Array.isArray(redline.addonLines)) return [];
  return redline.addonLines.filter((l) => l && isSitePrep(l.name));
}
function removalTotal(redline) {
  return removalLines(redline).reduce((t, l) => t + num(l.amt), 0);
}

/* The phase rows and every total on the quote.
   Returns null for a redline it cannot read, exactly as taxBreakdown does — a
   caller that treats null as "no charge" would be a bug either way, but this
   keeps the two identical. */
export function quoteLines(redline, adjustments) {
  if (!redline || typeof redline !== 'object') return null;
  const COMPED = compedMap(redline, adjustments);
  const OVR = overrideMap(redline, adjustments);
  const ADJUSTMENTS = adjustments || [];

  /* How much of a given row is being comped, so the reduction lands on the
     phase the item actually belongs to rather than being lopped off the
     bottom line. */
  function compedIn(names) {
    let t = 0;
    names.forEach(function (n) {
      if (n && COMPED[n] != null) t += COMPED[n];
      else if (n && OVR[n]) t += OVR[n].delta;   // an override moves the same phase
    });
    return t;
  }

  /* Everything about the shed itself is rolled into one "Shed" line; only
     foundation and interior finishing are broken out.

     This sum has to account for EVERY sell field the engine adds into
     customerPrice. A field the engine charges for and this list omits is money
     the quote silently fails to bill — paintSell was missing here for exactly
     that reason, and it is on almost every shed. worker/quotepage.test.mjs
     checks this sum against the engine. */
  const shedTotal = num(redline.marginPrice)
    + sumLines(redline.doorUpLines, 'up')
    + sumLines(redline.windowSellLines, 'price')
    + sumLines(redline.dormerSellLines, 'price')
    + num(redline.porchSell)
    + num(redline.porchDeckSell)
    + num(redline.sidingSell)
    + num(redline.paintSell)
    + num(redline.laborSell)
    + num(redline.heightSell)
    + num(redline.elecSell)
    + num(redline.floorSell)
    + num(redline.loftSell)
    + sumLines(redline.shelfSellLines, 'price')
    + sumLines(redline.addonLines, 'amt')
    - removalTotal(redline)
    - compedIn(nameList(redline, 'shed'));

  /* Build order matches how the job is actually run and billed: concrete goes
     in first, then the shed, then interior finishing — each its own phase.
     Phase numbers are assigned from position after the rows are built, because
     removal is added at the FRONT when it applies. */
  /* Each row carries its KIND (clearance / foundation / shed / interior) so two
     builds billed together can match concrete with concrete and shed with shed
     even when one has a site-clearance phase in front and its numbers shift. */
  const rows = [];
  function add(label, amt) {
    if (!label || !amt) return null;
    const row = { label: label, amt: Number(amt) };
    rows.push(row);
    return row;
  }

  const removal = removalLines(redline);
  if (removal.length) {
    const rTotal = removalTotal(redline) - compedIn(removal.map((l) => l.name));
    /* Two removals have always read "Site Clearance"; with sprinkler work in
       the mix it is more than clearing, so it reads "Site Prep". */
    const multiName = removal.some((l) => REMOVAL_NAMES.indexOf(l.name) === -1) ? 'Site Prep' : 'Site Clearance';
    const rRow = add(removal.length > 1 ? multiName : removal[0].name, rTotal);
    if (rRow) rRow.kind = 'clearance';
    if (rRow) {
      rRow.estimate = removal.some((l) => !REMOVAL_NAMES.includes(l.name));
      const o = removal.length === 1 && OVR[removal[0].name];
      if (o) rRow.override = { was: o.was, note: o.note };
    }
    if (rRow && removal.length > 1) {
      rRow.subLines = removal.map((l) => ({ label: l.name, amt: num(l.amt) - (OVR[l.name] ? OVR[l.name].delta : 0) }));
    }
  }

  /* The pad spec (4" poured slab) belongs on every quote regardless of when its
     redline snapshot was taken, so it is added at display time rather than
     depending on redline.foundName having been generated with it baked in. */
  let foundLabel = redline.foundName || 'Concrete';
  if (foundLabel.indexOf('Concrete Pad') === 0 && foundLabel.indexOf('4"') === -1) {
    foundLabel = foundLabel.replace('Concrete Pad', 'Concrete Pad (4" slab)');
  }
  const foundRow = add(foundLabel, num(redline.foundSell) - compedIn(nameList(redline, 'foundation')));
  if (foundRow) foundRow.kind = 'foundation';
  /* A promo on the pad: the row's amount is already what they pay; this is
     only so the page can show the list price struck through and the promo
     as its own line. A comped pad has no row, so nothing to show. */
  /* Concrete is an estimate (site conditions); the quote says so beside it. */
  if (foundRow && /^Concrete/i.test(foundLabel)) foundRow.estimate = true;
  const foundOvr = OVR[redline.foundName];
  /* Overridden: the staff figure is the price, so the promo arithmetic no
     longer describes it; the row says what it was instead. */
  if (foundRow && foundOvr) foundRow.override = { was: foundOvr.was, note: foundOvr.note };
  else if (foundRow && num(redline.foundPromo) > 0) {
    foundRow.listAmt = foundRow.amt + num(redline.foundPromo);
    foundRow.promo = { label: redline.foundPromoName || 'Concrete pad promo', amt: num(redline.foundPromo) };
  }
  let travelTotal = 0;
  const travelLines = [];
  ADJUSTMENTS.forEach(function (a) {
    const t = travelAmount(a);
    if (t > 0) { travelTotal += t; travelLines.push({ label: travelLabel(a), amt: t }); }
  });
  const shedRow = add('Shed' + (redline.baseSheetLabel ? ' (' + shedStyleName(redline.baseSheetLabel) + ')' : ''), shedTotal + travelTotal);
  if (shedRow) shedRow.kind = 'shed';
  const intRow = add(redline.intSellName || 'Interior Finishing', num(redline.intSell) - compedIn(nameList(redline, 'interior')));
  if (intRow) intRow.kind = 'interior';

  /* Electrical and flooring are still billed and deposited as part of the Shed
     phase (their dollars stay inside shedTotal) — these just break them out so
     the customer can see what the package costs, without changing the
     invoicing or deposit schedule. Appended rather than assigned: electrical
     used to claim this slot outright, so anything added alongside it silently
     replaced it. */
  function shedSubLine(amt, label, includes) {
    if (!shedRow || !amt) return;
    (shedRow.subLines = shedRow.subLines || []).push({
      label: label, amt: num(amt),
      includes: Array.isArray(includes) ? includes : null
    });
  }
  /* Each is net of anything comped on it, because a comped line is already
     listed under "Included at No Charge" — charging for it here and crediting
     it there would show the customer the same item twice at two prices. */
  function shedItem(label, amt) {
    if (!label) return;
    shedSubLine(num(amt) - (COMPED[label] || 0) - (OVR[label] ? OVR[label].delta : 0), label);
  }
  function shedItemsFrom(lines, nameKey, amtKey) {
    (lines || []).forEach(function (l) {
      if (!l || isSitePrep(l[nameKey])) return;   // its own phase
      shedItem(l[nameKey], l[amtKey]);
    });
  }

  /* Build labour is INSIDE this number, not a line of its own. Added whole,
     with no comp subtracted, deliberately: labour is not in the compable set,
     and shedTotal above adds laborSell with no comp handling either. Netting a
     comp off here alone would drop Base Shed without dropping the phase total
     it has to add up to. */
  shedSubLine(num(redline.marginPrice) + num(redline.laborSell), 'Base Shed', BASE_SHED_INCLUDES);
  shedItem(redline.heightSellName, redline.heightSell);
  shedItem(redline.sidingSellName, redline.sidingSell);
  shedItem(redline.paintSellName, redline.paintSell);
  shedItem(redline.porchSellName, redline.porchSell);
  shedItem(redline.porchDeckSellName, redline.porchDeckSell);
  shedItemsFrom(redline.doorUpLines, 'label', 'up');
  shedItemsFrom(redline.windowSellLines, 'label', 'price');
  shedItemsFrom(redline.dormerSellLines, 'label', 'price');
  shedItem(redline.loftSellName, redline.loftSell);
  shedItemsFrom(redline.shelfSellLines, 'label', 'price');
  shedItemsFrom(redline.addonLines, 'name', 'amt');

  shedSubLine(redline.elecSell, redline.elecSellName || 'Electrical', redline.elecIncludes);
  shedSubLine(redline.floorSell, redline.floorSellName || 'Flooring');
  travelLines.forEach(function (t) { shedSubLine(t.amt, t.label); });

  if (!rows.length) return null;
  rows.forEach(function (r, i) {
    r.phase = i + 1;
    r.label = 'Phase ' + r.phase + ' — ' + r.label;
  });
  rows.forEach(function (r) {
    r.tax = r.amt * TAX_RATE;
    r.total = r.amt + r.tax;
    r.deposit = r.total * DEPOSIT_RATE;
  });
  const subtotal = rows.reduce((t, r) => t + r.amt, 0);
  const percentBase = subtotal - travelTotal;

  /* Percentages and flat amounts, applied BEFORE tax because tax is owed on
     what they actually pay, and scaled through the per-phase deposits by the
     same ratio — a discount that reduced the total but not the deposits would
     have them paying a bigger share up front for a cheaper shed.
     Comps are already gone by this point: they were removed from their own
     phase rows above, which is what makes the percentage land on the post-comp
     figure without any extra arithmetic here. */
  let percentAdjust = 0, amountAdjust = 0;
  ADJUSTMENTS.forEach(function (a) {
    if (!a) return;
    const v = Number(a.value);
    if (a.kind === 'percent' && isFinite(v)) percentAdjust += percentBase * (v / 100);
    else if (a.kind === 'amount' && isFinite(v)) amountAdjust += v;
  });
  const adjust = percentAdjust + amountAdjust;
  let adjustedSubtotal = subtotal + adjust;
  if (adjustedSubtotal < 0) adjustedSubtotal = 0;
  const ratio = subtotal > 0 ? (adjustedSubtotal / subtotal) : 1;
  if (adjust) {
    rows.forEach(function (r) {
      r.tax = r.amt * ratio * TAX_RATE;
      r.total = r.amt * ratio + r.tax;
      r.deposit = r.total * DEPOSIT_RATE;
    });
  }

  const tax = adjustedSubtotal * TAX_RATE;
  const depositTotal = rows.reduce((t, r) => t + r.deposit, 0);
  return withCardPrice(redline, {
    rows: rows,
    subtotal: subtotal,
    /* What a percentage adjustment is a percentage OF: the subtotal less any
       travel surcharge. Equal to subtotal on every quote without one. */
    percentBase: percentBase,
    travel: travelTotal,
    adjust: adjust,
    percentAdjust: percentAdjust,
    amountAdjust: amountAdjust,
    adjustedSubtotal: adjustedSubtotal,
    tax: tax,
    total: adjustedSubtotal + tax,
    /* Tax-inclusive so they sit beside the Total Due figure and subtract to it
       exactly. Derived from adjustedSubtotal rather than from `adjust`, because
       adjustedSubtotal is clamped at zero — a discount bigger than the shed
       would otherwise report a saving larger than the price. */
    totalBefore: subtotal * (1 + TAX_RATE),
    savings: Math.max(0, subtotal - adjustedSubtotal) * (1 + TAX_RATE),
    depositTotal: depositTotal
  });
}

/* ── REGULAR (CARD) PRICE AND THE CASH, CHECK & BANK TRANSFER DISCOUNT ──────
 *
 * Nando, 9 Oct 2026: card payers pay 3% more than everyone else, done the way
 * the card networks allow — the POSTED price is the card price and paying any
 * other way earns a discount. A quote priced while the switch was on carries
 * redline.cardUplift (0.03); every money figure here is then today's figure x
 * (1 + uplift): each phase, sub-line, promo, adjustment, the tax and every
 * deposit. One uniform factor, applied once, at the end — so the quote reads
 * as plain regular prices with no "card" line anywhere, and the arithmetic
 * above (comps, overrides, adjustments, rounding) is untouched.
 *
 * The discount is uplift / (1 + uplift) of the regular price (2.913% for 3%),
 * which takes a non-card payer back to EXACTLY today's figure:
 *   today $10,000.00 -> regular (card) $10,300.00 -> discount $300.00 -> $10,000.00
 *
 * A redline without cardUplift (every quote priced before the switch, or while
 * it is off) comes back exactly as before — no cashDiscount key at all. */
export const CARD_UPLIFT_MAX = 0.10;
export function cardUpliftOf(redline) {
  const u = Number(redline && redline.cardUplift);
  return Number.isFinite(u) && u > 0 ? Math.min(CARD_UPLIFT_MAX, u) : 0;
}
/* The share of the REGULAR price that comes off: 0.03 -> 0.029126... */
export function cashDiscountFraction(uplift) {
  const u = Number(uplift) || 0;
  return u > 0 ? u / (1 + u) : 0;
}
/* How the saving is written for customers: the true share of the regular
   price, to one decimal (3% uplift -> "2.9"). Not "3": $300 off $10,300 is
   2.91%, and an advertised discount has to be the real one. */
export function cashDiscountPctLabel(uplift) {
  const f = cashDiscountFraction(uplift) * 100;
  return String(Math.round(f * 10) / 10);
}
export const CASH_DISCOUNT_LABEL = 'Cash, check & bank transfer discount';
export function cashDiscountDisclosure(uplift, amount) {
  const pct = cashDiscountPctLabel(uplift);
  const amt = Number(amount) > 0 ? ' (' + qlMoney(amount) + ')' : '';
  return 'Prices shown are our regular prices. Pay by cash, check, cashier\u2019s check or bank transfer (ACH) and save ' + pct + '%' + amt + '.';
}
function qlMoney(n) {
  return '$' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function withCardPrice(redline, bd) {
  const u = cardUpliftOf(redline);
  if (!u) return bd;
  const k = 1 + u;
  const sc = (v) => (typeof v === 'number' ? v * k : v);
  bd.rows.forEach(function (r) {
    ['amt', 'tax', 'total', 'deposit', 'listAmt'].forEach(function (f) { if (r[f] != null) r[f] = sc(r[f]); });
    if (r.promo) r.promo = Object.assign({}, r.promo, { amt: sc(Number(r.promo.amt) || 0) });
    if (r.override && r.override.was != null) r.override = Object.assign({}, r.override, { was: sc(Number(r.override.was) || 0) });
    if (r.subLines) r.subLines = r.subLines.map(function (l) { return Object.assign({}, l, { amt: sc(Number(l.amt) || 0) }); });
  });
  ['subtotal', 'percentBase', 'travel', 'adjust', 'percentAdjust', 'amountAdjust', 'adjustedSubtotal',
   'tax', 'total', 'totalBefore', 'savings', 'depositTotal'].forEach(function (f) { bd[f] = sc(bd[f]); });
  /* What a flat adjustment typed by staff becomes on this quote (the page and
     the invoice multiply the typed figure by this). */
  bd.priceScale = k;
  const cashTotal = bd.total / k;
  bd.cashDiscount = {
    uplift: u,
    percentLabel: cashDiscountPctLabel(u),
    fraction: cashDiscountFraction(u),
    /* Tax-inclusive, like Total Due: what comes off, and what is left to pay
       by cash, check, cashier's check or bank transfer. */
    amount: bd.total - cashTotal,
    cashTotal: cashTotal,
    cashDepositTotal: bd.depositTotal / k
  };
  return bd;
}
