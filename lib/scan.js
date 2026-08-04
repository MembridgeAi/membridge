'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, loadState, saveState, walkFiles, isProjectOff, isTempPath, normPath, log, effectiveTargets } = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const ledgerStore = require('./ledger-store');
const recallStore = require('./recall-store');
const diagnostics = require('./diagnostics');
const hooks = require('./hooks');
const mcpRegister = require('./mcp-register');
const blockSignature = require('./block-signature');
const commits = require('./commits');
const projectResolve = require('./project-resolve');
const repoRoot = require('./repo-root');
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

// PREVENT, DON'T REPAIR (see foldWorktreeProjects below, which stays only as
// a migration for state that predates this function). A git worktree is the
// SAME project as its main repo, so a session whose raw cwd IS a live linked
// worktree root must never be allowed to mint its own project key in the
// first place -- collapse it to the main repo right here, before ev.project
// is ever looked at by mergeEvents.
//
// Reuses project-resolve's worktreeMain (the same authoritative `.git`
// pointer check foldWorktreeProjects already trusts) rather than a second
// resolver. Deliberately narrower than that function's fallback: worktreeMain
// only answers for a worktree that still exists on disk, so a session whose
// worktree has since been deleted passes through unchanged here and keeps
// relying on foldWorktreeProjects' path-based fallback -- this function has
// no path-container heuristic of its own, and inventing one would risk
// collapsing a genuinely nested, unrelated project that merely sits under a
// "worktrees" directory name.
//
// Unconditional, exactly like foldWorktreeProjects' own identity rule: it does
// NOT check whether the main repo is already tracked. If it is not, the
// ingestion gate (isTrackedProject/filterTrackedSessions, which runs later in
// syncOnce) drops the event same as it always would have -- this function
// only decides WHICH path an event is judged against, never whether it
// survives.
function normalizeWorktreeProject(rawProject) {
  if (!rawProject) return rawProject;
  try {
    const abs = path.resolve(String(rawProject));
    return projectResolve.worktreeMain(abs) || abs;
  } catch {
    return rawProject;
  }
}

// The project a file's events belong to, WHERE AN ADAPTER HAPPENS TO PERSIST
// ONE, without re-reading the transcript. Returns null when it is unknowable
// cheaply, which is the common case and is why the caller below fails safe.
//
// Codex carries the cwd across lines in rec.data (its rollout header arrives
// before the user messages, so the adapter has to persist it), which makes its
// files attributable for free. Claude Code does not: it takes the project from
// each entry's own `cwd` field and persists nothing about it, so the only way
// to attribute one of its transcripts is to read it. Distilled summaries are
// exact rather than heuristic, and are handled by the caller through
// hooks.summariesPath, which is the same mapping scanSummaries writes with.
function storedFileProject(rec) {
  const cwd = ((rec && rec.data) || {}).cwd;
  return typeof cwd === 'string' && cwd ? cwd : null;
}

