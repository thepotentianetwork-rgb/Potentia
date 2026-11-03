import { productionKpis } from "./production.js";
import assert from "node:assert";
const rows = [
  { status: "won", won_at: "2026-09-10", effective_price: 10000 },
  { status: "won", won_at: "2026-11-02", details: JSON.stringify({ quotedPrice: 20000 }) },
  { status: "quoted", created_at: "2026-11-01", effective_price: 6000 },
  { status: "superseded", effective_price: 99999 },
  { status: "lost", effective_price: 0 }
];
const k = productionKpis(rows, "2026-11-03");
assert.equal(k.avgDeal.amount, 15000);
assert.equal(k.avgQuote.amount, 12000);
assert.equal(k.avgMonthly.months, 3);
assert.equal(k.avgMonthly.amount, 10000);
assert.equal(k.thisMonth.amount, 20000);
assert.equal(k.months.length, 12);
console.log("production ok");
