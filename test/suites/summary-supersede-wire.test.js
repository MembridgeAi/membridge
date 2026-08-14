'use strict';
// DIAGNOSTIC, approved by CTOpus for backend-supersede (ticket: one session ->
// one summary row everywhere). Confirms buildEntries() already folds a
// session's appended checkpoints to one summary-bearing entry (see
// lib/memorydb.js:214-253 and the sibling probe that proved this outside the
// suite) -- so the open question was PURELY where the wire duplicates a live
// install shows (863 rows, 70 duplicates, one session with 16 identical rows,
// origin 'team', author andrewludwigbrown) actually originate.
//
// This suite pins ONE thing only: that pushProject's own drift-heal (the
// stale-row resend, `resolution=merge-duplicates`, bumped created_at)
// converges a multi-turn session to a single backend row carrying summary
// text, when the whole session is pushed to completion in a tight loop.
//
// What it does NOT cover, and must not be read as having ruled out: the
// live 16-row case turned out to be one session pushed INCREMENTALLY over 28
// hours, same author_id throughout (no rename -- an earlier hypothesis here,
// that the durable archive's dedup key mishandles a renamed display name, was
// investigated and reverted; lib/team-archive.js carries its own landmine
// comment explaining that case is already answered downstream by
// lib/activity.js's collapseIdentityTwins, keyed on session id, and that a
// second answer to a solved problem is how the two would drift). The open
// question is whether the drift-heal still reaches an entry that has aged out
// of `entries.slice(-maxEntries)` between pushes spaced hours apart -- this
// suite's tight loop cannot exercise that, and does not claim to.
//
// Calls teamsync.pushProject(...) DIRECTLY with crypto=null -- it never
// references keychain or ensureIdentity (grepped by CTOpus independently) --
// bypassing syncTeams' identity bootstrap entirely, which is what sent an
// earlier ad-hoc probe into the real macOS keychain. config.team.encrypt is
// pinned false as belt-and-braces even though this path does not consult it.
//
// Run directly, or via `node test/run.js summary-supersede-wire`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(97);

async function main() {
  // -------------------------------------------------------------------------
  // Part 1: does pushProject's drift-heal converge a multi-turn session to
  // ONE backend row carrying summary text, or does it leave superseded rows
  // behind with their own stale (but real) content?
  // -------------------------------------------------------------------------
  {
    const mock = createMockSupabase();
    await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
    process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
    process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
    try {
      const projectPath = path.join(ROOT, 'projects', 'multi-turn-proj');
      fs.mkdirSync(projectPath, { recursive: true });

      const creds = await teamsync.signup(util.getConfig(), 'wire@test.dev', 'pw-wire', 'Wire');
      const team = await teamsync.createTeam(util.getConfig(), 'WireTeam');
      await teamsync.linkProject(util.getConfig(), projectPath, team.team_id, 'WireTeam');
      const link = teamsync.loadTeamLink(projectPath);

      const config = util.getConfig();
      config.team = { ...(config.team || {}), encrypt: false }; // belt-and-braces; pushProject(crypto=null) doesn't read this

      const session = 'sess-multiturn';
      const base = Date.UTC(2026, 6, 20, 10, 0, 0);
      const iso = ms => new Date(ms).toISOString();

      // Twelve turns: each is a new prompt (its own ask-entry, its own ts,
      // per lib/memorydb.js:126-142) immediately followed by its own
      // cumulative, whole-session-restating checkpoint -- the shape the Stop
      // hook's contract asks for (lib/digest.js:787) on a long back-and-forth
      // session, as opposed to the single-ask/many-checkpoints shape
      // feed-activity.test.js documents. Push runs after EVERY turn, exactly
      // like the daemon's tick loop would.
      const proj = { events: [] };
      for (let i = 1; i <= 12; i += 1) {
        const askTs = base + (i - 1) * 5 * 60000;
        const summaryTs = askTs + 90 * 1000;
        proj.events.push(
          { ts: iso(askTs), source: 'Claude Code', kind: 'prompt', session, text: `turn ${i}` },
          {
            ts: iso(summaryTs), source: 'Distilled', kind: 'summary', session, distilled: true,
            text: `Checkpoint ${i}: restating the whole session so far, step ${i} of 12 done.`,
          },
        );
        // eslint-disable-next-line no-await-in-loop
        await teamsync.pushProject(config, creds, projectPath, proj, link, null);
      }

      const rows = mock.entries.filter(e => e.session === session);
      const withSummary = rows.filter(e => e.summary);

      check('summary-supersede-wire: pushProject leaves at most one row per session carrying summary text', () => {
        assert.strictEqual(withSummary.length, 1,
          `expected exactly 1 row with non-null summary for a 12-turn session, got ${withSummary.length}: ` +
          JSON.stringify(withSummary.map(r => ({ ts: r.ts, summary: r.summary }))));
      });

      check('summary-supersede-wire: the surviving row carries the LATEST checkpoint text', () => {
        assert.strictEqual(withSummary[0] && withSummary[0].summary,
          'Checkpoint 12: restating the whole session so far, step 12 of 12 done.');
      });

      check('summary-supersede-wire: no two rows for this session carry the same non-null summary text (no live duplication)', () => {
        const texts = rows.filter(r => r.summary).map(r => r.summary);
        const uniq = new Set(texts);
        assert.strictEqual(uniq.size, texts.length,
          `duplicate summary text across ${texts.length} rows: ${JSON.stringify(texts)}`);
      });
    } finally {
      h.noEgress.resetTeamEnv();
      await new Promise(r => mock.server.close(r));
    }
  }

  h.finish();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
