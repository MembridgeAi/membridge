'use strict';
// Repo-root discovery and the tracked-dir <-> repo-root path offset.
//
// WHY THIS EXISTS: lib/ledger-fold.js's readKeyFor and lib/hooks-recall.js's
// relFile both key paths against the TRACKED project directory, which
// lib/project-resolve.js deliberately allows to be a monorepo subdirectory.
// Two teammates on one remote tracking different depths therefore land on the
// same team project row (lib/teamsync.js's repoUrl) while producing
// incompatible path keys. Local structures keep their tracked-relative keys --
// they never leave the machine. Everything that CROSSES THE WIRE is translated
// through here, so both sides speak repo-root-relative.
//
// See docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md §7.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const toPosix = p => p.split(path.sep).join('/');

// `git rev-parse --show-toplevel` reports the REAL path, with every symlink
// already resolved, while path.resolve() leaves them alone. On macOS the temp
// dir alone is enough to diverge (/var -> /private/var), and any project under
// a symlinked home or volume diverges the same way. Comparing the two spellings
// directly makes path.relative() escape upward, which trackedOffset would then
// read as "outside its own root" and quietly answer '' -- turning translation
// into a silent no-op exactly where a monorepo teammate needs it. So resolve
// the tracked dir the same way git does before comparing. A path that cannot be
// realpath'd (not yet created) falls back to plain resolution.
const realPath = p => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Memoized: teamsync already spawns git per project for repoUrl(), and the
// top-level of a project cannot change while the daemon runs. A null result
// is cached too -- a non-repo stays a non-repo, and re-spawning git on every
// read would defeat the point.
const cache = new Map();

function repoRoot(projectPath) {
  const key = path.resolve(projectPath);
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const r = spawnSync('git', ['-C', key, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status === 0) {
      const s = String(r.stdout || '').trim();
      if (s) out = s;
    }
  } catch {
    out = null;
  }
  cache.set(key, out);
  return out;
}

// '' when the tracked dir IS the repo root (the common case, and byte-identical
// to pre-translation behaviour). 'packages/api/' when it sits below. '' as well
// for a non-repo, or for the impossible case of a tracked dir outside its own
// reported root -- in both, translation must be a no-op rather than a guess.
function trackedOffset(projectPath) {
  const root = repoRoot(projectPath);
  if (!root) return '';
  try {
    const rel = path.relative(realPath(root), realPath(projectPath));
    if (!rel) return '';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return `${toPosix(rel)}/`;
  } catch {
    return '';
  }
}

function toWirePath(projectPath, relPath) {
  const rel = String(relPath || '');
  if (!rel) return rel;
  return trackedOffset(projectPath) + rel;
}

// The inverse, with the legacy fallback spec §7 requires: rows already on the
// wire were written tracked-relative, so a path that does not sit under this
// project's offset is returned unchanged rather than mangled. Harmless when
// the offset is '' -- every path trivially "matches" and passes through.
function fromWirePath(projectPath, wirePath) {
  const wire = String(wirePath || '');
  if (!wire) return wire;
  const offset = trackedOffset(projectPath);
  if (!offset) return wire;
  return wire.startsWith(offset) ? wire.slice(offset.length) : wire;
}

// Test-only: the memo is keyed on absolute paths that outlive a single test
// fixture, and a suite that git-inits a directory after a miss was cached
// would otherwise read the stale null.
function clearCache() { cache.clear(); }

module.exports = { repoRoot, trackedOffset, toWirePath, fromWirePath, clearCache };
