// Editable notes: CRM notes (edit/delete) + a quote's Customer Notes, with an audit trail.
// Run: node --experimental-sqlite worker/noteedits.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
import { quoteLines } from "./quotelines.js";
const here = path.dirname(fileURLToPath(import.meta.url));
function makeD1(db){
  function shape(sql){ const st=db.prepare(sql); const sel=/^\s*(select|pragma)/i.test(sql);
    return a=>({ first(){ return sel?(st.get(...a)??null):(st.run(...a),null); },
      all(){ return {results:st.all(...a)}; },
      run(){ if(sel) return {results:st.all(...a)}; const r=st.run(...a);
             return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}; } }); }
  return { prepare(sql){ const m=shape(sql); return {...m([]), bind:(...a)=>m(a)}; }, async batch(st){ return st.map(x=>x.run()); } };
}
const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(here,"schema.sql"),"utf8"));
const env = { DB: makeD1(db), CRM_DB: makeD1(new DatabaseSync(":memory:")), ADMIN_PASSWORD:"pw", CRM_PASSWORD:"c", ADMIN_SESSION_SECRET:"k" };
const now = new Date().toISOString();
let fails=0; const check=(n,c,x)=>{ if(c) console.log("  ok   "+n); else { fails++; console.log("  FAIL "+n+(x!==undefined?"  "+JSON.stringify(x):"")); } };
async function call(m,p,b,t){ const h={Origin:"https://potentianetwork.com"}; if(b)h["Content-Type"]="application/json"; if(t)h.Authorization="Bearer "+t;
  const res=await worker.fetch(new Request("https://x"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env); return {status:res.status,data:await res.json().catch(()=>null)}; }
const tok=(await call("POST","/admin/login",{password:"pw"})).data.token;

db.prepare("INSERT INTO customers (name,created_at,updated_at) VALUES ('Lee',?,?)").run(now,now);
const fx = JSON.parse(fs.readFileSync(path.join(here,"fixtures","q71-like.json"),"utf8"));
await call("POST","/admin/submissions/1/adjustments",{adjustments:[]},tok);
db.prepare("INSERT INTO submissions (id,customer_id,name,email,details,status,created_at) VALUES (71,1,'Lee','l@x',?,?,?)").run(fx.details,"quoted",now);
await call("GET","/admin/submissions/71/design-status",null,tok);
db.prepare("UPDATE submissions SET adjustments=?, effective_price=? WHERE id=71").run(fx.adjustments, fx.effective_price);
try { db.exec("ALTER TABLE payments ADD COLUMN submission_id INTEGER"); } catch(e) {}
db.prepare("INSERT INTO payments (customer_id,amount,method,paid_at,created_at,submission_id) VALUES (1,1000,'cash',?,?,71)").run(now,now);
const row = () => db.prepare("SELECT details,adjustments,effective_price FROM submissions WHERE id=71").get();
const tot = (r) => { const d=JSON.parse(r.details); const b=quoteLines(d.redline, JSON.parse(r.adjustments)); return b.total.toFixed(2)+"|"+b.cashDiscount.cashTotal.toFixed(2)+"|"+JSON.stringify(b.rows.map(x=>x.amt)); };
const before = row();

console.log("staff only");
for (const [m,p,b] of [["POST","/admin/notes/1",{text:"x"}],["DELETE","/admin/notes/1",null],["POST","/admin/submissions/71/customer-notes",{notes:"x"}],["GET","/admin/customers/1/note-edits",null]]) {
  const r = await call(m,p,b); check(m+" "+p+" without login -> 401", r.status===401, r.status);
}

console.log("CRM notes");
const add = await call("POST","/admin/customers/1/notes",{text:"Called Lee, wants grey trim"},tok);
const nid = add.data.id;
const e1 = await call("POST","/admin/notes/"+nid,{text:"Called Lee, wants SW 7073 Network Gray trim", editor:"Nando"},tok);
check("edit saved", e1.status===200 && e1.data.changed===true, e1);
const n1 = db.prepare("SELECT * FROM notes WHERE id=?").get(nid);
check("text replaced, edited_by/at set", n1.text==="Called Lee, wants SW 7073 Network Gray trim" && n1.edited_by==="Nando" && !!n1.edited_at, n1);
check("created_at kept", n1.created_at === add.data.created_at);
const cust = await call("GET","/admin/customers/1",null,tok);
check("customer view returns edited_at/edited_by", cust.data.notes.some(n=>n.id===nid && n.edited_by==="Nando"), cust.data.notes);
check("same text = no change, no audit row", (await call("POST","/admin/notes/"+nid,{text:n1.text},tok)).data.changed===false);
check("empty text refused", (await call("POST","/admin/notes/"+nid,{text:"  "},tok)).status===400);
check("unknown note 404", (await call("POST","/admin/notes/9999",{text:"x"},tok)).status===404);
const nid2 = (await call("POST","/admin/customers/1/notes",{text:"Wrong customer, delete me"},tok)).data.id;
const d1 = await call("DELETE","/admin/notes/"+nid2,{editor:"Nando"},tok);
check("delete ok", d1.status===200 && !db.prepare("SELECT 1 FROM notes WHERE id=?").get(nid2));

console.log("Customer Notes on quote #71 (order has a deposit)");
check("before: $18,151.27", tot(before).startsWith("18151.27|17622.59"), tot(before));
const oldNotes = JSON.parse(before.details).notes;
const newNotes = oldNotes.replace("Orientation: doors face east;", "Orientation: doors face EAST (confirmed by phone);");
const c1 = await call("POST","/admin/submissions/71/customer-notes",{notes:newNotes, editor:"Nando"},tok);
check("saved (200) despite the deposit", c1.status===200 && c1.data.changed, c1);
const after = row(), da = JSON.parse(after.details), db4 = JSON.parse(before.details);
check("details.notes updated", da.notes === newNotes.trim());
check("notesEditedBy/At stamped", da.notesEditedBy==="Nando" && !!da.notesEditedAt);
const strip = d => { const y={...d}; delete y.notes; delete y.notesEditedAt; delete y.notesEditedBy; return JSON.stringify(y); };
check("every other details field byte-identical (config, redline, quotedPrice, history)", strip(da) === strip(db4));
check("total unchanged $18,151.27 (+cash, phases)", tot(after) === tot(before), tot(after));
check("adjustments byte-identical", after.adjustments === before.adjustments);
check("effective_price unchanged", after.effective_price === before.effective_price);
check("notes required", (await call("POST","/admin/submissions/71/customer-notes",{},tok)).status===400);

console.log("audit trail");
const h = await call("GET","/admin/customers/1/note-edits",null,tok);
const ed = h.data.edits;
check("3 audit rows (edit, delete, customer notes)", ed.length===3, ed.map(x=>x.kind+"/"+x.action));
const cn = ed.find(x=>x.kind==="customer_notes");
check("customer notes: old text kept, new text, editor", cn && cn.old_text===oldNotes && cn.new_text===newNotes.trim() && cn.editor==="Nando" && cn.submission_id===71);
const ce = ed.find(x=>x.kind==="crm_note" && x.action==="edit");
check("crm edit: old -> new", ce.old_text==="Called Lee, wants grey trim" && ce.new_text.includes("SW 7073"));
const cd = ed.find(x=>x.action==="delete");
check("deleted note text survives in the audit", cd.old_text==="Wrong customer, delete me" && cd.new_text===null);
check("editor defaults to 'staff'", (await (async()=>{ await call("POST","/admin/notes/"+nid,{text:"again"},tok); return db.prepare("SELECT editor FROM note_edits ORDER BY id DESC").get().editor; })())==="staff");
check("#71 still $18,151.27 at the end", tot(row()).startsWith("18151.27|"));

console.log(fails ? fails+" FAILED" : "ALL PASS"); process.exit(fails?1:0);
