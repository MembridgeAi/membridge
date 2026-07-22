'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, loadState, saveState, walkFiles, isProjectOff, isTempPath, normPath, log, effectiveTargets } = require('./util');
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
// commit time. The daemon is the authority instead: once it can PROVE its
// view of the relevant evidence is complete, it re-runs attributeCommit over
// fresh events and appends a settled row (provisional:false) —
// loadCommitMap's dedupe then always prefers it over the stale provisional
// one, never the other way around (see commitRank in lib/commits.js).
//
// What "caught up" actually means — the guarantee is PER SESSION FILE, not
// global. A single session's events come from its own JSONL file(s), read
// sequentially by byte offset (readNewLines above): WITHIN one session, a
// scanned event at time T proves every earlier event of that session was
// scanned too. ACROSS sessions there is no such order — files are discovered
// and drained independently, so session C's event from five seconds after
// the commit can be scanned while session B's edit from two seconds before
// it still sits unread in B's own file. A global newest-event-ts gate is
// therefore unsound: an unrelated session's newer event says NOTHING about
// whether the committing session's edits were scanned, and settling on it
// would permanently credit whatever stale evidence happens to be in state
// (or settle unattributed). Hence two gates:
//
//   • Settle ATTRIBUTED (attributeCommit credits session S) — fast path:
//     when S's OWN newest scanned event is newer than the commit, settle at
//     once — the per-session sequential-read guarantee proves S's evidence
//     at or before the commit is complete. While S's own events do NOT yet
//     pass the commit, stay provisional — S's still-unscanned edits are
//     exactly the pending evidence — BUT with a bounded escape: once the
//     GLOBAL newest scanned event is more than SETTLE_GRACE_MS past the
//     commit, settle WITH the current attribution (to S). Without the
//     escape, a session whose LAST act was the commit (edits scanned, then
//     commit, then the chat ends — the normal review-and-commit workflow)
//     could never satisfy the own-event gate: the row would stay pending
//     forever, and worse, once the bounded events window eventually evicted
//     S's edits, attributeCommit would credit nobody and the no-candidate
//     grace below would settle the row PERMANENTLY unattributed — destroying
//     provenance the daemon had already scanned. The escape is sound by the
//     same drain-lag argument the unattributed grace already accepts: a
//     grace window of data time vastly precedes event-cap eviction (hundreds
//     of events), so the escape converts "never settles / eventually wrong"
//     into "settles with the scanned attribution within one grace window".
//     NOTE the escape formally widens the documented A-active residual: past
//     the grace window a stale same-file session can be settled-credited
//     without any post-commit event of its own while the true author's file
//     still lags — but that now requires the author's file to lag a full
//     grace window of data time, which the same drain-lag analysis bounds
//     as far rarer than the every-commit starvation the escape removes.
//   • Settle UNATTRIBUTED (attributeCommit credits nobody): there is no
//     candidate whose file order can prove anything, so wait out the same
//     grace window — settle only once the newest scanned event (any
//     session) is more than SETTLE_GRACE_MS past the commit ts. The window
//     bounds the cross-file scan race (how far one session file's draining
//     can lag another's); it is deterministic — it compares two DATA
//     timestamps (event ts vs commit ts), never the wall clock, so a pass
//     replayed over the same data always decides the same way.
//
// Clock-corruption clamp: every gate above runs on DATA timestamps, so one
// corrupt event ts far in the future would satisfy every grace comparison
// instantly and void the window's protection (premature unattributed — or,
// via the escape, premature attributed — settling). Events whose ts claims
// to be more than SETTLE_TS_SANITY_MS in the future of the machine's OWN
// WALL CLOCK are ignored by the settle gates entirely — they still exist
// for attribution content, just not as catch-up proof. The anchor is the
// wall clock, never the pending commits' ts (see the constant's comment):
// past-tense events are always sane, no matter how long after the last
// commit they arrive.
//
// A commit with NO qualifying evidence yet simply stays provisional and is
// retried next pass — never force-settled, because "nothing matched so far"
// is indistinguishable from "not scanned yet".
//
// Runs every tick, independent of whether HEAD moved this tick — a
// provisional row can be left over from a commit the cursor already passed
// in an earlier pass — but costs nothing beyond one loadCommitMap (a plain
// fs read, no git) when there is nothing provisional, and calls git only for
// rows that are actually ready to settle. So the unchanged-HEAD tick's
// "avoid git entirely" cheapness is preserved for the common case (no
// provisional rows at all), while a provisional row is no longer starved by
// the unchanged-HEAD skip.
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

