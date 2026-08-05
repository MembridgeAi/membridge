'use strict';
// Resolve which project a session's work actually belongs to by walking up
// from edited files to the nearest ALREADY-TRACKED root, then re-home each
// event's `project`. Tracked = a key in state.projects (passed in as
// trackedRoots) OR a directory containing a .membridge/ (checked on disk).
// Never discovers new roots. An edit under nothing tracked is DROPPED (its
// project cleared) rather than credited to the session cwd -- see the
// containment note in rehomeEvents for what that costs and why it is right.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normPath, isTempPath, homeDir } = require('./util');

// The daemon's own home config dir (~/.membridge, or $MEMBRIDGE_HOME) shares
// its name with a per-project tracked marker, so a walk-up that reaches the
// user's home directory would otherwise false-positive it as a project root.
// This collides constantly on Windows, where os.tmpdir() nests under $HOME —
// nearly any untracked temp/scratch edit walks straight up into it. Checked
// against both the configured home (respects MEMBRIDGE_HOME) and the real
// os.homedir() (a real ~/.membridge can exist on disk independent of it).
//
// Exported so every OTHER "is this dir a project" check in the codebase can
// share this exact guard instead of re-deriving it. lib/scan.js's
// isTrackedProject used to have its own INLINE .membridge check with no home
// exclusion at all -- two definitions that were supposed to agree (see that
// function's own comment) silently diverged, and the result is live: on a
// real install, ~/.membridge always exists once the daemon has ever run
// there, so the unguarded check said "tracked" for the user's home directory
// itself. Never track home. That is always wrong, no matter what marker sits
// directly inside it.
function isProtectedDir(dir) {
  const n = normPath(dir);
  return n === normPath(homeDir()) || n === normPath(os.homedir());
}

