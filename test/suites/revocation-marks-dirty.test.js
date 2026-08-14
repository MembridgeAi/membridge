'use strict';
// lib/teamsync.js's confirmed-revoked branch of syncTeams stopped one step
// short: it clears proj.teamAccessLost, teamEntries, the durable archive and
// the derived notes index, but never marked the project DIRTY -- and
// lib/scan.js's injection pass only ever visits dirty projects (its filter at
// ~line 775). So a project's CLAUDE.md / AGENTS.md kept rendering the revoked
// teammate's block forever, for exactly the project a revoked member stops
// opening -- the one case with no local activity left to re-mark it dirty on
// its own.
//
// THE FIX (lib/teamsync.js, inside the confirmed-revoked branch's
// `if (!proj.teamAccessLost)` transition guard, beside the existing
// timestamp and log line): `proj.dirty = true;`. Transition-gated, not set on
// every pass the branch runs: this loop revisits every linked project on
// every sync tick regardless of local activity, so marking dirty
// unconditionally inside the branch would re-render an abandoned,
// still-revoked project every tick forever. digest.inject() already no-ops
// an unchanged write (context-block-churn.test.js pins this), so that would
// not be a correctness bug -- just wasted work for the life of the
// revocation. One mark at the transition triggers exactly the one re-render
// needed to clear the stale block.
//
// THE MASKING TRAP. lib/block-signature.js's pendingRefresh fires a ONE-SHOT
// re-render of every project with a rendered block whenever the block
// "recipe" (version, targets, redaction patterns, ...) has moved since the
// last recorded signature. A fresh fixture has no recorded signature, so the
// FIRST scan.syncOnce call in any suite would itself mark every project
// dirty for a reason that has nothing to do with revocation -- which would
// make the "revoked project's block goes stale" assertion below pass even
// with the fix reverted, and could just as easily make the healthy-app
// control fail for a reason unrelated to the fix. Before any scan.syncOnce
// call, this suite pre-records the CURRENT signature into state (exactly
// what the real code does once it has acted on a recipe change), so
// pendingRefresh answers null on every call here and the only thing that can
// mark either project dirty is the code path under test.
//
// Run directly, or via `node test/run.js revocation-marks-dirty`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require

// Belt-and-braces on top of MEMBRIDGE_HOME, before any lib/ module is
// required. This suite's ticket surfaced that test/harness.js does NOT
// actually isolate HOME -- only MEMBRIDGE_HOME / MEMBRIDGE_CLAUDE_DIR /
// MEMBRIDGE_CODEX_DIR (confirmed by reading harness.js in full and grepping
// the whole test/ tree for `env.HOME`). What actually keeps this suite off
// the real ~/.claude, ~/.codex and the macOS keychain is util.getConfig()
// picking up the MEMBRIDGE_CLAUDE_DIR/MEMBRIDGE_CODEX_DIR adapter overrides,
// and cfg.team.encrypt = false (set below, before the only teamsync call
// this suite makes) skipping buildCryptoContext/ensureIdentity entirely, so
// the keychain is never touched regardless of HOME. This HOME override is
// defense in depth on top of that, not the thing doing the work -- flagged
// to the team lead as a real gap in harness.js itself (tracked separately,
// not this ticket's scope).
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-test-home-'));

const { check, ROOT, P } = h;
const assert = require('assert');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const scan = require('../../lib/scan');
const memorydb = require('../../lib/memorydb');
const blockSignature = require('../../lib/block-signature');
const { createMockSupabase } = require('../mock-supabase');

// Grepped every suite's `P(N)` call (`grep -rhoE "P\([0-9]+\)" test/suites/*.test.js`):
// every offset 52-92 is already claimed, plus 3, 4, 7, 31, 49. 93 is unused.
const MOCK_PORT = P(93);

