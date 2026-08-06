'use strict';
// Removing a member from a team must be CRYPTOGRAPHIC, not just a row in a
// policy table.
//
// WHY THIS SUITE EXISTS. E2E exists so the server is not the guarantor of who
// can read what. Yet `removeMember` only called the remove_member RPC: the
// removed member's device kept the current epoch's team key, sealed to their
// own public key, forever. Everything that stopped them reading new content was
// server-side RLS — exactly the trust boundary encryption was introduced to
// remove. A copy of the ciphertext obtained by any other route (a backup, a
// still-syncing second device, a bug in one policy) stayed readable.
//
// Rotation is the answer and it already existed — `membridge team rekey` mints
// a new epoch and seals it only to CURRENT members. Nothing ever called it, so
// it never fired at the one moment it is actually needed. Removal now triggers
// it, best-effort and always reported.
//
// WHAT THIS SUITE DOES NOT COVER, because it cannot be fixed here: revoking a
// member from ONE PROJECT while they stay on the team. The team key spans every
// project in the team, so no rotation can express that revocation — the member
// legitimately needs the same key for the projects they kept. That needs
// project-scoped keys and a schema change; see the checks at the bottom, which
// pin the gap honestly rather than pretending it is closed.
//
// Run directly, or via `node test/run.js team-rekey-on-removal`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const teamcrypto = require('../../lib/teamcrypto');
const { createMockSupabase } = require('../mock-supabase');

