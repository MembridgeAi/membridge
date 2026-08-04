'use strict';
// Session distillation via Claude Code's Stop hook: as a session accumulates
// edits, the hook blocks the stop and asks the agent to append a checkpoint
// line to <project>/.membridge/summaries.jsonl. scan.js merges those lines
// back as high-quality kind:'summary' events (source 'Distilled').
//
// Staleness, not one-shot: the first checkpoint is asked at minEdits edits,
// and another every checkpointEvery edits after that — so a long session
// keeps its summary current instead of freezing on an early note. The hook
// only ever blocks once per stop cycle (the loop guard below).
//
// Contract (verified against docs.claude.com/en/docs/claude-code/hooks):
// the Stop hook receives a JSON payload on stdin — session_id, cwd,
// transcript_path and the top-level stop_hook_active loop guard — and blocks
// by printing {"decision":"block","reason":"..."} to stdout and exiting 0.
// A plain exit 0 with no output allows the stop.
//
// Everything in the hook path fails OPEN: a MemBridge bug must never trap a
// user's Claude Code session, so any internal error is logged and the stop
// is allowed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const memorydb = require('./memorydb');
const projectResolve = require('./project-resolve');
const { defaultRunGit } = require('./changes');
// The PreToolUse recall hook body lives in its own module (this file was
// already pushing 800 lines): see lib/hooks-recall.js for runRecall() itself
// and docs/superpowers/plans/2026-07-28-recall-saving-layer.md (Task 5) for
// the contract. Only its settings.json registration (setup-hooks/remove-hooks,
// alongside the Stop hook below) lives here, since that machinery is shared.
const { runRecall } = require('./hooks-recall');

const SUMMARIES_FILE = 'summaries.jsonl';
const summariesPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, SUMMARIES_FILE);

// Hard character cap for the distilled headline. The Activity card renders the
// headline verbatim on its glance line — it must fit without truncation, so
// blockReason asks for this budget and runAppend enforces it; anything longer
// belongs in did, which readers see when they open the card. Kept under the
// dashboard's 90-char display guard (capLine) so compliant headlines are never
// touched by any truncation path.
const HEADLINE_MAX = 80;

// Hard character cap for the distilled goal (the session's INTENT). Without
// a budget, agents restated the whole prompt verbatim -- a 10-person team's
// Intent column read as ten paragraphs where it should read as ten phrases.
// Enforced in runAppend exactly the way HEADLINE_MAX is; the field itself
// stays optional. Backward compatible: over-long goals already on disk still
// render, clipped at display.
//
// Raised from 70 to 180 (owner call, 2026-08-03). 70 bought a phrase, and a
// phrase under a general headline left the reader with no middle step: the
// header says the shape of the work and the bullets say the specifics, so the
// intent is the one place that can say what the session was actually for. Two
// sentences is the budget for that. The UI clips at INTENT_MAX (160) and
// renders a disclosure control when it does, so a goal at this cap costs no
// vertical space on the card.
const GOAL_MAX = 180;

// Per-point and per-field budgets for `decisions` and `gotchas`, which the
// session page renders as ONE bulleted list (ui/.../distill.ts whatBullets).
//
// These two fields were the only distilled text with no budget at all, and it
// showed: headline and goal were capped from the start while decisions
// routinely arrived as 800-character paragraphs, which is exactly what the
// brief widgets were reported as unreadable for. Nothing downstream can fix
// that, because no renderer can shorten a paragraph without hiding a
// teammate's reasoning behind a control they have no reason to open. The only
// place a paragraph can be prevented is the ask.
//
// One point per line, so the reader gets a list and not a wall. Enforced in
// runAppend the way the other two budgets are: loud, agent-facing, and
// correctable inside the same summary turn.
const POINT_MAX = 120;
const POINTS_MAX = 4;

// Env override so tests never touch the real ~/.claude/settings.json.
function claudeSettingsPath() {
  return process.env.MEMBRIDGE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

// How many usable checkpoint lines summaries.jsonl already holds for this
// session (session matches, did is a non-empty string). Malformed JSON lines
// count as absent — the agent is simply asked again.
function countSummaryLines(projectPath, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(summariesPath(projectPath), 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.session === sessionId && typeof e.did === 'string' && e.did.trim()) n++;
    } catch {
      // malformed line: ignore
    }
  }
  return n;
}

// Retained for callers that only care whether any checkpoint exists.
function hasSummaryLine(projectPath, sessionId) {
  return countSummaryLines(projectPath, sessionId) > 0;
}

// Timestamp of the NEWEST usable checkpoint for this session, or null if it
// has none. Read from the file rather than tracked in state.json for the same
// reason countSummaryLines is: the daemon owns state.json and the hook writes
// nothing. Same usability rule as countSummaryLines — a line with no `did` was
// never a checkpoint, so it must not move the cursor either.
function lastSummaryTs(projectPath, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(summariesPath(projectPath), 'utf8');
  } catch {
    return null;
  }
  let newest = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (!e || e.session !== sessionId) continue;
      if (typeof e.did !== 'string' || !e.did.trim()) continue;
      if (typeof e.ts !== 'string' || !e.ts) continue;
      // Do not assume the file is chronological: append order is the agent's
      // clock, and a resumed session can write a line stamped before one
      // already on disk.
      if (newest === null || tsAfter(e.ts, newest)) newest = e.ts;
    } catch {
      // malformed line: ignore
    }
  }
  return newest;
}

// Chronological "a is after b" for ISO stamps of mixed precision. Whole-second
// and millisecond stamps both occur here ('...:00Z' vs '...:00.500Z'), and
// string comparison orders those wrongly because '.' sorts before 'Z'. Falls
// back to string order only when a stamp will not parse.
function tsAfter(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return String(a) > String(b);
}

// Is a checkpoint due for this session? Pure, so the gate is testable without
// a clock, a daemon or a real session.
//
// The rule is EDITS SINCE THE LAST CHECKPOINT, never a cumulative total. The
// cumulative form this replaces (`edits >= minEdits + n * checkpointEvery`)
// compared a monotonic counter — n, the lines already appended, which nothing
// ever prunes — against an edit count that is NOT monotonic in practice. Once
// the two diverged the threshold could never be met again and distillation for
// that session stopped for good, with no error: failing the gate is a plain
// return. One real session reached n=8 with 29 edits, so it was being asked
// for 97. See the regression test in test/run-tests.js.
function isCheckpointDue({ editTs, lastCheckpointTs, minEdits, every }) {
  const edits = Array.isArray(editTs) ? editTs : [];
  const floor = Number.isFinite(minEdits) ? minEdits : 1;
  const step = Number.isFinite(every) && every >= 1 ? every : 12;
  if (!lastCheckpointTs) return edits.length >= floor;
  let since = 0;
  for (const ts of edits) if (typeof ts === 'string' && tsAfter(ts, lastCheckpointTs)) since++;
  return since >= step;
}

// n is the count of checkpoints already written for this session. Every
// checkpoint asks for a CUMULATIVE line — the whole session so far, newest
// line wins on every render surface. The prompt leads with the product's
// purpose and repeats it per field: everything written here is read by a
// TEAMMATE who was not in the session and needs what was done and WHY —
// project outcomes and reasoning, never AI activity. Delivery is discreet:
// one pre-approved append command (see runAppend / appendAllowRule), no
// commentary, so the summary turn is a single quiet tool call.
function blockReason(target, sessionId, n) {
  const scope = n > 0
    ? `summarize the whole session so far — this line supersedes the ${n} earlier line${n === 1 ? '' : 's'} already written for this session (never modify existing lines; just append)`
    : 'summarize the whole session so far';
  // Claude Code renders ANY Stop-hook block under its own fixed header,
  // `Stop hook blocking error from command: "<cmd>":`, and there is no field a
  // synchronous hook can send to soften it (rewakeMessage/rewakeSummary are
  // async-rewake, plugin-only). Verified against the 2.1.220 binary. The reason
  // text is the first thing the user reads after that header, so it opens by
  // naming MemBridge and saying this is normal -- otherwise every session looks
  // like our product just failed.
  return 'MemBridge is working normally — this is not an error. MemBridge pauses the stop so this summary gets written. ' +
    'MemBridge shares the summary with the user\'s teammates and their AI tools — ' +
    'every field is read by a team member who was not in this session and needs to understand what was done and why. ' +
    'Before stopping, save the summary by running exactly ONE command — ' +
    'no commentary before or after it, and do not restate the summary in your reply: ' +
    `${hookCommand()} append ${quoteArg(target)} '<json>' ` +
    `where <json> is ONE line: {"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","goal":"...","did":"...","headline":"...","decisions":"...","gotchas":"...","highlights":[{"file":"<path>","note":"..."}]} ` +
    'Pass the JSON as a single shell argument inside the single quotes; if any value contains an apostrophe, escape it for the shell as ' + String.raw`'\''` + ' (the command fails loudly if mis-quoted, so fix the quoting and re-run). ' +
    `— goal: the intent behind the session in your own words, 1-2 sentences, at most ${GOAL_MAX} characters — what this work was FOR, one step more specific than the headline; never restate the prompt (it is already captured verbatim), or ""; ` +
    `did: 1-2 plain-text sentences that ${scope}, phrased as what changed in the project from a teammate's point of view (the outcome), never a list of files edited or tools run; ` +
    `headline: the general shape of the session, at most ${HEADLINE_MAX} characters — the line a teammate reads at a glance to know roughly what you were on, like "Worked on UI fixes, app install and dmg"; the specifics belong in decisions, not here; it renders verbatim on a card that never truncates, or ""; ` +
    `decisions: what you did and why, as SHORT BULLETS, one per line, at most ${POINTS_MAX} lines of at most ${POINT_MAX} characters each — each line one completed piece of work or one choice made, phrased so a teammate can skim the list and know what happened, like "Added a back button to the day cards in Feed"; never a paragraph, or ""; ` +
    `gotchas: surprises or pitfalls hit, same shape — SHORT BULLETS, one per line, at most ${POINTS_MAX} lines of at most ${POINT_MAX} characters each, written so a teammate does not hit them again, or ""; ` +
    'highlights: up to 2 of the most important files with a short note each on why they matter, or []. ' +
    'Write for a teammate catching up on what was done and why — plain language, no markdown, nothing they do not need. Then stop again.';
}

