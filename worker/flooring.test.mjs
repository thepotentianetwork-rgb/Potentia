/* Flooring tiers: sell rate derived from cost at a TRUE 30% margin, with a job
   minimum, and the same price whether the shed sits on plywood or concrete.
   Run: node --experimental-sqlite worker/flooring.test.mjs */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
import { FLOORING, FLOORING_NAMES, flooringSellRateCents, flooringSellMinCents, flooringPrice } from "./pricing.js";
const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db){
  function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
    return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); },
      all(){ return {results:st.all(...a)}; },
      run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a);
             return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; }, async batch(st){ return st.map(x=>x.run()); } };
}
const db=new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env={DB:makeD1(db),CRM_DB:makeD1(new DatabaseSync(":memory:")),
           ADMIN_PASSWORD:"pw",CRM_PASSWORD:"c",ADMIN_SESSION_SECRET:"k"};
let fails=0;
const check=(n,cond,x)=>{ if(cond) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };

console.log("\n-- the sell prices on the price sheet --");
check("Better is $7.95 / sq ft", flooringSellRateCents("better")===795, flooringSellRateCents("better"));
check("Best is $9.95 / sq ft",   flooringSellRateCents("best")===995,   flooringSellRateCents("best"));
check("Better minimum is $1,195",flooringSellMinCents("better")===119500,flooringSellMinCents("better"));
check("Best minimum is $1,495",  flooringSellMinCents("best")===149500,  flooringSellMinCents("best"));

/* SEALING IS NOT SOLD HERE. It is sold on the Foundation step as
   SELL.foundationFinish.coated. It was briefly offered in both places at two
   different prices, and nothing stopped a customer buying both — $590 to seal
   one slab, on two quote lines. These are the checks that keep it in one
   place. */
console.log("\n-- sealing belongs to the Foundation step, not here --");
check("there is no sealed tier", FLOORING.tiers.good===undefined);
check("and asking for one costs nothing", flooringPrice("good", 160)===0, flooringPrice("good", 160));

/* A TRUE margin divides by (1 - margin). Multiplying by 1.30 is the mistake
   this guards: it would rate Good at $1.63, a 23% margin, and nothing about
   the number would look wrong. */
console.log("\n-- margin is cost / (1 - margin), not cost x 1.30 --");
for (const t of ["better","best"]) {
  const rate = flooringSellRateCents(t), cost = FLOORING.tiers[t].costSqftCents;
  const realised = (rate - cost) / rate;
  check(`${t}: realised margin is at least 30%`, realised >= 0.30,
    {cost, rate, margin: +(realised*100).toFixed(1)});
  check(`${t}: and is not wildly over (a x1.30 slip would read 23%)`, realised < 0.34,
    {margin: +(realised*100).toFixed(1)});
}

console.log("\n-- the spec's test-case table, exactly --");
const TABLE = [
  ["8x10",   80,  1195, 1495],
  ["10x16", 160,  1272, 1592],
  ["12x24", 288,  2290, 2866],
];
for (const [shed, area, better, best] of TABLE) {
  check(`${shed} (${area} sq ft) Better = $${better}`, flooringPrice("better", area)===better, flooringPrice("better", area));
  check(`${shed} (${area} sq ft) Best = $${best}`,   flooringPrice("best", area)===best,     flooringPrice("best", area));
}
check("Standard costs nothing at any size", [80,160,288,900].every(a=>flooringPrice("none",a)===0));
check("the minimum is a floor, not a fee — a big shed pays by area",
  flooringPrice("better", 288) > flooringSellMinCents("better")/100);

async function price(extra){
  const res=await worker.fetch(new Request("https://x/shed/quote",{method:"POST",
    headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json","CF-Connecting-IP":"5.5.5.5"},
    body:JSON.stringify({config:Object.assign({style:"gable",w:10,l:16,h:9},extra)})}),env);
  const j=await res.json(); return j;
}
console.log("\n-- it reaches the quote, and only when chosen --");
const qNone=await price({}), qBetter=await price({floor:"better"});
check("choosing Better adds exactly its price to the total",
  Math.round(qBetter.total-qNone.total)===1272, {none:Math.round(qNone.total), better:Math.round(qBetter.total)});
const qExplicitNone=await price({floor:"none"});
check("Standard adds nothing", Math.round(qExplicitNone.total)===Math.round(qNone.total));
const qJunk=await price({floor:"marble"});
check("a tier we do not sell adds nothing rather than throwing",
  Math.round(qJunk.total)===Math.round(qNone.total), {junk:Math.round(qJunk.total)});
