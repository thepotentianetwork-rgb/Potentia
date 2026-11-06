/* THE ADMIN NAV, DEFINED ONCE.
 *
 * Top-level labels (order): Home, Sales, Shop, Data, Web analytics.
 * Sales opens Customers / Activity / Pricing. Shop is Schedule only.
 * Team logins stays in the owner menu — never the main top nav.
 *
 * Desktop shell tabs and the phone dropdown both read the same NAV tree.
 * Styles are injected once so every admin page stays in sync.
 */
(function (global) {
  'use strict';

  var NAV = [
    { id: 'home', href: 'admin-dashboard.html', label: 'Home' },
    {
      id: 'sales',
      label: 'Sales',
      children: [
        { href: 'admin.html', label: 'Customers' },
        { href: 'admin-activity.html', label: 'Activity', badge: true },
        { href: 'admin-pricing.html', label: 'Pricing' }
      ]
    },
    { id: 'shop', href: 'admin-schedule.html', label: 'Shop' },
    { id: 'data', href: 'admin-data.html', label: 'Data' },
    { id: 'web', href: 'admin-website.html', label: 'Web analytics' }
  ];

  var OWNER_LINKS = [
    { href: 'admin-team.html', label: 'Team logins' }
  ];

  /* Flat leaf pages — kept for callers that walk AdminNav.PAGES / setCount. */
  function flatten(items) {
    var out = [];
    items.forEach(function (item) {
      if (item.children && item.children.length) {
        item.children.forEach(function (c) { out.push(c); });
      } else if (item.href) {
        out.push({ href: item.href, label: item.label, badge: item.badge });
      }
    });
    return out;
  }

  var PAGES = flatten(NAV);

  var CSS = [
    '.nav-wrap{position:relative;display:inline-block}',
    ".nav-btn{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--bright);background:none;border:1px solid var(--dim);padding:9px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:border-color 0.2s}",
    '.nav-btn:hover,.nav-btn[aria-expanded="true"]{border-color:var(--sp-blue)}',
    '.nav-caret{color:var(--silver);font-size:10px;line-height:1}',
    '.nav-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:210px;background:#0b0b13;border:1px solid var(--dim);z-index:60;box-shadow:0 14px 34px rgba(0,0,0,0.55)}',
    '.nav-menu[hidden]{display:none}',
    ".nav-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 15px;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--silver);text-decoration:none;border-bottom:1px solid rgba(42,45,56,0.7)}",
    '.nav-item:last-child{border-bottom:none}',
    '.nav-item:hover{background:rgba(44,192,253,0.1);color:var(--bright)}',
    '.nav-item.current{color:var(--sp-blue)}',
    '.nav-item.current::after{content:"●";font-size:7px;color:var(--sp-blue)}',
    '.nav-item.child{padding-left:24px;font-size:10.5px}',
    ".nav-group{display:block;padding:10px 15px 4px;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--silver);opacity:0.7}",
    ".act-badge{display:inline-block;font-family:'DM Mono',monospace;font-size:9px;line-height:1;color:var(--black);background:var(--sp-orange);border-radius:20px;padding:3px 6px}",
    '.owner-wrap{position:relative;display:inline-block}',
    ".owner-btn{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--silver);background:none;border:1px solid var(--dim);padding:9px 12px;cursor:pointer}",
    '.owner-btn:hover,.owner-btn[aria-expanded="true"]{border-color:var(--sp-blue);color:var(--bright)}',
    '.owner-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:170px;background:#0b0b13;border:1px solid var(--dim);z-index:60;box-shadow:0 14px 34px rgba(0,0,0,0.55)}',
    '.owner-menu[hidden]{display:none}',
    '@media (max-width:760px){.nav-menu{min-width:180px}}',
    '@media (min-width:761px) and (max-width:1199px){.nav-btn,.owner-btn{min-height:40px}.nav-item{min-height:46px;box-sizing:border-box}}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('admin-nav-css')) return;
    var s = document.createElement('style');
    s.id = 'admin-nav-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function currentFile() {
    var p = (location.pathname || '').split('/').pop();
    return p || 'admin.html';
  }

  function leafLabel(href) {
    var found = null;
    PAGES.forEach(function (p) { if (p.href === href) found = p.label; });
    OWNER_LINKS.forEach(function (p) { if (p.href === href) found = p.label; });
    return found;
  }

  function itemContains(item, href) {
    if (item.href === href) return true;
    if (!item.children) return false;
    for (var i = 0; i < item.children.length; i++) {
      if (item.children[i].href === href) return true;
    }
    return false;
  }

  /* ROLE: sales keeps Customers + Schedule + Activity under Sales / Shop. */
  var ROLE = (function () { try { return localStorage.getItem('potentia_role') || 'admin'; } catch (e) { return 'admin'; } })();
  var IS_OWNER = ROLE !== 'sales';
  var SALES_ALLOWED = { 'admin.html': 1, 'admin-schedule.html': 1, 'admin-activity.html': 1 };

  if (ROLE === 'sales') {
    NAV = NAV.filter(function (item) {
      return item.id === 'sales' || item.id === 'shop';
    }).map(function (item) {
      if (!item.children) return item;
      return {
        id: item.id,
        label: item.label,
        children: item.children.filter(function (c) { return SALES_ALLOWED[c.href]; })
      };
    });
    PAGES = flatten(NAV);
    try { document.documentElement.classList.add('role-sales'); } catch (e) {}
    var here0 = currentFile();
    if (!SALES_ALLOWED[here0] && here0 !== 'admin-customer.html') {
      location.replace('admin.html');
    }
  }

  function appendBadge(el, id) {
    var b = document.createElement('span');
    b.className = 'act-badge';
    b.id = id;
    b.style.display = 'none';
    el.appendChild(b);
    return b;
  }

  function addMenuLink(menu, href, label, opts) {
    opts = opts || {};
    var a = document.createElement('a');
    a.className = 'nav-item' + (opts.child ? ' child' : '') + (opts.current ? ' current' : '');
    a.href = href;
    a.appendChild(document.createTextNode(label));
    if (opts.badge) appendBadge(a, opts.badgeId || 'nav-badge');
    menu.appendChild(a);
    return a;
  }

  function bindDropdown(wrap, btn, menu) {
    var GUTTER = 8;
    function place() {
      menu.style.right = '';
      var vw = document.documentElement.clientWidth || 0;
      if (!vw) return;
      var m = menu.getBoundingClientRect();
      if (m.left < GUTTER) menu.style.right = (m.left - GUTTER) + 'px';
    }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); place(); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden ? open() : close();
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    window.addEventListener('resize', function () { if (!menu.hidden) place(); });
    return { close: close, open: open };
  }

  function renderOwnerMenu(mount) {
    if (!IS_OWNER || !mount) return null;
    injectStyles();
    var wrap = document.createElement('div');
    wrap.className = 'owner-wrap';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'owner-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-label', 'Owner menu');
    btn.textContent = 'Owner';
    wrap.appendChild(btn);
    var menu = document.createElement('div');
    menu.className = 'owner-menu';
    menu.hidden = true;
    OWNER_LINKS.forEach(function (p) {
      addMenuLink(menu, p.href, p.label, { current: currentFile() === p.href });
    });
    wrap.appendChild(menu);
    bindDropdown(wrap, btn, menu);
    /* Sit before logout when present. */
    var logout = mount.querySelector('#logout-btn, .logout');
    if (logout) mount.insertBefore(wrap, logout);
    else mount.appendChild(wrap);
    return { wrap: wrap, button: btn, menu: menu };
  }

  function render(mount, opts) {
    opts = opts || {};
    if (!mount) return null;
    injectStyles();

    var here = opts.current || currentFile();
    var btnLabel = leafLabel(here) || 'Menu';

    var wrap = document.createElement('div');
    wrap.className = 'nav-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn';
    btn.id = 'nav-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');
    btn.appendChild(document.createTextNode(btnLabel));
    var caret = document.createElement('span');
    caret.className = 'nav-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);
    appendBadge(btn, 'hdr-badge');
    wrap.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'nav-menu';
    menu.id = 'nav-menu';
    menu.hidden = true;

    NAV.forEach(function (item) {
      if (item.children && item.children.length) {
        var g = document.createElement('div');
        g.className = 'nav-group';
        g.textContent = item.label;
        menu.appendChild(g);
        item.children.forEach(function (c) {
          addMenuLink(menu, c.href, c.label, {
            child: true,
            current: c.href === here,
            badge: !!c.badge
          });
        });
      } else if (item.href) {
        addMenuLink(menu, item.href, item.label, { current: item.href === here });
      }
    });
    wrap.appendChild(menu);
    bindDropdown(wrap, btn, menu);

    mount.insertBefore(wrap, mount.firstChild);
    renderOwnerMenu(mount);
    return { wrap: wrap, button: btn, menu: menu };
  }

  function setCount(n) {
    ['hdr-badge', 'nav-badge', 'tab-badge', 'sales-badge'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var c = Number(n) || 0;
      el.textContent = c > 99 ? '99+' : String(c);
      el.style.display = c > 0 ? '' : 'none';
    });
  }

  global.AdminNav = {
    NAV: NAV,
    PAGES: PAGES,
    OWNER_LINKS: OWNER_LINKS,
    ROLE: ROLE,
    render: render,
    renderOwnerMenu: renderOwnerMenu,
    setCount: setCount,
    itemContains: itemContains,
    currentFile: currentFile
  };
})(typeof window !== 'undefined' ? window : globalThis);
