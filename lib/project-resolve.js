'use strict';
// Resolve which project a session's work actually belongs to by walking up
// from edited files to the nearest ALREADY-TRACKED root, then re-home each
// event's `project`. Tracked = a key in state.projects (passed in as
// trackedRoots) OR a directory containing a .membridge/ (checked on disk).
// Never discovers new roots: an edit under nothing tracked keeps its cwd.
const fs = require('fs');
const path = require('path');
const { normPath } = require('./util');

function defaultHasMembridge(dir) {
  try { return fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { return false; }
}

function defaultHasGit(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// Nearest ancestor of `file` that is tracked, else null. `file` should be
// absolute (callers pass absolute paths; rehomeEvents guarantees it by
// resolving each edit against its own project cwd first). An untracked `.git`
// repo root is a hard boundary: stop there and return null (→ cwd fallback)
// rather than escaping into a tracked parent and capturing this repo's work.
function resolveRoot(file, trackedRoots, opts = {}) {
  const hasMembridge = opts.hasMembridge || defaultHasMembridge;
  const hasGit = opts.hasGit || defaultHasGit;
  let dir = path.dirname(path.resolve(String(file)));
  for (;;) {
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
  const memoM = new Map(), memoG = new Map();
  const hasMembridge = opts.hasMembridge || (dir => {
    if (memoM.has(dir)) return memoM.get(dir);
    let v; try { v = fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { v = false; }
    memoM.set(dir, v); return v;
  });
  const hasGit = opts.hasGit || (dir => {
    if (memoG.has(dir)) return memoG.get(dir);
    let v; try { v = fs.existsSync(path.join(dir, '.git')); } catch { v = false; }
    memoG.set(dir, v); return v;
  });
  return f => resolveRoot(f, trackedRoots, { ...opts, hasMembridge, hasGit });
}

// Absolute path for an edit event, resolving a relative file against its project cwd.
function absEditFile(ev) {
  return path.isAbsolute(ev.file) ? ev.file : path.resolve(ev.project || '', ev.file);
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
    const root = resolve(absEditFile(ev));
    if (!root) continue;                       // untracked edit: leave cwd
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

module.exports = { resolveRoot, rehomeEvents, sessionDominantRoot };