// `membridge-hook.js append <target> '<json-line>'` — the canonical summary
// write named by blockReason and auto-approved by the setup-hooks allow rule.
// Because that rule pre-approves this command, it must be safe by
// construction: validate everything, only ever append one normalized line,
// and only to a .membridge/summaries.jsonl path. Unlike the stop path this
// fails LOUD (non-zero + stderr): it is agent-facing, and a clear error lets
// the agent correct the line and retry inside its summary turn.
function runAppend(argv) {
  const fail = msg => { process.stderr.write(msg + '\n'); process.exitCode = 1; };
  const [target, line] = argv || [];
  const suffix = path.join(memorydb.DIR_NAME, SUMMARIES_FILE);
  if (!target || !line) return fail(`usage: membridge-hook.js append <path ending in ${suffix}> '<json-line>'`);
  // Segment-anchored, not a suffix match: endsWith would accept a decoy like
  // `evil.membridge/summaries.jsonl`. Resolve, then require the last two path
  // segments to be exactly memorydb.DIR_NAME / SUMMARIES_FILE. This is the
  // SOLE safety gate once the append:* Bash rule auto-approves the command.
  const resolved = path.resolve(target);
  if (path.basename(resolved) !== SUMMARIES_FILE || path.basename(path.dirname(resolved)) !== memorydb.DIR_NAME) {
    return fail(`refusing to write: target must be a ${suffix} file`);
  }
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return fail('invalid JSON: pass exactly one JSON object as a single argument');
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail('invalid JSON: expected a JSON object');
  if (typeof e.session !== 'string' || !e.session.trim()) return fail('invalid line: "session" must be a non-empty string');
  if (typeof e.did !== 'string' || !e.did.trim()) return fail('invalid line: "did" must be a non-empty string');
  if (e.headline !== undefined && typeof e.headline !== 'string') return fail('invalid line: "headline" must be a string when present');
  const hl = typeof e.headline === 'string' ? e.headline.trim() : '';
  if (hl.length > HEADLINE_MAX) {
    return fail(`invalid line: "headline" is ${hl.length} characters, max ${HEADLINE_MAX} — the card shows it verbatim. Shorten it to the single glance outcome; the longer story belongs in "did".`);
  }
  if (e.goal !== undefined && typeof e.goal !== 'string') return fail('invalid line: "goal" must be a string when present');
  const goal = typeof e.goal === 'string' ? e.goal.trim() : '';
  if (goal.length > GOAL_MAX) {
    return fail(`invalid line: "goal" is ${goal.length} characters, max ${GOAL_MAX} — write the session's intent in your own words as 1-2 sentences, never a restated prompt. The verbatim prompt is already captured; "goal" is the why behind it.`);
  }
  // decisions and gotchas render as one bulleted list on the session page, so
  // they are validated per LINE rather than as one blob: a single 800-char
  // paragraph passes any whole-field length check that is generous enough to
  // hold four real bullets, which is exactly how the unreadable ones got in.
  for (const field of ['decisions', 'gotchas']) {
    const v = e[field];
    if (v !== undefined && typeof v !== 'string') return fail(`invalid line: "${field}" must be a string when present`);
    const points = typeof v === 'string' ? v.split('\n').map(s => s.trim()).filter(Boolean) : [];
    if (points.length > POINTS_MAX) {
      return fail(`invalid line: "${field}" has ${points.length} points, max ${POINTS_MAX} — keep the ones a teammate must know and drop the rest. One point per line.`);
    }
    const over = points.find(p => p.length > POINT_MAX);
    if (over) {
      return fail(`invalid line: a "${field}" point is ${over.length} characters, max ${POINT_MAX} — write it as a short bullet a teammate can skim, one completed piece of work or one choice per line, never a paragraph.`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, JSON.stringify(e) + '\n'); // re-stringified: guaranteed one line
  } catch (err) {
    return fail(`could not write summary line: ${err.message}`);
  }
}

// `membridge hook stop` — reads the Stop-hook payload from stdin and either
// allows the stop (exit 0, no output) or blocks it once with instructions.
function runStop() {
  try {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      return; // no/garbled payload: not a real hook invocation, allow
    }
    if (!payload || typeof payload !== 'object') return;
    // NEVER block twice: a prior block already asked for the summary.
    if (payload.stop_hook_active === true) return;

    const config = util.getConfig();
    const distill = config.distill || {};
    if (distill.enabled === false) return;

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    if (!cwd || !sessionId) return;

    const state = util.loadState();
    const scan = require('./scan'); // lazy: scan.js requires this module back
    // The session's edits may live under a project other than cwd (it was
    // launched elsewhere). Resolve the dominant tracked root from this
    // session's edit events; fall back to the cwd project.
    const tracked = scan.trackedRoots(state);
    // NOTE: this resolves dominance over the session's FULL accumulated edit
    // history, whereas scan.js re-homes each pass's events by that pass's
    // dominant root. For a rare multi-repo session whose edit balance flips
    // across daemon passes, the distilled summary lands in the overall-dominant
    // project while an earlier pass's prompt may sit under a different one.
    // Accepted: both are real roots the session touched; no data is lost.
    const allEvents = [];
    for (const pk of Object.keys(state.projects || {})) {
      for (const e of state.projects[pk].events || []) allEvents.push(e);
    }
    // Prefer the project the session's edits resolve to; canonicalize the
    // resolved root to its actual state.projects key (normPath match) and
    // fall back to the cwd project when it isn't a tracked project.
    let key = projectResolve.sessionDominantRoot(allEvents, sessionId, tracked);
    key = (key && scan.findProjectKey(state, key)) || scan.findProjectKey(state, cwd);
    if (!key || util.isProjectOff(key, config)) return; // untracked or paused: never nag

    // Worthiness gate: only sessions that actually changed files are worth a
    // summary. The daemon may not have scanned the tail of this session yet;
    // undercounting fails open (no block), never traps.
    const minEdits = Number.isFinite(distill.minEdits) ? distill.minEdits : 1;
    const editTs = (state.projects[key].events || [])
      .filter(e => e && e.kind === 'edit' && e.session === sessionId)
      .map(e => e.ts);

    // Staleness checkpoint: re-block once checkpointEvery edits have landed
    // SINCE the last checkpoint (see isCheckpointDue for why it is measured
    // that way and not cumulatively). n is still read, but only to tell the
    // agent how many earlier lines this one supersedes. Pure read — the
    // daemon owns state.json, so the hook writes nothing.
    // Keep this fallback in step with DEFAULT_CONFIG.distill in lib/util.js,
    // which explains why it is 12 and not something smaller. Configs written
    // before this key existed (or with it stripped) land here.
    const every = Number.isFinite(distill.checkpointEvery) && distill.checkpointEvery >= 1
      ? distill.checkpointEvery : 12;
    const n = countSummaryLines(key, sessionId);
    if (!isCheckpointDue({ editTs, lastCheckpointTs: lastSummaryTs(key, sessionId), minEdits, every })) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId, n) }) + '\n');
  } catch (err) {
    // fail open — log and allow the stop
    try {
      util.log(`hook stop error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

// `membridge hook post-commit` — the git post-commit hook body (provenance
// reconciliation): record HEAD for the tracked project containing cwd.
// Everything FAILS OPEN (return, exit 0, nothing on stdout): a git hook must
// never block or dirty a user's commit, so an untracked cwd, a paused
// project, an empty repo, or any internal error is at most a log line. Like
// runStop, this writes NOTHING to state.json — the daemon owns it; the
// sync-side recorded-shas check converges the cursor on the next pass.
//
// The hook NEVER attributes a commit itself anymore. It used to call
// attributeCommit here, against state.json as of commit time — but a commit
// usually lands seconds after the edits that produced it, before the next
// scan tick has read them, so state.json is STALE at exactly the moment the
// hook fires. Attributing from stale state risks crediting the WRONG
// session: if session A's old events are already in state and session B's
// fresh edits to the same file are not yet scanned, the hook would see only
// A's edit and permanently (recorded shas are never re-attributed) credit
// A for B's work. So a LOCAL commit is recorded PROVISIONALLY — sessions:[],
// unattributed: its files, provisional:true — and the daemon settles it once
// its events have caught up past the commit (lib/scan.js,
// settleProvisionalCommits), always attributing from FRESH events, so it is
// always correct.
//
// Authorship gate placement (the one place the hook still decides anything):
// a commit not committed by this machine's identity (a pulled teammate
// commit, or any commit when user.email is unset — fail closed) is recorded
// unattributed-locally and SETTLED (no provisional flag) immediately, never
// provisional. This is deliberate, not an oversight: "is this commit's
// committer my local identity" is knowable and stable right now — no amount
// of future scanning changes who committed it — so there is nothing to defer.
// It also makes the settle step simpler and airtight: because a foreign
// commit is NEVER written provisional, settleProvisionalCommits never needs
// to re-check the authorship gate — by construction, everything it finds
// provisional already passed the gate as a local commit.
function runPostCommit() {
  try {
    const state = util.loadState();
    const config = util.getConfig();
    const commits = require('./commits');
    // Probe with a child of cwd: resolveRoot walks from the file's dirname.
    const hit = projectResolve.resolveTrackedKey(state, path.join(process.cwd(), '_'));
    if (!hit || util.isProjectOff(hit.key, config)) return;
    const sha = commits.headSha(hit.key);
    if (!sha) return;
    if (commits.loadCommitMap(hit.key).some(r => r.sha === sha)) return; // already recorded
    const c = commits.readCommit(hit.key, sha);
    if (!commits.isLocalCommitter(c.email, commits.gitUserEmail(hit.key))) {
      commits.recordCommit(hit.key, {
        sha, ts: c.ts, project: hit.key,
        sessions: [], unattributed: [...(c.files || [])],
      });
      return;
    }
    commits.recordCommit(hit.key, {
      sha, ts: c.ts, project: hit.key,
      sessions: [], unattributed: [...(c.files || [])],
      provisional: true,
    });
  } catch (err) {
    try {
      util.log(`hook post-commit error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// setup-hooks / remove-hooks: register the Stop hook in ~/.claude/settings.json.
// This file belongs to the user and may carry hooks MemBridge knows nothing
// about, so the rules are strict: never overwrite or reorder existing
// entries, preserve every unknown key, refuse to touch a file that does not
// parse, and only ever add/remove entries containing 'membridge'. Explicit
// opt-in command only — the daemon never installs this by itself.
// ---------------------------------------------------------------------------

// Beta-specific discriminator. A stable MemBridge install registers its own
// Stop hook whose command also contains the word "membridge", so matching
// that bare word would make `membridge remove-hooks` rip out stable's
// entry (and setup-hooks rewrite it as a stale path). Keying on the hyphenated
// "membridge" token keeps the original broad intent — it matches both our
// shim path and a PATH-style `membridge hook stop` command — while never
// matching stable, whose command carries `membridge-hook.js` with no `-beta`.
const BETA_TOKEN = 'membridge';
const HOOK_SCRIPT = 'membridge-hook.js';
const mentionsMembridge = v => JSON.stringify(v).toLowerCase().includes(BETA_TOKEN);

// The hook command must run without `membridge` on PATH: GUI-launched Claude
// Code sessions get a minimal PATH, and app-only installs never have a global
// CLI at all. So the command is absolute — the current runtime binary plus
// lib/membridge-hook.js, which ships in every install layout (git checkout,
// npm -g, and the app's asar; the packaged app bundles lib/ but not bin/).
// Under Electron, ELECTRON_RUN_AS_NODE makes the app binary act as plain
// Node while keeping its asar read support, so the same command shape works
// from inside the packaged app.
const quoteArg = s => `"${s}"`;
// The one place our own hook script's location is decided. Env-overridable so
// the durability rules below can be exercised without a second real install.
function hookScriptPath() {
  return process.env.MEMBRIDGE_HOOK_SCRIPT || path.join(__dirname, 'membridge-hook.js');
}

function hookCommand() {
  const prefix = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}${quoteArg(process.execPath)} ${quoteArg(hookScriptPath())}`;
}

// ---------------------------------------------------------------------------
// Which install owns the hook registration.
//
// There is ONE ~/.claude/settings.json, but the command written into it is an
// absolute path into whichever copy of MemBridge ran setup-hooks last. That
// used to be a plain last-writer-wins race, which costs a real user in two
// ways: a throwaway copy (an `npx` cache, a trial clone, the app launched from
// its DMG) silently takes the registration off their real install; and when
// that copy is cleaned up the registration points at nothing. Because the hook
// path fails OPEN by design, a dead registration raises no error at all --
// summaries just stop while the user still believes MemBridge is running.
//
// So takeover is decided by DURABILITY, not arrival order.
// ---------------------------------------------------------------------------

// The membridge-hook.js argument out of a registered command string, or null.
// commandExecutable() deliberately returns the RUNTIME (node/Electron); the
// script is the token we key install identity on.
function hookScriptOf(command) {
  const tokens = String(command || '').match(/"[^"]*"|\S+/g) || [];
  const hit = tokens.map(t => t.replace(/^"|"$/g, ''))
    .find(t => /(^|[/\\])membridge-hook\.js$/.test(t));
  return hit || null;
}

// A linked git worktree is a working copy git itself treats as detachable, and
// tooling routinely creates and removes them per task. Asked of git rather
// than pattern-matched on the path, so this holds for any layout: in a linked
// worktree --git-dir and --git-common-dir differ; in a normal clone they match.
// Any failure (no git, not a repo, timeout) answers "no" -- a durability check
// must never be the reason setup fails.
function isLinkedWorktree(dir) {
  try {
    const runGit = defaultRunGit(dir);
    const own = String(runGit(['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
    const common = String(runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return !!own && !!common && path.resolve(own) !== path.resolve(common);
  } catch {
    return false;
  }
}

// 'dead' -> the script is gone. 'transient' -> a location expected to vanish.
// 'durable' -> anything else: an app bundle, a global npm install, a clone
// someone develops in. Note the ORDER: existence is checked first, because a
// path that is already gone is dead regardless of where it lived.
//
// Only signals that are UNAMBIGUOUS count as transient, because a false
// positive here is worse than a false negative: it would stop a user's real
// install from ever reclaiming its own registration. A merely suspicious
// location (the OS temp dir, an external volume, a mounted DMG) is
// deliberately NOT listed -- MemBridge is never installed there by any
// supported route, and the moment such a copy is cleaned up or ejected it
// reads as 'dead', which any install repairs. Covering the window before that
// is not worth the risk of misjudging somebody's real setup.
// The deepest ancestor of `abs` that is an .asar ARCHIVE FILE, or null. An
// asar is one file that plain node cannot stat into, so a path inside it
// (`.../app.asar/lib/membridge-hook.js`) fails existsSync even though the hook
// is really there and really runs — Electron's patched fs resolves it, and the
// packaged app registers exactly that path. Everything that judges liveness
// also runs under plain node (the CLI, `membridge status`, the dashboard), so
// the archive itself is what gets checked. An UNPACKED build keeps a real
// directory named app.asar, which needs none of this: it is a directory, not a
// file, so it is skipped here and the ordinary existsSync below sees it.
function asarArchiveOf(abs) {
  const parts = abs.split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) {
    if (!parts[i].toLowerCase().endsWith('.asar')) continue;
    const candidate = parts.slice(0, i + 1).join(path.sep);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there at all: keep walking up, then fall through to dead
    }
  }
  return null;
}

function installKind(scriptPath) {
  if (!scriptPath) return 'dead';
  const abs = path.resolve(scriptPath);
  // Checked before existsSync, which cannot see inside an archive. An app
  // bundle is the durable case by definition, so there is nothing further to
  // classify: no supported route installs an .asar into an npx cache or a
  // linked worktree.
  if (asarArchiveOf(abs)) return 'durable';
  if (!fs.existsSync(abs)) return 'dead';
  // npm's own cache layout for `npx` runs; the directory is garbage-collected.
  if (abs.split(path.sep).includes('_npx')) return 'transient';
  if (isLinkedWorktree(path.dirname(abs))) return 'transient';
  return 'durable';
}

// Should the install whose script is `ownScript` leave `existingCommand` in
// place? Only when we are the throwaway one and theirs is real and still
// there. A dead registration is ALWAYS repaired, by whoever notices it --
// leaving it is how summaries stop silently.
function shouldYieldTo(existingCommand, ownScript = hookScriptPath()) {
  const theirs = installKind(hookScriptOf(existingCommand));
  if (theirs !== 'durable') return false;
  return installKind(ownScript) === 'transient';
}

// The PreToolUse recall hook (lib/hooks-recall.js): same absolute-command
// shape as the Stop hook, with `recall` appended so membridge-hook.js routes
// to runRecall() instead of runStop(). Registered on Read/Grep/Glob — see
// docs/superpowers/plans/2026-07-28-recall-saving-layer.md (Task 5).
//
// Narrowed to 'Read' alone (final whole-branch review, C3): a Grep/Glob
// interception used to be answered exactly like a Read and priced by
// lib/recall.js's estimateCallTokens(null, {size}) as though the whole file
// had been read, though a grep call only ever returns a few matching lines
// -- inflating the direct-avoidance headline on calls that were never
// actually observed in full. lib/recall.js's decide() now refuses any
// toolName other than 'Read' as a second, independent floor; this matcher
// change means the hook stops firing on Grep/Glob at all, so most requests
// never reach decide() to need that floor -- reconcileRecallHook (below)
// rematches any already-installed entry still carrying the old, broader
// matcher so existing installs pick this up automatically.
const RECALL_MATCHER = 'Read';
const recallCommand = () => `${hookCommand()} recall`;

// True for MemBridge's OWN recall hook object, and nothing else. Deliberately
// far narrower than mentionsMembridge, for the same reason isOwnAppendRule is
// (see below): "membridge" appears in any hook script the user happens to keep
// under a directory named Membridge, and PreToolUse is where a user's own
// Read/Write hooks live. Claiming one of those was destructive in both
// directions -- setup-hooks OVERWROTE the user's command with ours (and the
// recall hook then inherited that entry's matcher, e.g. "Write", so it never
// fired on reads), and remove-hooks deleted the user's hook outright.
//
// Ownership needs both halves: the command must run our hook script (or the
// legacy PATH form `membridge hook recall`) AND end with the `recall`
// subcommand, which is what routes membridge-hook.js to runRecall(). The
// second half keeps this off our own Stop entry, whose command is the same
// script with no subcommand.
function isOwnRecallHook(h) {
  if (!h || typeof h.command !== 'string') return false;
  const cmd = h.command.trim().toLowerCase();
  if (!cmd.endsWith(' recall')) return false;
  return /(^|[\s"'/\\])membridge-hook\.js"?\s+recall$/.test(cmd) || /(^|[\s"'/])membridge\s+hook\s+recall$/.test(cmd);
}

// The PreToolUse SEARCH hook (lib/hooks-search.js): MemBridge's memory of
// prior work put in front of a Grep/Glob without the agent having to ask.
// Same absolute-command shape as the recall hook, with `search` appended so
// membridge-hook.js routes to runSearch().
//
// Registered on Grep and Glob and nothing else. Read belongs to the recall
// hook, which has a strictly better answer for a file read (that file's own
// skeleton) than a prose search could be; registering both on Read would put
// two MemBridge outputs in front of one tool call.
const SEARCH_MATCHER = 'Grep|Glob';
const searchCommand = () => `${hookCommand()} search`;

// True for MemBridge's OWN search hook object, and nothing else. Same
// anchoring discipline, and for exactly the same reason, as isOwnRecallHook
// above: PreToolUse is where a user's own Read/Grep/Bash hooks live, and one
// that merely mentions "membridge" (any script kept under a directory named
// Membridge) is not ours to rewrite or delete. Ownership needs both halves:
// the command must run our hook script (or the legacy PATH form
// `membridge hook search`) AND end with the `search` subcommand, which is what
// keeps this predicate off our own Stop and recall entries.
function isOwnSearchHook(h) {
  if (!h || typeof h.command !== 'string') return false;
  const cmd = h.command.trim().toLowerCase();
  if (!cmd.endsWith(' search')) return false;
  return /(^|[\s"'/\\])membridge-hook\.js"?\s+search$/.test(cmd) || /(^|[\s"'/])membridge\s+hook\s+search$/.test(cmd);
}

// The teammate-notes hooks (lib/hooks-notes.js): SessionStart delivers a
// teammate's undelivered decisions when a session arrives, PostCompact
// re-delivers them after a compaction has thrown the context away. Same
// absolute-command shape as the Stop and recall hooks, with a subcommand that
// lib/membridge-hook.js routes on.
//
// FileChanged is deliberately ABSENT and must stay that way. The Task 1 spike
// proved it suppresses systemMessage entirely and that its matcher rejects any
// filename containing '.' or '-', so it can never reach the human -- see
// docs/superpowers/spikes/2026-07-28-filechanged-findings.md.
//
// Neither event carries a matcher (like Stop, unlike recall's PreToolUse):
// SessionStart's matcher selects the session SOURCE (startup/resume/clear),
// and undelivered decisions are worth saying on every one of them.
// PostCompact is deliberately ABSENT. Re-injecting after compaction was
// specced to run through it, but PostCompact carries no `additionalContext` --
// it is not among the events that accept it, and its documented decision
// control is "none: side effects only". A registration there could never reach
// the model, while still costing the user a hook run after every compaction.
// Compaction is covered instead by SessionStart's `compact` source, which does
// accept additionalContext and which our matcher-less entry already receives.
const NOTES_HOOKS = [
  { event: 'SessionStart', sub: 'notes-session-start', timeout: 5 },
];
// Subcommands we used to register and must still RECOGNISE AS OURS so an
// upgrade strips them. Ownership is what licenses removal, so a retired entry
// dropped from NOTES_HOOKS alone would become unrecognised and sit in the
// user's settings.json forever.
const RETIRED_NOTES_SUBS = [
  { event: 'PostCompact', sub: 'notes-post-compact' },
];
const notesCommand = sub => `${hookCommand()} ${sub}`;

// True for MemBridge's OWN teammate-notes hook objects, and nothing else --
// same anchoring discipline, and for exactly the same reason, as
// isOwnRecallHook and isOwnStopHook below: a user's own SessionStart and
// PostCompact hooks live in these very arrays, and one that merely mentions
// "membridge" (any script kept under a directory named Membridge) is not ours
// to rewrite or delete. The script reference must sit at a path boundary and
// the subcommand must immediately follow it, never merely appear somewhere in
// the string. The legacy PATH form `membridge hook <sub>` matches too.
//
// Pass `sub` to ask about ONE hook -- what the reconciler needs, so its
// SessionStart pass never claims the PostCompact entry -- or omit it to ask
// "is this any teammate-notes hook of ours", which is what removeHooks needs.
const NOTES_OWN_PATTERNS = new Map([...NOTES_HOOKS, ...RETIRED_NOTES_SUBS].map(({ sub }) => [sub, [
  new RegExp(`(^|[\\s"'/\\\\])membridge-hook\\.js"?\\s+${sub}$`),
  new RegExp(`(^|[\\s"'/])membridge\\s+hook\\s+${sub}$`),
]]));

function isOwnNotesHook(h, sub) {
  if (!h || typeof h.command !== 'string') return false;
  const cmd = h.command.trim().toLowerCase();
  const subs = sub ? [sub] : [...NOTES_OWN_PATTERNS.keys()];
  return subs.some(s => (NOTES_OWN_PATTERNS.get(s) || []).some(re => re.test(cmd)));
}

// True for MemBridge's OWN Stop hook object, and nothing else. Same defect,
// same fix shape as isOwnRecallHook above -- mentionsMembridge is far too
// broad for a mutation site: it matches any hook command that merely
// contains the word "membridge", which is true of any script a user keeps
// under a directory named Membridge (several installed tool suites plausibly
// write hooks there). Left in place, that overwrites the user's command with
// ours on setup-hooks and deletes it outright on remove-hooks.
//
// Unlike recall, the Stop entry carries no subcommand at all in every
// real-world install: membridge-hook.js dispatches on argv[0] and falls
// through to runStop() when there is none (see membridge-hook.js). So the
// rule here is the mirror image of recall's "must end with recall": the
// command must reference the hook script itself (path-anchored on the
// FILENAME, never the bare word "membridge") AND its argv tail must be
// either empty or the literal 'stop' -- requiring a trailing ' stop' would
// make setup-hooks fail to recognize every currently-installed real-shape
// entry and append a duplicate alongside it. The Electron-prefixed form
// (ELECTRON_RUN_AS_NODE=1 ...) matches too, since the prefix sits before the
// part this checks. A legacy PATH-style `membridge hook stop` (no script
// path at all, referenced in older comments/installs) is matched as a
// fallback.
function isOwnStopHook(h) {
  if (!h || typeof h.command !== 'string') return false;
  const cmd = h.command.trim().toLowerCase();
  if (/(^|[\s"'/\\])membridge-hook\.js"?(\s+stop)?$/.test(cmd)) return true;
  return /(^|[\s"'/])membridge\s+hook\s+stop$/.test(cmd);
}

// First token of a hook command that is not an env assignment, unquoted —
// the executable the shell would run.
function commandExecutable(command) {
  const tokens = String(command).match(/"[^"]*"|\S+/g) || [];
  const exe = tokens.find(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return exe ? exe.replace(/^"|"$/g, '') : null;
}

function executableResolves(exe) {
  if (!exe) return false;
  if (exe.includes(path.sep)) return fs.existsSync(exe);
  return String(process.env.PATH || '').split(path.delimiter)
    .filter(Boolean)
    .some(dir => {
      try {
        return fs.existsSync(path.join(dir, exe));
      } catch {
        return false;
      }
    });
}

// The auto-approve rule for the summary append command. Bash permission
// rules are prefix-matched; this approves an `append` invocation of our hook
// script. Two properties keep the surface narrow: runAppend validates its
// input (well-formed line, a real .membridge/summaries.jsonl target), and
// Claude Code evaluates compound commands per-segment, so a trailing
// `&& ...` / `; ...` / pipe after a matched prefix is NOT auto-approved.
// The prefix string alone is not a blanket safety guarantee.
function appendAllowRule() {
  return `Bash(${hookCommand()} append:*)`;
}

// True for MemBridge's own append allow rule (current or a stale install
// path). Deliberately narrower than mentionsMembridge so we never strip a
// user's rule that merely mentions "membridge" (e.g. a path under a repo
// named Membridge).
//
// Fix round 5 (anchoring), append sibling of the isOwnStopHook /
// isOwnRecallHook anchoring fix (66c17a0). This used to be a bare substring
// test -- v.includes(HOOK_SCRIPT) && v.includes(' append') -- with no
// boundary anchoring and no ordering requirement. Two ways that went wrong:
// (1) any command whose last path segment merely ENDED in
// "membridge-hook.js" (e.g. a user's own /usr/bin/notmembridge-hook.js) was
// claimed as ours; (2) since the two substring checks were independent, a
// rule containing "membridge-hook.js" and " append" ANYWHERE, in ANY order
// (e.g. `Bash(my append tool: /opt/notmembridge-hook.js)`) matched too. Both
// are the same destructive failure as the Stop/recall predicates: setup-hooks
// never overwrites an allow rule in place (it only appends/rewrites its own),
// but remove-hooks strips anything this predicate claims, so a false
// positive here silently deletes a user's own Bash permission rule with no
// recovery.
//
// Fixed the same shape as the siblings: the script reference must sit at a
// path boundary (^|[\s"'/\\]), never a bare tail match, AND the `append`
// subcommand must immediately follow it (through an optional closing quote
// and whitespace) rather than merely appear somewhere in the string. The
// real generated rule (appendAllowRule -> `Bash(${hookCommand()} append:*)`)
// always has this exact shape -- hookCommand() quotes both the executable
// and the script path, so the command always reads `..."<script
// path>/membridge-hook.js" append:*)`, Electron prefix or stale install path
// notwithstanding -- so this still matches every rule setup-hooks writes,
// current or stale, while no longer matching a user rule that merely shares
// one of the two substrings.
const isOwnAppendRule = v => typeof v === 'string' &&
  /(^|[\s"'/\\])membridge-hook\.js"?\s+append(?=[\s:)]|$)/i.test(v);

// Ensure the allow rule is present, rewriting stale MemBridge append rules
// (previous install paths) in place. Returns the new allow array, or null
// when nothing needs to change. User-owned rules are never touched.
function upsertAllowRule(settings) {
  const rule = appendAllowRule();
  const allow = ((settings.permissions || {}).allow) || [];
  let stale = false;
  const next = allow.map(v => {
    if (!isOwnAppendRule(v) || v === rule) return v;
    stale = true;
    return rule;
  });
  if (next.includes(rule)) return stale ? [...new Set(next)] : null;
  return [...new Set([...next, rule])];
}

// Every MemBridge-owned command string in the Stop hook list.
function membridgeCommands(settings) {
  const commands = [];
  for (const entry of (settings.hooks || {}).Stop || []) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && typeof h.command === 'string' && mentionsMembridge(h)) commands.push(h.command);
    }
  }
  return commands;
}

// Parse the settings file. Missing file -> empty settings; unreadable,
// unparseable or unexpectedly-shaped file -> throw, so callers refuse to write
// over it.
function readSettings(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ONLY a genuinely absent file is safe to create. Every other read failure
    // means something IS there that we cannot see -- a settings.json locked to
    // mode 000 (EACCES), a directory in its place (EISDIR), a failing disk
    // (EIO) -- and reporting those as "missing" hands writeSettings an empty
    // object to write over the user's whole Claude Code config. Today the
    // plain writeFileSync below happens to fail on a mode-000 file, so the
    // damage is latent rather than live; making writeSettings atomic (tmp +
    // rename) removes that accident, because a rename only needs the DIRECTORY
    // writable, not the file. Same rule as lib/mcp-json.js's readConfig.
    if (err && err.code === 'ENOENT') return { settings: {}, existed: false };
    throw new Error(`refusing to touch ${file}: it exists but could not be read (${err && err.code}) — fix its permissions first`);
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to touch ${file}: it is not valid JSON — fix or remove it first`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`refusing to touch ${file}: expected a JSON object at the top level`);
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error(`refusing to touch ${file}: "hooks" is not an object`);
  }
  if (settings.hooks && settings.hooks.Stop !== undefined && !Array.isArray(settings.hooks.Stop)) {
    throw new Error(`refusing to touch ${file}: "hooks.Stop" is not an array`);
  }
  if (settings.permissions !== undefined && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions) || settings.permissions === null)) {
    throw new Error(`refusing to touch ${file}: "permissions" is not an object`);
  }
  if (settings.permissions && settings.permissions.allow !== undefined && !Array.isArray(settings.permissions.allow)) {
    throw new Error(`refusing to touch ${file}: "permissions.allow" is not an array`);
  }
  return { settings, existed: true };
}

// Monotonic per-process counter so two writes in the same tick never collide
// on the temp path; combined with the pid, the app and the CLI writing
// settings.json at once can't collide either.
let writeSettingsCounter = 0;

// Atomic write: serialize, stage into a temp file in the same directory, then
// rename it into place. Rename within one filesystem is atomic on POSIX/macOS,
// so a crash or a full disk can only ever leave a stray temp file behind --
// the user's settings.json is either the old good version or the new one,
// never a half-written mix that Claude Code would refuse to parse, costing
// them every hook, permission and model setting they had.
//
// Two things a naive tmp+rename gets wrong on a file we do not own:
//
//   1. Rename REPLACES the target, so the result carries the TEMP file's mode,
//      not the old file's. A settings.json the user deliberately locked to
//      0600 would be silently republished at the umask default. The existing
//      mode is therefore read first and carried over; only a genuinely new
//      file gets the default.
//   2. Rename needs only the DIRECTORY writable, not the file -- so nothing at
//      this layer stops it replacing a settings.json we could never read.
//      readSettings refusing everything but ENOENT is the ONLY guard against
//      that; do not weaken it (see its comment).
//
// Signature, return value and error-propagation contract are unchanged: a
// failure here still throws to the caller exactly as the old direct write did.
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(settings, null, 2) + '\n'; // throws before anything touches disk
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { mode = undefined; }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${writeSettingsCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

// Installed means "will actually run": the entry must exist AND its
// executable must resolve. A stale entry (e.g. `membridge hook stop` with no
// global CLI on PATH) fails silently on every stop, so reporting it as
// installed would hide exactly the breakage this check exists to surface.
//
// Shared by isHookInstalled and isRecallHookInstalled below -- same
// liveness test, two different hook arrays. BOTH halves must be there.
// Checking only the runtime was a hole big enough to swallow the whole
// check: the runtime is usually plain `node`, which always resolves, so a
// registration pointing at a deleted membridge-hook.js reported "installed"
// while every stop (or recall) silently did nothing -- see installKind, and
// the test pinning this.
function commandIsLive(command) {
  if (!executableResolves(commandExecutable(command))) return false;
  const script = hookScriptOf(command);
  return script ? installKind(script) !== 'dead' : true;
}

function isHookInstalled() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return membridgeCommands(settings).some(commandIsLive);
  } catch {
    return false;
  }
}

// Every MemBridge-owned command string in the PreToolUse recall hook list --
// the isOwnRecallHook-filtered twin of membridgeCommands above.
function membridgeRecallCommands(settings) {
  const commands = [];
  for (const entry of (settings.hooks || {}).PreToolUse || []) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && isOwnRecallHook(h)) commands.push(h.command);
    }
  }
  return commands;
}

// The recall channel's twin of isHookInstalled, for Settings (lib/server.js
// settingsPayload): /api/settings used to carry no field for recall at all,
// so the dashboard defaulted to a state that reads as broken even when a
// recall hook was installed and working. Same idiom, same liveness test
// (commandIsLive) -- a settings.json entry alone is not enough, the script
// it points at must actually still exist (this repo has shipped that exact
// false-"installed" bug once already, see commandIsLive's comment).
function isRecallHookInstalled() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return membridgeRecallCommands(settings).some(commandIsLive);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git post-commit hook install/remove, one file per tracked repo, with the
// same safety rules as the settings.json merge above: never clobber a user's
// hook — append our one line and preserve everything else byte-for-byte;
// removal strips ONLY lines mentioning membridge and deletes the file only
// when nothing but our own scaffolding (the shebang we wrote) remains.
// ---------------------------------------------------------------------------
const postCommitCommand = () => `${hookCommand()} post-commit`;

// Only lines WE wrote are ours: they invoke the membridge-hook.js shim with
// the post-commit argument. mentionsMembridge is too broad here — a user's
// own hook line may legitimately call the membridge CLI (`membridge sync &`)
// and must never be upgraded away or stripped.
//
// Fix round 6 (post-commit anchoring), fourth and last instance of the same
// defect fixed in isOwnStopHook / isOwnRecallHook / isOwnAppendRule (35434d5,
// 66c17a0, ae02dc7): this was two INDEPENDENT substring tests, with no path
// boundary before "membridge-hook.js" and no ordering/adjacency requirement
// between the two checks. That let a user's own similarly-named script (a
// last path segment merely ENDING in "membridge-hook.js", e.g.
// /opt/notmembridge-hook.js) or a line mentioning both substrings anywhere,
// in any order (e.g. a comment like "# post-commit: see notes about
// membridge-hook.js"), be falsely claimed as ours. Unlike the other three,
// this predicate feeds removePostCommitHooks, which does not just drop an
// allow-rule entry or overwrite a settings.json hook object — it can delete
// a LINE from, or the entirety of, a user's per-repo .git/hooks/post-commit
// file. That file has no undo. This is the same file type this project's own
// history already destroyed real user data through, so it is the
// highest-consequence instance of the four.
//
// Fixed the same shape as the siblings: the script reference must sit at a
// path boundary (^|[\s"'/\\]), never a bare tail match, AND the `post-commit`
// subcommand must immediately follow it (through an optional closing quote
// and required whitespace), not merely appear anywhere else in the line. The
// real generated line (postCommitCommand() -> `${hookCommand()} post-commit`,
// written as the WHOLE line with nothing after it) always has this exact
// shape -- hookCommand() quotes both the executable and the script path, so
// the line always reads `..."<script path>/membridge-hook.js" post-commit`,
// Electron prefix or stale install path notwithstanding -- so this still
// matches every line installPostCommitHooks writes, current or stale
// (letting the upgrade-in-place path in installPostCommitHooks find and
// replace it), while no longer matching a user line that merely shares one
// of the two substrings, or has them in the wrong order.
const isOurPostCommitLine = l =>
  /(^|[\s"'/\\])membridge-hook\.js"?\s+post-commit(?=\s|$)/i.test(String(l));

// Where a repo's hooks actually live. A user who sets core.hooksPath moves
// them out of .git/hooks — install/remove MUST follow, or those users get no
// commit->session capture at all. A relative core.hooksPath is resolved
// against the repo root (git's own rule); an unset value or any git failure
// falls back to the default .git/hooks. Injected runner for offline tests.
function postCommitHookDir(projectKey, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectKey);
  try {
    const hp = String(runGit(['config', '--get', 'core.hooksPath'])).trim();
    if (hp) return path.isAbsolute(hp) ? hp : path.join(projectKey, hp);
  } catch { /* unset (git config exits 1) or git failure: default below */ }
  return path.join(projectKey, '.git', 'hooks');
}

function postCommitHookPath(projectKey, deps = {}) {
  return path.join(postCommitHookDir(projectKey, deps), 'post-commit');
}

// Repos eligible for the hook: tracked, not paused, with a real .git dir
// (a .git FILE — worktree/submodule pointer — keeps its hooks elsewhere;
// skipped rather than guessed at).
function postCommitRepos(state, config) {
  return Object.keys((state && state.projects) || {}).filter(key => {
    if (util.isProjectOff(key, config)) return false;
    try {
      return fs.statSync(path.join(key, '.git')).isDirectory();
    } catch {
      return false;
    }
  });
}

function installPostCommitHooks() {
  const state = util.loadState();
  const config = util.getConfig();
  const cmd = postCommitCommand();
  let installed = 0, current = 0, upgraded = 0, failed = 0;
  for (const key of postCommitRepos(state, config)) {
    // Per-repo try/catch: one unwritable hooks dir (permissions, weird
    // mounts) must not abort the install for every other repo — nor block
    // the Stop-hook settings write that runs after this.
    try {
      const file = postCommitHookPath(key);
      let existing = '';
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {}
      if (existing.includes(cmd)) {
        current++;
        continue;
      }
      const stale = existing.split('\n').findIndex(isOurPostCommitLine);
      if (stale !== -1) {
        // Our line from an older install location: upgrade in place.
        const lines = existing.split('\n');
        lines[stale] = cmd;
        fs.writeFileSync(file, lines.join('\n'));
        upgraded++;
      } else if (!existing) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`);
        installed++;
      } else {
        const sep = existing.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(file, `${existing}${sep}${cmd}\n`);
        installed++;
      }
      try {
        fs.chmodSync(file, fs.statSync(file).mode | 0o755);
      } catch {}
    } catch {
      failed++;
    }
  }
  return { installed, current, upgraded, failed };
}

function removePostCommitHooks() {
  const state = util.loadState();
  let removed = 0;
  // Paused projects included on purpose: removal must reach every hook a
  // previous (pre-pause) install may have written. Per-repo try/catch for
  // the same reason as install: one broken repo must not strand the rest.
  for (const key of Object.keys((state && state.projects) || {})) {
    try {
      const file = postCommitHookPath(key);
      let existing;
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!existing.split('\n').some(isOurPostCommitLine)) continue;
      const rest = existing.split('\n').filter(l => !isOurPostCommitLine(l)).join('\n');
      if (!rest.replace(/^#!\/bin\/sh\s*/, '').trim()) {
        fs.unlinkSync(file); // only our scaffolding left — the file was ours
      } else {
        fs.writeFileSync(file, rest);
      }
      removed++;
    } catch { /* unwritable repo: skip, keep going */ }
  }
  return removed;
}

// Reconcile just the Stop hook + its narrow auto-approve rule in
// settings.json, writing only when something changed. Cheap (one settings.json
// read, an occasional write — no per-repo git spawns), so it is safe to run on
// every launch. Returns what happened so callers can report it; the settings
// write is performed here. Deliberately excludes the per-repo post-commit
// sweep, which is far more expensive (see ensureInstalled).
function reconcileStopHook() {
  const file = claudeSettingsPath();
  const { settings } = readSettings(file);
  const command = hookCommand();
  const fingerprint = hookFingerprint();
  const stop = (settings.hooks || {}).Stop || [];

  // Upgrade in place: any MemBridge command that differs from the current
  // resolved form (old PATH-based `membridge hook stop`, or a previous
  // install location) is rewritten; user entries are never touched.
  // Ownership uses isOwnStopHook (path-anchored on membridge-hook.js, argv
  // tail empty or 'stop'; see its comment) rather than the broad
  // mentionsMembridge, which would claim any user hook whose command merely
  // contains the word "membridge".
  //
  // "current" now also requires the stamped fingerprint to match, not just
  // the command string -- a MemBridge upgrade at a FIXED install path (a
  // global npm install, an app bundle replaced in place) never changes the
  // command text at all, so a command-only comparison would call it current
  // forever and any future change to the hook's SHAPE (a new default
  // timeout, a new field) would never reach an already-installed hook. The
  // fingerprint is the blunt, general catch-all for that; see hookFingerprint.
  //
  // Beyond the first owned hook, every further one is a duplicate -- e.g.
  // three byte-identical Stop entries observed in the wild -- and is dropped
  // here so setup-hooks converges to exactly one owned entry no matter how
  // many accumulated.
  let upgraded = 0;
  let current = false;
  let deduped = 0;
  let yielded = 0;
  let seenOwned = false;
  const upgradedStop = [];
  for (const entry of stop) {
    if (!entry || !Array.isArray(entry.hooks)) {
      upgradedStop.push(entry);
      continue;
    }
    const inner = [];
    for (const h of entry.hooks) {
      if (!h || typeof h.command !== 'string' || !isOwnStopHook(h)) {
        inner.push(h);
        continue;
      }
      if (seenOwned) {
        deduped++; // duplicate owned hook past the first: drop it
        continue;
      }
      seenOwned = true;
      if (h.command === command && h.membridgeFingerprint === fingerprint) {
        current = true;
        inner.push(h);
      } else if (shouldYieldTo(h.command)) {
        // Their install is real and still there; ours is throwaway. Stand down
        // rather than pointing the user's global hook at a path about to vanish
        // -- and never stamp OUR fingerprint onto a hook we did not write.
        yielded++;
        inner.push(h);
      } else {
        upgraded++;
        inner.push({ ...h, command, membridgeFingerprint: fingerprint });
      }
    }
    if (!inner.length) continue; // entry held only duplicate owned hooks: drop it whole
    const changed = inner.length !== entry.hooks.length || inner.some((h, i) => h !== entry.hooks[i]);
    upgradedStop.push(changed ? { ...entry, hooks: inner } : entry);
  }

  const newAllow = upsertAllowRule(settings);
  // Yielding counts as "nothing to do" alongside already-current: we chose to
  // leave their command in place, so there is nothing to write on its account.
  if ((current || yielded) && !upgraded && !deduped && !newAllow) {
    return { file, command, current, upgraded, deduped, yielded, addedAllow: false, wrote: false };
  }
  // Stop hooks take no matcher; 10s is generous for a local state read.
  const finalStop = seenOwned
    ? upgradedStop
    : [...upgradedStop, { hooks: [{ type: 'command', command, timeout: 10, membridgeFingerprint: fingerprint }] }];
  const next = { ...settings, hooks: { ...(settings.hooks || {}), Stop: finalStop } };
  if (newAllow) next.permissions = { ...(settings.permissions || {}), allow: newAllow };
  writeSettings(file, next);
  return { file, command, current, upgraded, deduped, yielded, addedAllow: !!newAllow, wrote: true };
}

// Reconcile ONE PreToolUse hook of ours the way reconcileStopHook does for
// Stop: same settings.json, same "never touch a user's own entries"
// guarantee, its own upgrade-in-place path, and its own matcher reconcile. No
// auto-approve rule is needed here — unlike `append` (a Bash command the
// AGENT runs, which needs pre-approval to avoid a permission prompt), a
// `command`-type hook entry is executed directly by Claude Code and never
// goes through the Bash tool's permission system.
//
// Parameterised because MemBridge now owns TWO PreToolUse entries with
// different matchers: the recall hook on Read (lib/hooks-recall.js) and the
// search hook on Grep|Glob (lib/hooks-search.js). They share one array in one
// file, and every rule below (ownership anchoring, durability precedence,
// matcher reconcile only when an entry is entirely ours) has to hold for
// both. Two hand-maintained copies of it would drift, and the failure mode of
// a drifted copy is deleting or hijacking a user's own hook.
//
// `isOurs` must be narrow enough to claim ONLY the one hook it is for; both
// predicates anchor on the script path AND the subcommand for exactly that
// reason (see isOwnRecallHook).
function reconcilePreToolUseHook({ command, isOurs, matcher, timeout }) {
  const file = claudeSettingsPath();
  const { settings } = readSettings(file);
  const fingerprint = hookFingerprint();
  const list = (settings.hooks || {}).PreToolUse || [];

  let upgraded = 0;
  let yielded = 0;
  let rematched = 0;
  let current = false;
  const upgradedList = list.map(entry => {
    if (!entry || !Array.isArray(entry.hooks)) return entry;
    const inner = entry.hooks.map(h => {
      if (!isOurs(h)) return h;
      if (h.command === command && h.membridgeFingerprint === fingerprint) {
        current = true;
        return h;
      }
      // Same durability precedence as the Stop hook: never point the user's
      // global hook at a throwaway copy of us (see shouldYieldTo), and never
      // stamp our fingerprint onto a hook we did not write.
      if (shouldYieldTo(h.command)) {
        yielded++;
        return h;
      }
      upgraded++;
      return { ...h, command, membridgeFingerprint: fingerprint };
    });
    // Reconcile the matcher too, or an entry narrowed to (say) "Read" leaves
    // Grep/Glob unregistered forever and a future matcher change can never
    // reach an existing install. Only when the entry is ENTIRELY ours: a
    // mixed entry's matcher also governs the user's hooks in it, so rewriting
    // it there would break them. `isOurs` is per-hook, so our OTHER PreToolUse
    // entry reads as "not ours" here and keeps its own matcher untouched.
    const allOurs = inner.length > 0 && inner.every(isOurs);
    const needsMatcher = allOurs && entry.matcher !== matcher;
    if (needsMatcher) rematched++;
    const changed = needsMatcher || inner.some((h, i) => h !== entry.hooks[i]);
    if (!changed) return entry;
    return { ...entry, ...(needsMatcher ? { matcher } : {}), hooks: inner };
  });

  if ((current || yielded) && !upgraded && !rematched) {
    return { file, command, current, upgraded, rematched, yielded, wrote: false };
  }
  const finalList = (current || upgraded || rematched)
    ? upgradedList
    : [...upgradedList, { matcher, hooks: [{ type: 'command', command, timeout, membridgeFingerprint: fingerprint }] }];
  const next = { ...settings, hooks: { ...(settings.hooks || {}), PreToolUse: finalList } };
  writeSettings(file, next);
  return { file, command, current, upgraded, rematched, yielded, wrote: true };
}

// The settings-level timeout is a PreToolUse hook's ONLY real bound: both hook
// bodies are fully synchronous (each blocks reading its payload off stdin), so
// no in-process JS timer can ever preempt them. See the module headers of
// lib/hooks-recall.js and lib/hooks-search.js. Keep this low; the Stop hook's
// 10s is deliberately not the model here, because these run in front of the
// tool call rather than after the session.
const PRE_TOOL_USE_TIMEOUT = 5;

function reconcileRecallHook() {
  return reconcilePreToolUseHook({
    command: recallCommand(), isOurs: isOwnRecallHook,
    matcher: RECALL_MATCHER, timeout: PRE_TOOL_USE_TIMEOUT,
  });
}

function reconcileSearchHook() {
  return reconcilePreToolUseHook({
    command: searchCommand(), isOurs: isOwnSearchHook,
    matcher: SEARCH_MATCHER, timeout: PRE_TOOL_USE_TIMEOUT,
  });
}

// Reconcile ONE hooks.<Event> array against a single command we own, the way
// reconcileStopHook reconciles Stop: upgrade our command in place, drop every
// duplicate past the first, and append one fresh entry only when we own none.
//
// It walks the existing array and never rebuilds it. That is the whole point:
// a user's own entries in this array keep their identity AND their position,
// and -- the case a per-entry filter gets wrong -- a user hook sharing an
// entry object with ours survives inside that entry instead of being deleted
// along with it.
function reconcileOwnedList(list, command, isOurs, timeout) {
  const fingerprint = hookFingerprint();
  let upgraded = 0;
  let deduped = 0;
  let current = false;
  let seenOwned = false;
  const kept = [];
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const inner = [];
    for (const h of entry.hooks) {
      if (!isOurs(h)) {
        inner.push(h);
        continue;
      }
      if (seenOwned) {
        deduped++; // duplicate owned hook past the first: drop it
        continue;
      }
      seenOwned = true;
      if (h.command === command && h.membridgeFingerprint === fingerprint) {
        current = true;
        inner.push(h);
      } else {
        upgraded++;
        // sibling fields (timeout, ...) preserved
        inner.push({ ...h, command, membridgeFingerprint: fingerprint });
      }
    }
    if (!inner.length) continue; // entry held only duplicate owned hooks: drop it whole
    const changed = inner.length !== entry.hooks.length || inner.some((h, i) => h !== entry.hooks[i]);
    kept.push(changed ? { ...entry, hooks: inner } : entry);
  }
  if (seenOwned) return { list: kept, upgraded, deduped, current, added: false };
  return {
    list: [...kept, { hooks: [{ type: 'command', command, timeout, membridgeFingerprint: fingerprint }] }],
    upgraded, deduped, current: false, added: true,
  };
}

// Reconcile the teammate-notes hooks (SessionStart, PostCompact) the same way
// reconcileRecallHook does for PreToolUse: same settings.json, same "never
// touch a hook we do not own" discipline, its own upgrade-in-place path, and
// no auto-approve rule (a `command`-type hook entry is run by Claude Code
// directly and never goes through the Bash tool's permission system).
//
// Writes only when something actually changed, so this is safe on every launch.
function reconcileNotesHooks() {
  const file = claudeSettingsPath();
  const { settings } = readSettings(file);
  const nextHooks = { ...(settings.hooks || {}) };
  const commands = {};
  let upgraded = 0;
  let deduped = 0;
  let added = 0;
  for (const spec of NOTES_HOOKS) {
    const existing = nextHooks[spec.event];
    // readSettings only shape-checks hooks.Stop, so these two arrays are ours
    // to refuse on. Refusing beats mangling a hand-edited settings file.
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`refusing to touch ${file}: "hooks.${spec.event}" is not an array`);
    }
    const command = notesCommand(spec.sub);
    commands[spec.event] = command;
    const r = reconcileOwnedList(existing || [], command, h => isOwnNotesHook(h, spec.sub), spec.timeout);
    upgraded += r.upgraded;
    deduped += r.deduped;
    if (r.added) added++;
    nextHooks[spec.event] = r.list;
  }
  // Strip subcommands we used to register. An installed settings.json still
  // holds them until something removes them, and the hook entry point treats an
  // unknown `notes-*` subcommand as inert -- so a stale entry is harmless but
  // permanent, firing a no-op process on every occurrence of that event. Doing
  // it here means an ordinary launch cleans it up; waiting for `remove-hooks`
  // would mean most users never do.
  let retired = 0;
  for (const spec of RETIRED_NOTES_SUBS) {
    const existing = nextHooks[spec.event];
    if (!Array.isArray(existing)) continue;
    const { kept, removed } = stripMembridgeEntries(existing, h => isOwnNotesHook(h, spec.sub));
    if (!removed) continue;
    retired += removed;
    // Drop the key entirely rather than leaving an empty array behind -- an
    // empty `PostCompact: []` is noise in a file the user reads.
    if (kept.length) nextHooks[spec.event] = kept;
    else delete nextHooks[spec.event];
  }

  if (!upgraded && !deduped && !added && !retired) {
    return { file, commands, upgraded, deduped, added, retired, wrote: false };
  }
  writeSettings(file, { ...settings, hooks: nextHooks });
  return { file, commands, upgraded, deduped, added, retired, wrote: true };
}

