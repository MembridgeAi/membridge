'use strict';
const util = require('./util');
const hooks = require('./hooks');
const hookConsent = require('./hook-consent');

// Does the first-run dialog still have a question to ask?
//
// It now asks the CONSENT RECORD, not just `distill.consent`. Two cases the
// old form got wrong, both of which end in a user being asked something they
// have already answered:
//   - a machine that opted out via `remove-hooks` or the Settings toggle would
//     be asked to enable summaries again on the next app launch;
//   - an install that predates the record and was grandfathered in
//     (hooks.installConsent) would be asked despite already running happily.
function needsConsentPrompt(config) {
  if (!config || !config.distill) return false;
  if (config.distill.enabled === false) return false;
  if (hookConsent.state(config) !== hookConsent.UNKNOWN) return false;
  return config.distill.consent == null;
}

// Apply the first-run answer, and RETURN WHAT ACTUALLY HAPPENED.
//
// The declined branch used to write `distill.consent = 'declined'` and return
// the sentence "Session summaries declined — no hook installed." Both halves
// were false: nothing read that field, and by the time the dialog appeared
// hooks.ensureInstalled had already written the Stop hook, both PreToolUse
// hooks, the SessionStart hooks and a Bash auto-approve rule. The user was
// told nothing was installed while four hooks were intercepting their session.
//
// Now the decline is a real decision: it records the opt-out that every
// reconciler and every hook body honours, and it removes anything an earlier
// build installed before asking. The sentence is then assembled from the
// removal count, so it can only say what happened.
function applyConsent(decision) {
  const raw = util.loadUserConfig();
  if (!raw.distill) raw.distill = {};
  raw.distill.consent = decision;
  // BELT AND BRACES, on the capture side.
  //
  // The hook-entry gate (lib/hook-consent.js, consulted by all four
  // reconcilers) is the primary control, and it is enough on its own for every
  // path that goes through a hook. `distill.enabled` is a SECOND, independent
  // switch read by the capture/distill path itself, so a decline that only
  // recorded the consent state left a route by which a summary could still be
  // produced if anything invoked distillation without passing the hook gate —
  // which is exactly what the companion suite caught: scanSummaries still
  // returned a captured event after a decline.
  //
  // Two independent switches, one decision. Only on decline: a grant must not
  // silently flip `enabled` on for someone who had deliberately turned it off.
  if (decision !== 'granted') raw.distill.enabled = false;
  util.saveUserConfig(raw);
  if (decision === 'granted') {
    // setupHooks records the grant itself, before it writes anything.
    hooks.setupHooks();
    return 'Session summaries enabled — Stop hook installed.';
  }
  // Fail-open, and say so. The removal reads settings.json, which throws when
  // that file is unreadable or malformed — a state the user has to fix by hand.
  // The decline itself is already recorded (hook bodies and reconcilers read
  // the config, not settings.json), so the honest report is "recorded, but I
  // could not clean up", never a thrown dialog handler and never a claim that
  // nothing was installed.
  let removed = 0;
  try {
    ({ removed } = hooks.removeHooksDetailed({ via: 'first-run-dialog' }));
  } catch (err) {
    try { hooks.hookConsent.record('declined', 'first-run-dialog'); } catch {}
    return `Session summaries declined — recorded, but your Claude Code settings could not be read to remove any hook already installed (${err && err.message ? err.message : err}).`;
  }
  return removed
    ? `Session summaries declined — removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'} an earlier launch had installed before asking.`
    : 'Session summaries declined — no hook installed.';
}

module.exports = { needsConsentPrompt, applyConsent };
