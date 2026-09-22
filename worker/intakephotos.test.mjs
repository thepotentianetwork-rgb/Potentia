/* PROJECT PHOTOS, AND WHETHER THE DEPOSIT LANDED.
 *
 * client_intake had been written since the onboarding form went up and never
 * once read: no endpoint returned it, no page showed it. The contractor's
 * answers went into the database and nobody could see them. Photos and a
 * deposit flag on a sheet nobody can open would have been additions to
 * nothing, so the read side is half of what this covers.
 *
 * Run: node --experimental-sqlite worker/intakephotos.test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import worker from "./index.js";

function makeD1(db) {
  function shape(sql) {
    const isSelect = /^\s*(select|pragma)/i.test(sql);
    return (args) => ({
      first() { const s=db.prepare(sql); return isSelect ? (s.get(...args) ?? null) : (s.run(...args), null); },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() {
        const s = db.prepare(sql);
        if (isSelect) return { results: s.all(...args) };
        const r = s.run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return { prepare(sql){ const m=shape(sql); return { ...m([]), bind:(...a)=>m(a) }; },
           async batch(st){ return st.map(s=>s.run()); } };
}
const crmDb = new DatabaseSync(":memory:");
const shedDb = new DatabaseSync(":memory:");
const env = { DB: makeD1(shedDb), CRM_DB: makeD1(crmDb),
              ADMIN_PASSWORD:"pw", CRM_PASSWORD:"cpw", ADMIN_SESSION_SECRET:"k" };

let fails = 0;
const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(method,p,body,tok){
  const h={Origin:"https://potentianetwork.com"};
  if(body)h["Content-Type"]="application/json";
  if(tok)h.Authorization="Bearer "+tok;
  const res=await worker.fetch(new Request("https://x"+p,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const jpg = (n) => "data:image/jpeg;base64," + Buffer.from("photo-"+n).toString("base64");

console.log("\n-- the sheet arrives with photos --");
let r = await call("POST","/crm/intake",{
  email:"hank@roofing.test", business_name:"Hank Roofing", owner_name:"Hank",
  trade:["roofing"], project_description:"Re-roof on a 1920s bungalow, cedar shake.",
  project_photos:[
    {data:jpg(1), caption:"Before"},
    {data:jpg(2)},
    jpg(3),                                        // a bare string is allowed too
    {data:"data:image/gif;base64,AAAA"},           // wrong type  -> dropped
    {data:"https://example.com/not-a-data-url"},   // not a data URL -> dropped
    {data:"data:image/png;base64,"+"A".repeat(800000)}  // too big -> dropped
  ]
});
check("intake accepted", r.status===200 && r.data.ok, r.data);
check("three usable photos kept, three junk ones dropped", r.data.photos===3, r.data.photos);
const clientId = r.data.id;

console.log("\n-- and can be read back, which it never could before --");
const tok=(await call("POST","/crm/login",{password:"cpw"})).data.token;
r = await call("GET","/crm/clients/"+clientId+"/intake",null,tok);
check("the sheet comes back", r.status===200 && r.data.sheets.length===1, r.status);
const sheet = r.data.sheets[0];
check("the answers are there", sheet.answers.business_name==="Hank Roofing", sheet.answers&&sheet.answers.business_name);
check("the project description is there", /cedar shake/.test(sheet.answers.project_description||""), sheet.answers.project_description);
check("three photos listed", sheet.photos.length===3, sheet.photos.length);
check("the caption survived", sheet.photos[0].caption==="Before", sheet.photos[0]);
check("photo bytes are NOT in the listing", sheet.photos[0].data===undefined, Object.keys(sheet.photos[0]));
check("nor inside the answers blob", sheet.answers.project_photos===undefined, !!sheet.answers.project_photos);

console.log("\n-- a photo is fetched one at a time --");
r = await call("GET","/crm/intake/photo/"+sheet.photos[0].id,null,tok);
check("the image comes back", r.status===200 && r.data.data===jpg(1), r.status);
check("with its type", r.data.mime==="image/jpeg", r.data.mime);
r = await call("GET","/crm/intake/photo/"+sheet.photos[0].id,null,null);
check("and not without a login", r.status===401, r.status);

console.log("\n-- the deposit --");
check("starts unmarked", sheet.deposit.received===false, sheet.deposit);
r = await call("POST","/crm/intake/deposit",{intake_id:sheet.id, received:true, amount:1500, note:"Zelle", by:"Nando"},tok);
check("marking it works", r.status===200 && r.data.received===true, r.data);
const firstAt = r.data.at;
r = await call("GET","/crm/clients/"+clientId+"/intake",null,tok);
check("it reads back as received", r.data.sheets[0].deposit.received===true, r.data.sheets[0].deposit);
check("with the amount", r.data.sheets[0].deposit.amount===1500, r.data.sheets[0].deposit.amount);
check("and who marked it", r.data.sheets[0].deposit.marked_by==="Nando", r.data.sheets[0].deposit.marked_by);

await new Promise(res=>setTimeout(res,5));
r = await call("POST","/crm/intake/deposit",{intake_id:sheet.id, received:true, amount:1600},tok);
check("editing the amount does NOT move the date the money arrived", r.data.at===firstAt, {firstAt, now:r.data.at});

r = await call("POST","/crm/intake/deposit",{intake_id:sheet.id, received:false},tok);
r = await call("GET","/crm/clients/"+clientId+"/intake",null,tok);
check("un-marking clears it", r.data.sheets[0].deposit.received===false && r.data.sheets[0].deposit.at===null, r.data.sheets[0].deposit);

r = await call("POST","/crm/intake/deposit",{intake_id:sheet.id, received:true},null);
check("and none of it without a login", r.status===401, r.status);

console.log("\n-- ten is the cap --");
r = await call("POST","/crm/intake",{ email:"many@x.test",
  project_photos: Array.from({length:14},(_,i)=>({data:jpg("m"+i)})) });
check("fourteen sent, ten stored", r.data.photos===10, r.data.photos);

console.log("\n-- a bad photo never costs the sheet --");
r = await call("POST","/crm/intake",{ email:"junk@x.test", business_name:"Junk Only",
  project_photos:[{data:"nonsense"},{data:"data:text/plain;base64,AAA"}] });
check("the sheet is still accepted", r.status===200 && r.data.ok, r.status);
check("with no photos", r.data.photos===0, r.data.photos);

console.log(fails ? "\n"+fails+" FAILED" : "\nall passed");
process.exit(fails?1:0);
