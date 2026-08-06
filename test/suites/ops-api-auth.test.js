'use strict';
// The ops Worker's own authentication layer — the second of the three it
// documents, and the only one written in this repo.
//
// WHY THIS SURFACE MATTERS MORE THAN ITS SIZE SUGGESTS. cloudflare/ops-api is
// the sole holder of SUPABASE_SERVICE_KEY. `service_role` bypasses row-level
// security entirely, so none of the access scoping, membership predicates or
// definer-function gates that protect the rest of this product are in the path
// for anything that gets past this Worker. Its `authenticate()` is, in effect,
// the last gate in front of an unrestricted database credential.
//
// The implementation is careful — RS256 pinned so `alg: none` cannot be
// substituted, signature verified against the live Access JWKS, exp/nbf
// checked, and `aud` pinned so a valid token for a DIFFERENT app on the same
// Access team does not open this one. All of that is exercised below as
// regression guards, because each is one edit away from being lost.
//
// The one defect is the allowlist, pinned as a failing check.
//
// WHAT THIS SUITE CANNOT COVER. It runs the Worker module in Node with a
// stubbed fetch. It does not and cannot verify anything about the DEPLOYED
// Worker: whether workers_dev is really false, whether the secret is really a
// secret rather than a plaintext var, or what the Access policy admits. Those
// need the Cloudflare API. The edge behaviour was checked separately by an
// unauthenticated request to the live hostname (302 to the Access login, with
// an aud matching wrangler.toml) — see the audit notes in that file.
// STATUS (2026-08-05): THE ALLOWLIST FINDING IS FIXED ELSEWHERE — not here.
// The fix is on `agent-sec`, commit e538edf ("fix(security): scope the function
// re-run class, enforce reconstruction evidence, fail the ops allowlist closed
// (SEC-8..10)"), in cloudflare/ops-api/src/index.js.
//
// The two failing checks below are LEFT EXACTLY AS THEY ARE. They were run
// against that branch's Worker (substituted in, run, reverted) and both PASS:
// 12/12. They stay red on this branch because this branch does not carry the
// fix, and they will go green when the branches merge — that transition is the
// proof, which editing them to pass would destroy. Do not "fix" them here.
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

// A throwaway RSA keypair standing in for Cloudflare Access's signing key. The
// Worker fetches the JWKS over the network, so the stub below serves this one.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64url = buf => Buffer.from(buf).toString('base64url');

// Signs an Access-shaped JWT. `alg` is a parameter so the downgrade guard can
// be exercised with a genuinely malformed header rather than a described one.
function makeJwt({ email, aud = AUD, exp, nbf, alg = 'RS256', sign = true }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid: KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    email, aud, exp: exp === undefined ? now + 600 : exp, nbf, iat: now,
  }));
  if (!sign) return `${header}.${payload}.${b64url('not-a-signature')}`;
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

// Serves the JWKS; everything else (Analytics Engine, Supabase RPCs) gets a
// bland ok so the handler can complete. No real network call is made, and no
// real credential exists in this process — `env` below is entirely synthetic.
function stubFetch() {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], ok: true }), { status: 200 });
  };
}

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_KEY: 'synthetic-not-a-real-key',
  CF_ACCOUNT_ID: 'synthetic',
  CF_API_TOKEN: 'synthetic',
};

const req = (token, url = 'https://ops.example.test/api') =>
  new Request(url, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });

