'use strict';
// Commit↔session attribution (provenance Phase 2, Task 1). Pure: given the
// files a commit touched, the commit's timestamp, and the project's event
// stream, decide which session owns each file. The rule is simple on
// purpose — the session of the MOST RECENT edit at or before the commit
// time owns the file; an edit dated after the commit cannot have produced
// it. File granularity only, same as lib/provenance.js: no line-level
// blame, no churn. No git in this module either — reading commits is the
// next task; this is the attribution rule alone, so it stays testable with
// plain fixtures (changes.js draws the same line around deriveChanges).
const fs = require('fs');
const path = require('path');
const provenance = require('./provenance');
const memorydb = require('./memorydb');
const { parseNumstat, defaultRunGit } = require('./changes');

// The sessions that own `changedFiles` as of `commitTs`.
//   changedFiles  repo-relative paths as git reports them (absolute and
//                 ./-prefixed spellings are normalized too)
//   commitTs      ISO string or epoch ms
//   events        the project's event stream; only kind 'edit' rows with a
//                 file and a parseable ts participate
//   opts.projectPath  the root that absolute paths (event files are usually
//                 absolute) normalize against; without it an absolute path
//                 cannot be matched and falls through as unattributed
// Returns { sessions: [{ session, files }], unattributed: [] } — sessions
// newest-owning first (by their latest winning edit), files in input order,
// spelled repo-relative. A file whose winning edit carries no session id is
// unattributed too: with nobody to credit, that IS unattributed.
function attributeCommit(changedFiles, commitTs, events, opts = {}) {
  const projectPath = (opts && opts.projectPath) || null;
  const cutoff = typeof commitTs === 'number' ? commitTs : Date.parse(commitTs);
  const norm = f => {
    const s = String(f || '');
    if (!s) return null;
    if (path.isAbsolute(s) && !projectPath) return null;
    return provenance.normalizeRel(projectPath || '', s);
  };

  // Normalize the commit's files up front; anything unnormalizable (empty,
  // absolute with no root, escaping the project) can never match an edit,
  // so it is unattributed as given.
  const targets = [];
  const unattributed = [];
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    const rel = norm(f);
    if (rel) targets.push(rel);
    else unattributed.push(String(f));
  }

  // Latest qualifying edit per file, one pass over the stream. Equal
  // timestamps: the later event wins (streams are time-sorted, so that is
  // the later write).
  const winner = new Map(); // rel -> { session, t }
  if (Number.isFinite(cutoff) && Array.isArray(events)) {
    const relevant = new Set(targets);
    for (const ev of events) {
      if (!ev || ev.kind !== 'edit' || !ev.file) continue;
      const t = Date.parse(ev.ts);
      if (!Number.isFinite(t) || t > cutoff) continue;
      const rel = norm(ev.file);
      if (!rel || !relevant.has(rel)) continue;
      const prev = winner.get(rel);
      if (!prev || t >= prev.t) winner.set(rel, { session: ev.session || '', t });
    }
  }

  const bySession = new Map(); // session -> { session, files, lastT }
  for (const rel of targets) {
    const w = winner.get(rel);
    if (!w || !w.session) {
      unattributed.push(rel);
      continue;
    }
    let g = bySession.get(w.session);
    if (!g) bySession.set(w.session, (g = { session: w.session, files: [], lastT: 0 }));
    g.files.push(rel);
    if (w.t > g.lastT) g.lastT = w.t;
  }
  const sessions = [...bySession.values()]
    .sort((a, b) => b.lastT - a.lastT)
    .map(({ session, files }) => ({ session, files }));
  return { sessions, unattributed };
}

// ---------------------------------------------------------------------------
// Git readers (Phase 2, Task 2). Same conventions as lib/changes.js: an
// injectable runGit (deps.runGit) defaulting to execFileSync in the project
// root, and every call best-effort — any git failure degrades to an empty
// result, it NEVER throws into a caller. Reading only: nothing here writes a
// store or wires into scan (Task 3).
// ---------------------------------------------------------------------------

