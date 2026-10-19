import assert from 'node:assert/strict';
import { computeStats } from './crmquery.js';
const subs = [
  { id: 1, customer_id: 1, status: 'lost', created_at: '2026-09-02T18:00:00Z', lost_at: '2026-09-20T18:00:00Z', lost_reason: 'money', effective_price: 10000, details: '{}' },
  { id: 2, customer_id: 2, status: 'lost', created_at: '2026-09-03T18:00:00Z', effective_price: 5000, details: '{}' },
  { id: 3, customer_id: 3, status: 'won', created_at: '2026-09-03T18:00:00Z', won_at: '2026-09-05T18:00:00Z', effective_price: 7000, details: '{}' }];
const st = computeStats(subs, [{ id: 1, created_at: '2026-09-01T00:00:00Z' }], []);
assert.equal(st.totals.lost, 2);
assert.deepEqual(st.totals.lost_by_reason, { money: 1, unknown: 1 });
assert.equal(st.totals.lost_value, 15000);
assert.equal(st.weeks.find((w) => w.period === '2026-09-14').lost_by_reason.money, 1);
assert.equal(st.lost_quotes.find((l) => l.quote_id === 1).lost_on, '2026-09-20');
console.log('lostreason ok');
