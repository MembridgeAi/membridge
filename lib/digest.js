'use strict';
const fs = require('fs');
const path = require('path');
const { normPath, EXTRA_TARGETS, teamRowsFor } = require('./util');
// Pure, stateless ts comparator shared with the ledger — parses mixed-precision
// ISO stamps instead of comparing them as raw strings (see lib/ledger.js).
const { byTs } = require('./ledger');
const redact = require('./redact');
const classify = require('./classify');
const { deriveChanges } = require('./changes');

// Distinct from stable MemBridge's `membridge:begin/end` anchors on purpose:
// inject() splices between them, so sharing anchors would make whichever
// edition ran last overwrite the other's block. With separate anchors each
// edition owns its own block and leaves the other's alone.
const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

// A file that uses CRLF anywhere is treated as a CRLF file, so the lines WE
// own match the ones already there. Writing LF into a CRLF CLAUDE.md leaves
// mixed endings and shows up as a whole-file diff on Windows. Mirrors
// mcp-toml.js's eolOf, which solves the identical problem for TOML targets.
const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');

// Re-line `text` to `eol`. Only ever applied to bytes WE generate (the
// rendered block, and the literal separators inject()/removeBlock() splice
// in) — never to text sliced verbatim from the user's existing file, which
// must survive byte-for-byte regardless of what it already contains.
const toEol = (text, eol) => (eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));

// SECURITY: content interpolated into the block must never be able to carry
// the block's OWN markers. Summary/goal/decisions fields are written by AI
// agents and are attacker-controllable under prompt injection, so a smuggled
// end-marker would close the managed block early — and everything after it
// would then live OUTSIDE the block, surviving every re-render AND every
// uninstall. That is a permanent foothold in the file every AI tool reads at
// startup. Rendered inert as HTML entities: still legible to a human reading
// the file, no longer a marker to anything scanning for one.
const MARKER_RE = /<!--\s*membridge:(begin|end)\s*-->/gi;
function neutralizeMarkers(s) {
  return String(s).replace(MARKER_RE, (_m, which) => `&lt;!-- membridge:${which.toLowerCase()} --&gt;`);
}

// Relative paths are logical identifiers (rendered in blocks, matched against
// DEP_RE, pushed to the team backend) — always POSIX-style, like memorydb.js
// and provenance.js already do, regardless of the OS computing them.
const toPosix = p => p.split(path.sep).join('/');

// Cursor's .mdc rule format requires YAML frontmatter as the file's literal
// first bytes, so that target gets a fixed preamble written ahead of the
// managed block instead of inside it. Every other target's preamble is ''.
const CURSOR_PREAMBLE = '---\ndescription: MemBridge shared AI memory\nalwaysApply: true\n---\n\n';
function preambleFor(target) {
  return target === EXTRA_TARGETS.cursor ? CURSOR_PREAMBLE : '';
}

// Which MCP-registration agent (lib/agent-config.js's SPECS keys, and the row
// shape lib/mcp-register.js's run() returns) reads each injected context
// file — so the "search memory over MCP" line below only ever names a tool
// that can actually reach the server FOR THIS FILE, never a blanket "MCP is
// registered somewhere" claim. CLAUDE.md/AGENTS.md are the two built-in
// targets (claude-code/codex); the extra targets deliberately share their
// config key with EXTRA_TARGETS (lib/util.js) — gemini/cursor/windsurf/copilot
// is exactly the agent id a user would declare under config.mcp.<key> to
// register MCP for that tool, so the same key does double duty here.
const TARGET_MCP_AGENT = {
  'CLAUDE.md': 'claude-code',
  'AGENTS.md': 'codex',
  [EXTRA_TARGETS.gemini]: 'gemini',
  [EXTRA_TARGETS.cursor]: 'cursor',
  [EXTRA_TARGETS.windsurf]: 'windsurf',
  [EXTRA_TARGETS.copilot]: 'copilot',
};

// A row counts as "live" the same way settingsMapper.ts's mcpChannel already
// does client-side: registered just now, or already there and left alone.
// 'skipped'/'failed'/'removed' all mean the agent cannot actually reach the
// server, so the instruction must not be printed.
const MCP_LIVE_STATUSES = new Set(['registered', 'unchanged']);

