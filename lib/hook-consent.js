'use strict';
// The recorded answer to one question: may MemBridge write hooks into this
// user's Claude Code settings, and may the hooks it already wrote do anything?
//
// It exists because there was no such record. The first-run dialog asked, the
// answer was stored as `distill.consent`, and NOTHING read it: the launch path
// (hooks.ensureInstalled) had already written the Stop hook, both PreToolUse
// hooks and an auto-approve rule before the dialog appeared, no hook body read
// consent at all, and `applyConsent('declined')` returned the sentence "no hook
// installed" over an install that had just happened. The same gap made
// `remove-hooks` and the Settings toggle temporary: they stripped the entries,
// and the next launch put them straight back.
//
// The shape is copied deliberately from lib/mcp-register.js, which already
// solved the second half: a recorded 'unregister' makes ensureRegistered()
// answer 'opted-out' forever, and `membridge mcp register` is the documented
// way back in. Here the record is `config.hooks`, the opt-out is a recorded
// 'declined', and `membridge setup-hooks` is the way back in.
//
// Stored in config.json rather than state.json on purpose. This is a user
// decision, not a derived cache: state.json has no locking (any
// load -> work -> save races every other process), and it is routinely deleted
// and rebuilt — a consent record that a state rebuild silently forgets is not
// a consent record. config.json is written only on the rare decision itself.
//
// Deliberately dependency-light (util only). The recall and search hook bodies
// call in on every Read/Grep/Glob and must not drag lib/hooks.js — 2k lines and
// its whole require graph — onto that path.
const util = require('./util');

const GRANTED = 'granted';
const DECLINED = 'declined';
const UNKNOWN = 'unknown';

// Every write goes through here, so the recorded shape is one shape:
//   config.hooks = { consent: 'granted'|'declined', decidedAt: <iso>, via: <token> }
// `via` is diagnostic only — it names which surface the user answered on
// ('first-run-dialog', 'setup-hooks', 'remove-hooks', 'pre-existing-install').
function record(decision, via) {
  if (decision !== GRANTED && decision !== DECLINED) {
    throw new Error(`hook consent must be '${GRANTED}' or '${DECLINED}', got ${JSON.stringify(decision)}`);
  }
  const raw = util.loadUserConfig();
  if (!raw.hooks || typeof raw.hooks !== 'object' || Array.isArray(raw.hooks)) raw.hooks = {};
  raw.hooks.consent = decision;
  raw.hooks.decidedAt = new Date().toISOString();
  if (via) raw.hooks.via = via;
  util.saveUserConfig(raw);
  return raw.hooks;
}

// Pure read — no disk probe, no writes, safe on the hook hot path.
//
// Returns 'granted', 'declined' or 'unknown'. 'unknown' is a real answer and
// the reason this is a three-value function rather than a boolean: it means
// nobody has been asked yet, which the launch path must treat as "do not
// write" and a hook body already on disk must NOT treat as "refuse to run"
// (see hooks.js's installConsent for the pre-existing-install case).
//
// The legacy fallback below is what keeps an install that predates this record
// working with no re-prompt and no interruption: `distill.consent` is the field
// the first-run dialog and the Settings toggle have always written. A user who
// granted it stays granted; a user who declined it finally gets the decline
// honoured (it never did anything before).
//
// `distill.enabled === false` is deliberately NOT read here. That switch is a
// preference about SUMMARIES, and reading it as a consent withdrawal would
// silence teammate notes and recall for someone who only turned summaries off
// — the same conflation of two independent switches that hooks-recall.js
// already calls out. The Settings toggle records the real decision on its own
// (it routes through removeHooks), so nothing is lost by ignoring it.
function state(config) {
  let cfg = config;
  if (!cfg) {
    try { cfg = util.getConfig(); } catch { return UNKNOWN; }
  }
  const rec = cfg && cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks.consent : null;
  if (rec === GRANTED || rec === DECLINED) return rec;
  const distill = (cfg && cfg.distill) || {};
  if (distill.consent === GRANTED) return GRANTED;
  if (distill.consent === DECLINED) return DECLINED;
  return UNKNOWN;
}

// The hook-body gate. Deliberately narrower than `state(...) !== 'granted'`:
// a body only stands down on an explicit NO. An installed hook running under
// an 'unknown' record is an install that predates the record — the hooks are
// on disk, they have been running for months, and refusing to run them would
// break a working install to satisfy a bookkeeping gap. Under the new rules
// nothing can put a hook on disk without a grant, so 'unknown' + installed can
// only mean legacy.
function declined(config) {
  return state(config) === DECLINED;
}

module.exports = { GRANTED, DECLINED, UNKNOWN, record, state, declined };
