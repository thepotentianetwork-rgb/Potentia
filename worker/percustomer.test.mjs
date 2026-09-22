/* ONE CUSTOMER, ONE DATA POINT.
 *
 * A customer working through ideas submits several times. The rows are all
 * real and all kept — but every figure derived from them was counted per
 * SUBMISSION, so somebody who designed six sheds moved the average price six
 * times, made their own favourite style look six times as popular, and put
 * six dots on the map at one address. The loudest customer set the numbers.
 *
 * What this checks:
 *   - a customer contributes ONE price: the MEAN of everything they quoted
 *   - style / siding / size / heard-about come from their NEWEST submission,
 *     because averaging a category is meaningless
 *   - one map dot per customer, carrying their average
 *   - won and lost are NOT averaged — they are jobs with money attached, and
 *     averaging a sale would misreport revenue
 *
 * Run: node --experimental-sqlite worker/percustomer.test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db) {
  function shape(sql) {
    const stmt = db.prepare(sql);
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { return isSelect ? (stmt.get(...args) ?? null) : (stmt.run(...args), null); },
      all() { return { results: stmt.all(...args) }; },
      run() {
        if (isSelect) return { results: stmt.all(...args) };
        const r = stmt.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql){ const m=shape(sql); return { ...m([]), bind:(...a)=>m(a) }; },
           async batch(st){ return st.map(s=>s.run()); } };
}

const shedDb = new DatabaseSync(":memory:");
shedDb.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
const crmDb = new DatabaseSync(":memory:");
const env = { DB: makeD1(shedDb), CRM_DB: makeD1(crmDb),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"cpw", ADMIN_SESSION_SECRET:"k" };

const now = new Date().toISOString();
for (const n of ["Serial Designer", "One And Done"]) {
  shedDb.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES (?,?,?)").run(n, now, now);
}
function sub(custId, status, price, style, daysAgo, geo) {
  const created = new Date(Date.now() - daysAgo*864e5).toISOString();
  const details = JSON.stringify({ quotedPrice: price, config:{ style, w:10, l:12, siding:"vertical" },
                                   heardAbout: "google", geo });
  shedDb.prepare("INSERT INTO submissions (customer_id,name,email,details,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(custId, "n", "e@x", details, status, created);
}

/* Customer 1 designs four sheds over a week, all still open. Mean = 20000.
   Their NEWEST is the leanto. Three of the four are gable. */
const geo1 = { lat: 40.7, lng: -111.9, city: "Salt Lake City", region: "UT" };
sub(1, "new",       8000, "gable",  9, geo1);
sub(1, "superseded",12000, "gable", 7, geo1);
sub(1, "superseded",30000, "gable", 5, geo1);
sub(1, "new",       30000, "leanto", 1, geo1);

/* Customer 2 submits once, at 50000. */
const geo2 = { lat: 41.2, lng: -111.9, city: "Ogden", region: "UT" };
sub(2, "new", 50000, "barn", 3, geo2);

let fails = 0;
const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(method,p,body,tok){
  const h={Origin:"https://potentianetwork.com"};
  if(body)h["Content-Type"]="application/json";
  if(tok)h.Authorization="Bearer "+tok;
  const res=await worker.fetch(new Request("https://x"+p,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;
const a=(await call("GET","/admin/analytics",null,tok)).data;

console.log("\n-- one customer, one price --");
/* Per submission it would be (8+12+30+30+50)/5 = 26,000.
   Per customer it is (20,000 + 50,000)/2 = 35,000. */
check("avg price averages CUSTOMERS, not submissions", a.avgPrice===35000, a.avgPrice);
check("two priced data points, not five", a.pricedCount===2, a.pricedCount);
check("median is over the two customers", a.medianPrice===50000, a.medianPrice);

console.log("\n-- what they want comes from their newest --");
/* Per submission: gable 3, leanto 1, barn 1 — gable looks dominant because
   ONE person kept redrawing it. Per customer: leanto 1 (their latest), barn 1. */
check("style counted once per customer, from the newest",
  a.styleCounts.leanto===1 && a.styleCounts.barn===1 && !a.styleCounts.gable, a.styleCounts);
check("size counted once per customer", a.sizeCounts["10x12"]===2, a.sizeCounts);
check("siding counted once per customer", a.sidingCounts.vertical===2, a.sidingCounts);
check("heard-about counted once per customer", a.heardCounts.google===2, a.heardCounts);

console.log("\n-- one dot per customer --");
check("two map points, not five", a.points.length===2, a.points.length);
const slc = a.points.find(p=>p.city==="Salt Lake City");
check("the dot carries the customer's AVERAGE", slc && slc.price===20000, slc && slc.price);

console.log("\n-- a sale is not an average --");
/* Won revenue must stay per submission: if this customer's 30k shed sells,
   the takings are 30k, not their 20k average. */
shedDb.prepare("UPDATE submissions SET status='won', won_at=? WHERE customer_id=1 AND details LIKE '%\"quotedPrice\":30000%' AND created_at=(SELECT MAX(created_at) FROM submissions WHERE customer_id=1)").run(now);
const b=(await call("GET","/admin/analytics",null,tok)).data;
check("won revenue is the real sale price, not the mean", b.won.revenue===30000, b.won.revenue);
check("won count is per job", b.won.count===1, b.won.count);

console.log(fails ? "\n"+fails+" FAILED" : "\nall passed");
process.exit(fails?1:0);
