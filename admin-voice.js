/* GOOGLE VOICE, FOR EVERY ADMIN PAGE THAT DIALS OR TEXTS A CUSTOMER.
 *
 * This shop does not send from the handset. Calls and texts go out on the
 * business line through Google Voice, so tel: and sms: are both wrong here:
 * tel: dials from whatever SIM the phone in your hand happens to have, and
 * sms: hands the message to the phone's own app, from a number the customer
 * has never seen. Those links were on three pages and worked on none of them.
 *
 * Shared rather than copied. The same mistake happened with the nav — six
 * hand-written copies before it became admin-nav.js — and the notes below are
 * the result of actual testing on a phone, which does not survive being
 * retyped into a fourth page.
 *
 * ---------------------------------------------------------------------------
 * voice.google.com deep-links: with the Google Voice app installed these open
 * the app directly (iOS Universal Links / Android App Links); everywhere else
 * they open Voice on the web, already pointed at the right number.
 *
 * The two URLs differ on purpose, and the difference is not an oversight.
 *
 * CALL — no /u/0/ account index. Tested on iOS: with the index the link opens
 * Safari, without it the Google Voice app takes it. So don't add an index back
 * here to disambiguate between Google accounts; it trades the app for the
 * browser. The app opens whichever account it is signed into.
 *
 * TEXT — opens the app, and deliberately carries NO number.
 *
 * Tested: the app registers /calls and ignores /messages, so a messages URL
 * can never open it. /calls opens the app on ANY action code, including
 * deliberate nonsense, which means unrecognised actions are dropped and there
 * is no message action to find. A link that lands on a specific thread in the
 * app does not exist.
 *
 * Given the choice between the right thread in the browser and the app with no
 * thread, this goes to the app. But NOT with the number attached: /calls with a
 * number opens the DIALER on it, and a button labelled Text that can place a
 * call is a trap. So the bare path opens the app, and the number goes to the
 * clipboard instead — paste it into Voice's search.
 *
 * To go back to the browser landing on the exact thread, this is the one line:
 *   'https://voice.google.com/u/0/messages?itemId=t.'  (and set newTab true)
 */
(function (global) {
  'use strict';

  var GV_CALL_URL = 'https://voice.google.com/calls?a=nc,';
  var GV_TEXT_URL = 'https://voice.google.com/calls';

  /* Google Voice wants E.164 (+15551234567). Assumes US/Canada, which is what
     this business serves — a 10-digit number gets +1, an 11-digit starting with
     1 gets a plus, anything already longer is passed through as-is. Anything
     else is null, and a caller with null must not render a dead button. */
  function toE164(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    if (d.length > 11) return '+' + d;
    return null;
  }

  function callHref(phone) {
    var e = toE164(phone);
    return e ? GV_CALL_URL + encodeURIComponent(e) : null;
  }

  /* No number in the URL, by the reasoning above. */
  function textHref(phone) {
    return toE164(phone) ? GV_TEXT_URL : null;
  }

  /* Points an existing <a> at Voice.
   *
   * Both navigate the CURRENT tab, which is what iOS needs to hand a URL to an
   * app — and nothing is lost by it, because when the app takes the link Safari
   * stays where it was, so the page underneath is still there.
   *
   * On a text, the number rides onto the clipboard as the link is followed. No
   * preventDefault and no scripted navigation: the anchor is followed natively,
   * because a JS-driven navigation is exactly the kind iOS declines to hand to
   * an app. The copy just goes along with it.
   *
   * Returns false and leaves the element alone when there is no usable number,
   * so each page decides for itself whether that means hiding the control or
   * showing it disabled. */
  function attach(a, phone, kind) {
    if (!a) return false;
    var href = kind === 'text' ? textHref(phone) : callHref(phone);
    if (!href) return false;
    a.href = href;
    a.rel = 'noopener';
    if (kind === 'text') {
      var e164 = toE164(phone);
      a.title = 'Text on Google Voice — opens Voice and copies ' + e164;
      a.addEventListener('click', function () {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(e164);
          }
        } catch (err) {
          /* A failed copy must never stop the app opening — that is the point
             of the tap; the clipboard is the bonus. */
        }
      });
    } else {
      a.title = 'Call on Google Voice';
    }
    return true;
  }

  global.AdminVoice = { toE164: toE164, callHref: callHref, textHref: textHref, attach: attach };
})(window);
