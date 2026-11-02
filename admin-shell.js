/* ADMIN SHELL — fills the desktop tab strip from AdminNav.PAGES so the page
   list still lives in exactly one place (admin-nav.js). Phones keep the
   AdminNav dropdown. Load after admin-nav.js. */
(function (g) {
  'use strict';
  function here() { return (location.pathname || '').split('/').pop() || 'admin.html'; }
  function mount(opts) {
    opts = opts || {};
    var tabs = document.querySelector('.shell-tabs');
    if (tabs && g.AdminNav) {
      var cur = opts.current || here();
      g.AdminNav.PAGES.forEach(function (p) {
        var a = document.createElement('a');
        a.className = 'shell-tab' + (p.href === cur ? ' current' : '');
        a.href = p.href;
        a.textContent = p.label;
        if (p.badge) { var b = document.createElement('span'); b.className = 'act-badge'; b.id = 'tab-badge'; b.style.display = 'none'; a.appendChild(b); }
        tabs.appendChild(a);
      });
    }
    var d = document.getElementById('h-date');
    if (d) d.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (g.AdminNav) {
      g.AdminNav.render(document.querySelector('.shell .h-actions'), opts);
      var set = g.AdminNav.setCount;
      g.AdminNav.setCount = function (n) { set(n); var t = document.getElementById('tab-badge'); if (t) { var c = Number(n) || 0; t.textContent = c > 99 ? '99+' : String(c); t.style.display = c > 0 ? '' : 'none'; } };
    }
  }
  g.AdminShell = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
