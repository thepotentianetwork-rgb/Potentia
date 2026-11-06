/* ADMIN SHELL — fills the desktop tab strip from AdminNav.NAV so the page
   list still lives in exactly one place (admin-nav.js). Phones keep the
   AdminNav dropdown. Load after admin-nav.js. */
(function (g) {
  'use strict';

  function here() { return (location.pathname || '').split('/').pop() || 'admin.html'; }

  function closeAllFlyouts(root) {
    if (!root) return;
    root.querySelectorAll('.shell-flyout').forEach(function (m) { m.hidden = true; });
    root.querySelectorAll('.shell-tab-btn[aria-expanded="true"]').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  function mountTabs(tabs, cur) {
    var nav = (g.AdminNav && g.AdminNav.NAV) || [];
    nav.forEach(function (item) {
      if (item.children && item.children.length) {
        var wrap = document.createElement('div');
        wrap.className = 'shell-tab-group';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shell-tab shell-tab-btn' + (g.AdminNav.itemContains(item, cur) ? ' current' : '');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-haspopup', 'true');
        btn.appendChild(document.createTextNode(item.label));
        var caret = document.createElement('span');
        caret.className = 'shell-tab-caret';
        caret.textContent = '▾';
        btn.appendChild(caret);
        if (item.children.some(function (c) { return c.badge; })) {
          var sb = document.createElement('span');
          sb.className = 'act-badge';
          sb.id = 'sales-badge';
          sb.style.display = 'none';
          btn.appendChild(sb);
        }
        wrap.appendChild(btn);

        var fly = document.createElement('div');
        fly.className = 'shell-flyout';
        fly.hidden = true;
        item.children.forEach(function (c) {
          var a = document.createElement('a');
          a.className = 'shell-flyout-item' + (c.href === cur ? ' current' : '');
          a.href = c.href;
          a.textContent = c.label;
          if (c.badge) {
            var b = document.createElement('span');
            b.className = 'act-badge';
            b.id = 'tab-badge';
            b.style.display = 'none';
            a.appendChild(b);
          }
          fly.appendChild(a);
        });
        wrap.appendChild(fly);

        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var open = fly.hidden;
          closeAllFlyouts(tabs);
          if (open) {
            fly.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
          }
        });
        tabs.appendChild(wrap);
      } else if (item.href) {
        var link = document.createElement('a');
        link.className = 'shell-tab' + (item.href === cur ? ' current' : '');
        link.href = item.href;
        link.textContent = item.label;
        tabs.appendChild(link);
      }
    });

    document.addEventListener('click', function () { closeAllFlyouts(tabs); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllFlyouts(tabs);
    });
  }

  function mount(opts) {
    opts = opts || {};
    var tabs = document.querySelector('.shell-tabs');
    var cur = opts.current || here();
    if (tabs && g.AdminNav) mountTabs(tabs, cur);

    var d = document.getElementById('h-date');
    if (d) d.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    });

    if (g.AdminNav) {
      g.AdminNav.render(document.querySelector('.shell .h-actions'), opts);
      var set = g.AdminNav.setCount;
      g.AdminNav.setCount = function (n) {
        set(n);
        ['tab-badge', 'sales-badge'].forEach(function (id) {
          var t = document.getElementById(id);
          if (!t) return;
          var c = Number(n) || 0;
          t.textContent = c > 99 ? '99+' : String(c);
          t.style.display = c > 0 ? '' : 'none';
        });
      };
    }
  }

  g.AdminShell = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
