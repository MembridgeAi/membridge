'use strict';
// The canonical cross-machine key for a file: its path relative to the
// checkout it lives in.
//
// WHY THIS EXISTS. lib/ledger-fold.js's readKeyFor and lib/hooks-recall.js's
// relFile key a file against the TRACKED PROJECT DIRECTORY. That is wrong in
// two independent ways, and both break file-keyed teammate notes:
//
//   1. MONOREPO DEPTH. lib/project-resolve.js deliberately lets the tracked
//      root be a subdirectory ("tracked sub-project or monorepo root"). Two
//      teammates on one remote tracking different depths land on the same team
//      project (lib/teamsync.js's repoUrl) with incompatible keys.
//
//   2. WORKTREES. A linked worktree nested inside its main repo -- the layout
//      MemBridge itself uses, .claude/worktrees/<name> -- resolves to the MAIN
//      repo as its project (project-resolve.js's defaultWorktreeMain, which is
//      correct for attribution). But the file key then comes out relative to
//      the main repo. Measured on live state:
//
//        <main>/lib/scan.js                        -> lib/scan.js
//        <main>/.claude/worktrees/x/lib/scan.js    -> .claude/worktrees/x/lib/scan.js
//
//      Same file, two keys. A teammate's note on lib/scan.js can never match a
//      session run from a worktree.
//
// ONE RULE CLOSES BOTH: key a file against the root of the checkout that
// contains it. `packages/api/src/x.ts` in a monorepo, `lib/scan.js` in a
// worktree, regardless of what the user happens to track.
//
// See docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md §7.
//
// NO SUBPROCESS. An earlier draft called `git rev-parse --show-toplevel`, which
// is both too slow for the read path (this runs ahead of the recall hook's
// storeEntry gate, inside a 150ms budget) and answers the wrong question --
// in a worktree it returns the worktree, and comparing its symlink-resolved
// output against path.resolve() silently yielded a '..'-leading path on macOS.
// Walking up to the nearest `.git` is what --show-toplevel does anyway, costs
// one statSync per level, and needs no realpath because nothing is compared
// across two sources.
const fs = require('fs');
const path = require('path');

const toPosix = p => p.split(path.sep).join('/');

// dir -> checkout root (absolute) | null. Every directory walked on the way to
// an answer is memoized with that same answer, so the second file read in a
// tree is a single Map hit no matter how deep it sits.
const cache = new Map();