function setupHooks() {
  const r = reconcileStopHook();
  const rc = reconcileRecallHook();
  const rs = reconcileSearchHook();
  // Registered by the explicit opt-in command too, not just by ensureInstalled:
  // remove-hooks strips these entries, so setup-hooks has to be able to put
  // them back — otherwise the documented undo has no matching redo.
  const rn = reconcileNotesHooks();
  // The git post-commit hook installs on every path — the Stop hook being
  // current says nothing about repos linked since the last setup run.
  const pc = installPostCommitHooks();
  const pcLine = `Git post-commit hook (commit->session provenance): ${pc.installed} installed, ${pc.upgraded} upgraded, ${pc.current} already current across tracked repos.${pc.failed ? ` ${pc.failed} repo(s) skipped (hooks dir not writable).` : ''}`;
  const recallLine = !rc.wrote
    ? 'Recall hook (answers repeat file reads from memory on Read/Grep/Glob): already installed.'
    : rc.upgraded
      ? 'Recall hook (answers repeat file reads from memory on Read/Grep/Glob): command updated to the current install path.'
      : 'Recall hook (answers repeat file reads from memory on Read/Grep/Glob): installed.';
  const searchLine = !rs.wrote
    ? 'Search hook (puts matching project memory in front of a Grep/Glob): already installed.'
    : rs.upgraded
      ? 'Search hook (puts matching project memory in front of a Grep/Glob): command updated to the current install path.'
      : 'Search hook (puts matching project memory in front of a Grep/Glob): installed.';
  const notesLine = !rn.wrote
    ? 'Teammate-notes hooks (deliver the fresh context block and a teammate\'s decisions on SessionStart): already installed.'
    : rn.upgraded
      ? 'Teammate-notes hooks (deliver the fresh context block and a teammate\'s decisions on SessionStart): commands updated to the current install path.'
      : 'Teammate-notes hooks (deliver the fresh context block and a teammate\'s decisions on SessionStart): installed.';

  if (r.current && !r.upgraded && !r.deduped && !r.addedAllow && !rc.wrote && !rs.wrote && !rn.wrote) {
    return `Claude Code Stop hook already installed in ${r.file} — nothing changed.
${recallLine}
${searchLine}
${notesLine}
${pcLine}`;
  }
  if (r.current && !r.upgraded && !r.deduped) {
    return `Added the MemBridge auto-approve rule for the summary append command in ${r.file}.
${recallLine}
${searchLine}
${notesLine}
${pcLine}
Undo anytime with: membridge remove-hooks`;
  }
  if (r.upgraded || r.deduped) {
    const parts = [];
    if (r.upgraded) parts.push(`${r.upgraded} entr${r.upgraded === 1 ? 'y' : 'ies'} rewritten to the current install path`);
    if (r.deduped) parts.push(`${r.deduped} duplicate entr${r.deduped === 1 ? 'y' : 'ies'} converged into one`);
    return `Updated the MemBridge Stop hook command in ${r.file} (${parts.join('; ')}).
${recallLine}
${searchLine}
${notesLine}
${pcLine}
Undo anytime with: membridge remove-hooks`;
  }
  return `Installed the MemBridge Stop hook in ${r.file} (appended after your existing hooks), plus one narrow auto-approve rule so the summary append never raises a permission prompt.
On every Claude Code session stop, \`${r.command}\` asks the agent for a short outcome summary of sessions that edited files, saved via the append command to <project>/.membridge/summaries.jsonl.
${recallLine}
${searchLine}
${notesLine}
${pcLine}
Undo anytime with: membridge remove-hooks`;
}