// One commit's committer time and changed files.
//   The format line is `%cI|%P` — committer date plus the parent list — and
//   parseNumstat ignores it (no tabs), so one parser serves both modules.
//   Merge detection is EXPLICIT: modern git (>= 2.31) prints first-parent
//   numstat rows for merges (verified against this very repo), so "no rows"
//   cannot be relied on — two or more parents force files: [] per the
//   contract, no matter what git printed. --no-show-signature keeps a user's
//   log.showSignature=true from prepending signature text to stdout (which
//   would become a garbage ts). On git failure ts is null — unknowable, not
//   fabricated.
function readCommit(projectPath, sha, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    // Format `%cI|%ce|%P` — committer date, committer EMAIL, parent list. The
    // email drives the authorship gate (isLocalCommitter); parseNumstat still
    // ignores this line (no tabs). Emails contain no '|', so a plain split is
    // unambiguous even when the parent list is present.
    const out = String(runGit(['show', '--numstat', '--format=%cI|%ce|%P', '--no-color', '--no-show-signature', sha, '--']));
    const head = (out.split('\n').find(l => l.trim()) || '').trim();
    const parts = head.split('|');
    const ts = (parts[0] || '').trim() || null;
    const email = (parts[1] || '').trim() || null;
    const parents = (parts.slice(2).join('|')).trim().split(/\s+/).filter(Boolean);
    if (parents.length >= 2) return { sha, ts, email, files: [] };
    return { sha, ts, email, files: [...parseNumstat(out).keys()] };
  } catch {
    return { sha, ts: null, email: null, files: [] };
  }
}

// The local git identity for `projectPath` — `git config user.email`, trimmed,
// or null (unset config, git failure). The authorship gate compares a commit's
// committer email against this: a null here means "no local identity", which
// fails the gate closed (nothing is attributed) rather than crediting blindly.
function gitUserEmail(projectPath, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    return String(runGit(['config', 'user.email'])).trim() || null;
  } catch {
    return null;
  }
}

// Authorship gate: is a commit with `committerEmail` locally authored, given
// this machine's `localEmail`? Fail closed — a missing local identity, a
// missing committer email, or any mismatch is NOT local, so a pulled teammate
// commit is never falsely credited to a local session.
function isLocalCommitter(committerEmail, localEmail) {
  const a = String(committerEmail || '').trim();
  const b = String(localEmail || '').trim();
  if (!a || !b) return false;
  return a === b;
}

// Commit shas on HEAD after `sinceSha`, oldest-first, merges excluded.
// A missing, unknown, or non-ancestor cursor (checked with merge-base
// --is-ancestor, which exits non-zero and throws) falls back to a BOUNDED
// first run: the newest 50 commits, never the whole history. git log prints
// newest-first; the reversal happens here in JS rather than via --reverse,
// whose interaction with -n limiting is easy to misread. Total git failure
// returns [].
function newCommitsSince(projectPath, sinceSha, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  const shas = out => String(out).split('\n').map(l => l.trim()).filter(Boolean);
  if (sinceSha) {
    try {
      runGit(['merge-base', '--is-ancestor', sinceSha, 'HEAD']);
      return shas(runGit(['log', '--no-merges', '--format=%H', `${sinceSha}..HEAD`])).reverse();
    } catch { /* unknown / non-ancestor cursor or git failure: bounded first run below */ }
  }
  try {
    return shas(runGit(['log', '--no-merges', '-n', '50', '--format=%H'])).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The commit->session map (Phase 2, Task 3): <project>/.membridge/
// commits.jsonl, one JSON line per commit, append-only. MemBridge owns this
// file — it both writes (sync backfill, post-commit hook) and reads it (the
// provenance surfaces). Append-only means the newest record is the last
// line, which is what lastRecordedSha leans on.
// ---------------------------------------------------------------------------
const COMMITS_FILE = 'commits.jsonl';
const commitMapPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, COMMITS_FILE);

// record = { sha, ts, project, sessions: [{ session, files }], unattributed,
// provisional }. `provisional` is new (provenance reconciliation): true means
// "recorded but not yet attributed — the daemon has not settled this sha
// against fresh events"; absent/falsy means settled, which is what every row
// ever written before this feature already looked like, so old rows keep
// meaning exactly what they always meant with zero migration. mkdir+append;
// callers wrap (sync and the hook both run best-effort). A
// torn tail (crash or ENOSPC mid-append leaves a partial line with no
// trailing newline) must not glue with this record into one unparseable
// line — that would lose BOTH records and, worse, let the sync cursor
// advance past a commit that was never durably recorded. Land on a fresh
// line whenever the file's last byte is not \n.
function recordCommit(projectPath, record) {
  const file = commitMapPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Single O_APPEND fd ('a+' so the torn-tail probe can still read): on POSIX
  // one write() to an O_APPEND file lands at EOF atomically, so the daemon
  // backfill and the post-commit hook can append concurrently without
  // interleaving or clobbering each other's row. The whole record + newline
  // goes out in ONE writeSync — never split across two appends.
  const fd = fs.openSync(file, 'a+');
  try {
    let sep = '';
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      // pread at an explicit position — independent of the append offset.
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) sep = '\n'; // land past a crash-torn partial line
    }
    fs.writeSync(fd, sep + JSON.stringify(record) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

// Every syntactically valid record in the file, in on-disk order, no
// dedupe — one JSON.parse per line, garbage lines skipped. Shared by
// loadCommitMap (which dedupes on top of this) and lastRecordedSha's rare
// full-parse fallback, which needs the PHYSICALLY last write, not
// dedup-by-sha order (see note there).
function parseRawRecords(raw) {
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && r.sha) records.push(r);
    } catch { /* garbage line: skip */ }
  }
  return records;
}

