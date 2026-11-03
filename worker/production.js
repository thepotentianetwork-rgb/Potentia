/* Production numbers for the sales (advisor) view of the CRM.
   Pure: rows in, figures out, so it can be tested without a database.

   rows: { status, created_at, won_at, effective_price, details }
   - avgDeal:      mean price of WON orders (closed/won average).
   - avgQuote:     mean price of every quote sent (any status except
                   superseded) that carries a price.
   - months:       booked ("generated") revenue per calendar month, by won_at,
                   for the last `span` months ending in today's month.
   - avgMonthly:   mean of those months, counting only months from the first
                   one with a sale (so a brand-new CRM is not averaged with
                   empty months before it existed).
   - goal:         the monthly generated goal ($75k). */
export const MONTHLY_GOAL = 75000;

function priceOf(row) {
  let d = {};
  try { d = JSON.parse(row.details || "{}") || {}; } catch (e) {}
  const n = row.effective_price != null ? Number(row.effective_price)
          : (d.quotedPrice != null ? Number(d.quotedPrice) : NaN);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
const ym = (iso) => (/^\d{4}-\d{2}/.exec(String(iso || "")) || [null])[0];

export function productionKpis(rows, todayISO, span = 12) {
  const live = (rows || []).filter((r) => r.status !== "superseded");
  const quotes = live.map(priceOf).filter((p) => p > 0);
  const won = live.filter((r) => r.status === "won").map((r) => ({ p: priceOf(r), m: ym(r.won_at || r.created_at) }))
    .filter((w) => w.p > 0 && w.m);
  const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0);

  const end = ym(todayISO) || new Date().toISOString().slice(0, 7);
  let [y, m] = end.split("-").map(Number);
  const keys = [];
  for (let i = 0; i < span; i++) { keys.unshift(`${y}-${String(m).padStart(2, "0")}`); m--; if (!m) { m = 12; y--; } }
  const by = {};
  won.forEach((w) => { by[w.m] = by[w.m] || { amount: 0, count: 0 }; by[w.m].amount += w.p; by[w.m].count++; });
  const months = keys.map((k) => ({ month: k, amount: by[k] ? by[k].amount : 0, count: by[k] ? by[k].count : 0 }));
  const firstIdx = months.findIndex((x) => x.count > 0);
  const counted = firstIdx < 0 ? [] : months.slice(firstIdx);
  const thisMonth = months[months.length - 1];
  return {
    avgDeal: { amount: Math.round(avg(won.map((w) => w.p))), count: won.length },
    avgQuote: { amount: Math.round(avg(quotes)), count: quotes.length },
    avgMonthly: { amount: Math.round(avg(counted.map((x) => x.amount))), months: counted.length },
    thisMonth: { month: thisMonth.month, amount: thisMonth.amount, count: thisMonth.count },
    goal: MONTHLY_GOAL,
    months
  };
}