// MemBridge version, used as the once-per-version marker below. Read lazily and
// fail-soft: a missing/unreadable package.json must not break auto-registration.
function membridgeVersion() {
  try {
    return require('../package.json').version || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Hook vintage: force-updating a stale registration.
//
// The known failure: a registered Stop/recall hook keeps running whatever
// code it pointed at when it was written, and nothing about settings.json
// says WHICH build that was. A stale summary prompt or an old recall matcher
// then looks identical to "working normally" from the outside -- see
// prompt-not-shared-vs-not-captured's "low-quality summary = stale build".
//
// Mirrors lib/mcp-register.js's registrationFingerprint: a short, versioned
// signature, `v=<membridgeVersion>`. Two differences, both about WHERE it
// lives. mcp-register's fingerprint is cached in state.json to GATE an
// expensive reconcile (a `claude mcp get` subprocess); this one is cheap to
// recompute every time (no I/O beyond package.json, already read for
// membridgeVersion()), so instead of caching it we STAMP it directly onto
// each owned hook object we write, as `membridgeFingerprint`. That makes a
// hook's vintage knowable from settings.json alone -- by a later run of this
// same code, by a different install entirely, or by a human reading the
// file -- with no separate record that could itself drift out of sync with
// what is actually registered.
function hookFingerprint() {
  return `v=${membridgeVersion()}`;
}

// Every hook object in `list` (a hooks.<Event> array) that `isOwn` claims,
// flattened past the entry wrapper. Shared by the vintage checks below.
function ownedHookObjects(list, isOwn) {
  const out = [];
  for (const entry of list || []) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) if (isOwn(h)) out.push(h);
  }
  return out;
}

