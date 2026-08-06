/**
 * MemBridge ops API — the private panel's only data source, and its only way
 * to write.
 *
 * Two planes, fetched separately and returned side by side but NEVER joined
 * (spec §7):
 *   counters — anonymous, install-scoped, from Analytics Engine
 *   business — account/team data, from Supabase ops_* functions
 * They share no key and there is no code path here that correlates them.
 *
 * ACCESS CONTROL, three independent layers:
 *   1. wrangler.toml sets workers_dev = false, so the only route is the
 *      Cloudflare Access-protected hostname.
 *   2. This Worker independently verifies the Access JWT and checks the email
 *      claim against an allowlist. Layer 1 alone holds right up until someone
 *      adds a route and forgets.
 *   3. Writes additionally require a same-origin JSON request (below).
 *
 * WHY LAYER 3 EXISTS — the one that is easy to miss. Access authenticates with
 * a cookie. A cross-site HTML form POSTing to this origin would carry that
 * cookie, Access would validate it at the edge and inject a perfectly genuine
 * JWT, and this Worker would see an authenticated request the operator never
 * intended to make. Classic CSRF, not fixed by Access. So every write must:
 *   - be Content-Type: application/json (a form cannot send this cross-origin
 *     without a CORS preflight, which we never answer), and
 *   - carry an Origin header matching this host.
 * Reads are exempt: they are side-effect free.
 *
 * All credentials are Worker secrets. The panel ships none.
 */

const COUNTER_WINDOW_DAYS = 30;

// Every action the panel may invoke, and the RPC it maps to. An action not in
// this table cannot be reached, whatever the request body says. Deliberately
// contains nothing destructive: no delete-team, no remove-member, no
// delete-entries. Those exist as product RPCs that run as the affected user,
// which is the right place for them.
const ACTIONS = {
  set_note:      { rpc: 'ops_set_team_note',            args: b => ({ p_team: b.team, p_note: b.note ?? null }) },
  set_internal:  { rpc: 'ops_set_team_internal',        args: b => ({ p_team: b.team, p_internal: !!b.internal }) },
  rotate_invite: { rpc: 'ops_rotate_invite',            args: b => ({ p_team: b.team }) },
  onboard:       { rpc: 'ops_create_onboarding_invite', args: b => ({ p_team_name: b.team_name, p_note: b.note ?? null, p_days: b.days ?? 14 }) },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// --- Cloudflare Access JWT verification -----------------------------------
let cachedKeys = null;

async function accessKeys(teamDomain) {
  if (cachedKeys) return cachedKeys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('cannot fetch Access certs');
  cachedKeys = (await res.json()).keys || [];
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
  } catch { return null; }
  if (header.alg !== 'RS256') return null; // never accept "none" or a downgrade

  const jwk = (await accessKeys(teamDomain)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(rawSig), new TextEncoder().encode(`${rawHeader}.${rawPayload}`));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now) return null;
  // aud pins the token to THIS application; without it a valid token for any
  // other app on the same Access team would open this one.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud && !auds.includes(aud)) return null;
  return payload;
}

async function authenticate(request, env) {
  const claims = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), {
    teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD,
  }).catch(() => null);
  if (!claims) return null;
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const email = String(claims.email || '').toLowerCase();
  if (!email) return null;

  // SEC-10. This used to read `if (allowed.length && !allowed.includes(email))`,
  // so an unset or whitespace-only ALLOWED_EMAILS SKIPPED the allowlist instead
  // of refusing. Everyone holding a valid Access JWT for this aud was then
  // admitted to the Worker that holds SUPABASE_SERVICE_KEY — and service_role
  // has rolbypassrls, so none of the RLS, membership predicates or definer
  // gates protecting the rest of the product are in the path behind this.
  // Nothing logged it and the panel kept working, so the only way to notice was
  // to read the line.
  //
  // An absent input was being read as permission. That is the THIRD instance of
  // that shape found today — with `project_access` treating an empty PostgREST
  // result as "no restriction", and readAccess treating an unreadable
  // default_access answer as `true` — which makes it a pattern in this
  // codebase rather than one careless line.
  //
  // It now fails CLOSED and says which of the two refusals happened. That
  // distinction is the whole point: "the allowlist is empty" is an operator
  // error that takes the panel down until a variable is set, and it must not be
  // indistinguishable in the logs from "you personally are not on the list".
  // A misconfiguration that silently locks everyone out is only marginally
  // better than one that silently lets everyone in — both are unexplained.
  //
  // BEHAVIOUR CHANGE, stated: if ALLOWED_EMAILS is ever unset or emptied, the
  // panel returns 403 for everybody instead of admitting everybody. That is
  // loud and recoverable; the previous behaviour was silent and was not.
  if (!allowed.length) {
    console.error('ops-api: ALLOWED_EMAILS is unset or empty — refusing all access. '
      + 'This is a configuration error, not a rejected user: set the ALLOWED_EMAILS '
      + 'secret on the Worker to a comma-separated list of Access emails.');
    return null;
  }
  if (!allowed.includes(email)) {
    console.warn('ops-api: refusing an authenticated Access identity that is not in ALLOWED_EMAILS');
    return null;
  }
  return email;
}

