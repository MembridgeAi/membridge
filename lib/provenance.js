'use strict';
// File-level provenance: which sessions edited a given file, newest first —
// the data layer behind `membridge why <file>` and the MCP `why` tool. A pure
// reduction over the ALREADY-captured event history (memorydb.buildEntries)
// plus the already-pulled teammate entries; no git, no new capture, and file
// granularity only — this answers "who touched this file, when, and what were
// they trying to do", never "which commit wrote line 42".
//
// Scope notes, deliberate:
//   • Teammate rows come from proj.teamEntries because a teammate session
//     that edited the file IS provenance (that is what `who` is for) — but
//     WITHOUT teamInjectSlice's age/count trimming: that budget exists to
//     keep injected context small, and provenance is history, not context.
//   • Provenance sees what memory sees: the same maxStoredEvents/maxEntries
//     caps bound how far back it reaches. That is the Phase 0 contract.
const path = require('path');
const digest = require('./digest');
const memorydb = require('./memorydb');

// "Live" is a TIME claim, not a summary claim: activity within this window.
// Mirrors the dashboard's work-unit rule; its twin constant (STALE_GAP) lives
// in dashboard.js's client-side template and cannot be imported — keep in sync.
const STALE_GAP_MS = 45 * 60 * 1000;

// Canonical project-relative posix path for any accepted spelling: a relative
// path (./-prefixed or not) or an absolute path inside the project. Paths
// escaping the project return null — same boundary rule as memorydb's
// relFile, and the caller renders that as "no provenance", never an error.
function normalizeRel(projectPath, file) {
  const f = String(file || '').trim();
  if (!f) return null;
  if (path.isAbsolute(f)) {
    const r = path.relative(projectPath, f);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }
  const norm = path.normalize(f).split(path.sep).join('/');
  if (!norm || norm === '.' || norm.startsWith('../')) return null;
  return norm;
}

// The sessions that edited `file`, newest first. Each row:
//   { who, tool, session, ts, ask, summary, decisions, gotchas, live }
// `now` is injectable so tests need no wall clock (digest.relativeLabel's
// pattern). Unknown/out-of-project file -> [].
function fileProvenance(projectPath, proj, config, file, now = Date.now()) {
  const rel = normalizeRel(projectPath, file);
  if (!rel || !proj || !Array.isArray(proj.events)) return [];
  const regexes = digest.compileRedactions(config);
  // Summary-tier fields are agent markdown: plainText before clip, same
  // pipeline (and same limits) as buildEntries' clipSummary. Asks are left
  // unflattened — the user's own formatting is part of the ask.
  const clipped = (text, n) => (text ? digest.clip(digest.redactText(digest.plainText(text), regexes), n) : null);

  // A session is live if its newest event of ANY kind is recent — a session
  // still running counts even when its last touch of this file was earlier.
  const lastTs = new Map();
  for (const ev of proj.events) {
    const s = ev.session || '';
    const prev = lastTs.get(s);
    if (!prev || String(ev.ts) >= String(prev)) lastTs.set(s, ev.ts);
  }
  const isLive = ts => {
    const t = Date.parse(ts);
    return Number.isFinite(t) && now - t < STALE_GAP_MS;
  };

  // Local sessions, reduced over buildEntries: per-prompt entries already
  // carry redacted asks and project-relative file lists, so the newest entry
  // per session that lists the file is "the ask under which it was edited".
  // Entries are time-ordered oldest->newest, so a plain overwrite keeps the
  // newest. The session's settled summary comes from digest.pickSummary over
  // the raw events — THE shared rule, so Distilled beats harvested here too.
  const bySession = new Map();
  for (const e of memorydb.buildEntries(projectPath, proj, config)) {
    if (Array.isArray(e.files) && e.files.includes(rel)) bySession.set(e.session || '', e);
  }
  const rows = [];
  for (const [session, e] of bySession) {
    const best = digest.pickSummary(proj.events, session);
    rows.push({
      who: 'You',
      tool: e.source,
      session: session || null,
      ts: e.ts,
      ask: e.ask || null,
      summary: best ? clipped(best.text, 300) : null,
      decisions: best && best.decisions ? clipped(best.decisions, 240) : null,
      gotchas: best && best.gotchas ? clipped(best.gotchas, 240) : null,
      live: isLive(lastTs.get(session) || e.ts),
    });
  }

  // Teammate sessions: pulled rows carry the same project-relative file
  // lists. Latest row per (author, session) — teamInjectSlice's key, minus
  // its trimming. Server content is untrusted, so every text field re-runs
  // the redaction pipeline here (defense in depth, same as renderBlock).
  const teamLatest = new Map();
  for (const e of proj.teamEntries || []) {
    if (!e || !Array.isArray(e.files) || !e.files.includes(rel)) continue;
    const key = `${e.author}|${e.session ? `s:${e.session}` : `t:${e.source}`}`;
    const prev = teamLatest.get(key);
    if (!prev || String(prev.ts) <= String(e.ts)) teamLatest.set(key, e);
  }
  for (const e of teamLatest.values()) {
    rows.push({
      who: e.author || '',
      tool: e.source || '',
      session: e.session || null,
      ts: e.ts,
      ask: e.ask ? digest.clip(digest.redactText(e.ask, regexes), 300) : null,
      summary: clipped(e.summary, 300),
      decisions: clipped(e.decisions, 240),
      gotchas: clipped(e.gotchas, 240),
      live: isLive(e.ts),
    });
  }

  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows;
}

