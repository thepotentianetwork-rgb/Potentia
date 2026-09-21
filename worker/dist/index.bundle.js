// Build stamp, written by build-bundle.mjs. Read it back from GET /version.
const WORKER_BUILD = "ade1cb2";
const WORKER_BUILT_AT = "2026-09-21T15:47:37.781Z";

// ---- inlined from worker/pricing.js by build-bundle.mjs — do not edit below by hand ----
/* Potentia / ShedPro — pricing engine, server-side only.
   Extracted verbatim from the pricing IIFE that used to live inside
   designer.html, so a competitor viewing source on the designer can no
   longer read SELL (every price) or COST (what we actually pay). This
   file is imported by worker/index.js and never shipped to a browser —
   the client only ever sees the /shed/quote response (a total, and an
   optionPrices map for the handful of tiles whose LABEL needs a number
   before the customer has finished a build), never these tables.
   Ported as directly as possible from the original — see setConfig()
   below for why some of this is module-level state rather than function
   parameters, and worker/pricing.regress.mjs for the regression check
   that this port didn't change a single price. */


/* ═══════════════════════════════════════════════════════════════════════
   ★★★  EDIT YOUR COSTS HERE  ★★★
   Every dollar figure the engine uses lives in this one block. These are
   what YOU pay (material cost), not what the customer pays. Update from your
   Logan HD receipts / Pro Desk (435-787-4864) and the profit number sharpens
   to exact. Prices below are HD baseline (national shelf, Jul 2026) — treat
   as placeholders until replaced with your real Logan/Pro numbers.
   ═══════════════════════════════════════════════════════════════════════ */
let COST = {
  // Metal roofing — CONFIRMED: Metal Mart $1.00 / sq ft (replaces shingles+felt)
  metalRoofPerSqft: 1.00,

  // Windows — cheapest HD line by size (TAFCO white-vinyl utility/shed, baseline).
  // Black vinyl & colored aluminum aren't sold as cheap shed SKUs — set your
  // real cost when you order them; they currently fall back to the vinyl price.
  window: {
    small:  92,    // ~18x24  white vinyl single-hung  (VSH1824B)
    medium: 105,   // ~24x30  white vinyl single-hung  (VSH2430B)
    large:  127,   // ~24x36 / 36x24  white vinyl       (VSH2436B)
    xlarge: 179    // ~36x36  white vinyl slider        (VUS3636B)
  },

  // Doors — ROUGH shop-built material cost (plywood face + 2x4 frame + hardware),
  // scaled by door size. ⚠️ PLACEHOLDER rates until the real build spec is known.
  // Swap these when you confirm what a door actually uses.
  doorMaterial: {
    plywoodPerSqft:  1.10,   // $/sqft of door face (LP/CDX)
    framing2x4PerFt: 0.55,   // $/linear ft of 2x4
    framingFactor:   1.5,    // perimeter × this ≈ total 2x4 ft (frame + brace + rails)
    hardwareSingle:  28,     // hinges + handle per single-leaf door
    hardwareDouble:  45      // hinges + handle + barrel bolts + astragal per double
  },

  /* DOORS BOUGHT AT HOME DEPOT — actual retail cost, marked up 30% to get the
     customer price. This is the pattern to extend to every other Home-Depot-
     sourced door/window: put the real $ cost here, then SELL.doors (below)
     computes off it as cost*1.3 instead of a second hand-typed number, so a
     price change only has to happen in ONE place.
     NOT auto-updating — Home Depot has no public price-lookup API and blocks
     automated/bot access to their site (confirmed 22 Aug 2026, tried fetching
     product pages directly and got HTTP 403), so there is no reliable way to
     poll their real price from here. These costs were found via web search,
     not read off a live product page, and are NOT confirmed as the true
     cheapest option in each category — treat them as a starting point and
     verify the exact SKU/price before they go live to customers. */
  doorHomeDepot: {
    // Steves & Sons 6-Panel Primed Steel Double Front Door, 72"x80" (6'0"x6'8").
    // Regular (non-sale) price — a sale price fluctuates, so pricing off the
    // regular price is the more stable baseline. Sale price seen at time of
    // research: $654.40.
    residentialDouble: { cost: 818.00, sku: 'Steves & Sons 6-Panel Primed Steel Double, 72x80', verified: false },
    // Cheapest 60"x80" white vinyl sliding patio door surfaced by search.
    // LOW CONFIDENCE — basic builder-grade sliders often run well under this;
    // this is likely NOT the true floor price, just the lowest number a
    // search actually turned up a source for.
    slidingGlass: { cost: 1262.80, sku: '60x80 white vinyl sliding patio door', verified: false }
  },

  // Job costs (margin math)
  marginTarget: 42,     // % target — used only to show "sell @ target" reference
  milesOneWay:  90,     // round-trip fuel is computed from this
  dieselPrice:  5.36,   // $/gal
  truckMpg:     11,
  helperPerDay: 250
};

/* ═══════════════════════════════════════════════════════════════════════
   BUILD CONFIG — the free variables computePricing (and everything it
   calls) reads. In designer.html these were true globals: the wizard set
   window.STYLE/W/L/... directly and every pricing function, however deep,
   just read them off the page. Ported here as module-level state for the
   same reason, NOT because it's the ideal shape: rewriting sellSheetKey(),
   framingCost(), roofDeltaCost(), styleRoofFactor() and PITCHVAL() to take
   every value as an explicit parameter — instead of reading it off the
   module — would touch a dozen call sites in logic that's been tuned
   against hundreds of real builds, which is exactly the kind of change
   the regression harness (see /worker/pricing.regress.mjs) exists to
   catch, not invite.
   SAFE IN A WORKER DESPITE BEING MODULE-LEVEL STATE: computePricing() and
   every function it calls are 100% synchronous — no await, no fetch, no
   setTimeout anywhere in this file. JS never interleaves two synchronous
   call stacks, so even if the Worker runtime reuses this isolate across
   concurrent requests, one request's setConfig()+computePricing() pair
   always finishes atomically before another request's code gets a turn.
   That guarantee breaks the moment anything in this file becomes async —
   if you ever add an await between setConfig() and computePricing(),
   stop and thread the values through as parameters instead. */
let STYLE='gable', PITCH=6, ROOFTYPE='shingle', OVTYPE='gable', OVH=4,
    SIDING='vertical', W=8, L=12, H=8,
    PORCH_LOC='none', SIDE_PORCH=0, PORCH_TIER='standard',
    DORMER_L=0, DORMER_R=0,
    FOUNDATION='blocks', FOUNDATION_FINISH='plain',
    LOFT='none', ELEC='none', INT_FINISH='none', FLOOR='none',
    ADDONS={ shutters:false, flowerboxes:false, cupola:'none',
      skylight:false, stairs:false, statLadder:false, atticLadder:false,
      weatherGuard:false, radiantBarrier:false, houseWrap:false, hurricaneTies:false,
      doorAwning:false, fbColor:'brown', shutterColor:'brown',
      shedRemoval:false, concreteRemoval:false },
    doorsData=[], windowsData=[], ventsData=[], shelvesData=[];

/* Maps the client's getDesignConfig() shape onto the module state above.
   Field names match getDesignConfig() exactly (see designer.html) so the
   Worker can pass the request body straight through with no translation
   layer to keep in sync. Anything missing/null keeps its current value —
   callers should assign fresh defaults first (see resetConfig) rather than
   rely on this to null things out, the same "missing = leave alone" shape
   applyDesignConfig() already uses for old permalinks. */
function setConfig(cfg){
  cfg = cfg || {};
  if(cfg.style!=null) STYLE=cfg.style;
  if(cfg.pitch!=null) PITCH=+cfg.pitch;
  if(cfg.roofType!=null) ROOFTYPE=cfg.roofType;
  if(cfg.ovType!=null) OVTYPE=cfg.ovType;
  if(cfg.ovh!=null) OVH=+cfg.ovh;
  if(cfg.siding!=null) SIDING=cfg.siding;
  if(cfg.w!=null) W=+cfg.w;
  if(cfg.l!=null) L=+cfg.l;
  if(cfg.h!=null) H=+cfg.h;
  if(cfg.porchLoc!=null) PORCH_LOC=cfg.porchLoc;
  if(cfg.porchDepth!=null) SIDE_PORCH=+cfg.porchDepth;
  if(cfg.porchTier!=null) PORCH_TIER=cfg.porchTier;
  if(cfg.dormerL!=null) DORMER_L=+cfg.dormerL;
  if(cfg.dormerR!=null) DORMER_R=+cfg.dormerR;
  if(cfg.foundation!=null) FOUNDATION=cfg.foundation;
  if(cfg.foundationFinish!=null) FOUNDATION_FINISH=cfg.foundationFinish;
  if(cfg.loft!=null) LOFT=cfg.loft;
  if(cfg.elec!=null) ELEC=cfg.elec;
  if(cfg.intFinish!=null) INT_FINISH=cfg.intFinish;
  if(cfg.floor!=null) FLOOR=cfg.floor;
  if(cfg.addons!=null) ADDONS=cfg.addons;
  doorsData   = Array.isArray(cfg.doors)   ? cfg.doors   : [];
  windowsData = Array.isArray(cfg.windows) ? cfg.windows : [];
  ventsData   = Array.isArray(cfg.vents)   ? cfg.vents   : [];
  shelvesData = Array.isArray(cfg.shelves) ? cfg.shelves : [];
}
/* Every field back to its designer.html default (see the top-level `var`
   declarations there). Call this before setConfig() on each request so a
   field the client omitted reads as "not selected", not as whatever the
   previous request left behind — computePricing has no per-request state
   of its own, this module-level config IS that state. */
function resetConfig(){
  STYLE='gable'; PITCH=6; ROOFTYPE='shingle'; OVTYPE='gable'; OVH=4;
  SIDING='vertical'; W=8; L=12; H=8;
  PORCH_LOC='none'; SIDE_PORCH=0; PORCH_TIER='standard';
  DORMER_L=0; DORMER_R=0;
  FOUNDATION='blocks'; FOUNDATION_FINISH='plain';
  LOFT='none'; ELEC='none'; INT_FINISH='none'; FLOOR='none';
  ADDONS={ shutters:false, flowerboxes:false, cupola:'none',
    skylight:false, stairs:false, statLadder:false, atticLadder:false,
    weatherGuard:false, radiantBarrier:false, houseWrap:false, hurricaneTies:false,
    doorAwning:false, fbColor:'brown', shutterColor:'brown',
    shedRemoval:false, concreteRemoval:false };
  doorsData=[]; windowsData=[]; ventsData=[]; shelvesData=[];
}

/* Ported verbatim from designer.html (porchEatFt/encWft/encLft/MIN_ENCLOSED)
   — computePricing's interior-finish floor area has to shrink by the SAME
   porch cut the 3D room actually uses, or the drywall tier gets billed
   against a floor area bigger than the real room. Gable only; every other
   style returns {w:0,l:0} and these are no-ops for it, matching the 3D
   code's own "nothing else in the file can tell the difference" note. */
const MIN_ENCLOSED=6;
function porchEatFt(){
  if(STYLE!=='gable') return {w:0,l:0};
  if(PORCH_LOC==='none') return {w:0,l:0};
  if(!(SIDE_PORCH>0)) return {w:0,l:0};
  return (PORCH_LOC==='front') ? {w:0, l:SIDE_PORCH} : {w:SIDE_PORCH, l:0};
}
function encWft(){ return Math.max(MIN_ENCLOSED, W - porchEatFt().w); }
function encLft(){ return Math.max(MIN_ENCLOSED, L - porchEatFt().l); }
/* Also ported (was outside the pricing IIFE, alongside porchEatFt/encWft/
   encLft): the concrete pad is sized off the ENCLOSURE, not the full
   footprint — a porch sits on its own deck. computePricing's foundation
   block calls this via the same typeof-guard the original used for a
   function living outside its own scope; here it always exists. Missing
   this on the first port left broom-finish billing against the full W×L
   footprint instead of the shrunk enclosure — caught by
   pricing.regress.mjs, which is exactly the case it's there to catch. */
function padSqft(){ return Math.round(encWft()*encLft()); }


/* INTERIOR FINISH PRICE — the single implementation.
   Called by computePricing for the quote and by the wizard for the button
   label. Two copies of a tier table is how a designer ends up showing one
   number and quoting another, so there is deliberately only one.
     kind: 'drywall' (mud only) | 'painted' (mud + paint) | anything else -> 0
   Painted pays the tier outright. Drywall-and-mud takes unpaintedPct off and
   snaps to roundTo, because 15% off these tiers lands on half dollars. */
function interiorPrice(kind, wf, df){
  if(kind!=='drywall' && kind!=='painted') return 0;
  var iv=SELL.interior; if(!iv) return 0;
  var floor=(wf||0)*(df||0);
  var tier=(floor>=iv.breakHi) ? iv.over
          :(floor>=iv.breakLo) ? iv.mid
          : iv.under;
  if(kind==='painted') return tier;
  var raw=tier*(1-(iv.unpaintedPct||0)/100);
  var step=iv.roundTo>0 ? iv.roundTo : 1;
  return Math.round(raw/step)*step;
}

/* ═══════════════════════════════════════════════════════════════════════
   FLOORING — finished floor over the subfloor or the slab.
   COSTS, not sell prices. Never ship this block to a browser: the client is
   handed the finished dollar amount per tier in optionPrices.flooring and
   nothing else, the same treatment SELL.siding and SELL.wallHeight get.

   margin is a TRUE margin, so the sell rate is cost / (1 - margin). Dividing
   by 0.70 and multiplying by 1.30 are not the same thing and the second one
   under-charges: 1.25 x 1.30 = 1.63 against a correct 1.80, which is 23%
   margin, not 30%. The arithmetic below is integer cents for the same reason
   — a float cent that lands a hair under a rounding step quietly prices a
   whole tier wrong. */
let FLOORING = {
  marginBp: 3000,                 // 30.00%, in basis points, to stay integer
  tiers: {
    none:   { costSqftCents:   0, costMinCents:      0 },
    /* No sealed/painted tier here. Sealing a floor is already sold, on the
       Foundation step, as SELL.foundationFinish.coated — and offering it in
       two places meant two prices for one job ($300 there, $290 here) with
       nothing stopping a customer buying both and being billed $590 to seal
       one slab. Flooring is the thing the Foundation step does NOT cover:
       plank over whatever the shed stands on. */
    better: { costSqftCents: 555, costMinCents:  83500 },
    best:   { costSqftCents: 695, costMinCents: 104500 }
  }
};
/* What the customer reads. The install spec (coats, plank thickness, wear
   layer, vapour barrier) is deliberately NOT here — it is internal, and this
   module's whole point is that what reaches the browser is a name and a
   number. */
const FLOORING_NAMES = {
  none:   'Standard Floor',
  better: 'Luxury Vinyl Plank',
  best:   'Premium Luxury Vinyl Plank'
};
// Ceiling division on integers — no float anywhere, so a rate can't land one
// ten-thousandth under a step and round down a tier.
function _ceilDiv(a, b){ return Math.floor((a + b - 1) / b); }
/* Sell rate per square foot, in whole cents, rounded UP to the nearest 5c.
   Good $1.80, Better $7.95, Best $9.95 — assert these, they are the numbers
   on the price sheet. */
function flooringSellRateCents(tier){
  var t = FLOORING.tiers[tier]; if(!t || !t.costSqftCents) return 0;
  var STEP = 5;                                            // round up to 5 cents
  return _ceilDiv(t.costSqftCents * 10000, (10000 - FLOORING.marginBp) * STEP) * STEP;
}
/* Job minimum, in whole cents, rounded UP to the nearest $5.
   Good $290, Better $1,195, Best $1,495. */
function flooringSellMinCents(tier){
  var t = FLOORING.tiers[tier]; if(!t || !t.costMinCents) return 0;
  var STEP = 500;                                          // round up to $5
  return _ceilDiv(t.costMinCents * 10000, (10000 - FLOORING.marginBp) * STEP) * STEP;
}
/* Whole dollars for THIS shed. Area is the ENCLOSED floor — a porch deck is
   not floored and a loft is not a second floor to price, so neither counts.
   The same price on plywood and on concrete: the tier's cost already carries
   whichever prep that floor needs (enamel vs sealer, vapour barrier vs none). */
function flooringPrice(tier, areaSqft){
  var rate = flooringSellRateCents(tier); if(!rate) return 0;
  var cents = Math.max(flooringSellMinCents(tier), (areaSqft||0) * rate);
  return Math.round(cents / 100);
}

/* FOUNDATION FLOOR FINISH — the single implementation, used by computePricing
   AND the Foundation step's finish list, so the price on the button cannot
   drift from the price in the quote. 'broom' is tiered by pad sqft (same
   break points as the interior drywall tiers, inclusive at the bottom the
   same way: exactly 125 pays SELL.broomTiers.mid, exactly 175 pays .over).
   'plain'/'coated' are flat, from SELL.foundationFinish. */
function foundationFinishPrice(kind, sqft){
  if(kind==='broom'){
    var t=SELL.broomTiers;
    return (sqft>=t.breakHi) ? t.over : (sqft>=t.breakLo) ? t.mid : t.under;
  }
  return (SELL.foundationFinish[kind]||0);
}

/* GRAVEL FOUNDATION PRICE — flat job price banded by the shed's own
   footprint (enclosure sqft, same basis as padSqft/broom), from
   SELL.gravelTiers. Only sheds LARGER than a break pay the next tier up —
   exactly at a break point still pays the lower tier, same "inclusive at
   the bottom" convention broom/interior use for their own break points.
   Past maxSqft we don't offer a gravel pad at all — returns null so the
   caller can fall back / refuse rather than silently pricing it. */
function gravelFoundationPrice(sqft){
  var t=SELL.gravelTiers;
  if(sqft>t.maxSqft) return null;
  return (sqft>t.break2) ? t.tier3 : (sqft>t.break1) ? t.tier2 : t.tier1;
}

/* ═══════════════════════════════════════════════════════════════════════
   ★★★  CUSTOMER SELL PRICES  (from Shed Pro Client Workbook, Jul 2026)  ★★★
   What the CUSTOMER pays — upcharges & option prices, NOT your cost.
   Customer price = base(by size) + these upcharges.  Profit = customer − cost.
   ⚠️ Not yet live on the customer number: needs the base-by-size table
      (SELL.baseSheets below) and, for most add-ons, a select button in the UI.
   Per-sqft items note their AREA BASIS — wall / floor / roof / own-size.
   ═══════════════════════════════════════════════════════════════════════ */
/* The shipped exterior paint rate, held as a constant as well as in SELL so
   the quote path has something sound to fall back to when an owner's saved
   pricing override leaves SELL.exteriorPaint.rate missing or unusable. */
/* Exterior paint is a FLAT fee, not a rate. Fernando, 18 Sep 2026: a small
   shed takes very nearly as much paint as a big one - you buy the same cans,
   the same primer, the same masking - so charging it per square foot was
   modelling a cost that does not actually vary that way. What varies with size
   is the TIME to paint it, and that is labour, priced below.
   This replaced $4/sqft of wall, which itself replaced a three-tier table that
   was a flat $7 in disguise: wall area is 2*(W+D)*wallH, so every shed sold
   cleared the top break and the two lower rates were unreachable. */
const PAINT_FLAT = 1400;

/* Build labour, per sqft of SHED FLOOR area - the shed's own size, the way it
   is quoted and talked about, not wall area. Bigger shed, more time.
   Keyed by wall height, because a taller shed of the same footprint genuinely
   is more wall to build and paint: pricing on footprint alone handed a 12x20
   with 10ft walls about $1,220 off, since none of its extra 147 sqft of wall
   reached this line. Same shape as SELL.wallHeight below, and the same heights.
   Each rate is fitted so that PAINT_FLAT + rate x footprint lands on what the
   old $7-a-wall-foot charge came to at that height, across 6x8 through 16x32.
   Worst residual runs about $260 at 8ft up to $810 at 12ft - the flat paint fee
   does not scale with height, so the rate has to absorb all of it. */
const LABOR_BY_HEIGHT = { 6: 5.00, 7: 6.50, 8: 7.75, 9: 9.75, 10: 11.50, 12: 14.50 };

/* The single charge paint and labour replaced: $7 per sqft of WALL area, which
   is what the old three-tier table always came to in practice. Kept only as the
   yardstick for the top-up below. Not a price, and read nowhere else. */
const LEGACY_FINISH_RATE = 7;


let SELL = {
  /* INTERIOR FINISH — drywall, mud & paint.
     A FLAT JOB PRICE, tiered on FLOOR area (W x D), not a per-sq-ft rate.
     That is deliberate: the cost here is mostly mobilisation, taping and
     finish time, which does not scale linearly with a few extra feet, so a
     rate per sq ft would badly undercharge the small sheds and overcharge
     the big ones. Fernando's numbers, 20 Aug 2026.
       under 125 sqft ......... 3250
       125 up to 175 sqft ..... 3750
       175 sqft and over ...... 4000
     Boundaries are INCLUSIVE at the bottom of each tier: exactly 125 pays
     3750, exactly 175 pays 4000. A 10x12 (120) is the small tier, a 10x16
     (160) the middle, a 12x16 (192) the top.
     Floor area is the shed's full W x D. A porch does not reduce it — the
     enclosure stays full size and the roof simply carries on over the porch.
     unpaintedPct: "Drywall & Mud" is the same job without the painting, so it
     bills at a PERCENTAGE off the tier rather than a flat dollar delta. A
     percentage is right here — the painting scales with the job, so a fixed
     deduction would be too big a discount on a 12x20 and too small on an 8x8.
     15% off, Fernando, 20 Aug 2026:
       under 125 ....  3250 -> 2765
       125 to 175 ...  3750 -> 3190
       175 and over .  4000 -> 3400
     roundTo: 15% lands on half-dollars (2762.50, 3187.50). Nobody quotes a
     shed to the half dollar, so the unpainted figure snaps to the nearest 5.
     Set roundTo to 1 for exact cents, or 25 for a coarser number. */
  interior: {
    under:        3250,  // < breakLo sqft
    mid:          3750,  // breakLo .. breakHi
    over:         4000,  // >= breakHi
    breakLo:      125,   // sqft
    breakHi:      175,   // sqft
    unpaintedPct: 15,    // % off the tier for drywall-and-mud (no paint)
    roundTo:      5      // $ step the unpainted figure snaps to
  },

  // ── FOUNDATION (flat) ── Levelling on blocks is complimentary. Gravel is
  // blocks levelling PLUS pouring gravel over the site first — tiered by
  // shed sqft, see gravelTiers below, not this table.
  foundation: { pad: 3000, blocks: 0, existing: 0 },

  // ── GRAVEL FOUNDATION ── tiered by the shed's own footprint (enclosure
  // sqft). $750 under 75 sqft, $1100 from 75-150 sqft, $1500 from 150-200
  // sqft. Not offered past 200 sqft — see maxSqft in gravelFoundationPrice.
  gravelTiers: { tier1: 750, tier2: 1100, tier3: 1500, break1: 75, break2: 150, maxSqft: 200 },

  // ── FOUNDATION FLOOR FINISH ── 'plain'/'coated' are flat; 'broom' is
  // tiered by pad sqft — see broomTiers below, not this table.
  foundationFinish: { plain: 0, coated: 300 },

  /* BROOM FINISH IS TIERED BY PAD AREA. Fernando, 21 Aug 2026:
       under 125 sqft ....  500
       125 up to 175 ....   750
       175 and over ....  1,000
     Same break points as the interior drywall tiers above, and inclusive at
     the bottom the same way: exactly 125 pays 750, exactly 175 pays 1,000.
     It is a flat figure per tier rather than a rate because broom finishing
     is mostly a labour-and-timing job — you get one window while the slab
     is right, and that does not scale smoothly with a few extra feet. */
  broomTiers: { under: 500, mid: 750, over: 1000, breakLo: 125, breakHi: 175 },

  // ── BASE PRICE BY SIZE ── ⚠️ FILL IN from the workbook's sheets.
  // Keyed by style sheet, then by "WxD" in feet. A porch is priced as its
  // own add-on below (porchFrontSqft / porchSideSqft) —
  // it does NOT change which sheet the base price comes from.
  //
  // Fill like:  aframe: { "8x8":2450, "8x10":2790, "8x12":3100, ... }
  // Missing cell -> quote falls back to the cost×margin proxy AND flags
  // itself in the redline, so a hole in the table is never silent.
  baseSheets: {
    "aframe":       {},  // A-Frame Style — A-frame, porch or not
    "barn":         {},  // Barn Style         — gambrel
    "leanto":       {},  // Single Slope       — lean-to
    "poolhouse":    {},  // Poolhouse          — 8/10/12 wide × 12–20 long
    "3peak":        {},  // 3 Peak — one cross gable, +X side wall
    "4peak":        {}   // 4 Peak — cross gable on both side walls
  },

  // ── DOORS (upcharge over the included 5' Double) ──
  doors: {
    "5' Double": 0, "5' Double Craftsman": 50, "5' Double (X-Trim)": 80,
    "5' Double (Arch Trim)": 80, "5' Double (4 Panel)": 80,
    "6' Double": 60, "6' Double Craftsman": 105, "6' Double (X-Trim)": 130,
    "6' Double (Arch Trim)": 130, "6' Double (4-Panel)": 130,
    "7' Double": 120, "7' Double Craftsman": 160, "7' Double (X-Trim)": 160,
    "7' Double (Arch Trim)": 160, "7' Double (4 Panel)": 160,
    "6' Roll Up": 790, "7' Roll Up": 890, "8' Roll Up": 945,
    "3' Single": 80, "3' Single Craftsman": 130, "3' Single (X-Trim)": 160,
    "3' Single (Arch Trim)": 160, "3' Single (4 Panel)": 160,
    "3'6\" Single": 80, "3'6\" Single Craftsman": 130, "3'6\" Single (X-Trim)": 160,
    "3'6\" Single (Arch Trim)": 160, "3'6\" Single (4 Panel)": 130,
    "36\" Residential 6 Panel": 525, "36\" Residential Half Lite": 580,
    "36\" Residential Full Lite": 630,
    "36\" Residential 6 Panel (Black)": 565, "36\" Residential Half Lite (Black)": 620,
    "36\" Residential Full Lite (Black)": 670,
    "5' Cedar Double": 700, "6' Cedar Double": 1000, "7' Cedar Double": 1100, "8' Cedar Double": 1100,
    "Fairytale Entry": 700, "9' Garage Door": 600,

    // Home-Depot-sourced doors — cost × 1.3, computed from COST.doorHomeDepot
    // above rather than typed by hand, so the two numbers can't drift apart.
    // ⚠️ Cost is a researched estimate, not a confirmed live price — see the
    // "verified: false" flags on COST.doorHomeDepot. Re-check before quoting.
    "72\" Residential Double 6 Panel": Math.round(COST.doorHomeDepot.residentialDouble.cost*1.3),
    "Sliding Glass Door 6' (60x80)":   Math.round(COST.doorHomeDepot.slidingGlass.cost*1.3),

    // No separately researched Home Depot cost for these three — a search
    // for a double full-lite door didn't turn up a reliable, comparable
    // price. Derived instead from patterns already IN this table: full-lite
    // costs 20% more than 6-panel on the existing single residential door
    // (630 vs 525), and black costs a flat +$40 over white on every
    // existing residential style. These are internal estimates from a real
    // pattern, not independently sourced prices — confirm real SKUs when
    // you get a chance.
    "72\" Residential Double Full Lite":         Math.round(COST.doorHomeDepot.residentialDouble.cost*1.3*1.2),
    "72\" Residential Double Full Lite (Black)":  Math.round(COST.doorHomeDepot.residentialDouble.cost*1.3*1.2)+40,
    "Sliding Glass Door 6' (60x80) (Black)":      Math.round(COST.doorHomeDepot.slidingGlass.cost*1.3)+40
  },

  /* ── SHED DORMERS (flat, per side) ──
     Not on a straight $/ft line — 6ft is $191.67/ft, 8ft is $176.25/ft,
     10ft is $155/ft. That's still MORE total dollars for a bigger dormer
     (1150 < 1410 < 1550) — only the per-foot RATE drops, the same
     economies-of-scale shape as the porch/interior tiers elsewhere in this
     table (a bigger job has more of it, but the fixed setup cost — cutting
     the roof, framing the valley — is spread over more feet). Read as "the
     bigger one is cheaper" if you're only looking at $/ft, not the total.
     12ft added in v388 with no real price yet, then filled in here as a
     straight-line fit through the three known totals (least-squares:
     price = 570 + 100×width, R² close enough that it lands within $40 of
     all three actual points) rather than left TBD — replace with a real
     number whenever one exists; this is an estimate, not a workbook price. */
  dormers: { 6: 1150, 8: 1410, 10: 1550, 12: 1770 },

  // ── PORCH (customer, add-on — NOT a base-sheet switch) ──
  // Front (end) porch: Standard finish is a flat fee by depth. Upgraded
  // finish tiers are priced per sqft, where sqft = depth × shed width
  // ("fit width of shed" — same on every tier). Side porch is currently
  // only offered as a fixed 4'x6' box, so only depth "4" has a price.
  /* v371 — EVERY PORCH IS PER SQFT NOW.
     porchFrontFlat was {4:400, 6:600} and porchSideFlat {4:400}. Those are
     not flat prices, they are $8.33/sqft frozen at a 12ft span: 400/48 and
     600/72 both come to 8.333. Frozen, they only priced a 12ft shed right —
     the same $400 covered 32 sqft on an 8ft-wide shed ($12.50/sqft) and 80
     sqft on a 20ft one ($5.00/sqft). Bigger shed, more porch given away.
     As a rate it scales, and the missing cells stop mattering: 8ft front and
     6/8ft side had no entry and quoted TBD purely because nobody had typed a
     number for a depth the designer only started offering in v354.
     'standard' is a tier like any other now, so it lives in the same table.
     FRONT spans the shed's WIDTH; SIDE spans its LENGTH — spLen is built from
     the enclosure length, so a 4ft side porch on a 12x20 is 80 sqft, not 48. */
  porchFrontSqft: {
    "standard": 8.33,
    "Basic Awning": 13, "Wood Floor Awning": 15, "Composite Awning": 25,
    "Posts & Beam, Finished Ceiling": 28, "Posts, Beams & Composite Floor": 35
  },
  porchSideSqft: { "standard": 8.33 },

  // ── WALL HEIGHT (upcharge, per sqft of wall area — 8ft is the included standard) ──
  wallHeight: { 6: 1.00, 7: 1.00, 8: 0, 9: 2.00, 10: 3.00, 12: 5.00 },

  // ── WINDOWS (customer price each) ──
  windows: {
    "White Vinyl 18x24": 130, "White Vinyl 24x30": 185, "White Vinyl 36x24": 190, "White Vinyl 36x36": 310,
    "Black Vinyl 18x24": 290, "Black Vinyl 24x36": 395, "Black Vinyl 36x24": 395, "Black Vinyl 36x36": 445,
    "White Aluminum 12x12": 80, "White Aluminum 18x27": 110, "White Aluminum 24x36": 155,
    "Brown Aluminum 12x12": 80, "Brown Aluminum 18x27": 110, "Brown Aluminum 24x36": 155,
    "Black Aluminum 12x12": 80, "Black Aluminum 18x27": 180, "Black Aluminum 24x36": 280,
    "White Transom 3x10": 80, "White Transom 5x10": 120,
    "Brown Transom 3x10": 80, "Brown Transom 5x10": 120,
    "Black Transom 3x10": 105, "Black Transom 5x10": 140,
    "24x48 Insulated": 45, "Transom 87x10": 200
  },

  // ── SIDING (upcharge, per sqft of WALL AREA) ──
  siding: {
    "vertical": 0,        // Vertical T11 — included
    "horizontal": 2.00,   // Horizontal Panel (seamed every 8')
    "board-batten": 2.50, // Board & Batten
    // 1x6 knotty pine T&G at $2.05/sq ft vs LP around $1.36 -> +$0.69.
    // Excludes stain, which pine MUST have on all six faces.
    "pine": 0.70
  },

  /* ── EXTERIOR PAINT (flat fee per shed) ──
     Covers the LP SmartSide siding AND the trim. NOT charged for pine siding
     — pine gets STAINED, a separate mandatory finish step (see siding.pine
     above), never painted. */
  exteriorPaint: { flat: PAINT_FLAT },

  /* ── BUILD LABOUR ($/sqft of SHED FLOOR AREA, by wall height) ──
     The time to build and paint it, which scales with both footprint and how
     tall the walls are. Charged on the same builds as exterior paint, and
     folded into the Base Shed line on the customer's quote rather than shown
     as a line of its own. */
  labor: Object.assign({}, LABOR_BY_HEIGHT),

  // ── ELECTRICAL PACKAGES (flat) ── Basic / Core / Essential only — the old
  // "Standard" tier and its a la carte variant were dropped Sep 2026
  // (shedpro-utah.com/gallery only ever listed three tiers). "Exterior
  // Light" stays: a standalone add-on, not a package. See ELEC_MAP below for
  // what maps a designer selection ('basic'/'core'/'essential') to these.
  electrical: {
    "Basic": 840, "Core": 2300, "Essential": 3000, "Exterior Light": 150
  },

  // ── ADDITIONAL OPTIONS ──
  options: {
    flat: {   // fixed price each
      "Shutters": 60, "Flowerboxes": 90,
      "Roof Ridge Vent": 263, "8x16 Gable/Wall Vent": 30, "Roof Vent": 53,
      "Cupola 16\" Black Roof": 600, "Cupola 16\" Copper Roof": 600,
      "Skylight": 184, "Stairs": 420, "Stationary Ladder": 105, "Attic Pull-Down Ladder": 375,
      // Site clearance, priced flat rather than by size: the work is a crew and
      // a dump run either way, and quoting it per square foot would invite an
      // argument about measurements before anyone has seen the site.
      // Both $1,000 as of Sep 2026 — breaking up and hauling a slab is the same
      // day's work as taking an old shed away, so it stopped being the cheaper
      // of the two.
      "Shed Removal": 1000, "Concrete Removal": 1000
    },
    perLinFt: { // × linear feet the customer specifies
      "16\" Deep Shelving": 15, "24\" Deep Shelving": 17
    },
    perSqft: {  // × area — see basis for each
      "Loft":               {rate:3.00,  basis:"loft"},   // customer-specified loft size
      "Pine Soffit":        {rate:3.00,  basis:"soffit"}, // single-slope only, soffit sqft
      "Floor Weather Guard":{rate:5.25,  basis:"floor"},
      "Radiant Roof Barrier":{rate:1.05, basis:"roof"},   // inside roof area
      "House Wrap":         {rate:3.10,  basis:"wall"},
      "Hurricane Ties":     {rate:1.00,  basis:"floor"}
    }
  }
};

/* ── WHICH BASE SHEET? ────────────────────────────────────────────────────
   The designer's styles resolve to one of the workbook's sheets. A porch
   does NOT change which sheet is read anymore — it's priced as its own
   add-on (porchFrontSqft / porchSideSqft) on top of
   whatever the shed's own base price is.
      gable   -> aframe          (A-Frame Style)
      barn    -> barn            (Barn Style)
      leanto  -> leanto          (Single Slope)
      hip     -> poolhouse       (Poolhouse)
   3 Peak / 4 Peak have sheets but no geometry in the designer yet.        */
