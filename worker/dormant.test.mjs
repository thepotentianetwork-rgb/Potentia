import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runAutoDormant } from './dormant.js';
function d1(db){const prep=(sql)=>{let a=[];const o={bind:(...x)=>{a=x;return o},all:async()=>({results:db.prepare(sql).all(...a)}),run:async()=>db.prepare(sql).run(...a)};return o};return{prepare:prep,batch:async(st)=>{for(const s of st)await s.run()}}}
test('stalled open designs go dormant; won/lost/fresh untouched', async () => {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE submissions(id INTEGER PRIMARY KEY, customer_id INT, name TEXT, status TEXT, created_at TEXT);
  INSERT INTO submissions VALUES(1,1,'a','new','2026-10-01T00:00:00Z'),(2,2,'b','quoted','2026-10-01T00:00:00Z'),
  (3,3,'c','won','2026-10-01T00:00:00Z'),(4,4,'d','lost','2026-10-01T00:00:00Z'),(5,5,'e','contacted','2026-10-30T00:00:00Z');`);
  const D=d1(db), now=new Date('2026-11-02T16:00:00Z');
  const dry=await runAutoDormant(D,{now,dryRun:true});
  assert.deepEqual(dry.rows.map(r=>r.id),[1,2]);
  assert.equal(db.prepare("SELECT count(*) c FROM submissions WHERE status='dormant'").get().c,0);
  await runAutoDormant(D,{now});
  assert.deepEqual(db.prepare("SELECT id FROM submissions WHERE status='dormant'").all().map(r=>r.id),[1,2]);
  assert.equal(db.prepare("SELECT count(*) c FROM submissions").get().c,5);
  assert.equal((await runAutoDormant(D,{now:new Date('2026-11-10T00:00:00Z')})).count,0); // stamped, clock restarted
});
