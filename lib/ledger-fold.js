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
// with no session group together" rule it pins).
const ledger = require('./ledger');

// --- bounds ----------------------------------------------------------------
// ledger.json is rewritten on every dirty sync, so nothing stored here may
// grow without limit. Every list below is capped and documented.

// Request/read dedupe horizons, FIFO by insertion. The window that feeds this
// fold is itself bounded (2000 plumbing events, digest.DEFAULT_PLUMBING_EVENTS),
// so 5000 keys is always a MUCH deeper horizon than the window it has to
// cover: for an evicted key to be readmitted, its event would have to still be
// inside the window, but by the time the key is evicted it is at least 5000
// requests old -- far older than anything a 2000-event window can still hold.
// The bound therefore cannot cause double counting.
const SEEN_KEY_CAP = 5000;
const READ_KEY_CAP = 5000;
// Distinct session ids remembered. The COUNT is accumulated separately, so it
// never falls when an id ages out. (An id that ages out and then reappears is
// counted twice -- over-counting is the acceptable direction here, because the
// whole point of this module is that a total must never go backwards.)
const SESSION_ID_CAP = 2000;
// Reader sessions remembered per path, LRU by last read. Tiering only needs
// "has anyone else read this", so a small set per path suffices; a path read
// by more sessions than this reports the cap as its reader count.
const READERS_PER_PATH_CAP = 32;
// Paths tracked at all. Least-recently-read paths are dropped first. A dropped
// path's next read re-tiers as 'first', which slightly under-counts repeats --
// acceptable at this depth, and it is the only way to keep ledger.json bounded
// on a repo with an unbounded file count.
const FILE_READERS_CAP = 5000;
// Hot set surfaced to the API, by reads desc.
const HOT_PATH_CAP = 200;

const LIMITS = {
  SEEN_KEY_CAP, READ_KEY_CAP, SESSION_ID_CAP,
  READERS_PER_PATH_CAP, FILE_READERS_CAP, HOT_PATH_CAP,
};

const num = v => (Number.isFinite(v) ? v : 0);
const list = v => (Array.isArray(v) ? v.slice() : []);

// FIFO push: oldest keys leave first, so the horizon always covers the most
// recent `cap` insertions.
function pushBounded(arr, value, cap) {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// Coerce whatever is on disk -- null on first run, an older shape after an
// upgrade -- into the full accumulator, so a partial ledger.json lifts in
// place instead of throwing or resetting to zero.
function normalize(prev) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const reads = (p.reads && typeof p.reads === 'object') ? p.reads : {};
  const fileReaders = {};
  for (const [file, rec] of Object.entries(p.fileReaders || {})) {
    if (Array.isArray(rec)) fileReaders[file] = { sessions: rec.slice(), reads: rec.length, lastTs: '' };
    else if (rec && Array.isArray(rec.sessions)) {
      fileReaders[file] = { sessions: rec.sessions.slice(), reads: num(rec.reads), lastTs: String(rec.lastTs || '') };
    }
  }
  return {
    requests: num(p.requests),
    volume: num(p.volume),
    inCost: num(p.inCost),
    outCost: num(p.outCost),
    sessionsTotal: num(p.sessions),
    sessionIds: list(p.sessionIds),
    reads: {
      first: num(reads.first),
      sameSession: num(reads.sameSession),
      crossSession: num(reads.crossSession),
    },
    seenKeys: list(p.seenKeys),
    readKeys: list(p.readKeys),
    fileReaders,
  };
}

// Identity of one API request, matching the fold buildRequests already does.
// Kept here as well (rather than trusting mergeEvents' persistence-level
// dedupe alone) as defence in depth: this is the layer whose totals can never
// be corrected once written.
const requestKey = r => `${r.sidechain ? 1 : 0}|${r.session || ''}|${r.messageId || r.ts}`;

function foldRequests(st, events) {
  const seen = new Set(st.seenKeys);
  const fresh = [];
  for (const r of ledger.buildRequests(events)) {
    const key = requestKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    pushBounded(st.seenKeys, key, SEEN_KEY_CAP);
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
function tierFor(rec, sid) {
  if (!rec || !rec.sessions.length) return 'first';
  return rec.sessions.some(s => s !== sid) ? 'crossSession' : 'sameSession';
}

function foldReads(st, events) {
  const seen = new Set(st.readKeys);
  const reads = events.filter(e => e && e.kind === 'read' && e.file).slice().sort(ledger.byTs);
  for (const e of reads) {
    const sid = e.session || '';
    const key = `${sid}|${e.toolUseId || e.ts}|${e.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushBounded(st.readKeys, key, READ_KEY_CAP);

    const rec = st.fileReaders[e.file];
    st.reads[tierFor(rec, sid)]++;
    if (!rec) {
      st.fileReaders[e.file] = { sessions: [sid], reads: 1, lastTs: String(e.ts || '') };
      continue;
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
// window. Returns the new ledger -- prev is never mutated.
function foldProjectLedger(prev, events) {
  const st = normalize(prev);
  const evs = Array.isArray(events) ? events : [];
  foldRequests(st, evs);
  foldReads(st, evs);
  return {
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
    // Accumulation evidence. Internal to the store -- lib/server.js projects
    // an explicit whitelist onto /api/savings and never these.
    seenKeys: st.seenKeys,
    readKeys: st.readKeys,
    sessionIds: st.sessionIds,
    fileReaders: st.fileReaders,
  };
}

module.exports = { foldProjectLedger, LIMITS };