const qOld=await price({floor:"good"});
check("and a preview link saved while the sealed tier existed prices as Standard",
  Math.round(qOld.total)===Math.round(qNone.total), {old:Math.round(qOld.total)});

/* The double-charge itself. Sealing a pad must cost the same whether or not a
   floor tier is also chosen. */
console.log("\n-- sealing a pad is billed once --");
const sealBase=await price({foundation:"pad"});
const sealed  =await price({foundation:"pad", foundationFinish:"coated"});
const sealedPlus=await price({foundation:"pad", foundationFinish:"coated", floor:"good"});
check("Stained & Sealed Coating costs $300", Math.round(sealed.total-sealBase.total)===300,
  Math.round(sealed.total-sealBase.total));
check("and asking for a sealed FLOOR on top adds nothing",
  Math.round(sealedPlus.total)===Math.round(sealed.total),
  {sealed:Math.round(sealed.total), both:Math.round(sealedPlus.total)});

console.log("\n-- the foundation does not change the flooring price --");
for (const f of ["blocks","gravel","pad","existing"]) {
  const a=await price({floor:"better",foundation:f}), b=await price({foundation:f});
  check(`on ${f}: Better still costs $1,272`, Math.round(a.total-b.total)===1272,
    {diff:Math.round(a.total-b.total)});
}

console.log("\n-- a porch is not floored --");
/* 12x16 with a 4ft front porch has a 12x12 room. Billing the footprint would
   charge 192 sq ft of plank for 144 sq ft of floor. */
async function priceWL(cfg){
  const res=await worker.fetch(new Request("https://x/shed/quote",{method:"POST",
    headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json","CF-Connecting-IP":"5.5.5.5"},
    body:JSON.stringify({config:cfg})}),env);
  return (await res.json()).total;
}
const base={style:"gable",w:12,l:16,h:9};
const porch={porchLoc:"front",porchDepth:4};
const pNo  = await priceWL(Object.assign({},base,porch));
const pYes = await priceWL(Object.assign({},base,porch,{floor:"better"}));
check("the 12x12 room is billed, not the 12x16 footprint",
  Math.round(pYes-pNo)===flooringPrice("better",144),
  {charged:Math.round(pYes-pNo), room:flooringPrice("better",144), footprint:flooringPrice("better",192)});

console.log("\n-- option prices for the cards --");
const op=(await price({})).optionPrices||{};
check("the client is handed a dollar amount per tier", op.flooring && op.flooring.better===1272, op.flooring);
check("and is offered no sealed tier to render", op.flooring && op.flooring.good===undefined, op.flooring);
check("and the area it was worked out from", op.flooring && op.flooring.areaSqft===160, op.flooring);
/* The whole reason pricing is server-side: the browser must never be able to
   read what we pay, or the rate we mark it up by. */
/* Scoped to the flooring block: other option prices legitimately contain
   numbers that would trip a whole-payload regex, and an assertion that fails
   for an unrelated reason is worse than no assertion. */
const fbody=JSON.stringify(op.flooring||{});
check("but never the cost per sq ft", !/555|695|125/.test(fbody), fbody);
check("and never the margin or the rate", !/marginBp|3000|795|995|180/.test(fbody), fbody);
check("nothing anywhere in the response names the cost block",
  !/marginBp|costSqftCents|costMinCents|FLOORING/.test(JSON.stringify(op)));

console.log("\n-- the quote line names the tier and the area --");
const tok=await (await worker.fetch(new Request("https://x/admin/login",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json"},
  body:JSON.stringify({password:"pw"})}),env)).json();
const rl=await (await worker.fetch(new Request("https://x/shed/quote?redline=1",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json",Authorization:"Bearer "+tok.token,"CF-Connecting-IP":"5.5.5.5"},
  body:JSON.stringify({config:{style:"gable",w:10,l:16,h:9,floor:"better"}})}),env)).json();
const labels=JSON.stringify(rl.redline||{});
check("the line reads Flooring — Luxury Vinyl Plank (160 sq ft)",
  /Flooring\s*—\s*Luxury Vinyl Plank\s*\(160 sq ft\)/.test(labels), labels.slice(0,260));
const rlNone=await (await worker.fetch(new Request("https://x/shed/quote?redline=1",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json",Authorization:"Bearer "+tok.token,"CF-Connecting-IP":"5.5.5.5"},
  body:JSON.stringify({config:{style:"gable",w:10,l:16,h:9}})}),env)).json();
check("and there is no flooring line at all on a Standard floor",
  !/Flooring/.test(JSON.stringify(rlNone.redline||{})));

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
