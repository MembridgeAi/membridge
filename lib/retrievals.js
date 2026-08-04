'use strict';
// Which memories actually get USED. Every demand-driven serve of a memory
// entry — a search_memory result (MCP tool and dashboard /api/search alike,
// both route through lib/activity.js searchMemory) or a `why` provenance row —
// appends the served entries' event keys here. Broadcast surfaces
// (get_project_memory, get_recent_activity, the injected CLAUDE.md block)
// deliberately do NOT record: they return history wholesale whether or not
// anyone wanted a specific entry, so counting them would drown the demand
// signal this file exists to capture.
//
// Why this exists: MemBridge stores and injects memory but has never known
// whether any given entry was ever recalled. Retrieval counts are the
// missing signal for everything downstream — proving value ("this decision
// was recalled 14 times"), future decay (an entry never retrieved in 90 days
// is a pruning candidate), and future ranking (usage as a relevance prior).
// Counts are shown on each search result as `retrievals` so an agent can see
// which memories the team actually leans on.
//
// Storage is an append-only JSONL under the membridge home — NEVER
// state.json. Two long-lived processes serve searches concurrently (the MCP
// stdio server and the daemon), and state.json has no cross-process locking:
// a read-modify-write of it from here would clobber concurrent daemon saves.
// O_APPEND of one small line per serve has no such window. This is the same
// posture as lib/mcp-usage.js, the one precedent for the MCP process writing
// anything: a best-effort side file that is not memory, where a write
// failure must never surface into a tool response.
//
// This is a usage SIGNAL, not a ledger. The recall lane's events.jsonl +
// ledger fold (lib/ledger*.js) stay the source of truth for anything billed
// or claimed as savings; nothing here feeds those totals. Losing an
// occasional increment (e.g. across the compaction window below) is
// acceptable and documented; inventing one is not.
//
// SHAPE, and why it is write-time-or-never. A line is
// { ts, tool, keys, q?, project?, total?, files? }. Counts alone answer "how
// often was this recalled" and can never answer "recalled FOR WHAT" — and the
// asking half of a serve is the one part of it no later pass can reconstruct.
// The keys, their rank order and the entries themselves all survive on disk;
// the query the caller actually typed exists only for the duration of the
// call. So it is written here or it is lost, which is why this file records
// more than the counter strictly needs: the ranking work downstream — an eval
// harness that replays REAL queries instead of invented ones, and file-graph
// ranking that needs to know which files a serve was about — cannot be
// backfilled from a corpus of counts, however long that corpus runs.
//
// `keys` is stored in SERVED RANK ORDER, so a key's position IS its index and
// no separate rank field is needed. That order is load-bearing for evaluation
// (a hit at 1 and a hit at 20 are not the same event), so nothing may sort it.
//
// `q` is raw user input, and is redacted at THIS boundary rather than by the
// caller — the same defense-in-depth rule the entry text follows. A pasted
// secret must not come to rest here just because someone searched for it.
//
// Older lines predate q/project/total/files and simply lack them. Nothing
// here backfills or infers those fields: readCounts reads only `keys`, so old
// lines keep counting exactly as before, and the eval lane treats a line with
// no `q` as what it is — an unlabelled serve, not a serve of the empty query.
//
// Compaction below folds the log into counts and DROPS the queries with it,
// so the raw log IS the eval corpus and its retention is the window before a
// fold — months at the threshold set here. readServes() is the read side.
const fs = require('fs');
const path = require('path');
const util = require('./util');
// For redactText only. No cycle: digest reaches util/ledger/redact/classify,
// never activity.js or this file, and both callers already have it loaded.
const digest = require('./digest');

// Compaction threshold. Carrying the query and files put a line at ~200-400
// bytes rather than the ~120-200 it was; heavy use (100 searches a day
// serving 20 results each) is ~60KB/day, so 4MB is still months of headroom.
// The threshold stays where it was because it now buys HALF the eval history
// it used to — the fold is what discards queries, so this number is the
// retention window for everything downstream of `q`, not just a disk bound.
// When the log crosses it, record() folds log+base into retrievals-base.json
// and truncates the log. The fold is atomic (tmp+rename) and the log is only
// truncated AFTER the base write succeeded — a failed fold leaves everything
// as it was. A line appended by the OTHER process between the fold's read
// and the truncate is lost; that window is a few ms once every few months,
// and this file's contract (above) explicitly trades it for never blocking
// or corrupting a read path.
const COMPACT_BYTES = 4 * 1024 * 1024;

function logPath() { return path.join(util.homeDir(), 'retrievals.jsonl'); }
function basePath() { return path.join(util.homeDir(), 'retrievals-base.json'); }

function enabled(config) {
  if (process.env.MEMBRIDGE_NO_RETRIEVALS === '1') return false;
  const c = config || util.getConfig();
  return !(c && c.trackRetrievals === false);
}

