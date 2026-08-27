// Potentia backend Worker — serves two things from one place:
//  1. /chat            — the AI assistant widget (assistant.js)
//  2. /admin/*          — password-gated dashboard for the shed company
//                         partner: view submissions, edit pricing
//     /shed/pricing     — public: current pricing (for their site to read)
//     /shed/submit      — public: customer design submissions land here
//
// See README.md for full deployment steps (secrets, D1 database, etc).
//
// worker/pricing.js holds the whole SELL/COST pricing engine — it never
// ships to a browser. This is a static import (not per-request dynamic
// import) so it's evaluated once when the isolate boots, same as every
// other module-level const here.

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
    LOFT='none', ELEC='none', INT_FINISH='none',
    ADDONS={ shutters:false, flowerboxes:false, cupola:'none',
      skylight:false, stairs:false, statLadder:false, atticLadder:false,
      weatherGuard:false, radiantBarrier:false, houseWrap:false, hurricaneTies:false,
      doorAwning:false, fbColor:'brown', shutterColor:'brown' },
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
  LOFT='none'; ELEC='none'; INT_FINISH='none';
  ADDONS={ shutters:false, flowerboxes:false, cupola:'none',
    skylight:false, stairs:false, statLadder:false, atticLadder:false,
    weatherGuard:false, radiantBarrier:false, houseWrap:false, hurricaneTies:false,
    doorAwning:false, fbColor:'brown', shutterColor:'brown' };
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

