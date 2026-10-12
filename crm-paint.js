/* BRAND PAINT COLOURS FOR THE CRM (Nando, 12 Oct 2026).
   The SAME colour books the Shed-Pro designer uses (paint-codes.js +
   /paint-colors/<brand>.json on shedpro-utah.com), so a colour picked here is
   stored exactly as the designer stores it:
     config.sidingColor / trimColor = the hex as an integer
     config.paint.siding / .trim    = {brand, code, name, hex:'#RRGGBB'}
     config.colorNames.siding/.trim = 'Brand CODE Name'
   and the designer's restoreConfig recognises the pick on reopen. Brand list
   and order copied from paint-codes.js BRANDS. The designer has no brand list
   for the roof (it is shingle / metal swatches), so the roof is not here. */
(function (root) {
  'use strict';
  var BASE = 'https://www.shedpro-utah.com/paint-colors/';
  var BRANDS = [
    { b: 'sw', brand: 'Sherwin-Williams', short: 'SW', alias: ['sherwin williams', 'sherwinwilliams', 'sherwin', 'sw'] },
    { b: 'bm', brand: 'Benjamin Moore', short: 'BM', alias: ['benjamin moore', 'benjaminmoore', 'benjamin', 'ben moore', 'bm'] },
    { b: 'behr', brand: 'Behr', short: 'Behr', alias: ['behr'] },
    { b: 'valspar', brand: 'Valspar', short: 'Valspar', alias: ['valspar'] },
    { b: 'ppg', brand: 'PPG / Glidden', short: 'PPG', alias: ['ppg glidden', 'glidden', 'ppg'] },
    { b: 'de', brand: 'Dunn-Edwards', short: 'DE', alias: ['dunn edwards', 'dunnedwards', 'dunn', 'de'] }
  ];
  var BY = {}; BRANDS.forEach(function (x, i) { x.rank = i; BY[x.b] = x; });
  var DATA = {}, LOADING = {};
  function fold(s) {
    s = String(s || '');
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s.toLowerCase().replace(/[\u00ae\u2122]/g, '').replace(/[-_.,\/']+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function setData(b, d) { DATA[b] = d; }
  function load(b, fetchFn) {
    if (DATA[b]) return Promise.resolve(DATA[b]);
    var f = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!LOADING[b]) LOADING[b] = f(BASE + b + '.json').then(function (r) { if (!r.ok) throw new Error('paint ' + b); return r.json(); })
      .then(function (d) { DATA[b] = d; return d; }).catch(function (e) { delete LOADING[b]; throw e; });
    return LOADING[b];
  }
  function loadAll(fetchFn) { return Promise.all(BRANDS.map(function (x) { return load(x.b, fetchFn).catch(function () { return null; }); })); }
  /* A leading brand word narrows to that brand; every other word must appear
     in the code or name ("sw 7006", "behr ultra pure white", "network gray"). */
  function search(q, limit) {
    var s = fold(q), brand = null;
    BRANDS.forEach(function (x) { x.alias.forEach(function (a) { if (!brand && (s === a || s.indexOf(a + ' ') === 0)) { brand = x.b; s = s.slice(a.length).trim(); } }); });
    var words = s ? s.split(' ') : [];
    if (!words.length) return [];
    var sc = s.replace(/ /g, ''), out = [];
    (brand ? [brand] : BRANDS.map(function (x) { return x.b; })).forEach(function (b) {
      var d = DATA[b]; if (!d) return;
      d.c.forEach(function (e) {
        var code = fold(e[0]), name = fold(e[1]), hay = code + ' ' + code.replace(/ /g, '') + ' ' + name;
        if (!words.every(function (w) { return hay.indexOf(w) !== -1; })) return;
        var score = (code.replace(/ /g, '') === sc || code.split(' ').pop() === s) ? 3 : name === s ? 2 : name.indexOf(s) === 0 ? 1 : 0;
        out.push({ score: score, b: b, e: e });
      });
    });
    out.sort(function (a, z) { return (z.score - a.score) || (BY[a.b].rank - BY[z.b].rank) || (a.e[1].length - z.e[1].length); });
    return out.slice(0, limit || 40).map(function (h) { return pickOf(h.b, h.e); });
  }
  /* Exactly the object paint-codes.js applyPick/decorateConfig store. */
  function pickOf(b, e) { return { brand: BY[b].brand, code: e[0], name: e[1], hex: '#' + String(e[2]).toUpperCase() }; }
  function label(p) { return p.brand + ' ' + p.code + ' ' + p.name; }
  function hexInt(p) { return parseInt(String(p.hex).replace('#', ''), 16); }
  var api = { BRANDS: BRANDS, BASE: BASE, load: load, loadAll: loadAll, setData: setData, search: search, pickOf: pickOf, label: label, hexInt: hexInt };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.CrmPaint = api;
})(typeof window !== 'undefined' ? window : globalThis);