// 'current' | 'outdated' | 'unknown'. 'unknown' covers both "nothing owned
// is registered here" (there is no vintage to report -- isHookInstalled /
// isRecallHookInstalled already say whether it's installed at all) and
// "settings.json could not be read" -- never guessed as either of the other
// two, per the owner's "render unknown if it genuinely cannot tell" ask.
function hookVintage(list, isOwn) {
  const owned = ownedHookObjects(list, isOwn);
  if (!owned.length) return 'unknown';
  const fp = hookFingerprint();
  return owned.every(h => h.membridgeFingerprint === fp) ? 'current' : 'outdated';
}

function stopHookVintage() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return hookVintage((settings.hooks || {}).Stop, isOwnStopHook);
  } catch {
    return 'unknown';
  }
}

function recallHookVintage() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return hookVintage((settings.hooks || {}).PreToolUse, isOwnRecallHook);
  } catch {
    return 'unknown';
  }
}

// GET-shaped: /api/settings's honest "up to date" / "outdated -- update
// available" / "unknown" pair, read fresh from settings.json every call.
function hooksVersionStatus() {
  return { stop: stopHookVintage(), recall: recallHookVintage() };
}

// One line per hook, for forceUpdateHooks() below: what reconcile* actually
// did (or why it deliberately did nothing), never a bare "done".
function describeForceUpdate(r) {
  if (r.yielded) return 'left in place: a more durable MemBridge install owns this hook';
  if (!r.wrote) return 'already up to date';
  if (r.upgraded) return 'rewritten to the current version';
  if (r.deduped) return 'duplicate entries converged into one';
  if (r.rematched) return 'matcher updated to the current version';
  return 'installed';
}

