'use strict';
const fs = require('fs');
const path = require('path');
const { normPath, EXTRA_TARGETS } = require('./util');
const redact = require('./redact');

const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

// Cursor's .mdc rule format requires YAML frontmatter as the file's literal
// first bytes, so that target gets a fixed preamble written ahead of the
// managed block instead of inside it. Every other target's preamble is ''.
const CURSOR_PREAMBLE = '---\ndescription: MemBridge shared AI memory\nalwaysApply: true\n---\n\n';
function preambleFor(target) {
  return target === EXTRA_TARGETS.cursor ? CURSOR_PREAMBLE : '';
}

const eventKey = e => [e.ts, e.source, e.kind, e.session || '', e.text || '', e.file || ''].join('|');

// Fold newly scanned events into each project's rolling history (deduped,
// time-sorted, capped). Returns the set of project keys that changed.
function mergeEvents(state, events, config) {
  state.projects = state.projects || {};
  const touched = new Set();
  const seen = new Map(); // project key -> Set of event keys
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
    keys.add(k);
    const stored = { ts: ev.ts, source: ev.source, kind: ev.kind };
    if (ev.text) stored.text = ev.text;
    if (ev.file) stored.file = ev.file;
    if (ev.session) stored.session = ev.session;
    if (Array.isArray(ev.items)) stored.items = ev.items;
    proj.events.push(stored);
    touched.add(key);
  }

  for (const key of touched) {
    const proj = state.projects[key];
    proj.events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const cap = (config && config.maxStoredEvents) || 200;
    if (proj.events.length > cap) proj.events = proj.events.slice(-cap);
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
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
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
  return [...bySession.values()]
    .sort((a, b) => String(a[a.length - 1].ts).localeCompare(String(b[b.length - 1].ts)))
    .slice(-maxSessions)
    .map(events => {
      const prompts = events.filter(e => e.kind === 'prompt' && e.text);
      const summary = pickSummary(events);
      const todoWrites = events.filter(e => e.kind === 'todos' && Array.isArray(e.items));
      const edits = dedupeFiles(projectPath, events.filter(e => e.kind === 'edit'), maxFiles);
      return {
        ts: events[0].ts,
        source: events[0].source,
        prompts,
        ask: prompts.length ? prompts[0].text : '',
        summary: summary ? summary.text : '',
        distilled: !!summary && summary.source === 'Distilled',
        todos: todoWrites.length ? todoWrites[todoWrites.length - 1].items : null,
        files: edits.files,
        outsideOnly: !edits.files.length && edits.outside > 0,
      };
    });
}

const todoCounts = items => ({
  done: items.filter(i => i && i.status === 'completed').length,
  total: items.length,
});

// THE rule for choosing a session's summary, shared by every surface (block,
// memory.md, copy digest, team push) so it cannot drift: an agent-written
// summary (source 'Distilled', via the Stop hook) beats a harvested last-text
// one; within the same tier the latest event wins. Callers pass time-sorted
// events; `session` narrows to one session, omit it for pre-scoped lists.
function pickSummary(events, session) {
  const tier = e => (e.source === 'Distilled' ? 1 : 0);
  let best = null;
  for (const e of events) {
    if (!e || e.kind !== 'summary' || !e.text) continue;
    if (session !== undefined && (e.session || '') !== (session || '')) continue;
    if (!best || tier(e) >= tier(best)) best = e;
  }
  return best;
}

// Every checkpoint for one session, time-ordered, for the "go deeper" view.
// Tiers don't mix: once the agent has written its own checkpoints (Distilled),
// the harvested last-text ones are noise, so only the Distilled sequence is
// returned. Falls back to the harvested summaries when there are no Distilled.
function sessionSummaries(events, session) {
  const all = events.filter(e =>
    e && e.kind === 'summary' && e.text &&
    (session === undefined || (e.session || '') === (session || '')));
  const distilled = all.filter(e => e.source === 'Distilled');
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
function renderBlock(projectPath, proj, config, target) {
  const regexes = compileRedactions(config);
  const maxPrompts = (config && config.maxPrompts) || 8;
  const sessions = sessionGroups(projectPath, proj, config);
  const files = recentFiles(projectPath, proj, config);

  const lines = [BEGIN];
  lines.push('## Shared AI memory (MemBridge)');
  lines.push('');
  lines.push('_Recent work done in this project by AI coding tools, auto-synced so each tool knows what the others did. Treat as background context. Do not edit this block — MemBridge rewrites it._');
  lines.push('');
  if (sessions.some(s => s.prompts.length || s.summary || s.todos)) {
    lines.push('Recent asks across tools:');
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
      lines.push(`  Ask: ${s.ask ? clip(redactText(s.ask, regexes)) : '(not captured)'}`);
      if (s.summary) lines.push(`  Result: ${clip(redactText(plainText(s.summary), regexes), 240)}`);
      if (s.todos) {
        const t = todoCounts(s.todos);
        lines.push(`  Tasks: ${t.done}/${t.total} done`);
      }
      if (s.files.length) lines.push(`  Files: ${s.files.map(f => f.file).join(', ')}`);
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
  const team = teamInjectSlice(proj.teamEntries, config);
  if (team.length) {
    lines.push("Teammates' AI activity (MemBridge team sync):");
    for (const e of team) {
      const f = e.files && e.files.length ? ` — files: ${e.files.slice(0, 5).join(', ')}` : '';
      // ask is null when the teammate has not opted into prompt sharing.
      const ask = e.ask ? clip(redactText(e.ask, regexes)) : '(prompt not shared)';
      lines.push(`- ${shortDate(e.ts)} · ${e.author} · ${e.source}: ${ask}${f}`);
      if (e.summary) lines.push(`  Result: ${clip(redactText(plainText(e.summary), regexes), 240)}`);
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
  if (target === 'AGENTS.md' && (!config || !config.distill || config.distill.enabled !== false) && config && config.distill && config.distill.consent === 'granted') {
    lines.push('As you complete work here, append a line to `.membridge/summaries.jsonl`: `{"session":"<your session id>","ts":"<ISO time>","did":"<1-3 sentences on what you did>","decisions":"","gotchas":""}` — plain text, only what a teammate needs. On a long session, append a new line for each further chunk of work (covering only what is new); never edit earlier lines.');
    lines.push('');
  }
  lines.push(`_Last update: ${shortDate(new Date().toISOString())} UTC · synced by MemBridge_`);
  lines.push(END);
  return lines.join('\n');
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
  let updated;
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    updated = existing.slice(0, b) + block + existing.slice(e + END.length);
  } else if (existing.trim()) {
    updated = existing.replace(/\s*$/, '\n\n') + block + '\n';
  } else {
    updated = preamble + block + '\n';
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
  const e = existing.indexOf(END);
  if (b === -1 || e === -1 || e <= b) return null;
  const before = existing.slice(0, b).replace(/\n+$/, '\n');
  const after = existing.slice(e + END.length).replace(/^\n+/, '');
  const rest = before + after;
  if (!rest.trim() || (preamble && rest.trim() === preamble.trim())) {
    fs.unlinkSync(filePath);
    if (projectRoot) removeEmptyDirs(path.dirname(filePath), projectRoot);
    return 'deleted';
  }
  fs.writeFileSync(filePath, rest);
  return 'removed';
}

module.exports = {
  BEGIN, END,
  mergeEvents, renderBlock, inject, removeBlock, preambleFor,
  compileRedactions, redactText, clip, plainText, shortDate, recentPrompts, recentFiles,
  sessionGroups, todoCounts, pickSummary, sessionSummaries, teamInjectSlice,
};
