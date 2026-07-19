'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, loadState, saveState, walkFiles, isProjectOff, normPath, log, effectiveTargets } = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const hooks = require('./hooks');
const commits = require('./commits');
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

// Provenance reconciliation — the settle pass: the post-commit hook records a
// LOCAL commit provisionally (sessions:[], provisional:true, see
// lib/hooks.js) because it cannot safely attribute against state.json at
// commit time. The daemon is the authority instead: once this project's
// events include activity AT OR AFTER the commit's own timestamp, the daemon
// has necessarily also scanned everything AT OR BEFORE that point (event
// files are read and merged in ts order), so re-running attributeCommit here
// is trustworthy in a way the hook's own attempt never could be. The
// resulting row is appended settled (provisional:false) — loadCommitMap's
// dedupe then always prefers it over the stale provisional one, never the
// other way around (see commitRank in lib/commits.js).
//
// Ts-based, not "any event arrived": a commit with NO event yet at or after
// its own ts stays provisional and is retried on a later pass — settling it
// to empty just because nothing has matched SO FAR would be indistinguishable
// from "the daemon hasn't caught up", which is exactly the stale-crediting
// failure mode this whole feature exists to close. Once an event exists past
// the commit's ts, the daemon HAS caught up, and "no session touched these
// files" becomes a real, settleable answer (an unattributed settled row),
// not a guess.
//
// Runs every tick, independent of whether HEAD moved this tick — a
// provisional row can be left over from a commit the cursor already passed
// in an earlier pass — but costs nothing beyond one loadCommitMap (a plain
// fs read, no git) when there is nothing provisional, and calls git only for
// rows that are actually ready to settle. So the unchanged-HEAD tick's
// "avoid git entirely" cheapness is preserved for the common case (no
// provisional rows at all), while a provisional row is no longer starved by
// the line-277-style unchanged-HEAD skip.
//
// Authorship gate: NOT re-checked here. The hook only ever writes a
// provisional row for a commit that already passed the local-committer gate
// (a foreign commit is recorded settled-unattributed immediately, never
// provisional — see lib/hooks.js) — so by construction nothing this function
// finds provisional can be a foreign commit. Re-deriving the gate answer
// here would also be the wrong call to make TWICE: "is this the local
// identity" is a fact about who committed, fixed at record time, not
// something further scanning could change.
//
// Best-effort: any error (a bad commits.jsonl read, a git failure inside
// readCommit/attributeCommit) is caught per-row and logged — one bad
// provisional row must never abort settling the rest, or throw into
// syncOnce.
function settleProvisionalCommits(key, proj) {
  let map;
  try {
    map = commits.loadCommitMap(key);
  } catch (err) {
    log(`commit settle error for ${key}: ${err.message}`);
    return;
  }
  const pending = map.filter(r => commits.isProvisionalCommit(r));
  if (!pending.length) return;

  let newestEventTs = -Infinity;
  for (const ev of proj.events || []) {
    const t = Date.parse(ev && ev.ts);
    if (Number.isFinite(t) && t > newestEventTs) newestEventTs = t;
  }

  for (const row of pending) {
    try {
      const commitTs = Date.parse(row.ts);
      // Not caught up yet ("older than" per the design rule below) — wait
      // for a later pass rather than force-settling on incomplete data.
      if (!Number.isFinite(commitTs) || !(commitTs < newestEventTs)) continue;
      const c = commits.readCommit(key, row.sha);
      // A failed git read degrades to ts:null — do not let a transient git
      // hiccup settle this row into a bogus empty attribution; retry later.
      if (!c.ts) continue;
      const att = commits.attributeCommit(c.files, c.ts, proj.events || [], { projectPath: key });
      commits.recordCommit(key, {
        sha: row.sha, ts: c.ts, project: key,
        sessions: att.sessions, unattributed: att.unattributed,
        provisional: false,
      });
    } catch (err) {
      log(`commit settle error for ${key} (${row.sha}): ${err.message}`);
    }
  }
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

// Ingestion gate (over-collection fix). Runs AFTER rehomeEvents has stamped
// every event with its resolved root: an event survives only if its project
// is already tracked — a state.projects key (the passed set) or a dir with a
// .membridge/ (the same definition project-resolve uses). Anything else is
// dropped, so an arbitrary session cwd can never mint a new project; a
// multi-repo session keeps its tracked-root events while its untracked edits
// (left on the cwd by rehome) fall away. Defensive: a bad event or a failing
// disk check drops the event, never throws.
function filterTrackedSessions(events, tracked, opts = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  const roots = tracked || new Set();
  const hasMembridge = opts.hasMembridge || (dir => {
    try { return fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { return false; }
  });
  const memo = new Map(); // project path -> tracked?
  const kept = [];
  for (const ev of events) {
    if (!ev || !ev.project) continue;
    const key = String(ev.project);
    if (!memo.has(key)) {
      let v = false;
      try {
        const abs = path.resolve(key);
        v = roots.has(normPath(abs)) || !!hasMembridge(abs);
      } catch { v = false; }
      memo.set(key, v);
    }
    if (memo.get(key)) kept.push(ev);
  }
  return kept;
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
  const scanned = scanAll(state, config);
  projectResolve.rehomeEvents(scanned, trackedRoots(state));
  const events = filterTrackedSessions(scanned, trackedRoots(state));
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

  // Commit->session capture (provenance Phase 2): best-effort per tracked
  // project, after events are merged so attribution sees this pass's edits.
  // Any git or store failure skips that project and never breaks the sync —
  // the same rule team sync follows. The recorded-shas check lets the daemon
  // backfill and the post-commit hook converge without duplicate rows no
  // matter which of them saw a commit first; the cursor still advances over
  // already-recorded shas so the next pass skips them cheaply.
  if (!opts.dryRun) {
    const captureKeys = opts.project ? projectKeys : Object.keys(state.projects || {});
    for (const key of captureKeys) {
      const proj = state.projects[key];
      if (!proj || isProjectOff(key, config)) continue;
      let isDir = false;
      try {
        isDir = fs.statSync(key).isDirectory();
      } catch {}
      if (!isDir) continue;
      try {
        // Cheap per-tick skip: one `git rev-parse HEAD`. When the cursor has
        // already caught up to HEAD, no commit can be new, so skip the heavier
        // `git log` backfill entirely. Draining a backlog is unaffected — the
        // cursor is behind HEAD then, so this guard is false and capture runs.
        // NOTE this only guards the NEW-commit walk below — it must NOT skip
        // settling (see settleProvisionalCommits above): events can arrive
        // without HEAD moving, and the commit that most needs settling is
        // usually the one that IS proj.lastCommitSha already.
        const head = commits.headSha(key);
        if (!(head && head === proj.lastCommitSha)) {
          const sinceSha = proj.lastCommitSha || commits.lastRecordedSha(key);
          // Per-pass cap: newCommitsSince's 50-commit bound covers only the
          // missing-cursor first run — a VALID cursor behind a big `git pull`
          // backlog is unbounded and would stall this sync pass on hundreds of
          // git subprocesses. The cursor advances through each slice, so a
          // backlog drains across passes instead.
          const shas = commits.newCommitsSince(key, sinceSha).slice(0, 50);
          if (shas.length) {
            const recorded = new Set(commits.loadCommitMap(key).map(r => r.sha));
            // Authorship gate: only commits this machine's identity committed
            // may be attributed to a local session. A pulled teammate commit
            // (foreign committer email) — or any commit when user.email is
            // unset (fail closed) — is recorded unattributed-locally, never
            // falsely credited. A commit the daemon discovers HERE (not
            // through the hook) is attributed against events already merged
            // this very pass, so it is written settled, not provisional —
            // same reasoning as the hook's own settled-foreign-commit case.
            const localEmail = commits.gitUserEmail(key);
            for (const sha of shas) {
              if (!recorded.has(sha)) {
                const c = commits.readCommit(key, sha);
                const att = commits.isLocalCommitter(c.email, localEmail)
                  ? commits.attributeCommit(c.files, c.ts, proj.events || [], { projectPath: key })
                  : { sessions: [], unattributed: [...(c.files || [])] };
                commits.recordCommit(key, {
                  sha, ts: c.ts, project: key,
                  sessions: att.sessions, unattributed: att.unattributed,
                });
              }
              proj.lastCommitSha = sha;
            }
          }
        }
        settleProvisionalCommits(key, proj);
      } catch (err) {
        log(`commit capture error for ${key}: ${err.message}`);
      }
    }
  }

  if (!opts.dryRun) saveState(state);
  return { newEvents: events.length + distilled.length, projects: projectKeys, changes, skipped };
}

module.exports = { readNewLines, getAdapters, scanAll, scanSummaries, syncOnce, findProjectKey, trackedRoots, filterTrackedSessions };
