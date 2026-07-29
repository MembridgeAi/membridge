'use strict';
// Durable accumulation for the per-project token ledger.
//
// state.projects[key].events is a SLIDING window -- lib/digest.js caps it, and
// the plumbing budget is a couple of thousand events. Rebuilding the ledger
// from that window every pass therefore reports a shrinking slice of history
// (measured: ~6.6% of the real total), and volume can go DOWN after more work,
// which is worse than no number at all. So each pass folds only the requests
// and reads it has NOT already counted into the previously persisted totals,
// carrying bounded evidence of what has been counted.
//
// The batch classifier in lib/redundancy.js stays the oracle for read tiering;
// the incremental classifier here mirrors it exactly (including the "reads
// with no session group together" rule it pins). Bounds, schema versioning
// and on-disk-shape normalization live in ledger-fold-state.js.
//
// MONOTONICITY, updated (fix round 2, revisable settlement): every total
// here only ever goes UP -- requests, volume, cost, sessions, reads, and
// avoided.serves/tierA/tierB -- with ONE deliberate exception: avoided.tokens
// (and the partialWins/netNegatives buckets it moves between) may now go
// DOWN too. Not a regression: requests/volume/reads describe events already
// fully observed, so there is nothing left to learn -- but a recall serve is
// settled OPTIMISTICALLY, before all its evidence exists (see
// lib/ledger-fold-recall-settle.js's header). A later correction is NEW
// information about an event already counted once, not a re-count of it --
// see lib/ledger-fold-recall-open-serves.js for that pass.
const path = require('path');
const ledger = require('./ledger');
const {
  LEDGER_VERSION, LIMITS, keyHorizonFor, pushBounded, normalize,
} = require('./ledger-fold-state');

const { SESSION_ID_CAP, READERS_PER_PATH_CAP, FILE_READERS_CAP, HOT_PATH_CAP } = LIMITS;

// Identity of one API request, matching the fold buildRequests already does.
// Kept here as well (rather than trusting mergeEvents' persistence-level
// dedupe alone) as defence in depth: this is the layer whose totals can never
// be corrected once written.
const requestKey = r => `${r.sidechain ? 1 : 0}|${r.session || ''}|${r.messageId || r.ts}`;

function foldRequests(st, events, keyCap) {
  const seen = new Set(st.seenKeys);
  const fresh = [];
  for (const r of ledger.buildRequests(events)) {
    const key = requestKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    pushBounded(st.seenKeys, key, keyCap);
    fresh.push(r);
  }
  const vol = ledger.sessionVolume(fresh);
  st.requests += vol.nRequests;
  st.volume += vol.volume;
  st.inCost += vol.inCost;
  st.outCost += vol.outCost;

  const known = new Set(st.sessionIds);
  for (const r of fresh) {
    const sid = r.session || '';
    if (known.has(sid)) continue;
    known.add(sid);
    pushBounded(st.sessionIds, sid, SESSION_ID_CAP);
    st.sessionsTotal++;
  }
}

// One read's tier against everything the project has ever seen. Same three
// tiers as redundancy.classifyReads, decided against the accumulated reader
// sets rather than against a single batch.
function tierFor(rec, sid, ts) {
  if (!rec || !rec.sessions.length) return 'first';
  // Ordering guard: incremental tiering processes reads pass-by-pass, and a
  // path's reads can arrive across passes with inverted timestamps (e.g. an
  // earlier read is folded in a LATER pass than a later read from a
  // different session). Without this check, that read would be compared
  // against a reader set that already contains a session it never actually
  // preceded, inflating crossSession (measured: {first 1, same 0, cross 2}
  // against an oracle of {first 1, same 1, cross 1} for the same events --
  // see the ordering-guard test in test/run-tests.js for the exact
  // scenario). So a read whose ts precedes the path's recorded firstTs is
  // tiered 'first' and becomes the new firstTs/firstSession, matching what a
  // batch re-sort would find for THAT read.
  //
  // This does not fully recover the oracle: once reclassified, that
  // session's own already-recorded LATER read can still misclassify as
  // crossSession instead of sameSession, because another session is already
  // in the readers set by the time this one is processed. The residual is
  // bounded (crossSession never exceeds what a true batch classification
  // would find) and it never self-corrects -- it just stops getting worse
  // with more out-of-order passes. See the differential test that ties this
  // incremental classifier to redundancy.classifyReads, and the
  // ordering-guard test for the exact improved-but-imperfect numbers.
  if (ledger.byTs({ ts }, { ts: rec.firstTs }) < 0) return 'first';
  return rec.sessions.some(s => s !== sid) ? 'crossSession' : 'sameSession';
}