const SHEET_LABEL = {
  "aframe":"A-Frame", "barn":"Barn", "leanto":"Single Slope", "poolhouse":"Poolhouse",
  "3peak":"3 Peak", "4peak":"4 Peak"
};
function sellSheetKey(){
  var st  = (typeof STYLE!=='undefined') ? STYLE : 'gable';
  if(st==='barn')   return 'barn';
  if(st==='leanto') return 'leanto';
  if(st==='hip')    return 'poolhouse';
  /* 3 Peak and 4 Peak have their own workbook sheets and were falling through
     to 'aframe' — so a cross gable was quoting off the A-Frame base table.
     Invisible while baseSheets is empty (everything proxies off cost x margin
     either way), but it would have silently mispriced every one of them the
     day those cells got filled in. */
  if(st==='3peak')  return '3peak';
  if(st==='4peak')  return '4peak';
  return 'aframe';
}
// Customer base for W×D off a sheet. null = cell not entered yet, so the
// caller falls back to the proxy and flags the quote.
function sellBaseFor(W, D, sheet){
  var t = SELL.baseSheets[sheet || sellSheetKey()];
  if(!t) return null;
  var v = t[W+'x'+D];
  if(v==null) v = t[D+'x'+W];   // the workbook may list a size either way round
  return (typeof v==='number' && v>0) ? v : null;
}

// Single source of truth for the porch price line — used by both the UI
// (live price on the porch page's buttons) and computePricing(), so they
// can never drift apart. loc: 'front'|'side'. tier: 'standard' or one of
// porchFrontSqft's keys (front only). shedW: the shed's own width in ft,
// for the per-sqft tiers (sqft = depth × shedW, "fit width of shed").
/* Single rate path. shedSpan is the run the porch covers: the WIDTH for a
   front porch, the LENGTH for a side one, because the side porch roof is
   built as spLen = enclosure length + overhangs and runs the whole wall. */
function porchLineFor(loc, depth, tier, shedSpan){
  if(loc!=='front' && loc!=='side') return null;
  if(!(depth>0)) return null;
  var tbl  = (loc==='side') ? SELL.porchSideSqft : SELL.porchFrontSqft;
  var key  = (!tier || tier==='standard') ? 'standard' : tier;
  var rate = tbl[key];
  var sqft = Math.round(depth * (shedSpan||0));
  var label= (loc==='side' ? "' Side Porch" : "' Front Porch")
           + (key==='standard' ? '' : ' \u2014 '+key)
           + ' ('+sqft+' sqft)';
  return { price: rate ? Math.round(rate*sqft) : 0, name: depth+label, unpriced: !rate };
}

// Area helpers for per-sqft sell items (feet). wallH from the wall-height map.
function wallAreaFt(W,D,wallHft){ return 2*(W+D)*wallHObjFor(wallHft).heightFt; }
function floorAreaFt(W,D){ return W*D; }
function roofAreaFt(W,D){ var hs=W/2, rise=hs*(PITCHVAL()/12); return Math.sqrt(hs*hs+rise*rise)*2*D; }
// Compute a per-sqft option's price given the current build + optional custom area.
function sellPerSqft(name, W, D, wallHft, customArea){
  var o=SELL.options.perSqft[name]; if(!o) return 0;
  var a;
  if(o.basis==='wall') a=wallAreaFt(W,D,wallHft);
  else if(o.basis==='floor') a=floorAreaFt(W,D);
  else if(o.basis==='roof') a=roofAreaFt(W,D);
  else a=(customArea||0);   // loft / soffit — customer specifies the sqft
  return o.rate*a;
}

// ── LUMBER / MATERIAL PRICES (HD confirmed or estimated) ────────────────
var PT_JOIST = { 8:9.48, 10:15.48, 12:19.97, 14:24.97, 16:28.97 };
var STUD_PRICE = { 8:3.95, 10:6.48, 12:8.97, 16:11.97 };
var PLY_HALF = 34.98, OSB_34 = 35.67, LP_PANEL = 51.98;
var SHINGLE = 44.97, FELT_ROLL = 34.97;
var NAIL_16D = 26.76, NAIL_ROOF = 12.47;
var VENT_UNIT_COST = 16.97;

function joistBoard(span){
  if(span<=8)  return {len:8,  price:PT_JOIST[8]};
  if(span<=10) return {len:10, price:PT_JOIST[10]};
  if(span<=12) return {len:12, price:PT_JOIST[12]};
  if(span<=14) return {len:14, price:PT_JOIST[14]};
  return            {len:16, price:PT_JOIST[16]};
}
function stud4(need){
  if(need<=8)  return {len:8,  price:STUD_PRICE[8]};
  if(need<=10) return {len:10, price:STUD_PRICE[10]};
  if(need<=12) return {len:12, price:STUD_PRICE[12]};
  return            {len:16, price:STUD_PRICE[16]};
}

// ── WALL HEIGHTS — map the designer's integer H (ft) to a stud spec ──────
// The calculator's "8ft standard" uses a 92-5/8" precut => 7.71 heightFt.
var WALL_HEIGHTS = {
  6:  {heightFt:6,    studPrice:3.50},
  7:  {heightFt:7,    studPrice:3.75},
  8:  {heightFt:7.71, studPrice:3.95},   // standard precut
  9:  {heightFt:9,    studPrice:6.48},
  10: {heightFt:10,   studPrice:8.97},
  12: {heightFt:12,   studPrice:11.97}
};
function wallHObjFor(hFt){
  return WALL_HEIGHTS[hFt] || WALL_HEIGHTS[8];
}

// ── SIDING (per-unit; qty derived dynamically for continuous sizes) ──────
// Designer SIDING ids: "vertical" | "horizontal" | "board-batten"
var SIDING_MAP = {
  "vertical":     {perUnit:12.75, kind:"strip"},   // LP SmartSide vertical strip
  "board-batten": {perUnit:12.75, kind:"strip"},
  "horizontal":   {perUnit:12.75, kind:"strip"},
  "t111":         {perUnit:51.98, kind:"panel"}    // panel (fallback)
};
function sidingCost(sidingId, W, D, wallHft){
  var opt = SIDING_MAP[sidingId] || SIDING_MAP["vertical"];
  var wallH = wallHObjFor(wallHft).heightFt;
  if(opt.kind==="panel"){
    var sheets = Math.ceil((2*(W+D)*wallH)/32);
    return {qty:sheets, unit:opt.perUnit, cost:sheets*opt.perUnit};
  }
  // strip siding: 8"-wide x 16' pieces; cover perimeter*height area.
  // (2*(W+D)) ft perimeter * wallH ft => sqft; each 8"x16' piece = 10.67 sqft.
  var area = 2*(W+D)*wallH;
  var pcs  = Math.ceil(area / ((8/12)*16));
  return {qty:pcs, unit:opt.perUnit, cost:pcs*opt.perUnit};
}

// ── CORE FRAMING (dimension-driven, matches computeFramingSections) ──────
function framingCost(W, D, wallHft){
  var OC = 16/12;
  var wh = wallHObjFor(wallHft);
  var wallH = wh.heightFt;
  var lines = [];
  var add = function(label, qty, price){ var t=qty*price; lines.push({label:label, qty:qty, unit:price, total:t}); return t; };
  var total = 0;

  // Floor
  var jb = joistBoard(W);
  var joistCt = Math.ceil(D/OC)+1;
  total += add("2x6x"+jb.len+" PT Floor Joists", joistCt, jb.price);
  var subfloorSh = Math.ceil((W*D)/32);
  total += add('3/4" T&G OSB Subfloor (4x8)', subfloorSh, OSB_34);

  // Walls
  var fbStuds = (Math.ceil(W/OC)+1)*2;
  var sideStuds = (Math.ceil(D/OC)+1)*2;
  var totalStuds = fbStuds+sideStuds+16;
  total += add("2x4 Wall Studs (16\" OC + corners)", totalStuds, wh.studPrice);
  var fbPlate = stud4(W);
  total += add("2x4x"+fbPlate.len+" Front/Back Plates", 6, fbPlate.price);
  var sidePlatePcs = Math.ceil(D/8)*6;
  total += add("2x4x8 Side Plates (spliced)", sidePlatePcs, STUD_PRICE[8]);

  // Roof framing (A-frame baseline; barn/leanto handled via roofExtra below)
  var hs = W/2, rise = hs*(PITCHVAL()/12);
  var rLen = Math.sqrt(hs*hs+rise*rise);
  var rfBoard = stud4(rLen);
  var rafterCt = (Math.ceil(D/OC)+1)*2;
  total += add("2x4x"+rfBoard.len+" Rafters", rafterCt, rfBoard.price);

  // Roof deck + roofing (sloped area)
  var roofArea = rLen*2*D;
  var plySh = Math.ceil(roofArea/32);
  total += add('1/2" Plywood Roof Deck (4x8)', plySh, PLY_HALF);
  // Metal roof REPLACES shingles+felt at the Metal Mart $/sqft rate; otherwise
  // charge 40-yr architectural shingles + felt underlayment.
  var isMetal = (typeof ROOFTYPE!=='undefined' && ROOFTYPE==='metal');
  if(isMetal){
    total += add("Metal Roofing ("+Math.round(roofArea)+" sqft @ $"+COST.metalRoofPerSqft.toFixed(2)+")", Math.round(roofArea), COST.metalRoofPerSqft);
  } else {
    var shingles = Math.ceil(roofArea*1.1/100*3);
    total += add("40-yr Architectural Shingles", shingles, SHINGLE);
    var felt = Math.ceil(roofArea/200);
    total += add("#30 Felt Underlayment (roll)", felt, FELT_ROLL);
  }

  // Fasteners
  var nailBoxes = W*D>=200?2:1;
  total += add("16d Framing Nails (5lb box)", nailBoxes, NAIL_16D);
  total += add("Roofing Nails (1lb)", 1, NAIL_ROOF);

  return {total:total, lines:lines, roofArea:roofArea, rLen:rLen, rafterCt:rafterCt};
}

// Pitch id/number helper — the designer stores PITCH as a rise number (6,8,10,12)
function PITCHVAL(){ return (typeof PITCH!=='undefined') ? PITCH : 6; }

// ── ROOF-OPTIONS DELTA (pitch upgrade + overhang), matches calculator ────
function roofDeltaCost(W, D){
  var OC = 16/12;
  var rafterCount = (Math.ceil(D/OC)+1)*2;
  var L6=3.95, L8=6.48, FASCIA8=8.50;
  function rl(hs,rise){ return Math.sqrt(hs*hs+rise*rise); }
  // pitch delta vs the 6/12 baseline
  var bl = rl(W/2, W/2*(6/12));
  var nl = rl(W/2, W/2*(PITCHVAL()/12));
  var bp = bl<=6?L6:L8, np = nl<=6?L6:L8;
  var pitchDelta = Math.max(0, (np-bp)*rafterCount);
  // overhang: designer OVTYPE "gable"(flush) or "all4"(overhang); OVH inches
  var ohTotal;
  if(OVTYPE==="gable"){
    ohTotal = 2*FASCIA8;                       // fascia on gable ends only
  } else {
    var ft = OVH/12;
    var el = bl+ft;
    var ep = el<=6?L6:L8;
    var erc = (ep-bp)*rafterCount;
    ohTotal = erc + 4*FASCIA8;                 // extended tails + fascia all 4
  }
  return pitchDelta + ohTotal;
}

// ── BARN / LEAN-TO roof adjustment ───────────────────────────────────────
// The calculator only models gable + multi-peak. For the designer's barn and
// lean-to we approximate the roof-material delta off the gable baseline:
//   barn (gambrel): more sloped area & framing -> ~1.25x roof material
//   leanto (single slope): shallower, less area -> ~0.9x
function styleRoofFactor(){
  if(STYLE==="barn")   return 1.25;
  if(STYLE==="leanto") return 0.90;
  return 1.0;
}

// ── DOOR COST: rough shop-built material takeoff, scaled by door size ─────
// plywood face + 2x4 framing (perimeter × factor) + hardware.
function doorMaterialCost(wIn, hIn, isDouble){
  var m = COST.doorMaterial;
  var faceSqft = (wIn*hIn)/144;
  var plywood  = faceSqft * m.plywoodPerSqft;
  var perimFt  = 2*(wIn+hIn)/12;
  var framing  = perimFt * m.framingFactor * m.framing2x4PerFt;
  var hardware = isDouble ? m.hardwareDouble : m.hardwareSingle;
  return plywood + framing + hardware;
}
// Doors bought pre-hung from Home Depot aren't "shop-built plywood" — the
// formula below assumes a face + 2x4 frame you cut and assemble, which
// wildly understates the real cost of a purchased unit. Style-match these
// to their real COST.doorHomeDepot cost before falling through to the
// shop-built estimate (which still applies to the doors ShedPro actually
// builds in-house).
var HD_DOOR_COST = {
  resDouble:  { name: COST.doorHomeDepot.residentialDouble.sku+" (Home Depot)", cost: COST.doorHomeDepot.residentialDouble.cost },
  slideglass: { name: COST.doorHomeDepot.slidingGlass.sku+" (Home Depot)",      cost: COST.doorHomeDepot.slidingGlass.cost },
  // No sourced Home Depot cost for these three (see SELL.doors comment) —
  // back the cost out of the estimated sell price instead of falling
  // through to the shop-built formula, which would be even further off.
  // Labeled "(estimated)" rather than "(Home Depot)" so it reads as the
  // lower-confidence number it is.
  resDoubleFull:  { name: "Residential Double Full Lite (estimated)", cost: Math.round(COST.doorHomeDepot.residentialDouble.cost*1.2*100)/100 },
  resDoubleFullB: { name: "Residential Double Full Lite, Black (estimated)", cost: Math.round(COST.doorHomeDepot.residentialDouble.cost*1.2*100)/100 + 31 },
  slideglassB:    { name: "Sliding Glass Door, Black (estimated)", cost: COST.doorHomeDepot.slidingGlass.cost + 31 }
};
function doorSkuFor(dd){
  if(HD_DOOR_COST[dd.style]) return HD_DOOR_COST[dd.style];
  var wIn = dd.w||60, hIn = dd.h||76;
  var isDouble = wIn > 44;   // 5'/6'/7' doubles vs 3'/3'6" singles
  var nm = isDouble ? (wIn<=64?"5ft Double":wIn<=76?"6ft Double":"7ft Double")
                    : (wIn<=38?"3ft Single":"3'6\" Single");
  return {name:nm+" Door (shop-built)", cost:doorMaterialCost(wIn, hIn, isDouble)};
}
function windowSkuFor(wd){
  var wIn=wd.w||24, hIn=wd.h||36;
  var a = wIn*hIn;
  if(a<=18*24+1) return {name:"~18x24 window", cost:COST.window.small};
  if(a<=24*30+1) return {name:"~24x30 window", cost:COST.window.medium};
  if(a<=36*24+1) return {name:"~24x36 window", cost:COST.window.large};
  return            {name:"~36x36 window", cost:COST.window.xlarge};
}

// Map a placed door {w, style} to its Client-Workbook name + customer upcharge.
// Widths (in): 36→3' single, 42→3'6" single, 60→5' dbl, 72→6' dbl, 84→7' dbl.
function sellDoorName(dd){
  var w=dd.w||60;
  var st = dd.style||'basic';
  if(st==='rollup'){
    var gl=(w<=76)?"6'":(w<=90)?"7'":"8'";
    return { base: gl+" Roll Up", key: gl+" Roll Up", panel4:false };
  }
  // Cedar, Fairytale, and the 36" Residential styles are their own SELL.doors
  // entries (not width/trim variants of a plain door) — map them directly so
  // they don't fall through to the cheap plain-door price below.
  if(st==='cedar'){
    var cl=(w<=64)?"5'":(w<=78)?"6'":(w<=90)?"7'":"8'";
    var ck=cl+" Cedar Double";
    return { base: ck, key: ck, panel4:false };
  }
  if(st==='fairytale'){
    return { base: "Fairytale Entry", key: "Fairytale Entry", panel4:false };
  }
  var RESID_KEYS = {
    res6:"36\" Residential 6 Panel", reshalf:"36\" Residential Half Lite", resfull:"36\" Residential Full Lite",
    res6B:"36\" Residential 6 Panel (Black)", reshalfB:"36\" Residential Half Lite (Black)", resfullB:"36\" Residential Full Lite (Black)",
    resDouble:"72\" Residential Double 6 Panel", slideglass:"Sliding Glass Door 6' (60x80)",
    resDoubleFull:"72\" Residential Double Full Lite", resDoubleFullB:"72\" Residential Double Full Lite (Black)",
    slideglassB:"Sliding Glass Door 6' (60x80) (Black)"
  };
  if(RESID_KEYS[st]){
    return { base: RESID_KEYS[st], key: RESID_KEYS[st], panel4:false };
  }
  var wl = (w<=38)?"3'":(w<=46)?"3'6\"":(w<=64)?"5'":(w<=78)?"6'":"7'";
  var kind = (w<=46)?"Single":"Double";
  var suf = st==='craftsman'?" Craftsman":st==='xtrim'?" (X-Trim)":
            st==='arch'?" (Arch Trim)":st==='panel4'?" (4 Panel)":"";
  return { base: wl+" "+kind, key: wl+" "+kind+suf, panel4: st==='panel4' };
}
/* Roll-up curtain colours. White is the stock finish and the price the sizes
   above already carry; black and brown are a finish upcharge on top, the same
   whatever the door's width — it is a coating, not more steel.
   Flat per door, not per square foot, for that reason. */
const ROLLUP_COLOR_UPCHARGE = { white: 0, black: 100, brown: 100 };

function sellDoorUpcharge(dd){
  var m=sellDoorName(dd), t=SELL.doors;
  var base = 0;
  if(t[m.key]!=null) base = t[m.key];
  else if(m.panel4 && t[m.base+" (4-Panel)"]!=null) base = t[m.base+" (4-Panel)"]; // naming variant
  else if(t[m.base]!=null) base = t[m.base];   // fall back to the plain-door upcharge
  else return 0;
  return base + rollUpColorUpcharge(dd);
}

/* Only roll-ups carry this. A roll-up's black or brown is a factory coating on
   a steel curtain, quoted as an upcharge by the supplier. Every other door —
   the fairytale's painted leaf included — gets its colour from paint the price
   sheet already covers, so charging a finish upcharge there would bill the same
   work twice. The style gate is what keeps that true as more doors gain
   colours: a new entry in DOOR_COLOR_DEFAULTS cannot start billing by itself. */
function rollUpColorUpcharge(dd){
  if((dd && dd.style) !== 'rollup') return 0;
  var c = String((dd && dd.color) || 'white').toLowerCase();
  return ROLLUP_COLOR_UPCHARGE[c] || 0;
}

/* Which door styles come in a finish colour, and what each has always been
   built as when a saved design names no colour at all. Mirrors DOOR_COLOR_SETS
   in designer.html: the KEYS must stay identical, because dd.color is written
   there and read here.
   The defaults differ because the products do — a roll-up curtain has always
   been white, a fairytale leaf has always been black — and a design saved
   before the choice existed has to keep pricing and reading as the door it was
   actually quoted as. */
const DOOR_COLOR_DEFAULTS = { rollup: 'white', fairytale: 'black' };

/* The colour for the quote line, so "8' Roll Up · Black" is what the customer
   and the redline both read. Deliberately NOT folded into sellDoorName().key —
   that string is the lookup into SELL.doors, and appending to it would miss
   every entry in the table.
   The style's own default is left unsaid: a roll-up with no colour on the line
   is white and a fairytale with none is black, exactly as every quote already
   written reads. Anything the customer actively chose gets named, because the
   shop has to know what to paint. */
function doorColorLabel(dd){
  var st = String((dd && dd.style) || '');
  if(!Object.prototype.hasOwnProperty.call(DOOR_COLOR_DEFAULTS, st)) return '';
  var c = String((dd && dd.color) || DOOR_COLOR_DEFAULTS[st]).toLowerCase();
  if(c === DOOR_COLOR_DEFAULTS[st] || !ROLLUP_COLOR_UPCHARGE.hasOwnProperty(c)) return '';
  return ' \u00b7 ' + c.charAt(0).toUpperCase() + c.slice(1);
}
/* What the CUSTOMER reads on the quote line.

   sellDoorName().key is the lookup into SELL.doors and must stay exactly as
   the table spells it — "6' Roll Up". Renaming it there would miss every
   entry and price the door at zero, the same trap doorColorLabel was written
   to avoid. So the rename lives here, on the way out, and the key is left
   alone: "6' Roll Up" prices the door, "6' Roll-Up Garage Door" is what the
   quote says it is. */
function doorDisplayName(dd){
  var k = sellDoorName(dd).key;
  return (dd && dd.style === 'rollup') ? k.replace(/Roll Up$/, 'Roll-Up Garage Door') : k;
}
// Convenience: the readable label for the redline.
var _sellDoorNameStr = function(dd){ return doorDisplayName(dd); };

// ── WINDOW CATALOG ── the real Client-Workbook windows: each entry is a
// specific type+color+size with its own customer price (from SELL.windows).
// w/h are inches, used to draw the 3D opening. Order = dropdown order.
const WINDOW_CATALOG = [
  /* Two different products share the "Transom" group: these narrow UPRIGHT
     lights, and the wide short BANDS further down. Same word, opposite
     shape — a 12x24 stands on end, a 3x10 lies flat. `label` is what the
     tile shows; `key` stays untouched because it's the identity used by
     SELL.windows and by every saved design.
     Frame color: these three used to be a single colorless entry each
     (no black/white choice, unlike the horizontal bands below which
     already had White/Brown/Black). Split into White + Black per size to
     match. The old bare keys ("Transom 12x24" etc, no color in the name)
     are deliberately NOT reused or removed — any design saved against
     them keeps rendering fine (a placed window's own w/h are copied in at
     placement time, not re-read from this array), this just stops
     offering the colorless version for NEW placements. Neither the old
     nor the new keys have a SELL.windows price yet — nobody's supplied
     one — so both quote as flagged/unpriced rather than guessing. */
  {grp:"Transom", key:"White Transom 12x24", label:"Vertical Transom 12x24 · White", w:12,h:24},
  {grp:"Transom", key:"Black Transom 12x24", label:"Vertical Transom 12x24 · Black", w:12,h:24},
  {grp:"Transom", key:"White Transom 12x30", label:"Vertical Transom 12x30 · White", w:12,h:30},
  {grp:"Transom", key:"Black Transom 12x30", label:"Vertical Transom 12x30 · Black", w:12,h:30},
  {grp:"Transom", key:"White Transom 14x36", label:"Vertical Transom 14x36 · White", w:14,h:36},
  {grp:"Transom", key:"Black Transom 14x36", label:"Vertical Transom 14x36 · Black", w:14,h:36},
  {grp:"White Vinyl",    key:"White Vinyl 18x24",   w:18,h:24},
  {grp:"White Vinyl",    key:"White Vinyl 24x30",   w:24,h:30},
  {grp:"White Vinyl",    key:"White Vinyl 36x24",   w:36,h:24},
  {grp:"White Vinyl",    key:"White Vinyl 36x36",   w:36,h:36},
  {grp:"Black Vinyl",    key:"Black Vinyl 18x24",   w:18,h:24},
  {grp:"Black Vinyl",    key:"Black Vinyl 24x36",   w:24,h:36},
  {grp:"Black Vinyl",    key:"Black Vinyl 36x24",   w:36,h:24},
  {grp:"Black Vinyl",    key:"Black Vinyl 36x36",   w:36,h:36},
  {grp:"White Aluminum", key:"White Aluminum 12x12", w:12,h:12},
  {grp:"White Aluminum", key:"White Aluminum 18x27", w:18,h:27},
  {grp:"White Aluminum", key:"White Aluminum 24x36", w:24,h:36},
  {grp:"Brown Aluminum", key:"Brown Aluminum 12x12", w:12,h:12},
  {grp:"Brown Aluminum", key:"Brown Aluminum 18x27", w:18,h:27},
  {grp:"Brown Aluminum", key:"Brown Aluminum 24x36", w:24,h:36},
  {grp:"Black Aluminum", key:"Black Aluminum 12x12", w:12,h:12},
  {grp:"Black Aluminum", key:"Black Aluminum 18x27", w:18,h:27},
  {grp:"Black Aluminum", key:"Black Aluminum 24x36", w:24,h:36},
  {grp:"Transom", key:"White Transom 3x10", label:"Horizontal Transom 3x10 \u00b7 White", w:36,h:10},
  {grp:"Transom", key:"White Transom 5x10", label:"Horizontal Transom 5x10 \u00b7 White", w:60,h:10},
  {grp:"Transom", key:"Brown Transom 3x10", label:"Horizontal Transom 3x10 \u00b7 Brown", w:36,h:10},
  {grp:"Transom", key:"Brown Transom 5x10", label:"Horizontal Transom 5x10 \u00b7 Brown", w:60,h:10},
  {grp:"Transom", key:"Black Transom 3x10", label:"Horizontal Transom 3x10 \u00b7 Black", w:36,h:10},
  {grp:"Transom", key:"Black Transom 5x10", label:"Horizontal Transom 5x10 \u00b7 Black", w:60,h:10}
];
function windowCatEntry(key){
  for(var i=0;i<WINDOW_CATALOG.length;i++) if(WINDOW_CATALOG[i].key===key) return WINDOW_CATALOG[i];
  return null;
}
// Customer price for a placed window. Uses wd.type if set; else nearest by area.
function sellWindowPrice(wd){
  if(wd.type && SELL.windows[wd.type]!=null) return SELL.windows[wd.type];
  // fallback: no type chosen yet — price the closest white-vinyl size by area
  var a=(wd.w||24)*(wd.h||36);
  if(a<=18*24+1) return SELL.windows["White Vinyl 18x24"];
  if(a<=24*30+1) return SELL.windows["White Vinyl 24x30"];
  if(a<=36*24+1) return SELL.windows["White Vinyl 36x24"];
  return SELL.windows["White Vinyl 36x36"];
}
// True only if this exact type has a workbook price. The vertical transoms
// (White/Black Transom 12x24 / 12x30 / 14x36) are catalog entries with no
// SELL key — they are NOT the workbook's Transom 3x10 / 5x10 (those are
// 36"×10" and 60"×10" horizontal bands; these are tall narrow lites, still
// unpriced since nobody's supplied a number for them). Without this check
// they'd fall through the area buckets and quote as white vinyl.
function sellWindowPriced(wd){
  return !!(wd && wd.type && SELL.windows[wd.type]!=null);
}

// ── MARGIN / JOB-COST DEFAULTS (from the editable COST block) ────────────
let DEFAULTS = {
  marginTarget: COST.marginTarget,
  milesOneWay:  COST.milesOneWay,
  dieselPrice:  COST.dieselPrice,
  truckMpg:     COST.truckMpg,
  helperPerDay: COST.helperPerDay
};

// ── MASTER: compute everything from the current designer state ───────────
/* ── STAFF MARGIN LEVER ───────────────────────────────────────────────────
 * The margin target is the one number that moves the shed's BASE price, and
 * it is deliberately invisible to the customer: it lands inside marginPrice,
 * which the quote document folds into the single "Shed" line. There is no
 * separate line item to explain, because there is nothing to explain — it is
 * the price of the shed.
 *
 * The band is a business rule, not a UI nicety, so it lives here beside the
 * arithmetic rather than in whichever form happens to set it. Below 30% the
 * job stops covering its own overhead; above 70% it stops being a price
 * anyone signs. A value outside the band is pulled to the nearest edge rather
 * than rejected, so a fat-fingered 700 prices at 70% instead of failing the
 * quote or, worse, quietly pricing at 700%.
 */
const MARGIN_MIN = 30;
const MARGIN_MAX = 70;
function clampMarginTarget(v){
  // "Not set" has to stay distinguishable from "set to something low".
  // The designer's redline knob sends null when it is blank, and Number(null)
  // is 0 — so clamping first would have pulled every blank knob to the 30%
  // floor and quietly repriced every quote the moment staff opened the panel.
  if(v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if(!isFinite(n)) return null;
  return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, n));
}

