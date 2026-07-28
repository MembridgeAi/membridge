'use strict';
// Classifies every read against the history of the project. The three tiers
// map directly to the three recoverable mechanisms measured in the corpus
// study: cross-session repeats need memory, same-session repeats need only a
// pointer, and first reads can only be helped by compression.

function classifyReads(readEvents, editEvents) {
  const events = readEvents
    .filter(e => e && e.kind === 'read' && e.file)
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
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
