/* THE ADMIN NAV, DEFINED ONCE.
 *
 * Six pages had six hand-written header bars, and they had already drifted:
 * Activity was missing its link to Data, Pricing only appeared on two of
 * them, and the same page called itself "Customers" in one header and "All
 * Customers" in another. Every page added made that worse, and the row was
 * running out of width on an iPad regardless.
 *
 * So: one list of pages, one button. The button says where you are, the menu
 * says where you can go, and the activity count rides on both — visible
 * without opening anything.
 *
 * The styles are injected from here rather than copied into six <style>
 * blocks, for exactly the reason above.
 */
(function (global) {
  'use strict';

  var PAGES = [
    { href: 'admin.html',          label: 'Customers' },
    { href: 'admin-schedule.html', label: 'Schedule' },
    { href: 'admin-activity.html', label: 'Activity', badge: true },
    { href: 'admin-data.html',     label: 'Data' },
    { href: 'admin-pricing.html',  label: 'Pricing' }
  ];

  var CSS = [
    '.nav-wrap{position:relative;display:inline-block}',
    ".nav-btn{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--bright);background:none;border:1px solid var(--dim);padding:9px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:border-color 0.2s}",
    '.nav-btn:hover,.nav-btn[aria-expanded="true"]{border-color:var(--sp-blue)}',
    '.nav-caret{color:var(--silver);font-size:10px;line-height:1}',
    '.nav-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:190px;background:#0b0b13;border:1px solid var(--dim);z-index:60;box-shadow:0 14px 34px rgba(0,0,0,0.55)}',
    '.nav-menu[hidden]{display:none}',
    ".nav-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 15px;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--silver);text-decoration:none;border-bottom:1px solid rgba(42,45,56,0.7)}",
    '.nav-item:last-child{border-bottom:none}',
    '.nav-item:hover{background:rgba(44,192,253,0.1);color:var(--bright)}',
    '.nav-item.current{color:var(--sp-blue)}',
    '.nav-item.current::after{content:"●";font-size:7px;color:var(--sp-blue)}',
    ".act-badge{display:inline-block;font-family:'DM Mono',monospace;font-size:9px;line-height:1;color:var(--black);background:var(--sp-orange);border-radius:20px;padding:3px 6px}",
    '@media (max-width:760px){.nav-menu{min-width:170px}}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('admin-nav-css')) return;
    var s = document.createElement('style');
    s.id = 'admin-nav-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* The file this page was served as. Compared rather than passed in, so a
     page cannot mark the wrong item as current by mistyping its own name. */
  function currentFile() {
    var p = (location.pathname || '').split('/').pop();
    return p || 'admin.html';
  }

  function render(mount, opts) {
    opts = opts || {};
    if (!mount) return null;
    injectStyles();

    var here = opts.current || currentFile();
    var page = PAGES.filter(function (p) { return p.href === here; })[0];

    var wrap = document.createElement('div');
    wrap.className = 'nav-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn';
    btn.id = 'nav-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');
    /* Names the page you are on, so the button is a location as well as a
       control — on a phone that is the only thing telling you where you are. */
    btn.appendChild(document.createTextNode(page ? page.label : 'Menu'));
    var caret = document.createElement('span');
    caret.className = 'nav-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);
    var btnBadge = document.createElement('span');
    btnBadge.className = 'act-badge';
    btnBadge.id = 'hdr-badge';
    btnBadge.style.display = 'none';
    btn.appendChild(btnBadge);
    wrap.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'nav-menu';
    menu.id = 'nav-menu';
    menu.hidden = true;

    PAGES.forEach(function (p) {
      var a = document.createElement('a');
      a.className = 'nav-item' + (p.href === here ? ' current' : '');
      a.href = p.href;
      a.appendChild(document.createTextNode(p.label));
      if (p.badge) {
        var b = document.createElement('span');
        b.className = 'act-badge';
        b.id = 'nav-badge';
        b.style.display = 'none';
        a.appendChild(b);
      }
      menu.appendChild(a);
    });
    wrap.appendChild(menu);

    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden ? open() : close();
    });
    /* Closing on an outside tap matters more on a phone than a desktop: there
       is no Escape key and nowhere obvious to click away to. */
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    mount.insertBefore(wrap, mount.firstChild);
    return { wrap: wrap, button: btn, menu: menu, close: close };
  }

  /* Both badges at once — the one on the button and the one in the menu —
     so they cannot disagree about how much is waiting. */
  function setCount(n) {
    ['hdr-badge', 'nav-badge'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var c = Number(n) || 0;
      el.textContent = c > 99 ? '99+' : String(c);
      el.style.display = c > 0 ? '' : 'none';
    });
  }

  global.AdminNav = { PAGES: PAGES, render: render, setCount: setCount };
})(typeof window !== 'undefined' ? window : globalThis);
