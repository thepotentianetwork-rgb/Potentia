// Roll-up door colour pricing: white is stock, black and brown are +$100 flat.
// Run: node --experimental-sqlite worker/rollup.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
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
async function price(doors){
  const res=await worker.fetch(new Request("https://x/shed/quote",{method:"POST",
    headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json","CF-Connecting-IP":"5.5.5.5"},
    body:JSON.stringify({config:{style:"gable",w:12,l:16,h:9,doors:doors}})}),env);
  const j=await res.json(); return j.total;
}
const rollup = (w,color) => [{wall:"front",pos:0.5,style:"rollup",w:w,h:84,color:color}];

console.log("\n-- white is the stock finish, and costs what it always did --");
const w8=await price(rollup(96,"white"));
const wNone=await price(rollup(96));            // no colour stated at all
check("an 8ft white door prices", w8>0, w8);
check("omitting the colour prices the same as white", Math.round(w8)===Math.round(wNone), {w8,wNone});

console.log("\n-- black and brown are +$100 --");
const b8=await price(rollup(96,"black"));
const br8=await price(rollup(96,"brown"));
check("black is exactly $100 over white", Math.round(b8-w8)===100, {white:Math.round(w8), black:Math.round(b8), diff:Math.round(b8-w8)});
check("brown is exactly $100 over white", Math.round(br8-w8)===100, {diff:Math.round(br8-w8)});
check("black and brown cost the same as each other", Math.round(b8)===Math.round(br8));

console.log("\n-- the upcharge is flat, not scaled by door size --");
for (const [w,label] of [[72,"6ft"],[84,"7ft"],[96,"8ft"]]) {
  const white=await price(rollup(w,"white")), black=await price(rollup(w,"black"));
  check(`${label}: +$100 regardless of width`, Math.round(black-white)===100,
    {white:Math.round(white), black:Math.round(black)});
}

console.log("\n-- a colour we do not stock is not silently charged for --");
const bogus=await price(rollup(96,"turquoise"));
check("an unknown colour prices as white rather than adding anything",
  Math.round(bogus)===Math.round(w8), {bogus:Math.round(bogus), white:Math.round(w8)});

console.log("\n-- only roll-ups carry it --");
// Other styles take their colour from the siding, already priced into the walls.
const resWhite=await price([{wall:"front",pos:0.5,style:"resfull",w:36,h:82.5,color:"white"}]);
const resBlack=await price([{wall:"front",pos:0.5,style:"resfull",w:36,h:82.5,color:"black"}]);
check("a residential door is not charged a curtain-colour upcharge",
  Math.round(resWhite)===Math.round(resBlack), {resWhite:Math.round(resWhite), resBlack:Math.round(resBlack)});

console.log("\n-- the quote line names the colour --");
const tok=await (await worker.fetch(new Request("https://x/admin/login",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json"},
  body:JSON.stringify({password:"pw"})}),env)).json();
const rl=await (await worker.fetch(new Request("https://x/shed/quote?redline=1",{method:"POST",
  headers:{Origin:"https://shedpro-utah.com","Content-Type":"application/json",Authorization:"Bearer "+tok.token,"CF-Connecting-IP":"5.5.5.5"},
  body:JSON.stringify({config:{style:"gable",w:12,l:16,h:9,doors:rollup(96,"black")}})}),env)).json();
const labels=JSON.stringify(rl.redline||{});
check("the redline says Black, not just \"8' Roll Up\"", /8'\s*Roll\s*Up\s*·\s*Black/.test(labels), labels.slice(0,200));

console.log(fails?`\n${fails} FAILED\n`:"\nAll checks passed.\n");
process.exit(fails?1:0);
