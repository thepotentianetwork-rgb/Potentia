/* Shared by the client list (crm.html) and the client page (crm-client.html).

   Both have to say the same thing about a lead — the same badge, the same
   evidence, the same wording. It lives here because the alternative is two
   copies that agree right up until one of them is edited.

   Everything is built as DOM nodes rather than markup: every value in here
   came off the open internet. */
(function (global) {
  'use strict';

  /* The headline reason, short enough to sit under the business name. The full
     sentence is still in the detail block; this is the version you can read at
     a glance down a list of thirty.

     Derived from the stored evidence rather than parsed back out of the reason
     text, so it cannot drift from what the pipeline actually decided. */
  function whyBadge(c) {
    if (c.lead_speed != null) {
      var n = Number(c.lead_speed);
      if (Number(c.lead_mobile_ready) === 0) {
        // Short enough to sit on one line in a narrow column.
        return { tone: 'bad', text: n + '/100 \u00b7 no mobile' };
      }
      return { tone: n < 50 ? 'bad' : 'mid', text: n + '/100 mobile' };
    }
    if (Number(c.lead_mobile_ready) === 0) return { tone: 'bad', text: 'No mobile view' };
    if (!c.website_url) return { tone: 'bad', text: 'No website' };

    /* A site we never scored: either it is one of the pages that never needed a
       speed test, or Google could not load it. The reason line says which. */
    var r = String(c.lead_reason || '');
    if (/business\.site/.test(r)) return { tone: 'bad', text: 'Dead site' };
    if (/just a ([a-z.]+) page/.test(r)) return { tone: 'bad', text: r.match(/just a ([a-z.]+) page/)[1] + ' only' };
    if (/plain http/.test(r)) return { tone: 'bad', text: 'No https' };
    if (/does not load|does not resolve|returns an error|never finishes loading|not served securely|cannot load/.test(r)) {
      return { tone: 'bad', text: 'Site won\u2019t load' };
    }
    return null;
  }

  /* Everything the pipeline found out about a business, for someone about to
     ring it. Built with DOM nodes rather than innerHTML because every value
     here came off the open internet.

     The one thing deliberately NOT copied in is Google's own listing data —
     reviews, photos, hours, opening times. That is a link instead: it is always
     current, and a number we cached last Tuesday would be worse than useless on
     a call. */
  function leadDetail(c, labels) {
    var box = document.createElement('div');
    box.className = 'lead-detail';

    function line(key, node, wide) {
      var d = document.createElement('div');
      d.className = 'ld-line' + (wide ? ' ld-wide' : '');
      var k = document.createElement('span');
      k.className = 'ld-k';
      k.textContent = key;
      d.appendChild(k);
      d.appendChild(node);
      box.appendChild(d);
      return d;
    }
    function text(t, cls) {
      var s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = t;
      return s;
    }
    function link(href, label) {
      var a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      return a;
    }

    /* The reason first. In a list it is the thing being scanned for, and
       putting it last meant reading past four fields to reach it. */
    if (c.lead_reason) line('Why', text(c.lead_reason, 'ld-why'), true);

    // Then: is there a site, and can I look at it right now?
    if (c.website_url) {
      var href = /^https?:\/\//i.test(c.website_url) ? c.website_url : 'https://' + c.website_url;
      line('Site', link(href, c.website_url));
    } else {
      line('Site', text('No website at all', 'ld-none'));
    }

    // Google's own mobile verdict, when we measured one.
    if (c.lead_speed != null || c.lead_mobile_ready != null) {
      var row = document.createElement('span');
      if (c.lead_speed != null) {
        var n = Number(c.lead_speed);
        var pill = text(n + '/100 mobile', 'speed-pill ' + (n < 50 ? 'speed-bad' : n < 90 ? 'speed-mid' : 'speed-ok'));
        row.appendChild(pill);
      }
      if (Number(c.lead_mobile_ready) === 0) {
        var warn = text('no mobile viewport', 'speed-pill speed-bad');
        warn.style.marginLeft = '6px';
        row.appendChild(warn);
      }
      line('Speed', row);
    }

    // The town is already under the name; this is the street address.
    if (c.lead_address) line('Address', text(c.lead_address));
    if (c.lead_segment || c.lead_trade) {
      var what = (labels || {})[c.lead_segment] || c.lead_segment || '';
      // The trade is the useful half: "roofing contractor", not "subcontractor".
      /* The tidy name where the page has the map, the raw search term where it
         does not — either is readable, and neither waits on a fetch. */
      var trade = c.lead_trade
        ? ((global.TRADE_LABELS || {})[c.lead_trade] || c.lead_trade) : '';
      line('Trade', text(trade ? (what ? trade + '  ·  ' + what : trade) : what));
    }

    /* Straight to the live listing — reviews, photos, hours, how long they have
       been there. place_id is the only thing Google lets us keep, and it is the
       only thing this needs. */
    if (c.place_id) {
      line('Google', link(
        'https://www.google.com/maps/search/?api=1&query=' +
          encodeURIComponent(c.business_name || '') +
          '&query_place_id=' + encodeURIComponent(c.place_id),
        'Open their listing'));
    }

    return box;
  }

  /* Filling the fees in from the package, in one place because both CRM pages
     do it and getting it subtly different on one of them is how a client ends
     up quoted at another tier's price.

     Three rules:
       - An empty field gets the list price.
       - A figure someone TYPED is never touched. That is the real quote.
       - A figure this put there may be replaced — including with nothing,
         when the new package has no list price. Without that last part,
         picking Tier 1 and then changing to Custom CRM leaves 500 in the box
         and a custom build goes out priced like a two-page website.

     `prices` is { key: {price, monthly} }, read from /crm/packages. */
  function bindFeePrefill(select, fields, prices, hintEl) {
    var filled = {};                       // field -> what we last put in it
    function apply() {
      var row = prices[select.value] || {};
      fields.forEach(function (f) {
        var el = f.el, cur = String(el.value).trim();
        if (cur && cur !== filled[f.key]) return;   // typed by a person, leave it
        var v = row[f.key];
        el.value = v == null ? '' : v;
        filled[f.key] = v == null ? undefined : String(v);
      });
      if (hintEl) hintEl.textContent = feeHint(row);
    }
    select.addEventListener('change', apply);
    return apply;
  }

  /* What the figures in the boxes MEAN, said next to them.

     A website tier is a list price. A CRM or a platform is scoped per
     business and the figure is only a floor — so the box says 2000 either
     way, and without this line the difference is invisible. Someone quotes a
     custom CRM at exactly 2000 because that is what the field said, and the
     build runs at a loss. */
  function feeHint(row) {
    if (!row || row.price == null) return '';
    var from = row.from ? 'from ' : '';
    var bits = [from + money(row.price) + ' build'];
    if (row.monthly != null) bits.push(from + money(row.monthly) + '/mo');
    var line = (row.from ? 'Starts at — scope it: ' : 'List: ') + bits.join(' · ');
    if (row.seatsIncluded != null) {
      line += ' · ' + row.seatsIncluded + ' logins included';
      if (row.perSeat != null) {
        line += ', ' + (row.perSeatFrom ? '' : '') + money(row.perSeat) +
                (row.perSeatFrom ? '+' : '') + '/mo each after';
      }
    }
    /* Turnaround on the same line as the price, because it is the other half
       of what gets said on the phone - and because the string carries the
       condition, quoting the hours without "from completed form + payment"
       is not possible by accident. */
    if (row.turnaround) line += ' · ' + row.turnaround;
    return line;
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }


  /* CALL AND TEXT, one implementation for both pages.

     Google Voice rather than tel: and sms:, so the call goes out on the
     business line instead of whatever SIM the iPad in your hand happens to
     have, and so the thread is in one place afterwards.

     /calls?a=nc,<number> places the call. Text points at /calls with NO
     number, because that same path WITH one opens the dialer — a Text button
     that can place a call is a trap. Voice ignores /messages, so no link can
     land on a specific thread; the number goes to the clipboard instead. */
  /* voice.google.com deep-links: with the Google Voice app installed these
     open the app directly (iOS Universal Links / Android App Links);
     everywhere else they open Voice on the web, already pointed at the right
     number. The two URLs differ on purpose, and the difference is not an
     oversight.

     CALL - no /u/0/ account index. Tested on iOS: with the index the link
     opens Safari, without it the Google Voice app takes it. So don't add an
     index back to disambiguate between Google accounts; it trades the app for
     the browser. The app opens whichever account it is signed into.

     TEXT - opens the app, and deliberately carries NO number. See the long
     note in admin-customer.html for the testing behind it. */
  var GV_CALL_URL = 'https://voice.google.com/calls?a=nc,';
  var GV_TEXT_URL = 'https://voice.google.com/calls';
  var CALL_ICON = '<path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>';
  var TEXT_ICON = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';

  /* Google Voice wants E.164 (+15551234567). Assumes US/Canada - a 10-digit
     number gets +1, an 11-digit starting with 1 gets a plus, anything longer
     is passed through as already-international. Null for anything else,
     including the half-typed numbers the client page sees on every keystroke. */
  function toE164(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    if (d.length > 11) return '+' + d;
    return null;
  }

  /* A Call and a Text button for one number, or null when there is no number
     we can dial. Null rather than an empty fragment so the caller can tell
     "nothing to show" from "two buttons" without counting children.

     opts.className goes on each link, because the list needs them smaller
     than the client page does. */
  function phoneActions(phone, opts) {
    var e164 = toE164(phone);
    if (!e164) return null;
    opts = opts || {};
    var size = opts.icon || 12;
    var frag = document.createDocumentFragment();
    [['Call', GV_CALL_URL, CALL_ICON, true],
     ['Text', GV_TEXT_URL, TEXT_ICON, false]].forEach(function (spec) {
      var a = document.createElement('a');
      a.href = spec[3] ? spec[1] + encodeURIComponent(e164) : spec[1];
      /* Current tab on both: a new tab is what stops iOS handing the link to
         the app, and the app opening over Safari leaves this record right
         here. */
      a.rel = 'noopener';
      if (opts.className) a.className = opts.className;
      a.title = spec[3]
        ? 'Call ' + e164 + ' on Google Voice'
        : 'Text on Google Voice — opens the app and copies ' + e164;
      if (!spec[3]) {
        /* Rides along with the native navigation - no preventDefault, because
           a scripted navigation is the kind iOS declines to hand to an app. */
        a.addEventListener('click', function () {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(e164);
            }
          } catch (e) {}
        });
      }
      a.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
        '" fill="none" stroke="currentColor" stroke-width="1.8">' + spec[2] + '</svg>' + spec[0];
      frag.appendChild(a);
    });
    return frag;
  }

  global.LeadDetail = { badge: whyBadge, block: leadDetail, bindFeePrefill: bindFeePrefill,
                        feeHint: feeHint, toE164: toE164, phoneActions: phoneActions };
})(window);
