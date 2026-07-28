'use strict';
// Classifies every read against the history of the project. The three tiers
// map directly to the three recoverable mechanisms measured in the corpus
// study: cross-session repeats need memory, same-session repeats need only a
// pointer, and first reads can only be helped by compression.
const path = require('path');
const { byTs } = require('./ledger');

// Whether `file` resolves to somewhere inside `projectPath`. Mirrors
// lib/ledger-fold.js's readKeyFor (and lib/hooks-recall.js's relFile) --
// project-membership is decided the same way everywhere it matters, this
// copy just returns a boolean instead of a relative key, since the
// classifier only needs to know whether to COUNT a read, not where to file
// it. projectPath is optional: callers with no project root in scope (the
// module's own tests using bare fixture paths) get the pre-existing
// behavior of counting every read, unfiltered.
function isInProject(projectPath, file) {
  if (!projectPath) return true;
  try {
    const r = path.relative(projectPath, file);
    return !!r && !r.startsWith('..') && !path.isAbsolute(r);
  } catch {
    return false;
  }
}

// FINDING 4: lib/ledger-fold.js's incremental fold drops out-of-project
// reads entirely (see its readKeyFor) so they never reach reads.first/
// sameSession/crossSession, but this batch classifier -- the oracle that
// fold is supposed to mirror -- used to count every read regardless of
// project membership. The two could only ever agree on fixtures where every
// read happened to be in-project; on real data (an agent reading another
// repo while working in this one) they'd diverge. Passing projectPath here
// applies the identical filter, so the oracle and the incremental fold
// cannot disagree on which reads even count.
function classifyReads(readEvents, editEvents, projectPath) {
  const events = readEvents
    .filter(e => e && e.kind === 'read' && e.file && isInProject(projectPath, e.file))
    .slice()
    .sort(byTs);
  // NOTE: reads with no session at all are treated as the SAME session (a
  // missing `e.session` groups with every other missing `e.session`, never
  // flips to 'cross-session'). In practice every read reaching this module
  // already has a session -- scan.js backfills it from the transcript
  // filename before events are emitted (see scanAll: `if (!ev.session)
  // ev.session = sessionId`) -- so this only matters for callers that bypass
  // that backfill. Deliberately NOT "fixed" to treat missing sessions as
  // unique-per-event: that would flip those reads to cross-session and
  // silently inflate the headline tier. Pinned by a guard test below.
  const seen = new Map();   // file -> Set of session ids that have read it
  const out = [];
  for (const e of events) {
    const readers = seen.get(e.file);
    let tier = 'first';
    if (readers && readers.size) {
      let otherSession = false;
      for (const s of readers) { if (s !== e.session) { otherSession = true; break; } }
      tier = otherSession ? 'cross-session' : 'same-session';
    }
    out.push(Object.assign({}, e, { tier }));
    if (!readers) seen.set(e.file, new Set([e.session]));
    else readers.add(e.session);
  }
  void editEvents;   // reserved: edit history drives the diff decision later
  return out;
}

function tally(classified) {
  const t = { first: 0, sameSession: 0, crossSession: 0 };
  for (const r of classified) {
    if (r.tier === 'first') t.first++;
    else if (r.tier === 'same-session') t.sameSession++;
    else t.crossSession++;
  }
  return t;
}

module.exports = { classifyReads, tally };