// Fold base + log into one { key: { n, last } } map. Corrupt or torn lines
// are skipped, not fatal: a half-written tail line (process killed mid-append)
// must not take every earlier count with it.
function readCounts() {
  const counts = {};
  try {
    const base = JSON.parse(fs.readFileSync(basePath(), 'utf8'));
    for (const [key, v] of Object.entries(base || {})) {
      if (v && Number.isFinite(v.n)) counts[key] = { n: v.n, last: v.last || null };
    }
  } catch { /* no base yet */ }
  let raw;
  try { raw = fs.readFileSync(logPath(), 'utf8'); } catch { return counts; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !Array.isArray(rec.keys)) continue;
    for (const key of rec.keys) {
      const prev = counts[key];
      if (prev) {
        prev.n += 1;
        if (!prev.last || String(rec.ts || '') > String(prev.last)) prev.last = rec.ts || prev.last;
      } else {
        counts[key] = { n: 1, last: rec.ts || null };
      }
    }
  }
  return counts;
}

// The raw serves, newest last, exactly as recorded — the read side of the
// shape above and the input the eval lane replays. Deliberately NOT folded:
// folding is what readCounts does, and it is precisely the fold that throws
// away the query and the rank order this returns. Same tolerance for a torn
// tail line, for the same reason (a process killed mid-append must not take
// the healthy history with it), and the same silence when there is no log.
//
// Not memoized. Callers are batch (an eval run, a graph build), not the hot
// search path, and memoizing a list this large to serve one caller per
// process would cost more memory than it saves.
function readServes() {
  let raw;
  try { raw = fs.readFileSync(logPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !Array.isArray(rec.keys)) continue;
    out.push(rec);
  }
  return out;
}

// Per-process memo of the folded counts, keyed on both files' stat identity —
// same shape of trick as lib/activity.js's archive cache. searchMemory calls
// countsFor on every search; re-parsing an unchanged log each time is pure
// waste, and any append (this process or the other one) moves mtimeMs/size.
let memo = null; // { logStat, baseStat, counts }
function statOf(p) {
  try { const s = fs.statSync(p); return `${s.mtimeMs}|${s.size}`; } catch { return 'absent'; }
}
function cachedCounts() {
  const logStat = statOf(logPath());
  const baseStat = statOf(basePath());
  if (memo && memo.logStat === logStat && memo.baseStat === baseStat) return memo.counts;
  const counts = readCounts();
  memo = { logStat, baseStat, counts };
  return counts;
}

// { key: { n, last } } for just the asked-for keys; a never-retrieved key is
// simply absent. Read side of the annotation searchMemory puts on results.
function countsFor(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return {};
  const all = cachedCounts();
  const out = {};
  for (const key of keys) {
    if (all[key]) out[key] = all[key];
  }
  return out;
}

// Append one serve. Best-effort by contract: every failure path returns
// silently, because a tracking failure must never turn into a search failure
// (house rule, same as mcp-usage.js). No success flag is written anywhere —
// the appended line IS the record, so there is nothing here that can claim
// work that did not happen.
function record(tool, keys, opts = {}) {
  try {
    if (!Array.isArray(keys) || keys.length === 0) return;
    if (!enabled(opts.config)) return;
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const rec = {
      ts: new Date(opts.now || Date.now()).toISOString(),
      tool,
      keys,
    };
    // Every field below is OPTIONAL and omitted when absent, so a caller that
    // knows less writes a shorter line rather than one padded with nulls that
    // a reader would have to tell apart from a real value.
    //
    // redactText with no compiled patterns still applies the DEFAULT set, so
    // a caller that forgets to pass regexes gets less redaction, never none.
    if (opts.query != null && String(opts.query) !== '') {
      rec.q = digest.redactText(String(opts.query), opts.regexes);
    }
    if (opts.project) rec.project = String(opts.project);
    // The size of the pool the serve was drawn from. Served-vs-ranked is the
    // difference between "the only 3 matches there were" and "3 of 400", and
    // recall@k means nothing without it.
    if (Number.isFinite(opts.total)) rec.total = opts.total;
    if (Array.isArray(opts.files) && opts.files.length) rec.files = opts.files.map(String);
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(p, line, { mode: 0o600 });
    memo = null; // our own append invalidates the fold memo
    maybeCompact(p);
  } catch { /* never break a serve over usage tracking */ }
}

// Fold the oversized log into the base file, then truncate the log. Base is
// written atomically (pid-suffixed tmp + rename, the team-archive/mcp-usage
// pattern) and the truncate only happens after the rename landed. A crash
// before the rename changes nothing. A crash between the rename and the
// truncate double-counts that log window on the NEXT fold — accepted over
// the alternative (truncate first), which would lose the window entirely on
// a failed base write; both failures need a disk that just took a rename to
// then refuse a same-directory write.
function maybeCompact(p) {
  let size;
  try { size = fs.statSync(p).size; } catch { return; }
  if (size < COMPACT_BYTES) return;
  const folded = readCounts();
  const bp = basePath();
  const tmp = `${bp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(folded), { mode: 0o600 });
  fs.renameSync(tmp, bp);
  fs.writeFileSync(p, '', { mode: 0o600 });
  memo = null;
}

module.exports = {
  record, countsFor, readCounts, readServes, logPath, basePath,
  // Exported for tests: exercise compaction without writing 4MB of fixtures.
  maybeCompact, COMPACT_BYTES,
};
