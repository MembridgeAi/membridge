'use strict';
// Post-install feedback nudges. LOCAL-ONLY: this module never opens a socket,
// never phones home, never auto-submits anything. It only prints two text
// messages (each exactly once, ever) and points the user at a static web form
// they choose to open. All state lives in ~/.membridge/state.json. Every state
// write is wrapped so a broken state file can never crash a normal command —
// these are nudges, not core function.
//
// The canonical repo in every link is MembridgeAi/membridge.

const path = require('path');
const util = require('./util');

// Print only to a real interactive terminal: a TTY, not CI, and not disabled in
// config. This is what keeps the messages out of the detached daemon's logfile
// and out of piped/scripted output.
function shouldPrompt(config) {
  return !!process.stdout.isTTY && !process.env.CI && (!config || config.prompts !== false);
}

const MESSAGE_A =
  '✓ MemBridge is running — watching Claude Code + Codex sessions.\n' +
  '\n' +
  "  You're one of the first people running this.\n" +
  '  90-sec feedback:  https://membridge.app/feedback?ref=cli\n' +
  '  Bugs / breakage:  https://github.com/MembridgeAi/membridge/issues\n' +
  '  Useful? A star genuinely helps: https://github.com/MembridgeAi/membridge';

function messageB(n) {
  return (
    '★ MemBridge has synced ' + n + ' sessions across your tools so far.\n' +
    '  Worth 90 seconds? Your feedback shapes v0.2: https://membridge.app/feedback?ref=cli-value'
  );
}

// Wrap all state mutation: a nudge must never break a real command.
function withState(fn) {
  try {
    const state = util.loadState();
    if (!state.feedback) return; // loadState defaults it, but stay defensive
    fn(state);
  } catch {
    // fail silent: a broken state file is not this feature's problem to surface
  }
}

// First-run message. Shows once, ever.
function maybeFirstRun(config) {
  if (!shouldPrompt(config)) return;
  withState(state => {
    if (state.feedback.firstRunShown) return;
    console.log(MESSAGE_A);
    state.feedback.firstRunShown = true;
    util.saveState(state);
  });
}

// How many of this sync's changes were real context-file writes (CLAUDE.md,
// AGENTS.md, ...) — an 'updated' action whose basename is a configured target.
// Memory.md / the project memory DB are NOT context files, so they never count.
function countAmendments(changes, config) {
  const targets = new Set(util.effectiveTargets(config));
  let n = 0;
  for (const c of changes || []) {
    if (c && c.action === 'updated' && targets.has(path.basename(c.file || ''))) n++;
  }
  return n;
}

// Distinct session ids across all tracked projects' events. This is the real
// "sessions synced" number; falls back to the amendment count if no events
// carry a session (never returns 0 to the caller — flushValueMoment guards on
// amendments >= 5, so there is always a positive number to show).
function sessionCount(state) {
  const seen = new Set();
  const projects = (state && state.projects) || {};
  for (const key of Object.keys(projects)) {
    const events = (projects[key] && projects[key].events) || [];
    for (const e of events) {
      if (e && e.session) seen.add(e.session);
    }
  }
  if (seen.size > 0) return seen.size;
  return (state && state.feedback && state.feedback.amendments) || 0;
}

// The "value moment": once the user has accrued >= 5 context-file amendments,
// the next TTY-attached command prints message B. Shows once, ever.
function flushValueMoment(config) {
  if (!shouldPrompt(config)) return;
  withState(state => {
    if (state.feedback.valueShown) return;
    if (!(state.feedback.amendments >= 5)) return;
    const n = sessionCount(state);
    if (!n) return; // never print "0 sessions" — wait for a real count
    console.log(messageB(n));
    state.feedback.valueShown = true;
    util.saveState(state);
  });
}

module.exports = { shouldPrompt, maybeFirstRun, countAmendments, sessionCount, flushValueMoment, MESSAGE_A, messageB };
