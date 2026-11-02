// Website Analytics stub (GA4). Returns { connected:false } until GA_PROPERTY_ID +
// GA_SA_KEY are configured. No metrics are fabricated here, ever.
// Later: call GA4 Data API runReport with the service account, cache ~6h.
module.exports = (req, res) => {
  const hasConfig = !!(process.env.GA_PROPERTY_ID && process.env.GA_SA_KEY);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(JSON.stringify({
    connected: false,
    source: 'ga4',
    measurementId: 'G-GR8BG7DXZE',
    reason: hasConfig ? 'ga_fetch_not_implemented' : 'not_configured',
    needs: ['GA_PROPERTY_ID (numeric GA4 property id)', 'GA_SA_KEY (service account JSON, added as Viewer)'],
    range: (req.query && req.query.range) || '28d'
  }));
};
