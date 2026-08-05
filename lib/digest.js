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

// A FOURTH budget, for edits, for the third instance of the same lesson: the
// loud kind starves the quiet one. Edits stay NARRATIVE (they are the product,
// and isPlumbing below must keep answering false for them -- server.js and
// memorydb.js read that predicate as "is this real work") but they no longer
// share the narrative CAP with prompts, summaries and todos.
//
// Forced by subagent edits now being captured (lib/adapters/claude-code.js).
// Measured on the reporting user's live state: the Membridge project sat
// EXACTLY at the 1,000 narrative cap with 361 edits, 462 summaries, 152 prompts
// and 25 todos, and subagent capture more than doubles edit volume (+119% over
// the whole transcript corpus: 1,920 main-chain against 2,287 sidechain). Under
// one shared budget those ~790 edits would have evicted roughly 400 summaries
// and prompts -- so the change that exists to stop history going missing would
// have bought that by making other history go missing, on the one user who
// reported the problem.
//
// NOTE FOR EXISTING INSTALLS: this changes eviction behaviour. Edits survive
// longer than before, and prompts/summaries/todos get the full maxStoredEvents
// budget to themselves instead of sharing it. Nothing is deleted by the change
// itself; the next capped write simply keeps a different mix.
const DEFAULT_EDIT_EVENTS = 2000;

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
    const editCap = (config && config.maxEditEvents) || DEFAULT_EDIT_EVENTS;
    // Partition, cap each class against its own budget (still newest-wins, by
    // slicing from the tail), then re-interleave in ts order so every consumer
    // downstream still sees one chronological array. FOUR classes now: reads are
    // split out from usage so token traffic cannot evict them (see
    // DEFAULT_READ_EVENTS), and edits are split out from the rest of narrative
    // so subagent edit volume cannot evict prompts and summaries (see
    // DEFAULT_EDIT_EVENTS). Edits are still narrative to isPlumbing and to
    // every consumer of it -- only the capping budget is separate.
    const narrative = [], usage = [], reads = [], edits = [];
    for (const e of proj.events) {
      if (!isPlumbing(e)) (e && e.kind === 'edit' ? edits : narrative).push(e);
      else if (e.kind === 'read') reads.push(e);
      else usage.push(e);
    }
    if (narrative.length > cap || usage.length > plumbingCap || reads.length > readCap || edits.length > editCap) {
      proj.events = narrative.slice(-cap)
        .concat(usage.slice(-plumbingCap), reads.slice(-readCap), edits.slice(-editCap))
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

// clip, on a WORD boundary. Kept separate from clip rather than folded into
// it: clip's mid-word cut is correct for the injected context block (an agent
// reads it, the budget is the point) and wrong for anything a person reads as
// a sentence, where a stub broken inside a word reads as corrupted text rather
// than as a summary. Mirrors ui/src/data/mappers.ts clipWords, which solves
// the identical problem on the row that renders beside this one.
function clipWords(text, n) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.5 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')}…`;
}

// clip, for the two fields the Stop hook asks for as ONE BULLET PER LINE
// (decisions, gotchas). clip's `\s+` cannot tell a newline from a space, so it
// flattened four bullets into one paragraph on every path out of storage: the
// local feed (memorydb), the team wire (teamsync), the provenance payload, and
// the injected block below. The bullets were written correctly to
// summaries.jsonl every time and destroyed before any reader saw them, which
// is why asking the agent for bullets appeared to change nothing at all.
//
// Whitespace still collapses WITHIN a line. Only the breaks BETWEEN lines
// survive.
//
// A single-line value returns byte-identical to clip, on purpose. Every entry
// written before this existed is already stored flattened and its line breaks
// are unrecoverable, so the owner's call was to leave those rendering exactly
// as they do today; routing them through a different path would shift them.
function bulletClip(text, n = 140) {
  const raw = String(text == null ? '' : text);
  if (!raw.includes('\n')) return clip(raw, n);

  const lines = raw.split('\n').map(l => l.replace(/[^\S\n]+/g, ' ').trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const joined = lines.join('\n');
  if (joined.length <= n) return joined;

  // Over budget: drop whole bullets from the END rather than truncate the last
  // one. Half a bullet with an ellipsis reads as a rendering bug, and the
  // trailing bullets are the least load-bearing, since the hook asks for the
  // most important first. Never leaves a dangling separator.
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost > n) break;
    kept.push(line);
    used += cost;
  }
  // A first bullet longer than the entire budget is the one case where
  // truncating beats returning nothing.
  return kept.length ? kept.join('\n') : clip(lines[0], n);
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

