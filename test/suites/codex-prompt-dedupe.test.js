'use strict';
// Codex records ONE user turn TWICE, and the adapter counted both.
//
// THE DEFECT. A Codex rollout writes a user message as two separate entries:
// a `response_item` / `message` with role 'user' (the item sent to the model)
// and an `event_msg` / `user_message` (the UI event). lib/adapters/codex.js
// has a branch for each -- it must, because they are also the two shapes
// different Codex versions have used -- and the emit below them pushed a
// `kind:'prompt'` event for whichever matched. Both match, so every Codex
// prompt was captured twice.
//
// NOT THEORETICAL. Measured against a real rollout produced by Codex CLI
// 0.147.0-alpha.6.5 on 2026-08-07: 11 entries in, 2 identical prompt events
// out for one user message. The two copies carry a byte-identical timestamp
// (`2026-08-07T14:32:43.273Z`), which is what makes the dedupe safe to key on.
//
// WHAT IT LOOKED LIKE. Doubled prompt volume in the feed and in search for
// every Codex user, with no signal that it was happening -- the two events
// are genuinely identical, so nothing downstream could tell them apart from a
// user who really did send the same thing twice.
//
// The fixtures here are the real rollout's shapes, reduced to the fields the
// adapter reads.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const codex = require('../../lib/adapters/codex');

const TS = '2026-08-07T14:32:43.273Z';
const CWD = '/repos/membridge';
const ASK = 'Reply with exactly the word ACKNOWLEDGED and nothing else.';

// The first line of every genuine rollout. Without it the adapter marks the
// file foreign and returns [] forever, so every fixture needs one.
function meta(over = {}) {
  return {
    type: 'session_meta',
    timestamp: TS,
    payload: { originator: 'codex_exec', history_mode: 'legacy', cwd: CWD, ...over },
  };
}

// The `response_item` half of a user turn.
function asItem(text, ts = TS) {
  return {
    type: 'response_item',
    timestamp: ts,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

// The `event_msg` half of the SAME user turn.
function asEvent(text, ts = TS) {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: text } };
}

const prompts = events => events.filter(e => e.kind === 'prompt');

function run() {
  check('codex: one user turn recorded twice yields ONE prompt', () => {
    const state = {};
    const events = codex.extractEvents([meta(), asItem(ASK), asEvent(ASK)], state);
    assert.strictEqual(prompts(events).length, 1);
    assert.strictEqual(prompts(events)[0].text, ASK);
  });

  check('codex: the pair still folds when it straddles two incremental reads', () => {
    // The reason the dedupe key lives on fileState rather than in a local.
    // scan.js reads a growing file in chunks, and the two copies can easily
    // land either side of a chunk boundary -- at which point a local would be
    // comparing against nothing and both would be emitted.
    const state = {};
    const first = codex.extractEvents([meta(), asItem(ASK)], state);
    const second = codex.extractEvents([asEvent(ASK)], state);
    assert.strictEqual(prompts(first).length, 1);
    assert.strictEqual(prompts(second).length, 0, 'second read re-emitted the same turn');
  });

  check('codex: a user really sending the same text twice counts twice', () => {
    // The case a text-only dedupe would silently swallow. "yes" / "continue"
    // are among the most common things anyone types at an agent, so this is
    // the common path, not an edge case. Different turn => different
    // timestamp => both must survive.
    const state = {};
    const events = codex.extractEvents([
      meta(),
      asItem('continue', '2026-08-07T14:32:43.273Z'),
      asEvent('continue', '2026-08-07T14:32:43.273Z'),
      asItem('continue', '2026-08-07T14:35:10.000Z'),
      asEvent('continue', '2026-08-07T14:35:10.000Z'),
    ], state);
    assert.strictEqual(prompts(events).length, 2);
  });

  check('codex: two DIFFERENT prompts on the same timestamp both survive', () => {
    // Guards the other half of the key. Timestamps collide in this format at
    // millisecond resolution, so the text has to be part of the comparison --
    // keying on ts alone would drop a real prompt.
    const state = {};
    const events = codex.extractEvents([meta(), asEvent('first thing'), asEvent('second thing')], state);
    assert.strictEqual(prompts(events).length, 2);
  });

  h.finish();
}

run();
