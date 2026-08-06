'use strict';
// Sign-out has to reach the backend, and has to say so honestly when it could
// not.
//
// WHY. credentials.json holds a refresh token: a bearer credential that mints
// fresh access tokens on demand, for as long as the session lives. Deleting
// the file is amnesia, not revocation — any copy taken before the delete (a
// Time Machine backup, a synced folder, a second process running as this user)
// goes on working, and 0600 does nothing about it because that copy is owned
// by the same user. Every check below is written against a COPY of the file
// taken before sign-out, because that copy is the whole threat: assertions
// about the machine that signed out would pass even with no backend call at
// all.
//
// AND THE OTHER HALF. A user offline, or behind a backend outage, must still be
// able to sign out of their own laptop — so the local delete is unconditional.
// Which makes the reporting the security-critical part: a failed revocation
// rendered as a clean "signed out" is this repo's signature defect (a flag
// recording an outcome the code never achieved), except here the flag is a
// security claim. `revoked` is true only when the backend confirmed it.
//
// Run directly, or via `node test/run.js sign-out-revokes`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const server = require('../../lib/server');

// Whether a stolen copy of credentials.json can still buy an access token.
// This is the question the whole ticket is about, so it is asked directly of
// the backend rather than inferred from anything on this disk.
async function copyStillWorks(url, copy) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: 'anon-test' },
    body: JSON.stringify({ refresh_token: copy.refreshToken }),
  });
  return res.ok;
}