function computePricing(cfgIn, opts){
  // cfgIn drives the module-level build-config state (STYLE/W/L/H/...);
  // opts is the separate, pre-existing margin/mileage/diesel override used
  // by the admin redline sliders — kept as its own parameter rather than
  // folded into cfgIn since it overrides DEFAULTS, not the build itself.
  resetConfig();
  setConfig(cfgIn);
  opts = opts || {};
  var cfg = {
    marginTarget: (clampMarginTarget(opts.marginTarget) != null)
                    ? clampMarginTarget(opts.marginTarget) : DEFAULTS.marginTarget,
    milesOneWay:  opts.milesOneWay!=null?opts.milesOneWay:DEFAULTS.milesOneWay,
    dieselPrice:  opts.dieselPrice!=null?opts.dieselPrice:DEFAULTS.dieselPrice,
    truckMpg:     opts.truckMpg!=null?opts.truckMpg:DEFAULTS.truckMpg,
    helperPerDay: opts.helperPerDay!=null?opts.helperPerDay:DEFAULTS.helperPerDay
  };
  var Wf = (typeof W!=='undefined')?W:12;
  var Df = (typeof L!=='undefined')?L:16;      // designer depth is L
  var Hf = (typeof H!=='undefined')?H:8;

  // Framing + roof (with style factor on the roof-material portion)
  var fr = framingCost(Wf, Df, Hf);
  var roofFactor = styleRoofFactor();
  // Re-scale just the roof-area material lines by the style factor.
  var roofExtra = 0;
  fr.lines.forEach(function(li){
    if(/Rafters|Roof Deck|Shingles|Felt|Metal Roofing/.test(li.label)){
      roofExtra += li.total*(roofFactor-1);
    }
  });
  var framing = fr.total + roofExtra;

  // Siding
  var sid = sidingCost((typeof SIDING!=='undefined')?SIDING:"vertical", Wf, Df, Hf);

  // Roof options delta (pitch + overhang)
  var roofDelta = roofDeltaCost(Wf, Df);

  // Vents (from placed vents)
  var ventCt = (typeof ventsData!=='undefined')?ventsData.length:0;
  var ventCost = ventCt*VENT_UNIT_COST;

  // Doors & windows — auto-priced from placed openings (default SKU each)
  var doorLines=[], winLines=[];
  var doorCost=0, winCost=0;
  if(typeof doorsData!=='undefined'){
    doorsData.forEach(function(dd){
      var sku=doorSkuFor(dd); doorCost+=sku.cost;
      doorLines.push({label:sku.name, qty:1, unit:sku.cost, total:sku.cost});
    });
  }
  if(typeof windowsData!=='undefined'){
    windowsData.forEach(function(wd){
      var sku=windowSkuFor(wd); winCost+=sku.cost;
      winLines.push({label:sku.name, qty:1, unit:sku.cost, total:sku.cost});
    });
  }

  // ── TRUE COST (all real material + job costs) ──
  var grandBase = framing + sid.cost + roofDelta + ventCost + doorCost + winCost;
  var autoBuildDays = (Wf*Df) > 160 ? 2 : 1;
  var helperCost = autoBuildDays * cfg.helperPerDay;
  var gallons = (cfg.milesOneWay*2)/cfg.truckMpg;
  var fuelCost = gallons*cfg.dieselPrice;
  var trueTotalCost = grandBase + helperCost + fuelCost;

  // ── BASE-SHED PROXY (until the real base-by-size table is in) ──
  // The customer's base price should be a FIXED number by size (from the
  // workbook) that already includes T11 siding + one standard 5' door. We don't
  // have that table yet, so we PROXY it as shell-cost × margin — but the shell
  // must EXCLUDE the items we charge for separately on the customer side
  // (windows, siding upgrade, extra/upgraded doors, vents), or they'd count
  // twice. Base includes exactly one standard door's cost.
  var includedDoorCost = (typeof doorsData!=='undefined' && doorsData.length>0) ? doorMaterialCost(60, 76, true) : 0;
  var shellCost = framing + sid.cost + roofDelta + includedDoorCost + helperCost + fuelCost;
  var baseProxy = shellCost / (1 - cfg.marginTarget/100);

  // ── REAL BASE (workbook sheet) with the proxy as fallback ──
  // The sheet is chosen by style AND porch — see sellSheetKey().
  var baseSheet  = sellSheetKey();
  var baseReal   = sellBaseFor(Wf, Df, baseSheet);
  var baseSource = (baseReal!=null) ? 'sheet' : 'proxy';
  var basePrice  = (baseReal!=null) ? baseReal : baseProxy;
  var marginPrice = basePrice;   // shown as "Base sell" in the redline

  // Anything this quote cannot price yet. Surfaced in the redline so a hole
  // in the tables shows up as a warning instead of a confident wrong number.
  var unpriced = [];
  if(baseReal==null){
    unpriced.push(SHEET_LABEL[baseSheet]+' '+Wf+'x'+Df+'ft — no base in table, using cost\u00d7margin');
  }
  // ── CUSTOMER SELL ADD-ONS (real prices from the workbook) ──
  // Each add-on moves the customer price by exactly its sell amount; its material
  // cost is already in trueTotalCost, so profit = price − cost per add-on.
  var doorUpcharge = 0, doorUpLines = [];
  if(typeof doorsData!=='undefined'){
    doorsData.forEach(function(dd){
      var up = sellDoorUpcharge(dd);
      if(up>0){ doorUpcharge += up;
                doorUpLines.push({label:doorDisplayName(dd) + doorColorLabel(dd), up:up}); }
    });
  }
  var customerPrice = basePrice + doorUpcharge;

  // ── DORMERS (customer): flat price by width, per side ──
  var dormerSell = 0, dormerSellLines = [];
  [['Left', typeof DORMER_L!=='undefined' ? DORMER_L : 0],
   ['Right', typeof DORMER_R!=='undefined' ? DORMER_R : 0]].forEach(function(pair){
    var side=pair[0], ft=pair[1];
    if(ft>0){
      var p = SELL.dormers[ft];
      if(p>0){
        dormerSell += p;
        dormerSellLines.push({label:ft+"' "+side+' Dormer', price:p});
      } else {
        unpriced.push(ft+"ft "+side.toLowerCase()+' dormer — no price set');
      }
    }
  });
  customerPrice += dormerSell;

  // ── PORCH (customer): add-on, not a base-sheet switch. Front porch has
  // finish tiers; side porch is a fixed 4'x6' box. See porchLineFor(). ──
  var porchSell = 0, porchSellName = '';
  var porchLoc = (typeof PORCH_LOC!=='undefined') ? PORCH_LOC : 'none';
  var porchDepth = (typeof SIDE_PORCH!=='undefined') ? SIDE_PORCH : 0;
  var porchTier = (typeof PORCH_TIER!=='undefined') ? PORCH_TIER : 'standard';
  if(porchLoc!=='none' && porchDepth>0){
    var pl = porchLineFor(porchLoc, porchDepth, porchTier, (porchLoc==='side'?Df:Wf));
    if(pl){
      porchSell += pl.price;
      porchSellName = pl.name;
      if(pl.unpriced) unpriced.push(pl.name+' — no price set');
    }
  }
  customerPrice += porchSell;

  // ── SIDING UPCHARGE (customer): per sqft of WALL AREA over included T11 ──
  var sidingSell = 0, sidingSellName = '';
  var sidId = (typeof SIDING!=='undefined')?SIDING:'vertical';
  var sidRate = SELL.siding[sidId];
  if(sidRate>0){
    sidingSell = sidRate * wallAreaFt(Wf, Df, Hf);
    sidingSellName = (sidId==='board-batten')?'Board & Batten':(sidId==='horizontal')?'Horizontal Lap':(sidId==='pine')?'Pine T&G':sidId;
  }
  customerPrice += sidingSell;

  // ── EXTERIOR PAINT (customer): per sqft of WALL AREA, tiered by wall
  // sqft. Not charged for pine — pine gets stained instead (mandatory,
  // priced separately), never painted. Covers siding + trim in one rate.
  var paintSell = 0, paintSellName = '';
  if(sidId!=='pine'){
    /* Flat, so nothing is read off an area. A saved override predating the
       flat fee carries only the old rate/tier keys and the merge never deletes
       from the defaults, so `flat` survives underneath it. Anything unusable
       falls back to the shipped fee rather than to 0 - silently painting a
       shed for free is the leak vents already had. An explicit 0 is honoured. */
    var _pf = SELL.exteriorPaint && SELL.exteriorPaint.flat;
    paintSell = (typeof _pf==='number' && isFinite(_pf) && _pf>=0) ? _pf : PAINT_FLAT;
    paintSellName = 'Exterior Paint';
  }
  customerPrice += paintSell;

  /* ── BUILD LABOUR (customer): per sqft of SHED FLOOR area ──
     Same pine exemption as paint, deliberately: pine is stained rather than
     painted, and that step is priced on its own.
     Note this is floorAreaFt, the shed's own footprint - NOT wall area. Wall
     height therefore does not move it, which is fine here because the wall
     height upcharge below is itself charged per sqft of wall area and so
     already rises with height. */
  var laborSell = 0, laborSellName = '';
  if(sidId!=='pine'){
    var _laborSqft = floorAreaFt(Wf, Df);
    /* Keyed by wall height. An unknown height falls back to the 8ft rate, the
       same way wallHObjFor treats an unknown height as standard. A saved
       override predating this carries labor.rate and no height keys; the merge
       never deletes from the defaults, so the height keys survive underneath
       and the stale `rate` sits inert. Anything unusable falls back to the
       shipped rate rather than to 0 - building a shed for free is the leak
       vents already had. An explicit 0 is honoured. */
    var _lr = SELL.labor && SELL.labor[Hf];
    var laborRate = (typeof _lr==='number' && isFinite(_lr) && _lr>=0)
      ? _lr : (LABOR_BY_HEIGHT[Hf] || LABOR_BY_HEIGHT[8]);
    laborSell = laborRate * _laborSqft;
    laborSellName = 'Build Labor (' + Math.round(_laborSqft) + ' sqft)';
  }
  customerPrice += laborSell;

  /* ── FINISH SHORTFALL RECOVERED INTO THE BASE SHED ──
     Splitting the old $7-a-wall-foot charge into a flat paint fee and a
     per-height footprint rate was meant to change how the price is ARRIVED AT,
     not what it comes to. The fitted rates land close but not exact, and on
     mid-size sheds they come out a few hundred under - money the business was
     not choosing to give away, it just fell out of the arithmetic.
     So the difference goes into the base shed price. The total holds, and the
     allocation is what changed: paint reads as the flat fee it actually is,
     the labour sits with the build where it belongs, and the remainder lands
     on the shed itself rather than being quietly dropped.
     Only ever a top-up. Where the fitted rates already charge MORE than the old
     model did - small sheds, and the tallest walls - nothing is taken back off.
     Pine is excluded: it pays neither paint nor labour and never paid the $7,
     so there is no shortfall to recover on it. */
  var finishRecovered = 0;
  if(sidId!=='pine'){
    var _legacyFinish = LEGACY_FINISH_RATE * wallAreaFt(Wf, Df, Hf);
    finishRecovered = Math.max(0, _legacyFinish - (paintSell + laborSell));
    if(finishRecovered>0){
      marginPrice   += finishRecovered;
      customerPrice += finishRecovered;
    }
  }

  // ── WALL HEIGHT UPCHARGE (customer): per sqft of wall area — 8ft is the included standard ──
  var heightSell = 0, heightSellName = '';
  var heightRate = SELL.wallHeight[Hf];
  if(heightRate>0){
    heightSell = heightRate * wallAreaFt(Wf, Df, Hf);
    heightSellName = Hf+"' Walls";
  }
  customerPrice += heightSell;

  // ── WINDOWS (customer): each placed window at its catalog price ──
  var windowSell = 0, windowSellLines = [];
  if(typeof windowsData!=='undefined'){
    windowsData.forEach(function(wd){
      var p = sellWindowPrice(wd);
      var priced = sellWindowPriced(wd);
      if(p>0){
        windowSell += p;
        windowSellLines.push({label:(wd.type||'Window'), price:p, est:!priced});
        if(!priced) unpriced.push((wd.type||'Untyped window')+' — no workbook price, estimated by area');
      }
    });
  }
  customerPrice += windowSell;

  // ── INTERIOR FINISH (customer): flat job price, tiered by FLOOR sqft ──
  // The tier maths lives in interiorPrice() so the quote and the wizard
  // button label read from ONE implementation. They were briefly separate
  // and that is exactly how the two drift apart.
  var intSell = 0, intSellName = '';
  var intId = (typeof INT_FINISH!=='undefined') ? INT_FINISH : 'none';
  if(intId==='drywall' || intId==='painted'){
    /* Drywall goes in the ROOM, not under the porch. Now the porch eats
       into the footprint, Wf x Df would bill a 12x16-with-a-4ft-porch as
       192 sqft when only 144 of it has walls — a whole tier too high. */
    var _eat = (typeof porchEatFt==='function') ? porchEatFt() : {w:0,l:0};
    var _encW = Wf - _eat.w, _encD = Df - _eat.l;
    var _floor = _encW * _encD;
    intSell = interiorPrice(intId, _encW, _encD);
    intSellName = (intId==='drywall' ? 'Drywall & Mud' : 'Drywall, Mud & Paint')
                + ' (' + _floor + ' sqft)';
  }
  customerPrice += intSell;

  /* ── FLOORING (customer): area x rate, with a job minimum ──
     Same enclosed area the interior finish just used, and for the same
     reason: a porch deck is not floored, so billing the full footprint would
     charge a 12x16-with-a-4ft-porch for 192 sqft of plank when only 144 of it
     is inside. The price does not move with the foundation — the tier's cost
     already carries whichever prep that floor needs. */
  var floorSell = 0, floorSellName = '';
  var floorId = (typeof FLOOR!=='undefined') ? FLOOR : 'none';
  if(FLOORING.tiers[floorId] && floorId!=='none'){
    var _feat = (typeof porchEatFt==='function') ? porchEatFt() : {w:0,l:0};
    var _fArea = (Wf - _feat.w) * (Df - _feat.l);
    floorSell = flooringPrice(floorId, _fArea);
    floorSellName = 'Flooring \u2014 ' + (FLOORING_NAMES[floorId]||floorId)
                  + ' (' + _fArea + ' sq ft)';
  }
  customerPrice += floorSell;

  // ── ELECTRICAL PACKAGE (customer): flat price by tier ──
  var elecSell = 0, elecSellName = '', elecIncludes = [];
  var elecId = (typeof ELEC!=='undefined')?ELEC:'none';
  var ELEC_MAP = { basic:'Basic', core:'Core', essential:'Essential' };
  if(ELEC_MAP[elecId] && SELL.electrical[ELEC_MAP[elecId]]!=null){
    elecSell = SELL.electrical[ELEC_MAP[elecId]];
    elecSellName = ELEC_MAP[elecId]+' Electrical';
    elecIncludes = (ELEC_INCLUDES[ELEC_MAP[elecId]]||[]).slice();
  }
  customerPrice += elecSell;

  // ── SHELVES (customer): chosen length (ft, capped to wall) × depth rate ──
  //   16" deep = $15/ft, 24" deep = $17/ft (SELL.options.perLinFt)
  var shelfSell = 0, shelfSellLines = [];
  if(typeof shelvesData!=='undefined'){
    var r16 = SELL.options.perLinFt['16" Deep Shelving'];
    var r24 = SELL.options.perLinFt['24" Deep Shelving'];
    shelvesData.forEach(function(sd){
      var wallLen = (sd.wall==='front'||sd.wall==='back') ? Wf : Df;
      var lenFt = Math.min(sd.len||wallLen, wallLen);   // cap to the wall length
      var rate = (sd.depth===24) ? r24 : r16;
      var p = lenFt*rate;
      shelfSell += p;
      shelfSellLines.push({label:(sd.depth===24?'24"':'16"')+' Shelf '+lenFt+'ft', price:p});
    });
  }
  customerPrice += shelfSell;

  // ── LOFT (customer): depth(ft) × shed WIDTH × $3/sqft; dual = ×2 ──
  // LOFT value = 'none' or "<depthFt>-<front|back|dual>"
  var loftSell = 0, loftSellName = '';
  var loftId = (typeof LOFT!=='undefined')?LOFT:'none';
  if(loftId && loftId!=='none'){
    var parts = String(loftId).split('-');
    var depthFt = parseFloat(parts[0])||0;
    // Can't build (or charge for) a loft deeper than the shed itself.
    if(depthFt > Df) depthFt = Df;
    var kind = parts[1]||'front';
    var lofts = (kind==='dual')?2:1;
    var sqft = depthFt * Wf * lofts;
    var rate = SELL.options.perSqft['Loft'].rate;   // $3/sqft
    loftSell = sqft * rate;
    var kindLabel = (kind==='dual')?'Dual':(kind==='back')?'Back Gable':'Front Gable';
    loftSellName = depthFt+"' "+kindLabel+' Loft ('+sqft+' sqft)';
  }
  customerPrice += loftSell;

  // ── ADD-ONS (flowerboxes, cupola, shutters, skylight, ladders, wraps…) ──
  var addonSell=0, addonLines=[];
  if(typeof ADDONS!=='undefined'){
    var flat=SELL.options.flat;
    function _flat(on,name,label){ if(on){ var p=flat[name]||0; addonSell+=p; addonLines.push({name:label||name,amt:p}); } }
    _flat(ADDONS.shutters,'Shutters');
    if(ADDONS.flowerboxes){ var fbCt=(typeof windowsData!=='undefined'&&windowsData.length)?windowsData.length:1; var fp=(flat['Flowerboxes']||90)*fbCt; addonSell+=fp; addonLines.push({name:'Flowerboxes \u00d7'+fbCt,amt:fp}); }
    /* GABLE/WALL VENTS — the ones the customer places in the designer.
       "8x16 Gable/Wall Vent" has sat in SELL.options.flat since the table was
       written with nothing ever reading it, so every vent placed was built and
       fitted for nothing. It is not that the charge was folded into the base
       either: the base-shed proxy above deliberately EXCLUDES ventCost, on the
       grounds that vents are "items we charge for separately on the customer
       side" — and the separate charge was never built. Each one costs
       VENT_UNIT_COST to buy, so it was going out below cost.
       Counted off ventsData like Flowerboxes counts off windowsData, so it
       follows what is actually on the shed rather than a toggle. */
    var _ventCt=(typeof ventsData!=='undefined'&&ventsData)?ventsData.length:0;
    if(_ventCt>0){
      var _vp=(flat['8x16 Gable/Wall Vent']||0)*_ventCt;
      if(_vp>0){
        addonSell+=_vp;
        addonLines.push({name:'Gable/Wall Vent \u00d7'+_ventCt, amt:_vp});
      }
    }
    if(ADDONS.cupola==='black')  _flat(true,'Cupola 16" Black Roof','Cupola (Black Roof)');
    if(ADDONS.cupola==='copper') _flat(true,'Cupola 16" Copper Roof','Cupola (Copper Roof)');
    /* Roof Ridge Vent was priced in SELL.options.flat all along with nothing
       able to select it. Flat $263 as written on the sheet — note that means
       the same price on an 8ft ridge as a 24ft one, which is worth revisiting
       since ridge vent is normally sold by the linear foot. */
    // Same gate as the UI — a stale toggle from a previous style must not
    // keep billing after the customer switches to a Lean-To.
    var _hasRidge=(STYLE==='gable'||STYLE==='3peak'||STYLE==='4peak');
    _flat(ADDONS.ridgeVent && _hasRidge,'Roof Ridge Vent');
    _flat(ADDONS.skylight,'Skylight');
    _flat(ADDONS.stairs,'Stairs');
    _flat(ADDONS.statLadder,'Stationary Ladder');
    _flat(ADDONS.atticLadder,'Attic Pull-Down Ladder');
    // Removal of what is already on the site. Priced through the same flat
    // table as every other add-on so the admin price editor can change it, but
    // the quote document pulls these two back out into their own phase — they
    // happen before the pad goes down, not as part of the shed.
    _flat(ADDONS.shedRemoval,'Shed Removal');
    _flat(ADDONS.concreteRemoval,'Concrete Removal');
    function _sq(on,name){ if(on){ var p=Math.round(sellPerSqft(name,Wf,Df,Hf)); addonSell+=p; addonLines.push({name:name,amt:p}); } }
    _sq(ADDONS.weatherGuard,'Floor Weather Guard');
    _sq(ADDONS.radiantBarrier,'Radiant Roof Barrier');
    _sq(ADDONS.houseWrap,'House Wrap');
    _sq(ADDONS.hurricaneTies,'Hurricane Ties');
  }
  customerPrice += addonSell;

  // ── FOUNDATION (flat price, from SELL.foundation / SELL.foundationFinish) ──
  var foundSell=0, foundName='';
  // Levelling on blocks is complimentary, so only the pad adds anything.
  if(typeof FOUNDATION!=='undefined' && FOUNDATION==='pad'){
    foundSell = SELL.foundation.pad||0;
    foundName = 'Concrete Pad (4" slab)';   // the pad spec belongs on every quote, not just the price
    if(typeof FOUNDATION_FINISH!=='undefined'){
      var _sq=(typeof padSqft==='function')?padSqft():(Wf*Df);
      var fc = foundationFinishPrice(FOUNDATION_FINISH, _sq);
      foundSell += fc;
      if(FOUNDATION_FINISH==='broom') foundName+=' + Broom Finish ('+_sq+' sqft)';
      else if(FOUNDATION_FINISH==='coated') foundName+=' + Stained Coating';
    }
  } else if(typeof FOUNDATION!=='undefined' && FOUNDATION==='gravel'){
    var _gsq=(typeof padSqft==='function')?padSqft():(Wf*Df);
    var _gprice = gravelFoundationPrice(_gsq);
    // Over 200 sqft we don't offer a gravel pad — the UI should already keep
    // this option from being selected at that size, but fall back to $0/no
    // line rather than silently charging nothing for a pad we didn't build.
    foundSell = _gprice||0;
    foundName = (_gprice==null)
      ? 'Gravel Pad — not available over 200 sqft'
      : 'Gravel Pad + Leveled on Cinder Blocks ('+_gsq+' sqft)';
  }
  customerPrice += foundSell;

  var profit = customerPrice - trueTotalCost;

  return {
    // customer-facing
    customer: customerPrice,
    // redline (admin/sales)
    redline: {
      framing: framing,
      siding: sid.cost,
      sidingQty: sid.qty,
      roofDelta: roofDelta,
      vents: ventCost, ventCt: ventCt,
      doors: doorCost, doorLines: doorLines,
      windows: winCost, winLines: winLines,
      grandBase: grandBase,
      helperCost: helperCost, buildDays: autoBuildDays,
      fuelCost: fuelCost, gallons: gallons,
      trueTotalCost: trueTotalCost,
      marginTarget: cfg.marginTarget,
      marginPrice: marginPrice,
      baseSheet: baseSheet, baseSheetLabel: SHEET_LABEL[baseSheet],
      baseSource: baseSource, baseProxy: baseProxy,
      unpriced: unpriced,
      doorUpcharge: doorUpcharge, doorUpLines: doorUpLines,
      dormerSell: dormerSell, dormerSellLines: dormerSellLines,
      porchSell: porchSell, porchSellName: porchSellName,
      sidingSell: sidingSell, sidingSellName: sidingSellName,
      paintSell: paintSell, paintSellName: paintSellName,
      laborSell: laborSell, laborSellName: laborSellName,
      finishRecovered: finishRecovered,
      heightSell: heightSell, heightSellName: heightSellName,
      windowSell: windowSell, windowSellLines: windowSellLines,
      intSell: intSell, intSellName: intSellName,
      floorSell: floorSell, floorSellName: floorSellName,
      elecSell: elecSell, elecSellName: elecSellName, elecIncludes: elecIncludes,
      shelfSell: shelfSell, shelfSellLines: shelfSellLines,
      loftSell: loftSell, loftSellName: loftSellName,
      addonSell: addonSell, addonLines: addonLines,
      foundSell: foundSell, foundName: foundName,
      customerPrice: customerPrice,
      marginDollars: profit,
      framingLines: fr.lines,
      metal: (typeof ROOFTYPE!=='undefined' && ROOFTYPE==='metal'),
      cfg: cfg
    }
  };
}


/* Applies an admin-edited pricing snapshot (what /shed/pricing-config
   stores, i.e. what admin-pricing.html or designer.html's #admin screen
   saves) on top of the hardcoded defaults above. Mirrors the exact
   allowlist that used to run client-side in designer.html's boot() — this
   is that same merge, just running once server-side instead of once per
   visitor's page load. Call it once when the Worker starts handling a
   batch of requests (or per-request; it's cheap) BEFORE computePricing —
   never inside the same tick as an await, for the same synchronous-only
   reason setConfig()'s doc comment explains. */
/* THE SHIPPED PRICES, AS SHIPPED.
   Taken at module load, before any request can apply a saved override on top
   of SELL/COST/DEFAULTS. The dashboard needs to show the prices the engine
   will ACTUALLY charge, which is these plus whatever the owner has edited —
   and a live read of SELL cannot give that, because a previous request in the
   same isolate may already have mutated it. */
const PRISTINE = JSON.stringify({ SELL: SELL, COST: COST, DEFAULTS: DEFAULTS });
function pricingDefaults(){ return JSON.parse(PRISTINE); }

/* The named tables an override may replace keys inside. Declared once and used
   by BOTH the live apply and the merged read below, because the two disagreeing
   about which groups exist is exactly how the dashboard ends up showing a
   different set of prices from the one being charged. */
/* WHAT EACH ELECTRICAL TIER INCLUDES.
   Word for word from the tier cards on gallery.html, which is what the
   customer read before they picked one — so the estimate promises exactly what
   the website promised, and there is one place to change it if a tier changes.
   Listed, never priced: the tier is a single flat figure, and a number beside
   each light would invite picking the package apart.
   Exported because a quote stores its redline at submit time, so every order
   placed before this existed has the package NAME but no contents — the Worker
   fills them back in from the name when it serves one. */
const ELEC_INCLUDES = {
  Basic:     ['(1) 6" Light', '(1) Switch', '(1) Outlet', '(1) 120V Power Inlet'],
  Core:      ['(4) 6" Lights', 'Porch Light', '(2) Switches', '(2) Outlets',
              '(1) GFCI Outlet', '(1) 120V Power Inlet'],
  Essential: ['(4) 6" Lights', 'Porch Light', 'Exterior Soffit Lights',
              'Multiple Switch Locations', '(6) Outlets', '(1) GFCI Outlet',
              '(1) 120V Power Inlet']
};

/* Given a stored "Core Electrical", hand back what Core contains. */
/* Re-price the finish on a quote written before paint and labour were split.
   Those redlines carry a single paintSell, charged at $7 per sqft of WALL area,
   and no laborSell at all. This returns what the same build would be charged
   today - the flat paint fee, plus labour on the shed's own footprint at the
   rate for its wall height - so a quote already sent can be shown under current
   pricing without being re-quoted.

   Deliberately NOT a full re-price. Only the two finish figures are recomputed;
   everything else on that redline is what the customer was quoted and stays
   exactly as written. Re-running the whole engine would also move the base shed
   with today's material costs, which is a different and much larger change.

   Returns null - meaning leave the quote alone - when there is nothing to do or
   nothing to do it from: a redline already carrying laborSell is current; a
   build with no paint charge is pine or was never painted, and pine pays
   neither line; and a config without usable dimensions cannot be priced, so it
   is left as written rather than guessed at.

   Reads SELL, so an owner's dashboard edits apply here exactly as they do to a
   new quote. */
function repriceFinish(redline, cfg){
  if(!redline || typeof redline!=='object') return null;
  if(!cfg || typeof cfg!=='object') return null;
  if(redline.laborSell != null) return null;          // already on the new model
  var oldPaint = Number(redline.paintSell) || 0;
  if(cfg.siding==='pine' || oldPaint<=0) return null; // nothing was charged to redo
  var w=Number(cfg.w), d=Number(cfg.l), h=Number(cfg.h);
  if(!(w>0 && d>0 && h>0)) return null;

  var _pf = SELL.exteriorPaint && SELL.exteriorPaint.flat;
  var paintSell = (typeof _pf==='number' && isFinite(_pf) && _pf>=0) ? _pf : PAINT_FLAT;
  var _lr = SELL.labor && SELL.labor[h];
  var laborRate = (typeof _lr==='number' && isFinite(_lr) && _lr>=0)
    ? _lr : (LABOR_BY_HEIGHT[h] || LABOR_BY_HEIGHT[8]);
  var floor = w*d;
  var laborSell = laborRate * floor;

  /* The same top-up a new quote gets, measured against this quote's own stored
     paint charge rather than against LEGACY_FINISH_RATE. That stored figure IS
     what the old model charged for this exact build, so it is the truest
     yardstick available - and using it means an already-sent quote keeps the
     total its customer was given, with only the allocation changing. Which is
     the whole point: the customer sees where their money goes, not a different
     number from the one they agreed to. */
  var recovered = Math.max(0, oldPaint - (paintSell + laborSell));

  return {
    paintSell: paintSell,
    paintSellName: 'Exterior Paint',
    laborSell: laborSell,
    laborSellName: 'Build Labor (' + Math.round(floor) + ' sqft)',
    recovered: recovered,
    delta: (paintSell + laborSell + recovered) - oldPaint
  };
}

function elecIncludesFor(sellName){
  if(!sellName) return [];
  const tier = String(sellName).replace(/\s*Electrical\s*$/i, '').trim();
  return (ELEC_INCLUDES[tier] || []).slice();
}

const OVERRIDE_GROUPS = ['doors','windows','siding','exteriorPaint','labor','electrical','dormers','wallHeight',
  'porchFrontSqft','porchSideSqft','interior','foundation','foundationFinish','broomTiers','gravelTiers'];
const OVERRIDE_OPTION_SUBS = ['flat','perLinFt','perSqft'];

/* A null in a saved override means REMOVED, not "priced at null".
   Deleting the key from the snapshot instead does nothing at all: the snapshot
   is layered OVER the shipped defaults and never deletes from them, so the item
   carried on being charged at its shipped price while the dashboard row was
   gone. A tombstone is what actually takes it off the sheet. */
function _mergeInto(target, src){
  if(!src) return;
  Object.keys(src).forEach(function(k){
    if(src[k]===null) delete target[k]; else target[k]=src[k];
  });
}

function applyPricingOverrides(o){
  if(!o || typeof o!=='object') return;
  if(o.baseSheets) SELL.baseSheets=o.baseSheets;
  _mergeInto(COST, o.COST);
  _mergeInto(DEFAULTS, o.DEFAULTS);
  if(o.SELL){
    OVERRIDE_GROUPS.forEach(function(group){
      if(o.SELL[group] && SELL[group]) _mergeInto(SELL[group], o.SELL[group]);
    });
    if(o.SELL.options){
      OVERRIDE_OPTION_SUBS.forEach(function(sub){
        if(o.SELL.options[sub] && SELL.options[sub]) _mergeInto(SELL.options[sub], o.SELL.options[sub]);
      });
    }
  }
}

/* What the dashboard should render: every shipped price, with the owner's edits
   applied on top — the same combination /shed/quote prices from. Returns a
   plain object and touches no module state, so calling it cannot leak into the
   next quote served by this isolate.
   Any other top-level key the saved config carried is passed through untouched,
   so a round-trip through the editor never drops data it did not know about. */
function mergedPricingConfig(saved){
  var o = (saved && typeof saved==='object') ? saved : {};
  var d = pricingDefaults();
  var out = {};
  Object.keys(o).forEach(function(k){ if(k!=='SELL'&&k!=='COST'&&k!=='DEFAULTS') out[k]=o[k]; });
  out.SELL = d.SELL; out.COST = d.COST; out.DEFAULTS = d.DEFAULTS;
  out.baseSheets = o.baseSheets || d.SELL.baseSheets;
  _mergeInto(out.COST, o.COST);
  _mergeInto(out.DEFAULTS, o.DEFAULTS);
  if(o.SELL){
    if(o.SELL.baseSheets) out.SELL.baseSheets=o.SELL.baseSheets;
    OVERRIDE_GROUPS.forEach(function(group){
      if(o.SELL[group] && out.SELL[group]) _mergeInto(out.SELL[group], o.SELL[group]);
    });
    if(o.SELL.options){
      OVERRIDE_OPTION_SUBS.forEach(function(sub){
        if(o.SELL.options[sub] && out.SELL.options[sub]) _mergeInto(out.SELL.options[sub], o.SELL.options[sub]);
      });
    }
  }
  return out;
}

// ---- end inlined pricing.js ----

// ---- inlined from worker/leadpipeline.js by build-bundle.mjs — do not edit below by hand ----
/* ══════════════════════════════════════════════════════════════════════════
   LEAD ENRICHMENT PIPELINE

   Sources local businesses from Google Places, researches each one with Grok,
   scores it against Potentia's three offers with Claude, and inserts the good
   ones into the CRM's `clients` table as leads.

   Three rules shape most of the code below.

   1. PLACES CONTENT IS BORROWED, NOT KEPT. Google's terms let us store
      `place_id` indefinitely and essentially nothing else. So Places fields
      live in lead_candidates only while a candidate is being judged, and the
      row is stripped the moment it is. A qualified lead's durable contact
      details come from the business's own site (enrichment source_urls).

   2. THE PIPELINE NEVER OVERWRITES. It only ever INSERTs into `clients`. If a
      business is already there — however it got there, however stale it looks
      — the pipeline leaves it completely alone. A caller's hand-typed note is
      worth more than anything this file can work out.

   3. IT SPENDS REAL MONEY. Every run is capped, every call is logged with its
      estimated cost, and a daily ceiling is checked before each paid call.
   ══════════════════════════════════════════════════════════════════════════ */


/* Unit costs in USD, for the daily ceiling and the per-run log. Google Places
   text search is the only paid call left in the pipeline — the AI stages are
   gone and PageSpeed is free — so a run now costs single-digit cents however
   many businesses it judges. */
// Named LEAD_COST / LEAD_DEFAULTS, not COST / DEFAULTS: pricing.js already
// owns those at top level, and the bundler flattens both modules into one
// file where a duplicate const is a hard SyntaxError.
const LEAD_COST = {
  placesSearchUsd: 0.035      // Text Search Enterprise, $35/1000 — VERIFIED
};                            // PageSpeed is free; there is nothing else to pay for.

const LEAD_DEFAULTS = {
  /* Websites checked per run. This was 5 when each one cost six cents of AI
     research; checking is free now, so the only cost is the ten to thirty
     seconds Google takes per site that actually has one. At 20 the run drains
     its queue at roughly the rate sourcing fills it, instead of paying Places
     for candidates that pile up unjudged. */
  perRun: 20,
  dailyUsdCap: 5.0,
  maxAttempts: 3,
  sourceBatch: 2,             // Places queries per run
  /* Star rating a business has to clear to be worth calling. Tunable without
     a deploy via LEADS_MIN_RATING, because where exactly the line sits is a
     judgement about who you want as a customer, not a fact about the code. */
  minRating: 4.0,
};