/* ═══════════════════════════════════════════════════════════════════════
   ★★★  CUSTOMER SELL PRICES  (from Shed Pro Client Workbook, Jul 2026)  ★★★
   What the CUSTOMER pays — upcharges & option prices, NOT your cost.
   Customer price = base(by size) + these upcharges.  Profit = customer − cost.
   ⚠️ Not yet live on the customer number: needs the base-by-size table
      (SELL.baseSheets below) and, for most add-ons, a select button in the UI.
   Per-sqft items note their AREA BASIS — wall / floor / roof / own-size.
   ═══════════════════════════════════════════════════════════════════════ */
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
  // blocks levelling PLUS pouring gravel over the site first, flat $500.
  foundation: { pad: 3000, blocks: 0, existing: 0, gravel: 500 },

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

  /* ── EXTERIOR PAINT (per sqft of WALL AREA, tiered by wall sqft) ──
     Covers the LP SmartSide siding AND the trim in one rate — trim area
     is small enough next to the walls that pricing it separately isn't
     worth the extra line item. Fernando, 24 Aug 2026:
       under 100 sqft ....... $4/sqft
       100 up to 200 sqft ... $5/sqft
       200 sqft and over .... $7/sqft
     Boundaries inclusive at the bottom, same convention as every other
     tier table here: exactly 100 pays the mid rate, exactly 200 pays over.
     NOT charged for pine siding — pine gets STAINED, a separate mandatory
     finish step (see siding.pine above), never painted. */
  exteriorPaint: { under: 4, mid: 5, over: 7, breakLo: 100, breakHi: 200 },

  // ── ELECTRICAL PACKAGES (flat) ──
  electrical: {
    "Basic": 840, "Standard": 1500, "Core": 2300, "Essential": 3000,
    "Standard (a la carte)": 500, "Exterior Light": 150
  },

  // ── ADDITIONAL OPTIONS ──
  options: {
    flat: {   // fixed price each
      "Shutters": 60, "Flowerboxes": 90,
      "Roof Ridge Vent": 263, "8x16 Gable/Wall Vent": 30, "Roof Vent": 53,
      "Cupola 16\" Black Roof": 600, "Cupola 16\" Copper Roof": 600,
      "Skylight": 184, "Stairs": 420, "Stationary Ladder": 105, "Attic Pull-Down Ladder": 375
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
function sellDoorUpcharge(dd){
  var m=sellDoorName(dd), t=SELL.doors;
  if(t[m.key]!=null) return t[m.key];
  if(m.panel4 && t[m.base+" (4-Panel)"]!=null) return t[m.base+" (4-Panel)"]; // naming variant
  if(t[m.base]!=null) return t[m.base];   // fall back to the plain-door upcharge
  return 0;
}
// Convenience: the readable label for the redline.
var _sellDoorNameStr = function(dd){ return sellDoorName(dd).key; };

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
function computePricing(cfgIn, opts){
  // cfgIn drives the module-level build-config state (STYLE/W/L/H/...);
  // opts is the separate, pre-existing margin/mileage/diesel override used
  // by the admin redline sliders — kept as its own parameter rather than
  // folded into cfgIn since it overrides DEFAULTS, not the build itself.
  resetConfig();
  setConfig(cfgIn);
  opts = opts || {};
  var cfg = {
    marginTarget: opts.marginTarget!=null?opts.marginTarget:DEFAULTS.marginTarget,
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
      if(up>0){ doorUpcharge += up; doorUpLines.push({label:sellDoorName(dd).key, up:up}); }
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
    var _paintSqft = wallAreaFt(Wf, Df, Hf);
    var pt = SELL.exteriorPaint;
    var paintRate = (_paintSqft>=pt.breakHi) ? pt.over : (_paintSqft>=pt.breakLo) ? pt.mid : pt.under;
    paintSell = paintRate * _paintSqft;
    paintSellName = 'Exterior Paint ('+Math.round(_paintSqft)+' sqft)';
  }
  customerPrice += paintSell;

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

  // ── ELECTRICAL PACKAGE (customer): flat price by tier ──
  var elecSell = 0, elecSellName = '';
  var elecId = (typeof ELEC!=='undefined')?ELEC:'none';
  var ELEC_MAP = { basic:'Basic', standard:'Standard', core:'Core', essential:'Essential' };
  if(ELEC_MAP[elecId] && SELL.electrical[ELEC_MAP[elecId]]!=null){
    elecSell = SELL.electrical[ELEC_MAP[elecId]];
    elecSellName = ELEC_MAP[elecId]+' Electrical';
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
    foundSell = SELL.foundation.gravel||0;
    foundName = 'Gravel Pad + Leveled on Cinder Blocks';
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
      heightSell: heightSell, heightSellName: heightSellName,
      windowSell: windowSell, windowSellLines: windowSellLines,
      intSell: intSell, intSellName: intSellName,
      elecSell: elecSell, elecSellName: elecSellName,
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
function applyPricingOverrides(o){
  if(!o || typeof o!=='object') return;
  if(o.baseSheets) SELL.baseSheets=o.baseSheets;
  if(o.COST) Object.keys(o.COST).forEach(function(k){ COST[k]=o.COST[k]; });
  if(o.DEFAULTS) Object.keys(o.DEFAULTS).forEach(function(k){ DEFAULTS[k]=o.DEFAULTS[k]; });
  if(o.SELL){
    ['doors','windows','siding','exteriorPaint','electrical','dormers','wallHeight',
     'porchFrontSqft','porchSideSqft','interior','foundation','foundationFinish','broomTiers'].forEach(function(group){
      if(o.SELL[group]) Object.keys(o.SELL[group]).forEach(function(k){
        SELL[group][k]=o.SELL[group][k];
      });
    });
    if(o.SELL.options){
      ['flat', 'perLinFt'].forEach(function(sub){
        if(o.SELL.options[sub]) Object.keys(o.SELL.options[sub]).forEach(function(k){
          SELL.options[sub][k]=o.SELL.options[sub][k];
        });
      });
      var incomingSqft=o.SELL.options.perSqft;
      if(incomingSqft) Object.keys(incomingSqft).forEach(function(k){
        SELL.options.perSqft[k]=incomingSqft[k];
      });
    }
  }
}

// ---- end inlined pricing.js ----


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

const SYSTEM_PROMPT = `You are the AI assistant embedded on the Potentia Studio website (a small web design & digital growth studio). Potentia builds custom, hand-built websites — no templates, no bloated platforms. 72-hour turnaround, free domain included for the first year.

Packages:
01 — Foundation: 3-Page Essential Site. Home, About & Contact pages, 5 images, free domain (1 year). One-time build, no monthly subscription (edits after the first 7 days are billed per change request).
02 — Booking: 3-Page Booking Site. Everything in Foundation, plus a live booking calendar. Includes a monthly plan for ongoing management & edits.
03 — Gallery: 4-Page Gallery Site. 15-photo gallery page, 1 featured video, free domain (1 year). Includes a monthly plan to edit, manage & update photos.
04 — Operator: Website + Growth System. Everything in Gallery, plus an AI chat assistant (like this one!), instant lead alerts, a built-in CRM, and a monthly performance report. Includes a monthly plan for the growth system & ongoing management.

Add-ons: Promotional Video, Google Business Setup, Google Profile Management (monthly), AI Content Engine (monthly), Professional Photography, Logo Vectorization, Service Menu Design.

Important: Potentia does not publish prices publicly — every quote is custom. NEVER state or guess a dollar amount, even if asked directly or pressured. If asked about cost, explain that pricing is tailored to the project and invite them to share project details on the contact page or by calling/texting (435) 277-0764; Potentia responds within 24 hours.

Be warm, concise, and confident — a few sentences at most. You are a live example of what Potentia builds (the Operator package's AI assistant), so when it's natural you can mention that this chat is itself a sample of that add-on. Don't be pushy. If asked something unrelated to Potentia or web design, answer briefly and steer back.`;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return await verifyToken(env.ADMIN_SESSION_SECRET, token);
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
    await env.DB.prepare(
      "UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?, updated_at = ? WHERE id = ?"
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

// ---- /admin/customers: one row per customer, with their latest order + note ----
async function handleListCustomers(request, env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.city, c.state, c.created_at, c.updated_at,
       (SELECT s.id FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_id,
       (SELECT s.details FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_details,
       (SELECT s.status FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_status,
       (SELECT s.created_at FROM submissions s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS latest_submission_at,
       (SELECT COUNT(*) FROM submissions s WHERE s.customer_id = c.id AND s.status != 'superseded') AS submission_count,
       (SELECT n.text FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
       (SELECT n.created_at FROM notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_at
     FROM customers c
     ORDER BY latest_submission_at DESC
     LIMIT 200`
  ).all();

  const customers = results.map((c) => {
    let quotedPrice = null;
    try {
      const d = JSON.parse(c.latest_details);
      if (d && d.quotedPrice != null) quotedPrice = d.quotedPrice;
    } catch (e) {}
    const { latest_details, ...rest } = c;
    return { ...rest, latest_quoted_price: quotedPrice };
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
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  const { results: submissions } = await env.DB.prepare(
    "SELECT id, details, status, created_at FROM submissions WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(id)
    .all();

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

  return json({ customer, submissions, notes, payments, installs }, 200, origin);
}

// ---- DELETE /admin/customers/:id — permanently removes the customer and
// every submission/note/payment tied to them. No soft-delete: the admin UI
// requires typing the customer's name plus a second confirm before this
// ever fires.
async function handleDeleteCustomer(request, env, origin, id) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, origin);

  await ensurePaymentsTable(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes WHERE customer_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE customer_id = ?").bind(id),
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
  const submission = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!submission) return json({ error: "Not found" }, 404, origin);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(submission.customer_id).first();
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

async function handleUpdateSubmissionStatus(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status || "").slice(0, 40);
  if (!id || !status) return json({ error: "id and status required" }, 400, origin);
  await env.DB.prepare("UPDATE submissions SET status = ? WHERE id = ?").bind(status, id).run();
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
  if (body.config) {
    try {
      const { result } = await computeQuoteResult(body.config, undefined, env);
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

// ---- /admin/analytics: aggregated stats + geo points for the data dashboard ----
async function handleAnalytics(request, env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT customer_id, details, status, created_at FROM submissions ORDER BY created_at DESC LIMIT 3000"
  ).all();

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
      const price = d.quotedPrice != null ? Number(d.quotedPrice) : null;
      if (price != null && isFinite(price)) prices.push(price);
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

  return json(
    {
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
  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  if (!row) return json({}, 200, origin);
  let data;
  try {
    data = JSON.parse(row.data);
  } catch (e) {
    data = {};
  }
  return json(data, 200, origin);
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
const SHED_ELEC = ["none", "basic", "standard", "core", "essential"];
const SHED_INT_FINISH = ["none", "drywall", "painted"];

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
    foundation: Object.assign({}, SELL.foundation),
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
async function computeQuoteResult(rawConfig, overrides, env) {
  const cfg = validateShedConfig(rawConfig);

  const row = await env.DB.prepare("SELECT data FROM pricing_config WHERE id = 1").first();
  if (row) {
    let saved;
    try {
      saved = JSON.parse(row.data);
    } catch (e) {
      saved = null;
    }
    if (saved) applyPricingOverrides(saved);
  }

  const opts = overrides && typeof overrides === "object" ? overrides : undefined;
  const result = computePricing(cfg, opts);
  return { cfg, result };
}

async function handleShedQuote(request, env, origin) {
  const body = await request.json().catch(() => ({}));

  let cfg, result;
  try {
    ({ cfg, result } = await computeQuoteResult(body.config, body.overrides, env));
  } catch (e) {
    return json({ error: "Could not price this build" }, 400, origin);
  }

  const url = new URL(request.url);
  const wantsRedline = url.searchParams.get("redline") === "1";
  if (wantsRedline) {
    if (!(await requireAuth(request, env))) return json({ error: "Unauthorized" }, 401, origin);
    return json({ total: result.customer, redline: result.redline }, 200, origin);
  }

  return json({ total: result.customer, optionPrices: computeOptionPrices(cfg) }, 200, origin);
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
      if (path === "/chat" && request.method === "POST") {
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

      if (path === "/shed/pricing" && request.method === "GET") {
        return await handlePublicPricing(request, env, origin);
      }
      if (path === "/shed/submit" && request.method === "POST") {
        return await handleShedSubmit(request, env, origin);
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
        return await handleShedQuote(request, env, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Server error", detail: String(e) }, 500, origin);
    }
  }
};
