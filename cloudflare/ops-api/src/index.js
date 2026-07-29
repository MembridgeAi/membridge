/**
 * MemBridge ops API — the private dashboard's only data source.
 *
 * Two planes, fetched separately and returned side by side but NEVER joined
 * (spec §7):
 *
 *   counters — anonymous, install-scoped, from Analytics Engine
 *   business — account/team aggregates, from Supabase ops_snapshot()
 *
 * They share no key and there is deliberately no code path here that
 * correlates them. Joining them would produce per-team behavioural telemetry
 * tied to real accounts, which is the shape this design exists to avoid. If a
 * future change wants "which team hit that failure", that is a spec change
 * with a stated cost, not a patch to this file.
 *
 * ACCESS CONTROL, two independent layers:
 *   1. wrangler.toml sets workers_dev = false, so the only route is the
 *      Cloudflare Access-protected hostname. Access rejects anonymous callers
 *      at the edge, before this code runs.
 *   2. This Worker independently verifies the Access JWT and checks the email
 *      claim against an allowlist. Layer 1 alone would be enough right up
 *      until someone adds a route and forgets, which is exactly the kind of
 *      mistake that should not be able to disclose anything.
 *
 * All credentials are Worker secrets. The dashboard page ships no secret and
 * discloses nothing if its bundle leaks.
 */

const COUNTER_WINDOW_DAYS = 30;

// --- Cloudflare Access JWT verification -----------------------------------
// Access signs with RS256 and publishes its keys at the team's certs endpoint.
// Keys are cached for the isolate's lifetime; a rotation is picked up when the
// isolate recycles, and a signature that fails simply 401s.
let cachedKeys = null;

async function accessKeys(teamDomain) {
  if (cachedKeys) return cachedKeys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('cannot fetch Access certs');
  const { keys } = await res.json();
  cachedKeys = keys || [];
  return cachedKeys;
}

const b64urlToBytes = s => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function verifyAccessJwt(token, { teamDomain, aud }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null; // never accept "none" or a downgrade

  const jwk = (await accessKeys(teamDomain)).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now) return null;
  // aud pins the token to THIS application. Without it, a valid token for any
  // other app on the same Access team would open this one.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud && !auds.includes(aud)) return null;

  return payload;
}

// --- Data sources ----------------------------------------------------------

// Analytics Engine counts must be summed over _sample_interval, not counted as
// rows: above the sampling threshold each stored row represents many events,
// and count(*) would silently under-report exactly when volume matters most.
async function fetchCounters(env) {
  const sql = `
    SELECT blob1 AS name, blob2 AS version, blob3 AS dim_key, blob4 AS dim_value,
           sum(_sample_interval) AS total
    FROM membridge_counters
    WHERE timestamp > now() - INTERVAL '${COUNTER_WINDOW_DAYS}' DAY
    GROUP BY name, version, dim_key, dim_value
    ORDER BY total DESC
    FORMAT JSON`;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql },
  );
  if (!res.ok) return { error: `analytics engine ${res.status}`, rows: [] };
  const json = await res.json();
  return { rows: json.data || [] };
}

async function fetchBusiness(env) {
  const exclude = env.EXCLUDE_TEAMS ? JSON.parse(env.EXCLUDE_TEAMS) : [];
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ops_snapshot`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_exclude_teams: exclude }),
  });
  if (!res.ok) return { error: `supabase ${res.status}` };
  return await res.json();
}

export default {
  async fetch(request, env) {
    const email = await (async () => {
      // Access presents the token as a header on every proxied request.
      const token = request.headers.get('cf-access-jwt-assertion');
      const claims = await verifyAccessJwt(token, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
      }).catch(() => null);
      if (!claims) return null;
      const allowed = (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const claimed = String(claims.email || '').toLowerCase();
      if (allowed.length && !allowed.includes(claimed)) return null;
      return claimed;
    })();

    if (!email) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetched concurrently, merged into one response object, and that is the
    // only relationship they ever have. No key is shared, nothing is
    // correlated — see this file's header.
    const [counters, business] = await Promise.all([
      fetchCounters(env).catch(e => ({ error: String(e && e.message || e), rows: [] })),
      fetchBusiness(env).catch(e => ({ error: String(e && e.message || e) })),
    ]);

    return new Response(JSON.stringify({ counters, business, viewer: email }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};