// plainText, minus the newline flattening. Same markdown stripping, but the
// break BETWEEN bullets survives while runs of spaces and tabs inside one
// still collapse. Needed because plainText runs BEFORE the clip on every note
// path, so flattening here would destroy the lines before bulletClip could
// preserve them, which is exactly what happened the first time this was fixed.
function plainLines(text) {
  return String(text)
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

// The injected block is strictly ONE LINE PER FIELD: an agent parses it, and a
// raw newline inside Notes would read as the start of a new entry. So bullets
// are flattened here deliberately, joined with the separator the block already
// uses between decisions and gotchas, which keeps them legible as distinct
// items instead of running together into a sentence.
const bulletsInline = text => plainLines(text).split('\n').join(' \u00b7 ');

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

// The block's closing stamp, derived from the CONTENT above it rather than
// from the clock.
//
// WHY. inject() already refuses to write a file whose content has not changed
// (see its `updated === existing` guard), and this one line defeated that
// guard on its own: the stamp was `new Date()` at render time, minute-
// granular, so re-rendering an unchanged project produced a block differing by
// exactly this line and the file was rewritten. In a repo where the context
// file is TRACKED — the normal way a team shares instructions — that is a diff
// in a file nobody edited, which is issue #66. Derived from the newest thing
// actually rendered, an unchanged project now renders byte-identically and the
// existing guard suppresses the write for free, on every target, with no
// migration and no git awareness needed.
//
// This NARROWS the churn, it does not end it. New activity genuinely changes
// the block every session, by design; relocating the volatile content out of a
// tracked file is a separate, larger decision (docs/context-block-placement.md).
//
// THE WORDING CHANGED BECAUSE THE MEANING CHANGED. "_Last update_" described
// when MemBridge last looked. This value is when the newest rendered activity
// happened, which is a different fact, and a footer that quietly starts
// meaning something else is how documentation drifts. `lib/hooks-prime.js`
// comparable() knows both spellings so an upgrade does not read every existing
// on-disk block as stale.
//
// Sources are exactly the slices rendered above — the sessions, the teammate
// entries and the file list that made it past their caps — so "the content did
// not change" and "the stamp did not move" cannot come apart. An empty history
// gets a fixed sentence rather than an absent line or a clock reading: it has
// to be STABLE, since a project with nothing to say still renders a block.
function footerLine(sessions, team, files, maxPrompts) {
  let newest = '';
  const consider = ts => { const s = String(ts || ''); if (s > newest) newest = s; };
  for (const s of sessions || []) {
    if (s.summary || s.todos) consider(s.ts);
    else for (const p of (s.prompts || []).slice(-maxPrompts)) consider(p.ts);
  }
  for (const e of team || []) consider(e.ts);
  for (const f of files || []) consider(f.ts);
  return newest
    ? `_Latest activity: ${shortDate(newest)} UTC · synced by MemBridge_`
    : '_No activity recorded yet · synced by MemBridge_';
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
      if (notes) lines.push(`  Notes: ${clip(redactText(bulletsInline(notes), regexes), 240)}`);
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
      if (e.decisions || e.gotchas) lines.push(`  Notes: ${clip(redactText(bulletsInline([e.decisions, e.gotchas].filter(Boolean).join('\n')), regexes), 240)}`);
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
  lines.push(footerLine(sessions, team, files, maxPrompts));
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

// ---------------------------------------------------------------------------
// The day digest: one sentence per author per LOCAL calendar day, spanning
// every project that person touched that day.
//
// WHY IT LIVES HERE AND NOT IN THE CLIENT.
// ui/src/features/feed/dayCards.ts picks ONE entry's outcome verbatim and
// documents, with a test behind it, that it must never concatenate several
// rows into "a sentence nobody wrote". That rule is correct for the input it
// has. Every /api/feed row is one captured prompt, and a single session lands
// SEVERAL checkpoint rows whose text is largely a restatement of the previous
// one -- the Stop hook asks each line to restate the whole session so far
// (lib/hooks.js runAppend). Measured on this repo's own .membridge history,
// one day held 7 checkpoints across 3 sessions: joining those 7 outcomes
// prints the same statement three times over. THAT is the garbage the comment
// in dayCards.ts is about, and it is a property of the row stream, not of
// concatenation as such.
//
// The daemon holds two things the client does not:
//
//   1. It can collapse a day to one statement PER SESSION first, using the
//      supersede rule the rest of this file already applies (pickSummary:
//      a distilled checkpoint beats a harvested one, and inside a tier the
//      newest wins). Seven near-duplicates become two or three distinct
//      statements, each of which a human or an agent actually wrote.
//   2. It sees every project at once. A person's day is one thing; the feed
//      page's project boundary is an accident of pagination.
//
// Only after that collapse is a join safe, and even then it is a LISTING of
// verbatim statements, never a paraphrase. Nothing here rewrites a clause,
// nothing infers a topic, and nothing turns an intent into an outcome. A day
// with nothing to say says exactly that.
//
// NO MODEL IS CALLED. This is deterministic: same entries in, same sentence
// out, no network, no clock read beyond the local-day boundary. Introducing a
// summarizing model here would put a fabrication risk on the one surface whose
// whole job is telling a human what actually happened.
// ---------------------------------------------------------------------------

// Viewer-local calendar day as YYYY-MM-DD.
//
// MUST STAY IDENTICAL to ui/src/data/localTime.ts's localDayKey, which is what
// the feed's day cards key on. getFullYear/getMonth/getDate (never getUTC*):
// `toISOString().slice(0, 10)` is a UTC day, and it filed an evening session
// west of Greenwich under TOMORROW. The daemon and the UI agree here because
// they run on the same machine -- the dashboard is served on loopback only, so
// the browser's resolved zone IS this process's zone. test/suites/day-digest
// extracts localDayKey from the UI source and runs both over the same instants
// rather than trusting that sentence.
function dayKeyLocal(d) {
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Said when the day has entries but none of them landed any text. Deliberately
// not a sentence about the work: nothing here knows what the work was, and
// inventing a summary is the one thing this must never do. Same words as
// dayCards.ts's NO_SUMMARY_OVERVIEW so the two surfaces cannot disagree.
const NO_DAY_SUMMARY = 'No summary yet for this day.';

// A DIFFERENT fact from the line above: the rows arrived as ciphertext this
// machine could not read. Without saying so, a reader cannot tell a quiet day
// from a broken key. Mirrors dayCards.ts's OPAQUE_OVERVIEW.
const OPAQUE_DAY_SUMMARY = 'Encrypted: these sessions could not be read on this machine.';

// How many session statements the sentence may carry. Three is where a day
// still reads as one line: real days measured on this repo hold one to three
// summarized sessions, and a busy one holds six, at which point a six-clause
// run-on is worse than an honest "and 3 more". Anything dropped is COUNTED,
// never silently discarded -- renderBlock's rule, that a capped view must say
// it is capped.
const DAY_CLAUSE_LIMIT = 3;

// Identity of one person, matching dayCards.ts's authorPart exactly: ids where
// available, display names as the fallback, in separate namespaces so a person
// whose display name equals someone else's user id can never collide.
//
// The fallback is load-bearing, but NOT for the reason the neighbouring UI
// comment gives. `author_id uuid not null` has been in memory_entries since
// the original CREATE TABLE (supabase/schema.sql) and no migration ever added
// it, so there is no such thing as a team row that predates the column. What
// IS reachable: a SIGNED-OUT machine. server.js feedPayload passes
// `authorId: creds ? creds.userId : null`, so every local entry of a user who
// is not signed in arrives here with a null id under the display name 'You'.
// Keying on the id alone would fold that person's whole day into a bucket
// named after nobody.
function digestAuthorPart(e) {
  const norm = v => String(v == null ? '' : v).trim().toLowerCase();
  return e.authorId ? `id:${norm(e.authorId)}` : `name:${norm(e.author)}`;
}

// The id the UI already builds for a feed row (ui/src/data/mappers.ts
// streamEntryId). Emitted verbatim so a card can link its sentence at the
// session it describes without the daemon inventing a second identity scheme.
const digestEntryId = e => `${e.session || 'none'}|${e.ts}`;

// Shortest a SCAVENGED statement may be. It is a FILTER, never a clip: under
// it the candidate is skipped and the next one in the session is tried, and if
// nothing in the session clears it the session contributes no clause at all.
//
// WHY THERE IS A FLOOR ON ONE PATH AND NOT THE OTHER. The two sources below
// are not the same kind of text. A headline, and the `did` prose of a
// distilled checkpoint, were written to BE a statement about the session
// (lib/hooks.js asks for exactly that). The opening sentence of a harvested
// summary was not: a harvested summary is the last thing an agent said in a
// chat, and its first sentence is very often a reply to the person rather than
// a report of the work. Andrew saw the result on a real card, whose third
// clause was "Completely agree."
//
// MEASURED, over every entry the real feed serves (589 entries, 2026-07-13 to
// 2026-08-05, 195 of which produce a statement at all):
//
//   authored (33 headlines + 8 distilled openings)  0 filler, shortest 45 chars
//   scavenged (154 harvested openings)             ~25% filler, shortest 4 chars
//
// Requiring authorship outright was measured too and rejected: it takes 15 of
// the 33 day buckets from a real sentence to "No summary yet for this day",
// because distillation is recent and consent-gated, so a machine that never
// ran the Stop hook would lose the feature entirely.
//
// Length is what is left, and it does NOT come from a clean gap the way the
// UI's DAY_ASK_MIN did (nothing at all lived between 11 and 25 there). Here
// real and filler interleave the whole way up: filler at 29 ("Done and
// verified end-to-end."), 38 ("You're right, and I was wrong earlier."), 40
// ("Here's the whole picture in plain terms."); real at 27, 34, 37, 40. What
// the corpus does say is where the filler STOPS: the longest is 40, and the
// shortest statement anyone deliberately authored is 45. 42 sits between the
// two, and re-running the whole corpus at every floor from 30 to 46 produces
// byte-identical day digests, so the exact value is not load-bearing -- it is
// a plateau, not a fitted threshold. At 28 and below the filler comes back; at
// 50 and above a real day goes dark.
//
// The cost is honest and small: a short harvested report ("0.2.9 is live on
// npm with provenance.") is dropped along with the filler, because at 40
// characters the two classes genuinely overlap and no measurement separates
// them. A gap is honest, filler is not. Nothing short and real is lost on the
// authored path, which is why "Shipped 0.3.2." still renders when someone
// wrote it as a headline.
const SCAVENGED_STATEMENT_MIN = 42;

// One session's statement: the headline verbatim when it landed one, else the
// summary's FIRST SENTENCE. Same ladder as mappers.ts outcomeOf, for the same
// reason -- only 4 of 21 rows measured off a real teammate carry a headline,
// and the full summary is a 750-1000 character paragraph that is not a
// sentence about a day. `.` inside a path or a version (lib/feed.js, v0.3.2)
// is not a sentence end, so a stop must be followed by whitespace.
//
// Returns the text together with whether it STANDS as a session's statement
// (see SCAVENGED_STATEMENT_MIN), because the caller needs to tell "this
// session said nothing" from "this session said nothing usable" -- the second
// one is a session the digest owes the reader a count of.
//
// The floor is measured on the source sentence, BEFORE clipWords: clipping is
// a render budget, and a 900-character report that happens to clip at 41 is
// not a two-word acknowledgement.
function statementFor(e, max) {
  const headline = String(e.headline == null ? '' : e.headline).trim();
  if (headline) return { text: clipWords(headline, max), stands: true };
  const summary = plainText(String(e.summary == null ? '' : e.summary)).trim();
  if (!summary) return null;
  const stop = /[.!?](\s|$)/.exec(summary);
  const first = stop ? summary.slice(0, stop.index + 1) : summary;
  const source = first.length <= max ? first : summary;
  return {
    text: clipWords(source, max),
    stands: !!e.distilled || source.length >= SCAVENGED_STATEMENT_MIN,
  };
}

// The one statement that stands for a session, over that session's entries.
// Identical tiering to pickSummary: distilled beats harvested outright, and
// inside a tier the newest wins, because a later checkpoint restates the whole
// session so far and therefore supersedes its own earlier ones.
//
// A candidate that does not stand is SKIPPED rather than settled for, so a
// session whose newest checkpoint opens on an acknowledgement falls through to
// the newest one that actually states something. `rejected` counts what was
// skipped, so a session left with nothing can be disclosed instead of quietly
// dropped.
//
// An undecryptable row is skipped whatever it carries. Its content fields are
// nulled fail-closed by lib/feed.js, so text on one could only have come from
// the server's untrusted plaintext columns -- and text this machine could not
// verify must never become a person's day.
function pickSessionStatement(entries, max) {
  let best = null;
  let bestText = '';
  let rejected = 0;
  for (const e of entries) {
    if (!e || e.undecryptable) continue;
    const candidate = statementFor(e, max);
    if (!candidate || !candidate.text) continue;
    if (!candidate.stands) {
      rejected++;
      continue;
    }
    const tier = e.distilled ? 1 : 0;
    const bestTier = best ? (best.distilled ? 1 : 0) : -1;
    if (tier > bestTier || (tier === bestTier && String(e.ts) >= String(best.ts))) {
      best = e;
      bestText = candidate.text;
    }
  }
  return { statement: best ? { entry: best, text: bestText } : null, rejected };
}

// Fold a page of normalized feed entries (lib/feed.js shape) into one digest
// per author per local day, newest day first.
//
// opts.truncatedBefore is the page's `nextBefore` cursor: the ts below which
// entries exist but were not served. ONLY the day that cursor falls in can be
// partial -- every older day is absent from the page entirely and produces no
// digest at all -- so that one day is marked `complete: false` and says so.
// Reporting a partial day as whole is the same class of lie as inventing a
// summary: the sentence would be true of the rows it saw and false of the day
// it names.
function buildDayDigests(entries, opts = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const max = (opts && opts.clauseMax) || require('./hooks').HEADLINE_MAX;
  const limit = (opts && opts.clauseLimit) || DAY_CLAUSE_LIMIT;
  const partialDay = opts && opts.truncatedBefore
    ? (() => {
      const t = new Date(opts.truncatedBefore);
      return Number.isFinite(t.getTime()) ? dayKeyLocal(t) : null;
    })()
    : null;
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
  })();

  const buckets = new Map();
  for (const e of entries) {
    if (!e || !e.ts) continue;
    const at = new Date(e.ts);
    // An unparseable ts has no day. Dropping it is the only honest option:
    // filing it under today would attribute work to a day it may not belong to.
    if (!Number.isFinite(at.getTime())) continue;
    const day = dayKeyLocal(at);
    const key = `${day} ${digestAuthorPart(e)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { key, day, entries: [] }));
    b.entries.push(e);
  }

  const digests = [];
  for (const bucket of buckets.values()) {
    // Newest first inside the bucket, so "the newest entry wins" holds for
    // every rule below without each one re-sorting.
    const rows = bucket.entries.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const newest = rows[0];

    // A session id identifies a session; a session-less row (the rare bare
    // entry) is only ever itself. Falling back to a shared '' key would count
    // every session-less row in a day as ONE session -- the same non-scoped-key
    // mistake dayCards.ts's sessionCountOf documents.
    const bySession = new Map();
    for (const e of rows) {
      const sk = e.session || `entry:${digestEntryId(e)}`;
      if (!bySession.has(sk)) bySession.set(sk, []);
      bySession.get(sk).push(e);
    }

    const statements = [];
    // Sessions that HAD candidate text and produced no statement from any of
    // it. Distinct from a session that landed no text at all: this one worked
    // and said something, the digest just will not put words in its mouth.
    let unstatedSessions = 0;
    for (const sessionRows of bySession.values()) {
      const { statement, rejected } = pickSessionStatement(sessionRows, max);
      if (statement) statements.push(statement);
      else if (rejected) unstatedSessions++;
    }
    // Oldest first: a day reads in the order it happened. The CAP, though,
    // keeps the NEWEST statements, because later work supersedes earlier work
    // -- the same reason every other pick in this file is newest-first.
    statements.sort((a, b) => String(a.entry.ts).localeCompare(String(b.entry.ts)));

    // Two sessions can land byte-identical text (a restarted session, a
    // re-run task). Keep the later one; dropping the duplicate is not a
    // paraphrase, it is not saying the same thing twice.
    const seen = new Set();
    const distinct = [];
    for (let i = statements.length - 1; i >= 0; i--) {
      const norm = statements[i].text.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      distinct.unshift(statements[i]);
    }

    const kept = distinct.slice(-limit);
    const undecryptableEntries = rows.filter(e => e.undecryptable).length;
    const complete = !(partialDay && partialDay === bucket.day);
    const cappedSessions = distinct.length - kept.length;
    // ONE number for "sessions this sentence does not speak for", whatever the
    // reason. The two reasons are disclosed separately in the note below, but
    // they have to land in the same field: dayCards.ts coverageNoteFor renders
    // the note only when omittedSessions > 0, so a skipped session that stayed
    // out of this count would be a silent omission on the card -- exactly what
    // renderBlock's "a capped view must SAY it is capped" rule forbids.
    const omittedSessions = cappedSessions + unstatedSessions;

    let text;
    let kind;
    if (kept.length) {
      // Every clause is verbatim; the only thing added is the separator and
      // the order. `; ` rather than `, ` because these are whole statements,
      // several of which already contain commas of their own.
      text = kept.map(s => s.text).join('; ');
      kind = kept.every(s => s.entry.distilled) ? 'distilled' : 'summary';
    } else if (undecryptableEntries) {
      text = OPAQUE_DAY_SUMMARY;
      kind = 'undecryptable';
    } else {
      text = NO_DAY_SUMMARY;
      kind = 'none';
    }

    // What the sentence is NOT showing, ready to render. A number the caller
    // has to notice is a number the caller will forget; this is the same
    // reason renderBlock builds its "showing the last 5 of 23" line itself
    // rather than shipping two counts and hoping.
    const notes = [];
    if (cappedSessions > 0) notes.push(`${cappedSessions} more session${cappedSessions === 1 ? '' : 's'} not shown`);
    // Said as its own fact, not folded into the line above: "not shown" would
    // imply the statement exists somewhere a reader could go and find it, and
    // for these sessions it does not.
    if (unstatedSessions > 0) {
      notes.push(unstatedSessions === 1
        ? '1 session left out, nothing in it reads as a statement of the work'
        : `${unstatedSessions} sessions left out, nothing in them reads as a statement of the work`);
    }
    if (!complete) notes.push('showing only the part of this day that has loaded');

    digests.push({
      key: bucket.key,
      day: bucket.day,
      tz,
      author: newest.author || '',
      authorId: newest.authorId || null,
      kind,
      text,
      sources: kept.map(s => ({
        entryId: digestEntryId(s.entry),
        session: s.entry.session || null,
        ts: s.entry.ts,
        project: s.entry.project || '',
        projectId: s.entry.projectId || null,
        distilled: !!s.entry.distilled,
        text: s.text,
      })),
      sessions: bySession.size,
      summarized: distinct.length,
      omittedSessions,
      // The two halves of omittedSessions, so a reader (or a later surface)
      // can tell "there was more to say and the cap cut it" from "there was
      // nothing here worth saying in the writer's own words".
      cappedSessions,
      unstatedSessions,
      undecryptableEntries,
      projects: [...new Set(rows.map(e => e.project).filter(Boolean))].sort(),
      entries: rows.length,
      complete,
      coverageNote: notes.length ? notes.join('; ') : null,
    });
  }

  return digests.sort((a, b) => (a.day === b.day ? a.key.localeCompare(b.key) : b.day.localeCompare(a.day)));
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
  compileRedactions, redactText, clip, clipWords, bulletClip, plainText, plainLines, shortDate, relativeLabel, recentPrompts, recentFiles,
  // The per-author-per-local-day digest (see the block above buildDayDigests).
  dayKeyLocal, buildDayDigests, DAY_CLAUSE_LIMIT, NO_DAY_SUMMARY, OPAQUE_DAY_SUMMARY,
  sessionGroups, todoCounts, pickSummary, sessionSummaries, teamInjectSlice, formatChanges,
  // Exported for the suite: which agent's MCP registration gates the
  // standing MCP-usage line for a given target file.
  TARGET_MCP_AGENT, mcpLiveFor, NOTE_MAX,
};