const toPosix = p => p.split(path.sep).join('/');

// Repo-relative identity for one read, mirroring lib/memorydb.js's relFile and
// the PreToolUse hook's own copy (lib/hooks-recall.js). THE key-shape contract
// of this module: read EVENTS carry whatever the adapter saw (an absolute path,
// from lib/adapters/claude-code.js), but the per-project ledger this fold
// writes is keyed repo-relative, because that is what every consumer looks up
// -- lib/recall.js tiers on ledger.fileReaders[relPath], and
// lib/recall-store.js's warm() joins projectPath onto hotPaths[].file. A file
// outside the project (an agent reading another repo while working in this
// one) has no relative identity here and is dropped, not stored under a
// foreign absolute path. A path that is not absolute cannot be placed either,
// so it is dropped the same way.
//
// projectPath is optional: a one-shot buildProjectLedger with no project root
// in scope (tests, ad-hoc analysis) keeps the verbatim keys, since nothing
// persists that result per project. Every PERSISTED ledger goes through
// ledger-store.updateLedger, which always supplies it.
function readKeyFor(projectPath, file) {
  if (!projectPath) return file;
  try {
    const r = path.relative(projectPath, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return toPosix(r);
  } catch {}
  return null;
}

// Merge a recall-queue settlement (lib/ledger-fold-recall.js's impure read
// of .membridge/recall/events.jsonl, already reduced to plain deltas plus
// the next openServes list) into the running accumulator. Kept as pure
// arithmetic here -- the same "table-testable with plain object literals"
// contract the rest of this module holds -- so all the fs/estimator work
// stays on the caller's side of the boundary (see ledger-fold-recall.js's
// own header). `settlement` is optional: a one-shot buildProjectLedger call
// with no recall queue to fold (most callers, including every existing
// test) passes nothing and this is a no-op, exactly like readKeyFor's
// projectPath-less mode above.
//
// avoidedDelta[k] may be NEGATIVE (a correction revising a serve down --
// see this file's header); every other delta merged here is additive-only.
// openServes is a full REPLACEMENT, not a delta: the caller already applied
// this pass's new serves, corrections, and bounds before handing it back.
function foldRecallSettlement(st, settlement) {
  if (!settlement) return;
  const { avoidedDelta, holdoutDelta, openServes } = settlement;
  if (avoidedDelta) {
    for (const k of Object.keys(st.avoided)) st.avoided[k] += avoidedDelta[k] || 0;
  }
  if (holdoutDelta) {
    for (const k of Object.keys(st.holdout)) st.holdout[k] += holdoutDelta[k] || 0;
  }
  if (Array.isArray(openServes)) st.openServes = openServes;
}

function foldReads(st, events, keyCap, projectPath) {
  const seen = new Set(st.readKeys);
  const reads = events.filter(e => e && e.kind === 'read' && e.file).slice().sort(ledger.byTs);
  for (const e of reads) {
    const file = readKeyFor(projectPath, e.file);
    if (!file) continue; // outside the project: not this ledger's business
    const sid = e.session || '';
    // The dedupe key stays on the event's own verbatim path: it identifies an
    // EVENT, not a ledger row, and must not change shape when the ledger's
    // key shape does.
    const key = `${sid}|${e.toolUseId || e.ts}|${e.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushBounded(st.readKeys, key, keyCap);

    const rec = st.fileReaders[file];
    const tier = tierFor(rec, sid, e.ts);
    st.reads[tier]++;
    if (!rec) {
      st.fileReaders[file] = {
        sessions: [sid], reads: 1, lastTs: String(e.ts || ''),
        firstTs: String(e.ts || ''), firstSession: sid,
      };
      continue;
    }
    if (tier === 'first') {
      // This read's ts precedes what the path had on record -- move the
      // first-read marker back to match (see tierFor's comment for the
      // residual this does and doesn't fix).
      rec.firstTs = String(e.ts || rec.firstTs);
      rec.firstSession = sid;
    }
    // Move-to-end keeps the most recently ACTIVE sessions when the per-path
    // cap bites, which is what tiering cares about.
    const at = rec.sessions.indexOf(sid);
    if (at !== -1) rec.sessions.splice(at, 1);
    rec.sessions.push(sid);
    if (rec.sessions.length > READERS_PER_PATH_CAP) {
      rec.sessions.splice(0, rec.sessions.length - READERS_PER_PATH_CAP);
    }
    rec.reads++;
    rec.lastTs = String(e.ts || rec.lastTs);
  }

  const files = Object.keys(st.fileReaders);
  if (files.length > FILE_READERS_CAP) {
    files.sort((a, b) => String(st.fileReaders[a].lastTs).localeCompare(String(st.fileReaders[b].lastTs)));
    for (const f of files.slice(0, files.length - FILE_READERS_CAP)) delete st.fileReaders[f];
  }
}

// Hot set: paths more than one session has read. These are exactly the paths a
// recall layer could serve, so they drive pre-warming later.
function hotPathsOf(fileReaders) {
  const out = [];
  for (const [file, rec] of Object.entries(fileReaders)) {
    if (rec.sessions.length > 1) out.push({ file, readers: rec.sessions.length, reads: rec.reads });
  }
  out.sort((a, b) => b.reads - a.reads);
  return out.slice(0, HOT_PATH_CAP);
}

// prev is the last persisted ledger (or null); events is the current sliding
// window; plumbingCap is the effective config.maxPlumbingEvents for this
// project (undefined falls back to the default -- see keyHorizonFor in
// ledger-fold-state.js); projectPath is the project root the ledger belongs
// to, used to key reads repo-relative (see readKeyFor -- omit it only for a
// one-shot fold that is never persisted per project). `settlement` is the
// already-computed recall-queue delta (lib/ledger-fold-recall.js), or
// omitted entirely for a fold with nothing to settle -- see
// foldRecallSettlement above. Returns the new ledger -- prev is never
// mutated.
function foldProjectLedger(prev, events, plumbingCap, projectPath, settlement) {
  const st = normalize(prev);
  const evs = Array.isArray(events) ? events : [];
  const keyCap = keyHorizonFor(plumbingCap);
  foldRequests(st, evs, keyCap);
  foldReads(st, evs, keyCap, projectPath);
  foldRecallSettlement(st, settlement);
  return {
    version: LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    // `sessions` IS the cumulative distinct-session total; it is derived from
    // the counter, not from sessionIds.length, so it cannot fall when ids age
    // out of that bounded list.
    sessions: st.sessionsTotal,
    requests: st.requests,
    volume: st.volume,
    inCost: st.inCost,
    outCost: st.outCost,
    reads: st.reads,
    hotPaths: hotPathsOf(st.fileReaders),
    // Direct avoidance / holdout (spec §7.1/§7.2, Task 6) -- cumulative,
    // settled totals. lib/server.js's /api/savings projects both onto the
    // wire as-is (tokens only, no cost fields -- spec §8.2).
    avoided: st.avoided,
    holdout: st.holdout,
    // Accumulation evidence. Internal to the store -- lib/server.js projects
    // an explicit whitelist onto /api/savings and never these.
    seenKeys: st.seenKeys,
    readKeys: st.readKeys,
    sessionIds: st.sessionIds,
    fileReaders: st.fileReaders,
    // Open-serve receipts for revisable settlement (fix round 2, Task 6) --
    // also internal bookkeeping, never projected onto /api/savings.
    openServes: st.openServes,
  };
}

module.exports = {
  foldProjectLedger, LIMITS, LEDGER_VERSION, keyHorizonFor,
  // Exported for lib/ledger-fold-recall.js: settlement needs to relativize a
  // follow-up read's absolute `file` the exact same way this fold keys
  // fileReaders, or a follow-up would never match the serve it settles
  // against (see readKeyFor's own header comment on why this identity must
  // be shared, not re-derived).
  readKeyFor,
};
