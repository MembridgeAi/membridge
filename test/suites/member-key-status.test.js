'use strict';
// Which member's key changed — carried per member, with "we don't know" as a
// state of its own.
//
// WHY. A teammate's box pubkey comes from the server, so a compromised backend
// could substitute its own and read the sealed team key. lib/teampins.js pins
// the first key ever seen and raises an alert on any later disagreement. That
// alert is the single most important thing this app can tell a user about
// their team, and it could not reach them per-member at all: the UI's chip was
// gated on a field the daemon never sent, and the only thing that did ship was
// a COUNT — which can say "somebody's key changed" but never whose, which is
// the one thing you need in order to go and check.
//
// THE SHAPE IS THE TICKET. Three states, always present:
//   'alert'   — this member's key disagrees with the pin
//   'ok'      — we hold a pin and the gate agreed with it
//   'unknown' — we cannot say
// A boolean cannot carry that: `false` for "never checked" renders identically
// to "verified", and the user reads the absence of a warning as an assurance
// nobody made. That is the bug being fixed, in a new costume, so the checks
// below assert 'unknown' explicitly at every point where a two-valued field
// would have quietly said "safe".
//
// Run directly, or via `node test/run.js member-key-status`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const teampins = require('../../lib/teampins');
const server = require('../../lib/server');

const PINNED_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const UNPINNED_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

