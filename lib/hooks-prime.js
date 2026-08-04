'use strict';
// Session-start delivery of the project context block ("Shared AI memory"),
// rendered fresh from state at the moment the session starts.
//
// WHY A HOOK WHEN THE DAEMON ALREADY WRITES FILES. The daemon injects the
// block into CLAUDE.md at the project root and every linked worktree — but
// only on its own ticks. A session that starts in a JUST-CREATED worktree
// (the app's worktree-per-session default) reads whatever block was last
// COMMITTED there: days stale, or another project's. The daemon heals the
// file one tick later, after the session already loaded its context. This
// hook closes that race by riding the same SessionStart entry point the
// teammate-notes hook uses (lib/hooks-notes.js composes both into one
// envelope) and injecting a fresh render.
//
// WHY THE DEDUPE GATE. Claude Code loads CLAUDE.md from the cwd and its
// ancestors, so in the healthy steady state the daemon-written file already
// delivers this exact content and a second copy would be pure token waste on
// every session start. The gate walks the cwd's ancestor directories and
// stays silent when any CLAUDE.md there carries the same block content —
// which is the common case, because the hook renders from the same
// state.json the daemon's last tick rendered from. Only a genuinely
// missing, stale, or foreign block lets the injection through.
//
// The comparison ignores the `_Last update:` footer: shortDate is
// minute-granular, so an exact match would fail on almost every session and
// quietly turn "inject only when stale" into "inject always".
//
// GOVERNING RULE, identical to lib/hooks-notes.js and lib/hooks-recall.js:
// every failure degrades to ordinary agent behaviour. buildPrimeOutput wraps
// its whole body; a corrupt state file, an unreadable CLAUDE.md or a render
// throw all end as a silent null. Injection is only ever additionalContext;
// nothing here blocks anything.
//
// TOKEN ACCOUNTING, deliberately absent for now. The recall measurement
// queue (lib/recall-events.js) only accepts row kinds its fold settles —
// teaching lib/ledger-fold-recall-settle.js a new family is its own change,
// and the FILE-delivered block this hook substitutes for was never counted
// either. When block cost accounting lands, it should cover both paths.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const digest = require('./digest');

// How far up the ancestor walk goes. Twelve directories covers any sane
// worktree/monorepo nesting; the cap exists so a pathological cwd can never
// turn a session-start hook into a filesystem crawl.
const MAX_ANCESTOR_WALK = 12;

// Spoken to the model, not the user: the on-disk block says "MemBridge
// rewrites it", which is true of the FILE but not of this injection, and a
// session that sees both copies needs to know which one wins.
const PREFACE = 'MemBridge shared-memory context, rendered fresh for this session start. '
  + 'If a CLAUDE.md in this checkout also carries a "Shared AI memory (MemBridge)" block, '
  + 'that copy may be stale: this version supersedes it.';

// Strip the file markers: they exist so inject() can find and replace the
// block in a file it does not own. Injected context has no such need, and
// HTML comments are noise to the model.
function innerOf(block) {
  let s = block;
  if (s.startsWith(digest.BEGIN)) s = s.slice(digest.BEGIN.length);
  if (s.endsWith(digest.END)) s = s.slice(0, s.length - digest.END.length);
  return s.trim();
}

// Normalize for the stale-vs-fresh comparison: CRLF targets get their line
// endings converted by inject() on write, and the `_Last update:` footer is
// minute-granular (see the module header).
function comparable(s) {
  return s.replace(/\r\n/g, '\n').replace(/_Last update:[^\n]*/g, '').trim();
}

// Every CLAUDE.md the session's cwd can see, nearest first — the same
// upward walk Claude Code itself performs when it gathers context files.
function ancestorClaudeMds(cwd) {
  const out = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
    try {
      out.push(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'));
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// Does any CLAUDE.md visible from cwd already carry exactly this content?
// lastIndexOf for the end marker, same as inject(): a forged end marker
// inside the content must not truncate the slice being compared.
function onDiskBlockMatches(cwd, freshInner) {
  const want = comparable(freshInner);
  for (const content of ancestorClaudeMds(cwd)) {
    const b = content.indexOf(digest.BEGIN);
    const e = content.lastIndexOf(digest.END);
    if (b === -1 || e <= b) continue;
    if (comparable(content.slice(b + digest.BEGIN.length, e)) === want) return true;
  }
  return false;
}

// Build the injection, or null when there is nothing to say — which is the
// COMMON case and the compatibility contract: every existing SessionStart
// caller (and its tests) relies on an empty project producing no output.
//
// `source` semantics: 'startup' is the race this exists for; 'clear' and
// 'compact' erased whatever context the session had, so a re-render is due;
// 'resume' restores the earlier transcript (which already carried either the
// file block or a prior injection), so re-stating would be pure duplication.
// `state` is injectable for tests; production callers omit it.
function buildPrimeOutput({ projectPath, cwd, source, config, state }) {
  try {
    if (source === 'resume') return null;
    if (util.isProjectOff(projectPath, config)) return null;
    const st = state || util.loadState();
    const proj = st && st.projects ? st.projects[projectPath] : null;
    if (!proj) return null;
    const hasLocal = Array.isArray(proj.events) && proj.events.length > 0;
    if (!hasLocal && !util.teamRowsFor(proj).length) return null;

    // Same rows the daemon threads into its own renders, so the hook's output
    // (and therefore the dedupe comparison) can never drift from the file's.
    let mcpRows = null;
    try {
      mcpRows = (require('./mcp-register').lastRegistration() || {}).rows || null;
    } catch {}

    const inner = innerOf(digest.renderBlock(projectPath, proj, config, 'CLAUDE.md', undefined, mcpRows));
    if (cwd && onDiskBlockMatches(cwd, inner)) return null;
    return { text: `${PREFACE}\n\n${inner}` };
  } catch {
    return null;
  }
}

module.exports = { buildPrimeOutput };
