'use strict';
// SessionStart / PostCompact hook bodies for teammate notes: read the
// per-project index built on each team pull (.membridge/teammate-notes.json)
// and hand the agent the teammate decisions it has not been told yet.
//
// PLACEHOLDERS. Task 7 registers these entry points in settings.json so the
// registration is testable on its own; Task 9 fills in the bodies. Until then
// each is a deliberate no-op: exit 0 with nothing on stdout, which Claude Code
// reads as "inject nothing, carry on".
//
// Whatever lands here must keep lib/hooks-recall.js's fail-open contract: the
// whole body wrapped so any exception degrades to ordinary agent behaviour,
// and injection only ever via hookSpecificOutput.additionalContext — this
// feature never denies a tool call and never blocks a session.
function runSessionStart() {}
function runPostCompact() {}

module.exports = { runSessionStart, runPostCompact };
