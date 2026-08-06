'use strict';
// Tier A must prove the interval its own wording claims (REV-4).
//
// THE BUG. Tier A's body says a file is "unchanged since" THIS SESSION READ IT
// -- the interval [read, now]. tierFor gated it on `fresh`, which compares the
// store's contentHash (stamped when warm() cached the file) against the hash
// now -- the interval [warm, now]. Different intervals, and the gap between
// them is an ordinary sequence:
//
//   T1 session reads the file      T2 someone edits it
//   T3 a sync pass warms the new content
//   T4 session reads again -> `fresh` passes -> Tier A says "unchanged since"
//
// The agent is holding T1's bytes, is told they are current, and skips the
// re-read. Every other honesty bug on this path makes the product say LESS
// than it knows; this one hands a false statement to something that acts on
// it, and nothing downstream can detect it.
//
// THE FIX. lib/hooks-recall.js records the hash this session saw at each read
// (sessionState.reads); Tier A is answered from that and is independent of the
// store. Tiers B/C keep `fresh`, which IS the right proof for them -- their
// claim is about the SKELETON matching disk, and the skeleton was built from
// exactly the content contentHash names.
//
// tierFor is a pure function of its input, so this is a table test against it
// directly -- no fixtures, no I/O, and every case states which interval it is
// probing.
//
// Run directly, or via `node test/run.js recall-tier-a-interval`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const recall = require('../../lib/recall');

const SESSION = 'sess-A';
const OTHER = 'sess-B';
const REL = 'lib/payroll.js';
const H_OLD = 'aaaa1111';
const H_NOW = 'bbbb2222';

// `input` as lib/hooks-recall.js assembles it. Defaults describe the healthy
// case; each check overrides only the field it is probing.
function input(over = {}) {
  return {
    relPath: REL,
    sessionId: SESSION,
    fileStat: { size: 9000, hash: H_NOW },
    storeEntry: { contentHash: H_NOW, skeleton: 'class Payroll { ... }' },
    ledger: { fileReaders: { [REL]: { sessions: [SESSION], reads: 2 } } },
    sessionState: { served: {}, reads: { [REL]: H_NOW }, interceptions: 0 },
    config: {},
    ...over,
  };
}

