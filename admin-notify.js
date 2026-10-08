/* LIVE FORM ALERTS on the Customers screen.
 *
 * Designer quotes, designer call-backs and the contact-page info request all
 * land in submissions, and /admin/activity already lists them. This polls that
 * feed while the page is open and, for anything newer than this browser's
 * last-seen stamp, raises a toast, counts it, and marks the row.
 *
 * Last-seen is per browser (localStorage), same idea as the activity badge,
 * but its own key: opening this page must not mark the Activity tab read,
 * and dismissing a toast must not bring the same lead back on the next poll.
 * The first visit only draws the line. It does not announce history.
 */
(function (global) {
  'use strict';
  var KEY = 'shedpro_form_notify_seen';
  var FRESH = 'shedpro_form_notify_fresh';
  var POLL_MS = 25000;
  var fresh = {};

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function loadFresh() {
    try { fresh = JSON.parse(read(FRESH) || '{}') || {}; } catch (e) { fresh = {}; }
    if (!fresh || typeof fresh !== 'object') fresh = {};
  }
  function saveFresh() { write(FRESH, JSON.stringify(fresh)); }

  function isForm(e) { return e && (e.kind === 'consult' || e.kind === 'order'); }
  function tagOf(e) {
    var k = global.AdminActivity && AdminActivity.formKind(e);
    if (k) return k;
    if (e.kind === 'order') return 'Designer';
    return 'Call back';
  }
  function unacked() { return Object.keys(fresh).length; }

  function paint() {
    document.querySelectorAll('#customers-body tr[data-cid]').forEach(function (tr) {
      var id = tr.getAttribute('data-cid');
      var on = false;
      Object.keys(fresh).forEach(function (k) {
        if (String(fresh[k].customer_id) === String(id)) on = true;
      });
      tr.classList.toggle('lead-fresh', on);
    });
    var n = unacked();
    var badge = document.getElementById('form-badge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
    }
    if (global.AdminNav && n > 0) AdminNav.setCount(n);
  }

  function chime() {
    try {
      if (global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.05, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.22);
      o.onended = function () { try { ctx.close(); } catch (e) {} };
    } catch (e) {}
  }

  function desktop(title, body, tag) {
    if (!global.Notification || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, tag: tag }); } catch (e) {}
  }

  function ensureBox() {
    var box = document.getElementById('form-toasts');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'form-toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
    return box;
  }

  function toast(items) {
    var box = ensureBox();
    items.slice(0, 3).forEach(function (e) {
      var a = document.createElement('a');
      a.className = 'form-toast';
      a.href = 'admin-customer.html?id=' + encodeURIComponent(e.customer_id);
      var tag = tagOf(e);
      var when = (global.AdminActivity && AdminActivity.ago(e.at)) || '';
      var bits = [];
      if (e.summary) bits.push(e.summary);
      if (when) bits.push(when);
      var label = document.createElement('span');
      label.className = 'ft-tag';
      label.textContent = tag;
      var name = document.createElement('strong');
      name.textContent = e.customer_name || 'New submission';
      var meta = document.createElement('span');
      meta.className = 'ft-meta';
      meta.textContent = bits.join(' · ');
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'ft-x';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '×';
      x.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        delete fresh[e.id];
        saveFresh();
        a.remove();
        paint();
      });
      a.appendChild(label);
      a.appendChild(name);
      a.appendChild(meta);
      a.appendChild(x);
      a.addEventListener('click', function () {
        delete fresh[e.id];
        saveFresh();
      });
      box.appendChild(a);
      desktop(tag + ': ' + (e.customer_name || 'New submission'), bits.join(' · '), e.id);
    });
    if (items.length && global.Notification && Notification.permission === 'default') {
      var ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'form-toast ft-ask';
      ask.textContent = 'Turn on desktop alerts';
      ask.addEventListener('click', function () {
        try { Notification.requestPermission(); } catch (e) {}
        ask.remove();
      });
      box.appendChild(ask);
    }
  }

  /* events are newest-first, which /admin/activity already guarantees. */
  function consider(events, alert) {
    var forms = (events || []).filter(isForm);
    var newest = forms.length ? forms[0].at : '';
    var seen = read(KEY);
    if (!seen) {
      write(KEY, newest || new Date().toISOString());
      return;
    }
    var neu = forms.filter(function (e) { return e.at && e.at > seen; });
    if (!neu.length) return;
    write(KEY, neu[0].at > seen ? neu[0].at : seen);
    neu.forEach(function (e) {
      fresh[e.id] = { customer_id: e.customer_id, tag: tagOf(e), at: e.at };
    });
    saveFresh();
    paint();
    if (alert) {
      toast(neu);
      chime();
    }
  }

  function poll(authFetch) {
    return authFetch('/admin/activity?limit=40').then(function (r) {
      if (!r || !r.ok) return;
      consider((r.data && r.data.events) || [], true);
    }).catch(function () {});
  }

  function start(authFetch) {
    loadFresh();
    paint();
    var first = !read(KEY);
    authFetch('/admin/activity?limit=40').then(function (r) {
      if (!r || !r.ok) return;
      consider((r.data && r.data.events) || [], !first);
    }).catch(function () {});
    setInterval(function () { poll(authFetch); }, POLL_MS);
  }

  global.FormNotify = { start: start, paint: paint, poll: poll, unacked: unacked };
})(typeof window !== 'undefined' ? window : globalThis);
