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

// Nearest ancestor of `file` that is tracked, else null. `file` should be
// absolute (callers pass absolute paths; rehomeEvents guarantees it by
// resolving each edit against its own project cwd first).
function resolveRoot(file, trackedRoots, opts = {}) {
  const hasMembridge = opts.hasMembridge || defaultHasMembridge;
  let dir = path.dirname(path.resolve(String(file)));
  for (;;) {
    if (trackedRoots.has(normPath(dir)) || hasMembridge(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root, nothing tracked
    dir = parent;
  }
}

// Re-stamp `events[].project` in place and return the array:
//  - each edit → its own resolved root (kept as cwd when it resolves to null);
//  - each session's non-edit events (prompt/summary/todos) → that session's
//    DOMINANT root (the resolved root with the most edits), when one exists.
function rehomeEvents(events, trackedRoots, opts = {}) {
  const memo = new Map();
  const hasMembridge = opts.hasMembridge || (dir => {
    if (memo.has(dir)) return memo.get(dir);
    let v;
    try { v = fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { v = false; }
    memo.set(dir, v);
    return v;
  });
  const resolve = opts.resolveRoot || (f => resolveRoot(f, trackedRoots, { ...opts, hasMembridge }));
  const counts = new Map();   // session -> Map(normRoot -> {count, root})
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file) continue;
    const abs = path.isAbsolute(ev.file) ? ev.file : path.resolve(ev.project || '', ev.file);
    const root = resolve(abs);
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

module.exports = { resolveRoot, rehomeEvents };