async function main() {
  stubFetch();
  const worker = (await import(WORKER)).default;
  const call = (token, env, url) => worker.fetch(req(token, url), { ...baseEnv, ...env });

  // THE FINDING. `authenticate()` ends with:
  //     if (allowed.length && !allowed.includes(email)) return null;
  // The `allowed.length &&` guard means an ABSENT or EMPTY ALLOWED_EMAILS skips
  // the allowlist entirely and admits any email carrying a valid Access JWT for
  // this aud. The check does not fail closed; it stops existing.
  //
  // This is the same shape as the file's own stated reason for having layer 2 at
  // all — "Layer 1 alone holds right up until someone adds a route and forgets".
  // Layer 2 holds right up until someone clears a variable, and unsets it
  // silently: nothing logs, and the panel keeps working perfectly for the
  // operator, so the only way to notice is to read this line.
  //
  // Blast radius is bounded by Access still gating the edge, so the exposure is
  // "anyone the Access policy admits" rather than the open internet. That is a
  // real reduction and worth saying — but the Worker is the sole holder of an
  // RLS-bypassing database credential, and its own allowlist is the layer that
  // is supposed to survive an over-broad Access policy.
  await check('an unlisted email is refused when ALLOWED_EMAILS is unset', async () => {
    const res = await call(makeJwt({ email: 'stranger@example.com' }), { ALLOWED_EMAILS: undefined });
    assert.strictEqual(res.status, 401,
      'with ALLOWED_EMAILS absent the allowlist is skipped entirely rather than ' +
      'failing closed, so any holder of a valid Access JWT for this aud is admitted ' +
      'to a Worker holding the service_role key. Drop the `allowed.length &&` guard ' +
      'and refuse when the list is empty.');
  });

  await check('an unlisted email is refused when ALLOWED_EMAILS is empty', async () => {
    const res = await call(makeJwt({ email: 'stranger@example.com' }), { ALLOWED_EMAILS: '   ' });
    assert.strictEqual(res.status, 401,
      'a whitespace-only ALLOWED_EMAILS parses to an empty list and disables the check');
  });

  // Regression guards. Each of these currently PASSES and encodes a property
  // that would be expensive to lose quietly.
  await check('the allowlist is enforced when it IS configured', async () => {
    const res = await call(makeJwt({ email: 'stranger@example.com' }),
      { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401, 'a configured allowlist must refuse an unlisted email');
  });

  await check('a listed email is admitted', async () => {
    const res = await call(makeJwt({ email: 'Operator@Example.com' }),
      { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 200,
      'the comparison is case-insensitive on both sides; a listed operator must get in');
  });

  await check('a request with no Access assertion is refused', async () => {
    const res = await call(null, { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401);
  });

  await check('a token with a valid payload but a bad signature is refused', async () => {
    const res = await call(makeJwt({ email: 'operator@example.com', sign: false }),
      { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401, 'the signature must actually be verified');
  });

  // The classic JWT downgrade. Pinned because `alg: none` acceptance is the
  // single most common way a hand-rolled verifier fails, and this one gets it
  // right by refusing anything that is not RS256 before touching the key.
  await check('an alg:none token is refused', async () => {
    const parts = makeJwt({ email: 'operator@example.com', alg: 'none' }).split('.');
    const res = await call(`${parts[0]}.${parts[1]}.`, { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401, 'alg must be pinned to RS256');
  });

  await check('an expired token is refused', async () => {
    const res = await call(
      makeJwt({ email: 'operator@example.com', exp: Math.floor(Date.now() / 1000) - 60 }),
      { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401);
  });

  // aud pinning is what stops a valid token minted for ANOTHER application on
  // the same Cloudflare Access team from opening this one.
  await check('a token for a different Access application is refused', async () => {
    const res = await call(makeJwt({ email: 'operator@example.com', aud: 'some-other-app' }),
      { ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 401, 'aud must be pinned to this application');
  });

  // Writes carry the CSRF requirement because Access authenticates with a
  // cookie, which a cross-site form POST would carry too.
  await check('a write without a same-origin JSON context is refused', async () => {
    const token = makeJwt({ email: 'operator@example.com' });
    const res = await worker.fetch(new Request('https://ops.example.test/api/action', {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': token,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: 'action=rotate_invite',
    }), { ...baseEnv, ALLOWED_EMAILS: 'operator@example.com' });
    assert.strictEqual(res.status, 403, 'cross-origin form writes must be refused');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
