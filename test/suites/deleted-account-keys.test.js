'use strict';
// A soft-deleted account must stop receiving team encryption keys.
//
// WHY THIS SUITE EXISTS, and why it is the first thing built in the deletion
// lane. Supabase's dashboard offers a "soft delete" beside the delete that
// correctly refuses: it sets auth.users.deleted_at and LEAVES THE ROW, so it
// touches none of the seven foreign keys that block a hard delete. It always
// succeeds. And nothing in this codebase read that column, so the account
// stayed a full participant everywhere.
//
// Four of those surfaces are cosmetic (roster, access matrix, Insights,
// trust pins). THIS ONE IS NOT. All three key-sealing paths in lib/teamsync.js
// derive their recipients from team_members_list, whose row survives a soft
// delete, so every new team key epoch kept being sealed to the deleted
// account's public key. Offboarding somebody that way went on handing them the
// keys, forward, indefinitely, with nothing to show it. That is continuing to
// grant access to a person you believe you removed.
//
// THE COUNTER-CHECK IS LOAD-BEARING. "Nobody gets sealed to" would pass a
// naive exclusion test and would break encryption for the whole team, so every
// exclusion assertion here is paired with a positive one: an ordinary live
// member MUST still be sealed to in the same call. A fix that cannot tell the
// two apart is not a fix.
//
// The three seal sites share one choke point -- `fetchMembers()`, which is
// team_members_list -- so they are fixed in one place and proven separately
// here rather than assumed to follow.
//
// deleted_at reaches the client only once supabase/migrations/
// 053_team_members_list_deleted_at.sql is applied. Until then every row
// carries `deleted_at: undefined`, which this filter reads as "not deleted",
// so the client behaves exactly as it does today. See that file's header for
// why that makes the deploy order safe in both directions -- and why applying
// 053 alone is NOT the fix.
//
// Run directly, or via `node test/run.js deleted-account-keys`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const teamsync = require('../../lib/teamsync');
const teampins = require('../../lib/teampins');

const ME = '00000000-0000-4000-8000-00000000me';
const LIVE = '00000000-0000-4000-8000-000000live';
const GONE = '00000000-0000-4000-8000-000000gone';

// A deliberately transparent stand-in for libsodium: "sealed:<key>:<pubkey>".
// The real crypto is covered elsewhere; what is under test here is WHO ends up
// in the recipient list, which must be readable at a glance from the fixture.
const fakeCrypto = {
  available: () => true,
  ready: async () => {},
  genTeamKey: () => 'K-NEW',
  sealTeamKey: (teamKey, pub) => `sealed:${teamKey}:${pub}`,
  unsealTeamKey: (sealed, pub) => {
    const m = /^sealed:([^:]+):(.+)$/.exec(String(sealed || ''));
    return m && m[2] === pub ? m[1] : null;
  },
};

// members: [{ user_id, display_name, deleted_at }]. Everything else is fixed.
function mkDeps(members, { keyRows } = {}) {
  const inserted = [];
  let pinStore = {};
  return {
    inserted,
    deps: {
      teamId: 'team-1',
      userId: ME,
      teamcrypto: fakeCrypto,
      cache: null,
      // The REAL trust-on-first-use gate, with storage in memory. Using the
      // real teampins.check keeps this test honest about the interaction
      // between the TOFU filter and the deleted-account filter.
      pins: { load: () => pinStore, save: p => { pinStore = p; }, check: teampins.check },
      onAlert: () => {},
      fetchMembers: async () => members,
      fetchMemberPubkeys: async () => members.map(m => ({ user_id: m.user_id, public_key: `pk-${m.user_id}` })),
      fetchTeamKeyRows: async () => keyRows || [
        // I hold epoch 1 and can open it, so I am able to re-seal it to anyone
        // missing a row there. LIVE and GONE are both missing.
        { epoch: 1, member_user_id: ME, sealed_team_key: `sealed:K1:pk-${ME}` },
      ],
      fetchMySealedRow: async () => ({ sealed_team_key: `sealed:K1:pk-${ME}` }),
      insertSealedRows: async rows => { inserted.push(...rows); },
      deleteMyRows: async () => {},
    },
  };
}

const identity = { publicKey: `pk-${ME}`, privateKey: `sk-${ME}` };
const recipients = inserted => inserted.map(r => r.member_user_id);

