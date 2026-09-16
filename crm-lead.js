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
    return line;
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  global.LeadDetail = { badge: whyBadge, block: leadDetail, bindFeePrefill: bindFeePrefill, feeHint: feeHint };
})(window);