// ── table setup ───────────────────────────────────────────────────────────
// Lazily created on first use, same as payments/installs/saved_designs.
async function ensureLeadPipelineTables(env) {
  const db = env.CRM_DB;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_template TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL,
      segment TEXT NOT NULL, offer_hint INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, created_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS lead_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      /* status: new -> enriching -> pushed | rejected | failed, or 'screened'
         for a business vetoed on the free Places fields without ever being
         checked. 'screened' is the only one ?rescreen=1 will clear. */
      place_id TEXT NOT NULL UNIQUE, segment TEXT NOT NULL, trade TEXT, offer_hint INTEGER,
      source_id INTEGER, status TEXT NOT NULL DEFAULT 'new',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      places_json TEXT, places_fetched_at TEXT, enrichment_json TEXT,
      promise INTEGER, score INTEGER, best_offer INTEGER, reason TEXT, opener TEXT,
      crm_client_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS enrichment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT,
      sourced INTEGER NOT NULL DEFAULT 0, deduped INTEGER NOT NULL DEFAULT 0,
      enriched INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 0,
      pushed INTEGER NOT NULL DEFAULT 0, screened INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT)`
  ).run();

  /* D1 has no "ADD COLUMN IF NOT EXISTS", and a duplicate ADD throws. Read the
     table first and add only what is missing — the same lazy-migration shape
     the rest of this Worker uses. */

  // `promise` arrived after the first candidates were staged, so it has to be
  // added to an existing table as well as declared in CREATE TABLE above.
  const candCols = await db.prepare("PRAGMA table_info(lead_candidates)").all();
  const candNames = (candCols.results || []).map((r) => r.name);
  if (candNames.indexOf("promise") === -1) {
    await db.prepare("ALTER TABLE lead_candidates ADD COLUMN promise INTEGER").run();
  }
  // Which search found them — "roofing contractor", not just "subcontractor".
  if (candNames.indexOf("trade") === -1) {
    await db.prepare("ALTER TABLE lead_candidates ADD COLUMN trade TEXT").run();
  }

  // Same for `screened` — free screening used to be lumped in with `rejected`.
  const runCols = await db.prepare("PRAGMA table_info(enrichment_runs)").all();
  if ((runCols.results || []).map((r) => r.name).indexOf("screened") === -1) {
    await db.prepare("ALTER TABLE enrichment_runs ADD COLUMN screened INTEGER NOT NULL DEFAULT 0").run();
  }

  const have = await db.prepare("PRAGMA table_info(clients)").all();
  const cols = (have.results || []).map((r) => r.name);
  const wanted = [
    ["do_not_contact", "INTEGER NOT NULL DEFAULT 0"],
    ["place_id", "TEXT"],
    ["lead_score", "INTEGER"],
    ["lead_segment", "TEXT"],
    ["lead_offer", "INTEGER"],
    ["lead_reason", "TEXT"],
    ["lead_opener", "TEXT"],
    ["lead_address", "TEXT"],
    ["lead_area", "TEXT"],
    ["lead_speed", "INTEGER"],
    ["lead_mobile_ready", "INTEGER"],
    ["lead_check", "TEXT"],
    ["lead_trade", "TEXT"],
    ["created_by_pipeline", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [name, decl] of wanted) {
    if (cols.indexOf(name) === -1) {
      await db.prepare(`ALTER TABLE clients ADD COLUMN ${name} ${decl}`).run();
    }
  }

  /* Subcontractors, general contractors and handymen used to be three
     categories. Renaming
     them in place keeps every row's last_run_at and enabled flag, which a
     rebuild would throw away — and rebuilds are the thing that loses track of
     which cities have already been searched. Idempotent: once nothing matches
     it does nothing.

     Runs last on purpose: it writes clients.lead_segment, which only exists
     after the loop above has added it. */
  for (const [table, col] of [["lead_sources", "segment"],
                              ["lead_candidates", "segment"],
                              ["clients", "lead_segment"]]) {
    await db.prepare(
      `UPDATE ${table} SET ${col} = 'home_service'
        WHERE ${col} IN ('subcontractor', 'general', 'handyman')`
    ).run();
  }
}

// ── dedupe helpers ────────────────────────────────────────────────────────
/* Last 10 digits. US numbers arrive from Places as "(435) 232-9516", from a
   website as "+1 435-232-9516", and from a caller's typing as "4352329516" —
   all the same business, and comparing the raw strings would miss every time. */
function normalisePhone(v) {
  const d = String(v == null ? "" : v).replace(/\D+/g, "");
  if (d.length < 10) return null;
  return d.slice(-10);
}

/* Registrable domain, lowercased, "www." dropped. Two listings for one shop
   routinely differ only by scheme, www, a path or a tracking query. */
function registrableDomain(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let host;
  try { host = new URL(s).hostname; } catch (e) { return null; }
  host = host.toLowerCase().replace(/^www\./, "");
  return host || null;
}

// ── Google Places ─────────────────────────────────────────────────────────
/* Places API (New) Text Search. The field mask is deliberately short: it sets
   the billing tier, and every field we ask for is one we would then have to
   delete at judgement time anyway. */
/* places.photos is a Pro-tier field and rating/userRatingCount/websiteUri/
   nationalPhoneNumber are Enterprise-tier, so this mask bills at Enterprise
   either way — the photo list rides along for nothing. We only ever COUNT the
   references; fetching an actual photo is a separate SKU we never call.

   Photo count is one of the better tells in this whole pipeline. A working
   trade business with four photos on its listing is not managing its online
   presence; one with sixty has someone who is. */
const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.photos",
  "places.businessStatus"
].join(",");

async function placesTextSearch(env, query, signal) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(env.GOOGLE_PLACES_API_KEY),
      "X-Goog-FieldMask": PLACES_FIELDS
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 20 }),
    signal: signal || AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Places " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  return (data.places || []).map((p) => ({
    place_id: p.id,
    name: (p.displayName && p.displayName.text) || "",
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || "",
    website: p.websiteUri || "",
    rating: p.rating == null ? null : Number(p.rating),
    review_count: p.userRatingCount == null ? null : Number(p.userRatingCount),
    photo_count: Array.isArray(p.photos) ? p.photos.length : 0,
    status: p.businessStatus || ""
  }));
}

/* Is this business already known to us?
   Checked against BOTH the CRM and the candidate table, on all three keys, so
   a business sourced last week under a different query does not get paid for
   twice. A hit on `clients` is final: rule 2 says we do not touch it. */
async function findExisting(env, cand) {
  const db = env.CRM_DB;
  const phone = normalisePhone(cand.phone);
  const domain = registrableDomain(cand.website);

  const byPlace = await db.prepare(
    "SELECT id, do_not_contact FROM clients WHERE place_id = ? LIMIT 1"
  ).bind(cand.place_id).first();
  if (byPlace) return { where: "clients", on: "place_id", row: byPlace };

  if (phone) {
    /* Compare on digits, not on the stored string: the CRM's phone column
       holds whatever a human typed into it. */
    const rows = await db.prepare(
      "SELECT id, phone, do_not_contact FROM clients WHERE phone IS NOT NULL AND phone != ''"
    ).all();
    const hit = (rows.results || []).find((r) => normalisePhone(r.phone) === phone);
    if (hit) return { where: "clients", on: "phone", row: hit };
  }
  if (domain) {
    const rows = await db.prepare(
      "SELECT id, website_url, do_not_contact FROM clients WHERE website_url IS NOT NULL AND website_url != ''"
    ).all();
    const hit = (rows.results || []).find((r) => registrableDomain(r.website_url) === domain);
    if (hit) return { where: "clients", on: "domain", row: hit };
  }

  const seen = await db.prepare(
    "SELECT id, status FROM lead_candidates WHERE place_id = ? LIMIT 1"
  ).bind(cand.place_id).first();
  if (seen) return { where: "lead_candidates", on: "place_id", row: seen };

  return null;
}

/* ── CHEAP TRIAGE, BEFORE ANY MONEY IS SPENT ────────────────────────────────
   Places gives us review count, photo count and whether a website exists for
   the price of the search we already paid for. Research costs ~$0.06 a head,
   so spending it on a business that visibly cannot fit the profile is waste —
   and worse, it fills the caller's list with near-misses.

   Two jobs here. reject() throws out the clearly-hopeless for free. promise()
   ranks what is left, so the five we DO pay to research each run are the five
   that look most like the profile, rather than whichever happened to be
   sourced first.

   Both read only free fields. Nothing here is a final verdict — the scorer
   still decides, having actually read the business. */
function placesReject(p, minRating) {
  const rc = p.review_count;
  if (rc == null || rc < 5) {
    return "only " + (rc == null ? "no" : rc) + " reviews — no evidence of real trading";
  }
  if (rc > 150) {
    return rc + " reviews — too established to buy a cheap site";
  }

  /* A badly-reviewed business is the wrong customer, not a keener one. A
     website does not fix whatever the reviews are about, the job is more
     likely to end in an argument over the invoice, and it goes in the
     portfolio either way.

     Only applied when Google has a rating to give. The review floor above
     already means anything reaching this line has enough reviews for the
     average to mean something. */
  const floor = minRating == null ? LEAD_DEFAULTS.minRating : Number(minRating);
  const r = p.rating == null ? null : Number(p.rating);
  if (r != null && isFinite(r) && isFinite(floor) && r < floor) {
    return r + " stars from " + rc + " reviews — below the " + floor + " cut-off";
  }
  return null;
}

function placesPromise(p) {
  let score = 0;
  const rc = Number(p.review_count || 0);

  // A real, working business, not a giant one. 8-80 is the sweet spot.
  if (rc >= 8 && rc <= 80) score += 40;
  else if (rc > 80 && rc <= 150) score += 15;
  else score += 5;

  // No website at all is the strongest free signal we get.
  if (!p.website) score += 35;

  // Few photos means nobody is tending the listing.
  const ph = Number(p.photo_count || 0);
  if (ph <= 5) score += 25;
  else if (ph <= 15) score += 12;
  else if (ph >= 40) score -= 10;

  return Math.max(0, Math.min(100, score));
}

// ── the search grid ───────────────────────────────────────────────────────
/* Trades that sub to general contractors, the handyman end of the same
   market, and independent dealers. Second-tier cities on purpose: far more
   businesses with no web presence at all, and far less competition from other
   agencies for a $99 site than in a coastal metro.

   Utah rows ship DISABLED. "Businesses that aren't local" is the one input I
   could not resolve without knowing which town is home — enable the ones you
   want with a single UPDATE (see the README). Nothing in Utah is called until
   you do. */
/* One entry per category. Everything about a segment lives here — the
   searches, the offer it maps to, whether it ships on, and the name the CRM
   shows — so adding a category is one entry rather than four edits in four
   places that have to agree with each other.

   `on` is only the shipped default. Which categories are actually being
   worked is whatever lead_sources says, and that is what the CRM toggles. */
const SEGMENTS = [
  {
    /* Everyone who turns up at a house in a van. Specialty trades who sub to
       general contractors, the small GCs who hire them, and handymen — one
       category because they are the same sales conversation: looking
       legitimate to whoever is deciding who gets the job. For a trade that is
       a general contractor picking a bid list; for a handyman it is a
       homeowner choosing who to let through the door. Same product.

       Established general contractors are not the target and never were, but
       nothing here has to know that: the review ceiling in placesReject sends
       anyone big enough to have an agency straight out. */
    key: "home_service", label: "Home Services", offer: 2, on: true,
    queries: [
      "concrete contractor", "framing contractor", "drywall contractor",
      "electrician", "plumber", "HVAC contractor", "roofing contractor",
      "painting contractor", "flooring installer", "fencing contractor",
      "excavation contractor", "siding contractor", "masonry contractor",
      "stucco contractor", "insulation contractor", "gutter installer",
      "general contractor", "home builder", "remodeling contractor",
      "handyman", "handyman services", "home repair service"
    ]
  },
  {
    /* Detailers live or die on being findable and looking the part, and a
       striking number run the whole business off an Instagram account. */
    key: "detailer", label: "Auto detailers", offer: 1, on: false,
    queries: [
      "auto detailing", "mobile detailing", "car detailing",
      "ceramic coating", "auto detailing service"
    ]
  },
  {
    key: "dealer", label: "Car dealerships", offer: 3, on: false,
    queries: ["used car dealer", "auto sales", "pre-owned vehicles", "car dealership"]
  }
];

const LEAD_SEGMENTS = SEGMENTS.map((s) => s.key);

/* Home. Never called, and never switched on by a category toggle either —
   turning on "Auto detailers" should not start ringing the shop down the road. */
const HOME_STATE = "UT";

/* Wealthy metros, searched at suburb level rather than by metro name.

   "Los Angeles" as a query returns the same few hundred businesses however
   many times you ask, because Places ranks on prominence — and prominence is
   exactly what our target does not have. A business with no website is not
   winning "drywall contractor Los Angeles". It IS findable under the town it
   actually works in, which is why this list is suburbs: Torrance, Whittier,
   Anaheim, Mesa. Twenty-odd searches across a metro reach twenty different
   sets of businesses; one search on the metro reaches one.

   Money is the point of the list. A subcontractor in Newport Beach or
   Scottsdale is bidding on work where looking legitimate to a GC is worth
   real money, which is the whole pitch of offer 2.

   Utah rows are the home state and stay off. */
const CITIES = [
  // Greater Los Angeles
  ["Pasadena", "CA", 1], ["Glendale", "CA", 1], ["Burbank", "CA", 1],
  ["Santa Monica", "CA", 1], ["Torrance", "CA", 1], ["Long Beach", "CA", 1],
  ["Whittier", "CA", 1], ["Pomona", "CA", 1], ["Santa Clarita", "CA", 1],
  ["Thousand Oaks", "CA", 1], ["Woodland Hills", "CA", 1], ["Downey", "CA", 1],
  ["West Covina", "CA", 1], ["Redondo Beach", "CA", 1], ["Calabasas", "CA", 1],

  // Orange County
  ["Anaheim", "CA", 1], ["Irvine", "CA", 1], ["Santa Ana", "CA", 1],
  ["Huntington Beach", "CA", 1], ["Newport Beach", "CA", 1],
  ["Costa Mesa", "CA", 1], ["Fullerton", "CA", 1], ["Mission Viejo", "CA", 1],
  ["Laguna Niguel", "CA", 1], ["Yorba Linda", "CA", 1], ["Orange", "CA", 1],

  // Inland Empire
  ["Riverside", "CA", 1], ["Temecula", "CA", 1], ["Murrieta", "CA", 1],
  ["Rancho Cucamonga", "CA", 1], ["Corona", "CA", 1], ["Chino Hills", "CA", 1],
  ["Ontario", "CA", 1], ["Redlands", "CA", 1], ["Eastvale", "CA", 1],
  ["San Bernardino", "CA", 1],

  // San Diego County
  ["Carlsbad", "CA", 1], ["Encinitas", "CA", 1], ["Del Mar", "CA", 1],
  ["Poway", "CA", 1], ["Escondido", "CA", 1], ["Oceanside", "CA", 1],
  ["Vista", "CA", 1], ["San Marcos", "CA", 1], ["Chula Vista", "CA", 1],
  ["La Mesa", "CA", 1], ["El Cajon", "CA", 1], ["Coronado", "CA", 1],

  // Ventura County
  ["Ventura", "CA", 1], ["Camarillo", "CA", 1], ["Simi Valley", "CA", 1],
  ["Oxnard", "CA", 1], ["Westlake Village", "CA", 1],

  // Coachella Valley
  ["Palm Springs", "CA", 1], ["Palm Desert", "CA", 1], ["La Quinta", "CA", 1],
  ["Rancho Mirage", "CA", 1], ["Indio", "CA", 1],

  // Greater Phoenix
  ["Scottsdale", "AZ", 1], ["Mesa", "AZ", 1], ["Chandler", "AZ", 1],
  ["Gilbert", "AZ", 1], ["Tempe", "AZ", 1], ["Glendale", "AZ", 1],
  ["Peoria", "AZ", 1], ["Surprise", "AZ", 1], ["Goodyear", "AZ", 1],
  ["Paradise Valley", "AZ", 1], ["Queen Creek", "AZ", 1], ["Avondale", "AZ", 1],

  // Home state. Off.
  ["Logan", "UT", 0], ["Ogden", "UT", 0], ["Provo", "UT", 0],
  ["St George", "UT", 0], ["Cedar City", "UT", 0], ["Vernal", "UT", 0]
];
function defaultSources() {
  /* Every segment is seeded for every city whether or not it ships on, so
     switching a category on later is one UPDATE rather than a reseed — and a
     reseed would throw away which cities have already been searched.

     ROW ORDER IS LOAD-BEARING. A run takes the two least-recently-searched
     sources, and on a freshly seeded grid nothing has been searched, so they
     come back in insert order. Grouping by city — every query for Pasadena,
     then every query for Glendale — meant the first ten runs in a row all
     searched Pasadena, and the leads all came from one town. It looked like
     the city list was wrong when the city list was fine.

     So the rows are laid out query-major with the city start rotated each
     round: consecutive rows are different towns AND different trades, and a
     single run's two searches never land in the same place. */
  const plan = [];
  for (const seg of SEGMENTS)
    for (const q of seg.queries) plan.push([q, seg.key, seg.offer, seg.on]);

  /* Stepping through CITIES one at a time would still walk the regions in
     blocks — fifteen LA runs, then the Inland Empire, then San Diego. A stride
     jumps across the list instead, so consecutive runs land in different parts
     of Southern California and you see the whole map from the first day.

     The stride has to be coprime with the number of cities or the walk visits
     a subset and repeats it forever, silently never searching the rest. Rather
     than trust a hand-picked number to stay coprime as cities are added, it is
     checked here and falls back to 1, which is always safe. */
  const n = CITIES.length;
  const stride = coprimeStride(17, n);

  const out = [];
  plan.forEach(([query_template, segment, offer_hint, live], round) => {
    for (let i = 0; i < n; i++) {
      const [city, state, on] = CITIES[(i * stride + round) % n];
      out.push({ query_template, city, state, segment, offer_hint,
                 enabled: live ? on : 0 });
    }
  });
  return out;
}

function coprimeStride(want, n) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  if (n < 2) return 1;
  for (let s = want; s < want + n; s++) {
    const v = ((s - 1) % (n - 1)) + 1;      // keep it in 1..n-1
    if (gcd(v, n) === 1) return v;
  }
  return 1;
}

/* Seeds the grid on an empty table. With force=true it REPLACES the grid —
   which matters because the table is only ever seeded once, so a change to
   defaultSources() is invisible to a database that has already been seeded.
   A reseed drops manual edits with it: any row you switched on by hand goes
   back to whatever this file ships. That is why it is opt-in. */
async function seedLeadSources(env, force) {
  const db = env.CRM_DB;
  const n = await db.prepare("SELECT COUNT(*) AS c FROM lead_sources").first();
  if (n && Number(n.c) > 0) {
    if (!force) return 0;
    await db.prepare("DELETE FROM lead_sources").run();
  }
  const now = new Date().toISOString();
  const rows = defaultSources();

  /* Batched. The grid is nearly two thousand rows now, and one statement at a
     time is one network round trip at a time — tens of seconds of doing
     nothing but waiting, for a request a browser is sitting on. */
  const insert = db.prepare(
    `INSERT INTO lead_sources (query_template, city, state, segment, offer_hint, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(rows.slice(i, i + CHUNK).map((r) =>
      insert.bind(r.query_template, r.city, r.state, r.segment, r.offer_hint, r.enabled, now)));
  }
  return rows.length;
}

// ── stage 1: source + dedupe (no AI, costs pennies) ───────────────────────
async function sourceCandidates(env, counts, opts) {
  const db = env.CRM_DB;
  const batch = (opts && opts.sourceBatch) || LEAD_DEFAULTS.sourceBatch;
  const minRating = env.LEADS_MIN_RATING == null || env.LEADS_MIN_RATING === ""
    ? LEAD_DEFAULTS.minRating : Number(env.LEADS_MIN_RATING);
  const now = new Date().toISOString();

  /* Oldest-run-first so the grid rotates evenly instead of hammering whatever
     sorts first. NULL last_run_at sorts first, so new rows go before old. */
  const srcs = await db.prepare(
    `SELECT * FROM lead_sources WHERE enabled = 1
     ORDER BY last_run_at IS NOT NULL, last_run_at ASC LIMIT ?`
  ).bind(batch).all();

  for (const s of srcs.results || []) {
    const query = `${s.query_template} ${s.city} ${s.state}`;
    let found = [];
    try {
      found = await placesTextSearch(env, query);
      counts.est_cost_usd += LEAD_COST.placesSearchUsd;
    } catch (e) {
      counts.errors.push("source[" + query + "]: " + String(e).slice(0, 200));
      continue;
    }
    await db.prepare("UPDATE lead_sources SET last_run_at = ? WHERE id = ?").bind(now, s.id).run();

    for (const p of found) {
      if (!p.place_id) continue;
      // Permanently closed businesses are not leads.
      if (p.status && p.status !== "OPERATIONAL") { counts.deduped++; continue; }
      counts.sourced++;
      const existing = await findExisting(env, p);
      if (existing) { counts.deduped++; continue; }

      /* Triage on the free fields. A business that fails is still written
         down — a tombstone carrying place_id, the verdict and the reason, and
         none of the Places content — so the next run that meets it dedupes it
         away instead of queueing it up to be checked all over again.

         That tombstone is also how a cut-off gets baked in, which is why
         ?rescreen=1 exists: it clears them so a changed threshold is applied
         to everything, not just to businesses found after the change. */
      const veto = placesReject(p, minRating);
      if (veto) {
        await db.prepare(
          `INSERT INTO lead_candidates
             (place_id, segment, offer_hint, source_id, status, promise, score, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'screened', 0, 0, ?, ?, ?)`
        ).bind(p.place_id, s.segment, s.offer_hint, s.id, veto.slice(0, 300), now, now).run();
        counts.screened++;
        continue;
      }

      await db.prepare(
        `INSERT INTO lead_candidates
           (place_id, segment, trade, offer_hint, source_id, status, promise, places_json, places_fetched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`
      ).bind(p.place_id, s.segment, s.query_template, s.offer_hint, s.id, placesPromise(p),
             JSON.stringify(p), now, now, now).run();
    }
  }
}

// ── stage 2: judge the website (free) ─────────────────────────────────────
/* This used to be two AI calls per business: Grok researched it from search
   results, then Claude scored the research. Both are gone.

   The reason is not that they worked badly — it is that they were being asked
   a question we can already answer. What qualifies a lead here is exactly one
   thing: no website, or a website that is old or performing badly. Whether a
   website exists is in the Places row we have already paid for. How old and
   how slow it is, Google will tell us for free. Paying an AI five cents to
   read search results and guess at both was spending money to be told
   something we could look up. */

/* Pasting a key into a dashboard field catches a trailing newline or a
   leading space more often than anyone admits, and the provider answers with
   a flat "API key is invalid" that sends you looking at the wrong thing. */
function apiKey(v) { return String(v == null ? "" : v).trim(); }

/* Some failures are about the ACCOUNT, not the request: a rejected key, an
   empty credit balance, a suspended org. None of them will come right by
   trying again — the answer is identical six seconds later, on the next
   candidate, and on the one after that. Marking one lets the run stop instead
   of asking the same question of every business in the queue.
   Everything else — a timeout, a 429, a 500 — retries as before.

   A 401/403 is the obvious shape. The expensive one to miss is billing: both
   providers report an empty balance as a plain 400, which looks like any
   other bad request, so it is matched on the wording as well. */
function accountFailure(status, body) {
  if (status === 401 || status === 403 || status === 402) return true;
  if (status !== 400) return false;
  return /credit balance|billing|purchase credits|insufficient (funds|credit)|quota/i
    .test(String(body));
}

function providerError(who, status, body) {
  const e = new Error(who + " " + status + ": " + String(body).slice(0, 300));
  if (accountFailure(status, body)) e.accountFailure = true;
  return e;
}


/* "Newport Beach, CA" out of "1401 Dove St Ste 220, Newport Beach, CA 92660,
   USA". The full address belongs on the lead, but what someone scanning a
   list wants is the town — it is how you decide which five to ring this
   morning.

   Worked backwards from the state-and-zip part rather than by counting
   commas from the front, because a suite line adds a comma and a rural
   address drops the street one, so no fixed index is right for both. */
function placeArea(address) {
  const parts = String(address == null ? "" : address)
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";

  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^([A-Z]{2})\s+\d{5}(-\d{4})?$/.exec(parts[i]);
    if (m) {
      const city = i > 0 ? parts[i - 1] : "";
      return city ? city + ", " + m[1] : m[1];
    }
  }

  // No zip to anchor on — drop a trailing country and take what is left.
  const trimmed = /^(USA|United States)$/i.test(parts[parts.length - 1])
    ? parts.slice(0, -1) : parts;
  if (!trimmed.length) return "";
  return trimmed.length >= 2
    ? trimmed[trimmed.length - 2] + ", " + trimmed[trimmed.length - 1]
    : trimmed[0];
}

/* "Websites" that are not websites. A listing pointing at a Facebook page, a
   Linktree or a marketplace profile means the business has no site of its own
   — which is the pitch, not a disqualification.

   business.site deserves its own mention: that was Google's free website
   builder, and Google shut it down in 2024. A business still listing one has
   a website that does not load at all and may well not know. */
const NOT_A_WEBSITE = [
  "facebook.com", "m.facebook.com", "instagram.com", "linktr.ee", "yelp.com",
  "business.site", "sites.google.com", "nextdoor.com", "angi.com", "thumbtack.com",
  "houzz.com", "bbb.org", "google.com", "linkedin.com", "x.com", "twitter.com"
];

function notARealWebsite(url) {
  const d = registrableDomain(url);
  if (!d) return null;
  for (const bad of NOT_A_WEBSITE) {
    if (d === bad || d.endsWith("." + bad)) return bad;
  }
  return null;
}

/* Google PageSpeed Insights, v5. Free, and it is Google fetching the page
   rather than us — we never request the site ourselves.

   Two things are read from it. The performance score is the "bad performing"
   half of the brief. The `viewport` audit is the "old" half: a page with no
   viewport meta tag was built before responsive design and has never been
   touched since, which on a phone is the difference between a website and a
   photograph of one.

   A real run takes ten to thirty seconds per site, which is why the run
   streams its progress. */
async function pageSpeed(env, url, fetchImpl) {
  const key = apiKey(env.GOOGLE_PLACES_API_KEY);
  const go = async (withKey) => {
    const q = new URLSearchParams({ url: url, strategy: "mobile", category: "performance" });
    if (withKey && key) q.set("key", key);
    return (fetchImpl || fetch)(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q.toString(),
      { signal: AbortSignal.timeout(120000) }
    );
  };

  let res = await go(true);

  /* PageSpeed is one of the few Google APIs that works with no key at all —
     the key only buys a higher rate limit. So a key the project will not
     accept for this API is a reason to drop the key, not to stop working.
     This is the difference between a misconfigured restriction costing you a
     setting to fix later and costing you every lead in the meantime. */
  if (res.status === 403 && key) {
    res = await go(false);
  }

  /* Keyless requests share one quota with everyone on the internet who has not
     set a key, and it is usually spent. Worth trying as a fallback, not worth
     reporting as though the project itself were out of quota — so if the
     keyless attempt is the thing that hit the limit, say what the KEYED
     attempt said, which is the failure there is something to do about. */
  if (res.status === 429 && key) {
    const body = await res.text().catch(() => "");
    throw providerError("PageSpeed", 403,
      "the API key is not allowed to call PageSpeed, and the keyless fallback is out of shared quota: " +
      String(body).slice(0, 160));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    /* A page Lighthouse could not load comes back as a 400, not as a result —
       and that is a lead, not a failure. A business whose website does not
       answer is the best call on the list after one with no website at all,
       and it was being counted as "could not be researched" and retried until
       the candidate retired. */
    const broken = brokenSiteCode(body);
    if (broken) return { unreachable: true, code: broken, performance: null, hasViewport: null };

    throw providerError("PageSpeed", res.status, body);
  }
  const data = await res.json();
  const lh = (data && data.lighthouseResult) || {};

  /* The same thing said the other way: sometimes it is HTTP 200 with a
     runtimeError in the body instead. Both shapes mean the site is broken. */
  if (lh.runtimeError && lh.runtimeError.code) {
    return { unreachable: true, code: lh.runtimeError.code, performance: null, hasViewport: null };
  }

  const perf = lh.categories && lh.categories.performance;
  const viewport = lh.audits && lh.audits.viewport;
  return {
    unreachable: false,
    code: null,
    // Lighthouse scores 0-1; a percentage is what everyone actually talks in.
    performance: perf && typeof perf.score === "number" ? Math.round(perf.score * 100) : null,
    hasViewport: viewport && typeof viewport.score === "number" ? viewport.score === 1 : null
  };
}

/* Lighthouse's names for "I could not load this page". Each one is a website
   that does not work for the business's customers either, which is the thing
   being sold against — so they qualify rather than error.

   Matched on the body text because the code arrives in different places
   depending on whether Google answers 200 or 400. */
const BROKEN_SITE_CODES = [
  "FAILED_DOCUMENT_REQUEST",     // the page never loaded
  "ERRORED_DOCUMENT_REQUEST",    // it loaded an error
  "DNS_FAILURE",                 // the domain does not resolve at all
  "INSECURE_DOCUMENT_REQUEST",   // https asked for, http given
  "NO_FCP"                       // nothing ever rendered
];

function brokenSiteCode(body) {
  const text = String(body == null ? "" : body);
  for (const code of BROKEN_SITE_CODES) {
    if (text.indexOf(code) !== -1) return code;
  }
  return null;
}

/* Something a caller can read out. "FAILED_DOCUMENT_REQUEST" is not. */
const BROKEN_SITE_WORDS = {
  FAILED_DOCUMENT_REQUEST: "their website does not load",
  ERRORED_DOCUMENT_REQUEST: "their website returns an error",
  DNS_FAILURE: "their domain does not resolve — the site is gone",
  INSECURE_DOCUMENT_REQUEST: "their website is not served securely",
  NO_FCP: "their website never finishes loading"
};

/* How bad a site has to be to be worth a call. 50 is Lighthouse's own
   boundary between "needs improvement" and "poor" on mobile. */
const SLOW_AT = 50;

/* The whole qualification, in one place. Returns a verdict with a score so
   the CRM can still rank, and a reason a caller can read down the phone
   without being briefed.

   The cheap checks come first and most businesses never reach PageSpeed. */
async function websiteVerdict(env, places, deps) {
  const reviews = places.review_count == null ? null : Number(places.review_count);
  const trading = reviews == null ? "" : ", " + reviews + " Google reviews";

  if (!places.website) {
    return { qualified: true, score: 95, checked: "places", speed: null, mobileReady: null,
             reason: "No website at all" + trading + "." };
  }

  const impostor = notARealWebsite(places.website);
  if (impostor) {
    const dead = impostor === "business.site";
    return { qualified: true, score: dead ? 95 : 90, checked: "places",
             speed: null, mobileReady: null,
             reason: dead
               ? "Their only site is a Google business.site page, which Google shut down — it does not load" + trading + "."
               : "No site of their own, just a " + impostor + " page" + trading + "." };
  }

  // Plain HTTP in 2026 means nobody has touched it in a decade, and every
  // browser tells their customers it is not secure.
  if (/^http:\/\//i.test(String(places.website).trim())) {
    return { qualified: true, score: 85, checked: "places", speed: null, mobileReady: null,
             reason: "Site is still on plain http — browsers mark it not secure" + trading + "." };
  }

  /* No speed test available — the key is refused and keyless failed too.
     Everything above this line still worked, so businesses with no usable
     site keep qualifying; this one is simply put back for a later run rather
     than guessed at in either direction. */
  if (deps && deps.noPageSpeed) return { defer: true };

  const ps = await (deps && deps.pageSpeed ? deps.pageSpeed : pageSpeed)(env, places.website);

  if (ps.unreachable) {
    const words = BROKEN_SITE_WORDS[ps.code] || "their website could not be loaded";
    return { qualified: true, score: 92, checked: "pagespeed", speed: null, mobileReady: null,
             reason: "Google could not test it \u2014 " + words + trading + "." };
  }
  if (ps.hasViewport === false) {
    return { qualified: true, score: 88, checked: "pagespeed",
             speed: ps.performance, mobileReady: false,
             reason: "Site has no mobile viewport — it was built before phones mattered and is unusable on one" + trading + "." };
  }
  if (ps.performance != null && ps.performance < SLOW_AT) {
    return { qualified: true, score: 75, checked: "pagespeed",
             speed: ps.performance, mobileReady: ps.hasViewport,
             reason: "Website scores " + ps.performance + "/100 on Google's mobile speed test" + trading + "." };
  }

  return { qualified: false, score: ps.performance == null ? 20 : ps.performance,
           checked: "pagespeed", speed: ps.performance, mobileReady: ps.hasViewport,
           reason: ps.performance == null
             ? "Has a working site; Google returned no score for it."
             : "Website is fine — " + ps.performance + "/100 on mobile. Nothing to sell them." };
}

// ── stage 4: push to the CRM ──────────────────────────────────────────────
/* INSERT ONLY. There is no UPDATE path in this function and there should never
   be one — see rule 2 at the top of the file. findExisting() has already run;
   if it found anything, we never get here.

   status stays 'lead'. The CRM validates status against a fixed list in both
   the Worker and crm.html, and "ready to call" is not in it — a row with that
   status would fail validation and not render. Ranking is lead_score, which
   is what a caller actually sorts by. */
async function pushLeadToCrm(env, cand, places, verdict) {
  const now = new Date().toISOString();
  /* Contact details are what the caller needs in front of them for a business
     we are about to ring — not a durable copy of a Places record. */
  const phone = places.phone || null;
  const website = places.website || null;

  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients
       (business_name, phone, website_url, status, source, service,
        place_id, lead_score, lead_segment, lead_offer, lead_reason,
        lead_address, lead_area, lead_speed, lead_mobile_ready, lead_check, lead_trade,
        created_by_pipeline, do_not_contact, created_at, updated_at)
     VALUES (?, ?, ?, 'lead', 'pipeline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).bind(
    places.name || "",
    phone,
    website,
    offerName(cand.offer_hint),
    cand.place_id,
    verdict.score,
    cand.segment,
    cand.offer_hint,
    verdict.reason || "",
    /* Name, phone, website and address are what it takes to actually ring a
       business; they live here because we are working the lead, not because
       we are keeping a copy of a Places record. Everything else a caller
       wants — reviews, photos, hours — is one click away on the live Google
       listing via place_id, which is better than a stale copy anyway. */
    places.address || "",
    placeArea(places.address),
    verdict.speed == null ? null : verdict.speed,
    verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
    verdict.checked || null,
    cand.trade || null,
    now,
    now
  ).run();
  // `message` is left alone on purpose: it is the human's note field, and a
  // pipeline lead never wrote us an inquiry to put in it.
  return (res && res.meta && res.meta.last_row_id) || null;
}

function offerName(n) {
  if (n === 1) return "$99 Website";
  if (n === 2) return "Credibility Website";
  if (n === 3) return "Dealership CRM";
  return "Unknown";
}

/* A search term is not a label. "gutter installer" is what you type into
   Places; "Gutters" is what you want at the top of a column of leads.

   Explicit where the tidy name is not derivable — Electrical from
   electrician, Handyman from home repair service — and a general rule for
   everything else, so adding a search term does not mean remembering to add
   a label alongside it. */
const TRADE_LABELS = {
  "electrician": "Electrical",
  "plumber": "Plumbing",
  "HVAC contractor": "HVAC",
  "gutter installer": "Gutters",
  "flooring installer": "Flooring",
  "general contractor": "General Contracting",
  "home builder": "General Contracting",
  "remodeling contractor": "Remodeling",
  "handyman": "Handyman",
  "handyman services": "Handyman",
  "home repair service": "Handyman",
  "auto detailing": "Detailing",
  "auto detailing service": "Detailing",
  "car detailing": "Detailing",
  "mobile detailing": "Mobile Detailing",
  "ceramic coating": "Ceramic Coating",
  "used car dealer": "Used Cars",
  "auto sales": "Used Cars",
  "pre-owned vehicles": "Used Cars",
  "car dealership": "Dealership"
};

