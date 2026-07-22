'use strict';
// Shareability: a session appears in MemBridge only if it did real project
// work. The signal is edits — a session that changed files is work; a session
// that changed nothing (browser automation, ad generation, Q&A, tool-wrangling)
// is operations and never reaches the feed, the CLAUDE.md block, or the team
// push. The rule is enforced on the emitting machine, so a teammate never
// receives a zero-edit session and no inbound filter is needed.
//
// Edits are the signal ONLY for tools that report them. Some adapters (Codex,
// and custom stores) never emit edit events, so their sessions can't be judged
// by edits at all — they are always shown. A source counts as "edit-capturing"
// once it has emitted at least one edit event in this project, which makes the
// rule self-calibrating and adapter-agnostic: Claude Code (which reports edits)
// gets its zero-edit sessions suppressed; Codex (which never does) does not.
//
// Pure functions over event arrays; every function fails open toward
// "shareable" on malformed input and never throws.

// The set of session ids worth sharing, computed once over a project's full
// event history (the history is needed to know which sources report edits).
function shareableSessions(events) {
  const set = new Set();
  if (!Array.isArray(events)) return set;
  const editCapturing = new Set();       // sources that have emitted >=1 edit
  const hasEdit = new Set();             // sessions with >=1 edit event
  const bySessionSources = new Map();    // session -> Set of its sources
  for (const e of events) {
    if (!e) continue;
    const s = e.session || '';
    if (e.kind === 'edit') { editCapturing.add(e.source); hasEdit.add(s); }
    let sources = bySessionSources.get(s);
    if (!sources) bySessionSources.set(s, (sources = new Set()));
    sources.add(e.source);
  }
  for (const [session, sources] of bySessionSources) {
    // Shareable if the session made an edit, OR it involves a source that never
    // reports edits (so edits can't be its yardstick).
    if (hasEdit.has(session) || [...sources].some(src => !editCapturing.has(src))) {
      set.add(session);
    }
  }
  return set;
}

function isShareableLocal(events, sessionId) {
  return shareableSessions(events).has(sessionId || '');
}

function filterShareableEntries(entries, events) {
  if (!Array.isArray(entries)) return [];
  const set = shareableSessions(events);
  return entries.filter(e => set.has((e && e.session) || ''));
}

module.exports = { shareableSessions, isShareableLocal, filterShareableEntries };