function main() {
  // ---- 1. THE BUG: edited after the read, warmed since, must not claim A ----
  check('edited since this session read it: Tier A must NOT fire', () => {
    const tier = recall.tierFor(input({
      // what the session actually saw at its read...
      sessionState: { served: {}, reads: { [REL]: H_OLD }, interceptions: 0 },
      // ...and the store was warmed AFTER the edit, so `fresh` passes
      storeEntry: { contentHash: H_NOW, skeleton: 'class Payroll { ... }' },
      fileStat: { size: 9000, hash: H_NOW },
    }));
    assert.notStrictEqual(tier, 'A',
      'Tier A fired for a file that CHANGED after this session read it. Its body says "unchanged since" — the agent '
      + 'is holding stale bytes, is being told they are current, and will skip the re-read. The gate is proving '
      + '[warm, now] while the claim is about [read, now].');
  });

  // ---- 2. THE COUNTER-CHECK: genuinely unchanged must still serve ----
  // A fix that reaches correctness by never serving Tier A is not a fix.
  check('COUNTER: a genuinely unchanged file still serves Tier A', () => {
    assert.strictEqual(recall.tierFor(input()), 'A',
      'Tier A stopped firing for a file that really is unchanged since this session read it — correctness by '
      + 'silence is not correctness');
  });

  // ---- 3. absent read hash is not agreement ----
  // Every session file written before this shipped has no `reads` map.
  check('a session with no recorded read hash fails CLOSED', () => {
    assert.notStrictEqual(recall.tierFor(input({ sessionState: { served: {}, interceptions: 0 } })), 'A',
      'a pre-upgrade session (no reads map) served Tier A — absence of proof was read as proof of no change, which '
      + 'is the silent-safe default this whole line of work exists to remove');
    assert.notStrictEqual(recall.tierFor(input({ sessionState: { served: {}, reads: {}, interceptions: 0 } })), 'A',
      'an empty reads map served Tier A');
  });

  // ---- 4. a recorded hash alone is not enough: the read must have happened ----
  // The hook runs on PreToolUse, BEFORE the read, so a hash can be recorded for
  // a read that was then denied. The ledger is what proves it actually ran.
  check('a recorded hash without a ledger record does not serve Tier A', () => {
    assert.notStrictEqual(recall.tierFor(input({ ledger: { fileReaders: {} } })), 'A',
      'Tier A fired on a PreToolUse hash alone — that covers a read that was denied and never happened, and would '
      + 'tell the session it had already seen a file it never received');
  });

  // ---- 5. COUNTER: tiers B and C are untouched ----
  // `fresh` is the correct proof for them, and this fix must not disturb it.
  check('COUNTER: Tier B still serves on a fresh store entry for another session', () => {
    const tier = recall.tierFor(input({
      sessionId: OTHER,
      sessionState: { served: {}, reads: {}, interceptions: 0 }, // no read by OTHER
      ledger: { fileReaders: { [REL]: { sessions: [SESSION], reads: 2 } } },
    }));
    assert.strictEqual(tier, 'B',
      'Tier B stopped serving — its claim is about the skeleton matching disk, which `fresh` proves correctly, and '
      + 'this change must not have touched it');
  });
  check('COUNTER: a STALE store entry still blocks Tier B', () => {
    const tier = recall.tierFor(input({
      sessionId: OTHER,
      sessionState: { served: {}, reads: {}, interceptions: 0 },
      storeEntry: { contentHash: H_OLD, skeleton: 'stale' },
    }));
    assert.strictEqual(tier, null, 'a stale skeleton was served as though it matched the file on disk');
  });

  // ---- 6. Tier A no longer depends on the store at all ----
  // It serves a one-line notice and never reads a skeleton, so a missing or
  // stale store entry must not suppress a claim it can prove by itself.
  check('Tier A serves without any store entry, since it never uses one', () => {
    assert.strictEqual(recall.tierFor(input({ storeEntry: null })), 'A',
      'Tier A was suppressed by a missing store entry it has no use for');
    assert.strictEqual(recall.tierFor(input({ storeEntry: { contentHash: H_OLD, skeleton: 'stale' } })), 'A',
      'Tier A was suppressed by a STALE store entry — its own proof (the read-time hash) was still valid');
  });

  // ---- 7. decide() must be able to FINISH a store-less Tier A serve (REV-8) ----
  // tierFor returning 'A' without a store entry is only half a serve: decide()
  // then has to build the body. It read storeEntry.contentHash to do that,
  // which throws the moment Tier A is exercised on the path REV-4 opened for
  // it -- and the hook's outer fail-open swallows the throw into silence, so
  // the tier looks merely absent rather than broken.
  const dInput = (over = {}) => ({ ...input(), toolName: 'Read', tracked: true, offset: null, limit: null, ...over });

  check('decide() serves Tier A with NO store entry, and quotes the hash it proved', () => {
    const d = recall.decide(dInput({ storeEntry: null }));
    assert.strictEqual(d.serve, true, `Tier A did not serve without a store entry: ${d.reason}`);
    assert.strictEqual(d.tier, 'A');
    assert.ok(d.body.includes(H_NOW.slice(0, 8)),
      `Tier A quoted a hash it did not prove. Its evidence is the content THIS session read (${H_NOW}), which is `
      + `the only hash it has when there is no store entry at all: ${d.body}`);
  });

  check('decide() quotes the FILE hash, not a stale store hash, when both exist', () => {
    const d = recall.decide(dInput({ storeEntry: { contentHash: H_OLD, skeleton: 'stale', skeletonTokens: 10 } }));
    assert.strictEqual(d.tier, 'A');
    assert.ok(d.body.includes(H_NOW.slice(0, 8)) && !d.body.includes(H_OLD.slice(0, 8)),
      `Tier A quoted the store's warm-time hash next to a claim about what this session read: ${d.body}`);
  });

  // ---- 8. "already served" is a fact about CONTENT, not about a path ----
  check('COUNTER: the same path, same content, is never served twice in a session', () => {
    const d = recall.decide(dInput({
      storeEntry: null,
      sessionState: { served: { [REL]: H_NOW }, reads: { [REL]: H_NOW }, interceptions: 1 },
    }));
    assert.strictEqual(d.serve, false, 'a session was handed the same pointer for the same bytes twice');
    assert.strictEqual(d.reason, 'already-served');
  });

  check('a serve for content that has since CHANGED does not silence the new content', () => {
    // Served the pointer for H_OLD, the file was rewritten, this session read
    // the new bytes and is now re-reading them. The earlier serve says nothing
    // about H_NOW, and refusing on it is the same borrowed-fact bug as before.
    const d = recall.decide(dInput({
      storeEntry: null,
      sessionState: { served: { [REL]: H_OLD }, reads: { [REL]: H_NOW }, interceptions: 1 },
    }));
    assert.strictEqual(d.serve, true,
      `refused with "${d.reason}" — the only serve this session got was about content that no longer exists on disk`);
    assert.strictEqual(d.tier, 'A');
  });

  check('COUNTER: Tier B is undisturbed by the served-hash rule', () => {
    // Another session read it, the skeleton is fresh -> B, exactly as before.
    const served = recall.decide(dInput({
      sessionId: OTHER,
      sessionState: { served: {}, reads: {}, interceptions: 0 },
      storeEntry: { contentHash: H_NOW, skeleton: 'class Payroll { ... }', skeletonTokens: 20 },
    }));
    assert.strictEqual(served.tier, 'B', `Tier B stopped serving: ${served.reason}`);
    // ...and a B serve for these exact bytes still bars a second one.
    const again = recall.decide(dInput({
      sessionId: OTHER,
      sessionState: { served: { [REL]: H_NOW }, reads: {}, interceptions: 1 },
      storeEntry: { contentHash: H_NOW, skeleton: 'class Payroll { ... }', skeletonTokens: 20 },
    }));
    assert.strictEqual(again.serve, false, 'a Tier B skeleton was served twice for the same content');
    assert.strictEqual(again.reason, 'already-served');
  });

  h.finish();
}

main();
