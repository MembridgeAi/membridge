'use strict';
// Deterministic verification of an agent-written session summary.
//
// WHY. Everything MemBridge stores about a session is the model's own account
// of what it did, and model self-report of ACTIONS is not reliable. The
// research lane's evidence, in short:
//   - arXiv 2601.22436 finds agents "disregard or misinterpret condensed
//     experience, even when it is the only experience provided";
//   - anthropics/claude-code#70525 documents the competitor's live loop:
//     hallucinate -> write memory -> memory primes next session -> hallucinate
//     again. In MemBridge that loop would run through a TEAMMATE.
//   - every field report of an agent misreporting its work was caught the same
//     way: by checking an observable artifact — the branch, the diff, the file.
//
// MemBridge is structurally able to do that check and the incumbents are not.
// Claude Code and Copilot capture MID-session on model initiative, when there
// is no final diff to check against. MemBridge captures at Stop, with a
// settled tree and the daemon's tool-call ledger already on disk. This module
// is the first, deliberately small piece of that: it grounds the CITED part of
// a summary against observable state and stamps the result.
//
// SCOPE, ON PURPOSE. This does not judge prose and never calls a model. It
// checks the two things that are cheap and deterministic today:
//   1. did this session actually edit files, per the daemon's edit ledger;
//   2. does every file the summary CITES exist on disk or appear in that
//      session's edits.
// Anything it cannot check is `unverified`. It never guesses, and it never
// upgrades a claim on the strength of prose.
//
// NOTHING DOWNSTREAM CONSUMES THIS YET. The stamp is additive: existing
// summaries.jsonl lines have no such field and keep parsing exactly as before,
// no existing field changes meaning, and no renderer, sync path or search
// weight reads it. Gating injection/team-sync on it is a separate, owner-signed
// decision (see claude/ops or the run's hook-changes.md write-up).
const fs = require('fs');
const path = require('path');

const STATUS = {
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  CONTRADICTED: 'contradicted',
};

// Every edit event this session recorded under `projectPath`, as absolute
// paths. The daemon derives these from the transcript, so this IS the
// tool-call ledger — read-only, and it is the daemon's to write.
function sessionEditFiles(state, projectPath, sessionId) {
  const out = new Set();
  const proj = ((state || {}).projects || {})[projectPath];
  for (const e of (proj && proj.events) || []) {
    if (!e || e.kind !== 'edit' || e.session !== sessionId) continue;
    const f = typeof e.file === 'string' ? e.file : '';
    if (!f) continue;
    out.add(path.isAbsolute(f) ? path.normalize(f) : path.normalize(path.join(projectPath, f)));
  }
  return out;
}

// Does a cited path point at something real? Two independent ways to say yes,
// because either one is ground truth: the file is on disk under the project
// now, or the session demonstrably touched it (a file the session DELETED is
// a true citation with nothing left to stat).
function citedFileResult(cited, projectPath, editFiles) {
  const raw = String(cited || '').trim();
  if (!raw) return 'fail';
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(projectPath, raw));
  if (editFiles.has(abs)) return 'pass';
  // Also accept a citation that names the file by a suffix of an edited path
  // (agents cite "lib/hooks.js" for a worktree-absolute edit event).
  for (const f of editFiles) {
    if (f.endsWith(path.sep + raw) || path.basename(f) === path.basename(abs)) return 'pass';
  }
  try {
    if (fs.existsSync(abs)) return 'pass';
  } catch { /* unreadable: fall through to fail */ }
  return 'fail';
}

// Verify one summary entry. Pure apart from fs.existsSync and the state it is
// handed; never throws — a verifier that can break the append path would cost
// a real summary to record a diagnostic, which is the wrong trade.
//
// Returns { status, checks, sessionEdits }.
function verifySummary({ projectPath, entry, state, health }) {
  const checks = [];
  try {
    const sessionId = entry && typeof entry.session === 'string' ? entry.session : '';
    if (!projectPath || !sessionId) {
      return { status: STATUS.UNVERIFIED, checks: [{ check: 'session', result: 'unknown', why: 'no project or session' }], sessionEdits: 0 };
    }
    // A stale/absent state.json means the ledger cannot be trusted as
    // evidence of ABSENCE. Under those conditions a summary is `unverified`,
    // never `contradicted` — "MemBridge could not check" and "the claim is
    // false" are exactly the two things this whole run exists to keep apart.
    const blind = !!(health && (health.stateMissing === true || health.running === false || health.stale === true));
    const editFiles = sessionEditFiles(state, projectPath, sessionId);
    checks.push({
      check: 'session-edits',
      result: editFiles.size > 0 ? 'pass' : (blind ? 'unknown' : 'fail'),
      count: editFiles.size,
    });

    const highlights = Array.isArray(entry.highlights) ? entry.highlights.slice(0, 2) : [];
    let citedPass = 0;
    let citedFail = 0;
    for (const hl of highlights) {
      if (!hl || typeof hl.file !== 'string' || !hl.file.trim()) continue;
      const result = blind && !editFiles.size ? 'unknown' : citedFileResult(hl.file, projectPath, editFiles);
      checks.push({ check: 'cited-file', target: hl.file.trim(), result });
      if (result === 'pass') citedPass++;
      else if (result === 'fail') citedFail++;
    }

    // CONTRADICTED is reserved for a claim demonstrably about something that
    // is not there: a cited file that neither exists nor was ever touched.
    // "The session recorded no edits" alone is NOT a contradiction — the
    // daemon may simply not have scanned the tail of the session yet, which
    // is routine and is the same undercount runStop already fails open on.
    if (citedFail > 0) return { status: STATUS.CONTRADICTED, checks, sessionEdits: editFiles.size };
    // VERIFIED requires a positive, checked correspondence: the session really
    // edited files AND at least one file the summary cites was confirmed.
    // A summary with no citations has nothing checkable in it, so it stays
    // unverified however plausible its prose is.
    if (editFiles.size > 0 && citedPass > 0) return { status: STATUS.VERIFIED, checks, sessionEdits: editFiles.size };
    return { status: STATUS.UNVERIFIED, checks, sessionEdits: editFiles.size };
  } catch (err) {
    return {
      status: STATUS.UNVERIFIED,
      checks: [...checks, { check: 'verifier', result: 'unknown', why: String((err && err.message) || err) }],
      sessionEdits: 0,
    };
  }
}

module.exports = { STATUS, verifySummary, sessionEditFiles, citedFileResult };
