/* AWNING vs PORCH (23 Oct 2026). awning:1 prices the shed at its enclosed
 * shedW x shedL and bills the awning on its own line; configs without the
 * flag (every quote saved before) price exactly as they did. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing } from './pricing.js';
const base = { v:1, style:'gable', w:14, l:20, h:9, pitch:8, siding:'horizontal', roofType:'metal',
  porchLoc:'side', porchDepth:4, porchDeck:'pt', porchTier:'standard', foundation:'blocks', loft:'12-back',
  doors:[], windows:[], vents:[], shelves:[], porchAdds:1, shedW:10, shedL:20 };
const noPorch10x20 = { ...base, w:10, l:20, porchLoc:'none', porchDepth:0, porchAdds:undefined, shedW:undefined, shedL:undefined };

test('awning:1 = a 10x20 shed priced as a 10x20, plus the awning line', () => {
  const a = computePricing({ ...base, awning:1 });
  const plain = computePricing(noPorch10x20);
  assert.equal(a.redline.porchSellName, "4' Side Awning (80 sqft)");
  assert.equal(Math.round(a.customer - a.redline.porchSell), Math.round(plain.customer));
});
test('porchAdds without awning:1 keeps its 10-21 price (footprint-priced)', () => {
  const old = computePricing(base);
  const aw = computePricing({ ...base, awning:1 });
  assert.ok(old.customer > aw.customer);
  assert.equal(old.redline.porchSellName, "4' Side Porch (80 sqft)");
});
test('awning on a partial porch is ignored (a partial porch is a porch)', () => {
  const p = { ...base, awning:1, porchLen:8 };
  assert.equal(computePricing(p).customer, computePricing({ ...p, awning:undefined }).customer);
});
import worker from './index.js';
test('/shed/quote passes awning:1 through validation', async () => {
  const env = { DB: { prepare(){ const o={ bind(){return o;}, first: async()=>null, all: async()=>({results:[]}), run: async()=>({}) }; return o; } } };
  const q = async cfg => (await (await worker.fetch(new Request('https://local/shed/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:cfg})}), env)).json()).total;
  const a = await q({ ...base, awning:1 }), p = await q(base);
  assert.ok(a < p, `awning ${a} should price under footprint ${p}`);
});
