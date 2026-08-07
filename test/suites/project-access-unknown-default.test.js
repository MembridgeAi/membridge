'use strict';
// readAccess must never INVENT this project's access state.
//
// lib/api-access.js readAccess asks the backend for one thing it cannot derive
// locally: `projects?id=eq.<projectId>&select=default_access`. That answer
// decides `canSee` for every member with no explicit project_access row, and it
// is the value behind the "New members join with access" toggle. The line used
// to read:
//
//     Array.isArray(projectRows) && projectRows.length ? !!projectRows[0].default_access : true
//
// so an EMPTY or UNREADABLE answer became `true` — every member reported as
// able to see a project the daemon knows nothing about. Same defect shape as
// the one beside it (a value asserting something the code never established),
// and the same root cause as the H-4 bug: PostgREST answers `200 []` for a row
// that is refused AND for a row that is absent, so an empty array is not a
// fact.
//
// Reachable state, no adversary and no exotic setup. `.membridge/team.json` is
// a COMMITTED file (lib/teamsync.js linkProject adopts an existing one and
// deliberately leaves it byte-identical), while `public.projects` is backend
// state that can be deleted, archived away by a hard delete, or simply never
// have been created. A manager opening the Project page for a project whose
// backend row is gone is the whole precondition.
//
// The contract this suite pins (S-54): refuse. Two distinguishable failures,
// because they need different remedies and neither may be reported as the
// other:
//
//   409 — the answer was READ and contained no row for this project. Durable:
//         the local link points at a project the backend does not have. The
//         manager has to relink.
//   502 — the answer could not be READ at all (non-JSON body behind a 200,
//         which restCall turns into `null`). Transient: retry.
//
// And the third check is the one that stops the fix from being "refuse
// whenever the list is short": a project whose row IS present still answers,
// including the `default_access = false` case, which is the only case where
// falling open was ever a disclosure rather than a misreport.
//
// Run directly, or via `node test/run.js project-access-unknown-default`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const apiAccess = require('../../lib/api-access');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(67);

async function makeLinkedProject(name, teamId, teamName) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: [] } };
  util.saveState(st);
  const link = await teamsync.linkProject(util.getConfig(), key, teamId, teamName);
  return { key, link };
}

// The refusal must carry its own status through to the HTTP layer, exactly
// like readAccess's existing 401/403/404 do (lib/server.js's /api/project/access
// handler answers `err.status || 500`). A thrown Error with no status would
// surface as a generic 500, which the UI reads as "the daemon is broken".
async function refusalOf(projectPath) {
  try {
    const answer = await apiAccess.readAccess(util.getConfig(), projectPath);
    return { threw: false, answer };
  } catch (err) {
    return { threw: true, status: err.status, message: err.message };
  }
}

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // The documented escape hatch every other team suite uses: keeps the mock
    // round trip off the real macOS keychain.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'AccessCo');

    const gone = await makeLinkedProject('vanished-app', team.team_id, 'AccessCo');
    const present = await makeLinkedProject('present-app', team.team_id, 'AccessCo');

    // Baseline: with the row present, a manager gets a real answer. Establishes
    // that everything else in this fixture (auth, role, members, project_access)
    // works, so the refusals below are about the missing row and nothing else.
    const baseline = await refusalOf(present.key);
    assert.strictEqual(baseline.threw, false,
      `fixture: a healthy project should answer, got ${baseline.status} ${baseline.message}`);
    assert.strictEqual(baseline.answer.defaultAccess, true,
      'fixture: link_project should leave default_access at the table default');

    // THE STATE: the backend row is gone, the committed link file is not.
    // Nothing else changes — same team, same membership, same manager role.
    const goneIdx = mock.projects.findIndex(p => p.id === gone.link.projectId);
    assert.ok(goneIdx >= 0, 'fixture: the project row should exist before it is removed');
    mock.projects.splice(goneIdx, 1);

    await check('a project row the backend does not have is refused, not defaulted to visible', async () => {
      const r = await refusalOf(gone.key);
      assert.strictEqual(r.threw, true,
        `readAccess answered for a project the backend has no row for: ${JSON.stringify(r.answer)} ` +
        '— every member with no explicit project_access row was reported with a canSee this code never established');
      assert.strictEqual(r.status, 409,
        `the refusal must carry a status the HTTP layer can pass through, and it must not reuse ` +
        `401/403/404 (each already means something else here); got ${r.status}: ${r.message}`);
      assert.ok(/project/i.test(r.message),
        `the message has to say WHICH thing could not be determined, got: ${r.message}`);
    });

    await check('the refusal never leaks a fabricated member list alongside it', async () => {
      const r = await refusalOf(gone.key);
      assert.strictEqual(r.answer, undefined,
        'a refusal that still returns members lets a caller ignore the error and render the guess');
    });

    // The unreadable-answer case: a 200 whose body is not JSON. restCall's
    // `res.json().catch(() => null)` turns that into `null`, which the old
    // `Array.isArray` test also swallowed into `true`. Distinct status: this one
    // is transient and a manager should retry, not relink.
    const realHandler = mock.server.listeners('request')[0];
    mock.server.removeAllListeners('request');
    mock.server.on('request', (req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/projects?id=eq.')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('<html>a proxy answered instead</html>');
      }
      return realHandler(req, res);
    });

    await check('an unreadable default_access answer is refused as transient, not as a missing project', async () => {
      const r = await refusalOf(present.key);
      assert.strictEqual(r.threw, true,
        `a 200 with an unparseable body was accepted as "no rows" and defaulted to visible: ${JSON.stringify(r.answer)}`);
      assert.strictEqual(r.status, 502,
        `"the backend's answer could not be read" is a different remedy from "the project is gone" and ` +
        `must not be reported as 409; got ${r.status}: ${r.message}`);
    });

    mock.server.removeAllListeners('request');
    mock.server.on('request', realHandler);

    // The half of the pair that stops the fix from being a blanket refusal: a
    // present row still answers, and it answers with the project's REAL
    // default — including false, which is the case the old fall-open actually
    // mis-stated in the permissive direction.
    await check('a project whose row IS present still answers, default_access = false included', async () => {
      const row = mock.projects.find(p => p.id === present.link.projectId);
      row.defaultAccess = false;
      // Drop the rows 029/032 materialize on link, so this member genuinely has
      // NO explicit project_access row and the default is what decides — the
      // fall-through path this whole ticket is about. With the materialized row
      // in place tier 1 wins and the default is never consulted, which would
      // make the assertion below vacuous.
      for (let i = mock.projectAccess.length - 1; i >= 0; i--) {
        if (mock.projectAccess[i].project_key === present.link.projectId) mock.projectAccess.splice(i, 1);
      }
      const r = await refusalOf(present.key);
      assert.strictEqual(r.threw, false,
        `a healthy project was refused: ${r.status} ${r.message}`);
      assert.strictEqual(r.answer.defaultAccess, false,
        'the project\'s real default_access was not reported');
      assert.ok(r.answer.members.length > 0, 'the member list went missing');
      assert.ok(r.answer.members.every(m => m.canSee === false),
        `a member with no explicit project_access row must inherit default_access = false, got ` +
        JSON.stringify(r.answer.members));
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