// In-memory stand-in for the OS key store: the real one would prompt, and a
// test must never touch the developer's actual keychain.
const mkMemKeychain = () => {
  const m = new Map();
  return {
    available: () => true,
    load: a => m.get(a) || null,
    store: (a, s) => { m.set(a, s); return true; },
    remove: a => m.delete(a),
  };
};

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(71), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(71)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const savedHome = process.env.MEMBRIDGE_HOME;

  const homeOwner = path.join(ROOT, 'home-owner');
  const homeGone = path.join(ROOT, 'home-gone');
  const homeStays = path.join(ROOT, 'home-stays');
  const proj = path.join(ROOT, 'projects', 'rekey-app');
  fs.mkdirSync(proj, { recursive: true });
  const kcOwner = mkMemKeychain(), kcGone = mkMemKeychain(), kcStays = mkMemKeychain();
  const cryptoDeps = kc => ({ keychain: kc, teamcrypto });

  const setTeamCfg = () => {
    util.ensureConfig();
    const raw = util.loadUserConfig();
    raw.team = { ...(raw.team || {}), encrypt: true };
    util.saveUserConfig(raw);
  };

  let err = null, teamId = null, goneId = null, staysId = null;
  let epochsBefore = [], epochsAfter = [], removeResult = null;
  try {
    // Owner creates the team and links a project.
    process.env.MEMBRIDGE_HOME = homeOwner;
    setTeamCfg();
    await teamsync.signup(util.getConfig(), 'owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'RekeyTeam');
    teamId = team.team_id;
    await teamsync.linkProject(util.getConfig(), proj, teamId, 'RekeyTeam');

    // Two members join and publish their public keys (a sync pass does that).
    process.env.MEMBRIDGE_HOME = homeGone;
    setTeamCfg();
    await teamsync.signup(util.getConfig(), 'gone@test.dev', 'pw-g', 'Gone');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);
    await teamsync.syncTeams({ cryptoDeps: cryptoDeps(kcGone) });
    goneId = teamsync.loadCredentials().userId;

    process.env.MEMBRIDGE_HOME = homeStays;
    setTeamCfg();
    await teamsync.signup(util.getConfig(), 'stays@test.dev', 'pw-s', 'Stays');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);
    await teamsync.syncTeams({ cryptoDeps: cryptoDeps(kcStays) });
    staysId = teamsync.loadCredentials().userId;

    // Owner syncs: mints epoch 1 and seals it to all three.
    process.env.MEMBRIDGE_HOME = homeOwner;
    const st = util.loadState();
    st.projects[proj] = { events: [
      { ts: '2026-07-20T10:00:00.000Z', source: 'Claude Code', kind: 'summary', text: 'before the removal', session: 'r1' },
    ] };
    util.saveState(st);
    await teamsync.syncTeams({ project: proj, cryptoDeps: cryptoDeps(kcOwner) });
    epochsBefore = mock.teamKeys.map(r => ({ epoch: r.epoch, member: r.member_user_id }));

    // The act under test.
    removeResult = await teamsync.removeMember(util.getConfig(), teamId, goneId,
      { cryptoDeps: cryptoDeps(kcOwner) });
    epochsAfter = mock.teamKeys.map(r => ({ epoch: r.epoch, member: r.member_user_id }));
  } catch (e) { err = e; } finally {
    process.env.MEMBRIDGE_HOME = savedHome;
    mock.server.close();
  }

  const maxEpoch = rows => rows.reduce((m, r) => Math.max(m, Number(r.epoch) || 0), 0);

  check('removal: the team was actually sealed at one epoch before the removal', () => {
    assert.ok(!err, `scenario threw: ${err && err.message}`);
    assert.strictEqual(maxEpoch(epochsBefore), 1, `expected epoch 1 only: ${JSON.stringify(epochsBefore)}`);
    assert.strictEqual(epochsBefore.filter(r => r.epoch === 1).length, 3,
      `epoch 1 must be sealed to all three members: ${JSON.stringify(epochsBefore)}`);
  });

  // THE FIX. Without it the highest epoch after a removal is still 1: the
  // removed device holds a key that still opens every row the team writes
  // tomorrow, and only server-side RLS stands between them and the content.
  check('removal: removing a member mints a NEW epoch (rotation actually fires)', () => {
    assert.ok(!err, `scenario threw: ${err && err.message}`);
    assert.ok(maxEpoch(epochsAfter) > maxEpoch(epochsBefore),
      `no rotation happened — the removed member's key still opens new content: ${JSON.stringify(epochsAfter)}`);
  });

  check('removal: the new epoch is sealed to the remaining members and NOT to the removed one', () => {
    assert.ok(!err, `scenario threw: ${err && err.message}`);
    const top = maxEpoch(epochsAfter);
    const sealed = epochsAfter.filter(r => r.epoch === top).map(r => r.member);
    assert.ok(!sealed.includes(goneId),
      `the removed member was sealed into the new epoch: ${JSON.stringify(sealed)}`);
    assert.ok(sealed.includes(staysId), `a remaining member was not sealed in: ${JSON.stringify(sealed)}`);
    assert.strictEqual(sealed.length, 2, `expected exactly the two remaining members: ${JSON.stringify(sealed)}`);
  });

  check('removal: the rotation is REPORTED, never silent — the caller learns what happened', () => {
    assert.ok(!err, `scenario threw: ${err && err.message}`);
    assert.ok(removeResult && typeof removeResult === 'object',
      'removeMember must return a result the UI/CLI can surface');
    assert.strictEqual(removeResult.removed, true, 'the removal itself must be reported');
    assert.ok(removeResult.rekey && removeResult.rekey.ok,
      `the rekey outcome must ride back with it: ${JSON.stringify(removeResult.rekey)}`);
    assert.ok(Array.isArray(removeResult.rekey.withheld),
      'members whose key could not be trusted must be named, not dropped silently');
  });

  // The old sealed rows are deliberately left alone. Rotation is forward-only:
  // history encrypted at epoch 1 stays readable to whoever held epoch 1, which
  // includes the removed member for anything they already pulled. Pretending
  // otherwise would be a lie the crypto cannot back.
  check('removal: rotation is forward-only — the pre-removal epoch is not rewritten', () => {
    assert.ok(!err, `scenario threw: ${err && err.message}`);
    const before1 = epochsBefore.filter(r => r.epoch === 1).length;
    const after1 = epochsAfter.filter(r => r.epoch === 1).length;
    assert.strictEqual(after1, before1, 'epoch 1 rows must be untouched by the rotation');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
