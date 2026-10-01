/* HOW AN ADDRESS IS WRITTEN DOWN, in one place.
 *
 * Four places composed one by hand and no two agreed. Three dropped the ZIP
 * entirely — including the location on the Google Calendar invite, which is
 * the address a crew types into a phone on the morning of an install. The
 * fourth kept it and punctuated it "Riverton, UT, 84065".
 *
 * A US address takes a COMMA between the street and the city and between the
 * city and the state, and a SPACE before the ZIP. Not a comma: "UT, 84065"
 * reads as a list and is what every hand-rolled `[city, state, zip].join(', ')`
 * produces, which is exactly why this is a function and not a convention.
 *
 * Blank parts fall out rather than leaving stray punctuation — most of these
 * rows have a city and state and nothing else, and ", , UT" is worse than no
 * address at all.
 */

function clean(v) {
  return String(v == null ? '' : v).trim();
}

/* "Riverton, UT 84065" — the locality line on its own. */
export function cityStateZip(c) {
  c = c || {};
  var city = clean(c.city), state = clean(c.state), zip = clean(c.zip);
  /* The state and the ZIP are ONE field joined by a space; the comma belongs
     between the city and that field. Building it in that order is what keeps
     a missing state from producing "Riverton, 84065" with a comma that now
     separates nothing. */
  var tail = [state, zip].filter(Boolean).join(' ');
  return [city, tail].filter(Boolean).join(', ');
}

/* "11999 South Lampton View Drive, Riverton, UT 84065" — what you navigate to. */
export function fullAddress(c) {
  c = c || {};
  return [clean(c.address), cityStateZip(c)].filter(Boolean).join(', ');
}