// --- Supabase --------------------------------------------------------------
// SEC-11. Reads and writes hold DIFFERENT database credentials, each scoped to
// its own Postgres role (migration 044). Neither has rolbypassrls and neither
// has any table privilege at all — every ops_* RPC is SECURITY DEFINER, so the
// function body runs as its owner and the caller supplies only the right to
// call. A leaked read credential pointed at /rest/v1/teams gets a permission
// error rather than a table, and cannot mint an onboarding invite (which
// redeem_onboarding_invite turns into a new team) or rotate a team's code.
//
// NO FALLBACK TO SUPABASE_SERVICE_KEY, deliberately. Falling back when the
// scoped key is absent would mean an unset variable silently restores
// database-wide privilege — the exact "absent input read as permission" shape
// this codebase has now produced four times (project_access reading an empty
// result as no-restriction, readAccess reading an unreadable default as true,
// the ops allowlist reading an empty list as no-allowlist, and this). Missing
// key is a loud 503, and the deploy order in supabase/APPLY-RUNBOOK.md exists
// so that state is never reached.
function dbKey(env, mode) {
  const name = mode === 'write' ? 'OPS_WRITE_KEY' : 'OPS_READ_KEY';
  const key = env[name];
  if (!key) {
    throw new Error(`${name} is not set on this Worker. The ops panel authenticates with `
      + 'two scoped database roles (migration 044); set both secrets with `wrangler secret put` '
      + 'or roll back to the previous deployment, which uses SUPABASE_SERVICE_KEY.');
  }
  return key;
}

async function rpc(env, fn, args, mode = 'read') {
  const key = dbKey(env, mode);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      // The apikey header is the project gateway's, not the role's — the ROLE
      // comes from the `role` claim in the bearer JWT. SUPABASE_ANON_KEY is
      // public by design, so preferring it here is not a privilege decision;
      // falling back to the scoped key keeps this working if it is unset.
      apikey: env.SUPABASE_ANON_KEY || key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Analytics Engine counts must be summed over _sample_interval, not counted as
// rows: above the sampling threshold each stored row stands for many events,
// so count(*) under-reports exactly when volume matters most.
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
    { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql });
  if (!res.ok) return { error: `analytics engine ${res.status}`, rows: [] };
  return { rows: (await res.json()).data || [] };
}

// --- CSRF ------------------------------------------------------------------
// See this file's header for why Access alone does not cover this.
function writeRequestIsSafe(request, url) {
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === url.host;
  } catch { return false; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const email = await authenticate(request, env);
    if (!email) return json({ error: 'unauthorized' }, 401);

    // --- writes ------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/api/action') {
      if (!writeRequestIsSafe(request, url)) return json({ error: 'bad request context' }, 403);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

      const spec = ACTIONS[body && body.action];
      if (!spec) return json({ error: 'unknown action' }, 400);
      if (body.team !== undefined && !UUID_RE.test(String(body.team))) {
        return json({ error: 'bad team id' }, 400);
      }

      // A missing credential is a CONFIGURATION error, not a database error,
      // and must not arrive as a 500 that reads like "the RPC failed". 503 with
      // the variable named is what tells whoever is on the deploy that they are
      // one `wrangler secret put` from working, rather than sending them to
      // look at Postgres.
      try { dbKey(env, 'write'); } catch (err) {
        console.error(`ops-api: ${String(err.message || err)}`);
        return json({ error: String(err.message || err) }, 503);
      }

      try {
        // p_actor is the VERIFIED Access email, never anything the client sent.
        // It is a required argument on every write RPC, so the audit trail
        // cannot be skipped by omitting it.
        const out = await rpc(env, spec.rpc, { p_actor: email, ...spec.args(body) }, 'write');
        return json({ ok: true, result: out });
      } catch (err) {
        return json({ error: String(err.message || err) }, 500);
      }
    }

    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    // --- single team drill-down -------------------------------------------
    const detail = url.pathname.match(/^\/api\/team\/([0-9a-f-]{36})$/i);
    if (detail) {
      try {
        return json({ team: await rpc(env, 'ops_team_detail', { p_team: detail[1] }) });
      } catch (err) {
        return json({ error: String(err.message || err) }, 500);
      }
    }

    // --- overview ----------------------------------------------------------
    // SEC-11, failure mode (b). `ops_audit_recent` and `ops_onboarding_invites`
    // used to swallow every failure as `.catch(() => [])`, so a MISSING GRANT
    // rendered an empty list — indistinguishable from "nothing has happened
    // recently". The panel looked healthy and was lying, which is the worst
    // outcome of a credential change: not an outage you notice, a downgrade you
    // do not. Scoping the role makes a per-RPC permission error a real
    // possibility for the first time, so the swallow had to go with it.
    //
    // The fallbacks are UNCHANGED so the panel's existing fields keep their
    // shapes and the UI cannot break on this. What is added is `degraded`: an
    // additive field naming every read that failed and why. Empty array means
    // everything answered.
    const degraded = [];
    // `fallback` may be a value or a function of the error message, because
    // ops_snapshot's existing contract with the panel is to return { error }
    // and counters' is to return { error, rows: [] }. Preserving each shape
    // exactly is what makes this additive rather than a UI change.
    const readOr = (name, fallback, promise) => promise.catch(e => {
      const error = String((e && e.message) || e);
      console.error(`ops-api: read "${name}" failed: ${error}`);
      degraded.push({ source: name, error });
      return typeof fallback === 'function' ? fallback(error) : fallback;
    });

    const [counters, business, audit, invites] = await Promise.all([
      readOr('counters', error => ({ error, rows: [] }), fetchCounters(env)),
      readOr('ops_snapshot', error => ({ error }), rpc(env, 'ops_snapshot', { p_exclude_teams: [] })),
      readOr('ops_audit_recent', [], rpc(env, 'ops_audit_recent', { p_limit: 50 })),
      readOr('ops_onboarding_invites', [], rpc(env, 'ops_onboarding_invites', {})),
    ]);

    // fetchCounters reports a bad response by RETURNING { error } rather than
    // throwing, so it never reaches readOr's catch. Folded in here so one field
    // means one thing: if `degraded` is empty, every source answered.
    if (counters && counters.error) degraded.push({ source: 'counters', error: counters.error });

    return json({ counters, business, audit, invites, degraded, viewer: email });
  },
};