// How far (in DATA time: newest scanned event ts past the commit ts) the
// daemon must see before "no session touched these files" becomes a
// settleable answer rather than a scan-race guess. 15 minutes comfortably
// exceeds how long one session file's draining realistically lags another's
// (every file is re-walked each sync tick), while still settling a genuinely
// unattributable commit promptly.
const SETTLE_GRACE_MS = 15 * 60 * 1000;

// Sanity ceiling for event timestamps used as catch-up proof: an event whose
// ts claims to be more than this far in the FUTURE relative to the machine's
// own wall clock is treated as clock corruption and ignored by the settle
// gates (it cannot legitimately certify anything about scan progress). The
// anchor is the WALL CLOCK, deliberately not the newest pending commit's ts:
// anchoring to the commit froze settling across any legitimate >24h quiet
// gap (Friday-evening last-act commit, weekend, vacation, daemon off) by
// branding all post-gap REAL events corrupt — until the next local commit
// happened to move the anchor, which could be never, and which stretched the
// events-cap eviction window from minutes to days. Past-tense events are
// never clamped; only a timestamp from the machine's own future is
// corruption. 24h absorbs any real timezone/skew artifact while still
// rejecting the years-off garbage this guard exists for.
const SETTLE_TS_SANITY_MS = 24 * 60 * 60 * 1000;