// POST /api/hooks/update: force BOTH hooks current, per-hook success/failure
// -- never a single "ok" for the pair, so a Stop-hook failure cannot hide
// behind a successful recall reconcile or vice versa. Each reconcile* already
// fails closed (readSettings throws on an unreadable/malformed file); that
// throw is caught HERE, not swallowed, so a real failure surfaces to the
// caller instead of reading as silent success -- the bug class this feature
// exists to end.
function forceUpdateHooks() {
  const run = fn => {
    try {
      const r = fn();
      return { ok: true, wrote: !!r.wrote, detail: describeForceUpdate(r) };
    } catch (err) {
      return { ok: false, wrote: false, detail: err && err.message ? err.message : String(err) };
    }
  };
  return { stop: run(reconcileStopHook), recall: run(reconcileRecallHook), search: run(reconcileSearchHook) };
}

// The per-repo post-commit sweep spawns `git config` for every tracked repo
// (~150ms+ on a busy machine), so gate it behind a version marker in state:
// run the full sweep once per installed version (fresh install, upgrade, or
// never-run), then skip it on every subsequent launch. Repos linked after the
// sweep still get their post-commit hook through the daemon's normal link/scan
// flow and through explicit `setup-hooks`.
function ensurePostCommitForVersion() {
  const version = membridgeVersion();
  const state = util.loadState();
  if (state.hooksInstalledVersion === version) return;
  installPostCommitHooks();
  util.saveState({ ...state, hooksInstalledVersion: version });
}