// Is `record` provisional (recorded, but not yet attributed by a settle
// pass)? Absent/falsy `provisional` — every row written before provenance
// reconciliation, and every row the daemon writes for a commit it discovers
// and attributes itself — means settled. A tiny helper so callers (scan.js's
// settle step, provenance.js's line-level fallback) never need to know the
// field's raw shape.
function isProvisionalCommit(record) {
  return !!(record && record.provisional);
}

// A record's dedupe rank for the same sha — LOWER wins. Three tiers:
//   0. settled + a real (non-empty) session list — the most informative row
//      there is.
//   1. settled + empty — "foreign committer" or "daemon settled and truly
//      nobody owns these files"; still authoritative, just uninformative.
//   2. provisional — NOT YET SETTLED, so it can never outrank a settled row
//      of either kind, even a settled-empty one, and even if some future
//      writer ever put real sessions on a provisional row (today's writers
//      never do: the post-commit hook only ever writes provisional rows with
//      sessions: [], see lib/hooks.js). Provisional information is, by
//      definition, not yet trustworthy.
// This is the one invariant the whole reconciliation feature leans on: a
// provisional row can NEVER win over a settled one, in either write order.
function commitRank(record) {
  if (isProvisionalCommit(record)) return 2;
  return Array.isArray(record.sessions) && record.sessions.length > 0 ? 0 : 1;
}

// All recorded commits, oldest-first, ONE ROW PER SHA. Missing file -> [];
// a garbage line (interrupted write, hand edit) is skipped, never thrown on.
//
// Dedupe-by-sha (Task 3, extended by provenance reconciliation): the hook and
// the daemon backfill/settle both append-only write this file, and both gate
// on "is this sha already recorded" before writing a NEW row (see
// recordCommit callers in lib/hooks.js / lib/scan.js) — a race between them
// (or an authorship-gate answer that flips between the two writes because
// `git config user.email` changed in between) can still land two rows for
// the same sha. Reads must present exactly one. Precedence, deliberately
// chosen over "first row wins" (which is what a naive scan would do by
// accident, and what lib/provenance.js's old `.find()` happened to do before
// this was a decided rule) — see commitRank above for the full ranking:
//   1. settled-real > settled-empty > provisional, full stop — a provisional
//      row NEVER wins over a settled one, regardless of write order.
//   2. within a tier (both provisional, or both settled with the same
//      informativeness), the LATER append wins — it reflects the freshest
//      pass (e.g. a daemon settle that saw more merged events than an
//      earlier settle, or simply the most recent write of an equal record).
// A sha's POSITION in the returned array is anchored to where it was FIRST
// seen, preserving the file's oldest-first ordering regardless of which
// duplicate's content won.
function loadCommitMap(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(commitMapPath(projectPath), 'utf8');
  } catch {
    return [];
  }
  const bySha = new Map(); // sha -> winning record so far
  const order = []; // shas in first-seen order
  for (const r of parseRawRecords(raw)) {
    const prev = bySha.get(r.sha);
    if (!prev) {
      order.push(r.sha);
      bySha.set(r.sha, r);
      continue;
    }
    // Lower/equal rank wins outright (equal rank -> later append wins).
    if (commitRank(r) <= commitRank(prev)) bySha.set(r.sha, r);
  }
  return order.map(sha => bySha.get(sha));
}