// True only when the agent that reads THIS target file has a live MCP
// registration. `mcpRows` is lib/mcp-register.js's lastRegistration().rows
// (or undefined, from any of the many call sites that render a block with no
// registration data at all) — undefined/non-array always answers false, so
// omitting the argument is the same as "not registered" rather than a crash.
function mcpLiveFor(target, mcpRows) {
  const agent = TARGET_MCP_AGENT[target];
  if (!agent || !Array.isArray(mcpRows)) return false;
  return mcpRows.some(r => r && r.agent === agent && MCP_LIVE_STATUSES.has(r.status));
}

const eventKey = e => [e.ts, e.source, e.kind, e.session || '', e.text || '', e.file || '', e.messageId || '', e.toolUseId || ''].join('|');

// Token-measurement plumbing. These kinds are inputs to the ledger only --
// nothing in memory.md, the team wire, provenance or the dashboard's activity
// surfaces is built from them. Every OTHER kind (prompt, edit, summary, todos,
// and anything a future adapter adds) is narrative: the product itself.
const PLUMBING_KINDS = new Set(['usage', 'read']);
const isPlumbing = e => PLUMBING_KINDS.has(e && e.kind);

// Plumbing outnumbers narrative roughly 7:1 on a real project, so a single
// flat cap over the whole array lets token rows evict the memory the product
// is made of (measured: ~90% narrative loss on a heavy repo). The classes
// therefore get SEPARATE budgets and are capped independently. Narrative keeps
// exactly the historical cap (config.maxStoredEvents); plumbing rides its own,
// far larger one, sized so the ledger's request window stays much fresher than
// its dedupe horizon (see lib/ledger-fold.js).
const DEFAULT_PLUMBING_EVENTS = 2000;

// Reads get a THIRD budget, separate from usage, for exactly the same reason
// usage was split off narrative: the loud kind was starving the quiet one.
// Reads and usage are both "plumbing", but usage outnumbers reads about 47:1
// -- measured on a real project, 1,958 usage rows against 42 reads, sitting
// exactly at the shared 2,000 cap, so reads held 2% of the window and roughly
// 12 hours of history.
//
// That is fatal specifically for recall. Its whole premise is the CROSS-SESSION
// repeat read: a file one session read and a later session reads again. Seeing
// that requires the FIRST read to still be in the window days later, and under
// a shared budget it never is -- the hot set (paths more than one session has
// read) collapses to a handful, and the cache has almost nothing to warm.
// Usage volume must not be able to evict reads, whatever the token traffic.
const DEFAULT_READ_EVENTS = 2000;

// Identity of one API REQUEST, as opposed to one transcript record. A response
// with several content blocks is written as several records that repeat the
// same usage object with different timestamps, so ~57% of stored usage rows
// were duplicates of a sibling. Requests are distinguished by tool, session,
// message id and request stream (main vs sidechain) -- never by ts.
// Returns null when the event has no message id: then ts is the only thing
// telling two requests apart and collapsing them would lose real spend.
// The ledger keeps its own fold on the same identity as defence in depth.
function usageIdentity(e) {
  if (!e || e.kind !== 'usage' || !e.messageId) return null;
  return [e.source || '', e.session || '', e.messageId, e.sidechain ? 1 : 0].join('|');
}