function localEvents(token, session) {
  return [
    { ts: '2026-08-04T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session, text: `wire up the ${token} path` },
    {
      ts: '2026-08-04T10:05:00.000Z', source: 'Distilled', kind: 'summary', session,
      text: `The ${token} path is wired.`, headline: `${token} is wired`,
      goal: '', decisions: '', gotchas: '', highlights: [],
    },
  ];
}

// Real-clock-relative on purpose (same reason as teammate-notes-revocation
// .test.js's OWN_ROW, section 7): digest.teamInjectSlice drops anything
// older than teamMaxAgeHours (72h default) measured against Date.now(), with
// no injectable "now" override reachable through scan.syncOnce. A row pinned
// to a fixed past date would age out of the inject window the moment the
// wall clock crosses it, and this suite would start failing for a reason
// that has nothing to do with revocation.
function teamRow(marker) {
  return {
    author: 'Andrew',
    authorId: '11111111-2222-3333-4444-555555555555',
    ts: new Date(Date.now() - 3600000).toISOString(),
    source: 'Claude Code',
    session: `their-${marker}-session`,
    ask: `rework the ${marker} cursor`,
    summary: `${marker}revocationmarker is the fixture's own row.`,
    decisions: `${marker}revocationmarker is the marker for this row`,
    gotchas: '',
    files: ['lib/teamsync.js'],
    changes: [{ file: 'lib/teamsync.js', note: `do not widen the dirty filter for ${marker}` }],
  };
}

// A tracked, linked project carrying one local session AND one pulled
// teammate row seeded directly into state -- this suite never calls
// pullProject (a mock entries round trip would only prove pull works, which
// other suites already pin); it only needs a teammate row that PREDATES
// revocation, to prove revocation clears it. teamPullTs is stamped to "now"
// so the real pull inside syncTeams later finds nothing new to fetch and
// does not disturb this seeded row itself.
async function makeLinkedProject(name, teamId, teamName, marker) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: localEvents(marker, `sess-${name}`) } };
  util.saveState(st);
  const link = await teamsync.linkProject(util.getConfig(), key, teamId, teamName);
  const state = util.loadState();
  state.projects[key].teamEntries = [teamRow(marker)];
  state.projects[key].teamPullTs = new Date().toISOString();
  util.saveState(state);
  return { key, link };
}

