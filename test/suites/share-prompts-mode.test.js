'use strict';
// --- three-value share-prompts mode ---
//
// Alpha readiness Task 5A. Widens `team.sharePrompts` from a boolean to
// `'off' | 'distilled' | 'verbatim'`, with the boolean kept for back-compat.
// The whole point is that a fresh install no longer uploads verbatim prompt
// text by default: `entryToRow` sends the agent-written `goal` (distilled from
// summaries.jsonl by the Stop hook) and sends the raw `ask` as null.
//
// These checks lock the wire shape at the boundary. If they go red on a wire
// change, that IS the point of the ticket, and a change that widens what
// crosses the machine boundary without touching this file is the bug shape.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env
const { check } = h;
const assert = require('assert');
const teamsync = require('../../lib/teamsync');
const util = require('../../lib/util');
const digest = require('../../lib/digest');

const CREDS = { userId: '00000000-0000-0000-0000-000000000001', displayName: 'Marco' };
const PROJECT_ID = '00000000-0000-0000-0000-0000000000aa';
const REGEXES = digest.compileRedactions({});

// A representative entry: it carries a raw prompt AND a distilled goal, which
// is the case the three-way setting has to route between (verbatim ships both,
// distilled ships only the goal, off ships neither).
const ENTRY = {
  ts: '2026-08-06T10:00:00.000Z',
  source: 'Claude Code',
  session: 'session-abc',
  ask: 'the raw user prompt with a shape-matched Stripe key sk_live_abcdefghij1234567890abcd',
  goal: 'Distilled intent: install the enroll command and backfill history',
  summary: 'Did the thing.',
  headline: 'Install enroll command',
  decisions: '- Chose add over init',
  gotchas: '- state.json has no locking',
  files: ['bin/membridge.js', 'lib/server.js'],
  changes: [{ file: 'bin/membridge.js', add: 12, del: 3 }],
  distilled: true,
};

check('readShareMode: fresh install (distilled) resolves through the new normalizer', () => {
  const mode = teamsync.readShareMode({ team: { sharePrompts: 'distilled' } });
  assert.strictEqual(mode, 'distilled');
});

check('readShareMode: legacy boolean true maps to verbatim (no existing user changes)', () => {
  const mode = teamsync.readShareMode({ team: { sharePrompts: true } });
  assert.strictEqual(mode, 'verbatim');
});

check('readShareMode: legacy boolean false maps to off', () => {
  const mode = teamsync.readShareMode({ team: { sharePrompts: false } });
  assert.strictEqual(mode, 'off');
});

check('readShareMode: absent config value returns off (fail-closed default)', () => {
  assert.strictEqual(teamsync.readShareMode({}), 'off');
  assert.strictEqual(teamsync.readShareMode(null), 'off');
  assert.strictEqual(teamsync.readShareMode({ team: {} }), 'off');
});

check('readShareMode: an unknown value returns off (never ship prompts on a typo)', () => {
  assert.strictEqual(teamsync.readShareMode({ team: { sharePrompts: 'yes' } }), 'off');
  assert.strictEqual(teamsync.readShareMode({ team: { sharePrompts: 1 } }), 'off');
});

check('freshInstallConfig ships distilled — verbatim is opt-in only', () => {
  const cfg = util.freshInstallConfig();
  assert.strictEqual(cfg.team.sharePrompts, 'distilled',
    'a fresh install must default to distilled so verbatim prompts do not upload without a choice');
});

check('sharedFieldsFor: with a distilled config default, the returned mode is distilled', () => {
  const cfg = { team: { sharePrompts: 'distilled' } };
  const proj = {};
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, 'session-abc'), 'distilled');
});

check('sharedFieldsFor: a per-session opt-in upgrades to verbatim even from distilled', () => {
  const cfg = { team: { sharePrompts: 'distilled' } };
  const proj = { sharedSessions: ['session-abc'] };
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, 'session-abc'), 'verbatim');
  // A session NOT in the opt-in list on a project that has ANY per-session UI
  // history stays off — presence of the array switches the project out of the
  // legacy global fallback, which is the pre-existing behavior isShared had.
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, 'session-other'), 'off');
});