// Fold newly scanned events into each project's rolling history (deduped,
// time-sorted, capped). Returns the set of project keys that changed.
function mergeEvents(state, events, config) {
  state.projects = state.projects || {};
  const touched = new Set();
  const seen = new Map(); // project key -> Set of event keys
  const seenUsage = new Map(); // project key -> Set of usage request identities
  // Case-insensitive filesystems (win32): map the case-folded path to the
  // stored key so tools reporting different casings share one history.
  const canon = new Map();
  for (const k of Object.keys(state.projects)) canon.set(normPath(k), k);

  for (const ev of events) {
    if (!ev || !ev.project || !ev.ts) continue;
    const resolved = path.resolve(String(ev.project));
    const norm = normPath(resolved);
    let key = canon.get(norm);
    if (!key) canon.set(norm, (key = resolved));
    const proj = state.projects[key] || (state.projects[key] = { events: [] });
    let keys = seen.get(key);
    if (!keys) {
      keys = new Set(proj.events.map(eventKey));
      seen.set(key, keys);
    }
    const k = eventKey(ev);
    if (keys.has(k)) continue;
    // Sibling records of one request differ only in ts, so eventKey above
    // never catches them -- the request-identity index does. Seeded from what
    // is already stored so the dedupe holds ACROSS sync passes too.
    const uid = usageIdentity(ev);
    if (uid) {
      let uids = seenUsage.get(key);
      if (!uids) {
        uids = new Set();
        for (const e of proj.events) { const u = usageIdentity(e); if (u) uids.add(u); }
        seenUsage.set(key, uids);
      }
      if (uids.has(uid)) continue;
      uids.add(uid);
    }
    keys.add(k);
    const stored = { ts: ev.ts, source: ev.source, kind: ev.kind };
    if (ev.text) stored.text = ev.text;
    if (ev.file) stored.file = ev.file;
    if (ev.session) stored.session = ev.session;
    if (Array.isArray(ev.items)) stored.items = ev.items;
    if (ev.goal) stored.goal = ev.goal;
    if (ev.headline) stored.headline = ev.headline;
    if (ev.decisions) stored.decisions = ev.decisions;
    if (ev.gotchas) stored.gotchas = ev.gotchas;
    if (Array.isArray(ev.highlights)) stored.highlights = ev.highlights;
    if (ev.kind === 'usage') {
      if (ev.usage) stored.usage = ev.usage;
      if (ev.messageId) stored.messageId = ev.messageId;
      if (ev.model) stored.model = ev.model;
      if (ev.sidechain) stored.sidechain = true;
    } else if (ev.kind === 'read') {
      if (ev.tool) stored.tool = ev.tool;
      if (ev.toolUseId) stored.toolUseId = ev.toolUseId;
      if (ev.messageId) stored.messageId = ev.messageId;
      if (ev.offset != null) stored.offset = ev.offset;
      if (ev.limit != null) stored.limit = ev.limit;
    }
    proj.events.push(stored);
    touched.add(key);
  }

  for (const key of touched) {
    const proj = state.projects[key];
    proj.events.sort(byTs);
    const cap = (config && config.maxStoredEvents) || 200;
    const plumbingCap = (config && config.maxPlumbingEvents) || DEFAULT_PLUMBING_EVENTS;
    const readCap = (config && config.maxReadEvents) || DEFAULT_READ_EVENTS;
    // Partition, cap each class against its own budget (still newest-wins, by
    // slicing from the tail), then re-interleave in ts order so every consumer
    // downstream still sees one chronological array. Three classes, not two:
    // reads are split out from usage so token traffic cannot evict them (see
    // DEFAULT_READ_EVENTS).
    const narrative = [], usage = [], reads = [];
    for (const e of proj.events) {
      if (!isPlumbing(e)) narrative.push(e);
      else if (e.kind === 'read') reads.push(e);
      else usage.push(e);
    }
    if (narrative.length > cap || usage.length > plumbingCap || reads.length > readCap) {
      proj.events = narrative.slice(-cap)
        .concat(usage.slice(-plumbingCap), reads.slice(-readCap))
        .sort(byTs);
    }
  }
  return touched;
}

// The one compiled redactor for a render pass: built-in default patterns
// (unless config.redactDefaults === false) plus the user's config.redact and
// the additive config.redactExtra, compiled once here rather than per event.
function compileRedactions(config) {
  const user = [];
  for (const pattern of [...((config && config.redact) || []), ...((config && config.redactExtra) || [])]) {
    try {
      user.push(new RegExp(pattern, 'gi'));
    } catch {
      // ignore invalid user pattern
    }
  }
  return { useDefaults: !config || config.redactDefaults !== false, user };
}

// THE single redaction pipeline. Defaults first (named [redacted:<name>]
// markers, incl. the entropy backstop), then user patterns ([redacted]).
// Accepts a bare regex array too, so any older/direct caller still works with
// defaults on. Always redact BEFORE clipping — truncation must not sever a
// pattern's anchor.
function redactText(text, compiled) {
  let t = String(text);
  const c = Array.isArray(compiled) ? { useDefaults: true, user: compiled } : (compiled || { useDefaults: true, user: [] });
  if (c.useDefaults) t = redact.redactDefault(t);
  for (const rx of c.user) t = t.replace(rx, '[redacted]');
  return t;
}

function clip(text, n = 140) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Compact one-line change summary for the injected block.
function formatChanges(changes) {
  if (!changes || !changes.length) return '';
  let add = 0, del = 0, counted = false;
  const parts = changes.map(c => {
    if (c.add != null) { add += c.add; counted = true; }
    if (c.del != null) { del += c.del; counted = true; }
    const tag = c.dep ? ' (deps)' : c.status === 'new' ? ` (new${c.add != null ? `, +${c.add}` : ''})`
      : c.status === 'deleted' ? ' (deleted)' : '';
    return `${c.file}${tag}`;
  });
  const totals = counted ? ` — +${add} −${del}` : '';
  return parts.join(' · ') + totals;
}