function tradeLabel(query) {
  const q = String(query == null ? "" : query).trim();
  if (!q) return "";
  if (TRADE_LABELS[q]) return TRADE_LABELS[q];
  // "drywall contractor" -> "Drywall", "masonry contractor" -> "Masonry".
  const base = q.replace(/\s+(contractor|installer|services?|service)$/i, "");
  return base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* Every search term the grid can produce, mapped to its label. Served to the
   CRM so the sub-categories it offers are the ones the pipeline can actually
   generate, rather than a second list that has to be kept in step. */
function tradeLabels() {
  const out = {};
  for (const seg of SEGMENTS)
    for (const q of seg.queries) out[q] = tradeLabel(q);
  return out;
}

function segmentLabel(key) {
  const s = SEGMENTS.find((x) => x.key === key);
  return s ? s.label : key;
}

/* What the CRM's category toggles read and write. Counting rows rather than
   storing a flag keeps one source of truth: lead_sources IS the setting. */
async function listSegments(env) {
  const rows = await env.CRM_DB.prepare(
    `SELECT segment,
            SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS on_count,
            COUNT(*) AS total
       FROM lead_sources GROUP BY segment`
  ).all();
  const bySeg = {};
  for (const r of rows.results || []) bySeg[r.segment] = r;

  return SEGMENTS.map((s) => {
    const r = bySeg[s.key];
    return {
      key: s.key,
      label: s.label,
      searches: Number((r && r.on_count) || 0),
      total: Number((r && r.total) || 0),
      enabled: Number((r && r.on_count) || 0) > 0
    };
  });
}

async function setSegmentEnabled(env, segment, enabled) {
  if (LEAD_SEGMENTS.indexOf(segment) === -1) throw new Error("unknown category: " + segment);
  const res = await env.CRM_DB.prepare(
    `UPDATE lead_sources SET enabled = ? WHERE segment = ? AND state <> ?`
  ).bind(enabled ? 1 : 0, segment, HOME_STATE).run();
  return (res && res.meta && res.meta.changes) || 0;
}

// ── judgement: strip the candidate row ────────────────────────────────────
/* The row keeps place_id (storable forever), our own score and a one-line
   reason, and loses every byte of Places and research content. That is enough
   to never re-source the business and to tell a 15 from a 65 later, and it is
   not a copy of anyone's data. */
async function stripCandidate(env, id, status, score, reason, crmId) {
  await env.CRM_DB.prepare(
    `UPDATE lead_candidates
        SET status = ?, score = ?, reason = ?, crm_client_id = ?,
            places_json = NULL, enrichment_json = NULL, opener = NULL,
            updated_at = ?
      WHERE id = ?`
  ).bind(status, score == null ? null : score, (reason || "").slice(0, 300),
         crmId == null ? null : crmId, new Date().toISOString(), id).run();
}

// ── recheck: leads that were never actually speed-tested ──────────────────
/* A lead with a real website should carry a speed score. One that does not
   was judged while the speed test was unavailable, and the only honest thing
   to say about it is that nobody has looked.

   Only untouched leads are considered: status still 'lead', no owner, no
   calls logged. The moment a person has engaged with a business, what the
   pipeline thinks about their website stops being the deciding fact — same
   never-overwrite rule as everywhere else. */
async function recheckLeads(env, opts) {
  const o = opts || {};
  const db = env.CRM_DB;
  await ensureLeadPipelineTables(env);

  const limit = Math.max(1, Math.min(200, Number(o.limit) || 50));
  const rows = await db.prepare(
    `SELECT c.id, c.business_name, c.website_url, c.lead_reason
       FROM clients c
      WHERE c.created_by_pipeline = 1
        AND c.status = 'lead'
        AND (c.owner IS NULL OR c.owner = '')
        AND c.website_url IS NOT NULL AND c.website_url != ''
        AND c.lead_speed IS NULL
        AND NOT EXISTS (SELECT 1 FROM client_calls cl WHERE cl.client_id = c.id)
      ORDER BY c.id ASC LIMIT ?`
  ).bind(limit).all();

  const counts = { looked: 0, kept: 0, retired: 0, skipped: 0, errors: [] };
  const emit = async (evt) => {
    if (!o.onProgress) return;
    try { await o.onProgress(evt); } catch (e) { /* client gone */ }
  };

  const queue = rows.results || [];
  await emit({ event: "recheck_start", total: queue.length });

  let position = 0;
  for (const row of queue) {
    position++;

    /* The free checks already settled these: a Facebook page, a dead
       business.site, plain http. They never needed a speed test and re-running
       one would only risk overturning a correct verdict. */
    if (notARealWebsite(row.website_url) || /^http:\/\//i.test(String(row.website_url).trim())) {
      counts.skipped++;
      continue;
    }

    await emit({ event: "rechecking", position: position, total: queue.length,
                 name: row.business_name || null, website: row.website_url });

    let verdict;
    try {
      verdict = await websiteVerdict(env, { website: row.website_url, review_count: null }, o.deps);
    } catch (e) {
      counts.errors.push((row.business_name || row.id) + ": " + String(e.message || e).slice(0, 160));
      if (e && e.accountFailure) {
        counts.errors.push("stopped: the speed test is still unavailable");
        break;
      }
      continue;
    }
    if (verdict.defer) { counts.errors.push("stopped: the speed test is still unavailable"); break; }

    counts.looked++;
    const now = new Date().toISOString();

    if (verdict.qualified) {
      // Still a lead — now with the evidence it should have had all along.
      await db.prepare(
        `UPDATE clients SET lead_score = ?, lead_reason = ?, lead_speed = ?,
                lead_mobile_ready = ?, lead_check = ?, updated_at = ?
          WHERE id = ?`
      ).bind(verdict.score, verdict.reason || "",
             verdict.speed == null ? null : verdict.speed,
             verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
             verdict.checked || null, now, row.id).run();
      counts.kept++;
    } else {
      /* Marked lost rather than deleted. It was put in front of someone as a
         lead, and a row that quietly disappears is worse than one that says
         why it is no longer worth a call. */
      await db.prepare(
        `UPDATE clients SET status = 'lost', lead_score = ?, lead_reason = ?,
                lead_speed = ?, lead_mobile_ready = ?, lead_check = ?, updated_at = ?
          WHERE id = ?`
      ).bind(verdict.score, "Rechecked: " + (verdict.reason || "their site is fine."),
             verdict.speed == null ? null : verdict.speed,
             verdict.mobileReady == null ? null : (verdict.mobileReady ? 1 : 0),
             verdict.checked || null, now, row.id).run();
      counts.retired++;
    }

    await emit({ event: "rechecked", position: position, total: queue.length,
                 name: row.business_name || null, kept: verdict.qualified,
                 speed: verdict.speed == null ? null : verdict.speed,
                 reason: verdict.reason || null });
  }

  return counts;
}

// ── cost ceiling ──────────────────────────────────────────────────────────
async function spentToday(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await env.CRM_DB.prepare(
    "SELECT COALESCE(SUM(est_cost_usd), 0) AS c FROM enrichment_runs WHERE started_at >= ?"
  ).bind(since).first();
  return Number((row && row.c) || 0);
}

// ── the run ───────────────────────────────────────────────────────────────
/* One run: source a couple of queries, then check up to `perRun`
   candidates. Every paid call is preceded by a ceiling check, so a run that
   starts under budget and crosses it mid-way stops cleanly rather than
   finishing the batch.

   opts.dryRun sources and dedupes and makes NO paid AI calls — the cheap mode
   for looking at what the grid actually returns before spending on it. */
async function runLeadPipeline(env, opts) {
  const o = opts || {};
  const perRun = Math.max(1, Math.min(25, Number(o.limit) || LEAD_DEFAULTS.perRun));
  const cap = Number(env.LEADS_DAILY_USD_CAP || LEAD_DEFAULTS.dailyUsdCap);
  const db = env.CRM_DB;

  await ensureLeadPipelineTables(env);
  await seedLeadSources(env, !!o.reseed);

  const counts = {
    sourced: 0, deduped: 0, enriched: 0, scored: 0,
    pushed: 0, screened: 0, rejected: 0, failed: 0, est_cost_usd: 0, errors: []
  };
  /* A screening tombstone records a cut-off as much as a business, so moving
     the cut-off has to be able to reach back. Only rows screened at sourcing
     are cleared — status 'screened', holding no Places content and never
     checked, so there is nothing to lose. A candidate actually checked and
     turned down is status 'rejected' and keeps its verdict. */
  if (o.rescreen) {
    const gone = await db.prepare(
      "DELETE FROM lead_candidates WHERE status = 'screened'"
    ).run();
    counts.rescreened = (gone && gone.meta && gone.meta.changes) || 0;
  }

  const started = new Date().toISOString();
  const run = await db.prepare(
    "INSERT INTO enrichment_runs (trigger, started_at) VALUES (?, ?)"
  ).bind(o.trigger || "manual", started).run();
  const runId = (run && run.meta && run.meta.last_row_id) || null;

  const already = await spentToday(env);
  const overBudget = () => already + counts.est_cost_usd >= cap;

  /* A caller that is streaming the run to a browser passes onProgress. It is
     never allowed to break the run: the client can hang up at any moment, and
     a failed write must not cost a candidate that is already paid for. */
  const emit = async (evt) => {
    if (!o.onProgress) return;
    try { await o.onProgress(evt); } catch (e) { /* client gone; keep going */ }
  };

  /* Write what has been spent so far back to the run row after every paid
     candidate, instead of only at the end. A run that is cut off halfway --
     the tab closed, the Worker killed -- has still spent that money, and the
     daily ceiling has to know about it or it silently under-counts. */
  const checkpoint = async () => {
    if (!runId) return;
    await db.prepare(
      `UPDATE enrichment_runs SET sourced = ?, deduped = ?, enriched = ?, scored = ?,
              pushed = ?, screened = ?, rejected = ?, failed = ?, est_cost_usd = ? WHERE id = ?`
    ).bind(counts.sourced, counts.deduped, counts.enriched, counts.scored,
           counts.pushed, counts.screened, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)), runId).run();
  };

  try {
    await emit({ event: "sourcing" });
    if (!overBudget()) await sourceCandidates(env, counts, o);
    else counts.errors.push("daily cost ceiling reached before sourcing");
    await checkpoint();
    await emit({ event: "sourced", sourced: counts.sourced,
                 deduped: counts.deduped, screened: counts.screened });

    if (!o.dryRun) {
      /* Recover anything a killed run left mid-flight. A candidate is set to
         'enriching' before the paid call and moved on after it, so a row still
         sitting in 'enriching' long afterwards belongs to a run that died --
         the tab closed, the request cut off. Nothing picks those up again,
         because the batch query only looks at 'new' and 'enriched', so without
         this they are stranded for good.

         Half an hour is well past the longest a live candidate can take (three
         attempts at a three-minute ceiling) so this cannot steal a row from a
         run that is still working. The attempt it burned stays burned: if the
         call really is what is killing the run, it still retires after three. */
      /* Anything an earlier billing or key lapse retired comes back. It was
         never the candidate's fault, and its research is usually still banked
         on the row, so reviving costs nothing and recovers what was paid for. */
      await db.prepare(
        `UPDATE lead_candidates SET status = 'new', attempts = 0, updated_at = ?
          WHERE status = 'failed' AND last_error LIKE ?`
      ).bind(new Date().toISOString(), ACCOUNT_FAIL + "%").run();

      const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await db.prepare(
        `UPDATE lead_candidates SET status = 'new', updated_at = ?
          WHERE status = 'enriching' AND updated_at < ?`
      ).bind(new Date().toISOString(), staleBefore).run();

      /* Only categories that are switched on. The toggles used to govern what
         got SOURCED and nothing else, so switching everything to Auto
         detailers and pressing run worked through a backlog of roofers and
         handymen staged weeks earlier — the categories said one thing and the
         leads said another. Candidates from a category that is off are not
         discarded, just parked until it is on again. */
      const live = await db.prepare(
        "SELECT DISTINCT segment FROM lead_sources WHERE enabled = 1"
      ).all();
      const liveSegments = (live.results || []).map((r) => r.segment);

      const batch = liveSegments.length
        ? await db.prepare(
            `SELECT * FROM lead_candidates
              WHERE status IN ('new','enriched') AND attempts < ?
                AND segment IN (${liveSegments.map(() => "?").join(",")})
              ORDER BY COALESCE(promise, -1) DESC, id ASC LIMIT ?`
          ).bind(LEAD_DEFAULTS.maxAttempts, ...liveSegments, perRun).all()
        : { results: [] };

      const queue = batch.results || [];
      await emit({ event: "batch", total: queue.length });

      let position = 0;
      let noPageSpeed = false;
      for (const cand of queue) {
        position++;
        if (overBudget()) { counts.errors.push("daily cost ceiling reached"); break; }
        const places = safeParse(cand.places_json);
        if (!places) {
          await failCandidate(env, cand, "no places_json", counts);
          continue;
        }
        try {
          await db.prepare("UPDATE lead_candidates SET attempts = attempts + 1, status = 'enriching', updated_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), cand.id).run();

          await emit({ event: "checking", position: position, total: queue.length,
                       name: places.name || null, website: places.website || null });

          /* No retry wrapper. The expensive, flaky, worth-retrying step was
             the AI research; a PageSpeed run that fails is either a site that
             will not load — which is itself a qualification — or an account
             problem, which stops the run. */
          const verdict = await websiteVerdict(env, places,
            Object.assign({}, o.deps, { noPageSpeed: noPageSpeed }));

          if (verdict.defer) {
            /* Put it back exactly as it was, attempt included: it was never
               looked at, and it must not burn its way to 'failed' while the
               speed test is unavailable. */
            await db.prepare(
              "UPDATE lead_candidates SET status = 'new', attempts = ?, updated_at = ? WHERE id = ?"
            ).bind(Number(cand.attempts || 0), new Date().toISOString(), cand.id).run();
            counts.deferred = (counts.deferred || 0) + 1;
            continue;
          }
          counts.scored++;

          if (verdict.qualified) {
            const crmId = await pushLeadToCrm(env, cand, places, verdict);
            await stripCandidate(env, cand.id, "pushed", verdict.score, verdict.reason, crmId);
            counts.pushed++;
          } else {
            await stripCandidate(env, cand.id, "rejected", verdict.score, verdict.reason, null);
            counts.rejected++;
          }
          await checkpoint();
          /* The name is safe to send down the wire and gone from the row a
             line later -- the candidate was just stripped. It is here so the
             person watching sees a business, not a row id. */
          await emit({ event: "judged", position: position, total: queue.length,
                       name: places.name || null, score: verdict.score,
                       kept: verdict.qualified, reason: verdict.reason || null,
                       checked: verdict.checked,
                       spent: Number(counts.est_cost_usd.toFixed(4)) });
        } catch (e) {
          const account = !!(e && e.accountFailure);
          await failCandidate(env, cand, String(e).slice(0, 300), counts, account);
          await checkpoint();
          await emit({ event: "candidate_failed", position: position,
                       total: queue.length, name: (places && places.name) || null,
                       account: account });
          /* A rejected key or an empty balance is the same answer for every
             candidate in the queue. Carrying on costs five cents a head to be
             told it five times, so the run stops and says what to go and fix. */
          if (account) {
            /* A refused PageSpeed only costs us the speed test. The rest of
               the queue — every business with no website, a Facebook-only
               page, a dead builder page or plain http — is still judgeable
               for free, so the run carries on without it. Anything else that
               fails on the account stops the run. */
            if (/^PageSpeed /.test(String(e.message || e))) {
              if (!noPageSpeed) {
                noPageSpeed = true;
                counts.errors.push("speed test unavailable: " + String(e.message || e).slice(0, 160));
                await emit({ event: "no_pagespeed" });
              }
              // failCandidate has already put it back untouched; report it the
              // same way as the ones deferred without even trying.
              counts.deferred = (counts.deferred || 0) + 1;
              continue;
            }
            counts.errors.push("stopped: " + String(e.message || e).slice(0, 200));
            break;
          }
        }
      }
    }
  } catch (e) {
    counts.errors.push("run: " + String(e).slice(0, 300));
  }

  if (runId) {
    await db.prepare(
      `UPDATE enrichment_runs SET finished_at = ?, sourced = ?, deduped = ?, enriched = ?,
              scored = ?, pushed = ?, screened = ?, rejected = ?, failed = ?, est_cost_usd = ?, error = ?
        WHERE id = ?`
    ).bind(new Date().toISOString(), counts.sourced, counts.deduped, counts.enriched,
           counts.scored, counts.pushed, counts.screened, counts.rejected, counts.failed,
           Number(counts.est_cost_usd.toFixed(4)),
           counts.errors.length ? counts.errors.join(" | ").slice(0, 900) : null,
           runId).run();
  }
  return { run_id: runId, dry_run: !!o.dryRun, ...counts };
}

/* A candidate that has burned its attempts is marked failed and left alone;
   the batch query filters on attempts so it never comes back.

   Unless the failure was the account's. A rejected key or an empty balance
   says nothing about the business, and three runs during a billing lapse
   would otherwise retire perfectly good candidates for good. Those give the
   attempt back and carry the ACCOUNT_FAIL marker, which the next run reads to
   revive anything an earlier lapse already retired. */
const ACCOUNT_FAIL = "[account] ";

async function failCandidate(env, cand, msg, counts, account) {
  const attempts = account ? Number(cand.attempts || 0) : Number(cand.attempts || 0) + 1;
  const terminal = !account && attempts >= LEAD_DEFAULTS.maxAttempts;
  if (terminal) counts.failed++;
  const text = (account ? ACCOUNT_FAIL : "") + msg;
  counts.errors.push("candidate " + cand.id + ": " + msg);
  await env.CRM_DB.prepare(
    `UPDATE lead_candidates SET status = ?, attempts = ?, last_error = ?, updated_at = ?
      WHERE id = ?`
  ).bind(terminal ? "failed" : "new", attempts, text.slice(0, 300),
         new Date().toISOString(), cand.id).run();
}


function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ---- end inlined leadpipeline.js ----

// Potentia backend Worker — serves three things from one place:
//  1. /chat            — the AI assistant widget (assistant.js)
//  2. /admin/*          — password-gated dashboard for the shed company
//                         partner: view submissions, edit pricing
//     /shed/pricing     — public: current pricing (for their site to read)
//     /shed/submit      — public: customer design submissions land here
//     /shed/consult     — public: "talk to a designer" call-back requests
//  3. /crm/*            — Potentia's own client CRM (web-design clients:
//                         pipeline, retainers, edit requests). Its own
//                         password and its own session scope — the shed
//                         partner's login does not open it. See the CRM
//                         section near the bottom of this file.
//
// See README.md for full deployment steps (secrets, D1 database, etc).
//
// worker/pricing.js holds the whole SELL/COST pricing engine — it never
// ships to a browser. This is a static import (not per-request dynamic
// import) so it's evaluated once when the isolate boots, same as every
// other module-level const here.


// Every (style, width) combination the designer's DOOR_SIZES catalog offers
// a tile for — kept in sync with that catalog by hand, same as WINDOW_CATALOG
// is kept in sync with pricing.js. Only style+width are needed: sellDoorUpcharge
// buckets purely off those two, never off the shed's own config.
const DOOR_PRICE_ENTRIES = [
  ["basic", 36], ["craftsman", 36], ["xtrim", 36], ["arch", 36], ["panel4", 36],
  ["basic", 42], ["craftsman", 42], ["xtrim", 42], ["arch", 42], ["panel4", 42],
  ["basic", 60], ["craftsman", 60], ["xtrim", 60], ["arch", 60], ["panel4", 60],
  ["basic", 72], ["craftsman", 72], ["xtrim", 72], ["arch", 72], ["panel4", 72],
  ["basic", 84], ["craftsman", 84], ["xtrim", 84], ["arch", 84], ["panel4", 84],
  ["res6", 36], ["reshalf", 36], ["resfull", 36], ["res6B", 36], ["reshalfB", 36], ["resfullB", 36],
  ["resDouble", 72], ["resDoubleFull", 72], ["resDoubleFullB", 72],
  ["slideglass", 70], ["slideglassB", 70],
  ["rollup", 72], ["rollup", 84], ["rollup", 96],
  ["cedar", 60], ["cedar", 72], ["cedar", 84], ["cedar", 96],
  ["fairytale", 36]
];
function computeDoorPrices() {
  const out = {};
  DOOR_PRICE_ENTRIES.forEach(([style, w]) => {
    out[style + "@" + w] = sellDoorUpcharge({ style, w });
  });
  return out;
}

const ALLOWED_ORIGINS = [
  "https://potentianetwork.com",
  "https://www.potentianetwork.com",
  "https://shedpro-utah.com",
  "https://www.shedpro-utah.com",
  "http://localhost:8080"
];

const SYSTEM_PROMPT = `You are the AI assistant embedded on the Potentia Studio website. Potentia builds two things: custom, hand-built websites — no templates, no bloated platforms, 72-hour turnaround, free domain for the first year — and the software a business runs on once the work arrives: fully custom CRMs and tailored sales platforms with data tracking. The website is where a client starts, not the whole offer; Potentia is looking for clients who want to grow with them over years, adding each piece when they need it rather than buying everything at once.

Stage One — the website (yours outright, no page builder underneath):
Tier 1 — Home & Contact Site: two pages, who you are and how to reach you. 3 images, free domain (1 year). Includes a monthly plan for hosting & upkeep; edits after the first 7 days of launch are billed per change request.
Tier 2 — Home, Gallery & Contact Site: everything in Tier 1, plus a gallery page (12 photos and 1 featured video). For businesses where seeing the work is what makes the customer call. Includes a monthly plan to edit, manage & update photos.
Tier 3 — Gallery Site + Scheduling: everything in Tier 2, plus a live booking calendar — the customer picks a service and books a slot instead of waiting on a callback. Includes a monthly plan for the calendar & ongoing management.

Stage Two — the system (scoped and quoted per business):
Fully Custom CRM: the software that manages the work once it arrives, built around the client's own pipeline stages and language, not a template. Website leads captured automatically, call logs, notes and follow-ups, per-person lead ownership, role-based access, their data exportable any time. Includes a monthly plan for hosting, support and changes.
Sales Platform & Data Tracking: the tool the client's team works in all day — quoting, configuring, scheduling, inventory, customer portals — with live pipeline and revenue reporting underneath. Built in stages so each piece earns its keep before the next. Two logins are included and further logins are charged monthly per person.

Add-ons, available at any stage: AI Chat Assistant (like this one!), Lead Alerts & Monthly Reporting, Promotional Video, Google Business Setup, Google Profile Management (monthly), AI Content Engine (monthly), Professional Photography, Logo Vectorization, Service Menu Design.

Important: Potentia does not publish prices publicly — every quote is custom. NEVER state or guess a dollar amount, even if asked directly or pressured. If asked about cost, explain that pricing is tailored to the project and invite them to share project details on the contact page or by calling/texting (435) 277-0764; Potentia responds within 24 hours.

Be warm, concise, and confident — a few sentences at most. You are a live example of what Potentia builds (the AI Chat Assistant add-on), so when it's natural you can mention that this chat is itself a sample of it. Don't be pushy. If asked something unrelated to Potentia or web design, answer briefly and steer back.`;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/* Who is on the phones. Overridden by CRM_CALLERS so the roster changes in
   Cloudflare rather than in a deploy. A fixed list rather than a free-text
   box on purpose: "Fernando M", "fernando" and "Fernando" are three owners
   of the same lead, and nobody notices until someone asks whose it is. */
const DEFAULT_CALLERS = "Fernando M, Alejandro A";

/* ---------------------------------------------------------------------------
   RATE LIMITING
   Every /shed/* endpoint below and /chat are public by necessity — a customer
   has to be able to use them without logging in — which means anyone with curl
   can call them too. What that costs is not the same everywhere:

     /chat          spends the Anthropic key. Real money, per call.
     /shed/submit   writes a lead, uploads up to 6 renders (3MB each) to R2,
                    and makes a geocoding request.
     /shed/consult  writes a lead.
     /shed/design   writes a row.
     /shed/quote    CPU only — but the designer calls it on EVERY change, so
                    its ceiling has to be high enough for someone genuinely
                    designing a shed for an hour.

   Counters live in D1 rather than KV on purpose: D1 is already bound, so this
   needs no new binding and nothing done in the Cloudflare dashboard. KV would
   be the more natural fit at scale and is worth moving to if traffic ever
   justifies it.

   Two rules this must never break:
     - It FAILS OPEN. If the table is missing, D1 is slow, or anything throws,
       the request is allowed. A rate limiter that blocks paying customers
       during a database wobble is worse than the abuse it prevents.
     - It never blocks the admin. Staff endpoints are behind requireAuth and
       are not rate limited at all.
--------------------------------------------------------------------------- */
let _rateTableReady = false;
async function ensureRateTable(env) {
  if (_rateTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      bucket TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    )`
  ).run();
  _rateTableReady = true;
}

function clientIp(request) {
  // CF-Connecting-IP is set by Cloudflare itself and cannot be spoofed by the
  // caller; X-Forwarded-For can be, so it is deliberately not consulted.
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/**
 * Fixed-window counter. Returns { ok } and, when refused, how many seconds
 * until the window rolls over.
 *
 * A fixed window lets someone send up to 2x the limit across a window
 * boundary. That is a known and accepted property here: the point is to stop
 * a loop running all night, not to police the exact shape of a burst, and the
 * alternative costs a second round trip on every request.
 */
async function rateLimit(request, env, name, limit, windowSec) {
  const ip = clientIp(request);
  if (ip === "unknown") return { ok: true };          // no key to count against
  const now = Math.floor(Date.now() / 1000);
  const bucket = name + ":" + ip;
  try {
    await ensureRateTable(env);
    const row = await env.DB.prepare(
      "SELECT count, window_start FROM rate_limits WHERE bucket = ?"
    ).bind(bucket).first();

    if (!row || now - row.window_start >= windowSec) {
      await env.DB.prepare(
        "INSERT INTO rate_limits (bucket, count, window_start) VALUES (?,1,?) " +
        "ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start"
      ).bind(bucket, now).run();
      // Opportunistic pruning — roughly one request in fifty pays for it, so
      // the table cannot grow without bound and no cron is needed.
      if (Math.random() < 0.02) {
        await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
          .bind(now - 86400).run().catch(() => {});
      }
      return { ok: true };
    }

    if (row.count >= limit) {
      return { ok: false, retryAfter: Math.max(1, row.window_start + windowSec - now) };
    }
    await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?")
      .bind(bucket).run();
    return { ok: true };
  } catch (e) {
    return { ok: true };                               // fail open, always
  }
}

function tooMany(retryAfter, origin) {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again shortly." }),
    { status: 429, headers: { ...corsHeaders(origin), "Content-Type": "application/json",
                              "Retry-After": String(retryAfter || 60) } }
  );
}

/* A form field no human ever sees, so anything that fills it in is automated.
   Accepted and answered with a normal 200 rather than an error: a bot told it
   failed simply tries again differently, whereas one told it succeeded moves
   on. Nothing is written either way. */
function looksAutomated(body) {
  return typeof body === "object" && body !== null &&
         typeof body.website === "string" && body.website.trim() !== "";
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    /* Every custom header the pages send has to be named here or the browser
       blocks the request at the preflight, before the Worker ever sees it —
       and reports it as a network failure, which sends you looking at the
       server for something the browser did. */
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Leads-Unlock",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
  });
}

// ---- base64url helpers (Workers has btoa/atob but not base64url) ----
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBuf(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function strToBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToStr(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return decodeURIComponent(escape(atob(str)));
}

// ---- session tokens: HMAC-signed, stateless, no DB lookup needed ----
async function signToken(secret, payload) {
  const dataStr = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataStr));
  return `${strToBase64Url(dataStr)}.${bufToBase64Url(sig)}`;
}
async function verifyToken(secret, token) {
  if (!token || token.indexOf(".") === -1) return null;
  const [dataB64, sigB64] = token.split(".");
  try {
    const dataStr = base64UrlToStr(dataB64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBuf(sigB64), new TextEncoder().encode(dataStr));
    if (!valid) return null;
    const payload = JSON.parse(dataStr);
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return mismatch === 0;
}
function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}
// Shed-partner admin session. Scoped: a Potentia CRM token is signed with the
// same secret, so the payload check is what keeps the two apart — logging into
// the CRM must never hand you the shed dashboard, and vice versa.
async function requireAuth(request, env) {
  const payload = await verifyToken(env.ADMIN_SESSION_SECRET, bearerToken(request));
  return payload && payload.admin === true ? payload : null;
}
// Potentia's own client CRM session — see the CRM section further down.
async function requireCrmAuth(request, env) {
  const payload = await verifyToken(env.ADMIN_SESSION_SECRET, bearerToken(request));
  return payload && payload.crm === true ? payload : null;
}

/* A second gate in front of the lead generator. Everyone working the phones
   gets a CRM login; the generator spends real money and rewrites the search
   grid, and that is not something a caller should be able to do by accident.

   Enforced here rather than by hiding the section, because a hidden button is
   not a lock — the endpoints are one fetch away from anyone with a login.

   The unlock token is sent in its own header. Piggybacking on Authorization
   would mean a caller's CRM token being swapped out for this one. */
async function leadsGate(request, env) {
  /* 401 and 403 mean different things to the page: a 401 sends someone to the
     login screen, a 403 shows the unlock box. Collapsing both into one would
     bounce a signed-in caller to a login they have already done. */
  if (!(await requireCrmAuth(request, env))) return { status: 401, error: "Unauthorized" };
  const raw = request.headers.get("X-Leads-Unlock") || "";
  const payload = await verifyToken(env.ADMIN_SESSION_SECRET, raw);
  if (!payload || payload.leads !== true) return { status: 403, error: "Locked" };
  return null;
}

/* LEADS_PASSWORD only — deliberately no fall back to ADMIN_PASSWORD, which is
   what unlocks prices in the ShedPro designer. Those are two different jobs
   for two different businesses: showing a customer their shed price is a
   thing every ShedPro staffer does all day, and spending Potentia's money
   sourcing leads is not. One password doing both means the first is handed
   out until the second is no longer protected.

   Unset means nobody can unlock, which is the right way round to fail: the
   generator spends money, so "no password configured" has to mean shut, not
   open. */
function leadsPassword(env) {
  return env.LEADS_PASSWORD || null;
}

// ---- /chat: AI assistant ----
async function handleChat(request, env, origin) {
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

  if (messages.length === 0) return json({ error: "No messages" }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Server not configured" }, 500, origin);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: SYSTEM_PROMPT, messages })
    });
  } catch (e) {
    return json({ error: "Upstream request failed" }, 502, origin);
  }
  if (!upstream.ok) return json({ error: "Upstream error" }, 502, origin);

  const data = await upstream.json();
  const reply = data && data.content && data.content[0] && data.content[0].text
    ? data.content[0].text
    : "Sorry, I didn't catch that — could you rephrase?";
  return json({ reply }, 200, origin);
}

// ---- /admin/login ----
async function handleAdminLogin(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "Server not configured" }, 500, origin);
  }
  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return json({ error: "Invalid credentials" }, 401, origin);
  }
  const token = await signToken(env.ADMIN_SESSION_SECRET, { admin: true, exp: Date.now() + SESSION_TTL_MS });
  return json({ token }, 200, origin);
}

// ---- customers: find-or-create by email/phone match ----
async function findOrCreateCustomer(env, { name, email, phone, address, city, state, zip }) {
  const now = new Date().toISOString();
  let existing = null;
  if (email) {
    existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ? LIMIT 1").bind(email).first();
  }
  if (!existing && phone) {
    existing = await env.DB.prepare("SELECT id FROM customers WHERE phone = ? LIMIT 1").bind(phone).first();
  }
  if (existing) {
    // COALESCE(NULLIF(?, ''), col) — a blank field in this submission must not
    // erase what we already know. Every column here used to be overwritten
    // unconditionally, so a customer who left the address off their second
    // design lost the address from their first, and a consult request (phone
    // required, email optional) that matched an existing customer by phone
    // would blank out their email. Absent stays absent; present always wins.
    await env.DB.prepare(
      "UPDATE customers SET name = COALESCE(NULLIF(?, ''), name), email = COALESCE(NULLIF(?, ''), email), " +
        "phone = COALESCE(NULLIF(?, ''), phone), address = COALESCE(NULLIF(?, ''), address), " +
        "city = COALESCE(NULLIF(?, ''), city), state = COALESCE(NULLIF(?, ''), state), " +
        "zip = COALESCE(NULLIF(?, ''), zip), updated_at = ? WHERE id = ?"
    )
      .bind(name || null, email || null, phone || null, address || null, city || null, state || null, zip || null, now, existing.id)
      .run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    "INSERT INTO customers (name, email, phone, address, city, state, zip, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(name || null, email || null, phone || null, address || null, city || null, state || null, zip || null, now, now)
    .run();
  return res.meta.last_row_id;
}


// ---- lead temperature: manual override + revisit date ----
// The computed temperature (days since last touch) is wrong in the one case
// that matters most: a customer who has told you their timeline. Quote someone
// in September for a build they want in March and the maths says "hot" all
// through September and "dormant" by December, when the truth is the reverse.
//
// So two fields, both optional, on the customer:
//   temp_override — pin the temperature and stop computing it
//   follow_up_at  — the date to pick them back up
//
// The revisit date is what stops a pinned temperature going stale. Marked cold
// until March, the customer surfaces on their own in March rather than sitting
// cold forever in a list nobody rereads.
//
// Added by ALTER TABLE rather than in schema.sql because the customers table is
// already live with data. SQLite has no ADD COLUMN IF NOT EXISTS, so this reads
// the table's own columns first. Cheap no-op once they exist.
let customerTempColumnsReady = false;
async function ensureCustomerTempColumns(env) {
  if (customerTempColumnsReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(customers)").all();
  const have = (results || []).map((r) => r.name);
  if (have.indexOf("temp_override") === -1) {
    await env.DB.prepare("ALTER TABLE customers ADD COLUMN temp_override TEXT").run();
  }
  if (have.indexOf("follow_up_at") === -1) {
    await env.DB.prepare("ALTER TABLE customers ADD COLUMN follow_up_at TEXT").run();
  }
  customerTempColumnsReady = true;
}

const LEAD_TEMPS = ["hot", "warm", "cold", "dormant"];

// POST /admin/customers/:id/followup — { temperature, follow_up_at }
// Either may be null to clear it: null temperature means go back to computing
// it from activity, null date means no scheduled revisit.
async function handleSetFollowUp(request, env, origin, customerId) {
  await ensureCustomerTempColumns(env);
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));

  let temperature = null;
  if (body.temperature !== null && body.temperature !== undefined && body.temperature !== "") {
    const t = String(body.temperature).toLowerCase().trim();
    if (LEAD_TEMPS.indexOf(t) === -1) return json({ error: "Invalid temperature" }, 400, origin);
    temperature = t;
  }

  let followUpAt = null;
  if (body.follow_up_at) {
    const d = String(body.follow_up_at).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "Invalid date" }, 400, origin);
    followUpAt = d;
  }

  await env.DB.prepare("UPDATE customers SET temp_override = ?, follow_up_at = ?, updated_at = ? WHERE id = ?")
    .bind(temperature, followUpAt, new Date().toISOString(), customerId)
    .run();

  return json({ ok: true, temperature: temperature, follow_up_at: followUpAt }, 200, origin);
}

// ---- /admin/customers: one row per customer, with their latest order + note ----
async function handleListCustomers(request, env, origin) {
  await ensureCustomerTempColumns(env);
  await ensureCallsTable(env);
  /* Once for the whole list, not once per row: withCurrentFinish reads SELL
     directly, so the owner's saved edits have to be layered on before the map
     below runs. */
  await applySavedPricing(env);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.city, c.state, c.created_at, c.updated_at,
       c.temp_override, c.follow_up_at,
       (SELECT s.id FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_id,
       (SELECT s.details FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_details,
       (SELECT s.status FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_status,
       (SELECT s.created_at FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_at,
       (SELECT COUNT(*) FROM submissions s WHERE s.customer_id = c.id AND s.status != 'superseded') AS submission_count,
       (SELECT n.text FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at,
       (SELECT cl.called_at FROM calls cl WHERE cl.customer_id = c.id ORDER BY cl.called_at DESC LIMIT 1) AS latest_call_at
     FROM customers c
     ORDER BY latest_submission_at DESC
     LIMIT 200`
  ).all();

  const customers = results.map((c) => {
    let quotedPrice = null;
    let isConsult = false;
    let consultEstimate = null;
    try {
      const d = JSON.parse(c.latest_details);
      /* Same re-pricing the quote document gets, so the list and the quote
         never disagree about what a customer is being asked to pay. */
      withCurrentFinish(d);
      if (d && d.quotedPrice != null) quotedPrice = d.quotedPrice;
      // A consult request is a lead with no finished design behind it, so it
      // carries an estimate of what they had going, never a quotedPrice. The
      // two stay in separate fields on purpose: the list must not show a
      // half-finished number in the same column, and with the same weight, as
      // a price someone was actually quoted.
      if (d && d.consult === true) {
        isConsult = true;
        if (d.estimateAtRequest != null) consultEstimate = d.estimateAtRequest;
      }
    } catch (e) {}
    const { latest_details, ...rest } = c;
    return {
      ...rest,
      latest_quoted_price: quotedPrice,
      latest_is_consult: isConsult,
      latest_consult_estimate: consultEstimate
    };
  });

  return json({ customers }, 200, origin);
}

// Lazily creates the payments table on first use — avoids requiring a
// manual D1 migration step for a table that didn't exist when the DB was
// first set up. Cheap no-op once it already exists.
async function ensurePaymentsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      note TEXT,
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// Lazily creates the installs table on first use — same reasoning as
// ensurePaymentsTable: avoids a manual D1 migration for a table that didn't
// exist when the DB was first set up.
// One row per install EVENT, not per order — a submission can have both a
// concrete row and a shed row (or, if a job is redone, two rows for the same
// item), so this is an append-only log like payments/notes, not a pair of
// columns on submissions. item is 'concrete' or 'shed' today but nothing
// here assumes only those two, so a third item type later is just a new
// string, no schema change.
async function ensureInstallsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS installs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      item TEXT NOT NULL,
      install_date TEXT NOT NULL,
      days REAL,
      note TEXT,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// ---- /admin/customers/:id: full detail — customer + all their submissions + notes + payments + installs ----
async function handleGetCustomer(request, env, origin, id) {
  await ensureCustomerTempColumns(env);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensureSubmissionAdjustColumns(env);
  const { results: submissions } = await env.DB.prepare(
    "SELECT id, details, status, created_at, price_adjustment, adjustment_note, adjustments, effective_price FROM submissions WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

  // Each order carries the lines that can be comped on it, priced from its own
  // redline, plus its adjustments normalised into one shape. Done here so the
  // CRM never has to parse a redline or know about the older single-adjustment
  // column.
  submissions.forEach((sub) => {
    sub.adjustment_list = adjustmentsOf(sub);
    let redline = null, parsed = null;
    try {
      parsed = JSON.parse(sub.details);
      redline = parsed && parsed.redline;
    } catch (e) {}
    sub.comp_items = compItemsFromRedline(redline);
    // Backfill the electrical contents for orders taken before they existed.
    if (parsed && withElecIncludes(redline)) sub.details = JSON.stringify(parsed);
  });

  const { results: notes } = await env.DB.prepare(
    "SELECT id, text, created_at FROM notes WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

  await ensurePaymentsTable(env);
  const { results: payments } = await env.DB.prepare(
    "SELECT id, amount, method, note, paid_at, created_at FROM payments WHERE customer_id = ? ORDER BY paid_at DESC, id DESC"
  )
    .bind(id)
    .all();

  await ensureCallsTable(env);
  const { results: calls } = await env.DB.prepare(
    "SELECT id, direction, outcome, duration_min, notes, called_at, created_at FROM calls WHERE customer_id = ? ORDER BY called_at DESC, id DESC"
  )
    .bind(id)
    .all();

  // installs are keyed by submission (order), not customer — join through so
  // a repeat customer's install log for order A never bleeds into order B.
  await ensureInstallsTable(env);
  const { results: installs } = await env.DB.prepare(
    `SELECT i.id, i.submission_id, i.item, i.install_date, i.days, i.note, i.created_at
     FROM installs i JOIN submissions s ON i.submission_id = s.id
     WHERE s.customer_id = ? ORDER BY i.install_date DESC, i.id DESC`
  )
    .bind(id)
    .all();

  return json({ customer, submissions, notes, payments, installs, calls }, 200, origin);
}

// ---- DELETE /admin/customers/:id — permanently removes the customer and
// every submission/note/payment tied to them. No soft-delete: the admin UI
// requires typing the customer's name plus a second confirm before this
// ever fires.
async function handleDeleteCustomer(request, env, origin, id) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensurePaymentsTable(env);
  await ensureCallsTable(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM calls WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM submissions WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id)
  ]);

  return json({ ok: true }, 200, origin);
}

// ---- /admin/customers/:id/notes ----
async function handleAddNote(request, env, origin, customerId) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return json({ error: "text required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.DB.prepare("INSERT INTO notes (customer_id, text, created_at) VALUES (?,?,?)")
    .bind(customerId, text, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id, created_at: now }, 200, origin);
}


// ---- call log (ShedPro) ----
// Logged by hand, not pulled from a phone system: the useful part of a call is
// what was said and what happens next, and no API knows that. Kept separate
// from notes because these fields are answerable in one tap each — a note is
// prose, a call is a record.
//
// Lazily created on first use, same as payments and installs.
async function ensureCallsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_min REAL,
      notes TEXT,
      called_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();
}

const CALL_DIRECTIONS = ["outbound", "inbound"];
// "callback" is its own outcome rather than a note, because it is the one that
// should change what you do next — see the follow-up temperature.
const CALL_OUTCOMES = ["connected", "voicemail", "no-answer", "callback", "wrong-number"];

