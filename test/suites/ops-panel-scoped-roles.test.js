'use strict';
// SEC-11 — the ops panel stops authenticating as `service_role`.
//
// WHY. cloudflare/ops-api is the sole holder of SUPABASE_SERVICE_KEY, and
// service_role has rolbypassrls plus read+write on all fifteen public tables.
// Every protection in this schema is downstream of it. Migration 044 creates
// two roles — ops_panel_read and ops_panel_write — with EXECUTE on eight
// ops_* RPCs between them, no rolbypassrls, and NO table privileges at all
// (every ops_* function is SECURITY DEFINER, so the body runs as its owner and
// the caller supplies only the right to call).
//
// This suite pins the WORKER half: that reads and writes carry different
// credentials, that a missing credential fails loudly instead of falling back
// to the service key, and that a per-RPC permission failure is reported rather
// than rendered as an empty list.
//
// WHAT IT CANNOT COVER. It runs the Worker in Node against a stubbed fetch. It
// cannot verify the Postgres roles exist, that `authenticator` can assume them,
// or that the JWTs are minted correctly — those need the live project and are
// the verification queries at the foot of migration 044. What is checkable
// offline, and what actually decides whether the scoping does anything, is
// WHICH credential each call site sends.
//
// Run directly, or via `node test/run.js ops-panel-scoped-roles`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKER = pathToFileURL(
  path.join(__dirname, '..', '..', 'cloudflare', 'ops-api', 'src', 'index.js')).href;

const TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
const AUD = 'aud-for-this-app';
const KID = 'test-key-1';
const OPERATOR = 'operator@example.com';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64url = buf => Buffer.from(buf).toString('base64url');

function makeJwt({ email = OPERATOR, aud = AUD } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ email, aud, exp: now + 600, iat: now }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

// Records every outbound request so the assertions can be about WHICH
// credential was sent, not merely about the status code — the whole point of
// the change is invisible from the response.
let sent = [];
function stubFetch({ failRpc = null } = {}) {
  sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    const headers = (init && init.headers) || {};
    sent.push({ url: u, auth: headers.Authorization || '', apikey: headers.apikey || '' });
    if (failRpc && u.includes(`/rpc/${failRpc}`)) {
      // What a missing GRANT looks like coming back from PostgREST.
      return new Response(JSON.stringify({
        message: `permission denied for function ${failRpc}`,
      }), { status: 403 });
    }
    return new Response(JSON.stringify({ data: [], ok: true }), { status: 200 });
  };
}

const SERVICE_KEY = 'SYNTHETIC-SERVICE-ROLE-KEY';
const READ_KEY = 'SYNTHETIC-OPS-READ-KEY';
const WRITE_KEY = 'SYNTHETIC-OPS-WRITE-KEY';

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
  ALLOWED_EMAILS: OPERATOR,
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_KEY: SERVICE_KEY,
  OPS_READ_KEY: READ_KEY,
  OPS_WRITE_KEY: WRITE_KEY,
  CF_ACCOUNT_ID: 'synthetic',
  CF_API_TOKEN: 'synthetic',
};

const getReq = () => new Request('https://ops.example.test/api',
  { headers: { 'cf-access-jwt-assertion': makeJwt() } });

const writeReq = () => new Request('https://ops.example.test/api/action', {
  method: 'POST',
  headers: {
    'cf-access-jwt-assertion': makeJwt(),
    'content-type': 'application/json',
    origin: 'https://ops.example.test',
  },
  body: JSON.stringify({ action: 'rotate_invite', team: '11111111-2222-3333-4444-555555555555' }),
});

const rpcCalls = () => sent.filter(s => s.url.includes('/rest/v1/rpc/'));
const callFor = fn => rpcCalls().find(s => s.url.includes(`/rpc/${fn}`));