function defaultHasMembridge(dir) {
  if (isProtectedDir(dir)) return false;
  try { return fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { return false; }
}

function defaultHasGit(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// If `dir` is a git worktree root, return its MAIN repo root; else null. A
// worktree's `.git` is a FILE (not a dir) reading `gitdir: <main>/.git/worktrees/<name>`
// — so the main repo root is the part before `/.git/worktrees/`. A `.git`
// directory (a real repo) or a submodule pointer (`.git/modules/...`) returns
// null. This is what makes a worktree resolve to the SAME project as its main
// repo instead of becoming a project of its own.
function defaultWorktreeMain(dir) {
  try {
    const g = path.join(dir, '.git');
    let st;
    try { st = fs.statSync(g); } catch { return null; }
    if (!st.isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
    if (!m) return null;
    const parts = m[1].trim().split(/[\\/]\.git[\\/]worktrees[\\/]/);
    return parts.length >= 2 ? parts[0] : null;
  } catch { return null; }
}

// Nearest ancestor of `file` that is tracked, else null. `file` should be
// absolute (callers pass absolute paths; rehomeEvents guarantees it by
// resolving each edit against its own project cwd first). An untracked `.git`
// repo root is a hard boundary: stop there and return null (→ cwd fallback)
// rather than escaping into a tracked parent and capturing this repo's work.
function resolveRoot(file, trackedRoots, opts = {}) {
  const hasMembridge = opts.hasMembridge || defaultHasMembridge;
  const hasGit = opts.hasGit || defaultHasGit;
  const worktreeMain = opts.worktreeMain || defaultWorktreeMain;
  const isProtected = opts.isProtectedDir || isProtectedDir;
  let dir = path.dirname(path.resolve(String(file)));
  for (;;) {
    // The home directory never resolves as a root, unconditionally — even if
    // it is ALREADY sitting in trackedRoots (state a pre-fix bug minted; see
    // lib/scan.js's isTrackedProject). Checked first so nothing below —
    // worktree redirect, tracked-set membership, .membridge marker — can ever
    // hand it back.
    if (isProtected(dir)) return null;
    // A git worktree is the SAME project as its main repo: redirect and resolve
    // as if the file lived at the main repo root. Checked BEFORE the tracked /
    // .membridge test so a leftover worktree .membridge can't pin work to the
    // worktree — its own tracked status is deliberately ignored.
    const main = worktreeMain(dir);
    if (main) {
      const mnorm = normPath(main);
      return (trackedRoots.has(mnorm) || hasMembridge(main)) ? main : null;
    }
    // nearest tracked key / .membridge wins (tracked sub-project or monorepo root)
    if (trackedRoots.has(normPath(dir)) || hasMembridge(dir)) return dir;
    // an untracked repo root is a hard boundary: don't escape into a tracked parent
    if (hasGit(dir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root, nothing tracked
    dir = parent;
  }
}

// One memoized resolver closure per pass (caches .membridge/.git disk checks).
function makeResolver(trackedRoots, opts = {}) {
  if (opts.resolveRoot) return opts.resolveRoot;
  const memoM = new Map(), memoG = new Map(), memoW = new Map();
  const hasMembridge = opts.hasMembridge || (dir => {
    if (memoM.has(dir)) return memoM.get(dir);
    const v = defaultHasMembridge(dir);
    memoM.set(dir, v); return v;
  });
  const hasGit = opts.hasGit || (dir => {
    if (memoG.has(dir)) return memoG.get(dir);
    let v; try { v = fs.existsSync(path.join(dir, '.git')); } catch { v = false; }
    memoG.set(dir, v); return v;
  });
  const worktreeMain = opts.worktreeMain || (dir => {
    if (memoW.has(dir)) return memoW.get(dir);
    const v = defaultWorktreeMain(dir);
    memoW.set(dir, v); return v;
  });
  return f => resolveRoot(f, trackedRoots, { ...opts, hasMembridge, hasGit, worktreeMain });
}

// Absolute path for an edit event, resolving a relative file against its project cwd.
function absEditFile(ev) {
  return path.isAbsolute(ev.file) ? ev.file : path.resolve(ev.project || '', ev.file);
}

// Is `file` at or below `dir`? Deliberately the SAME test digest.dedupeFiles and
// memorydb.relFile apply on the way out (path.relative, rejecting '..' and an
// absolute result), so capture and every file surface agree on one definition of
// "inside the project" instead of two that can drift. normPath on both sides
// adds Windows case-insensitivity, which those two get from path.relative's own
// win32 comparison anyway. An empty relative result means file === dir, which is
// not a file in the project either.
function isInside(dir, file) {
  if (!dir || !file) return false;
  try {
    const r = path.relative(normPath(dir), normPath(file));
    return !!r && !r.startsWith('..') && !path.isAbsolute(r);
  } catch { return false; }
}

// The tracked root a session's edits predominantly land in (most edits), or null.
function sessionDominantRoot(events, session, trackedRoots, opts = {}) {
  const resolve = makeResolver(trackedRoots, opts);
  const counts = new Map(); // normRoot -> {count, root}
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file || (ev.session || '') !== session) continue;
    const root = resolve(absEditFile(ev));
    if (!root) continue;
    const k = normPath(root);
    const prev = counts.get(k) || { count: 0, root };
    counts.set(k, { count: prev.count + 1, root });
  }
  let best = null;
  for (const v of counts.values()) if (!best || v.count > best.count) best = v;
  return best ? best.root : null;
}

// Re-stamp `events[].project` in place and return the array:
//  - each edit → its own resolved root (kept as cwd when it resolves to null);
//  - each session's non-edit events (prompt/summary/todos) → that session's
//    DOMINANT root (the resolved root with the most edits), when one exists.
function rehomeEvents(events, trackedRoots, opts = {}) {
  const resolve = makeResolver(trackedRoots, opts);
  const counts = new Map();   // session -> Map(normRoot -> {count, root})
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file) continue;
    const abs = absEditFile(ev);
    // Throwaway edits (agent scratchpad / temp roots) resolve to no tracked
    // root and would otherwise be pinned to the session cwd, minting a phantom
    // project. Clear the project so the ingestion gate drops them outright.
    if (isTempPath(abs)) { ev.project = null; continue; }
    const root = resolve(abs);
    // CONTAINMENT. No tracked root owns this file, and the session cwd is NOT a
    // fallback owner: an edit to a file that does not live inside a project must
    // not be recorded against that project. Cleared so the ingestion gate drops
    // it, exactly like the temp-path case above.
    //
    // Measured on this machine (606 transcripts, 5188 edit events): 454 edits
    // resolved to no tracked root and 235 of those were outside the cwd they
    // would otherwise have been credited to -- 172 another project's
    // agent-memory files under ~/.claude/projects/<slug>/memory, 47 loose files
    // under the home directory or an untracked repo, 14 other ~/.claude state, 2
    // /tmp patches. None of them had a re-attribution target: the only "owner"
    // of those paths is the home directory, which isTrackedProject refuses
    // unconditionally.
    //
    // KNOW WHAT THIS COSTS, IT IS THE POINT AND NOT AN OVERSIGHT. Clearing the
    // project removes the SESSION, not just the wrong file. A Claude Code
    // session with no edit event is ops noise (lib/classify.js), so a session
    // whose ONLY edits were outside the project loses its ask and its summary
    // from the injected block, the feed and the team push as well. A session that
    // also edited something real keeps everything and just loses the foreign
    // file. test/suites/project-attribution.test.js pins both halves.
    //
    // The isInside escape hatch is containment, not attribution: a file that
    // genuinely lives inside ev.project but whose walk-up was blocked before
    // reaching it -- a nested untracked `.git` is the hard boundary that does
    // this -- is real in-project work and keeps its project. That case did not
    // occur once in the corpus above (unresolvable edits genuinely inside their
    // cwd: zero), so this is a guard against a shape we know how to be wrong
    // about, not a live path.
    if (!root) {
      if (!isInside(ev.project, abs)) ev.project = null;
      continue;
    }
    if (normPath(root) !== normPath(ev.project)) ev.project = root;
    const s = ev.session || '';
    if (!counts.has(s)) counts.set(s, new Map());
    const m = counts.get(s);
    const key = normPath(root);
    const prev = m.get(key) || { count: 0, root };
    m.set(key, { count: prev.count + 1, root });
  }
  const dominant = new Map();   // session -> root path
  for (const [s, m] of counts) {
    let best = null;
    for (const v of m.values()) if (!best || v.count > best.count) best = v;
    if (best) dominant.set(s, best.root);
  }
  for (const ev of events) {
    if (ev.kind === 'edit') continue;
    const root = dominant.get(ev.session || '');
    if (root && normPath(root) !== normPath(ev.project)) ev.project = root;
  }
  return events;
}

// Map an absolute path (typically something under the user's shell or git
// cwd, which node reports realpath'd) to its tracked state.projects key.
// Keys come from tool logs and may spell the same directory through a
// symlink (macOS /var -> /private/var, symlinked homes), so BOTH spellings
// of every key are candidates and whichever one the walk finds maps back to
// the stored key. Returns { key, root } — root is the spelling the walk
// matched (an ancestor of absFile, useful for relativizing) — or null.
// Canonical spelling for the alias map below. realpathSync.native asks the
// OS (GetFinalPathNameByHandle on Windows), which expands BOTH symlinks and
// 8.3 short names -- the plain JS realpathSync resolves only symlinks, which
// covered macOS's /var -> /private/var but left a Windows short spelling
// (C:\Users\RUNNER~1\...) unexpanded. That gap was live: a worktree's `.git`
// pointer carries git's own fully-canonicalized (long) spelling of the main
// repo, so when the tracked key was stored under a short-name spelling the
// two could never meet in byNorm and resolveTrackedKey answered null -- the
// recall/notes hook then went silent for every worktree session on such a
// path. Falls back to the JS realpath, then to the input, exactly as
// defensive as the old inline try/catch.
function realCanon(p) {
  try { return fs.realpathSync.native(p); } catch {
    try { return fs.realpathSync(p); } catch { return p; }
  }
}

function resolveTrackedKey(state, absFile) {
  const byNorm = new Map();
  for (const k of Object.keys((state && state.projects) || {})) {
    byNorm.set(normPath(k), k);
    byNorm.set(normPath(realCanon(k)), k);
  }
  const root = resolveRoot(absFile, new Set(byNorm.keys()));
  if (!root) return null;
  // Both directions: the stored key may be the alias (short/symlinked) while
  // resolveRoot answers canonical (the worktree case above), or the reverse.
  const key = byNorm.get(normPath(root)) || byNorm.get(normPath(realCanon(root))) || null;
  return key ? { key, root } : null;
}

module.exports = {
  resolveRoot, rehomeEvents, sessionDominantRoot, resolveTrackedKey, worktreeMain: defaultWorktreeMain, isProtectedDir,
};