// Line-level provenance: the one session behind a single line, via
// blame → SHA → the commit map → the owning session. Returns
//   { line, sha, session, fallback }
// where `session` is ONE row shaped exactly like fileProvenance's local rows
// (or null) and `fallback` is null or an explicit reason the caller renders
// before falling back to the file-level list:
//   'no-line'         no / zero / non-integer line
//   'uncommitted'     the line's last touch is not committed yet (blame all-zero)
//   'pending'         the commit map has this SHA, but only a provisional row —
//                      the daemon has not settled its attribution yet
//   'unmapped'        the blamed SHA isn't in the commit map / owns no local session
//   'merge'           the blamed SHA is a merge (attributed nothing)
//   'git-unavailable' blame/map read threw
// Redaction is NOT re-done here — the CLI/MCP boundary redacts, as fileProvenance's
// callers already do. Deps (`blameLine`, `loadCommitMap`) are injected for tests.
function lineProvenance(projectPath, proj, config, file, line, now = Date.now(), deps = {}) {
  const commits = deps.commits || require('./commits');
  const n = Number(line);
  if (!Number.isInteger(n) || n <= 0) {
    return { line: Number.isInteger(n) && n > 0 ? n : null, sha: null, session: null, fallback: 'no-line' };
  }
  let sha, records;
  try {
    sha = deps.blameLine ? deps.blameLine(projectPath, file, n) : commits.blameLine(projectPath, file, n);
    if (!sha) return { line: n, sha: null, session: null, fallback: 'uncommitted' };
    records = deps.loadCommitMap ? deps.loadCommitMap(projectPath) : commits.loadCommitMap(projectPath);
  } catch {
    return { line: n, sha: sha || null, session: null, fallback: 'git-unavailable' };
  }
  const rel = normalizeRel(projectPath, file);
  const rec = (Array.isArray(records) ? records : []).find(r => r && r.sha === sha);
  if (!rec) return { line: n, sha, session: null, fallback: 'unmapped' };
  // Provisional (recorded, not yet settled): never attempt to read
  // sessions/unattributed off it — those fields are meaningless (always
  // empty) until the daemon settles the row — so this must be checked before
  // the merge/unattributed logic below, which would otherwise misread an
  // empty provisional row as an attributed-nothing merge.
  if (commits.isProvisionalCommit(rec)) return { line: n, sha, session: null, fallback: 'pending' };
  const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
  const unattributed = Array.isArray(rec.unattributed) ? rec.unattributed : [];
  // A merge commit (readCommit files:[]) attributed nothing — no session AND
  // no unattributed files — so its lines carry no single ask.
  if (!sessions.length && !unattributed.length) return { line: n, sha, session: null, fallback: 'merge' };
  const owner = sessions.find(s => s && Array.isArray(s.files) && rel && s.files.includes(rel));
  if (!owner) return { line: n, sha, session: null, fallback: 'unmapped' };
  // Reuse the EXACT file-level row construction and pick the owning local
  // session's row — same ask/summary/decisions/gotchas/live pipeline, no extras.
  const row = fileProvenance(projectPath, proj, config, file, now)
    .find(r => r.who === 'You' && (r.session || '') === (owner.session || ''));
  if (!row) return { line: n, sha, session: null, fallback: 'unmapped' };
  return { line: n, sha, session: row, fallback: null };
}

// Split a `why` argument into { file, line }. `<file>:<line>` yields a numeric
// line; a bare file yields line null. Robust to two real pastes: a Windows
// drive colon (`C:\x.js:10` → the 10 is the line, the drive colon is not) and
// an editor `file:line:col` paste (`a.js:42:7` → keep the LINE, drop the col).
// A non-numeric suffix (`a.js:foo`) is part of the filename, not a line. The
// lazy `.*?` makes the FIRST trailing number the line.
function parseFileLineArg(arg) {
  const s = String(arg == null ? '' : arg);
  const m = s.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m) return { file: m[1], line: parseInt(m[2], 10) };
  return { file: s, line: null };
}

module.exports = { fileProvenance, lineProvenance, parseFileLineArg, normalizeRel, STALE_GAP_MS };