async function main() {
  const worker = (await import(WORKER)).default;
  const run = (request, env) => worker.fetch(request, { ...baseEnv, ...env });

  await check('every read RPC is sent with the READ credential', async () => {
    stubFetch();
    const res = await run(getReq(), {});
    assert.strictEqual(res.status, 200, `overview status ${res.status}`);
    const reads = ['ops_snapshot', 'ops_audit_recent', 'ops_onboarding_invites'];
    for (const fn of reads) {
      const c = callFor(fn);
      assert.ok(c, `${fn} was never called`);
      assert.strictEqual(c.auth, `Bearer ${READ_KEY}`,
        `${fn} must go out under the scoped read role, not the service key; sent ${c.auth}`);
    }
  });

  await check('a write RPC is sent with the WRITE credential', async () => {
    stubFetch();
    const res = await run(writeReq(), {});
    assert.strictEqual(res.status, 200, `action status ${res.status}`);
    const c = callFor('ops_rotate_invite');
    assert.ok(c, 'ops_rotate_invite was never called');
    assert.strictEqual(c.auth, `Bearer ${WRITE_KEY}`,
      `a write must use the write role — the read role deliberately has no EXECUTE on it. sent ${c.auth}`);
  });

  // The property the whole ticket exists for. Stated as an absolute over every
  // outbound request rather than per-call, so a future call site added without
  // a mode argument cannot quietly reintroduce it.
  await check('the service_role key is never sent once the scoped keys are set', async () => {
    stubFetch();
    await run(getReq(), {});
    await run(writeReq(), {});
    const leaked = sent.filter(s => s.auth.includes(SERVICE_KEY) || s.apikey.includes(SERVICE_KEY));
    assert.deepStrictEqual(leaked.map(s => s.url), [],
      'SUPABASE_SERVICE_KEY still went out on these requests; with the scoped roles '
      + 'configured nothing should authenticate as service_role');
  });

  // A missing scoped key must NOT silently restore database-wide privilege.
  // This is the fourth appearance of "absent input read as permission" in this
  // codebase, and the one place it would be easiest to excuse as convenience.
  await check('a missing read key does not fall back to the service key', async () => {
    stubFetch();
    const res = await run(getReq(), { OPS_READ_KEY: undefined });
    assert.strictEqual(res.status, 200,
      'the overview should still answer — degraded, not broken');
    const leaked = sent.filter(s => s.auth.includes(SERVICE_KEY));
    assert.deepStrictEqual(leaked.map(s => s.url), [],
      'with OPS_READ_KEY unset the Worker fell back to SUPABASE_SERVICE_KEY, so an unset '
      + 'variable silently restores rolbypassrls — exactly the shape this session has '
      + 'closed three times already');
    const body = await res.json();
    assert.ok(Array.isArray(body.degraded) && body.degraded.length >= 3,
      `every read should be reported as degraded, got ${JSON.stringify(body.degraded)}`);
  });

  await check('a missing write key is a 503 naming the variable, not a 500', async () => {
    stubFetch();
    const res = await run(writeReq(), { OPS_WRITE_KEY: undefined });
    assert.strictEqual(res.status, 503,
      'a missing credential is a configuration error; a 500 reads as "the RPC failed" and '
      + 'sends whoever is on the deploy to look at Postgres instead of at wrangler');
    const body = await res.json();
    assert.match(String(body.error), /OPS_WRITE_KEY/,
      `the error must name the variable that is missing, got: ${body.error}`);
    assert.deepStrictEqual(rpcCalls().map(s => s.url), [],
      'nothing should have been sent to the database at all');
  });

  // FAILURE MODE (b) from migration 044, and the one that would have made a
  // botched rollout invisible: these two reads used to swallow any error as
  // `.catch(() => [])`, so a missing grant rendered an EMPTY LIST — identical
  // on screen to "nothing has happened recently".
  await check('a read that fails on permissions is reported, not shown as an empty list', async () => {
    stubFetch({ failRpc: 'ops_audit_recent' });
    const res = await run(getReq(), {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.audit) && body.audit.length === 0,
      'the fallback shape must be preserved so the panel UI cannot break on this');
    const entry = (body.degraded || []).find(d => d.source === 'ops_audit_recent');
    assert.ok(entry,
      'a permission error on ops_audit_recent rendered an empty audit list with nothing '
      + `to distinguish it from a quiet week. degraded was ${JSON.stringify(body.degraded)}`);
    assert.match(String(entry.error), /permission denied/,
      `the reported reason should carry the database's own message, got: ${entry.error}`);
  });

  // COUNTER-CHECK (green today, must KEEP passing). `degraded` is only useful
  // if it is empty in the healthy case — a field that always lists something
  // gets ignored within a week, and then the failure above is invisible again.
  await check('degraded is empty when every read answers', async () => {
    stubFetch();
    const res = await run(getReq(), {});
    const body = await res.json();
    assert.deepStrictEqual(body.degraded, [],
      `a healthy overview must report nothing degraded, got ${JSON.stringify(body.degraded)}`);
    for (const field of ['counters', 'business', 'audit', 'invites', 'viewer']) {
      assert.ok(field in body, `the existing field "${field}" must survive this change`);
    }
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
