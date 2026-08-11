'use strict';
// Keep MemBridge's managed block out of git, without taking it off disk.
//
// THE USER PROBLEM. The block is injected into files that are legitimately
// tracked — the human's own instructions surround it in CLAUDE.md / AGENTS.md
// — so every rewrite of the block dirties a tracked file. `git status` reports
// churn nobody caused, the user has to decide whether to stage it, and on a
// merge both sides bring their own copy of the region and conflict on it (the
// claude-md-tracked-rebase-collision landmine). None of the obvious remedies
// work: .gitignore drops the human's lines too, and `--skip-worktree` hides
// every edit to the file and does not survive a fresh clone.
//
// A GIT CLEAN FILTER is the one mechanism that removes a REGION on the way
// into the index while leaving the working-tree file byte-for-byte as it is.
// Every AI tool reads the file off disk, so nothing that reads the block is
// affected — only what git records.
//
// WHAT THIS DOES AND DOES NOT BUY, measured against git 2.39 rather than
// assumed. The block never reaches the index, so `git diff` is empty for it
// and a merge cannot conflict on it — that is the whole ticket. `git status`
// is NOT unconditionally silent: git caches the WORKING TREE size in the index
// entry, so a rewrite that changes the file's byte length trips the size
// shortcut and prints ` M` without ever running this filter. The diff is still
// empty, the next `git add` stages nothing and clears the flag, and a
// same-length rewrite is invisible throughout. Nothing a clean filter can do
// changes that; both halves are pinned in test/suites/git-block-filter.test.js
// so a future git that closes the gap shows up as a failing expectation.
//
// Two properties of that mechanism are load-bearing and both were verified
// against real git before this was written:
//
//   1. A filter named in .gitattributes but NOT configured on this machine is
//      silently ignored: content is stored unchanged, exit 0, no warning. So
//      committing the .gitattributes line is safe for a teammate who has no
//      MemBridge, and starts working for free if they install it later.
//   2. Because git will not run a filter binary named by a freshly cloned
//      repo, .gitattributes ALONE can never enable this. The per-machine
//      `git config` below is mandatory — which is why it belongs in setup.
//
// `filter.membridge.required` is deliberately NOT set. It defaults to false,
// and false is what we want: if this script ever goes missing (MemBridge
// uninstalled or moved) git warns and passes the content through UNCHANGED.
// Setting it true would turn an uninstall into a repo where `git add` fails.
//
// FAIL-OPEN, AND WHAT THAT MEANS HERE. Any failure in this script writes the
// INPUT BYTES back out and exits 0, so the worst case is a block that lands in
// the index exactly as it does today. There is no success flag to get wrong on
// this path; the one place that reports success is configureFilter(), and it
// reports it only after reading the value back out of git.
//
// THE SPAN IS NOT THIS FILE'S BUSINESS. lib/block-span.js owns which markers
// bound a block — it is the only thing that gets a forged end marker and a
// merge-duplicated block both right — and the removal mirrors
// digest.removeBlock's splice so the filtered bytes equal what the file looked
// like before MemBridge ever injected into it. Anything less exact — leaving
// the blank run the injection introduced, say — would store a file that
// differs from the pre-MemBridge one and put a permanent whitespace hunk in
// everyone's diff. test/suites/git-block-filter.test.js asserts that equality
// against digest.removeBlock directly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BEGIN, firstBlockSpan } = require('./block-span');

const FILTER_NAME = 'membridge';
const CLEAN_KEY = `filter.${FILTER_NAME}.clean`;
const ATTR_HEADER = '# MemBridge: injected memory block stripped on the way into git (off: membridge git-filter off)';
const attrLineFor = target => `${target} filter=${FILTER_NAME}`;

// ---------------------------------------------------------------------------
// The filter itself.

const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');

// Exactly digest.js's spliceBlockOut: drop the span AND the blank run the
// injection introduced around it, so `text` collapses back to its pre-inject
// shape rather than to that shape plus stray newlines. Duplicated here rather
// than imported because git spawns this script once per filtered file and
// lib/digest.js drags in the whole distillation tree; the parity test is what
// keeps the two honest.
function spliceOut(text, span, eol) {
  const trailing = eol === '\r\n' ? /(?:\r\n)+$/ : /\n+$/;
  const leading = eol === '\r\n' ? /^(?:\r\n)+/ : /^\n+/;
  return text.slice(0, span.begin).replace(trailing, eol)
    + text.slice(span.end).replace(leading, '');
}

/**
 * Every complete managed block removed, the user's own lines around and
 * between them kept. A merge brings two blocks; both go, because neither
 * belongs in the index.
 */
function stripBlocks(text) {
  let out = String(text);
  const eol = eolOf(out);
  // Each pass removes a whole pair so this terminates; the bound is
  // belt-and-braces against a future block-span that stops shrinking.
  for (let guard = 0; guard < 1000; guard++) {
    const span = firstBlockSpan(out);
    if (!span) break;
    out = spliceOut(out, span, eol);
  }
  return out;
}