check('sharedFieldsFor: no sessionId means nothing to share (never leak on a null id)', () => {
  const cfg = { team: { sharePrompts: 'verbatim' } };
  const proj = { sharedSessions: ['session-abc'] };
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, null), 'off');
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, ''), 'off');
});

check('sharedFieldsFor: legacy config with no per-session array honors the global setting', () => {
  // The pre-migration honor window: a project that has never seen the
  // per-session UI (no sharedSessions array at all) still respects the old
  // global config value, translated through the new mode.
  const cfg = { team: { sharePrompts: true } }; // legacy boolean on
  const proj = {};
  assert.strictEqual(teamsync.sharedFieldsFor(cfg, proj, 'session-abc'), 'verbatim');
});

check('entryToRow (verbatim): ships both ask and goal, scrubbed and clipped', () => {
  const row = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, 'verbatim', REGEXES, '/tmp/nonexistent');
  assert.ok(row.ask && typeof row.ask === 'string' && row.ask.length > 0,
    'verbatim mode must ship the raw ask');
  assert.ok(row.goal && typeof row.goal === 'string' && row.goal.length > 0,
    'verbatim mode must ship the goal');
  // Defense in depth: the shape-matched key must not survive redactText.
  assert.ok(!/sk_live_abcdefghij1234567890abcd/.test(row.ask),
    'the shape-matched Stripe key leaked through the redaction pipeline');
});

check('entryToRow (distilled): goal ships, ask is explicit null', () => {
  const row = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, 'distilled', REGEXES, '/tmp/nonexistent');
  assert.strictEqual(row.ask, null,
    'distilled mode must NOT ship the raw ask — that is the whole point of the mode');
  assert.ok(row.goal && typeof row.goal === 'string' && row.goal.length > 0,
    'distilled mode must ship the agent-written goal so the row is readable');
  // Non-prompt fields ride along regardless.
  assert.ok(row.summary && row.summary.length > 0);
  assert.ok(row.headline && row.headline.length > 0);
});

check('entryToRow (off): both ask and goal are explicit null; non-prompt fields still ship', () => {
  const row = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, 'off', REGEXES, '/tmp/nonexistent');
  assert.strictEqual(row.ask, null);
  assert.strictEqual(row.goal, null);
  // The row still carries decisions, summary, headline, files, changes — the
  // legacy fallback comment above line 1826 lists these as "ship regardless".
  assert.ok(row.summary && row.summary.length > 0);
  assert.ok(row.headline && row.headline.length > 0);
  assert.ok(row.decisions && row.decisions.length > 0);
});

check('entryToRow keeps the explicit-null convention (never undefined) across all three modes', () => {
  // PostgREST rejects a batch whose rows disagree on their key SET; the
  // comment above line 985 pins this. Missing fields must serialize as
  // explicit `null`, never `undefined` (which JSON.stringify drops).
  for (const mode of ['off', 'distilled', 'verbatim']) {
    const row = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, mode, REGEXES, '/tmp/nonexistent');
    for (const key of ['ask', 'goal', 'summary', 'headline', 'decisions', 'gotchas']) {
      // Either a truthy string OR literal null — never undefined.
      const v = row[key];
      assert.ok(v === null || (typeof v === 'string' && v.length > 0),
        `${mode}: ${key} must be null or non-empty string, got ${JSON.stringify(v)}`);
    }
  }
});

check('entryToRow still accepts a boolean share arg for back-compat (reshareSession)', () => {
  // reshareSession() historically passed a plain boolean. Until every caller
  // is on the mode string, the entry point must keep interpreting true as
  // verbatim and false as off.
  const rowTrue = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, true, REGEXES, '/tmp/nonexistent');
  const rowFalse = teamsync.entryToRow(ENTRY, PROJECT_ID, CREDS, false, REGEXES, '/tmp/nonexistent');
  assert.ok(rowTrue.ask && rowTrue.goal, 'share=true (legacy) must behave like verbatim');
  assert.strictEqual(rowFalse.ask, null);
  assert.strictEqual(rowFalse.goal, null);
});

h.finish();