async function handleAddCall(request, env, origin, customerId) {
  await ensureCallsTable(env);
  const body = await request.json().catch(() => ({}));
  const direction = enumOr(String(body.direction || "").toLowerCase().trim(), CALL_DIRECTIONS, null);
  const outcome = enumOr(String(body.outcome || "").toLowerCase().trim(), CALL_OUTCOMES, null);
  if (!direction) return json({ error: "valid direction required" }, 400, origin);
  if (!outcome) return json({ error: "valid outcome required" }, 400, origin);

  const durationRaw = Number(body.duration_min);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 600) : null;
  const notes = String(body.notes || "").trim().slice(0, 2000) || null;
  const calledAt = body.called_at ? String(body.called_at).slice(0, 40) : new Date().toISOString();

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO calls (customer_id, direction, outcome, duration_min, notes, called_at, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(customerId, direction, outcome, duration, notes, calledAt, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeleteCall(request, env, origin, id) {
  await ensureCallsTable(env);
  await env.DB.prepare("DELETE FROM calls WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/customers/:id/payments ----
// A single collection is sometimes split across two methods (e.g. part cash,
// part Venmo) — the UI handles that by just logging two separate entries
// rather than needing a special multi-method row.
const PAYMENT_METHODS = ["cash", "check", "venmo", "zelle", "invoice2go", "card", "other"];
async function handleAddPayment(request, env, origin, customerId) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const method = String(body.method || "").toLowerCase().trim();
  const note = String(body.note || "").slice(0, 500);
  const paidAt = body.paid_at ? String(body.paid_at).slice(0, 40) : new Date().toISOString();
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "valid amount required" }, 400, origin);
  if (!PAYMENT_METHODS.includes(method)) return json({ error: "valid method required" }, 400, origin);

  await ensurePaymentsTable(env);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(customerId, amount, method, note || null, paidAt, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeletePayment(request, env, origin, id) {
  await ensurePaymentsTable(env);
  await env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/submissions/:id/installs ----
const INSTALL_ITEMS = ["concrete", "shed"];
async function handleAddInstall(request, env, origin, submissionId) {
  const body = await request.json().catch(() => ({}));
  const item = String(body.item || "").toLowerCase().trim();
  const installDate = body.install_date ? String(body.install_date).slice(0, 40) : "";
  const days = body.days != null && body.days !== "" ? Number(body.days) : null;
  const note = String(body.note || "").slice(0, 500);
  if (!INSTALL_ITEMS.includes(item)) return json({ error: "valid item required" }, 400, origin);
  if (!installDate) return json({ error: "install_date required" }, 400, origin);
  if (days != null && (!Number.isFinite(days) || days < 0)) return json({ error: "days must be a non-negative number" }, 400, origin);

  await ensureInstallsTable(env);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO installs (submission_id, item, install_date, days, note, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(submissionId, item, installDate, days, note || null, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeleteInstall(request, env, origin, id) {
  await ensureInstallsTable(env);
  await env.DB.prepare("DELETE FROM installs WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/submissions/:id: single order, for the quote document ----
async function handleGetSubmission(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const submission = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!submission) return json({ error: "Not found" }, 404, origin);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(submission.customer_id).first();
  // Normalised here so the quote document never has to know that older rows
  // store a single adjustment and newer ones store a list.
  submission.adjustment_list = adjustmentsOf(submission);
  /* This is the endpoint the QUOTE reads, so it is the one that decides
     whether an old order itemises its electrical package. See
     withElecIncludes: the contents are filled back in from the stored package
     name, because a redline written before they existed has the name alone. */
  await applySavedPricing(env);
  try {
    const parsed = JSON.parse(submission.details);
    if (parsed && parsed.redline) {
      withElecIncludes(parsed.redline);
      /* And shows the finish under current pricing: a quote written before
         paint and labour were split carries one wall-area paint charge and no
         labour at all, so without this it would go on showing a number the
         business no longer quotes. Stored row untouched — display only. */
      withCurrentFinish(parsed);
      submission.details = JSON.stringify(parsed);
    }
  } catch (e) {}
  return json({ submission, customer: customer || null }, 200, origin);
}

// ---- one-time cleanup: for every customer, any "new" submission that
// isn't their single most-recent submission gets superseded — even if a
// newer submission from them has already been moved to contacted/quoted/etc.
// A "new" row lingering behind a submission the admin already acted on is
// just as stale as a duplicate "new" row; both mean the customer moved on
// to something newer and this one shouldn't still read as a fresh lead.
async function handleCleanupSuperseded(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT id, customer_id, status FROM submissions ORDER BY customer_id, created_at DESC"
  ).all();

  const seenCustomer = new Set();
  const staleIds = [];
  for (const row of results) {
    if (seenCustomer.has(row.customer_id)) {
      if (row.status === "new") staleIds.push(row.id);
    } else {
      seenCustomer.add(row.customer_id);
    }
  }

  if (staleIds.length) {
    await env.DB.batch(staleIds.map((id) => env.DB.prepare("UPDATE submissions SET status = 'superseded' WHERE id = ?").bind(id)));
  }

  return json({ ok: true, updated: staleIds.length }, 200, origin);
}

// One-time fix for the hotspot map showing dots at wherever a customer's
// internet connection happened to route through instead of their actual
// address (see geocodeAddress). Every existing row's details.geo was written
// by the old IP-based logic (or is missing entirely) — this re-derives it
// from the SAME address fields already stored on the row (details.address/
// city/state/zip) and overwrites details.geo, or clears it to null if there
// still isn't a usable address. New submissions get this automatically going
// forward; this is only for the ones already in the database.
// Sequential, not parallel, and capped — polite to the free geocoding API
// and this is a run-once maintenance action, not a hot path.
async function handleRegeocodeSubmissions(request, env, origin) {
  const { results } = await env.DB.prepare("SELECT id, details FROM submissions ORDER BY id DESC LIMIT 3000").all();

  let updated = 0;
  let cleared = 0;
  let unchanged = 0;
  for (const row of results) {
    let d;
    try {
      d = JSON.parse(row.details);
    } catch (e) {
      continue;
    }
    const newGeo = await geocodeAddress({ address: d.address, city: d.city, state: d.state, zip: d.zip });
    const oldGeo = d.geo || null;
    const same =
      (newGeo == null && oldGeo == null) ||
      (newGeo != null && oldGeo != null && newGeo.lat === oldGeo.lat && newGeo.lng === oldGeo.lng);
    if (same) {
      unchanged++;
      continue;
    }
    d.geo = newGeo;
    if (newGeo == null) cleared++;
    else updated++;
    await env.DB.prepare("UPDATE submissions SET details = ? WHERE id = ?")
      .bind(JSON.stringify(d).slice(0, 20000), row.id)
      .run();
  }

  return json({ ok: true, total: results.length, updated, clearedNoAddress: cleared, unchanged }, 200, origin);
}

// One-time fix for quotes submitted while pricing was mid-migration to the
// server-side engine: /shed/submit used to store whatever redline the
// client sent, which was null for every ordinary customer (only staff with
// the redline panel open ever had one) — so those rows are missing their
// itemized breakdown (interior finish, electrical, everything quote.html
// only shows via redline). This recomputes redline from each row's own
// stored config and writes it back, but ONLY when the recomputed total
// still matches the price that customer was actually quoted — if pricing
// has changed since (an admin edited rates), backfilling would silently
// show a different total than what was promised, so those rows are left
// alone and counted separately instead. Safe to run more than once: rows
// that already have a redline are skipped.
async function handleBackfillQuoteRedline(request, env, origin) {
  const { results } = await env.DB.prepare("SELECT id, details FROM submissions ORDER BY id DESC LIMIT 3000").all();

  let updated = 0;
  let alreadyHad = 0;
  let noConfig = 0;
  let priceChanged = 0;
  let failed = 0;
  const priceChangedIds = [];

  for (const row of results) {
    let d;
    try {
      d = JSON.parse(row.details);
    } catch (e) {
      failed++;
      continue;
    }
    if (d.redline) {
      alreadyHad++;
      continue;
    }
    if (!d.config || typeof d.config !== "object" || d.quotedPrice == null) {
      noConfig++;
      continue;
    }
    let result;
    try {
      ({ result } = await computeQuoteResult(d.config, undefined, env));
    } catch (e) {
      failed++;
      continue;
    }
    // Compare to the cent — anything closer than that is float/rounding
    // noise, not an actual price difference.
    const matches = Math.abs(result.customer - Number(d.quotedPrice)) < 0.01;
    if (!matches) {
      priceChanged++;
      priceChangedIds.push(row.id);
      continue;
    }
    d.redline = result.redline;
    await env.DB.prepare("UPDATE submissions SET details = ? WHERE id = ?")
      .bind(JSON.stringify(d).slice(0, 200000), row.id)
      .run();
    updated++;
  }

  return json(
    { ok: true, total: results.length, updated, alreadyHad, noConfig, priceChanged, priceChangedIds, failed },
    200,
    origin
  );
}


// ---- won_at: when a job was actually won ----
// Status changes were never timestamped, so "how long from quote to won" and
// "wins per month" had nothing to read. This starts recording it. Rows already
// marked won before this shipped stay null — there is no way to recover a date
// that was never written, and guessing one from created_at would put every
// historical win on the day its quote came in. The analytics endpoint reports
// those separately rather than quietly folding them in.
//
// ALTER TABLE at runtime, since submissions is live and SQLite has no
// ADD COLUMN IF NOT EXISTS.
let submissionWonColumnReady = false;
async function ensureSubmissionWonColumn(env) {
  if (submissionWonColumnReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(submissions)").all();
  if ((results || []).every((r) => r.name !== "won_at")) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN won_at TEXT").run();
  }
  submissionWonColumnReady = true;
}



// ---- flexible quote adjustments ----
// Three kinds, stackable, stored as a list against one submission:
//   {kind:'comp',    item:'Skylight'}          — that line becomes free
//   {kind:'percent', value:-10}                — 10% off
//   {kind:'amount',  value:-250}               — 250 off
// value is signed throughout, matching the single adjustment this replaces:
// negative takes money off, positive adds it.
//
// ORDER IS NOT COSMETIC. comps, then percent, then amounts. Comping an item
// and then taking a percentage means the percentage is not applied to
// something already being given away — on a 20,000 quote with a 600 cupola
// comped and 10% off, comps-first is 17,460 and percent-first is 17,400. The
// first is the defensible one. Amounts land last so "250 off" is exactly 250.
//
// Several percentages add rather than compound: 10% and 5% is 15% off, not
// 14.5%. Compounding is not what anyone means when they say it out loud.
const ADJUSTMENT_KINDS = ["comp", "percent", "amount"];

// Every individually-priced, customer-visible line on a quote, by the name it
// appears under — which is exactly the set that can be given away. Read from
// the submission's own stored redline, so it reflects what THAT customer was
// quoted rather than a generic catalogue.
/* A quote stores its redline when the order is placed, so every order taken
   before the electrical contents existed has the package NAME and nothing
   else — and the quote page would show "Core Electrical $2,300" with no list
   under it however new the Worker is. Filled back in from the name on the way
   out, so old quotes itemise like new ones.
   Never overwrites: if the redline already carries a list, that is the one the
   customer was quoted and it wins. */
function withElecIncludes(redline) {
  if (!redline || typeof redline !== "object") return redline;
  if (Array.isArray(redline.elecIncludes) && redline.elecIncludes.length) return redline;
  const filled = elecIncludesFor(redline.elecSellName);
  if (filled.length) redline.elecIncludes = filled;
  return redline;
}

/* Show a quote written before the paint/labour split under current pricing.
   repriceFinish decides whether there is anything to do and returns null if
   not, so this is safe to call on every submission regardless of vintage.

   Mutates the parsed details in place and returns whether it changed anything.
   Nothing is written back to D1: the stored row stays exactly as the customer
   was originally quoted, and this only changes what is rendered from it. That
   keeps the record intact and makes the whole thing reversible by shipping a
   bundle that stops calling it.

   quotedPrice moves by the same delta as the redline, or the admin list would
   go on showing the old total while the quote document showed the new one. */
function withCurrentFinish(details) {
  if (!details || typeof details !== "object") return false;
  const priced = repriceFinish(details.redline, details.config);
  if (!priced) return false;
  details.redline.paintSell     = priced.paintSell;
  details.redline.paintSellName = priced.paintSellName;
  details.redline.laborSell     = priced.laborSell;
  details.redline.laborSellName = priced.laborSellName;
  /* The top-up lands in the base shed, exactly as it does on a new quote, so
     the customer's total holds and only the allocation changes. */
  if (priced.recovered > 0) {
    details.redline.marginPrice = (Number(details.redline.marginPrice) || 0) + priced.recovered;
  }
  if (details.quotedPrice != null && isFinite(Number(details.quotedPrice))) {
    details.quotedPrice = Number(details.quotedPrice) + priced.delta;
  }
  return true;
}

function compItemsFromRedline(redline) {
  if (!redline || typeof redline !== "object") return [];
  const out = [];
  const seen = {};
  function push(name, amt) {
    const n = Number(amt);
    if (!name || !Number.isFinite(n) || n <= 0) return;
    const key = String(name);
    // Two shelves of the same size are one comp-able entry at the combined
    // price — offering the same name twice in a picker would be a trap.
    if (seen[key] != null) { out[seen[key]].amt = Math.round((out[seen[key]].amt + n) * 100) / 100; return; }
    seen[key] = out.length;
    out.push({ name: key, amt: Math.round(n * 100) / 100 });
  }
  (redline.addonLines || []).forEach((l) => push(l && l.name, l && l.amt));
  (redline.doorUpLines || []).forEach((l) => push(l && l.label, l && l.up));
  (redline.windowSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.dormerSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  (redline.shelfSellLines || []).forEach((l) => push(l && l.label, l && l.price));
  push(redline.porchSellName, redline.porchSell);
  push(redline.sidingSellName, redline.sidingSell);
  push(redline.heightSellName, redline.heightSell);
  push(redline.elecSellName, redline.elecSell);
  push(redline.loftSellName, redline.loftSell);
  push(redline.intSellName, redline.intSell);
  push(redline.floorSellName, redline.floorSell);
  push(redline.foundName, redline.foundSell);
  // paintSell is deliberately absent. The quote document never sums it as its
  // own line, so comping it would take money off a total that never contained
  // it — the customer's bill would drop by an amount nothing on the page
  // accounts for. Only lines the quote actually adds up can be given away.
  return out;
}

// The arithmetic, in one place. quote.html mirrors this for display; both are
// tested against the same cases so they cannot drift apart quietly.
function applyAdjustments(subtotal, adjustments, compItems) {
  const list = Array.isArray(adjustments) ? adjustments : [];
  const priceOf = {};
  (compItems || []).forEach((i) => { priceOf[i.name] = i.amt; });

  const comped = [];
  let compTotal = 0;
  list.filter((a) => a && a.kind === "comp").forEach((a) => {
    const amt = priceOf[a.item];
    if (amt != null) { compTotal += amt; comped.push({ name: a.item, amt: amt }); }
  });

  let running = subtotal - compTotal;
  if (running < 0) running = 0;
  const afterComps = running;

  let percentTotal = 0;
  list.filter((a) => a && a.kind === "percent").forEach((a) => {
    const v = Number(a.value);
    if (Number.isFinite(v)) percentTotal += afterComps * (v / 100);
  });
  running += percentTotal;

  let amountTotal = 0;
  list.filter((a) => a && a.kind === "amount").forEach((a) => {
    const v = Number(a.value);
    if (Number.isFinite(v)) amountTotal += v;
  });
  running += amountTotal;
  if (running < 0) running = 0;

  return {
    comped: comped,
    compTotal: Math.round(compTotal * 100) / 100,
    percentTotal: Math.round(percentTotal * 100) / 100,
    amountTotal: Math.round(amountTotal * 100) / 100,
    adjusted: Math.round(running * 100) / 100
  };
}

function validateAdjustments(raw) {
  if (!Array.isArray(raw)) return { error: "adjustments must be a list" };
  if (raw.length > 20) return { error: "too many adjustments" };
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return { error: "bad adjustment entry" };
    const kind = String(a.kind || "").toLowerCase();
    if (ADJUSTMENT_KINDS.indexOf(kind) === -1) return { error: "unknown adjustment kind: " + kind };
    const note = String(a.note || "").trim().slice(0, 200) || null;
    if (kind === "comp") {
      const item = String(a.item || "").trim().slice(0, 200);
      if (!item) return { error: "comp needs an item" };
      out.push({ kind: kind, item: item, note: note });
    } else {
      const v = Number(a.value);
      if (!Number.isFinite(v) || v === 0) return { error: kind + " needs a non-zero value" };
      // A percentage past 100 either zeroes the quote or doubles it by
      // accident; both are far likelier to be a typo than an intention.
      if (kind === "percent" && (v > 100 || v < -100)) return { error: "percent must be between -100 and 100" };
      out.push({ kind: kind, value: Math.round(v * 100) / 100, note: note });
    }
  }
  return { list: out };
}

// ---- per-quote price adjustment ----
// A discount or surcharge agreed with ONE customer, stored against their
// submission so it changes that quote and nothing else. Deliberately kept as
// its own field rather than edited into quotedPrice: the original quote stays
// readable, so "we quoted 23,839 and took 1,000 off" survives as a fact instead
// of becoming an unexplained 22,839.
//
// Signed, so the same field covers a discount (negative) and a surcharge
// (positive) — a delivery a long way out, an awkward site.
//
// ALTER TABLE at runtime, since submissions is live.
let submissionAdjustColumnsReady = false;
async function ensureSubmissionAdjustColumns(env) {
  if (submissionAdjustColumnsReady) return;
  const { results } = await env.DB.prepare("PRAGMA table_info(submissions)").all();
  const have = (results || []).map((r) => r.name);
  if (have.indexOf("price_adjustment") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN price_adjustment REAL").run();
  }
  if (have.indexOf("adjustment_note") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN adjustment_note TEXT").run();
  }
  // The stackable list, and the price it works out to. effective_price is
  // stored rather than recomputed on every read so the analytics never has to
  // re-derive it from a redline — one place does the arithmetic, at save time.
  if (have.indexOf("adjustments") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN adjustments TEXT").run();
  }
  if (have.indexOf("effective_price") === -1) {
    await env.DB.prepare("ALTER TABLE submissions ADD COLUMN effective_price REAL").run();
  }
  submissionAdjustColumnsReady = true;
}


// Reads whichever form a row is in. Rows predating the list carry a single
// signed price_adjustment; they are presented as a one-entry list so nothing
// downstream needs to know which era a row is from.
function adjustmentsOf(row) {
  if (row && row.adjustments) {
    try {
      const parsed = JSON.parse(row.adjustments);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {}
  }
  if (row && row.price_adjustment != null && Number(row.price_adjustment) !== 0) {
    return [{ kind: "amount", value: Number(row.price_adjustment), note: row.adjustment_note || null }];
  }
  return [];
}

// POST /admin/submissions/:id/adjustments — { adjustments: [...] }
// Replaces the whole list; an empty list clears it.
async function handleSetAdjustments(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const row = await env.DB.prepare("SELECT id, details FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  const v = validateAdjustments(body.adjustments);
  if (v.error) return json({ error: v.error }, 400, origin);

  let quoted = null, redline = null;
  try {
    const d = JSON.parse(row.details);
    if (d) {
      if (d.quotedPrice != null) quoted = Number(d.quotedPrice);
      redline = d.redline || null;
    }
  } catch (e) {}

  const compItems = compItemsFromRedline(redline);
  // A comp naming a line this quote does not have would silently do nothing,
  // so it is refused rather than stored as a no-op the CRM would still display.
  const names = {};
  compItems.forEach((i) => { names[i.name] = true; });
  for (const a of v.list) {
    if (a.kind === "comp" && !names[a.item]) {
      return json({ error: "This quote has no line called \"" + a.item + "\"" }, 400, origin);
    }
  }

  // With no adjustments there is no effective price — the quote stands on its
  // own. Computed and reported as null in that case rather than as the
  // unadjusted total, so the response says exactly what was stored; returning
  // a number here while writing NULL would have the caller believe a price was
  // pinned that is not.
  let effective = null;
  if (v.list.length && quoted != null && Number.isFinite(quoted)) {
    effective = applyAdjustments(quoted, v.list, compItems).adjusted;
  }

  await env.DB.prepare(
    "UPDATE submissions SET adjustments = ?, effective_price = ?, price_adjustment = NULL, adjustment_note = NULL WHERE id = ?"
  )
    .bind(v.list.length ? JSON.stringify(v.list) : null, effective, id)
    .run();

  return json({ ok: true, adjustments: v.list, effective_price: effective, compItems: compItems }, 200, origin);
}

// POST /admin/submissions/:id/adjustment — { amount, note }
// amount null or 0 clears it.
async function handleSetAdjustment(request, env, origin, id) {
  await ensureSubmissionAdjustColumns(env);
  const row = await env.DB.prepare("SELECT id, details FROM submissions WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  let amount = null;
  if (body.amount !== null && body.amount !== undefined && body.amount !== "") {
    const n = Number(body.amount);
    if (!Number.isFinite(n)) return json({ error: "amount must be a number" }, 400, origin);
    amount = Math.round(n * 100) / 100;
  }

  // A discount can't exceed the quote — that would produce a negative total and
  // a quote document nobody could act on. Caught here rather than in the browser
  // so it holds however the endpoint is called.
  if (amount !== null && amount < 0) {
    let quoted = null;
    try {
      const d = JSON.parse(row.details);
      if (d && d.quotedPrice != null) quoted = Number(d.quotedPrice);
    } catch (e) {}
    if (quoted != null && Number.isFinite(quoted) && amount + quoted < 0) {
      return json({ error: "Discount is larger than the quote" }, 400, origin);
    }
  }

  const note = amount === null ? null : String(body.note || "").trim().slice(0, 200) || null;
  await env.DB.prepare("UPDATE submissions SET price_adjustment = ?, adjustment_note = ? WHERE id = ?")
    .bind(amount, note, id)
    .run();
  return json({ ok: true, amount: amount, note: note }, 200, origin);
}

async function handleUpdateSubmissionStatus(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status || "").slice(0, 40);
  if (!id || !status) return json({ error: "id and status required" }, 400, origin);
  await ensureSubmissionWonColumn(env);

  // Stamped on the way in to won, and cleared on the way out — a job marked won
  // by mistake and moved back shouldn't leave a win date behind for the
  // analytics to count. Re-marking an already-won job keeps the first date:
  // that's when it was won, not when someone last clicked the dropdown.
  if (status === "won") {
    await env.DB.prepare(
      "UPDATE submissions SET status = ?, won_at = COALESCE(won_at, ?) WHERE id = ?"
    )
      .bind(status, new Date().toISOString(), id)
      .run();
  } else {
    await env.DB.prepare("UPDATE submissions SET status = ?, won_at = NULL WHERE id = ?")
      .bind(status, id)
      .run();
  }
  return json({ ok: true }, 200, origin);
}

// ---- /admin/pricing ----
async function handleListPricing(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, category, price, unit, sort_order FROM pricing ORDER BY category, sort_order, label"
  ).all();
  return json({ pricing: results }, 200, origin);
}

async function handleUpsertPricing(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = body.id ? Number(body.id) : null;
  const label = String(body.label || "").slice(0, 200);
  const category = String(body.category || "").slice(0, 100);
  const price = Number(body.price);
  const unit = String(body.unit || "").slice(0, 40);
  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
  if (!label || !Number.isFinite(price)) return json({ error: "label and numeric price required" }, 400, origin);
  const now = new Date().toISOString();
  if (id) {
    await env.DB.prepare("UPDATE pricing SET label=?, category=?, price=?, unit=?, sort_order=?, updated_at=? WHERE id=?")
      .bind(label, category, price, unit, sortOrder, now, id)
      .run();
    return json({ ok: true, id }, 200, origin);
  }
  const res = await env.DB.prepare("INSERT INTO pricing (label, category, price, unit, sort_order, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(label, category, price, unit, sortOrder, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

async function handleDeletePricing(request, env, origin, id) {
  await env.DB.prepare("DELETE FROM pricing WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/pricing (public) + /shed/submit (public) ----
async function handlePublicPricing(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT label, category, price, unit FROM pricing ORDER BY category, sort_order, label"
  ).all();
  return json({ pricing: results }, 200, origin);
}

// Decodes a data: URL image into raw bytes for an R2 put(). Returns null for
// anything that isn't a plain base64 JPEG/PNG data URL.
function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return null;
  const ext = match[1].toLowerCase() === "png" ? "png" : "jpg";
  let bin;
  try {
    bin = atob(match[2]);
  } catch (e) {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ext, contentType: ext === "png" ? "image/png" : "image/jpeg" };
}

const ALLOWED_RENDER_VIEWS = ["perspective", "front", "back", "left", "right"];

// Uploads submitted 3D renders to R2 and returns { view: publicUrl }. Never
// throws — a broken/oversized image is just skipped, it doesn't fail the
// whole submission.
async function uploadRenders(env, renders) {
  if (!Array.isArray(renders) || !env.RENDERS || !env.RENDERS_PUBLIC_BASE) return null;
  const out = {};
  for (const r of renders.slice(0, 6)) {
    if (!r || typeof r.view !== "string" || !ALLOWED_RENDER_VIEWS.includes(r.view)) continue;
    const decoded = dataUrlToBytes(r.dataUrl);
    if (!decoded || decoded.bytes.length > 3_000_000) continue;
    const key = `submissions/${Date.now()}-${crypto.randomUUID()}-${r.view}.${decoded.ext}`;
    try {
      await env.RENDERS.put(key, decoded.bytes, { httpMetadata: { contentType: decoded.contentType } });
      out[r.view] = env.RENDERS_PUBLIC_BASE.replace(/\/$/, "") + "/" + key;
    } catch (e) {
      // skip this image
    }
  }
  return Object.keys(out).length ? out : null;
}

// Turns the customer's OWN submitted address into a map point for the admin
// data page's hotspot map — this used to be the requester's IP-based
// geolocation instead, which puts the dot wherever their phone/ISP happened
// to route through at the moment they hit submit (often a different city
// than the actual delivery address, sometimes a different state entirely).
// Zippopotam.us is free and keyless — no signup, no API key to manage — and
// resolves to a ZIP centroid, which is the same precision the old IP
// geolocation gave anyway, just anchored to the right place. Falls back from
// zip -> city+state -> null; a submission with no usable address gets no
// dot rather than a wrong one.
async function geocodeAddress(contact) {
  const zip = String((contact && contact.zip) || "").trim().slice(0, 10);
  const state = String((contact && contact.state) || "").trim().slice(0, 2);
  const city = String((contact && contact.city) || "").trim();
  try {
    if (zip) {
      const r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(zip));
      if (r.ok) {
        const d = await r.json();
        const p = d.places && d.places[0];
        if (p && p.latitude != null && p.longitude != null) {
          return {
            lat: Number(p.latitude),
            lng: Number(p.longitude),
            city: p["place name"] || city || null,
            region: p["state abbreviation"] || state || null,
            country: "US"
          };
        }
      }
    }
    if (city && state) {
      const r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(state) + "/" + encodeURIComponent(city));
      if (r.ok) {
        const d = await r.json();
        const p = d.places && d.places[0];
        if (p && p.latitude != null && p.longitude != null) {
          return {
            lat: Number(p.latitude),
            lng: Number(p.longitude),
            city: d["place name"] || city,
            region: d["state abbreviation"] || state,
            country: "US"
          };
        }
      }
    }
  } catch (e) {
    // network hiccup — fall through to null, no dot rather than a wrong one
  }
  return null;
}

async function handleShedSubmit(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  // Answered as if it worked. See looksAutomated: nothing is stored.
  if (looksAutomated(body)) return json({ ok: true }, 200, origin);
  // Accepts either the designer tool's shape ({contact:{...}, config, permalink,
  // quotedPrice, redline, renders, page}) or a plain {name, email, phone, details} shape.
  const contact = body.contact || {};
  const name = String(contact.name || body.name || "").slice(0, 200);
  const email = String(contact.email || body.email || "").slice(0, 200);
  const phone = String(contact.phone || body.phone || "").slice(0, 60);
  if (!name || !email) return json({ error: "name and email required" }, 400, origin);

  // Map point for the admin data page's hotspot map — geocoded from the
  // customer's own submitted address, not from where their connection
  // happened to be (see geocodeAddress above).
  const geo = await geocodeAddress(contact);

  // Price it ourselves rather than trusting body.quotedPrice/body.redline —
  // the client can't compute a redline any more (pricing.js never ships to
  // it), so quoteCache.redline is only ever non-null for staff who had the
  // redline panel open at submit time. Every ordinary customer quote used to
  // arrive with redline:null, which is why the stored order was missing
  // line items (electrical, interior finish) that only ever lived in the
  // redline breakdown. Computing it here means every submission gets the
  // real, current numbers regardless of what the browser sent.
  let quotedPrice = body.quotedPrice != null ? body.quotedPrice : null;
  let redline = body.redline || null;

  /* The margin target a salesperson dialled in has to survive the submit, or
     the lever does nothing: the redline panel would show the higher price,
     the order would store the default, and the quote would go out at a number
     nobody chose. It is re-priced here rather than trusted from the body —
     the browser sends the margin, never the price — and only for a caller
     holding a staff token, so a customer cannot price their own shed.
     Clamped to the 30–70% band by clampMarginTarget in the pricing module. */
  let marginTarget = null;
  if (body.overrides && body.overrides.marginTarget != null && (await requireAuth(request, env))) {
    marginTarget = clampMarginTarget(body.overrides.marginTarget);
  }

  if (body.config) {
    try {
      const { result } = await computeQuoteResult(
        body.config,
        marginTarget != null ? { marginTarget: marginTarget } : undefined,
        env
      );
      quotedPrice = result.customer;
      redline = result.redline;
    } catch (e) {
      // Malformed config — fall back to whatever the client sent (if anything)
      // rather than losing the submission over a pricing error.
    }
  }

  const detailsPayload =
    body.details !== undefined
      ? body.details
      : {
          address: contact.address || null,
          city: contact.city || null,
          state: contact.state || null,
          zip: contact.zip || null,
          notes: contact.notes || null,
          config: body.config || null,
          permalink: body.permalink || null,
          quotedPrice: quotedPrice,
          // What the shed was actually priced at, when staff moved it off the
          // default. null means the standard margin — see DEFAULTS.marginTarget.
          marginTarget: marginTarget,
          redline: redline, // internal cost/margin breakdown — admin dashboard only, never public
          renders: await uploadRenders(env, body.renders),
          page: body.page || null,
          geo,
          heardAbout: body.heardAbout || null,
          heardAboutOther: body.heardAboutOther || null
        };
  const details = JSON.stringify(detailsPayload).slice(0, 20000);

  const customerId = await findOrCreateCustomer(env, {
    name,
    email,
    phone,
    address: contact.address,
    city: contact.city,
    state: contact.state,
    zip: contact.zip
  });

  // A customer working through design iterations can submit several times
  // in a row. Only the newest untouched submission should ever count as a
  // "new" lead — once a fresh one lands, mark any still-"new" ones from
  // this same customer as superseded so they stop inflating the New count.
  // Submissions the admin already moved past "new" (contacted/quoted/etc.)
  // are left alone — that's real pipeline progress, not noise.
  await env.DB.prepare("UPDATE submissions SET status = 'superseded' WHERE customer_id = ? AND status = 'new'")
    .bind(customerId)
    .run();

  await env.DB.prepare("INSERT INTO submissions (customer_id, name, email, phone, details, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(customerId, name, email, phone, details, "new", new Date().toISOString())
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/consult (public): "talk to a designer" from inside the designer ----
// A consult is a lead that arrives BEFORE a finished design, which makes it
// the opposite of /shed/submit in three ways worth stating, because each one
// is a deliberate difference and not an oversight:
//
//   1. Phone is required and email is not. Someone asking for a call back is
//      giving you the channel they want to be reached on; demanding an email
//      on top of it is friction in exchange for a field you may never use.
//   2. It does NOT supersede the customer's existing "new" submissions.
//      /shed/submit does that because a fresh design replaces an older one.
//      A request to talk replaces nothing — if they already sent a quote
//      request, that lead is still live and must stay in the New count.
//   3. No geocoding. The form asks for a name, a number and a good time; there
//      is no address to place on the map, and inventing one from the
//      connection's IP would put a false dot on the hotspot map.
//
// The design they had going when they asked is stored alongside, so the
// call-back starts from what they were looking at rather than from nothing.
async function handleShedConsult(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  if (looksAutomated(body)) return json({ ok: true }, 200, origin);
  const contact = body.contact || {};
  const name = String(contact.name || body.name || "").trim().slice(0, 200);
  const phone = String(contact.phone || body.phone || "").trim().slice(0, 60);
  const email = String(contact.email || body.email || "").trim().slice(0, 200);
  if (!name) return json({ error: "name required" }, 400, origin);
  if (phone.replace(/\D/g, "").length < 10) return json({ error: "a 10-digit phone number is required" }, 400, origin);

  // Price what they had so far, purely as context for the call — same
  // server-side engine as a real quote, so the number the admin sees is the
  // number the designer was showing them.
  //
  // Only if they actually got somewhere. The pricing engine never throws: hand
  // it a garbage config, an empty object, or the untouched defaults and it
  // quietly prices a default 8x12 at about $5,000. So someone who stalled on
  // step 1 and accepted the offer of a call — having chosen nothing at all —
  // would show up in the admin list as "$5,034 so far", which reads as a build
  // in progress and is worse than showing nothing. stepIndex > 0 is the honest
  // signal: they moved through at least one step, so the config holds choices
  // they actually made.
  const engaged = Number.isFinite(body.stepIndex) && body.stepIndex > 0;
  let estimate = null;
  if (engaged && body.config) {
    try {
      const { result } = await computeQuoteResult(body.config, undefined, env);
      estimate = result.customer;
    } catch (e) {
      /* partial design — the lead matters, the estimate doesn't */
    }
  }

  const details = JSON.stringify({
    consult: true,
    bestTime: String(body.bestTime || "").slice(0, 120) || null,
    question: String(body.question || "").slice(0, 2000) || null,
    // Where they were when they asked — "stalled on step 1" and "got to
    // Review and hesitated" are very different sales calls.
    step: String(body.step || "").slice(0, 80) || null,
    stepIndex: Number.isFinite(body.stepIndex) ? body.stepIndex : null,
    trigger: body.trigger === "nudge" ? "nudge" : "button",
    // Same reason as the estimate above: the default config from an untouched
    // step 1 is not "their design", and summarising it in the admin as an
    // 8x12 gable would invent a preference they never expressed.
    config: (engaged && body.config) || null,
    permalink: body.permalink || null,
    estimateAtRequest: estimate,
    page: body.page || null
  }).slice(0, 20000);

  const customerId = await findOrCreateCustomer(env, { name, email, phone });

  // submissions.email is NOT NULL (every quote submission has always carried
  // one), so an email-less consult stores "" rather than null. The customers
  // row takes null happily, and findOrCreateCustomer's COALESCE keeps any
  // address we already had on file for them.
  await env.DB.prepare(
    "INSERT INTO submissions (customer_id, name, email, phone, details, status, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(customerId, name, email, phone, details, "new", new Date().toISOString())
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /admin/analytics: aggregated stats + geo points for the data dashboard ----
async function handleAnalytics(request, env, origin) {
  await ensureSubmissionWonColumn(env);
  await ensureSubmissionAdjustColumns(env);
  const { results } = await env.DB.prepare(
    "SELECT id, customer_id, details, status, created_at, won_at, price_adjustment, effective_price FROM submissions ORDER BY created_at DESC LIMIT 3000"
  ).all();

  // ---- install state of won jobs ----
  // Derived from the install log, not from a status anyone has to remember to
  // set. The dates are already recorded per order; asking for a second,
  // separate "installed" flag would mean two records of the same fact, free to
  // disagree — a job marked installed with no date, or a date logged against a
  // job still reading pending.
  //
  // The SHED install is what counts as done. A poured pad on its own is not a
  // delivered job, and treating it as one would report revenue as complete
  // while the building is still to come.
  await ensureInstallsTable(env);
  const { results: shedInstalls } = await env.DB.prepare(
    "SELECT submission_id, MAX(install_date) AS install_date FROM installs WHERE item = 'shed' GROUP BY submission_id"
  ).all();
  const shedInstallBy = {};
  (shedInstalls || []).forEach((r) => { shedInstallBy[r.submission_id] = r.install_date; });
  const todayISO = new Date().toISOString().slice(0, 10);

  const install = {
    installed: { count: 0, revenue: 0 },
    scheduled: { count: 0, revenue: 0 },
    unscheduled: { count: 0, revenue: 0 },
    nextDates: []
  };

  // ---- won jobs ----
  // Everything here is derived from what is genuinely stored. Revenue is the
  // quoted price of jobs marked won; cost is that job's own redline
  // trueTotalCost, which the pricing engine computed at submission — so the
  // margin is the real one, not a percentage assumption.
  // Discounts given, tracked separately so the effect on takings is visible
  // rather than just quietly absent from the revenue line.
  const adjustments = { total: 0, count: 0, wonTotal: 0, wonCount: 0 };
  const won = {
    count: 0, revenue: 0, cost: 0, costKnown: 0,
    byMonth: {}, byStyle: {}, bySize: {}, values: [],
    dated: 0, undated: 0, daysToWin: []
  };
  const lost = { count: 0, revenue: 0, byStyle: {} };

  const byDay = {};
  const statusCounts = {};
  const styleCounts = {};
  const sidingCounts = {};
  const points = [];
  const prices = [];
  const sizeCounts = {};
  const heardCounts = {};

  for (const row of results) {
    const day = (row.created_at || "").slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
    const status = row.status || "new";
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    let d = null;
    try {
      d = JSON.parse(row.details);
    } catch (e) {}
    if (d) {
      const config = d.config || {};
      if (config.style) styleCounts[config.style] = (styleCounts[config.style] || 0) + 1;
      if (config.siding) sidingCounts[config.siding] = (sidingCounts[config.siding] || 0) + 1;
      if (config.w && config.l) {
        const key = config.w + "x" + config.l;
        sizeCounts[key] = (sizeCounts[key] || 0) + 1;
      }
      if (d.heardAbout) {
        const key = d.heardAbout === "other" && d.heardAboutOther ? "other: " + d.heardAboutOther : d.heardAbout;
        heardCounts[key] = (heardCounts[key] || 0) + 1;
      }
      // Every figure below uses the price actually agreed — the quote plus any
      // adjustment made for this customer. Reporting won revenue at the
      // pre-discount number would overstate the takings, and worse, overstate
      // the margin: a discount comes straight out of profit, since the build
      // costs the same either way.
      const rawPrice = d.quotedPrice != null ? Number(d.quotedPrice) : null;
      // effective_price is written at save time by the adjustment endpoint,
      // which is the only place the comp/percent/amount arithmetic runs. Older
      // rows carrying a single signed price_adjustment still work.
      let price = null;
      if (row.effective_price != null && isFinite(Number(row.effective_price))) {
        price = Number(row.effective_price);
      } else if (rawPrice != null && isFinite(rawPrice)) {
        const legacy = row.price_adjustment != null ? Number(row.price_adjustment) : 0;
        price = rawPrice + (isFinite(legacy) ? legacy : 0);
      }
      const adjust = (price != null && rawPrice != null && isFinite(rawPrice)) ? price - rawPrice : 0;
      if (price != null && isFinite(price)) prices.push(price);
      if (adjust && isFinite(adjust)) {
        adjustments.total += adjust;
        adjustments.count++;
        if (status === "won") { adjustments.wonTotal += adjust; adjustments.wonCount++; }
      }

      if (status === "won") {
        won.count++;
        // Three states, because "pending" covers two situations that need
        // different things from you: one needs a date in the diary, the other
        // needs the crew to turn up.
        const shedDate = shedInstallBy[row.id];
        const bucket = !shedDate ? "unscheduled"
          : (String(shedDate).slice(0, 10) <= todayISO ? "installed" : "scheduled");
        install[bucket].count++;
        if (price != null && isFinite(price)) install[bucket].revenue += price;
        if (bucket === "scheduled") install.nextDates.push(String(shedDate).slice(0, 10));
        if (price != null && isFinite(price)) {
          won.revenue += price;
          won.values.push(price);
        }
        // trueTotalCost is this job's own costed build. Counted separately from
        // the job count so a margin is never reported over a mix of jobs that
        // had cost data and jobs that didn't.
        const tc = d.redline && d.redline.trueTotalCost;
        if (tc != null && isFinite(Number(tc))) {
          won.cost += Number(tc);
          won.costKnown++;
        }
        if (config.style) won.byStyle[config.style] = (won.byStyle[config.style] || 0) + 1;
        if (config.w && config.l) {
          const k = config.w + "x" + config.l;
          won.bySize[k] = (won.bySize[k] || 0) + 1;
        }
        // Grouped by the month it was WON where that's known. Rows won before
        // won_at existed are counted apart rather than dropped into the month
        // their quote arrived, which would be a different fact.
        if (row.won_at) {
          won.dated++;
          const m = String(row.won_at).slice(0, 7);
          won.byMonth[m] = (won.byMonth[m] || 0) + 1;
          if (row.created_at) {
            const days = Math.round((new Date(row.won_at) - new Date(row.created_at)) / 86400000);
            if (isFinite(days) && days >= 0) won.daysToWin.push(days);
          }
        } else {
          won.undated++;
        }
      } else if (status === "lost") {
        lost.count++;
        if (price != null && isFinite(price)) lost.revenue += price;
        if (config.style) lost.byStyle[config.style] = (lost.byStyle[config.style] || 0) + 1;
      }
      if (d.geo && d.geo.lat != null && d.geo.lng != null) {
        points.push({
          lat: d.geo.lat,
          lng: d.geo.lng,
          city: d.geo.city || null,
          region: d.geo.region || null,
          status,
          price
        });
      }
    }
  }

  prices.sort((a, b) => a - b);
  const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  const custRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first();
  // Superseded rows are earlier, never-actioned resubmissions from the same
  // customer — they stay in the DB for history but shouldn't inflate the
  // headline submission count.
  const activeSubmissionCount = results.filter((row) => row.status !== "superseded").length;

  // Collected across all customers. Deliberately NOT presented as "collected
  // against won jobs": payments are recorded per customer, not per submission,
  // so tying a payment to a specific job isn't something the data supports.
  await ensurePaymentsTable(env);
  const paidRow = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments").first();

  won.values.sort((a, b) => a - b);
  won.daysToWin.sort((a, b) => a - b);
  const decided = won.count + lost.count;
  const wonBlock = {
    count: won.count,
    revenue: Math.round(won.revenue),
    // Only over the jobs whose cost is actually known — see costKnown.
    cost: Math.round(won.cost),
    costKnown: won.costKnown,
    grossProfit: won.costKnown ? Math.round(won.revenue - won.cost) : null,
    marginPct: won.costKnown && won.revenue > 0
      ? Math.round(((won.revenue - won.cost) / won.revenue) * 1000) / 10
      : null,
    avgValue: won.values.length ? Math.round(won.revenue / won.values.length) : null,
    medianValue: won.values.length ? won.values[Math.floor(won.values.length / 2)] : null,
    // Of decided jobs only. Open ones haven't been lost, and counting them
    // against the rate would make a busy pipeline look like failure.
    winRatePct: decided ? Math.round((won.count / decided) * 1000) / 10 : null,
    decided,
    lostCount: lost.count,
    lostRevenue: Math.round(lost.revenue),
    byMonth: won.byMonth,
    byStyle: won.byStyle,
    bySize: won.bySize,
    lostByStyle: lost.byStyle,
    dated: won.dated,
    undated: won.undated,
    medianDaysToWin: won.daysToWin.length ? won.daysToWin[Math.floor(won.daysToWin.length / 2)] : null,
    collectedAllTime: Math.round(paidRow ? paidRow.total : 0),
    // Negative for discounts given. Shown so a thin margin can be traced to
    // what was given away rather than looking like a pricing problem.
    adjustedWonTotal: Math.round(adjustments.wonTotal),
    adjustedWonCount: adjustments.wonCount
  };

  install.nextDates.sort();
  const installBlock = {
    installed: { count: install.installed.count, revenue: Math.round(install.installed.revenue) },
    scheduled: { count: install.scheduled.count, revenue: Math.round(install.scheduled.revenue) },
    unscheduled: { count: install.unscheduled.count, revenue: Math.round(install.unscheduled.revenue) },
    // Everything won but not yet in the ground — the work still owed.
    pendingCount: install.scheduled.count + install.unscheduled.count,
    pendingRevenue: Math.round(install.scheduled.revenue + install.unscheduled.revenue),
    nextInstall: install.nextDates.length ? install.nextDates[0] : null
  };

  return json(
    {
      won: wonBlock,
      install: installBlock,
      totalSubmissions: activeSubmissionCount,
      totalCustomers: custRow ? custRow.n : 0,
      byDay,
      statusCounts,
      styleCounts,
      sidingCounts,
      sizeCounts,
      heardCounts,
      avgPrice,
      medianPrice,
      pricedCount: prices.length,
      points
    },
    200,
    origin
  );
}

// ---- /shed/pricing-config: the designer's full pricing engine snapshot ----
// GATED — this is the entire SELL/COST sheet (every price, every margin
// number). It used to be public ("every visitor's designer loads live
// prices on boot"), which was the actual hole: view-source hid nothing a
// competitor couldn't just fetch directly. Now the designer no longer has
// its own SELL/COST at all (see /shed/quote below, which computes off
// pricing.js server-side) so this endpoint has exactly one legitimate
// caller left — admin-pricing.html — and it's authenticated like every
// other admin route.
async function handleGetPricingConfig(request, env, origin) {
  /* Returns the shipped defaults with the owner's saved edits applied on top —
     the SAME combination /shed/quote prices from.
     It used to return the saved snapshot alone, which meant the dashboard only
     ever listed prices that existed on the day it was last saved. Anything
     added to pricing.js afterwards was charged by the quote engine and was
     invisible here: Shed Removal and Concrete Removal were being billed at
     $1,000 and $500 with no row to see them on, let alone change them. */
  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  let saved = {};
  if (row) {
    try { saved = JSON.parse(row.data); } catch (e) { saved = {}; }
  }
  return json(mergedPricingConfig(saved), 200, origin);
}

async function handleSavePricingConfig(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400, origin);
  const data = JSON.stringify(body).slice(0, 200000);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO pricing_config (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  )
    .bind(data, now)
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- /shed/quote: the ONLY place a price is computed. SELL/COST live in
// pricing.js, which never ships to a browser — this endpoint is how the
// designer gets a number instead. Loads the admin-edited pricing snapshot
// fresh on every call (D1 reads are cheap; a stale cached snapshot serving
// a price the admin just corrected would be worse) and applies it on top
// of pricing.js's hardcoded defaults before computing. ----
const SHED_STYLES = ["gable", "barn", "leanto", "hip", "3peak", "4peak"];
const SHED_SIDING = ["vertical", "horizontal", "board-batten", "pine"];
const SHED_ROOFTYPE = ["shingle", "metal"];
const SHED_OVTYPE = ["gable", "all4"];
const SHED_PORCHLOC = ["none", "front", "side"];
const SHED_FOUNDATION = ["blocks", "pad", "existing", "gravel"];
const SHED_FOUNDATION_FINISH = ["plain", "broom", "coated"];
// "standard" is deliberately absent — that tier was retired Sep 2026 and has
// no entry in pricing.js's ELEC_MAP any more. Leaving it here let an old
// permalink or a stale cached designer submit elec:"standard", which passed
// validation and then priced electrical at $0 because the map lookup missed:
// a quote that silently omitted $1,500 of work. Now it falls back to "none",
// so a retired tier reads as no electrical package rather than a free one.
const SHED_ELEC = ["none", "basic", "core", "essential"];
const SHED_INT_FINISH = ["none", "drywall", "painted"];
/* Flooring tiers. Anything else falls back to "none" rather than being priced
   — an unknown tier must cost nothing, not throw and not guess. That includes
   "good", a sealed-floor tier that was briefly here and was dropped because
   the Foundation step already sells sealing: a preview link saved while it
   existed prices as a Standard floor rather than as something we no longer
   offer. */
const SHED_FLOOR = ["none", "better", "best"];

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function enumOr(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}
function capArray(a, max) {
  return Array.isArray(a) ? a.slice(0, max) : [];
}
// Matches the designer's own sliders/pickers — see the wsteps markup in
// designer.html (width/length/height ranges) and the style/siding/etc.
// option lists. A request outside these isn't a build the designer could
// actually produce, so it's clamped rather than trusted.
function validateShedConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    style: enumOr(raw.style, SHED_STYLES, "gable"),
    w: clampNum(raw.w, 6, 20, 8),
    l: clampNum(raw.l, 6, 32, 12),
    h: clampNum(raw.h, 6, 12, 8),
    pitch: clampNum(raw.pitch, 3, 12, 6),
    siding: enumOr(raw.siding, SHED_SIDING, "vertical"),
    roofType: enumOr(raw.roofType, SHED_ROOFTYPE, "shingle"),
    ovType: enumOr(raw.ovType, SHED_OVTYPE, "gable"),
    ovh: clampNum(raw.ovh, 0, 24, 4),
    porchLoc: enumOr(raw.porchLoc, SHED_PORCHLOC, "none"),
    porchDepth: clampNum(raw.porchDepth, 0, 20, 0),
    porchTier: typeof raw.porchTier === "string" ? raw.porchTier.slice(0, 60) : "standard",
    dormerL: clampNum(raw.dormerL, 0, 12, 0),
    dormerR: clampNum(raw.dormerR, 0, 12, 0),
    foundation: enumOr(raw.foundation, SHED_FOUNDATION, "blocks"),
    foundationFinish: enumOr(raw.foundationFinish, SHED_FOUNDATION_FINISH, "plain"),
    loft: typeof raw.loft === "string" ? raw.loft.slice(0, 20) : "none",
    elec: enumOr(raw.elec, SHED_ELEC, "none"),
    intFinish: enumOr(raw.intFinish, SHED_INT_FINISH, "none"),
    floor: enumOr(raw.floor, SHED_FLOOR, "none"),
    addons: raw.addons && typeof raw.addons === "object" ? raw.addons : {},
    doors: capArray(raw.doors, 30),
    windows: capArray(raw.windows, 30),
    vents: capArray(raw.vents, 30),
    shelves: capArray(raw.shelves, 30)
  };
}

// The handful of prices the client needs a NUMBER for before the customer
// has finished a build — dormer width buttons, interior finish buttons,
// foundation finish buttons, and every window catalog tile — computed off
// the real (possibly admin-overridden) tables, so the client never needs
// SELL itself to render a label. Porch prices are the shed's own current
// width/length at the 'standard' depth ladder, plus every finish tier at
// whatever depth is currently selected (the two moments the porch page
// actually shows a price for).
function computeOptionPrices(cfg) {
  const encEat = cfg.style === "gable" && cfg.porchLoc !== "none" && cfg.porchDepth > 0
    ? (cfg.porchLoc === "front" ? { w: 0, l: cfg.porchDepth } : { w: cfg.porchDepth, l: 0 })
    : { w: 0, l: 0 };
  const encW = Math.max(6, cfg.w - encEat.w), encD = Math.max(6, cfg.l - encEat.l);

  const windows = Object.assign({}, SELL.windows);

  const interior = { drywall: interiorPrice("drywall", encW, encD), painted: interiorPrice("painted", encW, encD) };

  /* Flooring: the finished dollar amount for THIS shed, per tier, so the cards
     can show what the upgrade actually costs without the browser ever holding
     the $/sq ft rate — same treatment siding and wall height get. Enclosed
     area, so a porch deck is not billed as floor. */
  const flooring = {};
  SHED_FLOOR.forEach((t) => {
    flooring[t] = flooringPrice(t, encW * encD);
  });
  flooring.areaSqft = Math.round(encW * encD);

  const padSqft = Math.round(encW * encD);
  const foundationFinish = {
    plain: foundationFinishPrice("plain", 0),
    coated: foundationFinishPrice("coated", 0),
    broom: foundationFinishPrice("broom", padSqft)
  };

  // Depth buttons price at the shed's CURRENTLY selected finish tier (the
  // tier ladder itself is priced separately below, at the current depth) —
  // both pages read the same build, just holding a different dimension fixed.
  const curTier = cfg.porchTier || "standard";
  const maxPorchFront = Math.max(0, cfg.l - 6);
  const maxPorchSide = Math.max(0, cfg.w - 6);
  const frontDepths = {};
  [4, 6, 8].filter((ft) => ft <= maxPorchFront).forEach((ft) => {
    const line = porchLineFor("front", ft, curTier, cfg.w);
    if (line) frontDepths[ft] = line.price;
  });
  const sideDepths = {};
  [4, 6, 8].filter((ft) => ft <= maxPorchSide).forEach((ft) => {
    const line = porchLineFor("side", ft, "standard", cfg.l);
    if (line) sideDepths[ft] = line.price;
  });
  const frontTiers = {};
  if (cfg.porchLoc === "front" && cfg.porchDepth > 0) {
    Object.keys(SELL.porchFrontSqft).forEach((tier) => {
      const line = porchLineFor("front", cfg.porchDepth, tier, cfg.w);
      if (line) frontTiers[tier] = line.price;
    });
  }

  const wallHeight = {};
  Object.keys(SELL.wallHeight).forEach((h) => {
    const rate = SELL.wallHeight[h];
    wallHeight[h] = rate > 0 ? rate * wallAreaFt(cfg.w, cfg.l, Number(h)) : 0;
  });

  // Add-ons list (Upgrades step): flat items pass the SELL.options.flat price
  // straight through; per-sqft items are computed against THIS shed's own
  // floor/roof/wall area, same as wallHeight above — the client never gets
  // handed the $/sqft rate itself, only what it comes to for this build.
  const ADDON_FLAT_KEYS = {
    shutters: "Shutters", flowerboxes: "Flowerboxes", ridgeVent: "Roof Ridge Vent",
    skylight: "Skylight", stairs: "Stairs", statLadder: "Stationary Ladder",
    shedRemoval: "Shed Removal", concreteRemoval: "Concrete Removal",
    atticLadder: "Attic Pull-Down Ladder"
  };
  const ADDON_PERSQFT_KEYS = {
    weatherGuard: "Floor Weather Guard", radiantBarrier: "Radiant Roof Barrier",
    houseWrap: "House Wrap", hurricaneTies: "Hurricane Ties"
  };
  const addons = {};
  Object.keys(ADDON_FLAT_KEYS).forEach((k) => { addons[k] = SELL.options.flat[ADDON_FLAT_KEYS[k]] || 0; });
  Object.keys(ADDON_PERSQFT_KEYS).forEach((k) => {
    addons[k] = sellPerSqft(ADDON_PERSQFT_KEYS[k], cfg.w, cfg.l, cfg.h);
  });
  addons.cupola = {
    black: SELL.options.flat['Cupola 16" Black Roof'] || 0,
    copper: SELL.options.flat['Cupola 16" Copper Roof'] || 0
  };

  // Siding upcharge, computed against THIS shed's own wall area — the
  // client used to hardcode the $/sqft rates straight into the Siding
  // step's markup (a rate table baked into served HTML, worse than an
  // option price). Now it's a dollar amount per siding choice, like wallHeight.
  const siding = {};
  Object.keys(SELL.siding).forEach((k) => {
    const rate = SELL.siding[k];
    siding[k] = rate > 0 ? rate * wallAreaFt(cfg.w, cfg.l, cfg.h) : 0;
  });

  // Electrical tiers are flat (no size dependency). "Standard" is retired
  // from the designer's own tier list (ShedPro's real packages are now just
  // Basic/Core/Essential — see gallery page) but stays priceable in
  // pricing.js/SELL.electrical so an old permalink or stored quote with
  // elec:'standard' still prices correctly; it's just not offered here any
  // more, so there's no reason to hand the client a price for it.
  const ELEC_MAP = { basic: "Basic", core: "Core", essential: "Essential" };
  const electrical = {};
  Object.keys(ELEC_MAP).forEach((k) => { electrical[k] = SELL.electrical[ELEC_MAP[k]] || 0; });

  // Shelving: rate × length, capped to the wall it's on — same as
  // computePricing's own SHELVES block. One {16, 24} pair per placed shelf
  // (index-matched to cfg.shelves) so the depth picker can show what
  // switching depth would cost THIS shelf at its own current length,
  // without the client ever holding the $/ft rate itself.
  const shelfRate16 = SELL.options.perLinFt['16" Deep Shelving'] || 0;
  const shelfRate24 = SELL.options.perLinFt['24" Deep Shelving'] || 0;
  const shelving = (cfg.shelves || []).map((sd) => {
    const wallLen = (sd.wall === "front" || sd.wall === "back") ? cfg.w : cfg.l;
    const lenFt = Math.min(sd.len || wallLen, wallLen);
    return { 16: lenFt * shelfRate16, 24: lenFt * shelfRate24 };
  });

  return {
    dormers: Object.assign({}, SELL.dormers),
    windows: windows,
    doors: computeDoorPrices(),
    interior: interior,
    flooring: flooring,
    // 'gravel' isn't a flat SELL.foundation entry — it's tiered by THIS
    // shed's own footprint (gravelTiers), same as foundationFinish.broom
    // below is tiered by pad sqft. Computed fresh here so the tile always
    // shows what this exact build would actually be charged.
    foundation: Object.assign({}, SELL.foundation, { gravel: gravelFoundationPrice(padSqft) }),
    foundationFinish: foundationFinish,
    wallHeight: wallHeight,
    siding: siding,
    electrical: electrical,
    shelving: shelving,
    addons: addons,
    porch: { frontDepths: frontDepths, sideDepths: sideDepths, frontTiers: frontTiers }
  };
}

// Shared by /shed/quote and /shed/submit: validate the raw config, layer in
// whatever admin overrides are currently saved in D1, and price it. Both
// callers need the same "what would this build actually cost right now"
// answer — /shed/submit should never trust a client-supplied price or
// redline (the client can't compute either any more, and even if it could,
// a submitted quote's numbers need to be the real ones, not whatever the
// browser was told to send).
/* Layer the owner's saved pricing edits over the shipped defaults. Pulled out
   of computeQuoteResult because the read paths need it too: a quote being shown
   under current pricing has to use the same table a new quote would be priced
   from, or the dashboard's edits would apply to new quotes only. */
async function applySavedPricing(env) {
  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  if (!row) return;
  let saved;
  try {
    saved = JSON.parse(row.data);
  } catch (e) {
    saved = null;
  }
  if (saved) applyPricingOverrides(saved);
}

async function computeQuoteResult(rawConfig, overrides, env) {
  const cfg = validateShedConfig(rawConfig);

  await applySavedPricing(env);

  const opts = overrides && typeof overrides === "object" ? overrides : undefined;
  const result = computePricing(cfg, opts);
  return { cfg, result };
}

async function handleShedQuote(request, env, origin) {
  const body = await request.json().catch(() => ({}));

  const url = new URL(request.url);
  const wantsRedline = url.searchParams.get("redline") === "1";

  /* Overrides move the price. They are a STAFF lever (margin target, mileage,
     diesel), so they are honoured only for a caller who proves it — the auth
     check used to gate the redline RESPONSE while the overrides had already
     been applied to the total above it, which meant an unauthenticated caller
     could post overrides:{marginTarget:0} and be quoted well under the real
     price. Nothing about the request identifies staff except the token. */
  const staff = await requireAuth(request, env);
  const overrides = staff ? body.overrides : undefined;

  let cfg, result;
  try {
    ({ cfg, result } = await computeQuoteResult(body.config, overrides, env));
  } catch (e) {
    return json({ error: "Could not price this build" }, 400, origin);
  }

  if (wantsRedline) {
    if (!staff) return json({ error: "Unauthorized" }, 401, origin);
    return json({ total: result.customer, redline: result.redline }, 200, origin);
  }

  return json({ total: result.customer, optionPrices: computeOptionPrices(cfg) }, 200, origin);
}

// ---- /shed/design: short shareable links for a saved 3D design ----
// The designer used to build its own "share this design" link by encoding
// the ENTIRE config into the URL itself — every dimension, door, window,
// color, addon — which is why that link was enormous. This stores the
// config server-side under a short random code instead, so the link is just
// .../designer.html?d=<8 hex chars>. Works for ANY design, not only ones
// that have gone through /shed/submit — staff can hand a customer a link
// before they've filled out contact info at all.
// Lazily creates the table on first use — same reasoning as
// ensurePaymentsTable/ensureInstallsTable: avoids a manual D1 migration for
// a table that didn't exist when the DB was first set up.
async function ensureSavedDesignsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS saved_designs (
      code TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      created_at TEXT NOT NULL
    )`
  ).run();
}

// Random, not sequential — a saved design can carry the customer's name/
// email/phone (whatever the designer had on hand when it was saved), and a
// guessable code would let anyone page through other people's designs by
// incrementing it.
function randomDesignCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function handleSaveDesign(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.config) {
    return json({ error: "config required" }, 400, origin);
  }
  const config = JSON.stringify(body.config).slice(0, 40000);
  const contact = body.contact || {};
  const name = String(contact.name || "").slice(0, 200) || null;
  const email = String(contact.email || "").slice(0, 200) || null;
  const phone = String(contact.phone || "").slice(0, 60) || null;

  await ensureSavedDesignsTable(env);

  // Collisions are astronomically unlikely at 8 hex chars (32 bits) but cost
  // nothing to guard — retry a few times with a fresh code rather than
  // failing the save outright.
  let code = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomDesignCode();
    const existing = await env.DB.prepare("SELECT 1 FROM saved_designs WHERE code = ?").bind(candidate).first();
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) return json({ error: "Could not generate a code, try again" }, 500, origin);

  await env.DB.prepare(
    "INSERT INTO saved_designs (code, config, contact_name, contact_email, contact_phone, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(code, config, name, email, phone, new Date().toISOString())
    .run();

  return json({ code }, 200, origin);
}

async function handleGetDesign(request, env, origin, code) {
  await ensureSavedDesignsTable(env);
  const row = await env.DB.prepare("SELECT config FROM saved_designs WHERE code = ?").bind(code).first();
  if (!row) return json({ error: "Not found" }, 404, origin);
  let config;
  try {
    config = JSON.parse(row.config);
  } catch (e) {
    return json({ error: "Corrupt saved design" }, 500, origin);
  }
  return json({ config }, 200, origin);
}

// ============================================================================
// Potentia's own client CRM — /crm/*
//
// Separate from the /admin/* shed dashboard above in every way that matters:
// its own password, its own session scope, and — the part worth being loud
// about — its own DATABASE. Everything here reads and writes env.CRM_DB (the
// `potentia-crm` D1 database), never env.DB (`potentia-shed`, which belongs to
// the shed partner). Potentia's client list, revenue and notes are not rows in
// a client's database.
//
// That means every query below must use env.CRM_DB. A stray env.DB in this
// section would silently write Potentia's data into the shed's database, which
// is exactly what the split exists to prevent — worker/crm.test.mjs asserts the
// shed database ends up with none of these tables.
//
// Tables are created lazily on first use (same pattern as ensurePaymentsTable)
// so there's no migration to paste — worker/schema-crm.sql carries them too,
// for reference.
// ============================================================================

const CRM_STATUSES = ["lead", "contacted", "proposal", "building", "live", "paused", "lost"];
// Statuses that count as a paying client for MRR — a build in progress is
// already on its monthly plan, a paused or lost one is not.
const CRM_ACTIVE_STATUSES = ["building", "live"];
/* The packages a client can be on, and what a build of each one costs.

   `price` is the one-time build; `monthly` is the retainer that keeps the
   site hosted, patched and looked after. Both are INTERNAL. The public site quotes nothing — every plan on
   pricing.html says "Request Info", and the site's assistant is told in its
   system prompt never to state a figure. They live here, behind CRM auth,
   rather than in crm.html, because crm.html is a public file: anyone can read
   its source without logging in. Nothing that should not be on a billboard
   goes in a page.

   Written once here and served to the CRM pages, so a price change is one
   edit rather than a hunt through three files.

   The retired names stay in the list. A client who bought a 4-Page Gallery
   Site bought that, not a Tier 2, and rewriting their row would falsify the
   record of what they paid for. They are marked retired so the CRM can stop
   offering them for new work while still showing them on the clients who
   have one. */
/* `turnaround` is the build time, and it carries its CONDITION in the same
   string on purpose. "24-48 hours" on its own reads as a clock that starts
   when someone says yes; it starts when the last thing we are waiting on
   arrives, which for a gallery tier means the photos. Splitting the two into
   separate fields is how the condition gets dropped from one of the places
   this is rendered. null means quoted per job, not "no idea". */
const CRM_PACKAGE_LIST = [
  { key: "tier1", label: "Tier 1 — Home & Contact", price: 500, monthly: 20,
    turnaround: "As little as 24–48 hrs from completed form + payment" },
  { key: "tier2", label: "Tier 2 — Home, Gallery & Contact", price: 1200, monthly: 75,
    turnaround: "As little as 48–72 hrs from form, deposit + gallery photos" },
  { key: "tier3", label: "Tier 3 — Gallery + Scheduling", price: 1800, monthly: 150,
    turnaround: "As little as 48–72 hrs from form, deposit + gallery photos" },
  /* `from: true` means the figure is a FLOOR, not the price. A CRM build is
     scoped per business and starts here; quoting exactly 2000 because the box
     was filled in with 2000 is the mistake this flag exists to prevent, so
     the CRM says "from" next to it rather than showing it as a price. */
  { key: "crm", label: "Custom CRM", price: 2000, monthly: 250, from: true,
    turnaround: "Scoped per build" },
  { key: "platform", label: "Sales Platform", price: 5000, monthly: 350, from: true,
    seatsIncluded: 2, perSeat: 50, perSeatFrom: true,
    turnaround: "Scoped per build" },
  { key: "custom", label: "Custom", price: null, monthly: null },
  { key: "foundation", label: "Foundation", price: null, retired: true },
  { key: "booking", label: "Booking", price: null, retired: true },
  { key: "gallery", label: "Gallery", price: null, retired: true },
  { key: "operator", label: "Operator", price: null, retired: true }
];
const CRM_PACKAGES = [""].concat(CRM_PACKAGE_LIST.map((p) => p.key));
const CRM_SOURCES = ["", "website", "referral", "instagram", "facebook", "google", "outreach", "repeat", "other"];
const CRM_PAYMENT_METHODS = ["cash", "check", "venmo", "zelle", "card", "stripe", "paypal", "invoice", "other"];
// What a payment was for. Keeps a $150/mo retainer from being read as another
// build fee when totalling what a client has actually paid.
const CRM_PAYMENT_KINDS = ["build", "monthly", "addon", "other"];

let crmTablesReady = false;
async function ensureCrmTables(env) {
  if (crmTablesReady) return;
  await env.CRM_DB.batch([
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT,
        contact_name TEXT,
        email TEXT,
        phone TEXT,
        website_url TEXT,
        package TEXT,
        status TEXT NOT NULL DEFAULT 'lead',
        source TEXT,
        service TEXT,
        message TEXT,
        build_fee REAL,
        monthly_fee REAL,
        domain TEXT,
        domain_renews_at TEXT,
        launched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'build',
        note TEXT,
        paid_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_min REAL,
        notes TEXT,
        logged_by TEXT,
        called_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        due_date TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        created_at TEXT NOT NULL
      )`
    ),
    env.CRM_DB.prepare(
      /* The contractor intake sheet, kept whole as the JSON it arrived as.
         46 fields and growing, and most of them have nowhere to live on the
         clients row - flattening them into columns would mean a migration
         every time the form gains a question. Stored per submission rather
         than per client on purpose: a client who fills it in twice has
         changed their mind about something, and which answers came first is
         worth being able to see. */
      `CREATE TABLE IF NOT EXISTS client_intake (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    )
  ]);

  /* CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
     so anything added after the first deploy has to be an ALTER. D1 has no
     "ADD COLUMN IF NOT EXISTS" and a duplicate ADD throws, so read the table
     and add only what is missing. */
  for (const [table, cols] of [
    ["clients", [["owner", "TEXT"], ["owner_since", "TEXT"]]],
    ["client_calls", [["logged_by", "TEXT"]]]
  ]) {
    const have = await env.CRM_DB.prepare(`PRAGMA table_info(${table})`).all();
    const names = (have.results || []).map((r) => r.name);
    for (const [name, decl] of cols) {
      if (names.indexOf(name) === -1) {
        await env.CRM_DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`).run();
      }
    }
  }

  crmTablesReady = true;
}

function crmStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === "" ? null : s;
}
function crmMoney(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function crmEnum(v, allowed, fallback) {
  const s = v == null ? "" : String(v).toLowerCase().trim();
  return allowed.includes(s) ? s : fallback;
}
// Accepts a plain YYYY-MM-DD from a date input, and tolerates a full ISO
// timestamp by keeping just the date part. Anything else becomes null rather
// than a string that would sort strangely against the others.
function crmDate(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---- POST /crm/login ----
// CRM_PASSWORD only — deliberately no fall back to ADMIN_PASSWORD. The shed
// partner knows that one, and it must not open Potentia's client list. Until
// the secret is set this endpoint refuses every attempt, which is the safe
// direction to fail in: the CRM stays shut rather than quietly answering to
// the partner's password.
async function handleCrmLogin(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!env.CRM_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "CRM password not configured" }, 503, origin);
  }
  if (!timingSafeEqual(password, env.CRM_PASSWORD)) {
    return json({ error: "Invalid credentials" }, 401, origin);
  }
  const token = await signToken(env.ADMIN_SESSION_SECRET, { crm: true, exp: Date.now() + SESSION_TTL_MS });
  return json({ token }, 200, origin);
}

// ---- GET /crm/clients — the whole list plus the headline numbers ----
async function handleCrmListClients(request, env, origin) {
  await ensureCrmTables(env);
  const { results } = await env.CRM_DB.prepare(
    `SELECT c.*,
       (SELECT n.text FROM client_notes n WHERE n.client_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM client_notes n WHERE n.client_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at,
       (SELECT cl.called_at FROM client_calls cl WHERE cl.client_id = c.id ORDER BY cl.called_at DESC LIMIT 1) AS latest_call_at,
       (SELECT COUNT(*) FROM client_tasks t WHERE t.client_id = c.id AND t.done = 0) AS open_tasks,
       (SELECT MIN(t.due_date) FROM client_tasks t WHERE t.client_id = c.id AND t.done = 0 AND t.due_date IS NOT NULL) AS next_due,
       (SELECT COALESCE(SUM(p.amount), 0) FROM client_payments p WHERE p.client_id = c.id) AS collected
     FROM clients c
     ORDER BY c.updated_at DESC
     LIMIT 500`
  ).all();

  const activeList = CRM_ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");
  const mrrRow = await env.CRM_DB.prepare(
    `SELECT COALESCE(SUM(monthly_fee), 0) AS mrr, COUNT(*) AS active
     FROM clients WHERE status IN (${activeList}) AND monthly_fee IS NOT NULL`
  ).first();
  const activeRow = await env.CRM_DB.prepare(
    `SELECT COUNT(*) AS n FROM clients WHERE status IN (${activeList})`
  ).first();
  const leadRow = await env.CRM_DB.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'lead'").first();

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const collectedRow = await env.CRM_DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM client_payments WHERE paid_at >= ?"
  )
    .bind(cutoff)
    .first();

  return json(
    {
      clients: results,
      stats: {
        mrr: mrrRow ? mrrRow.mrr : 0,
        active_clients: activeRow ? activeRow.n : 0,
        open_leads: leadRow ? leadRow.n : 0,
        collected_30d: collectedRow ? collectedRow.total : 0
      }
    },
    200,
    origin
  );
}

// Field whitelist shared by create and update — anything not listed here can't
// be written from the browser, so a stray key in a POST body can't reach a
// column it has no business touching.
function crmClientFields(body) {
  return {
    business_name: crmStr(body.business_name, 160),
    contact_name: crmStr(body.contact_name, 120),
    email: crmStr(body.email, 200),
    phone: crmStr(body.phone, 40),
    website_url: crmStr(body.website_url, 300),
    package: crmEnum(body.package, CRM_PACKAGES, "") || null,
    status: crmEnum(body.status, CRM_STATUSES, "lead"),
    source: crmEnum(body.source, CRM_SOURCES, "") || null,
    service: crmStr(body.service, 120),
    message: crmStr(body.message, 5000),
    build_fee: crmMoney(body.build_fee),
    monthly_fee: crmMoney(body.monthly_fee),
    domain: crmStr(body.domain, 200),
    domain_renews_at: crmDate(body.domain_renews_at),
    launched_at: crmDate(body.launched_at)
  };
}
const CRM_CLIENT_COLUMNS = [
  "business_name", "contact_name", "email", "phone", "website_url", "package",
  "status", "source", "service", "message", "build_fee", "monthly_fee",
  "domain", "domain_renews_at", "launched_at"
];

// ---- POST /crm/clients ----
async function handleCrmCreateClient(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const f = crmClientFields(body);
  if (!f.business_name && !f.contact_name && !f.email) {
    return json({ error: "Give the client at least a name or an email" }, 400, origin);
  }
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients (${CRM_CLIENT_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES (${CRM_CLIENT_COLUMNS.map(() => "?").join(",")},?,?)`
  )
    .bind(...CRM_CLIENT_COLUMNS.map((k) => f[k]), now, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

// ---- GET /crm/clients/:id ----
async function handleCrmGetClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const client = await env.CRM_DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  if (!client) return json({ error: "Not found" }, 404, origin);

  const { results: notes } = await env.CRM_DB.prepare(
    "SELECT id, text, created_at FROM client_notes WHERE client_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();
  const { results: payments } = await env.CRM_DB.prepare(
    "SELECT id, amount, method, kind, note, paid_at, created_at FROM client_payments WHERE client_id = ? ORDER BY paid_at DESC, id DESC"
  )
    .bind(id)
    .all();
  // Open work first and by due date, because that's the order it gets done in;
  // finished items fall to the bottom as a record.
  const { results: tasks } = await env.CRM_DB.prepare(
    `SELECT id, title, due_date, done, done_at, created_at FROM client_tasks
     WHERE client_id = ?
     ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, id DESC`
  )
    .bind(id)
    .all();
  const { results: calls } = await env.CRM_DB.prepare(
    "SELECT id, direction, outcome, duration_min, notes, logged_by, called_at, created_at FROM client_calls WHERE client_id = ? ORDER BY called_at DESC, id DESC"
  )
    .bind(id)
    .all();

  return json({ client, notes, payments, tasks, calls }, 200, origin);
}

// ---- POST /crm/clients/:id — update (POST, not PATCH: the CORS allow-list
// above only advertises GET/POST/DELETE) ----
async function handleCrmUpdateClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404, origin);

  const body = await request.json().catch(() => ({}));
  // A status-only change (the dropdown on the list page) shouldn't have to
  // resend every other field and risk blanking them.
  if (Object.keys(body).length === 1 && typeof body.status === "string") {
    const status = crmEnum(body.status, CRM_STATUSES, null);
    if (!status) return json({ error: "Invalid status" }, 400, origin);
    await env.CRM_DB.prepare("UPDATE clients SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), id)
      .run();
    return json({ ok: true }, 200, origin);
  }

  const f = crmClientFields(body);
  await env.CRM_DB.prepare(
    `UPDATE clients SET ${CRM_CLIENT_COLUMNS.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`
  )
    .bind(...CRM_CLIENT_COLUMNS.map((k) => f[k]), new Date().toISOString(), id)
    .run();
  return json({ ok: true }, 200, origin);
}

// ---- DELETE /crm/clients/:id — removes the client and everything hanging off
// them. The UI makes you type the client's name first.
async function handleCrmDeleteClient(request, env, origin, id) {
  await ensureCrmTables(env);
  const existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404, origin);
  await env.CRM_DB.batch([
    env.CRM_DB.prepare("DELETE FROM client_notes WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_payments WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_tasks WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM client_calls WHERE client_id = ?").bind(id),
    env.CRM_DB.prepare("DELETE FROM clients WHERE id = ?").bind(id)
  ]);
  return json({ ok: true }, 200, origin);
}

// Every child write touches the parent's updated_at so the list page's
// "last activity" ordering reflects notes and payments, not just edits.
async function touchClient(env, id) {
  await env.CRM_DB.prepare("UPDATE clients SET updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

// ---- notes ----
async function handleCrmAddNote(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim().slice(0, 4000);
  if (!text) return json({ error: "text required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
    .bind(clientId, text, now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id, created_at: now }, 200, origin);
}
async function handleCrmDeleteNote(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_notes WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- payments ----
async function handleCrmAddPayment(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const method = crmEnum(body.method, CRM_PAYMENT_METHODS, null);
  const kind = crmEnum(body.kind, CRM_PAYMENT_KINDS, "build");
  const note = crmStr(body.note, 500);
  const paidAt = crmDate(body.paid_at) || new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "valid amount required" }, 400, origin);
  if (!method) return json({ error: "valid method required" }, 400, origin);

  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_payments (client_id, amount, method, kind, note, paid_at, created_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(clientId, Math.round(amount * 100) / 100, method, kind, note, paidAt, now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}
async function handleCrmDeletePayment(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_payments WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- tasks: the running list of edit requests / to-dos per client ----
async function handleCrmAddTask(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || "").trim().slice(0, 300);
  if (!title) return json({ error: "title required" }, 400, origin);
  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_tasks (client_id, title, due_date, done, done_at, created_at) VALUES (?,?,?,0,NULL,?)"
  )
    .bind(clientId, title, crmDate(body.due_date), now)
    .run();
  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}
async function handleCrmToggleTask(request, env, origin, id) {
  await ensureCrmTables(env);
  const task = await env.CRM_DB.prepare("SELECT id, client_id, done FROM client_tasks WHERE id = ?").bind(id).first();
  if (!task) return json({ error: "Not found" }, 404, origin);
  const body = await request.json().catch(() => ({}));
  const done = typeof body.done === "boolean" ? body.done : !task.done;
  await env.CRM_DB.prepare("UPDATE client_tasks SET done = ?, done_at = ? WHERE id = ?")
    .bind(done ? 1 : 0, done ? new Date().toISOString() : null, id)
    .run();
  await touchClient(env, task.client_id);
  return json({ ok: true, done: done }, 200, origin);
}
async function handleCrmDeleteTask(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_tasks WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}


// ---- GET /crm/analytics — Potentia's own won-clients data ----
// "Won" for an agency is a signed client, so it maps to the stages where work
// is actually happening or live. Paused and lost are excluded: a paused client
// was won once but isn't revenue now, and folding them in would flatter the
// numbers.
const CRM_WON_STATUSES = ["building", "live"];

async function handleCrmAnalytics(request, env, origin) {
  await ensureCrmTables(env);
  const { results: clients } = await env.CRM_DB.prepare(
    "SELECT id, status, source, package, build_fee, monthly_fee, launched_at, created_at FROM clients LIMIT 2000"
  ).all();
  const { results: payments } = await env.CRM_DB.prepare(
    "SELECT amount, kind, paid_at FROM client_payments LIMIT 5000"
  ).all();

  const byStatus = {};
  const wonBySource = {};
  const allBySource = {};
  const wonByPackage = {};
  const wonByMonth = {};
  const buildFees = [];
  let wonCount = 0, wonBuild = 0, mrr = 0, lostCount = 0;

  for (const c of clients) {
    const status = c.status || "lead";
    byStatus[status] = (byStatus[status] || 0) + 1;
    const source = c.source || "unknown";
    allBySource[source] = (allBySource[source] || 0) + 1;
    if (status === "lost") lostCount++;

    if (CRM_WON_STATUSES.indexOf(status) !== -1) {
      wonCount++;
      wonBySource[source] = (wonBySource[source] || 0) + 1;
      if (c.package) wonByPackage[c.package] = (wonByPackage[c.package] || 0) + 1;
      if (c.build_fee != null) { wonBuild += Number(c.build_fee); buildFees.push(Number(c.build_fee)); }
      if (c.monthly_fee != null) mrr += Number(c.monthly_fee);
      // Launch date is the closest thing to a "won on" date the CRM records.
      // Clients still building have none yet, so they are counted but not
      // placed on the timeline rather than being dated by their signup.
      if (c.launched_at) {
        const m = String(c.launched_at).slice(0, 7);
        wonByMonth[m] = (wonByMonth[m] || 0) + 1;
      }
    }
  }

  let collected = 0, collectedBuild = 0, collectedMonthly = 0;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let collected30 = 0;
  for (const p of payments) {
    const amt = Number(p.amount || 0);
    collected += amt;
    if (p.kind === "monthly") collectedMonthly += amt;
    if (p.kind === "build") collectedBuild += amt;
    if (String(p.paid_at || "") >= cutoff) collected30 += amt;
  }

  buildFees.sort((a, b) => a - b);
  const decided = wonCount + lostCount;

  return json(
    {
      totalClients: clients.length,
      byStatus,
      won: {
        count: wonCount,
        buildRevenue: Math.round(wonBuild),
        mrr: Math.round(mrr),
        // What the retainers are worth over a year, alongside the one-time
        // build work. The two are different kinds of money and are kept apart.
        annualisedRecurring: Math.round(mrr * 12),
        avgBuildFee: buildFees.length ? Math.round(wonBuild / buildFees.length) : null,
        medianBuildFee: buildFees.length ? buildFees[Math.floor(buildFees.length / 2)] : null,
        winRatePct: decided ? Math.round((wonCount / decided) * 1000) / 10 : null,
        decided,
        lostCount,
        bySource: wonBySource,
        allBySource,
        byPackage: wonByPackage,
        byMonth: wonByMonth,
        // Build fee agreed vs build money actually in the bank.
        buildOutstanding: Math.round(Math.max(0, wonBuild - collectedBuild))
      },
      collected: {
        allTime: Math.round(collected),
        build: Math.round(collectedBuild),
        monthly: Math.round(collectedMonthly),
        last30: Math.round(collected30)
      }
    },
    200,
    origin
  );
}

// ---- client call log ----
// Same shape as the shed side's calls table, logged by hand for the same
// reason: what was said and what happens next is the part worth keeping, and
// no phone system knows it.
async function handleCrmAddCall(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const direction = crmEnum(body.direction, CALL_DIRECTIONS, null);
  const outcome = crmEnum(body.outcome, CALL_OUTCOMES, null);
  if (!direction) return json({ error: "valid direction required" }, 400, origin);
  if (!outcome) return json({ error: "valid outcome required" }, 400, origin);

  const durationRaw = Number(body.duration_min);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 600) : null;
  const notes = crmStr(body.notes, 2000);
  const loggedBy = crmStr(body.logged_by, 60);
  const calledAt = body.called_at ? String(body.called_at).slice(0, 40) : new Date().toISOString();

  const now = new Date().toISOString();
  const res = await env.CRM_DB.prepare(
    "INSERT INTO client_calls (client_id, direction, outcome, duration_min, notes, logged_by, called_at, created_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(clientId, direction, outcome, duration, notes, loggedBy, calledAt, now)
    .run();

  /* Whoever gets the customer on the phone owns the lead. Voicemail and
     no-answer are not contact — you can leave five of those and have spoken
     to nobody — so they claim nothing. And it is FIRST contact: this only
     ever writes into an empty owner, so a later caller opening the record
     cannot take a lead off the person who actually earned it. */
  const claimed = await claimLead(env, clientId, loggedBy, outcome);

  await touchClient(env, clientId);
  return json({ ok: true, id: res.meta.last_row_id, claimed_by: claimed }, 200, origin);
}

const CONTACT_OUTCOMES = ["connected", "callback"];

async function claimLead(env, clientId, loggedBy, outcome) {
  if (!loggedBy || CONTACT_OUTCOMES.indexOf(outcome) === -1) return null;
  const res = await env.CRM_DB.prepare(
    `UPDATE clients SET owner = ?, owner_since = ?
      WHERE id = ? AND (owner IS NULL OR owner = '')`
  ).bind(loggedBy, new Date().toISOString(), clientId).run();
  return res && res.meta && res.meta.changes ? loggedBy : null;
}

async function handleCrmDeleteCall(request, env, origin, id) {
  await ensureCrmTables(env);
  await env.CRM_DB.prepare("DELETE FROM client_calls WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, origin);
}

// ---- POST /crm/lead — public. The contact form posts here alongside its
// existing Formspree submit, so an inquiry becomes a CRM lead on its own.
// An inquiry from someone already in the CRM is logged as a note on their
// record instead of creating a second one.
async function handleCrmLead(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const name = crmStr(body.name, 120);
  const email = crmStr(body.email, 200);
  const phone = crmStr(body.phone, 40);
  const service = crmStr(body.service, 120);
  const message = crmStr(body.message, 5000);
  if (!email && !phone) return json({ error: "email or phone required" }, 400, origin);

  const now = new Date().toISOString();
  let existing = null;
  if (email) existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE email = ? LIMIT 1").bind(email).first();
  if (!existing && phone) {
    existing = await env.CRM_DB.prepare("SELECT id FROM clients WHERE phone = ? LIMIT 1").bind(phone).first();
  }

  if (existing) {
    const parts = ["New website inquiry"];
    if (service) parts.push("Interested in: " + service);
    if (message) parts.push(message);
    await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
      .bind(existing.id, parts.join(" — "), now)
      .run();
    await touchClient(env, existing.id);
    return json({ ok: true, id: existing.id, existing: true }, 200, origin);
  }

  const res = await env.CRM_DB.prepare(
    `INSERT INTO clients (business_name, contact_name, email, phone, status, source, service, message, created_at, updated_at)
     VALUES (?,?,?,?,'lead','website',?,?,?,?)`
  )
    .bind(name, name, email, phone, service, message, now, now)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

/* Phone matching has to survive how people actually type a number. The CRM
   holds whatever was typed the first time - "(801) 555-0148", "801-555-0148",
   "8015550148" are all the same person and none of them are string-equal.
   Compared on the last 10 digits so a leading 1 or a +1 does not break it. */
function crmPhoneKey(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/* Find the client an intake belongs to, by email first and phone second.
   Email is the stronger signal: a phone gets reused between a business and its
   owner far more often than an address does. Returns null for a new client. */
async function findClientByContact(env, email, phone) {
  if (email) {
    const hit = await env.CRM_DB.prepare(
      "SELECT * FROM clients WHERE lower(email) = lower(?) LIMIT 1"
    ).bind(email).first();
    if (hit) return hit;
  }
  const key = crmPhoneKey(phone);
  if (!key) return null;
  /* No phone_key column to index, so the normalising happens here over the
     rows that have a phone at all. The client list is hundreds, not millions;
     when that stops being true this wants a stored key. */
  const { results } = await env.CRM_DB.prepare(
    "SELECT * FROM clients WHERE phone IS NOT NULL AND phone != ''"
  ).all();
  for (const row of results || []) {
    if (crmPhoneKey(row.phone) === key) return row;
  }
  return null;
}

/* A readable summary for the note that goes on the client's timeline. The
   whole sheet is kept in client_intake either way - this is so someone
   scanning the record sees what arrived without opening anything. */
function intakeSummary(body) {
  const trades = []
    .concat(body.trade || [], body.other_trade ? [body.other_trade] : [])
    .filter(Boolean);
  const bits = ["Contractor intake sheet received"];
  if (body.business_name) bits.push(String(body.business_name));
  if (trades.length) bits.push("Trades: " + trades.join(", "));
  if (body.service_area) bits.push("Service area: " + String(body.service_area));
  return bits.join(" \u2014 ").slice(0, 2000);
}

/* ---- POST /crm/intake — public. The contractor intake sheet posts here
   alongside its Formspree submit, the same way the contact form does.

   Matching an existing client on email or phone is the point: someone who
   enquired months ago and is now onboarding is the SAME record, and a second
   row for them is how a CRM starts lying about how many clients there are.

   Nothing on an existing client is ever overwritten. Blank fields get filled
   in - a record with no business name gains one - but anything already there,
   typed by staff or arrived earlier, wins. Status is never touched at all:
   whatever stage they are at is a decision someone made, and an intake form
   is not evidence it changed. */
async function handleCrmIntake(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));

  const email = crmStr(body.email, 200);
  const phone = crmStr(body.phone, 40);
  if (!email && !phone) return json({ error: "email or phone required" }, 400, origin);

  const business = crmStr(body.business_name, 200);
  const owner = crmStr(body.owner_name, 120);
  const now = new Date().toISOString();
  const payload = JSON.stringify(body).slice(0, 60000);

  let client = await findClientByContact(env, email, phone);
  let created = false;

  if (!client) {
    const trades = [].concat(body.trade || []).filter(Boolean).join(", ");
    /* status 'building'. The form is unlisted and noindexed - the only way to
       reach it is a link someone was sent, which is a far stronger signal than
       a nav item anyone could wander into. Someone who was sent this sheet and
       filled it in is a client whose build is starting, not a cold enquiry, and
       landing them at 'lead' would mean moving every one of them by hand.
       It was 'lead' while the form sat in the public nav; that reason went away
       when the link did. */
    const res = await env.CRM_DB.prepare(
      `INSERT INTO clients (business_name, contact_name, email, phone, status, source, service, message, created_at, updated_at)
       VALUES (?,?,?,?,'building','intake',?,?,?,?)`
    ).bind(business || owner || null, owner || null, email || null, phone || null,
           crmStr(trades, 200) || null, crmStr(body.story, 5000) || null, now, now).run();
    client = { id: res.meta.last_row_id };
    created = true;
  } else {
    /* Fill the gaps, never the answers. COALESCE(NULLIF(col,''), ?) keeps a
       value that is already there and takes the new one only when the column
       is null or empty. */
    await env.CRM_DB.prepare(
      `UPDATE clients SET
         business_name = COALESCE(NULLIF(business_name,''), ?),
         contact_name  = COALESCE(NULLIF(contact_name,''),  ?),
         email         = COALESCE(NULLIF(email,''),         ?),
         phone         = COALESCE(NULLIF(phone,''),         ?),
         updated_at    = ?
       WHERE id = ?`
    ).bind(business || null, owner || null, email || null, phone || null, now, client.id).run();
  }

  await env.CRM_DB.batch([
    env.CRM_DB.prepare("INSERT INTO client_intake (client_id, payload, created_at) VALUES (?,?,?)")
      .bind(client.id, payload, now),
    env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
      .bind(client.id, intakeSummary(body), now)
  ]);

  return json({ ok: true, id: client.id, created: created }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      /* Which build is actually live. Public, read-only, and deliberately
         tiny: the worker ships by pasting a bundle into the Cloudflare
         dashboard, so without this there is no way to tell a paste that landed
         from one that never happened - and a stale worker is indistinguishable
         from a bug in the code. Carries no data about the business.
         WORKER_BUILD is injected by build-bundle.mjs; running index.js
         unbundled has no stamp, hence the typeof guard. */
      if (path === "/version" && request.method === "GET") {
        return json({
          build: (typeof WORKER_BUILD !== "undefined") ? WORKER_BUILD : "unbundled",
          builtAt: (typeof WORKER_BUILT_AT !== "undefined") ? WORKER_BUILT_AT : null
        }, 200, origin);
      }

      if (path === "/chat" && request.method === "POST") {
        // The only endpoint here that spends money per call. 30/hour is far
        // more than a visitor asking about shed sizes will ever use, and far
        // less than a script needs to run up a bill.
        {
          const rl = await rateLimit(request, env, "chat", 30, 3600);
          if (!rl.ok) return tooMany(rl.retryAfter, origin);
        }
        return await handleChat(request, env, origin);
      }

      if (path === "/admin/login" && request.method === "POST") {
        return await handleAdminLogin(request, env, origin);
      }

      if (path === "/admin/customers" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleListCustomers(request, env, origin);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/notes") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/notes".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddNote(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/followup") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/followup".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetFollowUp(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/calls") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/calls".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddCall(request, env, origin, id);
      }
      if (path.startsWith("/admin/calls/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/calls/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteCall(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/payments") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length, -"/payments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddPayment(request, env, origin, id);
      }
      if (path.startsWith("/admin/payments/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/payments/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeletePayment(request, env, origin, id);
      }
      if (path.startsWith("/admin/submissions/") && path.endsWith("/installs") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/installs".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleAddInstall(request, env, origin, id);
      }
      if (path.startsWith("/admin/installs/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/installs/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteInstall(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetCustomer(request, env, origin, id);
      }
      if (path.startsWith("/admin/customers/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/customers/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeleteCustomer(request, env, origin, id);
      }

      if (path.startsWith("/admin/submissions/") && path.endsWith("/adjustments") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/adjustments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetAdjustments(request, env, origin, id);
      }
      if (path.startsWith("/admin/submissions/") && path.endsWith("/adjustment") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length, -"/adjustment".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleSetAdjustment(request, env, origin, id);
      }
      if (path === "/admin/submissions/status" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleUpdateSubmissionStatus(request, env, origin);
      }
      if (path === "/admin/submissions/cleanup-superseded" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCleanupSuperseded(request, env, origin);
      }
      if (path === "/admin/submissions/regeocode" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleRegeocodeSubmissions(request, env, origin);
      }
      if (path === "/admin/submissions/backfill-redline" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleBackfillQuoteRedline(request, env, origin);
      }
      if (path.startsWith("/admin/submissions/") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/submissions/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleGetSubmission(request, env, origin, id);
      }

      if (path === "/admin/analytics" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleAnalytics(request, env, origin);
      }

      if (path === "/admin/pricing" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleListPricing(request, env, origin);
      }
      if (path === "/admin/pricing" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleUpsertPricing(request, env, origin);
      }
      if (path.startsWith("/admin/pricing/") && request.method === "DELETE") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/admin/pricing/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleDeletePricing(request, env, origin, id);
      }

      // ---- Potentia client CRM ----
      // Every CRM route but login needs the CRM's own database. Failing here
      // with a clear message beats a confusing "no such table" from D1 if the
      // binding was missed during setup.
      if (path.startsWith("/crm/") && path !== "/crm/login" && !env.CRM_DB) {
        return json({ error: "CRM database not connected" }, 503, origin);
      }
      if (path === "/crm/login" && request.method === "POST") {
        return await handleCrmLogin(request, env, origin);
      }
      if (path === "/crm/intake" && request.method === "POST") {
        /* Tighter than the contact form's limit: an onboarding sheet is filled
           in once, not repeatedly, and it writes three rows per call. */
        const rl = await rateLimit(request, env, "intake", 20, 3600);
        if (!rl.ok) return tooMany(rl.retryAfter, origin);
        return await handleCrmIntake(request, env, origin);
      }

      if (path === "/crm/lead" && request.method === "POST") {
        return await handleCrmLead(request, env, origin);
      }
      /* Manual trigger for testing. Admin-gated and capped the same as the
         cron path — ?dry=1 sources and dedupes without spending on AI. */
      if (path === "/crm/leads/run-now" && request.method === "POST") {
        const gate = await leadsGate(request, env);
        if (gate) return json({ error: gate.error }, gate.status, origin);
        /* Only pass a limit if the caller actually named one — otherwise the
           pipeline's own default applies. This used to hardcode 5 here as
           well, which quietly overrode it. */
        const limitParam = Number(url.searchParams.get("limit"));
        const limit = isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
        const dryRun = url.searchParams.get("dry") === "1";
        // ?reseed=1 replaces the search grid from the code's own defaults —
        // needed after changing which segments or cities ship, since the grid
        // is otherwise only ever written once. Drops manual enables with it.
        const reseed = url.searchParams.get("reseed") === "1";
        /* ?rescreen=1 clears the businesses screened out on the free fields,
           so a changed rating or review cut-off is applied to everything
           already seen rather than only to what turns up next. */
        const rescreen = url.searchParams.get("rescreen") === "1";

        /* Streamed, not awaited. A real run researches five businesses one
           after another and routinely takes several minutes; Cloudflare cuts
           off any request that has sent nothing for 100 seconds, which killed
           the run halfway and showed the page a spinner that never ended.
           Sending the first byte immediately keeps the connection open for as
           long as the run needs, and turns the wait into visible progress.

           One NDJSON object per line: {event:"researching",...} as it goes,
           then a final {event:"done", result:{...}} with the same payload the
           endpoint used to return. */
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        let gone = false;
        const emit = async (evt) => {
          if (gone) return;
          try { await writer.write(enc.encode(JSON.stringify(evt) + "\n")); }
          catch (e) { gone = true; }
        };

        // Floating on purpose: the open response body is what keeps the
        // Worker alive, and awaiting it here would defeat the streaming.
        (async () => {
          try {
            const out = await runLeadPipeline(env, {
              trigger: "manual", limit, dryRun, reseed, rescreen, onProgress: emit
            });
            await emit({ event: "done", result: out });
          } catch (e) {
            await emit({ event: "error", error: String(e).slice(0, 300) });
          }
          try { await writer.close(); } catch (e) { /* client already gone */ }
        })();

        return new Response(readable, {
          status: 200,
          headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no"   // no proxy in front should buffer this
          }
        });
      }
      if (path === "/crm/leads/segments" && request.method === "GET") {
        const gate = await leadsGate(request, env);
        if (gate) return json({ error: gate.error }, gate.status, origin);
        await ensureLeadPipelineTables(env);
        // Seed on first read so the toggles are never an empty list.
        await seedLeadSources(env, false);
        /* trades maps every search term the grid can produce to the name the
           CRM shows for it, so the sub-categories on offer are the ones the
           pipeline can actually generate. */
        return json({ segments: await listSegments(env), trades: tradeLabels() }, 200, origin);
      }
      if (path === "/crm/leads/segments" && request.method === "POST") {
        const gate = await leadsGate(request, env);
        if (gate) return json({ error: gate.error }, gate.status, origin);
        await ensureLeadPipelineTables(env);
        const body = await request.json().catch(() => ({}));
        try {
          const changed = await setSegmentEnabled(env, body.segment, !!body.enabled);
          return json({ ok: true, changed, segments: await listSegments(env),
                        trades: tradeLabels() }, 200, origin);
        } catch (e) {
          return json({ error: String(e.message || e) }, 400, origin);
        }
      }
      if (path === "/crm/leads/recheck" && request.method === "POST") {
        const gate = await leadsGate(request, env);
        if (gate) return json({ error: gate.error }, gate.status, origin);

        /* Streamed like a run, and for the same reason: each site is a fresh
           speed test and fifty of them is well past the 100 seconds Cloudflare
           will hold a silent request open. */
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        let gone = false;
        const emit = async (evt) => {
          if (gone) return;
          try { await writer.write(enc.encode(JSON.stringify(evt) + "\n")); }
          catch (e) { gone = true; }
        };

        (async () => {
          try {
            /* Both: recheckLeads reads client_calls, which belongs to the CRM
               tables rather than the pipeline's. */
            await ensureCrmTables(env);
            const out = await recheckLeads(env, {
              limit: Number(url.searchParams.get("limit")) || undefined,
              onProgress: emit
            });
            await emit({ event: "done", result: out });
          } catch (e) {
            await emit({ event: "error", error: String(e).slice(0, 300) });
          }
          try { await writer.close(); } catch (e) { /* client already gone */ }
        })();

        return new Response(readable, {
          status: 200,
          headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no"
          }
        });
      }
      if (path === "/crm/leads/runs" && request.method === "GET") {
        const gate = await leadsGate(request, env);
        if (gate) return json({ error: gate.error }, gate.status, origin);
        await ensureLeadPipelineTables(env);
        const rows = await env.CRM_DB.prepare(
          "SELECT * FROM enrichment_runs ORDER BY id DESC LIMIT 30"
        ).all();
        return json({ runs: rows.results || [] }, 200, origin);
      }
      if (path === "/crm/packages" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        /* Behind CRM auth because it carries the build prices, which are not
           public. The labels alone would be harmless; the prices are why this
           is an endpoint and not a constant in the page. */
        return json({ packages: CRM_PACKAGE_LIST }, 200, origin);
      }
      if (path === "/crm/segment-names" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        /* Names only, and deliberately not behind the generator's lock: what a
           category is CALLED is how leads read in the list, and a caller never
           unlocks the generator. The counts and the toggles stay locked.

           Served rather than duplicated in the page, so "Home Services" is
           written once. */
        return json({
          segments: SEGMENTS.map((s) => ({ key: s.key, label: s.label })),
          trades: tradeLabels()
        }, 200, origin);
      }
      if (path === "/crm/leads/unlock" && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const secret = leadsPassword(env);
        if (!secret || !env.ADMIN_SESSION_SECRET) {
          return json({ error: "No lead generator password is set. Add LEADS_PASSWORD as a secret on the Worker." }, 503, origin);
        }
        const body = await request.json().catch(() => ({}));
        const given = typeof body.password === "string" ? body.password : "";
        if (!timingSafeEqual(given, secret)) {
          return json({ error: "Wrong password" }, 401, origin);
        }
        const unlock = await signToken(env.ADMIN_SESSION_SECRET,
          { leads: true, exp: Date.now() + SESSION_TTL_MS });
        return json({ ok: true, unlock }, 200, origin);
      }
      if (path === "/crm/callers" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        await ensureCrmTables(env);
        /* The people on the phones, from CRM_CALLERS (comma-separated) so the
           roster changes without a deploy. Names already in the call log are
           merged in so history never loses an owner who has since left the
           list. */
        const roster = String(env.CRM_CALLERS || DEFAULT_CALLERS)
          .split(",").map((n) => n.trim()).filter(Boolean);
        const rows = await env.CRM_DB.prepare(
          `SELECT logged_by AS name, COUNT(*) AS calls FROM client_calls
            WHERE logged_by IS NOT NULL AND logged_by != ''
            GROUP BY logged_by ORDER BY calls DESC LIMIT 50`
        ).all();
        const owners = await env.CRM_DB.prepare(
          "SELECT owner AS name, COUNT(*) AS leads FROM clients WHERE owner IS NOT NULL AND owner != '' GROUP BY owner"
        ).all();
        const seen = {};
        for (const n of roster) seen[n] = true;
        for (const r of rows.results || []) seen[r.name] = true;
        for (const r of owners.results || []) seen[r.name] = true;
        return json({ callers: Object.keys(seen).sort(), roster }, 200, origin);
      }
      if (path === "/crm/analytics" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmAnalytics(request, env, origin);
      }
      if (path === "/crm/clients" && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmListClients(request, env, origin);
      }
      if (path === "/crm/clients" && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCrmCreateClient(request, env, origin);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/notes") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/notes".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddNote(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/payments") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/payments".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddPayment(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/calls") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/calls".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddCall(request, env, origin, id);
      }
      if (path.startsWith("/crm/calls/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/calls/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteCall(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && path.endsWith("/tasks") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length, -"/tasks".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmAddTask(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmGetClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmUpdateClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/clients/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/clients/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteClient(request, env, origin, id);
      }
      if (path.startsWith("/crm/notes/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/notes/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteNote(request, env, origin, id);
      }
      if (path.startsWith("/crm/payments/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/payments/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeletePayment(request, env, origin, id);
      }
      if (path.startsWith("/crm/tasks/") && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/tasks/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmToggleTask(request, env, origin, id);
      }
      if (path.startsWith("/crm/tasks/") && request.method === "DELETE") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const id = Number(path.slice("/crm/tasks/".length));
        if (!id) return json({ error: "Invalid id" }, 400, origin);
        return await handleCrmDeleteTask(request, env, origin, id);
      }

      if (path === "/shed/pricing" && request.method === "GET") {
        return await handlePublicPricing(request, env, origin);
      }
      // A real customer submits once, maybe three times across an evening of
      // revisions. Ten an hour leaves room for a family arguing over colours
      // without leaving room for a flood — and each one of these carries R2
      // uploads and a geocoding call.
      if (path === "/shed/submit" && request.method === "POST") {
        const rl = await rateLimit(request, env, "submit", 10, 3600);
        if (!rl.ok) return tooMany(rl.retryAfter, origin);
        return await handleShedSubmit(request, env, origin);
      }
      if (path === "/shed/consult" && request.method === "POST") {
        const rl = await rateLimit(request, env, "consult", 10, 3600);
        if (!rl.ok) return tooMany(rl.retryAfter, origin);
        return await handleShedConsult(request, env, origin);
      }
      if (path === "/shed/pricing-config" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleGetPricingConfig(request, env, origin);
      }
      if (path === "/shed/pricing-config" && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleSavePricingConfig(request, env, origin);
      }
      if (path === "/shed/quote" && request.method === "POST") {
        // Deliberately generous. The designer re-prices on every single change
        // — size, colour, each window — so an hour of genuine designing is
        // easily several hundred calls. This endpoint only burns CPU: no
        // writes, no uploads, no API spend. The ceiling is here to stop a
        // runaway loop, not to ration customers.
        const rl = await rateLimit(request, env, "quote", 900, 3600);
        if (!rl.ok) return tooMany(rl.retryAfter, origin);
        return await handleShedQuote(request, env, origin);
      }
      if (path === "/shed/design" && request.method === "POST") {
        // Saved once per quote submission, plus whenever someone shares a
        // build. 40/hour covers heavy use and caps junk rows.
        const rl = await rateLimit(request, env, "design", 40, 3600);
        if (!rl.ok) return tooMany(rl.retryAfter, origin);
        return await handleSaveDesign(request, env, origin);
      }
      if (path.startsWith("/shed/design/") && request.method === "GET") {
        const code = path.slice("/shed/design/".length);
        if (!code) return json({ error: "Invalid code" }, 400, origin);
        return await handleGetDesign(request, env, origin, code);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Server error", detail: String(e) }, 500, origin);
    }
  },

  /* Cron Triggers. Schedule this at an interval of an hour or MORE: Cloudflare
     gives a scheduled handler 30s of CPU below an hour and 15 minutes at an
     hour or above, and this run makes several slow AI calls. Waiting on fetch()
     is not CPU time, so the work fits comfortably in the 15-minute tier and
     would be tight in the 30-second one.

     Wrapped in waitUntil so the run is not cut short when the handler returns,
     and swallowed on error — a failed run is already recorded in
     enrichment_runs, and throwing here just retries the whole thing. */
  async scheduled(event, env, ctx) {
    if (!env.CRM_DB || !env.GOOGLE_PLACES_API_KEY) return;
    ctx.waitUntil(
      runLeadPipeline(env, { trigger: "cron" }).catch(() => {})
    );
  }
};