/**
 * Buffer in, buffer out. A buffer with no begin marker in it is returned
 * UNTOUCHED without ever being decoded — that is what makes "a file with no
 * block passes through byte-identical" true even for content that is not
 * valid UTF-8, which a clean filter has no right to assume it is.
 */
function stripBuffer(buf) {
  if (!buf.includes(BEGIN)) return buf;
  const text = buf.toString('utf8');
  const stripped = stripBlocks(text);
  return stripped === text ? buf : Buffer.from(stripped, 'utf8');
}

/** stdin -> stdout, exit 0 no matter what. */
function runFilter(stdin = process.stdin, stdout = process.stdout) {
  const chunks = [];
  stdin.on('data', c => chunks.push(c));
  stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    let output;
    try {
      output = stripBuffer(input);
    } catch {
      output = input; // fail open: storing the block is the harmless outcome
    }
    stdout.write(output);
  });
  stdin.on('error', () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Configuring it on this machine.

/**
 * The command git runs, absolute on both halves. Same reasoning as
 * hooks.hookCommand(): `membridge` is not on PATH for every process that
 * shells out to git, and under Electron ELECTRON_RUN_AS_NODE makes the app
 * binary behave as plain Node while keeping asar reads working.
 */
function filterCommand() {
  const prefix = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  const q = s => `"${s}"`;
  return `${prefix}${q(process.execPath)} ${q(__filename)}`;
}

function runGit(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, status: null, out: '', error: r.error.message };
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, status: r.status, out, error: r.status === 0 ? null : (out || `git exited ${r.status}`) };
}

/** The command currently configured for this filter, or null. */
function configuredCommand(opts = {}) {
  const r = runGit(['config', '--global', '--get', CLEAN_KEY], opts);
  return r.ok && r.out ? r.out : null;
}

/**
 * Point git at this script, machine-wide. Reports success ONLY after reading
 * the value back out of git — `git config` failing while we print "enabled" is
 * this codebase's signature defect, and a write we never confirmed is exactly
 * the shape of it.
 */
function configureFilter(opts = {}) {
  const command = filterCommand();
  const w = runGit(['config', '--global', CLEAN_KEY, command], opts);
  if (!w.ok) return { ok: false, command, error: w.error };
  const readBack = configuredCommand(opts);
  if (readBack !== command) {
    return { ok: false, command, error: `git config accepted the write but ${CLEAN_KEY} reads back as ${readBack === null ? 'unset' : JSON.stringify(readBack)}` };
  }
  return { ok: true, command, error: null };
}

/**
 * The off switch: remove the machine-level config. The .gitattributes lines
 * are left alone on purpose — they are committed, shared with teammates, and
 * inert without this config (property 1 in the header). `removed` is false
 * when there was nothing configured, which is "already off", not a failure.
 *
 * `--unset-all` exits 5 when the key is not set. An empty `[filter
 * "membridge"]` section header can be left behind in the config file; it
 * configures nothing.
 */
function unconfigureFilter(opts = {}) {
  const r = runGit(['config', '--global', '--unset-all', CLEAN_KEY], opts);
  if (!r.ok && r.status !== 5) return { ok: false, removed: false, error: r.error };
  const still = configuredCommand(opts);
  if (still !== null) return { ok: false, removed: false, error: `${CLEAN_KEY} is still set to ${JSON.stringify(still)}` };
  return { ok: true, removed: r.status === 0, error: null };
}

// ---------------------------------------------------------------------------
// Marking a repo's context files.

/** Does `line` already route `target` through this filter? */
function isOurAttrLine(line, target) {
  const s = String(line).trim();
  if (!s || s.startsWith('#')) return false;
  const parts = s.split(/\s+/);
  return parts[0] === target && parts.slice(1).includes(`filter=${FILTER_NAME}`);
}

/**
 * Append the missing `targets` to `repoDir/.gitattributes`, idempotently and
 * without disturbing what is already in the file. Returns which targets it
 * added; an empty `added` with ok:true means every target was already marked.
 */