// Backfill on adoption (alpha readiness F3). scanAll advances offsets for every
// file it touches, including files belonging to projects that are not tracked
// yet, and filterTrackedSessions runs afterwards. So a project's history is
// already consumed by the time a user adopts it, and deleteProject's comment
// states the consequence: only future activity revives it.
//
// USES THE PLAN'S DOCUMENTED FALLBACK, not per-file attribution. Per-file
// attribution is not determinable before scanning for the Claude Code adapter,
// which is the primary one (see storedFileProject above). Rather than
// reimplementing the scanner's cwd resolution -- which would let adoption and
// ingestion disagree about where a session lives, the exact failure
// isTrackedProject's comment says was already fixed once -- this clears every
// file whose attribution is unset or points somewhere untracked, and clears
// NOTHING attributed to a project that was already tracked before this call.
//
// Re-reading an already-ingested file is safe but not free: mergeEvents dedupes
// on eventKey seeded from what is already stored, so re-ingesting produces no
// duplicates while those events remain in proj.events. It is a sliding window,
// so a file whose events have aged out of it could re-add them. That is why the
// keep-set below exists rather than simply clearing everything.
//
// The once-only offset invariant for the STEADY state is untouched: this runs
// at adoption only, never on a sync pass.
function resetOffsetsForAdoption(state, adoptedRoot) {
  const adopted = normPath(path.resolve(String(adoptedRoot)));
  // Every tracked project EXCEPT the one being adopted. The adopted root's own
  // files are exactly what must be re-read.
  const keep = new Set();
  const keepSummaryFiles = new Set();
  for (const key of Object.keys(state.projects || {})) {
    if (normPath(key) === adopted) continue;
    keep.add(normPath(key));
    try { keepSummaryFiles.add(normPath(hooks.summariesPath(key))); } catch {}
  }
  const cleared = [];
  for (const [file, rec] of Object.entries(state.files || {})) {
    // A distilled-summaries file names its project in its own path, so this
    // one is exact: never re-read another project's summaries.
    if (keepSummaryFiles.has(normPath(file))) continue;
    const proj = storedFileProject(rec);
    if (proj && keep.has(normPath(normalizeWorktreeProject(path.resolve(proj))))) continue;
    delete state.files[file]; // dropping the rec re-scans from byte 0
    cleared.push(file);
  }
  return cleared;
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
            if (ev.project) {
              // A relative edit file (the config-driven custom adapter can log
              // one) is resolved against the RAW cwd first, so it still points
              // at the file that was actually edited -- inside the worktree
              // checkout -- and not at a same-named file under the main repo
              // the project key is about to be normalized to.
              if (ev.file && !path.isAbsolute(ev.file)) {
                ev.file = path.resolve(String(ev.project), ev.file);
              }
              ev.project = normalizeWorktreeProject(ev.project);
            }
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
    // A read that starts at 0 is backfill — first adoption of an existing file,
    // or resetOffsetsForAdoption. Those lines are genuinely historical, so their
    // claimed ts is kept: collapsing a whole history to "now" is worse than
    // rough timestamps. Every later read is a line appended while the daemon was
    // running, which is where the real clock belongs (see the ts note below).
    const backfill = rec.offset === 0;
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
      // The Stop hook asks the AGENT for "ts":"<current UTC time>", and models
      // have no clock — they estimate. Observed: six consecutive round-number
      // values (03:05:00, 03:30:00, 04:05:00) on one machine, and backend rows
      // written minutes ago but stamped up to 299 minutes earlier. Trusting it
      // put teammates outside util.isLive's 15-minute window while they were
      // actively working, sorted their current work below older local work, and
      // dropped activity into the wrong api-insights window. The daemon reads
      // the line moments after it is written and DOES have a clock, so it stamps
      // ts itself. The claim is kept as claimedTs rather than dropped — a
      // checkpoint may legitimately describe earlier work — it just must not
      // drive ordering or liveness.
      const claimedTs = typeof e.ts === 'string' && e.ts ? e.ts : '';
      const ev = {
        ts: backfill && claimedTs ? claimedTs : new Date().toISOString(),
        project: key,
        source: summarySource(e.session),
        kind: 'summary',
        session: e.session,
        text: e.did.trim(),          // canonical outcome (= did), no longer a blob
        distilled: true,
      };
      const goal = str(e.goal), decisions = str(e.decisions), gotchas = str(e.gotchas), headline = str(e.headline);
      if (claimedTs && !backfill) ev.claimedTs = claimedTs;
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
// .membridge/ (the same definition project-resolve uses) — and is never the
// user's home directory, unconditionally (see isProtectedDir below). Anything
// else is dropped, so an arbitrary session cwd can never mint a new project; a
// multi-repo session keeps its tracked-root events while its untracked edits
// (left on the cwd by rehome) fall away. Defensive: a bad event or a failing
// disk check drops the event, never throws.
// The single definition of "tracked", shared by the ingestion gate below and
// by the dashboard's discovered-projects list. Both must agree on what
// adoption means, or the dashboard would offer to adopt something already
// tracked (or hide something that is not). Defensive: any failure is "not
// tracked", never a throw.
function isTrackedProject(projectPath, tracked, opts = {}) {
  const roots = tracked || new Set();
  const hasMembridge = opts.hasMembridge || (dir => {
    try { return fs.statSync(path.join(dir, memorydb.DIR_NAME)).isDirectory(); } catch { return false; }
  });
  // The user's home directory is never a project, full stop -- checked BEFORE
  // roots.has() so this overrides even an existing state.projects entry at
  // exactly the home path. Without that override, a key this bug already
  // minted on a live install (before this fix) would keep re-qualifying every
  // new home-cwd session forever via roots.has() alone, even once the
  // .membridge-marker false-positive below is closed. Reuses
  // project-resolve.js's isProtectedDir -- that file already carried this
  // exact guard for its own hasMembridge check; this inline copy predated it
  // and simply never got it, which is how the home directory started being
  // tracked in the first place. Injectable for tests, same as hasMembridge.
  const isProtectedDir = opts.isProtectedDir || projectResolve.isProtectedDir;
  try {
    const abs = path.resolve(String(projectPath));
    if (isProtectedDir(abs)) return false;
    return roots.has(normPath(abs)) || !!hasMembridge(abs);
  } catch {
    return false;
  }
}

function filterTrackedSessions(events, tracked, opts = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  const roots = tracked || new Set();
  const memo = new Map(); // project path -> tracked?
  const kept = [];
  for (const ev of events) {
    if (!ev || !ev.project) continue;
    const key = String(ev.project);
    if (!memo.has(key)) memo.set(key, isTrackedProject(key, roots, opts));
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

// Git worktrees are the SAME project as their main repo. MIGRATION ONLY as of
// the normalizeWorktreeProject step in scanAll above: a session's project key
// is now collapsed to the main repo BEFORE it ever reaches state.projects, so
// a worktree fragment can no longer be minted going forward. This function
// stays to repair state that ALREADY has fragments -- pre-existing installs,
// or a worktree that was deleted from disk before it was ever scanned once
// (normalizeWorktreeProject only resolves a LIVE worktree; it has no path
// fallback of its own, deliberately, so it never risks collapsing a genuine
// nested project). Fold each such entry's events back into the main repo's
// project (deduped via mergeEvents) and drop the fragment, so the feed,
// context block, team push and ops-noise filter all see one project.
// Idempotent — once folded the fragment key is gone, and in steady state
// (nothing left to migrate) this is a no-op every pass. Detection is
// authoritative from the worktree's `.git` pointer while it exists on disk,
// with a path fallback (a `worktrees`/`.worktrees` container segment under an
// existing project) for worktrees already deleted from disk. Only ever folds
// into an EXISTING project, never mints one. Returns [{from, to}] folded.
function foldWorktreeProjects(state, config) {
  const projects = (state && state.projects) || {};
  const keyByNorm = new Map(Object.keys(projects).map(k => [normPath(k), k]));
  const mainKeyOf = K => {
    const disk = projectResolve.worktreeMain(K); // main repo root path, if a live worktree
    if (disk) {
      const mk = keyByNorm.get(normPath(disk));
      return mk && normPath(mk) !== normPath(K) ? mk : null; // fold only into an existing main
    }
    // Deleted worktree: fall back to the nearest ancestor project, but only when
    // the path sits in a worktrees container (never fold a real nested project).
    const segs = normPath(K).split(path.sep);
    if (!segs.includes('worktrees') && !segs.includes('.worktrees')) return null;
    let dir = path.dirname(K);
    for (;;) {
      const hit = keyByNorm.get(normPath(dir));
      if (hit && normPath(hit) !== normPath(K)) return hit;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  // Fold targets are resolved against a snapshot of the ORIGINAL keys, so a
  // nested fragment (…/worktrees/wt/web) can name a parent fragment (…/wt)
  // that this same pass is about to fold away and delete. Merging into it then
  // RE-CREATES the deleted key, leaving a worktree behind as its own project —
  // exactly what the fold exists to prevent. So chase each target through the
  // chain to one that is not itself folding, with a seen-set so a pathological
  // cycle terminates instead of spinning.
  const immediate = new Map();
  for (const K of Object.keys(projects)) {
    try { immediate.set(K, mainKeyOf(K)); } catch { immediate.set(K, null); }
  }
  const finalTargetOf = K => {
    let t = immediate.get(K);
    if (!t) return null;
    const seen = new Set([normPath(K), normPath(t)]);
    for (;;) {
      const next = immediate.get(t);
      if (!next || seen.has(normPath(next))) return t;
      seen.add(normPath(next));
      t = next;
    }
  };

  const folded = [];
  for (const K of Object.keys(projects)) {
    const mKey = finalTargetOf(K);
    if (!mKey) continue;
    const moved = (projects[K].events || []).map(e => ({ ...e, project: mKey }));
    delete projects[K];
    if (moved.length) for (const t of digest.mergeEvents(state, moved, config)) {
      if (state.projects[t]) state.projects[t].dirty = true;
    }
    folded.push({ from: K, to: mKey });
  }
  return folded;
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
  const foldedWt = foldWorktreeProjects(state, config);
  if (foldedWt.length && !opts.dryRun) log(`worktree fold: merged ${foldedWt.length} worktree project(s) into their main repo`);
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

  // Block-recipe refresh (lib/block-signature.js). Everything above marks a
  // project because its own work changed; this marks one because the RECIPE
  // did -- a new MemBridge version, a newly enabled target, a new redaction
  // pattern -- none of which gives any project an event, so without this a
  // project the user has not opened in weeks keeps the old note forever.
  //
  // Deliberately NOT a widening of the dirty filter below: pendingRefresh
  // answers null once the signature it acted on is recorded, so this is a
  // one-shot on the rare tick where the recipe actually moved and silent on
  // every other. The mark and the record land in the same saveState at the end
  // of this pass, so a crash between them is not a state either can reach.
  // Fail-open: an undeterminable signature answers null and nothing happens.
  const refresh = blockSignature.pendingRefresh(state, config);
  if (refresh) {
    let refreshed = 0;
    for (const key of refresh.keys) {
      // Only projects that ALREADY carry a block: a changed recipe makes an
      // existing block stale, it does not make a project that never had one
      // want a block now. See block-signature.js's hasRenderedBlock.
      if (!state.projects[key] || !blockSignature.hasRenderedBlock(key, config)) continue;
      state.projects[key].dirty = true;
      refreshed++;
    }
    state[blockSignature.SIGNATURE_KEY] = refresh.signature;
    if (!opts.dryRun && refreshed) {
      log(`block recipe changed (${refresh.signature}): re-rendering ${refreshed} project(s) once`);
    }
  }

  let projectKeys;
  if (opts.project) {
    const key = findProjectKey(state, opts.project);
    projectKeys = key ? [key] : [];
  } else {
    projectKeys = Object.keys(state.projects || {}).filter(k => state.projects[k] && state.projects[k].dirty);
  }

  // Read once per pass, not once per project/target: lastRegistration() is a
  // state.json read, and the injected MCP-usage line (digest.mcpLiveFor)
  // needs only the rows, which never change mid-pass.
  let mcpRows = null;
  try { mcpRows = (mcpRegister.lastRegistration() || {}).rows || null; } catch { mcpRows = null; }

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
    // The project root PLUS every linked worktree of it. A worktree is another
    // working copy of this same project (project-resolve.js already credits its
    // work here), and an agent running there reads ITS OWN directory for
    // context -- so a block written only at the root never reaches that agent.
    // See lib/repo-root.js's linkedWorktreesOf.
    //
    // The block is rendered ONCE against `key`: every copy is byte-identical
    // and describes the project, not the directory it happens to sit in.
    //
    // A worktree gets the same pause/exclude gate as any other path, so
    // excluding a scratch worktree keeps it clean.
    const injectDirs = [key];
    for (const wt of repoRoot.linkedWorktreesOf(key)) {
      if (!isProjectOff(wt, config)) injectDirs.push(wt);
    }
    for (const target of effectiveTargets(config)) {
      const block = digest.renderBlock(key, proj, config, target, sessions, mcpRows);
      for (const dir of injectDirs) {
        const file = path.join(dir, target);
        if (opts.dryRun) {
          changes.push({ file, action: 'would update' });
        } else if (digest.inject(file, block, digest.preambleFor(target))) {
          changes.push({ file, action: 'updated' });
        }
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
    // Token ledger: same trigger as the memory update above (a real sync
    // pass, not a dry run), so it stays cheap -- folded once per project per
    // dirty pass, not on every poll. proj.events is a sliding window, so this
    // ACCUMULATES onto the persisted ledger rather than rebuilding from what
    // happens to be in the window (see lib/ledger-fold.js). Best-effort like
    // the memory update: a write failure here must not block the rest of the
    // sync.
    if (!opts.dryRun) {
      let freshLedger = null;
      try {
        freshLedger = ledgerStore.updateLedger(key, proj.events || [], config);
      } catch (err) {
        log(`ledger write error for ${key}: ${err.message}`);
      }
      // Pre-warm the recall store off the ledger's OWN hot set, right after
      // it was written -- this is what actually populates
      // .membridge/recall/ for the PreToolUse hook to serve from; before this
      // wiring nothing ever called warm() in production. warm() is async
      // (it awaits skeletonize() per path) while syncOnce itself is
      // synchronous and called from many places that expect a plain return
      // value, so this is deliberately fire-and-forget: errors are caught
      // via .catch(), never thrown back into syncOnce, matching the
      // best-effort contract the ledger write above already has. A failed
      // or skipped ledger write (freshLedger still null) leaves nothing to
      // warm from, so this is skipped entirely rather than warming a stale
      // or empty hot set.
      if (freshLedger) {
        try {
          recallStore.warm(key, freshLedger.hotPaths || [], config)
            .catch(err => log(`recall warm error for ${key}: ${err.message}`));
        } catch (err) {
          log(`recall warm error for ${key}: ${err.message}`);
        }
        // Net-negative auto-report (spec §7.1/§8.5, Task 9): if this
        // project's lifetime direct-avoidance total has gone negative with
        // enough serves behind it, pause recall for it and (best-effort)
        // report one anonymous diagnostic. checkNetNegative is itself
        // fail-open and idempotent per project -- this try/catch is
        // defense in depth, matching every other ledger-adjacent call in
        // this loop.
        try {
          diagnostics.checkNetNegative(key, freshLedger, config);
        } catch (err) {
          log(`diagnostics error for ${key}: ${err.message}`);
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

  // Feedback value-moment counter (local-only, no telemetry, no printing here):
  // count this pass's real context-file amendments (an 'updated' write whose
  // basename is a configured target — CLAUDE.md/AGENTS.md, never memory.md/db)
  // into state.feedback.amendments. Logic is inlined rather than imported from
  // lib/prompts.js to keep scan.js free of a require cycle. The next
  // TTY-attached command surfaces message B once the count reaches 5.
  if (!opts.dryRun && state.feedback && !state.feedback.valueShown) {
    const targets = new Set(effectiveTargets(config));
    let n = 0;
    for (const c of changes) {
      if (c && c.action === 'updated' && targets.has(path.basename(c.file || ''))) n++;
    }
    if (n > 0) state.feedback.amendments += n;
  }

  // Confirm-in-sync pass. A full sync only VISITS dirty projects (projectKeys
  // above), so a project that goes clean has its lastSync frozen at whatever
  // it was — the daemon never touches it again until new work arrives. That
  // froze the one comparison every consumer uses to answer "is my work
  // captured?": the app's sync badge, `membridge status`, and the MCP project
  // metadata all read lastActivity against lastSync. When the pass that
  // cleared `dirty` also consumed the burst's final activity, lastActivity
  // ended up newer than the frozen lastSync and STAYED there, so the UI showed
  // "behind" with a Sync now button indefinitely on a project that was in fact
  // fully synced. (Observed live: a project stuck behind across repeated ticks
  // that only an explicit per-project sync could clear — that path builds
  // projectKeys from the request, so it reaches the project the timer skips.)
  //
  // `dirty` is the authoritative "has unrendered work" flag, maintained by
  // mergeEvents above. Not dirty therefore means in sync, and saying so is a
  // statement about work we just checked, not an unearned success flag.
  // Deliberately scoped to the full sweep: a project-scoped sync must not
  // stamp projects it never looked at. Paused/excluded projects are not
  // synced at all, so they must keep their real (stale) stamp.
  if (!opts.dryRun && !opts.project) {
    const now = new Date().toISOString();
    for (const key of Object.keys(state.projects || {})) {
      const proj = state.projects[key];
      if (!proj || proj.dirty) continue;
      if (isProjectOff(key, config)) continue;
      proj.lastSync = now;
    }
  }

  if (!opts.dryRun) saveState(state);
  return { newEvents: events.length + distilled.length, projects: projectKeys, changes, skipped };
}

module.exports = { readNewLines, getAdapters, scanAll, scanSummaries, syncOnce, resetOffsetsForAdoption, findProjectKey, trackedRoots, isTrackedProject, filterTrackedSessions, filterScratchpadResidue, foldWorktreeProjects, cleanupCodexMislabels, reopenMislabeledForeignCodex, SETTLE_GRACE_MS };