// Agent self-reports arrive as chat markdown; a one-line digest wants prose.
// Prompts are left alone — the user's own formatting is part of the ask.
function plainText(text) {
  return String(text)
    .replace(/```[a-z]*\n?/gi, ' ') // code fences
    .replace(/`([^`]*)`/g, '$1')    // inline code
    .replace(/\*\*|__/g, '')        // bold
    .replace(/^#{1,6}\s+/gm, ' ')   // headings
    .replace(/\|/g, ' ')            // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

const shortDate = ts => String(ts).slice(0, 16).replace('T', ' ');

// Human "delta" label for a project's last-touched timestamp, shown as the
// project page's activity badge. Coarse buckets only — the exact ts is shown
// elsewhere. now is injectable so tests need no wall clock.
function relativeLabel(ts, now = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 'no activity yet';
  const day = 86400000;
  const diff = now - t;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  const days = Math.floor(diff / day);
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return shortDate(ts);
}

function recentPrompts(proj, config, regexes) {
  const max = (config && config.maxPrompts) || 8;
  return proj.events
    .filter(e => e.kind === 'prompt')
    .slice(-max)
    // Redact before clipping: truncation must not break a pattern's anchor.
    .map(e => ({ ts: e.ts, source: e.source, text: clip(redactText(e.text || '', regexes)) }));
}

// Files outside the project root are dropped, not shown: an absolute
// scratchpad path leaks usernames and machine layout into synced (and
// potentially committed) files, and carries no signal for teammates.
function dedupeFiles(projectPath, edits, max) {
  const seen = new Set();
  const files = [];
  let outside = 0;
  for (let i = edits.length - 1; i >= 0 && files.length < max; i--) {
    const f = edits[i].file;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let rel = null;
    try {
      const r = path.relative(projectPath, f);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = toPosix(r);
    } catch {}
    if (rel === null) {
      outside++;
      continue;
    }
    files.push({ file: rel, source: edits[i].source });
  }
  return { files, outside };
}

function recentFiles(projectPath, proj, config) {
  const max = (config && config.maxFiles) || 10;
  return dedupeFiles(projectPath, proj.events.filter(e => e.kind === 'edit'), max).files;
}

// Per-chat view of the event history: the last maxSessions sessions, each with
// its first ask, the latest agent self-report and todo state, and the files it
// touched. The latest summary/todos win — earlier ones in the same session are
// stale by definition (the last write reflects current task state).
function sessionGroups(projectPath, proj, config) {
  const maxSessions = (config && config.maxSessions) || 5;
  const maxFiles = (config && config.maxFiles) || 10;
  const bySession = new Map();
  for (const e of proj.events) {
    const s = e.session || '';
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(e);
  }
  // proj.events is time-sorted, so each group is too; order sessions by their
  // latest activity and keep the most recent maxSessions, oldest first.
  // Ops-noise suppression: drop sessions that did no project work before the
  // recency slice, so a quiet coding history is not crowded out by
  // tool-operation sessions. Computed over the FULL history (proj.events) so the
  // edit-capturing determination sees every source's edits, not just this group.
  const shareable = classify.shareableSessions(proj.events);
  return [...bySession.values()]
    .filter(events => shareable.has((events[0] && events[0].session) || ''))
    .sort((a, b) => String(a[a.length - 1].ts).localeCompare(String(b[b.length - 1].ts)))
    .slice(-maxSessions)
    .map(events => {
      const prompts = events.filter(e => e.kind === 'prompt' && e.text);
      const summary = pickSummary(events);
      const todoWrites = events.filter(e => e.kind === 'todos' && Array.isArray(e.items));
      const edits = dedupeFiles(projectPath, events.filter(e => e.kind === 'edit'), maxFiles);
      const changes = deriveChanges(
        projectPath,
        edits.files.map(f => f.file),
        summary && summary.highlights ? summary.highlights : []);
      return {
        ts: events[0].ts,
        source: events[0].source,
        prompts,
        ask: prompts.length ? prompts[0].text : '',
        summary: summary ? summary.text : '',
        distilled: !!summary && (summary.distilled || summary.source === 'Distilled'),
        todos: todoWrites.length ? todoWrites[todoWrites.length - 1].items : null,
        files: edits.files,
        outsideOnly: !edits.files.length && edits.outside > 0,
        goal: summary && summary.goal ? summary.goal : '',
        // headline rides along with its three siblings even though renderBlock
        // has no line for it: mergeEvents already stores it on the summary
        // event, and every OTHER consumer of a session (the MCP tools, the
        // feed) wants the glance line. Leaving it out here made
        // get_project_memory the only surface that could not see it.
        headline: summary && summary.headline ? summary.headline : '',
        decisions: summary && summary.decisions ? summary.decisions : '',
        gotchas: summary && summary.gotchas ? summary.gotchas : '',
        changes,
      };
    });
}

const todoCounts = items => ({
  done: items.filter(i => i && i.status === 'completed').length,
  total: items.length,
});

// THE rule for choosing a session's summary, shared by every surface (block,
// memory.md, copy digest, team push) so it cannot drift: an agent-written
// summary (distilled:true, via the Stop hook or Codex fallback) beats a harvested last-text
// one; within the same tier the latest event wins. Callers pass time-sorted
// events; `session` narrows to one session, omit it for pre-scoped lists.
function pickSummary(events, session) {
  const tier = e => (e.distilled || e.source === 'Distilled' ? 1 : 0);
  let best = null;
  for (const e of events) {
    if (!e || e.kind !== 'summary' || !e.text) continue;
    if (session !== undefined && (e.session || '') !== (session || '')) continue;
    if (!best || tier(e) >= tier(best)) best = e;
  }
  return best;
}

// Every checkpoint for one session, time-ordered, for the "go deeper" view.
// Tiers don't mix: once the agent has written its own checkpoints, the
// harvested last-text ones are noise, so only the distilled sequence is
// returned. Falls back to the harvested summaries when there are no distilled
// events.
function sessionSummaries(events, session) {
  const all = events.filter(e =>
    e && e.kind === 'summary' && e.text &&
    (session === undefined || (e.session || '') === (session || '')));
  const distilled = all.filter(e => e.distilled || e.source === 'Distilled');
  const chosen = distilled.length ? distilled : all;
  return chosen.slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// The slice of pulled teammate entries worth injecting. Teammates' context is
// read on every agent invocation, so it must stay small: keep only the latest
// entry per (author, session) — per (author, source) when the row carries no
// session id — drop anything older than teamMaxAgeHours, and cap at
// teamInjectMax. Only the injected view is trimmed; proj.teamEntries in state
// keeps the full pulled history for the dashboard feed.
function teamInjectSlice(teamEntries, config) {
  const knob = (v, dflt) => (Number.isFinite(v) && v >= 1 ? v : dflt);
  const max = knob(config && config.teamInjectMax, 8);
  const maxAgeMs = knob(config && config.teamMaxAgeHours, 72) * 3600000;
  const latest = new Map();
  for (const e of teamEntries || []) {
    if (!e) continue;
    const key = `${e.author}|${e.session ? `s:${e.session}` : `t:${e.source}`}`;
    const prev = latest.get(key);
    if (!prev || String(prev.ts) <= String(e.ts)) latest.set(key, e);
  }
  const cutoff = Date.now() - maxAgeMs;
  return [...latest.values()]
    .filter(e => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-max);
}

// The brief memory block each AI tool will read from its context file.
// `target` is the context filename being injected: AGENTS.md readers (Codex
// et al) have no Stop hook, so that block carries a standing ask to
// self-report — requested, where the Claude Code hook path is enforced.
function renderBlock(projectPath, proj, config, target, precomputedSessions, mcpRows) {
  const regexes = compileRedactions(config);
  const maxPrompts = (config && config.maxPrompts) || 8;
  const sessions = precomputedSessions || sessionGroups(projectPath, proj, config);
  const files = recentFiles(projectPath, proj, config);

  // Elision counts: a capped view must SAY it is capped and name the way to
  // the rest, or an agent reads "5 sessions" as "all the history there is"
  // (the failure beads' `bd prime` banner exists to prevent). Headers only
  // change when something is actually hidden, so a small project's block
  // stays byte-stable.
  const mcpLive = mcpLiveFor(target, mcpRows);
  const restHint = mcpLive ? '`search_memory` reaches the rest'
    : (!config || config.writeProjectMemory !== false ? 'the full log is in `.membridge/memory.md`' : '');
  const withHint = s => (restHint ? `${s}; ${restHint}` : s);

  const lines = [];
  lines.push('## Shared AI memory (MemBridge)');
  lines.push('');
  // The old preamble said "Treat as background context" about the WHOLE block,
  // which quietly demoted the block's own instructions (the MCP procedure
  // below, the AGENTS.md self-report ask) to passive reading material. That is
  // a counter-instruction sitting above every instruction we ship here, and it
  // is the likeliest reason the MCP tools went uncalled for months on a real
  // install. Background framing now covers the activity summaries only.
  lines.push('_Recent work done in this project by AI coding tools, auto-synced so each tool knows what the others did. The activity summaries below are background context; the instructions in this block are not, and apply exactly like any other instruction in this file. Do not edit this block — MemBridge rewrites it._');
  lines.push('');
  if (sessions.some(s => s.prompts.length || s.summary || s.todos)) {
    const totalSessions = classify.shareableSessions(proj.events).size;
    lines.push(totalSessions > sessions.length
      ? `Recent asks across tools (${withHint(`showing the last ${sessions.length} of ${totalSessions} sessions`)}):`
      : 'Recent asks across tools:');
    for (const s of sessions) {
      // Redact before clipping: truncation must not break a pattern's anchor.
      if (!s.summary && !s.todos) {
        // Nothing richer than the asks — keep the original one-line format.
        for (const p of s.prompts.slice(-maxPrompts)) {
          lines.push(`- ${shortDate(p.ts)} · ${p.source}: ${clip(redactText(p.text, regexes))}`);
        }
        continue;
      }
      lines.push(`- ${shortDate(s.ts)} · ${s.source}`);
      if (s.goal) lines.push(`  Intent: ${clip(redactText(s.goal, regexes), 160)}`);
      else lines.push(`  Ask: ${s.ask ? clip(redactText(s.ask, regexes)) : '(not captured)'}`);
      if (s.summary) lines.push(`  Did: ${clip(redactText(plainText(s.summary), regexes), 400)}`);
      const notes = [s.decisions, s.gotchas].filter(Boolean).join(' · ');
      if (notes) lines.push(`  Notes: ${clip(redactText(plainText(notes), regexes), 240)}`);
      if (s.todos) {
        const t = todoCounts(s.todos);
        lines.push(`  Tasks: ${t.done}/${t.total} done`);
      }
      if (s.changes && s.changes.length) lines.push(`  Changes: ${clip(redactText(formatChanges(s.changes), regexes), 300)}`);
      else if (s.files.length) lines.push(`  Files: ${s.files.map(f => f.file).join(', ')}`);
      else if (s.outsideOnly) lines.push('  Files: (outside project)');
    }
    lines.push('');
  }
  if (files.length) {
    lines.push(`Files recently modified by AI tools: ${files.map(f => f.file).join(', ')}`);
    lines.push('');
  }
  // Entries pulled from teammates via team sync, trimmed to the freshest
  // checkpoint per teammate session. Redacted again on render as defense in
  // depth — the server should only ever hold redacted text anyway.
  const teamRows = teamRowsFor(proj);
  const team = teamInjectSlice(teamRows, config);
  if (team.length) {
    // The cache in state is capped at 100 rows; the durable archive holds the
    // long tail (~50-day median cross-teammate overlap), so its row count is
    // the honest total when it is ahead. Lazy require at call time: the
    // archive module is off renderBlock's hot path and a top-level require
    // would tie digest's load graph to it for every caller. Both reads are
    // best-effort — a missing link or sidecar degrades to the cache count.
    let teamTotal = teamRows.length;
    try {
      const link = JSON.parse(fs.readFileSync(path.join(projectPath, '.membridge', 'team.json'), 'utf8'));
      // backfillStatus reads only the tiny sidecar, never the rows file.
      const meta = link && link.projectId ? require('./team-archive').backfillStatus(link.projectId) : null;
      if (meta && meta.rowCount > teamTotal) teamTotal = meta.rowCount;
    } catch {}
    lines.push(teamTotal > team.length
      ? `Teammates' AI activity (MemBridge team sync — ${withHint(`showing the freshest ${team.length} of ${teamTotal} shared entries`)}):`
      : "Teammates' AI activity (MemBridge team sync):");
    for (const e of team) {
      const intent = e.goal ? clip(redactText(e.goal, regexes), 160) : (e.ask ? clip(redactText(e.ask, regexes)) : '(prompt not shared)');
      lines.push(`- ${shortDate(e.ts)} · ${e.author} · ${e.source}: ${intent}`);
      if (e.summary) lines.push(`  Did: ${clip(redactText(plainText(e.summary), regexes), 400)}`);
      if (e.decisions || e.gotchas) lines.push(`  Notes: ${clip(redactText(plainText([e.decisions, e.gotchas].filter(Boolean).join(' · ')), regexes), 240)}`);
      if (e.changes && e.changes.length) lines.push(`  Changes: ${clip(redactText(formatChanges(e.changes), regexes), 300)}`);
      else if (e.files && e.files.length) lines.push(`  Files: ${e.files.slice(0, 5).join(', ')}`);
    }
    lines.push('');
  }
  // The current roadmap (PLAN M3) is cross-tool memory too: one line so every
  // AI tool reading this file knows the plan and where the details live.
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(projectPath, '.membridge', 'plan.json'), 'utf8'));
    const tasks = (saved.plan.phases || []).reduce((n, p) => n + p.tasks.length, 0);
    lines.push(`Current roadmap: ${clip(redactText(saved.goal, regexes), 120)} — ${tasks} tasks · \`.membridge/plan.json\``);
    lines.push('');
  } catch {}
  if (config && config.writeProjectMemory !== false) {
    lines.push('Full activity log and project file index: `.membridge/memory.md` (structured data in `.membridge/memory.json`).');
    lines.push('');
  }
  // Standing nudge toward the MCP tools (same lever as the AGENTS.md summary
  // ask below: an instruction baked into the block every session reads, since
  // that mechanism demonstrably gets followed). Only printed when THIS
  // target's own agent is actually registered — see mcpLiveFor — so an agent
  // is never told to call a server it cannot reach.
  //
  // Written as a PROCEDURE, not as a fact with a suggestion attached. The old
  // wording ("this project's memory is ALSO queryable over MCP ... search it
  // before exploring a file fresh") failed twice over: "also" marks the tools
  // as optional and secondary, and its trigger asked the agent to classify its
  // own activity mid-task, which it will not do. What demonstrably DOES get
  // followed is the AGENTS.md self-report ask below, whose shape is a concrete
  // trigger, an exact action, and an unambiguous stopping point. This mirrors
  // that shape, with the trigger tied to an OBSERVABLE action the agent is
  // about to take (grep/glob/read to reconstruct prior work) rather than to a
  // self-assessment.
  //
  // The bound is load-bearing and must stay. An unscoped "always call this
  // first" buys reflexive calls on trivial tasks: real tokens spent, nothing
  // recalled, and it lands in the user's own ledger as waste.
  if (mcpLive) {
    lines.push('Before you grep, glob, or read files to reconstruct prior work on this project, call `search_memory` first: one call, keywords or a filename, not a sentence. Before asking why a file looks the way it does, call `why` with its path. If nothing relevant comes back, continue as normal. This applies only to reconstructing prior work, so skip it on a task that does not depend on what was done here before; `get_project_memory` returns this project\'s memory in full when you need it.');
    lines.push('');
  }
  if (target === 'AGENTS.md' && (!config || !config.distill || config.distill.enabled !== false) && config && config.distill && config.distill.consent === 'granted') {
    // Lazy require: hooks.js reaches this module through memorydb, so a
    // top-level require here would close a load cycle. The budgets must come
    // from hooks (GOAL_MAX beside HEADLINE_MAX) so the instruction and the
    // runAppend enforcement can never drift apart.
    const { GOAL_MAX } = require('./hooks');
    lines.push(`As you complete work here, append a line to \`.membridge/summaries.jsonl\`: \`{"session":"<your session id>","ts":"<ISO time>","goal":"<the intent in your own words>","did":"<1-2 sentences on what you did>","decisions":"","gotchas":"","highlights":[]}\` — plain text, only what a teammate needs; goal is the why behind the session in your own words, at most ${GOAL_MAX} characters, never a restated prompt; highlights is up to 2 key files with a short note each. On a long session, append a new line as the work grows, each one restating the WHOLE session so far so it supersedes the earlier lines; never edit earlier lines.`);
    lines.push('');
  }
  lines.push(`_Last update: ${shortDate(new Date().toISOString())} UTC · synced by MemBridge_`);
  // The markers are added HERE, around content that has been stripped of any
  // marker of its own — one chokepoint, so no future field can reintroduce the
  // escape by forgetting to sanitize itself.
  return [BEGIN, neutralizeMarkers(lines.join('\n')), END].join('\n');
}

// Idempotently place the block: replace in place if present, append to an
// existing file, or create the file (preceded by `preamble` — e.g. Cursor's
// frontmatter — only on that first creation; a preamble already on disk from
// a prior inject is left untouched, same as any other pre-existing content).
// Creates the target's parent directory if needed. Returns true if the file
// changed.
function inject(filePath, block, preamble = '') {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {}
  // Match the target's own line endings — see eolOf/toEol above. `block`
  // arrives as hard-\n from renderBlock(); everything else here (the
  // separators we splice in ourselves) must agree with it too, or the write
  // below mixes endings even though each half was internally consistent.
  const eol = eolOf(existing);
  const ownBlock = toEol(block, eol);
  let updated;
  const b = existing.indexOf(BEGIN);
  // lastIndexOf, not indexOf: if a forged end-marker ever reached the file
  // (from a version before renderBlock neutralized them, or by hand), indexOf
  // would split at the FORGED one and leave the smuggled tail orphaned outside
  // the block forever. Taking the last marker re-absorbs it on the next render.
  const e = existing.lastIndexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    updated = existing.slice(0, b) + ownBlock + existing.slice(e + END.length);
  } else if (existing.trim()) {
    updated = existing.replace(/\s*$/, eol + eol) + ownBlock + eol;
  } else {
    updated = preamble + ownBlock + eol;
  }
  if (updated === existing) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, updated);
  return true;
}