function writeAttributes(repoDir, targets) {
  const file = path.join(repoDir, '.gitattributes');
  try {
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch {}
    const eol = eolOf(existing);
    const lines = existing.split(/\r?\n/);
    const missing = targets.filter(t => !lines.some(l => isOurAttrLine(l, t)));
    if (!missing.length) return { ok: true, file, added: [], error: null };
    const gap = !existing || /\r?\n$/.test(existing) ? '' : eol;
    const header = lines.some(l => l.trim() === ATTR_HEADER) ? [] : [ATTR_HEADER];
    fs.writeFileSync(file, existing + gap + [...header, ...missing.map(attrLineFor)].join(eol) + eol);
    return { ok: true, file, added: missing, error: null };
  } catch (err) {
    return { ok: false, file, added: [], error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Is the script named by an already-configured command still on disk?
 *
 * The durability question, same one lib/hooks.js asks about a registered hook:
 * a config value pointing into a MemBridge that has since been deleted or moved
 * is not a working filter, it is a stale string. git fails open on it (required
 * is unset), so nothing complains — the block just silently starts landing in
 * commits again. A command whose script is gone is treated as not configured,
 * so the next launch takes it over.
 *
 * A command we cannot parse is assumed live. Guessing "dead" would make us
 * stomp a value some other tool owns.
 */
function isCommandLive(command) {
  const script = String(command || '').match(/"([^"]*\.js)"|(\S*\.js)(?:\s|$)/);
  const p = script && (script[1] || script[2]);
  if (!p) return true;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The whole enable, in one place.
//
// This is shared by three callers that used to be able to drift apart, which is
// exactly how the desktop app ended up not getting the feature at all: the
// launch path (lib/hooks.js ensureInstalled), `membridge setup-hooks`, and the
// explicit `membridge git-filter on`. One function, three entry points, no
// second copy of the rules.
//
// lib/util.js is required LAZILY here on purpose. git spawns this script once
// per filtered file on `git add`, and that path must not pay to load the config
// and state machinery it never touches.

/**
 * Tracked, un-paused projects that are a git checkout. A `.git` FILE counts —
 * that is a linked worktree or a submodule, and .gitattributes is an ordinary
 * working-tree file that works in both. (lib/hooks.js's postCommitRepos
 * excludes them because .git/hooks lives elsewhere for those; that reason does
 * not apply here.)
 */
function trackedGitRepos() {
  const util = require('./util');
  const state = util.loadState();
  const config = util.getConfig();
  return Object.keys((state && state.projects) || {}).filter(key => {
    if (util.isProjectOff(key, config)) return false;
    try {
      return fs.existsSync(path.join(key, '.git'));
    } catch {
      return false;
    }
  });
}

/** Mark every tracked repo's context files. Pure fs — no subprocess. */
function markTrackedRepos(only) {
  const util = require('./util');
  const targets = util.effectiveTargets(util.getConfig());
  const repos = only ? [path.resolve(only)] : trackedGitRepos();
  let marked = 0, already = 0, failed = 0;
  for (const key of repos) {
    const w = writeAttributes(key, targets);
    if (!w.ok) failed++;
    else if (w.added.length) marked++;
    else already++;
  }
  return { repos, marked, already, failed };
}

/**
 * The user's standing answer, in config.json — NOT state.json, which has no
 * locking and whose load->work->save cycle erases concurrent writes.
 *
 * Three values and only one of them is load-bearing:
 *   false      the user ran `git-filter off`. Never auto-enable again.
 *   true       the user ran `git-filter on`. Behaves identically to absent.
 *   absent     not decided (a fresh install, or one that predates this).
 *
 * Deliberately NOT in util.DEFAULT_CONFIG: getConfig() deep-merges the defaults
 * into every config already on disk, so a default written there would decide
 * this on behalf of people who never agreed to it.
 *
 * `true` is stored for the sake of `git-filter status` being able to say what
 * the user asked for. It is NOT consulted as evidence that anything is
 * configured — that question is put to git itself on every single call, so no
 * cached flag can outlive the thing it claims. See ensureEnabled.
 */
function preference() {
  return (require('./util').getConfig().gitFilter || {}).enabled;
}

function setPreference(enabled) {
  const util = require('./util');
  const raw = util.loadUserConfig();
  const prev = raw.gitFilter && typeof raw.gitFilter === 'object' ? raw.gitFilter : {};
  raw.gitFilter = { ...prev, enabled };
  util.saveUserConfig(raw);
}

/**
 * Make the filter true on this machine, and mark the repos. Returns one of:
 *
 *   'off'      the user turned it off; nothing was touched
 *   'current'  git already runs a live MemBridge filter; repos re-marked
 *   'wrote'    git config was written AND read back successfully
 *   'failed'   git config did not take — carries `error`, and NOTHING claims
 *              otherwise. This is the case the codebase habitually gets wrong.
 *
 * There is no "already installed" cache. Every call asks git what is actually
 * configured (~14ms, one spawn), which is what makes the answer un-lieable and
 * what lets a wiped ~/.gitconfig or a moved install heal on the next launch.
 *
 * `force` (the explicit `git-filter on`) takes over another install's command;
 * the launch path never does, so two installs cannot ping-pong the value at
 * each other on every boot.
 */
function ensureEnabled({ force = false, only = null } = {}) {
  if (!force && preference() === false) return { state: 'off', error: null, repos: [] };
  const current = configuredCommand();
  if (!force && current && isCommandLive(current)) {
    return { state: 'current', error: null, ...markTrackedRepos(only) };
  }
  const r = configureFilter();
  if (!r.ok) return { state: 'failed', error: r.error, repos: [] };
  return { state: 'wrote', error: null, ...markTrackedRepos(only) };
}

if (require.main === module) runFilter();

module.exports = {
  FILTER_NAME, CLEAN_KEY, ATTR_HEADER,
  attrLineFor, isOurAttrLine, isCommandLive,
  stripBlocks, stripBuffer, runFilter,
  filterCommand, configuredCommand, configureFilter, unconfigureFilter, writeAttributes,
  trackedGitRepos, markTrackedRepos, preference, setPreference, ensureEnabled,
};
