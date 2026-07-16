'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, loadState, saveState, walkFiles, isProjectOff, normPath, log, effectiveTargets } = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const hooks = require('./hooks');
const projectResolve = require('./project-resolve');
const claudeCode = require('./adapters/claude-code');
const codex = require('./adapters/codex');
const custom = require('./adapters/custom');

// ---------------------------------------------------------------------------
// Incremental JSONL reading: only bytes appended since the last sync are read,
// and only complete lines are consumed, so a session file being actively
// written by a tool is never half-parsed.
// ---------------------------------------------------------------------------
function readNewLines(file, offset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { entries: [], offset: offset || 0 };
  }
  let start = offset || 0;
  if (stat.size < start) start = 0; // file was truncated/rewritten
  if (stat.size === start) return { entries: [], offset: start };

  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a); // '\n' is single-byte ASCII, safe on raw bytes
  if (lastNl === -1) return { entries: [], offset: start };

  const entries = [];
  for (const line of buf.slice(0, lastNl).toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // skip corrupt/partial line
    }
  }
  return { entries, offset: start + lastNl + 1 };
}

function getAdapters(config) {
  const a = config.adapters || {};
  const list = [];
  if (!a['claude-code'] || a['claude-code'].enabled !== false) list.push(claudeCode);
  if (!a.codex || a.codex.enabled !== false) list.push(codex);
  for (const def of a.custom || []) {
    if (!def || def.enabled === false) continue;
    try {
      list.push(custom.create(def));
    } catch (err) {
      log(`bad custom adapter ${def && def.id}: ${err.message}`);
    }
  }
  return list;
}

// One pass over every adapter's session stores. Mutates state.files (offsets
// and per-file carry data such as the Codex cwd).
function scanAll(state, config) {
  state.files = state.files || {};
  const events = [];
  for (const adapter of getAdapters(config)) {
    for (const root of adapter.sessionRoots(config)) {
      for (const file of walkFiles(root, '.jsonl')) {
        const rec = state.files[file] || (state.files[file] = { offset: 0, adapter: adapter.id, data: {} });
        rec.data = rec.data || {};
        const r = readNewLines(file, rec.offset);
        rec.offset = r.offset;
        if (r.entries.length) {
          // Transcript filename doubles as the per-chat session id.
          const sessionId = path.basename(file).replace(/\.jsonl$/, '');
          for (const ev of adapter.extractEvents(r.entries, rec.data)) {
            if (!ev.session) ev.session = sessionId;
            events.push(ev);
          }
        }
      }
    }
  }
  return events;
}

// Agent-written session summaries (lib/hooks.js): each tracked project's
// .membridge/summaries.jsonl is read incrementally like any session store.
// Runs after the transcript pass so a project first seen this pass is
// covered too. Lines are defensive-parsed; a bad line is just skipped.
function scanSummaries(state, config) {
  const events = [];
  if ((config.distill || {}).enabled === false) return events;
  for (const key of Object.keys(state.projects || {})) {
    const file = hooks.summariesPath(key);
    if (!fs.existsSync(file)) continue;
    const rec = state.files[file] || (state.files[file] = { offset: 0, adapter: 'distill', data: {} });
    const r = readNewLines(file, rec.offset);
    rec.offset = r.offset;
    for (const e of r.entries) {
      if (!e || typeof e.did !== 'string' || !e.did.trim()) continue;
      if (typeof e.session !== 'string' || !e.session) continue;
      const str = v => (typeof v === 'string' ? v.trim() : '');
      const highlights = Array.isArray(e.highlights)
        ? e.highlights
            .filter(h => h && typeof h.file === 'string' && h.file.trim())
            .slice(0, 2)
            .map(h => ({ file: h.file.trim(), note: str(h.note) }))
        : undefined;
      const ev = {
        ts: typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString(),
        project: key,
        source: 'Distilled',
        kind: 'summary',
        session: e.session,
        text: e.did.trim(),          // canonical outcome (= did), no longer a blob
      };
      const goal = str(e.goal), decisions = str(e.decisions), gotchas = str(e.gotchas);
      if (goal) ev.goal = goal;
      if (decisions) ev.decisions = decisions;
      if (gotchas) ev.gotchas = gotchas;
      if (highlights && highlights.length) ev.highlights = highlights;
      events.push(ev);
    }
  }
  return events;
}

// The set of roots MemBridge already tracks — every known project key,
// normalized. project-resolve also treats any dir with a .membridge/ as
// tracked, so a first-seen project still resolves.
function trackedRoots(state) {
  return new Set(Object.keys(state.projects || {}).map(normPath));
}

// normPath case-folds on win32 so `--project C:\Foo` matches a stored c:\foo.
function findProjectKey(state, projectPath) {
  const want = normPath(projectPath);
  return Object.keys(state.projects || {}).find(k => normPath(k) === want) || null;
}

// One full sync pass: scan session stores → merge events → inject the memory
// block into each touched, non-excluded, still-existing project.
function syncOnce(opts = {}) {
  const config = getConfig();
  const state = loadState();
  const events = scanAll(state, config);
  projectResolve.rehomeEvents(events, trackedRoots(state));
  const touched = digest.mergeEvents(state, events, config);
  const distilled = scanSummaries(state, config);
  for (const key of digest.mergeEvents(state, distilled, config)) touched.add(key);
  // Offsets only advance once, so a project stays dirty until its files are
  // actually rewritten: a project-scoped pass that consumed other projects'
  // events must not leave them permanently stale.
  for (const key of touched) state.projects[key].dirty = true;

  let projectKeys;
  if (opts.project) {
    const key = findProjectKey(state, opts.project);
    projectKeys = key ? [key] : [];
  } else {
    projectKeys = Object.keys(state.projects || {}).filter(k => state.projects[k] && state.projects[k].dirty);
  }

  const changes = [];
  const skipped = [];
  for (const key of projectKeys) {
    const proj = state.projects[key];
    if (!proj || !proj.events.length) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(key).isDirectory();
    } catch {}
    if (!isDir) {
      skipped.push({ project: key, reason: 'path no longer exists' });
      if (!opts.dryRun) delete proj.dirty; // can never inject; new events re-mark it
      continue;
    }
    if (isProjectOff(key, config)) {
      skipped.push({ project: key, reason: 'paused/excluded' });
      continue;
    }
    const sessions = digest.sessionGroups(key, proj, config);
    for (const target of effectiveTargets(config)) {
      const block = digest.renderBlock(key, proj, config, target, sessions);
      const file = path.join(key, target);
      if (opts.dryRun) {
        changes.push({ file, action: 'would update' });
      } else if (digest.inject(file, block, digest.preambleFor(target))) {
        changes.push({ file, action: 'updated' });
      }
    }
    if (config.writeProjectMemory !== false) {
      if (opts.dryRun) {
        changes.push({ file: memorydb.mdPath(key), action: 'would update' });
      } else {
        try {
          for (const f of memorydb.updateProject(key, proj, config)) {
            changes.push({ file: f, action: 'updated' });
          }
        } catch (err) {
          log(`memory db error for ${key}: ${err.message}`);
        }
      }
    }
    if (!opts.dryRun) {
      proj.lastSync = new Date().toISOString();
      delete proj.dirty;
    }
  }

  if (!opts.dryRun) saveState(state);
  return { newEvents: events.length + distilled.length, projects: projectKeys, changes, skipped };
}

module.exports = { readNewLines, getAdapters, scanAll, scanSummaries, syncOnce, findProjectKey, trackedRoots };