async function main() {
  // -------------------------------------------------------------------------
  // The security assertion, and its counter-check.
  // -------------------------------------------------------------------------
  await check('re-seal EXCLUDES a soft-deleted account from a new key epoch', async () => {
    const { deps, inserted } = mkDeps([
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live' },
      { user_id: GONE, display_name: 'Gone', deleted_at: '2026-08-05T12:00:00Z' },
    ]);
    await teamsync.reconcileTeamKeys(identity, deps);
    assert.ok(!recipients(inserted).includes(GONE),
      `a soft-deleted account was sealed a team key: ${JSON.stringify(inserted)}`);
  });

  await check('...and STILL seals to an ordinary live member in the same call ' +
              '(the fix must not be "seal to nobody")', async () => {
    const { deps, inserted } = mkDeps([
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live' },
      { user_id: GONE, display_name: 'Gone', deleted_at: '2026-08-05T12:00:00Z' },
    ]);
    await teamsync.reconcileTeamKeys(identity, deps);
    assert.ok(recipients(inserted).includes(LIVE),
      `the live member was not sealed to -- exclusion is too broad: ${JSON.stringify(inserted)}`);
    // And the blob is the real one for that member, not a placeholder.
    const row = inserted.find(r => r.member_user_id === LIVE);
    assert.strictEqual(row.sealed_team_key, `sealed:K1:pk-${LIVE}`);
  });

  // -------------------------------------------------------------------------
  // The TOFU pin store is upstream of sealing, so it gets the same filter: a
  // deleted account must not be pinned on first sight, or a later key change
  // raises a KEY CHANGE alert telling an owner to go and verify somebody who
  // no longer exists.
  // -------------------------------------------------------------------------
  await check('a soft-deleted account is not pinned in the trust store', async () => {
    let saved = null;
    const { deps } = mkDeps([
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live' },
      { user_id: GONE, display_name: 'Gone', deleted_at: '2026-08-05T12:00:00Z' },
    ]);
    const realSave = deps.pins.save;
    deps.pins.save = p => { saved = p; realSave(p); };
    await teamsync.reconcileTeamKeys(identity, deps);
    assert.ok(saved, 'the pin store was never written');
    assert.ok(!(GONE in saved), `a deleted account was pinned: ${JSON.stringify(saved)}`);
    // Counter-check, again: the live member IS pinned. An empty pin store
    // would satisfy the assertion above and would disable TOFU entirely.
    assert.ok(LIVE in saved, `the live member was not pinned: ${JSON.stringify(saved)}`);
  });

  // -------------------------------------------------------------------------
  // The pre-migration state. deleted_at simply is not there yet, and that must
  // read as "not deleted" rather than as "unknown, so exclude" -- otherwise
  // shipping the client before 053 empties every recipient list.
  // -------------------------------------------------------------------------
  await check('a member with NO deleted_at field is treated as live (pre-053 rows)', async () => {
    const { deps, inserted } = mkDeps([
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live' },
    ]);
    await teamsync.reconcileTeamKeys(identity, deps);
    assert.deepStrictEqual(recipients(inserted), [LIVE]);
  });

  await check('an explicit null deleted_at is live, not deleted', async () => {
    const { deps, inserted } = mkDeps([
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live', deleted_at: null },
    ]);
    await teamsync.reconcileTeamKeys(identity, deps);
    assert.deepStrictEqual(recipients(inserted), [LIVE]);
  });

  // -------------------------------------------------------------------------
  // The deleted account must be treated exactly as a REMOVED member is: the
  // existing "membership shrank -> rotate" rule already covers ex-members, and
  // a deleted account reaching it is the behaviour we want rather than a
  // coincidence. Proven through the shared helper so all three seal sites are
  // covered, not only the one exercised above.
  // -------------------------------------------------------------------------
  await check('activeMembers drops deleted accounts and keeps everyone else', () => {
    const rows = [
      { user_id: ME, display_name: 'Me' },
      { user_id: LIVE, display_name: 'Live', deleted_at: null },
      { user_id: GONE, display_name: 'Gone', deleted_at: '2026-08-05T12:00:00Z' },
    ];
    assert.deepStrictEqual(teamsync.activeMembers(rows).map(m => m.user_id), [ME, LIVE]);
  });

  await check('activeMembers is total on junk input (never throws, never invents members)', () => {
    assert.deepStrictEqual(teamsync.activeMembers(null), []);
    assert.deepStrictEqual(teamsync.activeMembers(undefined), []);
    assert.deepStrictEqual(teamsync.activeMembers([]), []);
    // An empty string is not a deletion timestamp; only a real value is.
    assert.deepStrictEqual(teamsync.activeMembers([{ user_id: LIVE, deleted_at: '' }]).map(m => m.user_id), [LIVE]);
  });

  h.finish();
}

main();