// Unconditional, silent, fail-open auto-registration, called at every real
// MemBridge launch (the CLI daemon boot and the Electron app) so the Stop hook
// lands however MemBridge was installed — git clone, npm, curl, or the app.
// Never throws and never logs on success: hook registration must never block or
// clutter a launch. Test suites reach neither call site, and even if they did,
// claudeSettingsPath() is redirected by MEMBRIDGE_CLAUDE_SETTINGS.
// Returns a registration outcome for lib/counters.js: 'wrote' (the recall hook
// was installed or its command updated), 'current' (already correct), or
// 'failed' (the reconcile threw — almost always an unwritable settings.json).
// The return is additive; every existing caller ignores it. It exists because
// a release that breaks hook registration is otherwise completely silent — the
// hook simply never runs and nothing anywhere says so.
function ensureInstalled() {
  try {
    reconcileStopHook();                // every launch: cheap settings.json reconcile
    const rc = reconcileRecallHook();   // every launch: same, for the PreToolUse recall hook
    reconcileSearchHook();              // every launch: same, for the PreToolUse Grep/Glob search hook
    reconcileNotesHooks();              // every launch: same, for the teammate-notes hooks
    ensurePostCommitForVersion();       // gated: full git sweep once per version only
    scheduleMcpReconcile();             // gated AND deferred: see below
    return { registration: rc && rc.wrote ? 'wrote' : 'current' };
  } catch (err) {
    try { util.log(`hook auto-register skipped: ${err && err.message}`); } catch {}
    return { registration: 'failed' };
  }
}

