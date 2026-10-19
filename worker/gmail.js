/* READ-ONLY Gmail access for the briefing's email section.
 *
 * Design (see README "Briefing email"): an OAuth refresh token for the ShedPro
 * mailbox, consented with ONLY the gmail.readonly scope, stored as Worker
 * secrets. The worker trades it for a short-lived access token per request,
 * reads thread METADATA (From / Subject / Date / labels) plus Gmail's own short
 * snippet, and returns it. Nothing is cached, nothing is written to D1, and
 * there is no code path that sends, labels, archives or marks anything read
 * (threads.get with format=metadata does not change UNREAD).
 *
 * Off unless BRIEFING_EMAIL_ENABLED === "true" AND all three secrets are set.
 * If the token's granted scopes include anything beyond read-only Gmail, it is
 * refused rather than used — a broader token pasted in by mistake fails closed.
 *
 * No imports: build-bundle.mjs inlines this file. `fetchImpl` is injectable
 * so tests never touch the network.
 */

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_QUERY = 'in:inbox newer_than:7d -category:promotions -category:social -category:forums -category:updates';

export function gmailConfigured(env) {
  return !!(env && String(env.BRIEFING_EMAIL_ENABLED || '').toLowerCase() === 'true'
    && env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

export function gmailSelfAddresses(env) {
  return String((env && env.GMAIL_SELF_ADDRESSES) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/* Only read-only scopes are acceptable. */
export function scopesAreReadOnly(scopeStr) {
  const scopes = String(scopeStr || '').split(/\s+/).filter(Boolean);
  if (!scopes.length) return false;
  const ok = new Set([GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.metadata']);
  return scopes.every((s) => ok.has(s));
}

async function accessToken(env, fetchImpl) {
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString()
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  if (!scopesAreReadOnly(j.scope)) throw new Error('refusing a Gmail token that is not read-only');
  return j.access_token;
}

function header(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/* Returns a function that fetches recent unread inbox threads as
   [{ id, messages:[{ id, from, subject, date, labelIds, snippet }] }], or null
   when email is not configured. */
export function makeThreadFetcher(env, fetchImpl = fetch, maxThreads = 15) {
  if (!gmailConfigured(env)) return null;
  return async () => {
    const token = await accessToken(env, fetchImpl);
    const auth = { Authorization: 'Bearer ' + token };
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const list = await fetchImpl(`${base}/threads?maxResults=${maxThreads}&q=${encodeURIComponent(GMAIL_QUERY)}`, { headers: auth });
    if (!list.ok) throw new Error('list ' + list.status);
    const ids = ((await list.json()).threads || []).map((t) => t.id);
    const threads = await Promise.all(ids.map(async (id) => {
      const r = await fetchImpl(`${base}/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id`, { headers: auth });
      if (!r.ok) return null;
      const t = await r.json();
      return { id: t.id, messages: (t.messages || []).map((m) => ({ id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'),
        date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'Date'),
        labelIds: m.labelIds || [], snippet: m.snippet || '',
        list_unsubscribe: !!header(m, 'List-Unsubscribe'), list_id: !!header(m, 'List-Id') })) };
    }));
    return threads.filter(Boolean);
  };
}