async function main() {
  util.ensureConfig();

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(81), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(81)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  const setEncrypt = on => {
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: on };
    util.saveUserConfig(cfg);
  };
  // encrypt:false while signing up keeps the mock round trip off the real
  // macOS keychain; the checks below set it per case.
  setEncrypt(false);

  try {
    const projPath = path.join(ROOT, 'projects', 'keys-app');
    fs.mkdirSync(projPath, { recursive: true });
    await teamsync.signup(util.getConfig(), 'keys@test.dev', 'pw-keys', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'KeyTeam');
    const teamId = team.team_id;

    // Two teammates: one whose key we have pinned, one we never have.
    for (const [id, name] of [[PINNED_ID, 'Pinned Pat'], [UNPINNED_ID, 'Unpinned Uma']]) {
      mock.members.push({ teamId, userId: id, displayName: name, role: 'member', joinedAt: '2026-07-20T09:00:00Z' });
    }
    teampins.save({
      [PINNED_ID]: { publicKey: 'pk-pat-v1', name: 'Pinned Pat', firstSeen: '2026-07-20T09:00:00Z' },
    });

    const statusById = async () => {
      const rows = await server.teamMembersPayload(teamId);
      const out = {};
      for (const r of rows) out[String(r.user_id)] = r.keyStatus;
      return out;
    };
    const setAlerts = alerts => {
      const st = util.loadState();
      if (alerts) st.keyAlerts = alerts; else delete st.keyAlerts;
      util.saveState(st);
    };
    const setPaused = reason => {
      const st = util.loadState();
      if (reason) st.teamCryptoPaused = reason; else delete st.teamCryptoPaused;
      util.saveState(st);
    };

    // --- 1. the field is ALWAYS present, and never absent-means-safe ---
    {
      setEncrypt(true);
      setPaused(null);
      setAlerts(null);
      const got = await statusById();
      check('members: every row carries a key status, on a quiet team as much as a loud one', () => {
        for (const id of [PINNED_ID, UNPINNED_ID]) {
          assert.ok(got[id] !== undefined,
            `${id} has no keyStatus field — an absent field reads as "no problem", which is the bug`);
        }
      });
      check('members: a pinned member with no alert is ok; an UNPINNED one is unknown, not ok', () => {
        assert.strictEqual(got[PINNED_ID], 'ok', 'a pinned, unalerted member should read ok');
        assert.strictEqual(got[UNPINNED_ID], 'unknown',
          'a member we have never pinned read as ok — that claims a check that never ran');
      });
    }

    // --- 2. an alert names the member it is about ---
    {
      setEncrypt(true);
      setPaused(null);
      setAlerts([{ user_id: PINNED_ID, name: 'Pinned Pat', pinned: 'pk-pat-v1', fetched: 'pk-pat-v2' }]);
      const got = await statusById();
      check('members: the alerted member is the one flagged, and only that one', () => {
        assert.strictEqual(got[PINNED_ID], 'alert', 'the alert did not reach the member row');
        assert.notStrictEqual(got[UNPINNED_ID], 'alert', 'an unrelated member was flagged too');
      });
    }

    // --- 3. a paused gate is UNKNOWN, not ok ---
    // Pins on disk may be stale and nothing is re-checking them. A green
    // answer here would be a claim about a check that is not running.
    {
      setEncrypt(true);
      setAlerts(null);
      setPaused('no-key');
      const got = await statusById();
      check('members: a paused crypto gate makes a pinned member unknown, never ok', () => {
        assert.strictEqual(got[PINNED_ID], 'unknown',
          'a pinned member read ok while the gate that verifies pins is paused');
      });
      setPaused(null);
    }

    // --- 4. encryption off is UNKNOWN, not ok ---
    {
      setEncrypt(false);
      setAlerts(null);
      const got = await statusById();
      check('members: with encryption off nobody is ok — there is no gate to be ok by', () => {
        assert.strictEqual(got[PINNED_ID], 'unknown', 'a stale pin read as ok with encryption disabled');
        assert.strictEqual(got[UNPINNED_ID], 'unknown');
      });
    }

    // --- 5. an alert outranks a disabled gate ---
    // A key change that was found stays found: switching encryption off must
    // not silence a finding about a key that really did change.
    {
      setEncrypt(false);
      setAlerts([{ user_id: PINNED_ID, name: 'Pinned Pat', pinned: 'pk-pat-v1', fetched: 'pk-pat-v2' }]);
      const got = await statusById();
      check('members: turning encryption off does not silence an alert already found', () => {
        assert.strictEqual(got[PINNED_ID], 'alert',
          'a recorded key change disappeared because a config flag was flipped');
      });
      setEncrypt(true);
    }

    // --- 6. a departed member is not warned about ---
    // Removal is the case the ticket names: a stale pin for someone no longer
    // on the team must not surface as a security warning about an account that
    // is simply gone. Two halves — no row to flag, and the machine-local count
    // stops counting them.
    {
      setEncrypt(true);
      setPaused(null);
      setAlerts([
        { user_id: PINNED_ID, name: 'Pinned Pat', pinned: 'pk-pat-v1', fetched: 'pk-pat-v2' },
        { user_id: UNPINNED_ID, name: 'Unpinned Uma', pinned: 'pk-uma-v1', fetched: 'pk-uma-v2' },
      ]);
      await teamsync.removeMember(util.getConfig(), teamId, PINNED_ID);
      const got = await statusById();
      const after = util.loadState().keyAlerts || [];

      check('members: a removed member has no row at all, so nothing can flag them', () => {
        assert.strictEqual(got[PINNED_ID], undefined, 'a removed member still appeared in the roster');
        assert.strictEqual(got[UNPINNED_ID], 'alert', 'removing one member cleared an unrelated alert');
      });

      check('removal: the alert about the departed member is dropped from the count too', () => {
        assert.ok(!after.some(a => a.user_id === PINNED_ID),
          'the count still warns about a key belonging to an account that is gone');
        assert.ok(after.some(a => a.user_id === UNPINNED_ID),
          'the prune took an alert about someone still on the team');
      });
    }

    // --- 7. counter-check: a FAILED removal prunes nothing ---
    // The prune runs after the RPC on purpose. A removal the backend refused
    // must not clear an alert about a member who is still on the team.
    {
      setAlerts([{ user_id: UNPINNED_ID, name: 'Unpinned Uma', pinned: 'pk-uma-v1', fetched: 'pk-uma-v2' }]);
      let threw = null;
      try {
        // A team this caller does not manage: remove_member answers 403, and
        // the member named here is still very much on the real team.
        await teamsync.removeMember(util.getConfig(), 'dddddddd-0000-1111-2222-333333333333', UNPINNED_ID);
      } catch (err) { threw = err; }
      const after = util.loadState().keyAlerts || [];
      const got = await statusById();
      check('removal: a rejected removal leaves every alert exactly where it was', () => {
        assert.ok(threw, 'the fixture expected the backend to refuse this removal');
        assert.strictEqual(after.length, 1, 'the alert list changed on a removal that never happened');
        assert.strictEqual(got[UNPINNED_ID], 'alert', 'the member stopped being flagged');
      });
    }

    // --- 8. counter-check: an empty roster is not a crash or an invention ---
    {
      const empty = server._annotateKeyStatus([]);
      const notArray = server._annotateKeyStatus(null);
      check('members: an empty or missing roster annotates to nothing, not to a fabricated row', () => {
        assert.deepStrictEqual(empty, []);
        assert.deepStrictEqual(notArray, []);
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