// Nearest ancestor containing a `.git`, or null.
//
// `.git` is a DIRECTORY in a normal clone and a FILE in a linked worktree or a
// submodule -- statSync accepts both, and both are correct stopping points: a
// worktree's own root is exactly the key basis we want, and a submodule is its
// own project.
function checkoutRoot(startDir) {
  let dir = path.resolve(String(startDir || ''));
  const walked = [];
  for (;;) {
    if (cache.has(dir)) {
      const hit = cache.get(dir);
      for (const d of walked) cache.set(d, hit);
      return hit;
    }
    walked.push(dir);
    let found = false;
    try {
      fs.statSync(path.join(dir, '.git'));
      found = true;
    } catch { /* not here; keep walking */ }
    if (found) {
      for (const d of walked) cache.set(d, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { // filesystem root, no checkout anywhere above
      for (const d of walked) cache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// wireKeyFor(absFile) -> 'packages/api/src/x.ts' | null
//
// The ONLY identity that crosses the wire. null when the file is not inside a
// checkout, which callers treat exactly like "no note for this path" -- never
// as an error, and never as a reason to fall back to a machine-local path that
// could not match anyone else's.
function wireKeyFor(absFile) {
  const abs = path.resolve(String(absFile || ''));
  const root = checkoutRoot(path.dirname(abs));
  if (!root) return null;
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

// root -> is it a LINKED WORKTREE root (as opposed to a normal clone or a
// submodule). Memoized per root, so this costs one small readFileSync the
// first time a tree is touched and nothing after that.
const worktreeCache = new Map();

// A linked worktree and a submodule BOTH carry `.git` as a file, so the
// stat alone cannot tell them apart -- the gitdir it points at can. Git writes
// `<main>/.git/worktrees/<name>` for a worktree and `<super>/.git/modules/<name>`
// for a submodule. Only the former is another view of the SAME commit graph,
// which is what makes collapsing its prefix sound; a submodule is an
// independent project whose `src/x.ts` is a different file from the
// superproject's `src/x.ts`, so collapsing it would fabricate collisions.
function isLinkedWorktree(root) {
  if (worktreeCache.has(root)) return worktreeCache.get(root);
  let out = false;
  try {
    const dotGit = path.join(root, '.git');
    if (fs.statSync(dotGit).isFile()) {
      out = /^\s*gitdir:\s*.*[/\\]worktrees[/\\]/m.test(fs.readFileSync(dotGit, 'utf8'));
    }
  } catch { /* unreadable: treat as "not a worktree", the conservative answer */ }
  worktreeCache.set(root, out);
  return out;
}

// ledgerKeyFor(projectPath, absFile) -> 'lib/scan.js' | null
//
// The per-project read identity for lib/ledger-fold.js's fileReaders/hotPaths
// and lib/hooks-recall.js's store lookups. Two rules, in order:
//
//   1. CONTAINMENT (unchanged). A file outside the tracked project is null --
//      an agent reading another repo while working in this one is not this
//      ledger's business, and must never be stored under a foreign path.
//
//   2. WORKTREE COLLAPSE (the fix). If the file sits in a LINKED WORKTREE
//      nested inside the project -- MemBridge's own .claude/worktrees/<name>
//      layout -- key it relative to that worktree instead of to the project:
//
//        <main>/lib/scan.js                     -> lib/scan.js
//        <main>/.claude/worktrees/x/lib/scan.js -> lib/scan.js   (was:
//                                        .claude/worktrees/x/lib/scan.js)
//
//      Same file, one key, so a read from a worktree and a read from the main
//      checkout finally tier as the repeat read they are. Measured on a live
//      ledger before this: 12/12 keys carried a worktree prefix and two files
//      appeared twice under different worktrees, both scored 'first'.
//
// Deliberately NARROWER than wireKeyFor above, which keys against whatever
// checkout contains the file. Widening this to every checkout would break
// lib/recall-store.js's warm(), which resolves a key by joining it onto
// projectPath: for a monorepo sub-project tracked at <repo>/packages/api, a
// <repo>-relative key would resolve to <repo>/packages/api/packages/api/...
// and never warm anything. A nested worktree is the one case where the
// collapsed key still resolves under projectPath, because the worktree is a
// second view of the same tree.
//
// Serving a MAIN-checkout skeleton for a file read in a worktree is safe:
// lib/recall.js refuses to serve unless the stored contentHash equals the
// target file's current hash, so a worktree copy that has diverged simply
// misses instead of being answered with the wrong body.
function ledgerKeyFor(projectPath, absFile) {
  const proj = path.resolve(String(projectPath || ''));
  const abs = path.resolve(String(absFile || ''));
  let rel;
  try {
    rel = path.relative(proj, abs);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const root = checkoutRoot(path.dirname(abs));
  if (root && root !== proj && isLinkedWorktree(root)) {
    const wrel = path.relative(root, abs);
    if (wrel && !wrel.startsWith('..') && !path.isAbsolute(wrel)) return toPosix(wrel);
  }
  return toPosix(rel);
}

// Test-only: the memo is keyed on absolute paths that outlive a single fixture,
// and a suite that git-inits a directory after a miss was cached would
// otherwise read the stale null.
function clearCache() { cache.clear(); worktreeCache.clear(); }

module.exports = { wireKeyFor, ledgerKeyFor, checkoutRoot, clearCache };