// The most recently appended commit's sha, or null (missing file, no rows).
//
// Idempotency division of labor (Task 3): this is the CHEAP check a writer
// calls before recording a commit — it only guards the common case, a
// consecutive duplicate (the hook re-firing for the same HEAD, or the hook
// and the daemon racing on the same freshly-made commit while nothing else
// has been recorded since). It intentionally does NOT catch a NON-consecutive
// duplicate (this sha recorded earlier, then other shas, then this sha
// again) — loadCommitMap's dedupe-by-sha above is the backstop for that case,
// so a read is always correct even if a write-side idempotency check is
// bypassed or racy.
//
// Implementation: a tail read, not a full parse. JSON.stringify (the only
// thing recordCommit ever writes) never emits a raw newline, so one on-disk
// line is exactly one record; a bounded trailing window therefore contains
// the last COMPLETE record as long as the window is at least as large as
// that record. Walk the window's lines backwards (skipping a possibly
// truncated leading fragment, or a crash-torn trailing partial line, exactly
// like loadCommitMap does) for the first one that parses. If the window
// holds nothing parseable — the last record alone exceeds the window, or the
// file is genuinely all garbage — fall back to a full RAW parse (not
// loadCommitMap: dedup-by-sha there orders by first-seen sha, which would
// answer the wrong question here if the truly-last line happens to repeat an
// earlier sha — this function must track the physically last write) so
// correctness never regresses; that path is the rare/pathological one, not
// the common per-commit one this function exists to keep cheap.
// Any read error (missing file, permissions) degrades to null — "not
// recorded" — same as today, never throws into the hook path.
function lastRecordedSha(projectPath) {
  const TAIL_BYTES = 8192;
  const file = commitMapPath(projectPath);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const readLen = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r && typeof r === 'object' && r.sha) return r.sha;
      } catch { /* truncated fragment or torn line: try the one before it */ }
    }
    if (readLen < size) {
      // The tail window held nothing parseable — fall back to a full RAW
      // parse (see comment above: NOT loadCommitMap's deduped order).
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      const records = parseRawRecords(raw);
      return records.length ? records[records.length - 1].sha : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

// The commit SHA that last touched a single line, via `git blame -L`. Line
// granularity's whole basis: blame → SHA → the commit map → the owning
// session. Reading only, injected runner, degrades to null — a non-positive
// or non-integer line, the all-zero "not committed yet" SHA, malformed output,
// or any git failure all return null (the caller falls back to file-level).
function blameLine(projectPath, file, line, deps = {}) {
  const n = Number(line);
  if (!Number.isInteger(n) || n <= 0) return null;
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    // NB: `git blame` has no `--porcelain`-safe `--no-color` flag (that belongs
    // to diff/log); porcelain output is uncolored regardless, so it's omitted.
    const out = String(runGit(['blame', '-L', `${n},${n}`, '--porcelain', '--', file]));
    // Porcelain's first line is `<40-hex-sha> <orig> <final> <count>`.
    const token = ((out.split('\n')[0] || '').trim().split(/\s+/)[0] || '');
    if (!/^[0-9a-f]{40}$/.test(token) || /^0{40}$/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

// The repo's current HEAD sha, or null (empty repo, not a repo, no git).
// The post-commit hook needs the real sha — recording the literal string
// 'HEAD' would break the already-recorded idempotency check.
function headSha(projectPath, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    return String(runGit(['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

module.exports = {
  attributeCommit, readCommit, newCommitsSince, headSha, blameLine,
  gitUserEmail, isLocalCommitter,
  recordCommit, loadCommitMap, lastRecordedSha, commitMapPath,
  isProvisionalCommit,
};