// The MCP server's registration, reconciled on the same launch path as the
// hooks above and for the same reason: it has to land however MemBridge was
// installed. Two differences from its neighbours, both about cost.
//
// GATED, inside ensureRegistered: a reconcile is ~2s on a miss and ~6s on a
// repair (`claude mcp get` alone is ~2.1s of CLI startup), which is far too
// slow to pay on every launch for a repair that is almost never needed. The
// gate makes the common already-registered launch a state read.
//
// DEFERRED, here: so the rare launch that DOES reconcile lands behind the
// daemon coming up rather than in front of it. Both real callers (the daemon
// and the Electron app) are long-lived, so a 0ms timer simply runs it once the
// synchronous launch path has finished. Deliberately NOT unref'd -- unref
// would let a short-lived caller exit before the work happened, which is the
// silent-skip shape this whole feature exists to end.
//
// Required lazily. bin/membridge.js's fast path (`membridge hook stop`, fired
// on every session stop) requires THIS file and nothing else; a top-level
// require here would drag agent-config, mcp-toml, mcp-json and claude-bin into
// every one of those.
function scheduleMcpReconcile() {
  setTimeout(() => {
    try {
      require('./mcp-register').ensureRegistered();
    } catch (err) {
      try { util.log(`mcp auto-register skipped: ${err && err.message}`); } catch {}
    }
  }, 0);
}

// Filter one hooks.<EventName> entries array, dropping only MemBridge-owned
// hook objects. Surgical: a user entry mixing its own hooks with ours keeps
// everything else; an entry left with no hooks is dropped whole. Shared by
// removeHooks() for both the Stop and PreToolUse arrays, each called with its
// own narrow ownership predicate — isOwnStopHook for Stop, isOwnRecallHook
// for PreToolUse — since a user's own hooks live in both arrays, and one
// merely mentioning "membridge" is not ours to delete (see the H2 fix for
// PreToolUse and its Stop-hook twin above). The mentionsMembridge default
// below is no longer reached by any caller in this file; left in place only
// as a fallback for the argument-less shape, not as an endorsement of the
// broad rule.
function stripMembridgeEntries(list, isOurs = mentionsMembridge) {
  let removed = 0;
  const kept = [];
  for (const entry of list) {
    if (entry && Array.isArray(entry.hooks)) {
      const inner = entry.hooks.filter(h => !isOurs(h));
      if (inner.length === entry.hooks.length) {
        kept.push(entry); // nothing of ours inside — untouched
      } else {
        removed += entry.hooks.length - inner.length;
        if (inner.length) kept.push({ ...entry, hooks: inner });
      }
    } else if (isOurs(entry)) {
      removed++;
    } else {
      kept.push(entry);
    }
  }
  return { kept, removed };
}

function removeHooks() {
  // Post-commit hooks come out first and unconditionally — they exist per
  // repo, independent of the settings file's state.
  const pcRemoved = removePostCommitHooks();
  const pcLine = pcRemoved
    ? `\nRemoved the git post-commit hook line from ${pcRemoved} repo(s).`
    : '';
  const file = claudeSettingsPath();
  const { settings, existed } = readSettings(file);
  if (!existed) return `No Claude Code settings file at ${file} — nothing to remove.${pcLine}`;
  const stopResult = stripMembridgeEntries((settings.hooks || {}).Stop || [], isOwnStopHook);
  // PreToolUse holds BOTH of ours (recall on Read, search on Grep|Glob) plus
  // whatever the user put there. Stripped in two passes over the same array,
  // each with its own narrow ownership predicate, so neither can ever claim
  // the other's entry or a user's.
  const recallStripped = stripMembridgeEntries((settings.hooks || {}).PreToolUse || [], isOwnRecallHook);
  const searchStripped = stripMembridgeEntries(recallStripped.kept, isOwnSearchHook);
  const preResult = { kept: searchStripped.kept, removed: recallStripped.removed + searchStripped.removed };
  // SessionStart and PostCompact, the teammate-notes arrays. Same rule as the
  // two above and for the same reason: a user's own hooks live in these arrays,
  // so they are stripped with isOwnNotesHook — the exact predicate the
  // reconciler adds with — never the broad mentionsMembridge. Called without a
  // `sub` so it claims any of our notes subcommands, current or stale.
  const notesResults = NOTES_HOOKS.map(spec => {
    const list = (settings.hooks || {})[spec.event];
    return [spec.event, stripMembridgeEntries(Array.isArray(list) ? list : [], isOwnNotesHook)];
  });
  const notesRemoved = notesResults.reduce((n, [, res]) => n + res.removed, 0);
  const removed = stopResult.removed + preResult.removed + notesRemoved;

  const allow = ((settings.permissions || {}).allow) || [];
  const keptAllow = allow.filter(v => !isOwnAppendRule(v));
  const removedAllow = allow.length - keptAllow.length;
  if (!removed && !removedAllow) return `No MemBridge hook found in ${file} — nothing changed.${pcLine}`;
  if (stopResult.removed) {
    settings.hooks.Stop = stopResult.kept;
    if (!stopResult.kept.length) delete settings.hooks.Stop;
  }
  if (preResult.removed) {
    settings.hooks.PreToolUse = preResult.kept;
    if (!preResult.kept.length) delete settings.hooks.PreToolUse;
  }
  for (const [event, res] of notesResults) {
    if (!res.removed) continue;
    settings.hooks[event] = res.kept;
    if (!res.kept.length) delete settings.hooks[event];
  }
  if (removedAllow) {
    settings.permissions.allow = keptAllow;
    if (!keptAllow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  writeSettings(file, settings);
  const total = removed + removedAllow;
  return `Removed the MemBridge hooks from ${file} (${total} entr${total === 1 ? 'y' : 'ies'}: Stop + recall/search PreToolUse + teammate-notes SessionStart/PostCompact where present); your other hooks are untouched.${pcLine}
Re-enable anytime with: membridge setup-hooks`;
}

module.exports = {
  runStop, runRecall, runAppend, runPostCommit, countSummaryLines, hasSummaryLine, lastSummaryTs, isCheckpointDue, blockReason, summariesPath, claudeSettingsPath, SUMMARIES_FILE, HEADLINE_MAX, GOAL_MAX, POINT_MAX, POINTS_MAX,
  setupHooks, removeHooks, isHookInstalled, isRecallHookInstalled, hookCommand, recallCommand, searchCommand, appendAllowRule, postCommitCommand,
  ensureInstalled, reconcileStopHook, reconcileRecallHook, reconcileSearchHook, reconcileNotesHooks, ensurePostCommitForVersion,
  // Exposed for direct pinning of the per-repo post-commit install/remove
  // logic (isOurPostCommitLine anchoring) without exercising the unrelated
  // Stop/recall/settings.json machinery in setupHooks/removeHooks.
  installPostCommitHooks, removePostCommitHooks,
  // Exposed so the missing-vs-unreadable classification can be pinned
  // directly. Going through setupHooks/removeHooks would prove the refusal
  // only for the paths those two happen to take.
  readSettings, writeSettings,
  // Hook-registration ownership: which install may claim the single global
  // ~/.claude/settings.json entry. See shouldYieldTo.
  hookScriptPath, hookScriptOf, installKind, shouldYieldTo,
  // Hook vintage / force-update: see the "Hook vintage" section above.
  hookFingerprint, hooksVersionStatus, forceUpdateHooks,
};
