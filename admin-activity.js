/* THE NOTIFICATION BADGE, IN ONE PLACE.
 *
 * Four admin pages want to say "something happened while you were away", and
 * four copies of that logic is four chances for the dot to disagree with the
 * list. One file, loaded by all of them.
 *
 * "Seen" is a timestamp in localStorage, not a flag in the database. That is
 * deliberate: it is per DEVICE, which is what you want when the phone in the
 * truck and the laptop in the shop are looked at by the same person at
 * different times — marking something read on one should not hide it on the
 * other. It also means the server keeps no per-person state.
 *
 * Nothing here throws on a missing localStorage: Safari's private mode
 * refuses it, and a header that crashes takes the page with it.
 */
(function (global) {
  'use strict';

  var SEEN_KEY = 'shedpro_admin_activity_seen';

  function readSeen() {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; }
  }
  function writeSeen(at) {
    if (!at) return;
    try { localStorage.setItem(SEEN_KEY, at); } catch (e) {}
  }

  function money(n) {
    return '$' + Number(n || 0).toLocaleString(undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* One line, in the words you would use out loud. The amount is the point of
     most of these, so it goes in the sentence rather than in a column. */
  function describe(e) {
    var who = e.customer_name || 'Someone';
    if (e.kind === 'payment') {
      var how = e.method === 'stripe' ? '' : ' by ' + (e.method || 'hand');
      return who + ' paid ' + money(e.amount) + how;
    }
    if (e.kind === 'invoice_sent') {
      var which = e.invoice_kind === 'deposit' ? 'Deposit' : 'Balance';
      return which + ' invoice sent to ' + who + ' — ' + money(e.amount);
    }
    if (e.kind === 'consult') return who + ' asked for a call back';
    if (e.kind === 'order') {
      return who + ' designed a shed' + (e.amount != null ? ' — ' + money(e.amount) : '');
    }
    return who;
  }

  function label(e) {
    if (e.kind === 'payment') return 'Paid';
    if (e.kind === 'invoice_sent') return 'Invoiced';
    if (e.kind === 'consult') return 'Call back';
    return 'New design';
  }

  /* Relative time, because "2 hours ago" is the question being asked. Falls
     back to the date once it stops being useful. */
  function ago(at) {
    var t = Date.parse(at);
    if (!isFinite(t)) return '';
    var secs = Math.round((Date.now() - t) / 1000);
    if (secs < 60) return 'just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hrs / 24);
    if (days <= 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(t).toLocaleDateString();
  }

  /* Fetches the feed and tells the caller what is new. authFetch is passed in
     rather than imported: each page already has its own, and they differ in
     where they send you when the session has expired. */
  function load(authFetch, opts) {
    opts = opts || {};
    var q = '/admin/activity?limit=' + (opts.limit || 60);
    var seen = readSeen();
    if (seen) q += '&since=' + encodeURIComponent(seen);
    return authFetch(q).then(function (r) {
      if (!r.ok) return { events: [], unseen: 0, latest: seen };
      var events = r.data.events || [];
      var latest = r.data.latest || seen;

      /* FIRST LOAD SETS THE BASELINE.
         With no stored timestamp the server flags nothing, which left the
         badge permanently dark until someone pressed "mark all as seen" — a
         notification that only works after you have acknowledged the
         notifications you never got. Nor is the answer to flag all sixty
         rows of existing history as new; that is noise on day one and
         teaches you to ignore the dot.
         So the first load anywhere in the admin quietly records where things
         stood. Everything after that is genuinely new. */
      if (!seen && latest) {
        writeSeen(latest);
        return { events: events, unseen: 0, latest: latest, baseline: true };
      }
      return {
        events: events,
        unseen: Number(r.data.unseen) || 0,
        latest: latest
      };
    });
  }

  /* The dot in the header. Hidden at zero rather than showing "0", which
     reads as a broken counter. */
  function badge(el, count) {
    if (!el) return;
    var n = Number(count) || 0;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? '' : 'none';
  }

  global.AdminActivity = {
    SEEN_KEY: SEEN_KEY,
    readSeen: readSeen,
    writeSeen: writeSeen,
    describe: describe,
    label: label,
    ago: ago,
    money: money,
    load: load,
    badge: badge
  };
})(typeof window !== 'undefined' ? window : globalThis);
