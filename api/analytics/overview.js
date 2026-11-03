// Website Analytics (GA4). Reads GA_PROPERTY_ID + GA_SA_KEY (service account JSON,
// added as Viewer on the GA4 property). Calls Analytics Data API runReport for the
// last 28 days. Never fabricates metrics: any missing config or error => connected:false.
// Cached ~6h (in-memory per instance + CDN s-maxage).
const crypto = require('crypto');

const TTL = 6 * 60 * 60 * 1000;
let cache = null; // { at, body }

function b64u(x) { return Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

function parseKey(raw) {
  let s = String(raw).trim();
  if (!s.startsWith('{')) { try { s = Buffer.from(s, 'base64').toString('utf8'); } catch (_) {} }
  const k = JSON.parse(s);
  if (k.private_key) k.private_key = k.private_key.replace(/\\n/g, '\n');
  return k;
}

async function getToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(key.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + b64u(sig) }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('token_' + r.status + ':' + (j.error || ''));
  return j.access_token;
}

async function runReport(token, pid, body) {
  const r = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + pid + ':runReport', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('ga_' + r.status + ':' + ((j.error && j.error.status) || ''));
  return j;
}

function rowsOf(rep, n) {
  return ((rep && rep.rows) || []).slice(0, n).map(function (r) {
    return { label: r.dimensionValues[0].value, value: Number(r.metricValues[0].value) };
  });
}

const SOURCE_LABELS = {
  'Organic Search': 'Google / search engines', 'Direct': 'Typed the address or a bookmark',
  'Organic Social': 'Social media', 'Paid Social': 'Social media ads', 'Paid Search': 'Google ads',
  'Referral': 'Links on other websites', 'Email': 'Email', 'Organic Maps': 'Google Maps',
  'Unassigned': 'Unknown', 'AI Assistant': 'AI tools (ChatGPT, etc.)', 'Display': 'Display ads', 'Organic Video': 'Video (YouTube etc.)',
};

async function fetchOverview(pid, key) {
  const token = await getToken(key);
  const dateRanges = [{ startDate: '28daysAgo', endDate: 'yesterday' }];
  const q = (body) => runReport(token, pid, Object.assign({ dateRanges }, body)).catch(() => null);
  const top = (dim, metric, n) => q({ dimensions: [{ name: dim }], metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }], limit: n });
  const [tot, leads, src, pages, dev, city, designer] = await Promise.all([
    runReport(token, pid, { dateRanges, metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'averageSessionDuration' }, { name: 'engagementRate' }, { name: 'screenPageViews' }] }),
    // Leads = GA4 'generate_lead' event (sent by the contact form).
    q({ dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'generate_lead' } } } }),
    top('sessionDefaultChannelGroup', 'sessions', 5),
    top('pagePath', 'screenPageViews', 8),
    top('deviceCategory', 'sessions', 5),
    top('city', 'sessions', 6),
    q({ metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
      dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: 'designer' } } } }),
  ]);
  const v = ((tot.rows && tot.rows[0] && tot.rows[0].metricValues) || []).map((x) => Number(x.value));
  const kpis = { sessions: v[0] || 0, users: v[1] || 0, newUsers: v[2] || 0,
    avgSessionSec: Math.round(v[3] || 0), engagementRate: v[4] || 0, pageViews: v[5] || 0 };
  kpis.leads = leads && leads.rows && leads.rows[0] ? Number(leads.rows[0].metricValues[0].value) : 0;
  if (designer && designer.rows && designer.rows[0]) {
    kpis.designerUsers = Number(designer.rows[0].metricValues[0].value);
    kpis.designerViews = Number(designer.rows[0].metricValues[1].value);
  } else if (designer) { kpis.designerUsers = 0; kpis.designerViews = 0; }
  const sources = src && rowsOf(src, 5).map((r) => ({ raw: r.label, label: SOURCE_LABELS[r.label] || r.label, value: r.value }));
  const topPages = pages && rowsOf(pages, 8);
  const devices = dev && rowsOf(dev, 5);
  const cities = city && rowsOf(city, 6).filter((r) => r.label && r.label !== '(not set)');
  return { connected: true, source: 'ga4', measurementId: 'G-GR8BG7DXZE', range: '28d', kpis,
    sources, topPages, devices, cities, fetchedAt: new Date().toISOString() };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const pid = process.env.GA_PROPERTY_ID, rawKey = process.env.GA_SA_KEY;
  const send = (body, cacheable) => {
    res.setHeader('Cache-Control', cacheable ? 'public, s-maxage=21600, stale-while-revalidate=3600' : 'no-store');
    res.status(200).end(JSON.stringify(body));
  };
  if (!pid || !rawKey) {
    return send({ connected: false, source: 'ga4', measurementId: 'G-GR8BG7DXZE', reason: 'not_configured',
      needs: ['GA_PROPERTY_ID (numeric GA4 property id)', 'GA_SA_KEY (service account JSON, added as Viewer)'], range: '28d' }, false);
  }
  if (cache && Date.now() - cache.at < TTL) return send(cache.body, true);
  try {
    const body = await fetchOverview(pid, parseKey(rawKey));
    cache = { at: Date.now(), body };
    return send(body, true);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return send({ connected: false, source: 'ga4', measurementId: 'G-GR8BG7DXZE',
      reason: msg.startsWith('ga_403') ? 'no_property_access' : msg.startsWith('token_') ? 'bad_key' : 'ga_error',
      detail: msg.slice(0, 120), range: '28d' }, false);
  }
};
