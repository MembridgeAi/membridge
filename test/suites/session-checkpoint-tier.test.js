'use strict';
// The session detail page's `checkpoints` field (lib/server.js sessionPayload,
// ~1354) used to ship every appended checkpoint verbatim, for both tiers. For
// a distilled session that is wrong on purpose vs by accident: the Stop
// hook's own contract (lib/digest.js:787, lib/hooks.js:177) has each appended
// line restate the WHOLE session so far, so a session with N checkpoints
// shipped N near-identical restatements of itself -- the "twelve near-
// identical bullets" a human reported live, rendered by
// ui/src/features/session/distill.ts's distilledBullets (which only dedupes
// EXACT-match lines, never restatements) and, worse, by PromptChain, which
// attaches each whole-session restatement to whichever single prompt it
// happened to follow -- misattributing the rest of the session's work to
// that one prompt.
//
// THE FIX pins two tiers as genuinely different data, because they are:
//   * DISTILLED (agent-written, supersede applies): `checkpoints: []`. The
//     payload's `summary` field already carries the latest checkpoint's
//     text -- there is nothing left for the trail to say that isn't already
//     said once, correctly, above it.
//   * HARVESTED (no distilled events; sessionSummaries' own fallback):
//     UNCHANGED, full trail. Harvested checkpoints are last-text-per-capture,
//     genuinely distinct per entry, not restatements -- the trail is real
//     information there and this suite pins that it still ships.
//
// Deliberately NOT covered here (out of this ticket's scope, per CTOpus):
// lib/digest.js sessionSummaries itself keeps its contract unchanged --
// lib/memorydb.js:228 is a second, internal caller that needs the untouched
// full ordered list to decide its own collapse, so the split lives at this
// one call site, not inside the shared function.
//
// Run directly, or via `node test/run.js session-checkpoint-tier`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const server = require('../../lib/server');

function makeProject(name) {
  const key = path.join(h.ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
  return key;
}

function main() {
  util.ensureConfig();

  const distilledKey = makeProject('distilled-tier');
  const harvestedKey = makeProject('harvested-tier');
  const singleKey = makeProject('single-checkpoint');

  const DISTILLED_SESSION = 'sess-distilled-multi';
  const HARVESTED_SESSION = 'sess-harvested';
  const SINGLE_SESSION = 'sess-distilled-single';

  const base = Date.UTC(2026, 6, 22, 9, 0, 0);
  const iso = ms => new Date(ms).toISOString();

  {
    const st = util.loadState();
    // Three appended checkpoints, each a fuller whole-session restatement --
    // the exact shape the Stop hook's contract produces on a long session.
    st.projects[distilledKey] = {
      events: [
        { ts: iso(base), source: 'Claude Code', kind: 'prompt', session: DISTILLED_SESSION,
          text: 'fix the date bug', files: ['lib/date.js'] },
        { ts: iso(base + 60000), source: 'Distilled', kind: 'summary', session: DISTILLED_SESSION,
          distilled: true, text: 'Found the off-by-one in the date parser.' },
        { ts: iso(base + 120000), source: 'Distilled', kind: 'summary', session: DISTILLED_SESSION,
          distilled: true, text: 'Found the off-by-one in the date parser and fixed it.' },
        { ts: iso(base + 180000), source: 'Distilled', kind: 'summary', session: DISTILLED_SESSION,
          distilled: true,
          text: 'Found the off-by-one in the date parser, fixed it, and added a regression test.' },
      ],
    };
    // Two genuinely different harvested checkpoints -- no distilled events
    // for this session at all, so sessionSummaries falls back to the
    // harvested tier per its own documented rule.
    st.projects[harvestedKey] = {
      events: [
        { ts: iso(base), source: 'Codex', kind: 'prompt', session: HARVESTED_SESSION,
          text: 'clean up the config loader', files: ['lib/config.js'] },
        { ts: iso(base + 60000), source: 'Codex', kind: 'summary', session: HARVESTED_SESSION,
          text: 'harvested: last tool output mentioned the loader' },
        { ts: iso(base + 120000), source: 'Codex', kind: 'summary', session: HARVESTED_SESSION,
          text: 'harvested: last tool output mentioned the schema check' },
      ],
    };
    st.projects[singleKey] = {
      events: [
        { ts: iso(base), source: 'Claude Code', kind: 'prompt', session: SINGLE_SESSION,
          text: 'quick one-line fix', files: ['lib/quick.js'] },
        { ts: iso(base + 60000), source: 'Distilled', kind: 'summary', session: SINGLE_SESSION,
          distilled: true, text: 'Made the one-line fix.' },
      ],
    };
    util.saveState(st);
  }

  check('distilled tier: a multi-checkpoint session ships an empty checkpoints array', () => {
    const s = server.sessionPayload(DISTILLED_SESSION);
    assert.ok(s, 'sessionPayload returned null for a session state.js genuinely holds');
    assert.deepStrictEqual(s.checkpoints, []);
  });

  check('distilled tier: summary still carries the LATEST checkpoint text', () => {
    const s = server.sessionPayload(DISTILLED_SESSION);
    assert.strictEqual(s.summary,
      'Found the off-by-one in the date parser, fixed it, and added a regression test.');
  });

  check('harvested tier: the full trail ships exactly as before, unchanged', () => {
    const s = server.sessionPayload(HARVESTED_SESSION);
    assert.strictEqual(s.checkpoints.length, 2, `expected both harvested checkpoints, got ${s.checkpoints.length}`);
    assert.deepStrictEqual(s.checkpoints.map(c => c.text), [
      'harvested: last tool output mentioned the loader',
      'harvested: last tool output mentioned the schema check',
    ]);
  });

  check('distilled tier: a SINGLE checkpoint also ships empty -- no N=1 special case', () => {
    const s = server.sessionPayload(SINGLE_SESSION);
    assert.deepStrictEqual(s.checkpoints, []);
    assert.strictEqual(s.summary, 'Made the one-line fix.');
  });

  check('distilled tier: unavailable does NOT name checkpoints -- this is a real empty trail, not a structural gap', () => {
    // The team-origin branch names 'checkpoints' in `unavailable` because no
    // trail crosses team sync at all (lib/server.js TEAM_UNAVAILABLE). A
    // local session's empty checkpoints array must not borrow that marker --
    // it would tell the client something is missing that in fact never
    // existed to ship, which is the opposite of what TEAM_UNAVAILABLE means.
    const s = server.sessionPayload(DISTILLED_SESSION);
    assert.ok(!s.unavailable.includes('checkpoints'),
      'a local distilled session\'s empty checkpoints must read as "none", not as "structurally unavailable"');
  });

  h.finish();
}

main();
