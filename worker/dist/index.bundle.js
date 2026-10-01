// Build stamp, written by build-bundle.mjs. Read it back from GET /version.
const WORKER_BUILD = "3a92c05";
const WORKER_BUILT_AT = "2026-10-01T19:49:56.301Z";

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
    PORCH_LOC='none', SIDE_PORCH=0, PORCH_TIER='standard', PORCH_DECK='pt',
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
  if(cfg.porchDeck!=null) PORCH_DECK=cfg.porchDeck;
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
  PORCH_LOC='none'; SIDE_PORCH=0; PORCH_TIER='standard'; PORCH_DECK='pt';
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
    /* The cedar SINGLE is the same product as the double — same cedar leaf,
       same rails and stiles, same transom lites and cedar casing — with one
       leaf instead of two. Priced as its own pair of entries rather than as
       a fraction of a double: the casing, transom and hardware cost the same
       whatever the leaf count, so half the width is nowhere near half the
       price — $500 and $600 against the 5' double's $700, ShedPro's own
       numbers. Admin \u2192 Pricing \u2192 Doors overrides this table if they move. */
    "3' Cedar Single": 500, "3'6\" Cedar Single": 600,
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

  /* ── PORCH DECKING (upcharge, per sqft of porch) ──
     This is where the porch upgrade money lives now. It used to live in the
     porchFrontSqft finish tiers, which ran to $35/sqft and were invisible:
     nothing in the designer's 3D read PORCH_TIER, so a customer picking
     "Posts, Beams & Composite Floor" saw the identical shed and a price
     $1,900 higher on a 72 sqft porch. Meanwhile PORCH_DECK — pressure-treated
     against composite — did change the 3D, was sent up with every config, and
     was never priced at all. The page charged for the invisible choice and
     gave away the visible one.

     So the charge moved onto the control the customer can see. The rate is
     derived from what the old tier table already implied composite flooring
     was worth: Wood Floor Awning 15 -> Composite Awning 25 is +$10/sqft, and
     Posts & Beam Finished Ceiling 28 -> Posts Beams & Composite Floor 35 is
     +$7. This sits between them. It is an editable override like every other
     rate here, so it can be moved without a deploy.

     'pt' is 0 because the standard porch rate already includes a
     pressure-treated floor. 'none' is also 0 rather than a credit — a
     deckless porch is not currently discounted, and making it one would be a
     price cut nobody asked for. Worth revisiting: the standard rate is
     charging for a floor that is not being built. */
  porchDeckSqft: { "none": 0, "pt": 0, "composite": 8.50 },

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
    "24x48 Insulated": 45, "Transom 87x10": 200,

    /* PREMIUM \u2014 ShedPro's own numbers, replacing the placeholders these
       shipped with. Same four sizes for both products, so the two ladders read
       against each other: the lift-up is the dearer of the two at every size,
       by roughly $1,200 to $1,700.
       They must never be left blank. An unpriced window does NOT quote as TBD
       \u2014 sellWindowPrice falls through to the nearest WHITE VINYL by area,
       so a blank entry would put a 96x48 on a quote at $310 with only a note
       to say otherwise. Admin \u2192 Pricing \u2192 Windows overrides all eight. */
    "Black Bi-Fold Bar 48x36": 2495,
    "Black Bi-Fold Bar 60x42": 3495,
    "Black Bi-Fold Bar 72x42": 3995,
    "Black Bi-Fold Bar 96x48": 5795,
    "Black Lift-Up Bar 48x36": 3695,
    "Black Lift-Up Bar 60x42": 4995,
    "Black Lift-Up Bar 72x42": 5995,
    "Black Lift-Up Bar 96x48": 7495
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
      // Metal ramps at the drive-in door, so a quad can be ridden in. Flat for
      // the shed, not per door: it is one item on one delivery.
      "Ramp": 200,
      // Site clearance, priced flat rather than by size: the work is a crew and
      // a dump run either way, and quoting it per square foot would invite an
      // argument about measurements before anyone has seen the site.
      // Both $1,000 as of Sep 2026 — breaking up and hauling a slab is the same
      // day's work as taking an old shed away, so it stopped being the cheaper
      // of the two.
      "Shed Removal": 1000, "Concrete Removal": 1000,
      /* THE EXTERIOR BAR LEDGE. ONE price per ledge, whatever the window is —
         ShedPro quotes it that way, so it lives in `flat` rather than being
         computed per foot. It was built per-linear-foot first, which charged a
         4ft bar less than an 8ft one; the number below replaces that MODEL,
         not just its rate. Admin → Pricing → options.flat overrides it. */
      "Exterior Bar Ledge": 695
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

/* The porch's own square footage — the area both the porch line and the
   decking line bill on, so they cannot disagree about how big the porch is.
   A front porch spans the shed's WIDTH, a side porch its LENGTH, matching
   porchLineFor's shedSpan argument. */
function porchSqftFor(loc, depth, shedSpan){
  if(loc!=='front' && loc!=='side') return 0;
  if(!(depth>0)) return 0;
  return Math.round(depth * (shedSpan||0));
}
/* The decking upcharge. Separate from porchLineFor because it is a different
   question — porchLineFor prices the porch, this prices what you walk on —
   and because the designer needs to label its deck buttons with these prices
   without re-deriving a rate on the client. Unknown deck ids charge nothing
   rather than falling back to the composite rate: a typo must not invent a
   charge. */
function porchDeckLineFor(loc, depth, deck, shedSpan){
  var sqft = porchSqftFor(loc, depth, shedSpan);
  if(!sqft) return null;
  var id = String(deck || 'pt');
  var rate = (SELL.porchDeckSqft || {})[id];
  if(!(typeof rate === 'number' && isFinite(rate) && rate > 0)) return null;
  return {
    price: Math.round(rate * sqft),
    name: 'Composite Porch Decking (' + sqft + ' sqft)',
    unpriced: false
  };
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
  // The cedar single is its own style id, not a narrow 'cedar'. Width alone
  // can't tell the two apart safely: the ladders would have to meet at some
  // inch, and a door that lands on the wrong side of it prices as the wrong
  // product silently. Two ids, two ladders, no seam.
  if(st==='cedarSingle'){
    var sl=(w<=38)?"3'":"3'6\"";
    var sk=sl+" Cedar Single";
    return { base: sk, key: sk, panel4:false };
  }
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
  {grp:"Transom", key:"White Transom 3x10", label:"Horizontal Transom 36x10 \u00b7 White", w:36,h:10},
  {grp:"Transom", key:"White Transom 5x10", label:"Horizontal Transom 60x10 \u00b7 White", w:60,h:10},
  {grp:"Transom", key:"Brown Transom 3x10", label:"Horizontal Transom 36x10 \u00b7 Brown", w:36,h:10},
  {grp:"Transom", key:"Brown Transom 5x10", label:"Horizontal Transom 60x10 \u00b7 Brown", w:60,h:10},
  {grp:"Transom", key:"Black Transom 3x10", label:"Horizontal Transom 36x10 \u00b7 Black", w:36,h:10},
  {grp:"Transom", key:"Black Transom 5x10", label:"Horizontal Transom 60x10 \u00b7 Black", w:60,h:10},
  /* ── PREMIUM ──
     Its own group, not a size of an existing one, because these are bought-in
     architectural units rather than a stock shed window: a different supplier,
     a different lead time, and a price an order of magnitude above the vinyl.
     Keeping them in "Black Aluminum" would have put a $4,000 unit in the same
     list as a $155 one, sorted by size, with nothing to tell them apart.

     Both products are offered at the SAME four sizes, so a customer choosing
     between them is choosing a mechanism and not a size chart, and the two
     price lists compare line for line.
     The BI-FOLD BAR WINDOW is three panels on vertical hinges that accordion
     back against one jamb, over an exterior serving ledge. Every width divides
     by three exactly (16"/20"/24"/32" panels) so the closed window reads as
     three equal lights rather than two and a remainder. */
  {grp:"Premium", key:"Black Bi-Fold Bar 48x36", label:"Bi-Fold Bar Window 48x36 \u00b7 Black", w:48,h:36},
  {grp:"Premium", key:"Black Bi-Fold Bar 60x42", label:"Bi-Fold Bar Window 60x42 \u00b7 Black", w:60,h:42},
  {grp:"Premium", key:"Black Bi-Fold Bar 72x42", label:"Bi-Fold Bar Window 72x42 \u00b7 Black", w:72,h:42},
  {grp:"Premium", key:"Black Bi-Fold Bar 96x48", label:"Bi-Fold Bar Window 96x48 \u00b7 Black", w:96,h:48},
  /* The LIFT-UP is the other half of the premium pair and a different product,
     not a variant: one large sash hinged along its TOP edge, lifting to nearly
     horizontal on two gas struts to make a canopy over the bar. The bi-fold is
     three vertically hinged panels folding to one side. Nothing is shared but
     the serving ledge, so they are separate keys, separate geometry and
     separate prices — a customer who says "the lift-up one" means one of
     these, and there is no size at which the two meet. */
  {grp:"Premium", key:"Black Lift-Up Bar 48x36", label:"Lift-Up Bar Window 48x36 \u00b7 Black", w:48,h:36},
  {grp:"Premium", key:"Black Lift-Up Bar 60x42", label:"Lift-Up Bar Window 60x42 \u00b7 Black", w:60,h:42},
  {grp:"Premium", key:"Black Lift-Up Bar 72x42", label:"Lift-Up Bar Window 72x42 \u00b7 Black", w:72,h:42},
  {grp:"Premium", key:"Black Lift-Up Bar 96x48", label:"Lift-Up Bar Window 96x48 \u00b7 Black", w:96,h:48}
];
function windowCatEntry(key){
  for(var i=0;i<WINDOW_CATALOG.length;i++) if(WINDOW_CATALOG[i].key===key) return WINDOW_CATALOG[i];
  return null;
}
/* What the CUSTOMER reads on a window line.

   The catalog key is "<Colour> <Material> <WxH>" — "Black Vinyl 36x36" — and
   that key is the identity used by SELL.windows and by every saved design, so
   it cannot be renamed at the source without missing every price entry. Same
   trap doorDisplayName was written around, so the same answer: the noun goes
   on at the point of display and the key is left alone. "Black Vinyl 36x36"
   prices the window; "Black Vinyl Window 36x36" is what the quote calls it,
   because a line reading only "Black Vinyl" tells a customer the colour and
   the material and not what they are buying.

   The noun lands before the size rather than after it so the size stays last,
   matching the doors ("6' Roll-Up Garage Door" keeps its 6' out front). A key
   with no WxH in it — the area-fallback "Window" — is returned untouched. */
/* THE GABLE/WALL VENT'S SIZE, in inches, stated once.
   The louvre is 16 wide by 8 tall. That was written down in three places and
   named in a fourth — the price key is spelled "8x16 Gable/Wall Vent", which
   is HEIGHT BY WIDTH, the opposite order to every window in this file. So the
   line the customer reads is built from these two numbers rather than from
   that key, and it comes out 16x8 like everything else. */
const VENT_SIZE_IN = { w: 16, h: 8 };