async function main() {
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.team = { ...(cfg.team || {}), encrypt: false };
  util.saveUserConfig(cfg);

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(78), '127.0.0.1', r));
  const URL_ = `http://127.0.0.1:${P(78)}`;
  process.env.MEMBRIDGE_TEAM_URL = URL_;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  let n = 0;
  const signIn = async () => {
    n += 1;
    await teamsync.signup(util.getConfig(), `out${n}@test.dev`, 'pw-out', 'Me');
    // The copy an attacker (or a backup, or a synced folder) holds.
    return { ...teamsync.loadCredentials() };
  };

  try {
    // --- 1. the session is ended on the backend, not just forgotten here ---
    {
      const copy = await signIn();
      const beforeSignOut = await copyStillWorks(URL_, copy);
      const out = await teamsync.signOut(util.getConfig());
      const afterSignOut = await copyStillWorks(URL_, copy);

      check('sign-out: a copy of credentials.json stops working', () => {
        assert.strictEqual(beforeSignOut, true, 'precondition: the copy could mint tokens before sign-out');
        assert.strictEqual(afterSignOut, false,
          'the refresh token in a copy of credentials.json still mints access tokens after sign-out — ' +
          'sign-out deleted the local file and never ended the session');
      });

      check('sign-out: reports the revocation it actually got', () => {
        assert.strictEqual(out.revoked, true, 'the backend confirmed nothing');
        assert.strictEqual(out.cleared, true, 'the local credentials file survived');
        assert.strictEqual(out.error, null, `unexpected error: ${out.error}`);
        assert.strictEqual(teamsync.loadCredentials(), null, 'this machine still holds credentials');
      });
    }

    // --- 2. an EXPIRED access token is refreshed before the logout ---
    // The trap: an expired access token cannot authenticate its own logout —
    // GoTrue answers 401 and the refresh token outlives the sign-out. The
    // refresh rotates the pair inside the same session, so revoking afterwards
    // still kills the older token the copy holds.
    {
      const copy = await signIn();
      const stale = teamsync.loadCredentials();
      // Expired on BOTH sides, which is what makes this check bite: the local
      // clock says refresh, and the backend genuinely rejects the stale token
      // (mock.expireToken). Ageing only the local field would let a build that
      // skips the refresh sail through on a token the mock still honoured.
      mock.expireToken(stale.accessToken);
      stale.expiresAt = Date.now() - 60_000;
      fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify(stale, null, 2), { mode: 0o600 });

      const out = await teamsync.signOut(util.getConfig());
      const afterSignOut = await copyStillWorks(URL_, copy);

      check('sign-out: an expired token is refreshed first, and the OLD copy dies with the session', () => {
        assert.strictEqual(out.revoked, true,
          `revocation failed on an expired token (${out.error}) — an expired access token cannot ` +
          'authenticate its own logout, so the refresh has to happen first');
        assert.strictEqual(afterSignOut, false,
          'the pre-refresh copy still works — the logout revoked the rotated token only, not the session');
      });
    }

    // --- 3. a backend that refuses: sign out locally, and SAY it failed ---
    {
      const copy = await signIn();
      mock.flags.failLogout = true;
      let out;
      let threw = null;
      try {
        out = await teamsync.signOut(util.getConfig());
      } catch (err) {
        threw = err;
      } finally {
        mock.flags.failLogout = false;
      }

      check('sign-out: a failed revocation still signs this machine out', () => {
        assert.strictEqual(threw, null, `sign-out threw instead of completing locally: ${threw && threw.message}`);
        assert.strictEqual(out.cleared, true, 'the local sign-out was gated on the network call');
        assert.strictEqual(teamsync.loadCredentials(), null, 'credentials survived a failed revocation');
      });

      check('sign-out: a failed revocation is NEVER reported as revoked', () => {
        assert.strictEqual(out.revoked, false,
          'the backend refused the logout and sign-out reported success anyway');
        assert.ok(out.error && /logout|unavailable|500/i.test(out.error),
          `the reason was not carried back to the caller (got ${JSON.stringify(out.error)})`);
      });

      // The counterpart to the check above: `revoked: false` has to MEAN
      // something. If the session had died anyway, the honest report would be
      // needless alarm rather than accuracy — and the check above would pass
      // for a build that simply never revokes anything.
      const stillLive = await copyStillWorks(URL_, copy);
      check('sign-out: and the session really is still live — the report is not pessimism', () => {
        assert.strictEqual(stillLive, true,
          'the refused logout ended the session anyway, so revoked:false was not the true answer');
      });
    }

    // --- 4. an unreachable backend behaves the same way ---
    // Offline is the case a user is most likely to hit, and the one where
    // refusing to sign out locally would be worst.
    {
      await signIn();
      process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(79)}`; // nothing listening
      let out;
      let threw = null;
      try {
        out = await teamsync.signOut(util.getConfig());
      } catch (err) {
        threw = err;
      } finally {
        process.env.MEMBRIDGE_TEAM_URL = URL_;
      }

      check('sign-out: works offline, and admits the session was not ended', () => {
        assert.strictEqual(threw, null, `sign-out threw when the backend was unreachable: ${threw && threw.message}`);
        assert.strictEqual(out.cleared, true, 'an offline user could not sign out of their own machine');
        assert.strictEqual(out.revoked, false, 'an unreachable backend was reported as a confirmed revocation');
        assert.ok(out.error, 'no reason given for the failed revocation');
      });
    }

    // --- 4b. THE ROUTE, not just the function ---
    //
    // Everything above drives teamsync.signOut directly, and a measured drop
    // test showed what that misses: deleting `revoked`, `revokeError` or
    // `authenticated` from POST /api/team/logout leaves this suite fully green,
    // because nothing here crosses the wire. Nothing else covered that route
    // either — no split suite and no section of the monolith mentions it.
    //
    // The three fields are one signal between them. `revoked` false with no
    // `revokeError` is a warning with nothing to say; `revokeError` present
    // with no `revoked` is a reason for a failure nobody declared; and the UI's
    // fail-closed default reads a missing `revoked` as "not revoked", which is
    // safe but would leave the warning path permanently dark if `revokeError`
    // went with it. So all three are asserted PRESENT — `in`, not truthiness,
    // because a dropped key and a legitimate false/null are the same value.
    {
      const PORT = P(83);
      const srv = server.startServer(PORT, { retries: 0 });
      await h.waitForHttp(`http://127.0.0.1:${PORT}/api/status`);
      try {
        await signIn();
        const ok = await httpPost(PORT, '/api/team/logout', {});

        await signIn();
        mock.flags.failLogout = true;
        let failed;
        try {
          failed = await httpPost(PORT, '/api/team/logout', {});
        } finally {
          mock.flags.failLogout = false;
        }

        check('route: a successful sign-out reports all three fields', () => {
          assert.ok('authenticated' in ok, 'authenticated missing from the logout response');
          assert.ok('revoked' in ok, 'revoked missing — the UI cannot tell a real revocation from a local wipe');
          assert.ok('revokeError' in ok, 'revokeError missing — the warning path has nothing to render');
          assert.strictEqual(ok.authenticated, false);
          assert.strictEqual(ok.revoked, true, `the backend confirmed nothing: ${JSON.stringify(ok)}`);
          assert.strictEqual(ok.revokeError, null);
        });

        check('route: a refused revocation reports revoked:false WITH a reason', () => {
          assert.ok('revoked' in failed && 'revokeError' in failed,
            `the failure case lost a field: ${JSON.stringify(failed)}`);
          assert.strictEqual(failed.authenticated, false,
            'the machine must still be signed out locally even when revocation fails');
          assert.strictEqual(failed.revoked, false, 'a refused logout was reported as revoked');
          assert.ok(failed.revokeError && String(failed.revokeError).length > 0,
            'revoked:false arrived with no reason, so the UI can only say something vague went wrong');
        });
      } finally {
        await new Promise(r => srv.close(r));
      }
    }

    // --- 5. signing out when already signed out is not a failure ---
    {
      const out = await teamsync.signOut(util.getConfig());
      check('sign-out: nothing to sign out of is reported as such, not as a failed revocation', () => {
        assert.strictEqual(out.wasSignedIn, false, 'claimed there was a session to end');
        assert.strictEqual(out.revoked, false);
        assert.strictEqual(out.error, null, 'invented an error for a no-op sign-out');
      });
    }
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