// Remove now-empty directories inject() may have created, walking upward
// from `dir` but never past `root` (a project root must never be rmdir'd).
function removeEmptyDirs(dir, root) {
  const normRoot = path.resolve(root);
  let cur = path.resolve(dir);
  while (cur !== normRoot && (cur + path.sep).startsWith(normRoot + path.sep)) {
    try {
      if (fs.readdirSync(cur).length) break;
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}

// Strip the managed block. Deletes the file if nothing else was in it —
// `preamble` (e.g. Cursor's frontmatter) counts as "nothing else" since
// MemBridge wrote it, not the user. `projectRoot`, if given, also cleans up
// any now-empty parent directories inject() created (e.g. .cursor/rules/),
// stopping at the project root. Returns 'removed', 'deleted' or null (no
// block found).
function removeBlock(filePath, opts = {}) {
  const { preamble = '', projectRoot } = opts;
  let existing;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const b = existing.indexOf(BEGIN);
  const e = existing.lastIndexOf(END); // see inject(): a forged marker must not strand the tail
  if (b === -1 || e === -1 || e <= b) return null;
  // Collapse the blank-line seam left by the removed block down to `eol`, not
  // a literal '\n' — a bare LF here is exactly the mixed-ending bug inject()
  // fixes, just on the way out instead of the way in. The runs of blank lines
  // being collapsed are made of whichever eol the file already uses, so a run
  // of CRLF pairs is matched as CRLF pairs, not decomposed into lone LFs.
  const eol = eolOf(existing);
  const blankRun = eol === '\r\n' ? /(?:\r\n)+$/ : /\n+$/;
  const leadingBlankRun = eol === '\r\n' ? /^(?:\r\n)+/ : /^\n+/;
  const before = existing.slice(0, b).replace(blankRun, eol);
  const after = existing.slice(e + END.length).replace(leadingBlankRun, '');
  const rest = before + after;
  if (!rest.trim() || (preamble && rest.trim() === preamble.trim())) {
    fs.unlinkSync(filePath);
    if (projectRoot) removeEmptyDirs(path.dirname(filePath), projectRoot);
    return 'deleted';
  }
  fs.writeFileSync(filePath, rest);
  return 'removed';
}

// How much of a session's decisions/gotchas is KEPT at capture time.
//
// These used to be clipped to 240 the moment they were built, which is what
// every reader downstream then saw: the app, the session page and the team
// wire alike. Real captured notes measure ~560 characters at the median and
// 1030 at the longest, so the majority of every note was cut mid-word --
// long enough to bait a reader, too short to answer them.
//
// The injected context block is NOT affected: renderBlock re-clips its own
// Notes line to 240 (that path is token-budgeted and stays tight). This
// bound governs the stored/displayed/pushed text only.
const NOTE_MAX = 1200;

module.exports = {
  BEGIN, END, eolOf,
  mergeEvents, isPlumbing, renderBlock, inject, removeBlock, preambleFor,
  compileRedactions, redactText, clip, plainText, shortDate, relativeLabel, recentPrompts, recentFiles,
  sessionGroups, todoCounts, pickSummary, sessionSummaries, teamInjectSlice, formatChanges,
  // Exported for the suite: which agent's MCP registration gates the
  // standing MCP-usage line for a given target file.
  TARGET_MCP_AGENT, mcpLiveFor, NOTE_MAX,
};