const claudeMdPath = key => path.join(key, 'CLAUDE.md');
const projRecord = key => (util.loadState().projects || {})[key];

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // The documented escape hatch (team-access-fallthrough.test.js uses the
    // same one, with the same comment there): keeps this suite's ONE
    // teamsync.syncTeams call off the real macOS keychain entirely --
    // buildCryptoContext/ensureIdentity are only reached when this is not
    // false, so with it false the keychain is never touched.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'revoke-block@test.dev', 'pw-r', 'Revoker');
    const team = await teamsync.createTeam(util.getConfig(), 'RevokeCo');

    const revoked = await makeLinkedProject('revoked-app', team.team_id, 'RevokeCo', 'revokedmarker');
    const healthy = await makeLinkedProject('healthy-app', team.team_id, 'RevokeCo', 'healthymarker');

    // Defeat the pendingRefresh masking trap (see header) before the FIRST
    // real render: record the CURRENT recipe signature so every scan.syncOnce
    // call below sees no recipe change and marks nothing dirty on that
    // account. Both fixture projects are marked dirty by hand here too --
    // this is fixture setup (producing the baseline block via the real
    // render pipeline), not part of what is under test; the code path under
    // test is exercised later, by syncTeams alone.
    {
      const st = util.loadState();
      st[blockSignature.SIGNATURE_KEY] = blockSignature.blockSignature(util.getConfig());
      st.projects[revoked.key].dirty = true;
      st.projects[healthy.key].dirty = true;
      util.saveState(st);
    }
    scan.syncOnce({});

    // ---- baseline: prove the fixture actually rendered a real block before
    // touching revocation ----
    const revokedBlockBefore = h.read(claudeMdPath(revoked.key));
    const healthyBlockBefore = h.read(claudeMdPath(healthy.key));
    check('baseline: the revoked project\'s block carries its teammate row before revocation', () => {
      assert.ok(/revokedmarkerrevocationmarker/.test(revokedBlockBefore),
        `fixture: CLAUDE.md never rendered the teammate row -- the fixture is wrong, not the code:\n${revokedBlockBefore}`);
    });
    check('baseline: the healthy (control) project also carries its own teammate row', () => {
      assert.ok(/healthymarkerrevocationmarker/.test(healthyBlockBefore),
        'fixture: the control project never rendered its teammate row either -- the control would prove nothing');
    });
    // NOT a before/after revocation check -- would pass identically with the
    // fix reverted. lib/memorydb.js's buildEntries reads only proj.events and
    // never proj.teamEntries or util.teamRowsFor (grepped: no call site of
    // teamRowsFor/teamEntries anywhere in memorydb.js), and pullProject
    // writes pulled rows only to proj.teamEntries, never proj.events -- so no
    // path connects a teammate row to memory.md at all, revoked or not. This
    // is a baseline: it exists so a FUTURE change that starts routing team
    // rows through memorydb would be caught here. It is not evidence that
    // revocation "cleaned" memory.md -- memory.md never had anything of
    // this row to clean.
    check('baseline (not a revocation check): memory.md never carries teammate content, before or after', () => {
      const md = h.read(memorydb.mdPath(revoked.key));
      assert.ok(!/revokedmarkerrevocationmarker/.test(md),
        'memory.md rendered a teammate row -- lib/memorydb.js now reads team data, and this suite\'s revocation coverage does not reach it');
    });

    // ---- the state mutation: archive JUST the revoked project server-side,
    // leaving the healthy project (same team) untouched ----
    for (const p of mock.projects) if (p.id === revoked.link.projectId) p.archivedAt = new Date().toISOString();

    // ---- run the code under test: the confirmed-revoked branch of
    // syncTeams. This is the ONLY teamsync entry point this suite calls,
    // exclusively against the mock backend above. ----
    await teamsync.syncTeams({});

    check('fix: syncTeams marks the just-revoked project dirty, before any render happens', () => {
      assert.strictEqual(projRecord(revoked.key).teamAccessLost != null, true,
        'fixture: revocation was not confirmed -- project_stats mock is not excluding the archived project, so the branch under test never ran');
      assert.strictEqual(projRecord(revoked.key).dirty, true,
        'the confirmed-revoked branch did not mark the project dirty -- the next scan pass will never re-render it');
    });
    check('control: syncTeams does not mark the never-revoked project dirty', () => {
      assert.ok(!projRecord(healthy.key).teamAccessLost,
        'fixture: the control project was revoked too -- this does not isolate what the suite means to test');
      assert.ok(!projRecord(healthy.key).dirty,
        'a healthy, never-revoked project was marked dirty by a pass that only revoked a DIFFERENT project -- dirty is being set unconditionally rather than scoped to the confirmed-revoked branch');
    });

    // ---- render again, and prove the file was ACTUALLY rewritten: a byte
    // comparison against the pre-revocation snapshot, not a stat/mtime check
    // (mtime granularity would make this unreliable) ----
    const secondPass = scan.syncOnce({});

    const revokedBlockAfter = h.read(claudeMdPath(revoked.key));
    const healthyBlockAfter = h.read(claudeMdPath(healthy.key));

    check('fixed: the revoked project\'s block no longer carries the teammate row', () => {
      assert.ok(!/revokedmarkerrevocationmarker/.test(revokedBlockAfter),
        `a revoked teammate's row is still in CLAUDE.md after the next scan pass:\n${revokedBlockAfter}`);
    });
    check('fixed: the file was actually rewritten, not merely assumed to be', () => {
      assert.notStrictEqual(revokedBlockAfter, revokedBlockBefore,
        'CLAUDE.md is byte-identical to its pre-revocation snapshot -- nothing was actually written');
    });
    check('control: the healthy project\'s block is untouched -- byte-identical, not just "still has the row"', () => {
      assert.strictEqual(healthyBlockAfter, healthyBlockBefore,
        'a project that was never revoked was rewritten anyway -- the fix is not scoped to the confirmed-revoked branch');
    });

    // ---- gate-sharing: memory.md/memory.json are written inside the SAME
    // per-project dirty loop in scan.js as the block render (the
    // writeProjectMemory block runs unconditionally for every key in
    // projectKeys, right after the target-file render for that same key), so
    // the fix reconsiders them for rewrite in the same pass too, by
    // construction -- exactly what the ticket calls the "same dirty-gated
    // path". `projects` on syncOnce's return value IS that dirty-filtered
    // work list, so the revoked project appearing in it after the fix (and
    // NOT appearing in it before, per the RED proof) is the direct evidence.
    // This is a claim about ELIGIBILITY, not content -- see the baseline
    // above for why there is no content to newly clear.
    check('gate-sharing: the revoked project was in the SAME dirty-filtered pass that re-rendered its block', () => {
      assert.ok(secondPass.projects.includes(revoked.key),
        'the revoked project was not in scan.syncOnce\'s dirty-filtered work list for this pass -- the block render above could not have happened through the normal gate either');
    });
    check('control: the never-revoked project was NOT re-swept by this pass', () => {
      assert.ok(!secondPass.projects.includes(healthy.key),
        'the healthy project was revisited by a pass that had no reason to touch it -- consistent with the byte-identical check above');
    });
  } finally {
    h.noEgress.resetTeamEnv(); // NOT `delete`: an absent env var falls through to the BAKED production backend
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