// nowFn is injectable per house style (offline-deterministic tests); the
// daemon passes nothing and gets the real clock.
function settleProvisionalCommits(key, proj, nowFn = Date.now) {
  let map;
  try {
    map = commits.loadCommitMap(key);
  } catch (err) {
    log(`commit settle error for ${key}: ${err.message}`);
    return;
  }
  const pending = map.filter(r => commits.isProvisionalCommit(r));
  if (!pending.length) return;

  const tsCeiling = nowFn() + SETTLE_TS_SANITY_MS;

  // Newest SANE scanned event ts, global and per session — the per-session
  // map is what the attributed fast path leans on (see the header comment).
  let newestEventTs = -Infinity;
  const newestBySession = new Map(); // session id -> newest event ts (ms)
  for (const ev of proj.events || []) {
    const t = Date.parse(ev && ev.ts);
    if (!Number.isFinite(t) || t > tsCeiling) continue; // unparseable or corrupt-future: no catch-up proof
    if (t > newestEventTs) newestEventTs = t;
    const s = (ev && ev.session) || '';
    const prev = newestBySession.get(s);
    if (prev === undefined || t > prev) newestBySession.set(s, t);
  }

  for (const row of pending) {
    try {
      const rowTs = Date.parse(row.ts);
      // Cheap pre-gate: nothing scanned is newer than the commit at all, so
      // no gate below could pass — skip without touching git.
      if (!Number.isFinite(rowTs) || !(rowTs < newestEventTs)) continue;
      const c = commits.readCommit(key, row.sha);
      // A failed git read degrades to ts:null — do not let a transient git
      // hiccup settle this row into a bogus empty attribution; retry later.
      if (!c.ts) continue;
      const commitTs = Date.parse(c.ts);
      if (!Number.isFinite(commitTs)) continue;
      const att = commits.attributeCommit(c.files, c.ts, proj.events || [], { projectPath: key });
      const pastGrace = newestEventTs > commitTs + SETTLE_GRACE_MS;
      if (att.sessions.length) {
        // Attributed fast path: EVERY credited session's own events pass the
        // commit (a settled row is final, so a partially-proven attribution
        // waits whole). Otherwise the bounded escape: past the grace window,
        // settle with the current attribution rather than starve (see the
        // header comment — a session whose last act was the commit never
        // produces a post-commit event of its own).
        const caughtUp = att.sessions.every(s => {
          const own = newestBySession.get((s && s.session) || '');
          return own !== undefined && own > commitTs;
        });
        if (!caughtUp && !pastGrace) continue;
      } else if (!pastGrace) {
        continue; // no candidate: wait out the cross-file scan-race window
      }
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

// Provenance cleanup for codex-mislabeled history: Codex Desktop's history
// importer wrote OTHER tools' sessions (Claude Code / Cowork) as rollout-shaped
// files under ~/.codex/sessions, and the pre-gate adapter stamped every one of
// them 'Codex'. For each codex-tracked file with no gate verdict yet, re-read
// its first line from disk: a file failing codex.isGenuineRollout has its scan
// record dropped (offset 0, so the gated adapter re-decides — and skips it)
// and every 'Codex' event carrying that file's session id purged from every
// project; a passing file is stamped validated so pre-fix offsets keep
// working. Unreadable/missing files can't be judged and are left alone (fail
// closed against deleting possibly-genuine history). Scoped strictly by
// per-file validation — genuine Codex sessions on any project are untouched.
// Self-quiescing: every decided rec is skipped, so steady state is a no-op.
// First COMPLETE, non-blank line of a rollout, parsed. 1MB bound: genuine
// session_meta lines carry the full base instructions (~20KB observed) —
// headroom, not a hard shape limit. Anything unreadable/unparseable returns
// null = "cannot judge", which leaves the file and its events alone.
function readFirstRolloutEntry(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1048576);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf8');
      if (text.indexOf('\n') === -1) return null; // no complete line in bound
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) return JSON.parse(t); // first real line decides; parse failure -> null via catch
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function cleanupCodexMislabels(state, deps) {
  const readFirstEntry = (deps && deps.readFirstEntry) || readFirstRolloutEntry;
  const purged = [];
  for (const [file, rec] of Object.entries(state.files || {})) {
    if (!rec || rec.adapter !== 'codex') continue;
    const d = rec.data || {};
    if (d.foreign || d.validated) continue; // the gated adapter already decided
    const first = readFirstEntry(file);
    if (first === null) continue; // cannot judge: leave events and offsets alone
    if (codex.isGenuineRollout(first)) {
      rec.data = d;
      d.validated = true;
      continue;
    }
    delete state.files[file];
    purged.push(path.basename(file).replace(/\.jsonl$/, ''));
  }
  if (purged.length) {
    const bad = new Set(purged);
    for (const proj of Object.values(state.projects || {})) {
      if (!proj || !Array.isArray(proj.events)) continue;
      const before = proj.events.length;
      proj.events = proj.events.filter(e => !(e && e.source === 'Codex' && bad.has(e.session)));
      if (proj.events.length !== before) proj.dirty = true; // context blocks re-render clean
    }
  }
  return purged;
}

// Reverse migration for the history_mode gate bug: the old codex gate treated
// history_mode "legacy" as proof of an imported foreign session, but current
// Codex stamps "legacy" on GENUINE native sessions too. Those were marked
// foreign:true with their offsets fully consumed, so they stay black-holed even
// after the gate is fixed. For each foreign-marked codex file, re-read its first
// line and re-judge with the corrected isGenuineRollout: a now-genuine file has
// its scan rec dropped (offset 0, so the next scanAll re-reads and re-ingests
// it from the top); a truly-foreign file (Claude/Cowork originator) keeps its
// verdict and is flagged reopenChecked so it is never re-read again. Files that
// can't be read are left untouched (fail closed, retried next pass). Idempotent
// and self-quiescing: at steady state every foreign rec is either gone or
// flagged, so this is a no-op.
function reopenMislabeledForeignCodex(state, deps) {
  const readFirstEntry = (deps && deps.readFirstEntry) || readFirstRolloutEntry;
  const reopened = [];
  for (const [file, rec] of Object.entries(state.files || {})) {
    if (!rec || rec.adapter !== 'codex') continue;
    const d = rec.data || {};
    if (!d.foreign || d.reopenChecked) continue; // only foreign recs, once each
    const first = readFirstEntry(file);
    if (first === null) continue; // cannot judge: leave it, retry next pass
    if (codex.isGenuineRollout(first)) {
      delete state.files[file]; // re-scan from offset 0 re-decides + re-ingests
      reopened.push(path.basename(file).replace(/\.jsonl$/, ''));
    } else {
      d.reopenChecked = true; // genuinely foreign: stop re-reading it
      rec.data = d;
    }
  }
  return reopened;
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
  const summarySource = session => /^codex[-_]/i.test(session || '') ? 'Codex' : 'Distilled';
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
        source: summarySource(e.session),
        kind: 'summary',
        session: e.session,
        text: e.did.trim(),          // canonical outcome (= did), no longer a blob
        distilled: true,
      };
      const goal = str(e.goal), decisions = str(e.decisions), gotchas = str(e.gotchas), headline = str(e.headline);
      if (goal) ev.goal = goal;
      if (headline) ev.headline = headline;
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

// Drop throwaway work at capture, before homing, so it never mints or pollutes
// a project. Two levels:
//   1. every edit whose file is a temp/scratchpad path is dropped; and
//   2. a PURE-scratchpad session — one that had >=1 temp edit and NO real edit
//      — is dropped entirely (its prompt/summary too), so it leaves no residue
//      pinned to the cwd (the phantom "AI" card).
// A session with no temp edits at all (e.g. a real project's prompt-only
// planning session) is untouched. Pure function.
function filterScratchpadResidue(events) {
  const sawTemp = new Set(), sawReal = new Set();
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file) continue;
    (isTempPath(ev.file) ? sawTemp : sawReal).add(ev.session || '');
  }
  return events.filter(ev => {
    if (ev.kind === 'edit' && ev.file && isTempPath(ev.file)) return false;
    const s = ev.session || '';
    return !(sawTemp.has(s) && !sawReal.has(s));
  });
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
  const purgedCodex = cleanupCodexMislabels(state);
  if (purgedCodex.length && !opts.dryRun) log(`codex provenance cleanup: purged ${purgedCodex.length} imported session(s) mislabeled as Codex`);
  const reopenedCodex = reopenMislabeledForeignCodex(state);
  if (reopenedCodex.length && !opts.dryRun) log(`codex provenance repair: reopened ${reopenedCodex.length} genuine session(s) the old history_mode gate wrongly skipped`);
  const scanned = filterScratchpadResidue(scanAll(state, config));
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
    // An empty-but-DIRTY project must still render: a provenance purge can
    // empty a project whose context block already carries the purged asks —
    // skipping it would leave the block poisoned and the dirty flag stuck.
    if (!proj || (!proj.events.length && !proj.dirty)) continue;
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
            // The walk does NOT attribute — "events already merged this very
            // pass" is NOT proof the committing session's edits are among
            // them (the same cross-file scan race the settle gates exist
            // for: another session's file can be drained while the author's
            // still lags; and for daemon-off/backlog commits the evidence
            // may be minutes-to-days behind). A LOCAL commit discovered here
            // is recorded provisional, exactly like a hook-recorded one, and
            // the settle pass below (same tick and every tick after)
            // attributes it through the per-session/grace gates.
            //
            // Authorship gate: a pulled teammate commit (foreign committer
            // email) — or any commit when user.email is unset (fail closed)
            // — is recorded settled-unattributed at once, never provisional:
            // who committed is a stable fact, and never-provisional is what
            // guarantees a foreign commit can never settle into attributed.
            const localEmail = commits.gitUserEmail(key);
            for (const sha of shas) {
              if (!recorded.has(sha)) {
                const c = commits.readCommit(key, sha);
                const rec = {
                  sha, ts: c.ts, project: key,
                  sessions: [], unattributed: [...(c.files || [])],
                };
                if (commits.isLocalCommitter(c.email, localEmail)) rec.provisional = true;
                commits.recordCommit(key, rec);
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

module.exports = { readNewLines, getAdapters, scanAll, scanSummaries, syncOnce, findProjectKey, trackedRoots, filterTrackedSessions, filterScratchpadResidue, cleanupCodexMislabels, reopenMislabeledForeignCodex, SETTLE_GRACE_MS };
