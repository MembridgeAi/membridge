'use strict';
// Daemon/OS-level actions for the new UI's controls (Task 17):
//   - POST /api/open        reveal a known file/folder in the OS file manager
//   - POST /api/daemon/restart  restart the running daemon in place
//
// Both are security- or availability-sensitive in ways the rest of the API
// isn't, so they get their own module rather than living inline in
// lib/server.js:
//   - /api/open must NEVER open a path the caller merely claims — see
//     resolveTrackedPath below for the full boundary argument.
//   - restart must respond to the HTTP client BEFORE the process that would
//     answer that response goes away.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { z } = require('zod');
const util = require('./util');
const memorydb = require('./memorydb');
const { findProjectKey } = require('./scan');

class MachineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');

// ---------------------------------------------------------------------------
// POST /api/open
// ---------------------------------------------------------------------------
const openBodySchema = z.object({
  kind: z.enum(['config', 'memory', 'project']),
  // Required for 'memory'/'project' (checked below, not here, so the error
  // names which kind needed it); ignored for 'config'.
  path: z.string().min(1).optional(),
});

// realpath of the nearest EXISTING ancestor of `p`, with the missing tail
// (if any) rejoined verbatim. Plain fs.realpathSync throws ENOENT outright
// when the leaf doesn't exist yet (e.g. memory.md before a project's first
// sync) — but the missing tail cannot itself be a symlink (it doesn't exist),
// so resolving symlinks in whatever DOES exist and rejoining the rest is a
// safe, complete answer to "where would this path really point".
function existingRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = path.dirname(p);
    if (parent === p) throw err; // reached the filesystem root; nothing exists
    return path.join(existingRealpath(parent), path.basename(p));
  }
}

// The security-critical resolver. Never trusts the client's `path` as
// anything but a lookup key into MemBridge's OWN tracked-project list
// (findProjectKey — the same exact-match-after-normPath resolution every
// other /api/project* route already uses), then verifies the REAL,
// symlink-resolved target still sits inside that tracked project's REAL
// directory before returning it. A path that doesn't name a tracked project
// (a traversal attempt, or any path outside every tracked project) fails at
// the findProjectKey lookup; a path that names a real tracked project but
// escapes it through a symlink (e.g. a swapped .membridge dir, or memory.md
// itself replaced with a symlink) fails the realpath containment check.
// Both are 400s — this function is the one place that decides "no".
function resolveTrackedPath(state, kind, rawProjectPath) {
  if (kind === 'config') {
    return { target: util.configPath(), isDirectory: false };
  }
  if (!rawProjectPath) {
    throw new MachineError(400, `path is required to open kind "${kind}"`);
  }
  const key = findProjectKey(state, rawProjectPath);
  if (!key) {
    throw new MachineError(400, 'not a project MemBridge tracks');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(key);
  } catch {
    throw new MachineError(404, 'this project no longer exists on disk');
  }
  const wantPath = kind === 'project' ? key : memorydb.mdPath(key);
  if (kind === 'memory' && !fs.existsSync(wantPath)) {
    throw new MachineError(404, 'no memory log for this project yet');
  }
  const targetReal = existingRealpath(wantPath);
  const rel = path.relative(rootReal, targetReal);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    // A symlink somewhere between the project root and the target (most
    // likely .membridge itself, or memory.md) resolves outside the project.
    throw new MachineError(400, 'resolved path escapes the tracked project');
  }
  return { target: targetReal, isDirectory: kind === 'project' };
}

// Platform dispatch, argument-array only (never a shell string built from
// user input) — same shape as bin/membridge.js's openBrowser, extended to
// REVEAL a file (select it in its containing folder) rather than just open a
// URL. `deps` lets tests substitute spawnImpl/platform without touching the
// real file manager.
function openInFileManager(targetPath, isDirectory, deps = {}) {
  const spawnImpl = deps.spawnImpl || spawnSync;
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    // A single argv token: Explorer's /select, syntax takes no space after
    // the comma, and there is no shell here to mis-tokenize it either way.
    spawnImpl('explorer', [isDirectory ? targetPath : `/select,${targetPath}`], { stdio: 'ignore' });
  } else if (platform === 'darwin') {
    spawnImpl('open', isDirectory ? [targetPath] : ['-R', targetPath], { stdio: 'ignore' });
  } else {
    // No cross-desktop-standard "reveal and select" on Linux; open the
    // containing folder for a file, the folder itself for a directory.
    spawnImpl('xdg-open', [isDirectory ? targetPath : path.dirname(targetPath)], { stdio: 'ignore' });
  }
}

// Real dispatch by default; a test substitutes spawnImpl (or platform, to
// exercise all three OS branches without three OSes) by MUTATING this
// object's properties, never by reassigning the export — openTarget re-reads
// it via the default parameter on every call, so the swap takes effect
// immediately and cannot leak past the test that restores it. Same intent as
// the module-object convention the rest of this codebase's tests use for
// commits.newCommitsSince / recallStore.warm, adapted here because the call
// this needs to intercept is internal to this module rather than made by an
// external caller.
const defaultOpenDeps = { spawnImpl: spawnSync, platform: undefined };

function openTarget(state, rawBody, deps = defaultOpenDeps) {
  const parsed = openBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new MachineError(400, 'kind must be one of config, memory, project');
  }
  const resolved = resolveTrackedPath(state, parsed.data.kind, parsed.data.path);
  openInFileManager(resolved.target, resolved.isDirectory, deps);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// POST /api/daemon/restart
// ---------------------------------------------------------------------------
// Spawns a fresh detached daemon (identical to cmdStart's own child — see
// bin/membridge.js) and schedules THIS process to exit shortly after. The
// route handler in lib/server.js writes and flushes the HTTP response BEFORE
// calling this, so the client sees success even though the process that
// answered is about to go away. The new child binds the same dashboard port;
// startServer's own EADDRINUSE retry loop (already exercised by a fast
// stop→start, see its comment in lib/server.js) covers the brief overlap
// while the old process is still shutting down. `deps` lets tests verify the
// spawn arguments and the scheduled exit without either spawning a real
// daemon or killing the test process.
function restartDaemon(deps = {}) {
  const spawnImpl = deps.spawnImpl || spawn;
  const exit = deps.exit || (code => process.exit(code));
  const delayMs = deps.delayMs === undefined ? 200 : deps.delayMs;
  let out;
  try {
    out = fs.openSync(util.logPath(), 'a');
  } catch {
    out = 'ignore';
  }
  const child = spawnImpl(process.execPath, [BIN, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  // A ChildProcess is an EventEmitter: an 'error' event with no listener is
  // an UNCAUGHT exception in this process — the one moment restarting must
  // not itself crash the daemon it is trying to replace. Best-effort only;
  // there is no client left listening for the outcome by the time this could
  // fire (the HTTP response already went out).
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  const timer = setTimeout(() => exit(0), delayMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

module.exports = { MachineError, resolveTrackedPath, openInFileManager, openTarget, restartDaemon, existingRealpath, defaultOpenDeps };