function windowDisplayName(key){
  var k = String(key || '').trim();
  if(!k) return 'Window';
  if(/\bwindows?\b/i.test(k)) return k;
  /* EVERY WINDOW SIZE IS STATED IN INCHES, and the digits in the key cannot be
     trusted to be. The horizontal transoms are keyed "3x10" and "5x10" — those
     are FEET by inches, so a 36in wide window went onto a quote reading
     "White Transom Window 3x10". Nobody reads that as three feet; they read a
     window three inches wide, next to a 12x24 that really is inches.
     The catalog carries the true w/h, so the line is built from those. The KEY
     is left exactly as it is: it indexes SELL.windows and sits inside every
     saved design, and renaming it there would miss every price entry — the
     same trap doorDisplayName was written around. */
  var e = windowCatEntry(k);
  if(e) return k.replace(/\s*\d+\s*x\s*\d+\s*$/, '') + ' Window ' + e.w + 'x' + e.h;
  return /\d+\s*x\s*\d+\s*$/.test(k) ? k.replace(/(\d+\s*x\s*\d+)\s*$/, 'Window $1') : k;
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

/* ── THE BAR WINDOWS ──
   Premium serving windows: one folds to the side, one lifts overhead, both
   open onto a counter. Recognised through the CATALOG, not by a regex on the
   key alone — a bare /bar/ test would one day catch a "Barn Sash" and quietly
   start charging it for a countertop. The group has to say Premium too. */
function isBarWindowKey(key){
  var e = windowCatEntry(String(key||''));
  return !!e && e.grp==='Premium' && /\bBar\b/.test(e.key);
}
/* What the optional exterior ledge costs on a placed window. Zero unless this
   is a bar window AND the ledge is on. Default ON: the ledge is the reason
   these windows exist, so only an explicit false removes it — the same rule
   the 3D builder uses, and it is itemised either way so nobody pays for one
   without seeing it on the quote.
   ONE flat price per ledge, not per foot: that is how ShedPro quotes it. */
function sellBarLedge(wd){
  if(!wd || !isBarWindowKey(wd.type) || wd.ledge===false) return 0;
  return SELL.options.flat["Exterior Bar Ledge"] || 0;
}

/* What the CUSTOMER reads on the siding line.

   The horizontal product used to be labelled as lap siding here, and it is
   not lap siding — it is T1-11 run horizontally, seamed every 8'. Naming a
   product after a different product is the kind of thing a customer quotes
   back at you, so the line is named by its orientation and nothing else. The
   old label is deliberately not written out anywhere, including in a comment:
   a test greps the repo for it.

   Keys are the SIDING ids and are NOT display strings: they index SELL.siding
   and live inside every saved design, so they stay as they are and the label
   goes on here. An id with no entry falls back to the id rather than to an
   empty string — an unnamed line with a price on it is worse than an ugly one,
   and it would also break the comp picker, which matches on this exact text.

   "Siding" is on the end for the same reason "Window" is on the window lines:
   "Horizontal" beside a dollar amount does not tell a customer what they are
   paying for. Vertical is in the table but never reaches a quote — it is the
   included siding at rate 0, so no upcharge line is emitted for it. */
const SIDING_DISPLAY = {
  "vertical":     "Vertical Siding",
  "horizontal":   "Horizontal Siding",
  "board-batten": "Board & Batten Siding",
  "pine":         "Pine T&G Siding"
};
function sidingDisplayName(id){
  var k = String(id || '');
  return SIDING_DISPLAY[k] || k;
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
  var porchDeck = (typeof PORCH_DECK!=='undefined') ? PORCH_DECK : 'pt';
  var porchDeckSell = 0, porchDeckSellName = '';
  if(porchLoc!=='none' && porchDepth>0){
    var _span = (porchLoc==='side'?Df:Wf);
    var pl = porchLineFor(porchLoc, porchDepth, porchTier, _span);
    if(pl){
      porchSell += pl.price;
      porchSellName = pl.name;
      if(pl.unpriced) unpriced.push(pl.name+' — no price set');
    }
    /* Composite decking is its own line rather than folded into the porch.
       It is the visible upgrade the customer picked and watched change in the
       3D, so it should be the thing they see a price against — and keeping it
       separate means a porch's base price stays comparable across quotes. */
    var dk = porchDeckLineFor(porchLoc, porchDepth, porchDeck, _span);
    if(dk){ porchDeckSell = dk.price; porchDeckSellName = dk.name; }
  }
  customerPrice += porchSell + porchDeckSell;

  // ── SIDING UPCHARGE (customer): per sqft of WALL AREA over included T11 ──
  var sidingSell = 0, sidingSellName = '';
  var sidId = (typeof SIDING!=='undefined')?SIDING:'vertical';
  var sidRate = SELL.siding[sidId];
  if(sidRate>0){
    sidingSell = sidRate * wallAreaFt(Wf, Df, Hf);
    sidingSellName = sidingDisplayName(sidId);
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
        windowSellLines.push({label:windowDisplayName(wd.type), price:p, est:!priced});
        if(!priced) unpriced.push((wd.type?windowDisplayName(wd.type):'Untyped window')+' — no workbook price, estimated by area');
      }
      /* The bar ledge is its own line, right after the window it hangs on.
         Folded into the window's price it would be invisible: a customer
         turning the ledge off would watch the total drop with nothing on the
         quote to say what left. */
      var ledge = sellBarLedge(wd);
      if(ledge>0){
        windowSell += ledge;
        /* No footage on the line. The fee is flat, and a length printed
           beside a single number invites dividing one by the other. */
        windowSellLines.push({label:'Exterior Bar Ledge', price:ledge});
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
        // Sized on the line like every window, in inches. It was the one
        // opening on the quote that said nothing about how big it is.
        addonLines.push({name:'Gable/Wall Vent '+VENT_SIZE_IN.w+'x'+VENT_SIZE_IN.h+
                              ' \u00d7'+_ventCt, amt:_vp});
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
    _flat(ADDONS.ramp,'Ramp');
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
      porchDeckSell: porchDeckSell, porchDeckSellName: porchDeckSellName,
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

const OVERRIDE_GROUPS = ['doors','windows','siding','exteriorPaint','labor','electrical','dormers','wallHeight','porchDeckSqft',
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

// ---- inlined from worker/quotelines.js by build-bundle.mjs — do not edit below by hand ----
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
const TAX_RATE = 0.0725;
/* ONE deposit, covering the whole job, collected before work begins. It is
   worked out per item — 30% of each item's tax-included price, which is what
   the quote itemises — but the items are billed together, not as each stage
   starts. This comment and the quote both used to say the opposite, which was
   a promise on every quote sent that the invoicing never kept. */
const DEPOSIT_RATE = 0.30;

/* What the base shed price covers, named under the Base Shed line. NAMES ONLY,
   no figures: the shed line is a SELL price and the money behind these headings
   is cost, so printing both would let a customer read the margin off the page. */
const BASE_SHED_INCLUDES = [
  'Materials & lumber',
  'Shop labor',
  'Build labor & assembly',
  'Fuel & delivery'
];

const REMOVAL_NAMES = ['Shed Removal', 'Concrete Removal'];

function num(n) { return Number(n) || 0; }

function sumLines(lines, amtKey) {
  return (lines || []).reduce(function (t, l) { return t + num(l[amtKey]); }, 0);
}

/* Mirrors compItemsFromRedline() in the worker: the individually-priced lines
   this quote actually sums, which is exactly the set that can be given away. */
function compItemPrices(redline) {
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
function nameList(redline, which) {
  if (!redline) return [];
  if (which === 'interior') return [redline.intSellName].filter(Boolean);
  if (which === 'foundation') return [redline.foundName].filter(Boolean);
  const out = [];
  (redline.addonLines || []).forEach(function (l) {
    if (l && l.name && REMOVAL_NAMES.indexOf(l.name) === -1) out.push(l.name);
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

/* The comped lines for this submission, as name -> amount. quote.html builds
   this in render() before calling taxBreakdown; here it is derived inside, so
   a caller cannot forget to. */
function compedMap(redline, adjustments) {
  const prices = compItemPrices(redline);
  const out = {};
  (adjustments || []).forEach(function (a) {
    if (a && a.kind === 'comp' && prices[a.item] != null) out[a.item] = prices[a.item];
  });
  return out;
}

function removalLines(redline) {
  if (!redline || !Array.isArray(redline.addonLines)) return [];
  return redline.addonLines.filter((l) => l && REMOVAL_NAMES.indexOf(l.name) !== -1);
}
function removalTotal(redline) {
  return removalLines(redline).reduce((t, l) => t + num(l.amt), 0);
}

/* The phase rows and every total on the quote.
   Returns null for a redline it cannot read, exactly as taxBreakdown does — a
   caller that treats null as "no charge" would be a bug either way, but this
   keeps the two identical. */
function quoteLines(redline, adjustments) {
  if (!redline || typeof redline !== 'object') return null;
  const COMPED = compedMap(redline, adjustments);
  const ADJUSTMENTS = adjustments || [];

  /* How much of a given row is being comped, so the reduction lands on the
     phase the item actually belongs to rather than being lopped off the
     bottom line. */
  function compedIn(names) {
    let t = 0;
    names.forEach(function (n) { if (n && COMPED[n] != null) t += COMPED[n]; });
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
  const rows = [];
  function add(label, amt) {
    if (!label || !amt) return null;
    const row = { label: label, amt: Number(amt) };
    rows.push(row);
    return row;
  }

  const removal = removalLines(redline);
  if (removal.length) {
    const rTotal = removalTotal(redline) - compedIn(REMOVAL_NAMES);
    const rRow = add(removal.length > 1 ? 'Site Clearance' : removal[0].name, rTotal);
    if (rRow && removal.length > 1) {
      rRow.subLines = removal.map((l) => ({ label: l.name, amt: num(l.amt) }));
    }
  }

  /* The pad spec (4" poured slab) belongs on every quote regardless of when its
     redline snapshot was taken, so it is added at display time rather than
     depending on redline.foundName having been generated with it baked in. */
  let foundLabel = redline.foundName || 'Concrete';
  if (foundLabel.indexOf('Concrete Pad') === 0 && foundLabel.indexOf('4"') === -1) {
    foundLabel = foundLabel.replace('Concrete Pad', 'Concrete Pad (4" slab)');
  }
  add(foundLabel, num(redline.foundSell) - compedIn(nameList(redline, 'foundation')));
  const shedRow = add('Shed' + (redline.baseSheetLabel ? ' (' + redline.baseSheetLabel + ')' : ''), shedTotal);
  add(redline.intSellName || 'Interior Finishing', num(redline.intSell) - compedIn(nameList(redline, 'interior')));

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
    shedSubLine(num(amt) - (COMPED[label] || 0), label);
  }
  function shedItemsFrom(lines, nameKey, amtKey) {
    (lines || []).forEach(function (l) {
      if (!l || REMOVAL_NAMES.indexOf(l[nameKey]) > -1) return;   // its own phase
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
    if (a.kind === 'percent' && isFinite(v)) percentAdjust += subtotal * (v / 100);
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
  return {
    rows: rows,
    subtotal: subtotal,
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
  };
}

// ---- end inlined quotelines.js ----

// ---- inlined from worker/invoices.js by build-bundle.mjs — do not edit below by hand ----
/* WHAT AN INVOICE ACTUALLY CHARGES, WORKED OUT BEFORE STRIPE IS INVOLVED.
 *
 * Kept apart from the Stripe calls on purpose: this is the half that decides
 * how much money to ask a customer for, and it should be runnable — and wrong
 * in an obvious way — without a network, an API key or a sandbox.
 *
 * Everything here comes from quoteLines(), so the invoice cannot disagree with
 * the quote the customer already saw. Nothing is re-derived.
 *
 * TWO THINGS THAT WOULD OTHERWISE BITE:
 *
 * 1. Stripe takes integer CENTS. Rounding each line independently and letting
 *    them fall where they may is how an invoice ends up a penny off its own
 *    total — which looks like sloppiness on a document about money, and on a
 *    balance invoice means the job never quite reaches zero. The lines here are
 *    reconciled against the total, and a test asserts they sum to it exactly.
 *
 * 2. The amounts are TAX-INCLUSIVE. The quote computes Utah sales tax itself,
 *    and a phase's deposit is 30% of its tax-included figure. So Stripe must
 *    not add tax on top — no tax rates on the items, Stripe Tax off for these
 *    invoices. Sending a tax-inclusive amount to a tax-computing invoice is a
 *    7.25% overcharge that nothing in the code would flag.
 */

const KINDS = ['deposit', 'balance'];

/* Money in, money out, in the unit Stripe speaks. Rounded half away from zero
   rather than JS's default half-up, so a credit of -0.005 and a charge of
   0.005 land symmetrically instead of both rounding upward. */
function toCents(n) {
  const v = Number(n) || 0;
  return Math.sign(v) * Math.round(Math.abs(v) * 100);
}

function fromCents(c) { return (Number(c) || 0) / 100; }

/* Reconcile a set of line amounts so they sum to exactly `totalCents`.
   The residue lands on the LARGEST line, where a penny is least visible, not
   on the last one, which on a balance invoice is a credit — adjusting a credit
   to fix a rounding error would misstate what the customer has paid. */
function reconcile(lines, totalCents) {
  if (!lines.length) return lines;
  const sum = lines.reduce((t, l) => t + l.amountCents, 0);
  const drift = totalCents - sum;
  if (!drift) return lines;
  /* `fixed` lines are off limits: a payment credit is a statement of what the
     customer actually handed over, and a customer who paid $2,091.52 and sees
     $2,091.51 credited has found a discrepancy in the one document where
     finding one destroys their confidence in all of it. Only lines we
     computed get adjusted. Previously this picked the largest line outright,
     which on a balance invoice could be the deposit credit. */
  /* A line marked `residue` is the designated place for the odd penny — on a
     deposit that is the deferral, a figure derived here and printed nowhere
     else, so a cent on it contradicts nothing the customer can check. */
  let target = lines.findIndex((l) => l.residue && !l.fixed);
  if (target < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].fixed) continue;
      if (target < 0 || Math.abs(lines[i].amountCents) > Math.abs(lines[target].amountCents)) target = i;
    }
  }
  if (target < 0) target = 0;
  lines[target].amountCents += drift;
  return lines;
}

/* THE LINES, IN THE SAME ORDER AND THE SAME WORDS AS THE QUOTE.
 *
 * The quote a customer already read shows: each phase at its pre-tax price,
 * then each adjustment on its own line with the note that was written for it,
 * then sales tax. So that is what the invoice shows. Re-stating the same job
 * in a different shape — a single "30% deposit" line, say — makes a customer
 * check one document against the other, and the one place they must never
 * have to do that is the one asking for money.
 *
 * What differs between the two kinds is only the LAST line:
 *
 *   deposit — the rest is deferred, so a single credit carries 70% forward
 *   balance — what has actually been paid comes off, one credit per payment
 *
 * Both therefore show the whole job on the face of the invoice, which is also
 * what makes the second one add up in front of the customer.
 */
function pct(rate) {
  const s = ((Number(rate) || 0) * 100).toFixed(2);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/* The rates are DERIVED from the breakdown, not restated here. Two reasons,
   and the second is the hard one: a second copy of TAX_RATE would drift from
   quotelines.js the day either changes, and the bundler inlines every module
   at top level, so a second `const TAX_RATE` is a SyntaxError that stops the
   whole worker. Reading them back out of the numbers quoteLines produced
   keeps one source of truth and cannot collide. */
function taxRateOf(bd) {
  return bd.adjustedSubtotal > 0 ? bd.tax / bd.adjustedSubtotal : 0;
}
function depositRateOf(bd) {
  return bd.total > 0 ? bd.depositTotal / bd.total : 0;
}

/* One line per adjustment, labelled the way the quote labels it — including
   the note, which is often the whole explanation ("Honoring price before they
   increased"). Percentages are resolved against the pre-adjustment subtotal,
   the same base quoteLines used, so the figures match to the penny.

   Not hardcoded "Discount": an adjustment can go up as well as down, and
   "Discount (10%)" beside a +$500 figure reads as an error on the whole
   document. */
function adjustmentLines(bd, adjustments) {
  const want = toCents(bd.adjust);
  const named = [];
  (adjustments || []).forEach((a) => {
    if (!a) return;
    const v = Number(a.value);
    if (!isFinite(v) || !v) return;
    if (a.kind === 'percent') {
      named.push({
        label: (a.note || (v < 0 ? 'Discount' : 'Adjustment')) + ' (' + Math.abs(v) + '%)',
        amountCents: toCents(bd.subtotal * (v / 100))
      });
    } else if (a.kind === 'amount') {
      named.push({ label: a.note || (v < 0 ? 'Discount' : 'Adjustment'), amountCents: toCents(v) });
    }
  });

  /* The named lines are for the customer's benefit; the ARITHMETIC comes from
     the breakdown either way. If the two disagree — a caller that did not pass
     the adjustment list, or one that passed a stale copy — the named lines are
     dropped and the figures quoteLines already computed are used instead.
     Without this the shortfall does not surface: reconcile() would quietly
     pile it onto the largest phase line, and the invoice would still add up
     while every phase on it disagreed with the customer's quote. */
  const sum = named.reduce((t, l) => t + l.amountCents, 0);
  if (named.length && sum === want) return named;
  if (!want) return [];
  const out = [];
  const pctCents = toCents(bd.percentAdjust);
  const amtCents = toCents(bd.amountAdjust);
  if (pctCents) out.push({ label: pctCents < 0 ? 'Discount' : 'Adjustment', amountCents: pctCents });
  if (amtCents) out.push({ label: amtCents < 0 ? 'Discount' : 'Adjustment', amountCents: amtCents });
  /* Any penny of difference between the two roundings belongs with the
     adjustment, not smeared onto a phase. */
  const drift = want - out.reduce((t, l) => t + l.amountCents, 0);
  if (drift && out.length) out[out.length - 1].amountCents += drift;
  else if (drift) out.push({ label: 'Adjustment', amountCents: drift });
  return out;
}

/* Phases, adjustments and tax — everything above the line that differs by
   kind. Sums to the job total, which is asserted in the tests rather than
   assumed here. */
/* What a phase is made of, named on the phase's own line.
 *
 * This used to live only in the memo — until the memo turned out to be capped
 * at 500 characters, which a real shed's itemisation does not fit inside. So
 * the names move to the line items, where there is a separate budget per line
 * and, better, where they sit beside the money they explain. No prices: the
 * sub-items add up to the phase total on the same line, and printing both
 * invites a customer to check one against the other. */
function phaseLabel(row) {
  const parts = (row.subLines || []).map((s) => s.label).filter(Boolean);
  if (!parts.length) return row.label;
  /* Not clipped here. buildInvoice clips every line label on the way out, and
     a second cap at this spot is a line that looks load-bearing but cannot be
     made to fail — removing it changed no test, which is the tell. */
  return row.label + ': ' + parts.join(', ');
}

function jobLines(bd, adjustments) {
  const lines = bd.rows
    .map((r) => ({ label: phaseLabel(r), amountCents: toCents(r.amt) }))
    .filter((l) => l.amountCents !== 0);
  adjustmentLines(bd, adjustments).forEach((l) => lines.push({ ...l, fixed: true }));
  const taxCents = toCents(bd.tax);
  if (taxCents) lines.push({ label: 'Sales Tax (' + pct(taxRateOf(bd)) + '%)', amountCents: taxCents, fixed: true });
  return lines;
}

function depositInvoice(bd, adjustments) {
  const lines = jobLines(bd, adjustments);
  const totalCents = toCents(bd.depositTotal);
  const deferred = toCents(bd.total) - totalCents;
  if (deferred > 0) {
    lines.push({
      label: 'Less balance due on completion — ' + pct(1 - depositRateOf(bd)) + '% of each phase',
      amountCents: -deferred,
      residue: true
    });
  }
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* The balance: the whole job, less what has already been paid.
 *
 * NOT "the other 70%". A customer who paid a round number, or paid twice, or
 * whose deposit was taken by check before any of this existed, would be
 * overcharged by a flat 70% — and the error grows with how unusual the
 * payment history is, which is exactly when nobody is checking.
 *
 * Payments arrive as [{amount, method, paid_at}] and are listed individually
 * as credits rather than netted into one figure, so the invoice shows its own
 * arithmetic and a wrongly-applied payment is visible on the document instead
 * of buried in a subtraction. */
function balanceInvoice(bd, adjustments, payments) {
  const lines = jobLines(bd, adjustments);

  (payments || []).forEach((p) => {
    const c = toCents(p.amount);
    if (!c) return;
    const when = p.paid_at ? ' ' + String(p.paid_at).slice(0, 10) : '';
    const how = p.method ? ' by ' + p.method : '';
    lines.push({ label: 'Payment received' + how + when, amountCents: -Math.abs(c), fixed: true });
  });

  const jobCents = toCents(bd.total);
  const paidCents = (payments || []).reduce((t, p) => t + Math.abs(toCents(p.amount)), 0);
  const totalCents = jobCents - paidCents;
  return { lines: reconcile(lines, totalCents), totalCents };
}

/* WHICH PAYMENTS BELONG TO THIS JOB.
 *
 * payments is keyed to the CUSTOMER, not the job — it predates anyone buying a
 * second shed, and a few customers have. Subtracting every payment a customer
 * ever made from the balance on their second shed would credit them for the
 * first one.
 *
 * So rows now carry submission_id, and they sort into three:
 *
 *   applied    — this job's. These come off the balance.
 *   unassigned — recorded before the column existed, or entered without a job
 *                picked. NOT guessed at in either direction: silently counting
 *                them credits the wrong shed, silently ignoring them bills a
 *                customer for money they already paid. The caller surfaces
 *                them so a person decides.
 *   other      — another job's. Excluded, and counted only so the UI can say
 *                so rather than leaving someone wondering where a payment went.
 */
function splitPayments(payments, submissionId) {
  const applied = [], unassigned = [], other = [];
  const want = Number(submissionId);
  (payments || []).forEach((p) => {
    const sid = p && p.submission_id;
    if (sid == null || sid === '') unassigned.push(p);
    else if (Number(sid) === want) applied.push(p);
    else other.push(p);
  });
  return { applied, unassigned, other };
}

/* Build one invoice.
 *
 * Returns { kind, lines, totalCents, jobTotalCents, paidCents } — or throws.
 * Throwing rather than returning a zero invoice is deliberate: every caller
 * here is a button someone pressed meaning "bill this person", and silently
 * billing nothing is worse than an error they can read. */
/* WHAT THE CUSTOMER READS AROUND THE NUMBERS.
 *
 * The line items carry the money. Everything else the quote shows — what is
 * actually in the shed, what was thrown in free, how the two payments work —
 * goes in the three places a Stripe invoice has for it: custom fields across
 * the top, the memo under them, and the footer at the bottom.
 *
 * Every one of these is capped. Stripe documents a limit on the custom fields
 * (40 / 140 characters) and does not document one for the memo or the footer,
 * and an undocumented limit is still a limit — exceeding it is a hard
 * rejection, which on this endpoint means the invoice does not go out at all.
 * So they are trimmed to a conservative length here rather than discovered
 * the expensive way. The build detail degrades a piece at a time: the package
 * contents go first, then whole sub-lines, so what survives is always the
 * most useful part rather than an arbitrary cut mid-word.
 */
/* MEASURED, NOT GUESSED.
 *
 * Stripe documents the custom-field limits (40 / 140) and not the others, so
 * the memo was capped at a "conservative" 1200. It is 500 — learned when a
 * real invoice came back "Invalid string: ...; must be at most 500
 * characters" and did not send. A conservative guess at an undocumented limit
 * is still a guess; these are the numbers Stripe has actually enforced, and
 * the rest sit under the same 500 because nothing here needs more. */
const LIMITS = { memo: 500, footer: 500, fieldName: 40, fieldValue: 140, label: 250 };

function clip(s, max) {
  const t = String(s == null ? '' : s);
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

/* Exported because index.js needs the same formatter for its warnings, and the
   bundler inlines every module at TOP LEVEL — a second `function usd` there is
   a SyntaxError that stops the whole worker, not just this feature. */
function usd(n) {
  return Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/* The build, itemised the way the quote itemises it: each phase, then the
   parts that make it up, then what a package contains. Rendered at three
   levels of detail and the longest one that fits is used. */
function buildMemo(bd, opts = {}) {
  const head = [];
  if (opts.summary) head.push(opts.summary);
  if (opts.submissionId) head.push('Order #' + opts.submissionId);
  const heading = head.join(' \u00b7 ');

  function render(withIncludes, withSubLines) {
    const out = [];
    if (heading) out.push(heading, '');
    bd.rows.forEach((r) => {
      out.push(r.label + ' \u2014 ' + usd(r.amt));
      if (!withSubLines) return;
      (r.subLines || []).forEach((s) => {
        out.push('   + ' + s.label + ' \u2014 ' + usd(s.amt));
        if (!withIncludes) return;
        (s.includes || []).forEach((item) => out.push('       \u2014 ' + item));
      });
    });
    return out.join('\n').trim();
  }

  for (const [inc, sub] of [[true, true], [false, true], [false, false]]) {
    const text = render(inc, sub);
    if (text.length <= LIMITS.memo) return text;
  }
  return clip(render(false, false), LIMITS.memo);
}

/* Comped items, what they saved, and how the two payments work. The comped
   block is the reason this is not just a discount line: "Shutters — Included"
   is something you gave them, where "Discount -$60" reads as the price having
   been soft in the first place. */
function buildFooter(bd, comped, kind) {
  const parts = [];
  const names = Object.keys(comped || {});
  if (names.length) parts.push('Included at no charge: ' + names.join(', ') + '.');
  if (bd.savings > 0.005) parts.push('You save ' + usd(bd.savings) + ' on this build.');
  parts.push(kind === 'deposit'
    ? 'This invoice collects the deposit. The balance is invoiced on completion.'
    : 'This invoice settles the balance. Payments already received are credited above.');
  parts.push('All amounts include Utah sales tax.');
  return clip(parts.join(' '), LIMITS.footer);
}

/* Four fields, across the top of the invoice, answering the questions a
   customer asks before reading any further: what is this for, which shed,
   and how much is the whole job. */
function buildCustomFields(bd, kind, opts = {}) {
  const fields = [
    ['Order', opts.submissionId ? '#' + opts.submissionId : null],
    ['Build', opts.summary || null],
    ['Payment', kind === 'deposit' ? 'Deposit' : 'Balance on completion'],
    ['Job total', usd(bd.total)]
  ];
  return fields
    .filter(([, v]) => v)
    .map(([name, value]) => ({ name: clip(name, LIMITS.fieldName), value: clip(value, LIMITS.fieldValue) }))
    .slice(0, 4);
}

/* A SHORT, STABLE FINGERPRINT OF WHAT IS ABOUT TO BE SENT.
 *
 * Stripe remembers an idempotency key for 24 hours and refuses to reuse one
 * with different parameters. The key used to be built from the shed, the kind
 * and how many invoices had been raised — nothing about the CONTENT. So an
 * attempt that failed, followed by anything that changed the request, came
 * back "Keys for idempotent requests can only be used with the same
 * parameters they were first used with" and stayed stuck for a day. Which is
 * exactly what happened after the memo was shortened to fit Stripe's limit.
 *
 * Folding the content in makes the key identify THIS request: a double-tapped
 * button still sends one invoice, because nothing about it changed, while a
 * corrected one gets a fresh key immediately.
 *
 * Not a security hash — it is a cache key, and a collision would only
 * deduplicate two invoices that were identical anyway. */
function fingerprint(parts) {
  const s = JSON.stringify(parts === undefined ? null : parts);
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b + c, 2246822519) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
  }
  return (a.toString(36) + b.toString(36)).slice(0, 12);
}

function buildInvoice(breakdown, kind, payments, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown invoice kind: ${kind}`);
  if (!breakdown || !Array.isArray(breakdown.rows) || !breakdown.rows.length) {
    throw new Error('this submission has no priced phases to invoice');
  }
  const paid = payments || [];
  const adjustments = opts.adjustments || [];
  const out = kind === 'deposit'
    ? depositInvoice(breakdown, adjustments)
    : balanceInvoice(breakdown, adjustments, paid);

  if (out.totalCents <= 0) {
    throw new Error(kind === 'balance'
      ? 'nothing left to invoice — payments already cover this job'
      : 'the deposit for this job works out to nothing');
  }
  return {
    kind,
    lines: out.lines.map((l) => ({ ...l, label: clip(l.label, LIMITS.label) })),
    totalCents: out.totalCents,
    jobTotalCents: toCents(breakdown.total),
    paidCents: paid.reduce((t, p) => t + Math.abs(toCents(p.amount)), 0),
    memo: buildMemo(breakdown, opts),
    footer: buildFooter(breakdown, opts.comped, kind),
    customFields: buildCustomFields(breakdown, kind, opts)
  };
}

// ---- end inlined invoices.js ----

// ---- inlined from worker/stripe.js by build-bundle.mjs — do not edit below by hand ----
/* A SMALL STRIPE CLIENT, BECAUSE THE WORKER HAS NO DEPENDENCIES.
 *
 * worker/index.js is pasted into the Cloudflare dashboard as one file. There is
 * no npm install, so no stripe SDK. This is the slice of the REST API this
 * feature uses, written against the documented wire format.
 *
 * The Stripe API is FORM-ENCODED, not JSON, with a bracket syntax for nested
 * values — payment_method_types[0]=us_bank_account, not a JSON array. Getting
 * that wrong does not error usefully: Stripe ignores what it cannot parse, so
 * an invoice quietly comes out with the default payment methods and the
 * default tax behaviour instead of the ones asked for. That is why the encoder
 * is its own function with its own tests.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/* Stripe's form encoding. Nested objects become a[b], arrays become a[0].
   Null and undefined are dropped rather than sent as the string "null", which
   Stripe would take literally. false and 0 are kept — automatic_tax[enabled]
   being false is the whole point of sending it. */
function stripeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') stripeForm(item, `${key}[${i}]`, out);
        else out.push([`${key}[${i}]`, String(item)]);
      });
    } else if (typeof v === 'object') {
      stripeForm(v, key, out);
    } else {
      out.push([key, String(v)]);
    }
  }
  return prefix ? out : out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/* One call. Errors come back from Stripe as JSON with an error.message worth
   showing whoever pressed the button — "Your card was declined" or "No such
   customer" is far more use than "Stripe 400". */
async function stripeCall(env, path, body, opts = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured on this worker');
  const headers = {
    Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  /* Stripe deduplicates on this key for 24 hours. Without it, a double-tapped
     button is two invoices to the same customer for the same shed. */
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(STRIPE_API + path, {
    method: opts.method || 'POST',
    headers,
    body: body === undefined ? undefined : stripeForm(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe returned ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.stripeCode = data && data.error && data.error.code;
    throw err;
  }
  return data;
}

/* ACH and card. On an eleven thousand dollar shed the difference is about
   $360 — ACH is capped at $5, a card is 2.9% plus the invoicing fee. Card
   stays offered because some people will always reach for it, and a deposit
   that does not get paid is worse than one that costs more.

   The array order is NOT a display order: Stripe decides how the hosted
   invoice page presents them. An earlier version of this comment claimed
   otherwise. Listing ACH first is harmless but buys nothing. */
/* STRIPE_ prefixed, not PAYMENT_METHODS: index.js already has a constant by
   that name for the ways a human can record a payment, and the bundler
   inlines every module at top level. A duplicate const there is a
   SyntaxError that takes down the whole worker, not just this feature. */
const STRIPE_PAYMENT_METHODS = ['us_bank_account', 'card'];

/* Days until due, per kind. A deposit gates the build starting, so it is due
   when it arrives; the balance is billed against work already done. */
const DAYS_UNTIL_DUE = { deposit: 0, balance: 7 };

/* Create a customer, or reuse one we already recorded.
   Stripe will happily create a second customer with the same email, which is
   how a business ends up with four Jenny Rosens and a payment history split
   across all of them. */
async function ensureCustomer(env, { stripeCustomerId, name, email, phone }) {
  if (!email) throw new Error('this customer has no email address to invoice');
  if (stripeCustomerId) {
    try {
      /* UPDATED, not just reused. The email was previously read from the CRM
         only on the FIRST invoice; after that Stripe's copy was never touched
         again. Fix a typo in the CRM, or a customer changes address, and every
         later invoice still goes to the old one — silently, because Stripe
         reports the send as successful either way. For a repeat customer six
         months on, that is a bill delivered to a dead inbox and a job that
         looks unpaid. */
      const c = await stripeCall(env, '/customers/' + encodeURIComponent(stripeCustomerId),
        { name, email, phone });
      return { id: c.id, created: false, email: c.email || email };
    } catch (e) {
      /* THE SWITCH TO LIVE KEYS.
       *
       * Customer ids are per-environment. Every customer invoiced in test mode
       * has a test-mode `cus_...` saved against them, and the day the live key
       * goes in, Stripe answers "No such customer" for every one of them. That
       * would make the first real invoice of every existing customer fail, on
       * the day it matters most, for a reason that reads like a bug rather
       * than a migration.
       *
       * A customer id that is simply gone — deleted in the dashboard, or from
       * the other environment — is not an error worth stopping for. Make a new
       * one; the caller stores it over the stale one. Anything else (a bad
       * key, Stripe down, a rate limit) still throws, because those must not
       * quietly produce a duplicate customer. */
      const missing = e.status === 404 || e.stripeCode === 'resource_missing';
      if (!missing) throw e;
    }
  }
  const c = await stripeCall(env, '/customers', { name, email, phone });
  return { id: c.id, created: true, email: c.email || email };
}

/* The documented sequence: create the invoice, add its items, then send.
 *
 * auto_advance is false so the invoice stays a draft while the lines go on —
 * otherwise Stripe can finalize it the moment it is created and the items
 * arrive on a document that is already legally frozen.
 *
 * automatic_tax is explicitly OFF. The quote already computed Utah sales tax
 * and every amount here is tax-inclusive; letting Stripe add its own would
 * overcharge by 7.25% and nothing in this code would notice.
 */
async function createAndSendInvoice(env, {
  customerId, lines, kind, description, footer, customFields, idempotencyKey, metadata
}) {
  const days = DAYS_UNTIL_DUE[kind];
  if (days === undefined) throw new Error(`unknown invoice kind: ${kind}`);

  const invoice = await stripeCall(env, '/invoices', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: days,
    /* NESTED, not top level. On the Invoice API a top-level
       payment_method_types is rejected outright — "Received unknown
       parameter: payment_method_types. Did you mean payment_settings?" — and
       it was, by Stripe, on the first real invoice anyone tried to send. It
       belongs under payment_settings. (payment_method_types IS top level on
       PaymentIntents and Checkout Sessions, which is where the wrong shape
       came from.) */
    payment_settings: { payment_method_types: STRIPE_PAYMENT_METHODS },
    auto_advance: false,
    automatic_tax: { enabled: false },
    currency: 'usd',
    description: description || undefined,
    footer: footer || undefined,
    /* Up to four, across the top of the invoice. Sent only when there are
       any: an empty array is not the same as leaving the parameter off, and
       Stripe reads one as "clear them". */
    custom_fields: (customFields && customFields.length) ? customFields : undefined,
    metadata: metadata || undefined,
  }, { idempotencyKey: idempotencyKey ? idempotencyKey + ':invoice' : undefined });

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await stripeCall(env, '/invoiceitems', {
      customer: customerId,
      invoice: invoice.id,
      amount: l.amountCents,
      currency: 'usd',
      description: l.label,
    }, { idempotencyKey: idempotencyKey ? `${idempotencyKey}:item:${i}` : undefined });
  }

  /* Sending finalizes it. From here the monetary values cannot be edited —
     which is the behaviour we want, and why a mistake is fixed by voiding and
     reissuing rather than by editing. */
  const sent = await stripeCall(env, `/invoices/${invoice.id}/send`, {},
    { idempotencyKey: idempotencyKey ? idempotencyKey + ':send' : undefined });

  /* Normalised, so nothing downstream has to know Stripe's spelling.
     RESPONSE_FIELDS below is the list this reads from the invoice object, and
     a test checks nothing outside it is touched — because reading a field
     Stripe does not return is NOT an error. It is undefined, it is stored as
     null, and the first sign of trouble is a missing link in the CRM a week
     later. That is exactly how this function came to read
     `hosted_invoice_page`, which is not a field on the invoice object at all;
     the real one is `hosted_invoice_url`. */
  return {
    id: sent.id,
    status: sent.status || 'open',
    hostedUrl: sent.hosted_invoice_url || null,
    /* Where Stripe says it sent it, not where we asked it to. The whole point
       is to be able to answer "which address did this actually go to?" from
       the CRM, and only Stripe's own answer can do that. */
    customerEmail: sent.customer_email || null,
  };
}

/* Fields this module reads off a Stripe invoice object, checked against the
   API reference. Kept beside the code that reads them so the test below has
   something to compare against. */
const RESPONSE_FIELDS = ['id', 'status', 'hosted_invoice_url', 'amount_paid',
  'customer_email', 'email'];

/* Ask Stripe what actually happened, instead of waiting to be told.
 *
 * The webhook is the normal path and this is not a replacement for it — it is
 * the path for when the webhook did not arrive, which happens, and whose
 * failure mode is the CRM insisting a customer has not paid when they have.
 * Read-only: it answers a question and changes nothing at Stripe. */
async function getInvoice(env, stripeInvoiceId) {
  const inv = await stripeCall(env, '/invoices/' + encodeURIComponent(stripeInvoiceId),
    undefined, { method: 'GET' });
  return {
    id: inv.id,
    status: inv.status || null,
    hostedUrl: inv.hosted_invoice_url || null,
    customerEmail: inv.customer_email || null,
    amountPaidCents: Number(inv.amount_paid) || 0,
  };
}

async function voidInvoice(env, stripeInvoiceId) {
  return stripeCall(env, `/invoices/${stripeInvoiceId}/void`, {});
}

// ---- end inlined stripe.js ----

// ---- inlined from worker/stripewebhook.js by build-bundle.mjs — do not edit below by hand ----
/* VERIFYING THAT AN EVENT REALLY CAME FROM STRIPE.
 *
 * This endpoint is public and it marks sheds as paid. Unverified, anyone who
 * learns the URL can post {"type":"invoice.paid"} and clear an $11,000 balance.
 * There is no second check downstream — the CRM believes what lands here.
 *
 * Implemented from Stripe's documented scheme rather than their SDK, because
 * the worker is pasted into a dashboard as one file and has no dependencies.
 *
 * Three things here are load-bearing, and each is a real vulnerability if got
 * wrong rather than a style preference:
 *
 *   1. ONLY the v1 scheme is accepted. Stripe deliberately sends a bogus v0
 *      signature alongside real ones. Accepting any scheme that verifies is a
 *      downgrade attack: an attacker picks the weak one.
 *
 *   2. The comparison is constant time. A byte-by-byte compare that returns
 *      early leaks, through timing, how much of a guessed signature was right,
 *      which is enough to forge one a byte at a time.
 *
 *   3. The timestamp is checked against a tolerance. Without it a valid event
 *      captured once can be replayed forever — the same "paid" event posted
 *      again next month still verifies.
 */

/* Stripe's default, and their explicit advice: never 0, which disables the
   recency check entirely rather than tightening it. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/* t=1492774577,v1=5257a8...,v0=6ffbb5...  — one line, comma separated. */
function parseSignatureHeader(header) {
  const out = { timestamp: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') out.timestamp = Number(value);
    /* v0 is Stripe's deliberately fake test signature. Anything that is not
       v1 is ignored outright — not tried and rejected, never looked at. */
    else if (key === 'v1') out.v1.push(value);
  });
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Compares every byte regardless of where it first differs. Length is folded
   in through the accumulator rather than returned on early, so a wrong-length
   guess is not distinguishable by timing either. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  /* The length is folded in rather than returned on early, so a wrong-length
     guess is not distinguishable by timing either. Out of range reads as 0
     instead of wrapping the index: an earlier version used modulo, which made
     "ab" and "abab" compare equal the moment the length term came out. */
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return mismatch === 0;
}

async function computeSignature(secret, signedPayload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload)));
}

/* rawBody must be the body EXACTLY as it arrived. Parsing and re-serialising
   changes key order and whitespace, and the signature is over the bytes.
   Returns { ok } or { ok: false, reason } — the reason is for a log, never for
   the response: telling a caller which part of their forgery failed helps them. */
async function verifyStripeSignature(rawBody, header, secret, opts = {}) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!timestamp || !isFinite(timestamp)) return { ok: false, reason: 'no timestamp in the signature header' };
  if (!v1.length) return { ok: false, reason: 'no v1 signature in the header' };

  const tolerance = opts.toleranceSeconds === undefined ? DEFAULT_TOLERANCE_SECONDS : opts.toleranceSeconds;
  const now = opts.nowSeconds === undefined ? Math.floor(Date.now() / 1000) : opts.nowSeconds;
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp outside the tolerance window' };
  }

  const expected = await computeSignature(secret, `${timestamp}.${rawBody}`);
  /* Several v1 signatures arrive while a secret is being rolled — one per
     active secret — so any match is a match. Every candidate is compared, with
     no early exit on success either. */
  let matched = false;
  for (const candidate of v1) if (timingSafeEqual(expected, candidate)) matched = true;
  return matched ? { ok: true } : { ok: false, reason: 'signature did not match' };
}

// ---- end inlined stripewebhook.js ----

// ---- inlined from worker/calendar.js by build-bundle.mjs — do not edit below by hand ----
/* THE INSTALL DATE, AS A CALENDAR INVITE THE CUSTOMER GETS.
 *
 * No API, no OAuth, no key. A Google Calendar "template" link carries the
 * whole event in its query string: title, dates, location, description, and
 * — the part that makes this worth building — a guest list. Opening it puts a
 * filled-in event in front of whoever clicked, and the moment they press Save
 * Google emails the invite to the guests. So the customer gets a real invite
 * on their own calendar without us running a mail server or holding a token.
 *
 * THE ONE THAT WILL BITE: for an all-day event the end date is EXCLUSIVE. A
 * one-day install on the 15th is 20261015/20261016. Getting that wrong is not
 * a crash — it is an invite that quietly says the wrong days to a customer who
 * then turns up, or doesn't, on the wrong one. Every boundary case in here has
 * a test.
 *
 * All the date arithmetic is in UTC on purpose. install_date is a plain
 * calendar day with no time in it, and running it through local time is how
 * "the 15th" becomes "the 14th" for half the world on a date near a daylight
 * saving change.
 */

const GOOGLE_CALENDAR_BASE = 'https://calendar.google.com/calendar/render';

/* Titles the install rows already use, so the calendar says what the CRM
   says. Kept here rather than imported: the bundler inlines every module at
   top level and these must not collide with the CRM's own copy. */
const CAL_ITEM_LABELS = {
  prep: 'Site prep',
  pour: 'Concrete pour',
  gravel: 'Gravel pad',
  shop: 'Shop build',
  shed: 'Shed install',
  concrete: 'Concrete pour'
};

/* WHICH STAGES HAPPEN AT THE CUSTOMER'S PLACE.
 *
 * A shop day is a day in your own shop. Inviting the customer to it puts an
 * appointment on their calendar for a day when nothing happens at their
 * house, which is worse than not inviting them at all — they will either turn
 * up or stop trusting the invites. Only site days get the customer; the crew
 * list goes on everything, because the crew need to know about both. */
function isOnSite(item) {
  return item !== 'shop';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* A stored install_date, as a UTC calendar day. Accepts the YYYY-MM-DD the
   form sends and the full ISO string older rows may carry; anything else is
   null, and the caller offers no invite rather than a wrong one. */
function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  /* Rejects the 31st of a 30-day month and the 29th of a common February,
     which Date.UTC would silently roll forward into the next month. */
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function ymd(date) {
  return String(date.getUTCFullYear()) + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate());
}

/* How many calendar days an install occupies. Half a day still takes a day
   off someone's calendar, and a missing figure means one day rather than
   none — an event that ends before it starts is not a useful default. */
function calendarDays(days) {
  const n = Number(days);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n));
}

/* start inclusive, end EXCLUSIVE — Google's format for all-day events. */
function dayRange(installDate, days) {
  const start = parseDay(installDate);
  if (!start) return null;
  const end = new Date(start.getTime() + calendarDays(days) * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

/* Google accepts unencoded commas between guests, but encoding each address
   and joining is the version that cannot be broken by a stray character in an
   address someone typed into the CRM. */
function guestList(guests) {
  return (guests || [])
    .map((g) => String(g || '').trim())
    .filter((g) => g.indexOf('@') > 0)
    .map(encodeURIComponent)
    .join(',');
}

/* The link. Returns null rather than a half-built URL when there is no usable
   date: a button that opens an empty calendar entry is worse than no button,
   because it looks like it worked. */
function googleCalendarUrl({ title, installDate, days, details, location, guests }) {
  const range = dayRange(installDate, days);
  if (!range) return null;
  const parts = [
    'action=TEMPLATE',
    'text=' + encodeURIComponent(title || 'Install'),
    'dates=' + range.start + '/' + range.end,
  ];
  if (details) parts.push('details=' + encodeURIComponent(details));
  if (location) parts.push('location=' + encodeURIComponent(location));
  const add = guestList(guests);
  if (add) parts.push('add=' + add);
  return GOOGLE_CALENDAR_BASE + '?' + parts.join('&');
}

/* What the event is called. The customer's name is in it because this lands
   on a calendar beside twenty other things and "Shed install" alone tells you
   nothing at 6am. */
function installTitle(item, customerName) {
  const what = CAL_ITEM_LABELS[item] || 'Install';
  const who = String(customerName || '').trim();
  return who ? what + ' — ' + who : what;
}

/* Everything worth having on the phone when you are already in the truck. */
function installDetails({ summary, phone, note, days, orderId }) {
  const lines = [];
  if (summary) lines.push(summary);
  if (orderId) lines.push('Order #' + orderId);
  if (phone) lines.push('Phone: ' + phone);
  const n = Number(days);
  if (isFinite(n) && n > 0) lines.push('Scheduled: ' + n + (n === 1 ? ' day' : ' days'));
  if (note) lines.push('Note: ' + note);
  return lines.join('\n');
}

// ---- end inlined calendar.js ----

// ---- inlined from worker/schedule.js by build-bundle.mjs — do not edit below by hand ----
/* PLANNING A BUILD FROM ONE DATE.
 *
 * A shed is not one day in a diary. Concrete needs a prep day and a pour day,
 * the shed is built in the shop before it goes anywhere, and the on-site build
 * takes a day or more. Typing five dates by hand is how two of them end up on
 * the same day, or the shop day ends up after the install.
 *
 * So one date is entered and the rest follow:
 *
 *   CONCRETE — the pour date is the anchor
 *     prep      the working day before the pour
 *     pour      the date entered
 *     shop      the working day before the install
 *     install   one week after the pour, 2 days by default
 *
 *   GRAVEL — the pad date is the anchor. No cure to wait out, so the shed
 *     follows straight on: pad, shop, install on consecutive working days.
 *
 *   NO FOUNDATION — the install date is the anchor, with a shop day before it.
 *
 * WORKING DAYS ARE MONDAY TO FRIDAY. Saturday is a catch-up day, not a day to
 * start something on, so nothing is ever SCHEDULED onto a weekend — which
 * matters most for the shop day, since an install on a Monday would otherwise
 * be prepared for on the Sunday.
 *
 * Every date is computed in UTC on a plain calendar day. Local-time arithmetic
 * shifts the day for anyone east of UTC, and a schedule that is a day out is
 * one nobody notices until somebody drives somewhere.
 */

const WORK_START = 1;   // Monday
const WORK_END = 5;     // Friday

/* The vocabulary of a build. 'concrete' is the older single entry, kept so
   rows booked before any of this still read properly. */
const STAGE_LABELS = {
  prep: 'Site prep',
  pour: 'Concrete pour',
  gravel: 'Gravel pad',
  shop: 'Shop build',
  shed: 'Shed install',
  concrete: 'Concrete'
};

const DEFAULT_INSTALL_DAYS = 2;
const CURE_DAYS = 7;

/* Named apart from calendar.js's identical helper on purpose: the bundler
   inlines every module at TOP level, so two `function pad2` is a SyntaxError
   that stops the whole worker. Caught by bundle.test.mjs, not by reading. */
function pad2sched(n) { return (n < 10 ? '0' : '') + n; }

function dayFromISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function isoFromDay(date) {
  return date.getUTCFullYear() + '-' + pad2sched(date.getUTCMonth() + 1) +
    '-' + pad2sched(date.getUTCDate());
}

function isWorkday(date) {
  const d = date.getUTCDay();
  return d >= WORK_START && d <= WORK_END;
}

function shift(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/* The nearest working day, searching in one direction. Seven steps is always
   enough to find one and bounds the loop — an unbounded while() here would
   hang the worker on a bad calendar rather than return a wrong date. */
function toWorkday(date, direction) {
  const step = direction < 0 ? -1 : 1;
  let d = date;
  for (let i = 0; i < 7; i++) {
    if (isWorkday(d)) return d;
    d = shift(d, step);
  }
  return date;
}

function addWorkdays(date, n) {
  let d = toWorkday(date, n < 0 ? -1 : 1);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d = shift(d, step);
    if (isWorkday(d)) left--;
  }
  return d;
}

/* What kind of foundation a saved design describes. The designer stores the
   CONCRETE pad as foundation:'pad', which reads like any pad — hence the
   mapping rather than passing the raw value around. */
function foundationKind(config) {
  const f = config && config.foundation;
  if (f === 'pad') return 'concrete';
  if (f === 'gravel') return 'gravel';
  return 'none';
}

function stage(item, date, days) {
  return { item: item, install_date: isoFromDay(date), days: days };
}

/* Returns the stages in the order they happen, or null for a date it cannot
   read — a plan built on a date nobody can parse is worse than no plan. */
function planBuild(anchorISO, opts = {}) {
  const anchor = dayFromISO(anchorISO);
  if (!anchor) return null;

  const kind = opts.foundation || 'none';
  const raw = Number(opts.installDays);
  const installDays = isFinite(raw) && raw > 0 ? Math.max(1, Math.ceil(raw)) : DEFAULT_INSTALL_DAYS;

  /* The anchor itself is moved onto a working day. Picking a Saturday for a
     pour is a slip, and quietly honouring it would put every later date a day
     out as well. */
  const start = toWorkday(anchor, 1);

  if (kind === 'concrete') {
    const pour = start;
    const prep = addWorkdays(pour, -1);
    /* A week from the pour. Counted in calendar days, because concrete cures
       over the weekend too — then moved onto a working day, which only bites
       if the pour itself was dragged off a weekend. */
    const install = toWorkday(shift(pour, CURE_DAYS), 1);
    const shop = addWorkdays(install, -1);
    return [
      stage('prep', prep, 1),
      stage('pour', pour, 1),
      stage('shop', shop, 1),
      stage('shed', install, installDays)
    ];
  }

  if (kind === 'gravel') {
    const pad = start;
    const shop = addWorkdays(pad, 1);
    const install = addWorkdays(shop, 1);
    return [
      stage('gravel', pad, 1),
      stage('shop', shop, 1),
      stage('shed', install, installDays)
    ];
  }

  const install = start;
  return [
    stage('shop', addWorkdays(install, -1), 1),
    stage('shed', install, installDays)
  ];
}

/* What the anchor date means for a given foundation, so the form can label
   its one field honestly instead of saying "date". */
function anchorLabel(kind) {
  if (kind === 'concrete') return 'Pour date';
  if (kind === 'gravel') return 'Pad date';
  return 'Install date';
}

// ---- end inlined schedule.js ----

// ---- inlined from worker/address.js by build-bundle.mjs — do not edit below by hand ----
/* HOW AN ADDRESS IS WRITTEN DOWN, in one place.
 *
 * Four places composed one by hand and no two agreed. Three dropped the ZIP
 * entirely — including the location on the Google Calendar invite, which is
 * the address a crew types into a phone on the morning of an install. The
 * fourth kept it and punctuated it "Riverton, UT, 84065".
 *
 * A US address takes a COMMA between the street and the city and between the
 * city and the state, and a SPACE before the ZIP. Not a comma: "UT, 84065"
 * reads as a list and is what every hand-rolled `[city, state, zip].join(', ')`
 * produces, which is exactly why this is a function and not a convention.
 *
 * Blank parts fall out rather than leaving stray punctuation — most of these
 * rows have a city and state and nothing else, and ", , UT" is worse than no
 * address at all.
 */

function clean(v) {
  return String(v == null ? '' : v).trim();
}

/* "Riverton, UT 84065" — the locality line on its own. */
function cityStateZip(c) {
  c = c || {};
  var city = clean(c.city), state = clean(c.state), zip = clean(c.zip);
  /* The state and the ZIP are ONE field joined by a space; the comma belongs
     between the city and that field. Building it in that order is what keeps
     a missing state from producing "Riverton, 84065" with a comma that now
     separates nothing. */
  var tail = [state, zip].filter(Boolean).join(' ');
  return [city, tail].filter(Boolean).join(', ');
}

/* "11999 South Lampton View Drive, Riverton, UT 84065" — what you navigate to. */
function fullAddress(c) {
  c = c || {};
  return [clean(c.address), cityStateZip(c)].filter(Boolean).join(', ');
}

// ---- end inlined address.js ----

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
  ["cedarSingle", 36], ["cedarSingle", 42],
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
/* timingSafeEqual now lives in stripewebhook.js, imported above — the
   webhook needs the same comparison and two of them is one too many. */
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

  /* submission_id came later. This table was written when a payment only had
     to say which CUSTOMER paid; a few customers have since bought a second
     shed, and "what is still owed" is a question about a JOB. Without it, the
     balance invoice on a second shed would credit the customer for the first.
     The CRM side reached the same conclusion about its own deposits - see the
     note on client_intake in ensureCrmTables.

     Nullable, and left null on every existing row: those payments are real but
     unattributed, and inventing a job for them would be worse than admitting
     it. splitPayments() hands them back for a person to place.

     CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, and
     D1 has no ADD COLUMN IF NOT EXISTS, so read the table and add what is
     missing. */
  const have = await env.DB.prepare("PRAGMA table_info(payments)").all();
  const names = (have.results || []).map((r) => r.name);
  if (names.indexOf("submission_id") === -1) {
    await env.DB.prepare("ALTER TABLE payments ADD COLUMN submission_id INTEGER").run();
  }
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
    "SELECT id, amount, method, note, paid_at, created_at, submission_id FROM payments WHERE customer_id = ? ORDER BY paid_at DESC, id DESC"
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

  /* Each scheduled install carries a ready-made Google Calendar link, built
     here rather than in the browser so the date arithmetic — where an all-day
     event's end date is EXCLUSIVE — lives in one tested place. The customer
     is on the guest list, so whoever opens the link and presses Save has
     Google send them the invite. */
  const calGuests = String(env.INSTALL_CALENDAR_GUESTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const subById = {};
  submissions.forEach((s) => { subById[s.id] = s; });
  installs.forEach((i) => {
    let details = {};
    try { details = JSON.parse((subById[i.submission_id] || {}).details) || {}; } catch (e) {}
    i.calendar_url = googleCalendarUrl({
      title: installTitle(i.item, customer.name),
      installDate: i.install_date,
      days: i.days,
      details: installDetails({
        summary: configSummary(details.config),
        phone: customer.phone,
        note: i.note,
        days: i.days,
        orderId: i.submission_id,
      }),
      location: fullAddress(customer),
      guests: (customer.email && isOnSite(i.item)) ? [customer.email].concat(calGuests) : calGuests,
    });
  });

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

// ---- invoices ----------------------------------------------------------
/* What was billed, when, and for which shed. Lazily created like payments and
   installs, so no manual D1 migration.

   The AMOUNTS ARE SNAPSHOTTED here rather than recomputed on read. The quote
   reprices itself from current pricing every time it loads, which is right for
   a quote and wrong for an invoice: edit a price next month and an invoice a
   customer already received would quietly show a different number than the one
   they agreed to. Stripe freezes its side on finalize; this is our copy of the
   same fact.

   status mirrors Stripe's (open / paid / void / uncollectible) and is updated
   by the webhook, not guessed at here. */
async function ensureInvoicesTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      submission_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      stripe_invoice_id TEXT,
      hosted_url TEXT,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      lines TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      paid_at TEXT
    )`
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_invoices_submission ON invoices (submission_id)"
  ).run();

  /* Stripe's customer id, so a second invoice reuses the first customer rather
     than creating a duplicate — which is how a business ends up with four of
     the same person and a payment history split across all of them. */
  const have = await env.DB.prepare("PRAGMA table_info(customers)").all();
  const names = (have.results || []).map((r) => r.name);
  if (names.length && names.indexOf("stripe_customer_id") === -1) {
    await env.DB.prepare("ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT").run();
  }

  /* The address Stripe says it sent to. Stored rather than read back off the
     customer record, because that record can be edited afterwards and this has
     to stay the answer to "where did THIS invoice actually go?" */
  const inv = await env.DB.prepare("PRAGMA table_info(invoices)").all();
  const invNames = (inv.results || []).map((r) => r.name);
  if (invNames.length && invNames.indexOf("sent_to") === -1) {
    await env.DB.prepare("ALTER TABLE invoices ADD COLUMN sent_to TEXT").run();
  }
}

/* The one-line description of the build, in the same words and the same order
   the CRM's order cards use. Duplicated deliberately rather than shared: the
   CRM copy runs in a browser on details.config, this one runs in the worker,
   and a test checks the two produce the same string for the same config. */
function configSummary(config) {
  if (!config) return "";
  const parts = [];
  if (config.w && config.l) parts.push(config.w + "x" + config.l + " ft");
  if (config.style) parts.push(config.style);
  if (config.siding) parts.push(config.siding);
  return parts.join(" \u00b7 ");
}

/* POST /admin/submissions/:id/plan — the whole build from one date.
 *
 * Typing five dates by hand is how two land on the same day, or the shop day
 * ends up after the install. One date goes in and the stages come out, worked
 * out by planBuild() — which is where the rules live and where they are
 * tested.
 *
 * Without `confirm` it only returns the plan, so the CRM can show it before
 * anything is written. The dates are recomputed on confirm rather than taken
 * from the browser: a plan the customer's phone worked out is not one this
 * should be inserting.
 */
async function handlePlanBuild(request, env, origin, submissionId) {
  await ensureInstallsTable(env);
  const body = await request.json().catch(() => ({}));

  const sub = await env.DB.prepare(
    "SELECT id, customer_id, details FROM submissions WHERE id = ?"
  ).bind(submissionId).first();
  if (!sub) return json({ error: "no such order" }, 404, origin);

  let details = {};
  try { details = JSON.parse(sub.details) || {}; } catch (e) {}
  const kind = foundationKind(details.config);

  const stages = planBuild(String(body.anchor_date || ""), {
    foundation: kind,
    installDays: body.install_days,
  });
  if (!stages) {
    return json({ error: "a date is needed, as YYYY-MM-DD", anchor_label: anchorLabel(kind) },
      400, origin);
  }

  const shape = {
    foundation: kind,
    anchor_label: anchorLabel(kind),
    stages: stages.map((s) => ({ ...s, label: STAGE_LABELS[s.item] || s.item })),
  };

  const { results: existing } = await env.DB.prepare(
    "SELECT id, item, install_date FROM installs WHERE submission_id = ?"
  ).bind(submissionId).all();

  if (!body.confirm) {
    return json({ ok: true, preview: true, replaces: (existing || []).length, ...shape }, 200, origin);
  }

  /* Replacing is the normal case — dates slip and the whole run moves — but
     it throws away what was booked, so it is never the default. The caller
     has to have seen how many rows it is about to lose. */
  if ((existing || []).length && !body.replace) {
    return json({ error: "this order already has " + existing.length +
      " booking(s). Confirm replacing them.", replaces: existing.length, ...shape }, 409, origin);
  }
  if ((existing || []).length) {
    await env.DB.prepare("DELETE FROM installs WHERE submission_id = ?").bind(submissionId).run();
  }

  const now = new Date().toISOString();
  for (const s of stages) {
    await env.DB.prepare(
      "INSERT INTO installs (submission_id, item, install_date, days, note, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(submissionId, s.item, s.install_date, s.days, body.note ? String(body.note).slice(0, 500) : null, now).run();
  }

  return json({ ok: true, booked: stages.length, replaced: (existing || []).length, ...shape }, 200, origin);
}

/* GET /admin/activity — what has happened lately, newest first.
 *
 * Three things a person actually wants to be told about, in one list:
 * money arriving, invoices going out, and someone new turning up. Each is
 * already recorded somewhere; what was missing was anywhere to see them
 * together. Without this, a Stripe payment lands in the CRM silently and the
 * only way to find out is to open the right customer and look.
 *
 * ?since — an ISO timestamp. Rows at or before it are still returned, but
 * flagged `unseen: false`, so the page can show a marker without a second
 * request and without the server keeping per-person read state.
 * ?limit — capped, because "everything since we started" is not a feed.
 */
async function handleActivity(request, env, origin) {
  await ensurePaymentsTable(env);
  await ensureInvoicesTable(env);

  const url = new URL(request.url);
  const since = String(url.searchParams.get("since") || "");
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 60;

  const [pays, invs, subs] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.amount, p.method, p.note, p.paid_at, p.created_at, p.submission_id,
              c.id AS customer_id, c.name AS customer_name
       FROM payments p JOIN customers c ON p.customer_id = c.id
       ORDER BY p.paid_at DESC, p.id DESC LIMIT ?`
    ).bind(limit).all(),
    env.DB.prepare(
      `SELECT i.id, i.kind, i.amount, i.status, i.created_at, i.paid_at, i.hosted_url,
              i.submission_id, c.id AS customer_id, c.name AS customer_name
       FROM invoices i JOIN customers c ON i.customer_id = c.id
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
    ).bind(limit).all(),
    env.DB.prepare(
      `SELECT s.id, s.details, s.created_at, s.status,
              c.id AS customer_id, c.name AS customer_name
       FROM submissions s JOIN customers c ON s.customer_id = c.id
       ORDER BY s.created_at DESC, s.id DESC LIMIT ?`
    ).bind(limit).all(),
  ]);

  const events = [];
  const at = (t) => String(t || "");

  (pays.results || []).forEach((p) => {
    events.push({
      kind: "payment",
      /* paid_at is when the money moved, which is what this feed is about —
         created_at is when someone got round to typing it in. */
      at: at(p.paid_at || p.created_at),
      id: "pay:" + p.id,
      customer_id: p.customer_id,
      customer_name: p.customer_name,
      submission_id: p.submission_id,
      amount: Number(p.amount),
      method: p.method,
      note: p.note || null,
    });
  });

  (invs.results || []).forEach((i) => {
    events.push({
      kind: "invoice_sent",
      at: at(i.created_at),
      id: "inv:" + i.id,
      customer_id: i.customer_id,
      customer_name: i.customer_name,
      submission_id: i.submission_id,
      amount: Number(i.amount),
      invoice_kind: i.kind,
      status: i.status,
      hosted_url: i.hosted_url || null,
    });
  });

  (subs.results || []).forEach((s) => {
    let details = {};
    try { details = JSON.parse(s.details) || {}; } catch (e) {}
    events.push({
      /* A consult is someone asking to be called, which needs a different
         reaction from a finished design — so they are not the same event. */
      kind: details.consult ? "consult" : "order",
      at: at(s.created_at),
      id: "sub:" + s.id,
      customer_id: s.customer_id,
      customer_name: s.customer_name,
      submission_id: s.id,
      summary: configSummary(details.config),
      amount: details.quotedPrice != null ? Number(details.quotedPrice) : null,
      best_time: details.bestTime || null,
      question: details.question || null,
      status: s.status,
    });
  });

  /* One merged stream. Sorting in JS rather than in SQL because these are
     three tables with no sensible UNION — and the lists are already capped. */
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out = events.slice(0, limit).map((e) => ({ ...e, unseen: since ? e.at > since : false }));

  return json({
    events: out,
    unseen: out.filter((e) => e.unseen).length,
    /* The newest timestamp in this batch, for the page to store as "seen".
       Taken from the data rather than from the clock, so an event written a
       moment after this query cannot be skipped over. */
    latest: out.length ? out[0].at : since || null,
  }, 200, origin);
}

/* GET /admin/schedule — every install, across every customer, by date.
 *
 * The same rows the customer page shows one job at a time. They were only
 * ever reachable by opening a customer and finding the right order card,
 * which answers "when is Hank's shed going in" and is no use at all for
 * "what is happening this week" — the question you actually have on a Sunday
 * night.
 *
 * ?from / ?to bound it by install date, inclusive, as plain YYYY-MM-DD. The
 * default is deliberately not "everything": a yard with two seasons of
 * history behind it would load a list nobody reads.
 */
async function handleSchedule(request, env, origin) {
  await ensureInstallsTable(env);
  await ensureSubmissionAdjustColumns(env);

  const url = new URL(request.url);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const from = day(url.searchParams.get("from"));
  const to = day(url.searchParams.get("to"));

  /* WON ORDERS ONLY.
     An install row outlives the order it belongs to: mark a won order lost,
     or replace it with a newer design, and the booking stays in the table.
     Without this filter the schedule kept sending someone to a job that was
     no longer happening — and because the customer page hides the install
     block on anything but a won order, the booking was invisible there and
     could not be removed either. It is filtered, not deleted: re-mark the
     order won and the date comes back exactly as it was. */
  const where = ["s.status = 'won'"];
  const args = [];
  if (from) { where.push("i.install_date >= ?"); args.push(from); }
  if (to) { where.push("i.install_date <= ?"); args.push(to); }

  const sql =
    `SELECT i.id, i.submission_id, i.item, i.install_date, i.days, i.note, i.created_at,
            c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
            c.phone AS customer_phone, c.address, c.city, c.state, c.zip,
            s.details, s.status AS order_status
     FROM installs i
     JOIN submissions s ON i.submission_id = s.id
     JOIN customers c ON s.customer_id = c.id` +
    " WHERE " + where.join(" AND ") +
    " ORDER BY i.install_date ASC, i.id ASC";

  const { results } = await env.DB.prepare(sql).bind(...args).all();

  const calGuests = String(env.INSTALL_CALENDAR_GUESTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const installs = (results || []).map((r) => {
    let details = {};
    try { details = JSON.parse(r.details) || {}; } catch (e) {}
    const summary = configSummary(details.config);
    const location = fullAddress(r);
    return {
      id: r.id,
      submission_id: r.submission_id,
      item: r.item,
      install_date: r.install_date,
      days: r.days,
      note: r.note,
      order_status: r.order_status,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      customer_phone: r.customer_phone,
      address: location,
      summary,
      /* The build's own price, not the customer's running total — this is a
         list of jobs, and what each one is worth is the useful figure. */
      quoted_price: details.quotedPrice != null ? Number(details.quotedPrice) : null,
      calendar_url: googleCalendarUrl({
        title: installTitle(r.item, r.customer_name),
        installDate: r.install_date,
        days: r.days,
        details: installDetails({ summary, phone: r.customer_phone, note: r.note,
                                  days: r.days, orderId: r.submission_id }),
        location,
        guests: (r.customer_email && isOnSite(r.item)) ? [r.customer_email].concat(calGuests) : calGuests,
      }),
    };
  });

  return json({ installs }, 200, origin);
}

/* Everything an invoice needs, gathered and priced, without sending anything.
   Shared by the preview and the send so the figures a person approves are the
   figures that go out — computing them twice would let the two drift. */
async function invoiceContext(env, submissionId, kind) {
  await ensurePaymentsTable(env);
  await ensureInvoicesTable(env);

  const sub = await env.DB.prepare(
    "SELECT id, customer_id, details, adjustments, price_adjustment, adjustment_note FROM submissions WHERE id = ?"
  ).bind(submissionId).first();
  if (!sub) throw Object.assign(new Error("no such submission"), { status: 404 });

  const customer = await env.DB.prepare(
    "SELECT * FROM customers WHERE id = ?"
  ).bind(sub.customer_id).first();
  if (!customer) throw Object.assign(new Error("that submission has no customer"), { status: 404 });

  let details = {};
  try { details = JSON.parse(sub.details) || {}; } catch (e) {}
  const breakdown = quoteLines(details.redline, adjustmentsOf(sub));
  if (!breakdown) throw Object.assign(new Error("this submission has no priced build to invoice"), { status: 400 });

  const { results: payRows } = await env.DB.prepare(
    "SELECT id, amount, method, note, paid_at, submission_id FROM payments WHERE customer_id = ? ORDER BY paid_at, id"
  ).bind(sub.customer_id).all();
  const split = splitPayments(payRows || [], sub.id);

  /* Everything the quote page puts around the numbers, handed to the invoice
     so the customer reads one document, not two that have to be compared:
     the adjustments with the notes written for them, the items thrown in
     free, and the size-and-style line off the design. */
  const adjustments = adjustmentsOf(sub);
  const invoice = buildInvoice(breakdown, kind, split.applied, {
    adjustments,
    comped: compedMap(details.redline, adjustments),
    summary: configSummary(details.config),
    submissionId: sub.id
  });
  return { sub, customer, breakdown, split, invoice };
}

/* POST /stripe/webhook — public, and the only thing standing between it and a
 * stranger marking an $11,000 shed paid is the signature check.
 *
 * The body is read as TEXT and verified before it is parsed. Parsing first and
 * re-serialising for the check would change key order and whitespace, and the
 * signature is over the bytes.
 */
async function handleStripeWebhook(request, env, origin) {
  const raw = await request.text();
  const verdict = await verifyStripeSignature(
    raw, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!verdict.ok) {
    /* 400 with nothing useful in it. Telling a caller WHICH part of their
       forgery failed is a hint they can work with; the reason stays here. */
    console.log("stripe webhook rejected:", verdict.reason);
    return json({ error: "bad signature" }, 400, origin);
  }

  let event = {};
  try { event = JSON.parse(raw); } catch (e) {
    return json({ error: "bad payload" }, 400, origin);
  }

  /* Anything not handled is acknowledged, not retried. Stripe backs off for
     three days on a non-2xx, and a queue of events we were never going to act
     on is noise that hides the ones we would. */
  if (event.type !== "invoice.paid") return json({ ok: true, ignored: event.type }, 200, origin);

  const inv = (event.data && event.data.object) || {};
  if (!inv.id) return json({ ok: true, ignored: "no invoice id" }, 200, origin);

  await ensureInvoicesTable(env);
  await ensurePaymentsTable(env);

  const row = await env.DB.prepare(
    "SELECT id, customer_id, submission_id, kind, status, amount FROM invoices WHERE stripe_invoice_id = ?"
  ).bind(inv.id).first();
  /* An invoice raised somewhere other than here — the Stripe dashboard, say.
     Acknowledged rather than errored: it is a real event, just not ours. */
  if (!row) return json({ ok: true, ignored: "unknown invoice " + inv.id }, 200, origin);

  const done = await recordInvoicePaid(env, row, inv.amount_paid);
  if (done.already) return json({ ok: true, already: true }, 200, origin);
  return json({ ok: true, recorded: done.amount }, 200, origin);
}

/* MARKING AN INVOICE PAID, IN ONE PLACE.
 *
 * Two things arrive here: the webhook Stripe sends, and the Check Stripe
 * button for when it did not. Two copies of "insert a payment and flip the
 * status" is how the same payment gets recorded twice, and a double-recorded
 * deposit makes the balance invoice under-bill by that amount.
 *
 * Idempotent on the invoice's own status, which is also what makes Stripe's
 * retries harmless — resends can be triggered by hand for 30 days. No separate
 * ledger of processed event ids to keep in step with anything.
 */
async function recordInvoicePaid(env, row, amountPaidCents) {
  if (row.status === "paid") return { already: true, amount: Number(row.amount) };

  /* What actually cleared, which is not always what was billed — a partial
     payment or a credit note changes it. Record what arrived. */
  const cents = Number(amountPaidCents);
  const amount = Number.isFinite(cents) && cents > 0 ? cents / 100 : Number(row.amount);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at, submission_id) VALUES (?,?,?,?,?,?,?)"
  ).bind(row.customer_id, amount, "stripe",
         row.kind === "deposit" ? "Deposit paid on Stripe" : "Balance paid on Stripe",
         now, now, row.submission_id).run();

  await env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?")
    .bind(now, row.id).run();

  return { already: false, amount };
}

/* POST /admin/invoices/:id/sync — ask Stripe what it thinks and believe it.
 *
 * A missed webhook leaves the CRM saying a customer has not paid when they
 * have, which is worse than most bugs: nothing looks broken, and the cost is
 * chasing someone who already sent you money. This is the button for that.
 * It reads from Stripe and writes only to our own row.
 */
async function handleSyncInvoice(request, env, origin, id) {
  await ensureInvoicesTable(env);
  await ensurePaymentsTable(env);
  const row = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "no such invoice" }, 404, origin);
  if (!row.stripe_invoice_id) {
    return json({ error: "this invoice was never sent to Stripe" }, 400, origin);
  }

  let live;
  try {
    live = await getInvoice(env, row.stripe_invoice_id);
  } catch (e) {
    /* Same reasoning as voiding: an invoice this key cannot see is one nobody
       can pay through it, so it is recorded as void rather than left sitting
       in the CRM as money owed. Self-correcting — if the key is later put
       right, the next check copies Stripe's real status back over. */
    const missing = e.status === 404 || e.stripeCode === "resource_missing";
    if (!missing) return json({ error: e.message || "Stripe would not answer" }, 502, origin);
    const changed = row.status !== "void";
    if (changed) {
      await env.DB.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").bind(row.id).run();
    }
    return json({ ok: true, status: "void", changed, unknown_to_stripe: true,
                  stripe_status: null }, 200, origin);
  }

  /* Backfill the pay link while we are here. Invoices raised before the field
     name was corrected have none stored, and Stripe has had it all along. */
  if (live.hostedUrl && live.hostedUrl !== row.hosted_url) {
    await env.DB.prepare("UPDATE invoices SET hosted_url = ? WHERE id = ?")
      .bind(live.hostedUrl, row.id).run();
  }
  /* Same for the recipient: invoices raised before the column existed have
     none recorded, and Stripe has known all along. */
  if (live.customerEmail && live.customerEmail !== row.sent_to) {
    await env.DB.prepare("UPDATE invoices SET sent_to = ? WHERE id = ?")
      .bind(live.customerEmail, row.id).run();
  }

  if (live.status === "paid") {
    const done = await recordInvoicePaid(env, row, live.amountPaidCents);
    return json({ ok: true, status: "paid", changed: !done.already,
                  recorded: done.amount, stripe_status: live.status }, 200, origin);
  }

  /* Anything else Stripe reports is copied across as-is, so a voided or
     written-off invoice stops showing as money still owed. `paid` is handled
     above and deliberately not reachable here — it is the only status that
     also has to write a payment row. */
  const COPY = ["open", "void", "uncollectible", "draft"];
  if (live.status && live.status !== row.status && COPY.includes(live.status)) {
    await env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?")
      .bind(live.status, row.id).run();
    return json({ ok: true, status: live.status, changed: true,
                  stripe_status: live.status }, 200, origin);
  }

  return json({ ok: true, status: row.status, changed: false,
                stripe_status: live.status }, 200, origin);
}

/* POST /admin/invoices — {submission_id, kind, preview?}
 *
 * preview computes and returns without touching Stripe. Worth having: this is
 * the one button in the system that asks a customer for money, and sending it
 * blind is how a wrong figure reaches someone who then has to be apologised to.
 */
async function handleCreateInvoice(request, env, origin, actor) {
  const body = await request.json().catch(() => ({}));
  const submissionId = Number(body.submission_id);
  const kind = String(body.kind || "").toLowerCase();
  if (!submissionId) return json({ error: "submission_id required" }, 400, origin);

  let ctx;
  try {
    ctx = await invoiceContext(env, submissionId, kind);
  } catch (e) {
    return json({ error: e.message }, e.status || 400, origin);
  }
  const { sub, customer, split, invoice } = ctx;

  /* Payments nobody attributed to a job. Not applied and not ignored — both
     are wrong in a way that costs a customer money — so they ride along on
     every response and the person sending decides. */
  const warnings = [];
  if (split.unassigned.length) {
    warnings.push({
      code: "unassigned_payments",
      count: split.unassigned.length,
      total: split.unassigned.reduce((t, p) => t + Number(p.amount || 0), 0),
      message: "This customer has payments not assigned to a job. They are NOT " +
               "credited on this invoice. Assign them first if they belong to this shed."
    });
  }

  /* Another invoice for this same shed, sent and not yet paid. The amount
     below does NOT credit it — buildInvoice nets off money actually received,
     which is the only honest basis for a bill — so the two outstanding at once
     ask for more than the job costs. Nearly always it just means the deposit
     has not cleared and the balance is early. Warned about rather than
     blocked: there are real reasons to have both out, and guessing wrong here
     silently changes what a customer is charged. */
  const { results: outstanding } = await env.DB.prepare(
    "SELECT id, kind, amount, hosted_url FROM invoices WHERE submission_id = ? AND kind != ? AND status NOT IN ('paid','void','draft_failed')"
  ).bind(sub.id, kind).all();
  (outstanding || []).forEach((o) => {
    const combined = Number(o.amount || 0) + fromCents(invoice.totalCents);
    warnings.push({
      code: "unpaid_invoice",
      kind: o.kind,
      amount: Number(o.amount || 0),
      combined,
      hosted_url: o.hosted_url || null,
      message: "The " + o.kind + " invoice for " + usd(o.amount) + " is still unpaid. This one does " +
               "not credit it, so the two together ask for " + usd(combined) + " on a " +
               usd(fromCents(invoice.jobTotalCents)) + " job. Wait for it to clear, or void it first."
    });
  });

  const shape = {
    kind, submission_id: sub.id, customer_id: customer.id,
    lines: invoice.lines.map((l) => ({ label: l.label, amount: fromCents(l.amountCents) })),
    amount: fromCents(invoice.totalCents),
    job_total: fromCents(invoice.jobTotalCents),
    already_paid: fromCents(invoice.paidCents),
    /* Returned on the preview too, so what the CRM shows before sending is
       the whole document and not just its numbers. */
    memo: invoice.memo,
    footer: invoice.footer,
    custom_fields: invoice.customFields,
    warnings
  };
  if (body.preview) return json({ ok: true, preview: true, ...shape }, 200, origin);

  /* One live invoice of a kind per shed. Voiding is how you replace one, and
     requiring that makes "I pressed it twice last week" impossible to do by
     accident — Stripe's idempotency only covers a 24 hour window. */
  const existing = await env.DB.prepare(
    "SELECT id, status, hosted_url FROM invoices WHERE submission_id = ? AND kind = ? AND status NOT IN ('void','draft_failed')"
  ).bind(sub.id, kind).first();
  if (existing && !body.replace_voided) {
    return json({ error: "a " + kind + " invoice for this shed already exists (" + existing.status + "). Void it first.",
                  existing_id: existing.id, hosted_url: existing.hosted_url }, 409, origin);
  }

  /* Counts every attempt including voided ones, so reissuing after a void gets
     a fresh key while a double-tapped button inside one attempt does not. */
  const prior = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invoices WHERE submission_id = ? AND kind = ?"
  ).bind(sub.id, kind).first();
  /* The content goes in the key. Without it a failed attempt locked the shed
     out for 24 hours the moment anything about the request changed — Stripe
     refuses a reused key with different parameters, and "different" includes
     a bug fix. A genuine double-tap still collapses to one invoice, because
     an unchanged request fingerprints the same. */
  const idempotencyKey = `sub${sub.id}:${kind}:${(prior && prior.n) || 0}:` + fingerprint({
    customer: customer.stripe_customer_id || customer.email || null,
    lines: shape.lines,
    amount: shape.amount,
    memo: invoice.memo,
    footer: invoice.footer,
    fields: invoice.customFields,
  });

  let stripeCustomerId = customer.stripe_customer_id || null;
  let sent;
  try {
    const cust = await ensureCustomer(env, {
      stripeCustomerId,
      name: customer.name || customer.contact_name || undefined,
      email: customer.email, phone: customer.phone || undefined,
    });
    if (cust.created) {
      stripeCustomerId = cust.id;
      await env.DB.prepare("UPDATE customers SET stripe_customer_id = ? WHERE id = ?")
        .bind(cust.id, customer.id).run();
    }
    sent = await createAndSendInvoice(env, {
      customerId: cust.id, lines: invoice.lines, kind,
      /* The memo is the build itemised the way the quote itemises it. Falls
         back to the old one-liner only if a submission has nothing to list. */
      description: invoice.memo ||
        `${kind === "deposit" ? "Deposit" : "Balance"} — shed order #${sub.id}`,
      footer: invoice.footer,
      customFields: invoice.customFields,
      idempotencyKey,
      metadata: { submission_id: String(sub.id), customer_id: String(customer.id), kind },
    });
  } catch (e) {
    return json({ error: e.message || "Stripe would not accept this invoice" }, 502, origin);
  }

  const now = new Date().toISOString();
  const sentTo = sent.customerEmail || customer.email || null;
  const row = await env.DB.prepare(
    `INSERT INTO invoices (customer_id, submission_id, kind, stripe_invoice_id, hosted_url,
       amount, status, lines, created_at, created_by, sent_to) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(customer.id, sub.id, kind, sent.id, sent.hostedUrl,
         fromCents(invoice.totalCents), sent.status || "open",
         JSON.stringify(shape.lines), now, (actor && actor.name) || null, sentTo).run();

  return json({ ok: true, id: row.meta.last_row_id, stripe_invoice_id: sent.id,
                hosted_url: sent.hostedUrl, status: sent.status || "open",
                sent_to: sentTo,
                ...shape }, 200, origin);
}

async function handleListInvoices(request, env, origin, customerId) {
  await ensureInvoicesTable(env);
  const { results } = await env.DB.prepare(
    `SELECT id, submission_id, kind, stripe_invoice_id, hosted_url, amount, status,
            lines, created_at, created_by, paid_at, sent_to
     FROM invoices WHERE customer_id = ? ORDER BY created_at DESC, id DESC`
  ).bind(customerId).all();
  const invoices = (results || []).map((r) => {
    let lines = [];
    try { lines = JSON.parse(r.lines) || []; } catch (e) {}
    return { ...r, lines };
  });
  return json({ invoices }, 200, origin);
}

/* Void, because a sent invoice cannot be edited — Stripe treats a finalized
   invoice as a legal document. Voiding here and in Stripe together, so the CRM
   never shows one state while the customer's copy shows another. */
async function handleVoidInvoice(request, env, origin, id) {
  await ensureInvoicesTable(env);
  const row = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "no such invoice" }, 404, origin);
  if (row.status === "paid") {
    return json({ error: "this invoice is already paid — refund it in Stripe instead of voiding" }, 409, origin);
  }
  let gone = false;
  if (row.stripe_invoice_id) {
    try {
      await voidInvoice(env, row.stripe_invoice_id);
    } catch (e) {
      /* An invoice Stripe has never heard of cannot be collected, so refusing
         to void it locally helps nobody — it just leaves a row that blocks
         reissuing, with no way out of the CRM.
         This is not hypothetical: invoices are per-environment, so every
         invoice raised in test mode is missing the moment the live key goes
         in. The row is marked void; the customer's copy, wherever it is, is
         untouched. */
      const missing = e.status === 404 || e.stripeCode === "resource_missing";
      if (!missing) return json({ error: e.message || "Stripe would not void it" }, 502, origin);
      gone = true;
    }
  }
  await env.DB.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").bind(id).run();
  return json({ ok: true, id, status: "void", unknown_to_stripe: gone }, 200, origin);
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

  /* Which shed this paid for. Optional, because a payment can arrive before
     anyone knows, and refusing it would push someone into not recording it at
     all — an unrecorded payment is worse than an unattributed one. But it is
     checked when given: a typo'd id would attach money to another customer's
     job, and the balance invoice would then credit the wrong person. */
  let submissionId = null;
  if (body.submission_id !== undefined && body.submission_id !== null && body.submission_id !== "") {
    submissionId = Number(body.submission_id);
    if (!Number.isFinite(submissionId)) return json({ error: "bad submission_id" }, 400, origin);
    const owns = await env.DB.prepare(
      "SELECT id FROM submissions WHERE id = ? AND customer_id = ?"
    ).bind(submissionId, customerId).first();
    if (!owns) return json({ error: "that build does not belong to this customer" }, 400, origin);
  }

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO payments (customer_id, amount, method, note, paid_at, created_at, submission_id) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(customerId, amount, method, note || null, paidAt, now, submissionId)
    .run();
  return json({ ok: true, id: res.meta.last_row_id }, 200, origin);
}

/* PUT the shed onto a payment that has none — or move one that went on the
   wrong job. Every payment taken before this existed is unattributed, and
   without a way to place them the invoice warning never clears and the balance
   is wrong forever. */
async function handleSetPaymentSubmission(request, env, origin, paymentId) {
  const body = await request.json().catch(() => ({}));
  await ensurePaymentsTable(env);

  const pay = await env.DB.prepare("SELECT id, customer_id FROM payments WHERE id = ?")
    .bind(paymentId).first();
  if (!pay) return json({ error: "no such payment" }, 404, origin);

  let submissionId = null;
  if (body.submission_id !== undefined && body.submission_id !== null && body.submission_id !== "") {
    submissionId = Number(body.submission_id);
    if (!Number.isFinite(submissionId)) return json({ error: "bad submission_id" }, 400, origin);
    const owns = await env.DB.prepare(
      "SELECT id FROM submissions WHERE id = ? AND customer_id = ?"
    ).bind(submissionId, pay.customer_id).first();
    if (!owns) return json({ error: "that build does not belong to this customer" }, 400, origin);
  }

  await env.DB.prepare("UPDATE payments SET submission_id = ? WHERE id = ?")
    .bind(submissionId, paymentId).run();
  return json({ ok: true, id: paymentId, submission_id: submissionId }, 200, origin);
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
  push(redline.porchDeckSellName, redline.porchDeckSell);
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
  /* ONE CUSTOMER, ONE DATA POINT.
     A customer working through ideas submits several times — that is normal
     and the rows are all real. But every figure derived from them was counted
     per SUBMISSION, so somebody who designed six sheds moved the average
     price six times, made their own favourite style look six times as popular
     and put six dots on the map at one address. The loudest customer set the
     numbers.
     Collected here and collapsed after the loop: the price is the MEAN of
     everything they quoted, because a customer who priced an $8k shed and a
     $14k shed is an $11k customer, not two customers. What they WANT — style,
     siding, size, where they heard about us, where they live — comes from
     their newest submission, since averaging a category is meaningless and
     the latest one is what they settled on.
     Won and lost deliberately stay per submission further down. Those are
     jobs with money attached, and averaging a sale would misreport revenue. */
  const perCustomer = new Map();
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

      /* results is ordered created_at DESC, so the FIRST row seen for a
         customer is their most recent one. A row with no customer_id (older
         data) is its own bucket, which leaves it counted exactly as before. */
      const ckey = row.customer_id != null ? "c" + row.customer_id : "row" + row.id;
      let cust = perCustomer.get(ckey);
      if (!cust) { cust = { newest: d, newestStatus: status, prices: [] }; perCustomer.set(ckey, cust); }
      if (price != null && isFinite(price)) cust.prices.push(price);
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
    }
  }

  /* The collapse. One entry per customer, their price the mean of everything
     they quoted. */
  for (const cust of perCustomer.values()) {
    const d = cust.newest;
    const config = (d && d.config) || {};
    if (config.style) styleCounts[config.style] = (styleCounts[config.style] || 0) + 1;
    if (config.siding) sidingCounts[config.siding] = (sidingCounts[config.siding] || 0) + 1;
    if (config.w && config.l) {
      const key = config.w + "x" + config.l;
      sizeCounts[key] = (sizeCounts[key] || 0) + 1;
    }
    if (d && d.heardAbout) {
      const key = d.heardAbout === "other" && d.heardAboutOther ? "other: " + d.heardAboutOther : d.heardAbout;
      heardCounts[key] = (heardCounts[key] || 0) + 1;
    }
    const mean = cust.prices.length
      ? cust.prices.reduce((a, b) => a + b, 0) / cust.prices.length
      : null;
    if (mean != null && isFinite(mean)) prices.push(mean);
    if (d && d.geo && d.geo.lat != null && d.geo.lng != null) {
      points.push({
        lat: d.geo.lat,
        lng: d.geo.lng,
        city: d.geo.city || null,
        region: d.geo.region || null,
        status: cust.newestStatus,
        // The dot carries what this customer is worth on average, not
        // whichever of their sheds happened to be saved last.
        price: mean != null && isFinite(mean) ? Math.round(mean) : null
      });
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
const SHED_PORCHDECK = ["none", "pt", "composite"];
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
/* THE SHED'S OWN DIMENSIONS, and the ONLY place they are written down.
   These were three literals inside the clamp below, and the designer's size
   sliders were three more in another repo's markup. Raising the sliders to
   22x34 without touching the clamp did not fail anywhere: the server quietly
   shrank every request to 20x32 and quoted THAT, so a customer configuring a
   22x34 was shown the price of a shed two feet smaller in each direction, with
   nothing on the page or in the response to say so.
   They are served to the client now (computeOptionPrices returns `limits`) and
   the designer sets its sliders from them, so this file is the one source and
   the two cannot drift apart again. */
const SHED_LIMITS = {
  w: { min: 6,  max: 26, def: 8,  step: 2 },
  l: { min: 6,  max: 34, def: 12, step: 2 },
  h: { min: 6,  max: 12, def: 8,  step: 1 }
};
/* THE PORCH DEPTHS OFFERED, and the only place they are written down.
   Exactly the trap SHED_LIMITS was written for, and it had already been
   sprung: the designer's depth ladder went to 10ft with the size bump while
   the two loops below still ran [4, 6, 8]. Nothing failed. A 10ft porch
   prices correctly in the TOTAL — that is computed per square foot — but the
   depth tile the customer taps had no price on it at all, because nothing
   ever computed one for a depth the server did not know was on offer.
   Served with the limits, and the designer renders exactly these. */
const PORCH_DEPTHS_FT = [4, 6, 8, 10];
function validateShedConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const lim = (k) => [SHED_LIMITS[k].min, SHED_LIMITS[k].max, SHED_LIMITS[k].def];
  return {
    style: enumOr(raw.style, SHED_STYLES, "gable"),
    w: clampNum(raw.w, ...lim("w")),
    l: clampNum(raw.l, ...lim("l")),
    h: clampNum(raw.h, ...lim("h")),
    pitch: clampNum(raw.pitch, 3, 12, 6),
    siding: enumOr(raw.siding, SHED_SIDING, "vertical"),
    roofType: enumOr(raw.roofType, SHED_ROOFTYPE, "shingle"),
    ovType: enumOr(raw.ovType, SHED_OVTYPE, "gable"),
    ovh: clampNum(raw.ovh, 0, 24, 4),
    porchLoc: enumOr(raw.porchLoc, SHED_PORCHLOC, "none"),
    porchDepth: clampNum(raw.porchDepth, 0, 20, 0),
    porchTier: typeof raw.porchTier === "string" ? raw.porchTier.slice(0, 60) : "standard",
    /* Whitelisted, not passed through. A client-supplied deck id now moves
       money, so anything not in the rate table has to land on the free
       default rather than reaching the engine — porchDeckLineFor charges
       nothing for an unknown id anyway, but a validator that lets an unknown
       value through is one rate-table edit away from being a way to pick a
       price. */
    porchDeck: enumOr(raw.porchDeck, SHED_PORCHDECK, "pt"),
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
  PORCH_DEPTHS_FT.filter((ft) => ft <= maxPorchFront).forEach((ft) => {
    const line = porchLineFor("front", ft, curTier, cfg.w);
    if (line) frontDepths[ft] = line.price;
  });
  const sideDepths = {};
  PORCH_DEPTHS_FT.filter((ft) => ft <= maxPorchSide).forEach((ft) => {
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
  /* Decking, priced for THIS porch. The designer's deck buttons used to carry
     no price because there was no charge to carry; the charge moved here off
     the invisible finish tiers, so the buttons need the number. Every deck id
     is listed, including the free ones, so the client can show "included"
     rather than having to know which ids are free. */
  const porchDeck = {};
  if (cfg.porchLoc === "front" || cfg.porchLoc === "side") {
    const span = cfg.porchLoc === "side" ? cfg.l : cfg.w;
    Object.keys(SELL.porchDeckSqft).forEach((id) => {
      const line = porchDeckLineFor(cfg.porchLoc, cfg.porchDepth, id, span);
      porchDeck[id] = line ? line.price : 0;
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
    skylight: "Skylight", stairs: "Stairs", statLadder: "Stationary Ladder", ramp: "Ramp",
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

  /* WHAT THE BAR LEDGE WOULD COST on each placed window, one entry per
     cfg.windows index, in dollars. Computed with the ledge forced ON so the
     On/Off control can price BOTH states — a tile that only knows the cost
     when the option is already selected cannot say what selecting it costs.
     A dollar amount per window, not the $/ft rate, for the same reason the
     shelving block above hands over amounts: the rate is ours. */
  const barLedge = (cfg.windows || []).map((wd) =>
    sellBarLedge(Object.assign({}, wd, { ledge: true })));

  return {
    /* The sizes the client is allowed to build, and the porch depths it may
       offer. Served rather than duplicated in the designer — see SHED_LIMITS
       and PORCH_DEPTHS_FT. */
    limits: Object.assign({ porchDepths: PORCH_DEPTHS_FT.slice() }, SHED_LIMITS),
    dormers: Object.assign({}, SELL.dormers),
    windows: windows,
    barLedge: barLedge,
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
    porch: { frontDepths: frontDepths, sideDepths: sideDepths, frontTiers: frontTiers,
             deck: porchDeck }
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
    ),
    /* PROJECT PHOTOS, one row per photo rather than an array inside payload.
       A sheet with ten photos in one column is a multi-megabyte row that has
       to be read in full every time anyone opens the client, just to see the
       answers. Separate rows mean the sheet loads at the size it always did
       and a photo is fetched only when it is looked at.

       The bytes live in D1 as a data URL. Not because that is how image
       storage should work - R2 is - but because R2 needs a bucket and a
       binding added in the dashboard, and this Worker is deployed by pasting
       a bundle, so a feature that depends on new plumbing is a feature that
       does not work until someone does the plumbing. The form downsizes to
       roughly 150KB a photo, so ten is about 1.5MB per sheet: fine for an
       onboarding form filled in a handful of times a month, and the obvious
       thing to move to R2 if that ever stops being true. */
    env.CRM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS client_intake_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intake_id INTEGER NOT NULL,
        client_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        mime TEXT,
        caption TEXT,
        data TEXT NOT NULL,
        bytes INTEGER,
        created_at TEXT NOT NULL
      )`
    )
  ]);

  /* Its own statement, not part of the batch above. An index cannot be
     PREPARED until the table it names exists, and a batch may prepare every
     statement before running any of them. */
  await env.CRM_DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_intake_photos_intake ON client_intake_photos (intake_id)"
  ).run();

  /* CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
     so anything added after the first deploy has to be an ALTER. D1 has no
     "ADD COLUMN IF NOT EXISTS" and a duplicate ADD throws, so read the table
     and add only what is missing. */
  for (const [table, cols] of [
    ["clients", [["owner", "TEXT"], ["owner_since", "TEXT"]]],
    ["client_calls", [["logged_by", "TEXT"]]],
    /* The deposit sits on the SHEET, not on the client. A client can send a
       second sheet for a second project, and "did we get paid" is a question
       about a project. deposit_received is 0/1 rather than a timestamp alone
       so that "marked, then un-marked" is distinguishable from "never
       marked" - someone will tick it by mistake. */
    ["client_intake", [["deposit_received", "INTEGER"], ["deposit_received_at", "TEXT"],
                       ["deposit_amount", "REAL"], ["deposit_note", "TEXT"],
                       ["deposit_marked_by", "TEXT"]]]
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
/* PHOTOS OFF A FORM ARE UNTRUSTED INPUT, so this decides what is acceptable
   rather than trusting what arrived:
     - at most MAX_INTAKE_PHOTOS, extras dropped rather than the sheet refused
     - each one a data: URL for an image type we are willing to serve back
     - each one under the cap, because a data URL is ~33% bigger than the
       bytes it carries and D1 will not take an unbounded string
   Anything that fails is skipped silently. A photo that cannot be stored must
   never cost the onboarding sheet it came with - the answers matter more than
   the pictures, and the form fires this without waiting for a reply. */
const MAX_INTAKE_PHOTOS = 10;
const MAX_INTAKE_PHOTO_CHARS = 700000;      // ~500KB of image
const INTAKE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function intakePhotos(body) {
  const raw = Array.isArray(body && body.project_photos) ? body.project_photos : [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_INTAKE_PHOTOS) break;
    const src = item && typeof item === "object" ? item : { data: item };
    const data = typeof src.data === "string" ? src.data : "";
    const m = /^data:(image\/[a-z+]+);base64,/i.exec(data);
    if (!m) continue;
    const mime = m[1].toLowerCase();
    if (INTAKE_PHOTO_TYPES.indexOf(mime) === -1) continue;
    if (data.length > MAX_INTAKE_PHOTO_CHARS) continue;
    out.push({
      mime,
      caption: crmStr(src.caption, 300) || null,
      data,
      // What the image actually weighs, for the CRM to show.
      bytes: Math.round((data.length - m[0].length) * 3 / 4)
    });
  }
  return out;
}

function intakeSummary(body, photoCount) {
  const trades = []
    .concat(body.trade || [], body.other_trade ? [body.other_trade] : [])
    .filter(Boolean);
  const bits = ["Contractor intake sheet received"];
  if (body.business_name) bits.push(String(body.business_name));
  if (trades.length) bits.push("Trades: " + trades.join(", "));
  if (body.service_area) bits.push("Service area: " + String(body.service_area));
  if (body.project_description) bits.push("Project: " + String(body.project_description).slice(0, 300));
  if (photoCount) bits.push(photoCount + (photoCount === 1 ? " photo" : " photos"));
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
  /* THE PHOTOS COME OUT BEFORE THE PAYLOAD IS BUILT, not after.
     payload is capped at 60,000 characters, and a single base64 photo is
     bigger than that on its own — leaving them in truncated the JSON mid
     string, so JSON.parse failed later and EVERY ANSWER on the sheet came
     back null. The pictures destroyed the answers. */
  const photos = intakePhotos(body);
  const answersOnly = Object.assign({}, body);
  delete answersOnly.project_photos;
  const payload = JSON.stringify(answersOnly).slice(0, 60000);

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

  const sheet = await env.CRM_DB.prepare(
    "INSERT INTO client_intake (client_id, payload, created_at) VALUES (?,?,?)"
  ).bind(client.id, payload, now).run();
  const intakeId = sheet && sheet.meta ? sheet.meta.last_row_id : null;

  if (intakeId && photos.length) {
    await env.CRM_DB.batch(photos.map((ph, i) =>
      env.CRM_DB.prepare(
        "INSERT INTO client_intake_photos (intake_id, client_id, idx, mime, caption, data, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(intakeId, client.id, i, ph.mime, ph.caption, ph.data, ph.bytes, now)
    ));
  }

  await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
    .bind(client.id, intakeSummary(body, photos.length), now).run();

  return json({ ok: true, id: client.id, created: created, photos: photos.length }, 200, origin);
}

/* READING A SHEET BACK. client_intake has been written since the form went
   up and never once read: no endpoint returned it and no page showed it. The
   contractor's answers went into the database and nobody could see them.
   Adding photos and a deposit flag to a sheet nobody can open would have been
   adding them to nothing. */
async function handleClientIntakeList(request, env, origin, clientId) {
  await ensureCrmTables(env);
  const { results } = await env.CRM_DB.prepare(
    `SELECT id, payload, created_at, deposit_received, deposit_received_at,
            deposit_amount, deposit_note, deposit_marked_by
     FROM client_intake WHERE client_id = ? ORDER BY created_at DESC`
  ).bind(clientId).all();

  /* Photo METADATA only. The bytes are fetched one at a time by the page, so
     opening a client with four sheets of ten photos does not move 60MB. */
  const { results: ph } = await env.CRM_DB.prepare(
    `SELECT id, intake_id, idx, mime, caption, bytes
     FROM client_intake_photos WHERE client_id = ? ORDER BY intake_id DESC, idx ASC`
  ).bind(clientId).all();

  const byIntake = {};
  for (const p of ph || []) (byIntake[p.intake_id] = byIntake[p.intake_id] || []).push(p);

  const sheets = (results || []).map((r) => {
    let answers = null;
    try { answers = JSON.parse(r.payload); } catch (e) {}
    /* The photos were stripped before storage, but a sheet saved before that
       could still carry them inside the payload — drop them here so the page
       never receives megabytes it did not ask for. */
    if (answers && answers.project_photos) delete answers.project_photos;
    return {
      id: r.id,
      created_at: r.created_at,
      answers,
      photos: byIntake[r.id] || [],
      deposit: {
        received: r.deposit_received === 1,
        at: r.deposit_received_at || null,
        amount: r.deposit_amount != null ? Number(r.deposit_amount) : null,
        note: r.deposit_note || null,
        marked_by: r.deposit_marked_by || null
      }
    };
  });
  return json({ sheets }, 200, origin);
}

async function handleIntakePhoto(request, env, origin, photoId) {
  await ensureCrmTables(env);
  const row = await env.CRM_DB.prepare(
    "SELECT mime, data FROM client_intake_photos WHERE id = ?"
  ).bind(photoId).first();
  if (!row) return json({ error: "Not found" }, 404, origin);
  return json({ mime: row.mime, data: row.data }, 200, origin);
}

async function handleIntakeDeposit(request, env, origin) {
  await ensureCrmTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.intake_id);
  if (!id) return json({ error: "intake_id required" }, 400, origin);

  const received = body.received === true || body.received === 1 || body.received === "1";
  const amount = body.amount === "" || body.amount == null ? null : Number(body.amount);
  if (amount != null && !isFinite(amount)) return json({ error: "amount must be a number" }, 400, origin);

  const existing = await env.CRM_DB.prepare(
    "SELECT client_id, deposit_received, deposit_received_at FROM client_intake WHERE id = ?"
  ).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404, origin);

  /* Keep the ORIGINAL date when it is already marked. Re-saving the amount or
     a note should not quietly move the day the money arrived. */
  const at = received
    ? (existing.deposit_received === 1 && existing.deposit_received_at
        ? existing.deposit_received_at
        : new Date().toISOString())
    : null;

  await env.CRM_DB.prepare(
    `UPDATE client_intake SET deposit_received = ?, deposit_received_at = ?,
       deposit_amount = ?, deposit_note = ?, deposit_marked_by = ? WHERE id = ?`
  ).bind(received ? 1 : 0, at, received ? amount : null,
         received ? (crmStr(body.note, 500) || null) : null,
         received ? (crmStr(body.by, 120) || null) : null, id).run();

  /* On the timeline too. A deposit landing is the kind of thing someone will
     look for in the history rather than on a panel. */
  if (received) {
    const amt = amount != null ? " (" + amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) + ")" : "";
    await env.CRM_DB.prepare("INSERT INTO client_notes (client_id, text, created_at) VALUES (?,?,?)")
      .bind(existing.client_id, "Deposit received" + amt, new Date().toISOString()).run();
  }

  return json({ ok: true, received, at, amount: received ? amount : null }, 200, origin);
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
      /* Public by necessity — Stripe cannot log in. The signature is the
         auth, and there is no rate limit because a flood of unsigned posts is
         rejected before any database work happens. */
      if (path === "/stripe/webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env, origin);
      }
      if (path.startsWith("/admin/submissions/") && path.endsWith("/plan") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const pid = Number(path.slice("/admin/submissions/".length, -"/plan".length));
        if (!pid) return json({ error: "bad order id" }, 400, origin);
        return await handlePlanBuild(request, env, origin, pid);
      }
      if (path === "/admin/activity" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleActivity(request, env, origin);
      }
      if (path === "/admin/schedule" && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleSchedule(request, env, origin);
      }
      if (path === "/admin/invoices" && request.method === "POST") {
        const who = await requireAuth(request, env);
        if (!who) return json({ error: "Unauthorized" }, 401, origin);
        return await handleCreateInvoice(request, env, origin, who);
      }
      if (path.startsWith("/admin/customers/") && path.endsWith("/invoices") && request.method === "GET") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const cid = Number(path.split("/")[3]);
        if (!cid) return json({ error: "bad customer id" }, 400, origin);
        return await handleListInvoices(request, env, origin, cid);
      }
      if (path.startsWith("/admin/invoices/") && path.endsWith("/sync") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const sid = Number(path.split("/")[3]);
        if (!sid) return json({ error: "bad invoice id" }, 400, origin);
        return await handleSyncInvoice(request, env, origin, sid);
      }
      if (path.startsWith("/admin/invoices/") && path.endsWith("/void") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const iid = Number(path.split("/")[3]);
        if (!iid) return json({ error: "bad invoice id" }, 400, origin);
        return await handleVoidInvoice(request, env, origin, iid);
      }
      if (path.startsWith("/admin/payments/") && path.endsWith("/submission") && request.method === "POST") {
        if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const pid = Number(path.split("/")[3]);
        if (!pid) return json({ error: "bad payment id" }, 400, origin);
        return await handleSetPaymentSubmission(request, env, origin, pid);
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
      if (path.startsWith("/crm/clients/") && path.endsWith("/intake") && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const cid = Number(path.slice("/crm/clients/".length, -"/intake".length));
        if (!cid) return json({ error: "Invalid id" }, 400, origin);
        return await handleClientIntakeList(request, env, origin, cid);
      }
      if (path.startsWith("/crm/intake/photo/") && request.method === "GET") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        const pid = Number(path.slice("/crm/intake/photo/".length));
        if (!pid) return json({ error: "Invalid id" }, 400, origin);
        return await handleIntakePhoto(request, env, origin, pid);
      }
      if (path === "/crm/intake/deposit" && request.method === "POST") {
        if (!(await requireCrmAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
        return await handleIntakeDeposit(request, env, origin);
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
