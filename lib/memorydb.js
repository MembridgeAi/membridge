'use strict';
const fs = require('fs');
const path = require('path');
const digest = require('./digest');
const { deriveChanges } = require('./changes');

// Per-project memory database, stored inside the project at .membridge/:
//   memory.json  — structured DB: memory entries + an index of the project's
//                  local files, so entries can reference the exact files each
//                  AI touched and any other LLM can be pointed at them
//   memory.md    — the same memory rendered as markdown for humans and agents
//
// Both are derived deterministically from the project's event history, so
// they can always be regenerated and never drift from the source of truth.

const DIR_NAME = '.membridge';
const DB_VERSION = 1;

const toPosix = p => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------
function buildFileIndex(projectPath, config) {
  const ignore = new Set(config.indexIgnore || []);
  const max = config.maxIndexFiles || 2000;
  const files = [];
  let truncated = false;

  (function walk(dir, rel) {
    if (files.length >= max) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, r);
      } else if (e.isFile()) {
        if (files.length >= max) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        files.push({ path: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  })(projectPath, '');

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { updatedAt: new Date().toISOString(), truncated, count: files.length, files };
}

// ---------------------------------------------------------------------------
// Entries: one entry per prompt, with the files edited afterwards (up to the
// next prompt) attached — "what was asked, and which files it touched".
// ---------------------------------------------------------------------------
// Files outside the project are dropped entirely: entries can be pushed to
// team sync, a foreign absolute path would leak usernames and machine layout,
// and even the basename of a scratch file carries no signal for teammates.
// Returns null for such paths.
function relFile(projectPath, file) {
  try {
    const r = path.relative(projectPath, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return toPosix(r);
  } catch {}
  return null;
}

function buildEntries(projectPath, proj, config) {
  const regexes = digest.compileRedactions(config);
  const maxEntries = config.maxEntries || 100;
  const entries = [];
  let current = null;
  // Summaries and todo state belong to the ask they answer: the most recent
  // entry of the same session. Candidate summaries are collected per entry
  // and settled by digest.pickSummary at the end, so the Distilled-beats-
  // harvested rule is the same one every other surface uses.
  const lastInSession = new Map();
  const summariesFor = new Map(); // entry -> its candidate summary events

  for (const ev of proj.events) {
    if (ev.kind === 'prompt') {
      current = {
        ts: ev.ts,
        source: ev.source,
        session: ev.session || '',
        // Redact before clipping: truncation must not break a pattern's anchor.
        ask: digest.clip(digest.redactText(ev.text || '', regexes), 300),
        files: [],
      };
      entries.push(current);
      lastInSession.set(current.session, current);
    } else if (ev.kind === 'edit' && ev.file) {
      const rel = relFile(projectPath, ev.file);
      if (rel === null) continue;
      if (!current || current.source !== ev.source) {
        current = { ts: ev.ts, source: ev.source, session: ev.session || '', ask: '(file edits)', files: [] };
        entries.push(current);
        lastInSession.set(current.session, current);
      }
      if (!current.files.includes(rel)) current.files.push(rel);
    } else if (ev.kind === 'summary' && ev.text) {
      const entry = lastInSession.get(ev.session || '');
      if (entry) {
        if (!summariesFor.has(entry)) summariesFor.set(entry, []);
        summariesFor.get(entry).push(ev);
      }
    } else if (ev.kind === 'todos' && Array.isArray(ev.items)) {
      const entry = lastInSession.get(ev.session || '');
      if (entry) {
        entry.tasks = {
          ...digest.todoCounts(ev.items),
          items: ev.items.map(i => ({
            text: digest.clip(digest.redactText(digest.plainText(i.text || ''), regexes)),
            status: i.status,
          })),
        };
      }
    }
  }
  const clipSummary = (text, n) => digest.clip(digest.redactText(digest.plainText(text), regexes), n);
  for (const [entry, evs] of summariesFor) {
    const best = digest.pickSummary(evs);
    if (!best) continue;
    entry.summary = clipSummary(best.text, 300);
    if (best.goal) entry.goal = clipSummary(best.goal, 160);
    if (best.decisions) entry.decisions = clipSummary(best.decisions, 240);
    if (best.gotchas) entry.gotchas = clipSummary(best.gotchas, 240);
    entry.changes = deriveChanges(projectPath, entry.files, best.highlights || [])
      .map(c => (c.note ? { ...c, note: clipSummary(c.note, 80) } : c));
    if (best.source === 'Distilled') entry.distilled = true;
  }
  // A long session leaves a trail of distilled checkpoints, each bucketed to
  // whichever prompt was current when it was written — so the full ordered
  // sequence exists only at the session level. Collect it across the whole
  // event stream and attach it to one entry per session, the latest summary-
  // bearing one, for the "go deeper" view; the context block and team push
  // still take only the latest checkpoint (that entry's summary). The other
  // entries' summaries are earlier steps of the same trail, so they are
  // cleared rather than left pinned to asks they don't answer. Single-
  // checkpoint and harvested-only sessions are untouched.
  const repFor = new Map(); // session -> its latest summary-bearing entry
  for (const entry of entries) {
    if (entry.summary) repFor.set(entry.session, entry);
  }
  for (const [session, rep] of repFor) {
    const seq = digest.sessionSummaries(proj.events, session);
    if (seq.length < 2 || seq[0].source !== 'Distilled') continue;
    for (const entry of entries) {
      if (entry !== rep && entry.session === session) {
        delete entry.summary;
        delete entry.distilled;
        delete entry.goal;
        delete entry.decisions;
        delete entry.gotchas;
        delete entry.changes;
      }
    }
    rep.summary = clipSummary(seq[seq.length - 1].text, 300);
    rep.distilled = true;
    rep.checkpoints = seq.map(e => clipSummary(e.text, 240));
  }
  return entries.slice(-maxEntries);
}

// Aggregate counts for the project page's stat row, all from local events:
// distinct sessions active in the last 7 days, distinct project files ever
// touched, and still-open todos counting only the latest snapshot per session
// (so a session that keeps re-emitting its todo list is not double-counted).
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function projectStats(projectPath, proj, now = Date.now()) {
  const events = Array.isArray(proj && proj.events) ? proj.events : [];
  const weekAgo = now - WEEK_MS;
  const sessions = new Set();
  const files = new Set();
  const latestTodos = new Map(); // session -> { ts, items }
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    if (Number.isFinite(t) && t >= weekAgo) sessions.add(ev.session || '');
    if (ev.kind === 'edit' && ev.file) {
      const rel = relFile(projectPath, ev.file);
      if (rel !== null) files.add(rel);
    } else if (ev.kind === 'todos' && Array.isArray(ev.items)) {
      const s = ev.session || '';
      const prev = latestTodos.get(s);
      if (!prev || String(ev.ts) >= String(prev.ts)) latestTodos.set(s, { ts: ev.ts, items: ev.items });
    }
  }
  let openTodos = 0;
  for (const snap of latestTodos.values()) {
    openTodos += snap.items.filter(i => i && i.status !== 'completed').length;
  }
  return { sessionsThisWeek: sessions.size, filesTouched: files.size, openTodos };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderMemoryMd(projectPath, db, config) {
  const name = path.basename(projectPath);
  const shown = db.entries.slice(-30);
  const lines = [];
  lines.push(`# Project memory — ${name}`);
  lines.push('');
  lines.push('_Cross-tool AI activity log, maintained by MemBridge. Any AI agent reading this: it records what other AI tools recently did in this project and which files they touched. Auto-generated — do not edit._');
  lines.push('');
  for (const e of shown) {
    lines.push(`## ${digest.shortDate(e.ts)} · ${e.source}`);
    lines.push('');
    lines.push(e.ask);
    if (e.checkpoints && e.checkpoints.length > 1) {
      lines.push('');
      lines.push('Checkpoints:');
      e.checkpoints.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    } else if (e.summary) {
      lines.push('');
      lines.push(`Result: ${e.summary}`);
    }
    if (e.tasks) {
      lines.push('');
      lines.push(`Tasks (${e.tasks.done}/${e.tasks.total} done):`);
      for (const t of e.tasks.items || []) {
        lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.text}`);
      }
    }
    if (e.files.length) {
      lines.push('');
      lines.push(`Files: ${e.files.map(f => `\`${f}\``).join(', ')}`);
    }
    lines.push('');
  }
  const idx = db.fileIndex;
  lines.push('---');
  lines.push('');
  lines.push(`File index: ${idx.count}${idx.truncated ? '+' : ''} files indexed at ${digest.shortDate(idx.updatedAt)} — full list with sizes and timestamps in \`${DIR_NAME}/memory.json\`.`);
  const topLevel = [...new Set(idx.files.map(f => f.path.split('/')[0]))].slice(0, 20);
  if (topLevel.length) lines.push(`Top level: ${topLevel.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

// A compact handoff for web AIs that cannot see this machine: the same
// redacted entries as memory.md, trimmed to fit a chat box. Served to the
// dashboard's per-project "Copy for AI" button.
function renderCopyText(projectPath, proj, config) {
  const name = path.basename(projectPath);
  const entries = buildEntries(projectPath, proj, config).slice(-12);
  const lines = [];
  lines.push(`Context on my local project "${name}" — recent AI coding work, digested by MemBridge ${digest.shortDate(new Date().toISOString())} UTC.`);
  lines.push('Treat this as background so you know what has already been done; no need to summarize it back.');
  lines.push('');
  if (entries.length) {
    lines.push('Recent asks (oldest first):');
    for (const e of entries) {
      const files = e.files.length ? ` — files: ${e.files.join(', ')}` : '';
      lines.push(`- ${digest.shortDate(e.ts)} · ${e.source}: ${e.ask}${files}`);
      if (e.summary) lines.push(`  Result: ${digest.clip(e.summary, 240)}`);
      if (e.tasks) lines.push(`  Tasks: ${e.tasks.done}/${e.tasks.total} done`);
    }
  } else {
    lines.push('No AI activity captured in this project yet.');
  }
  const top = topLevelNames(projectPath, config);
  if (top.length) {
    lines.push('');
    lines.push(`Project top level: ${top.join(', ')}`);
  }
  lines.push('');
  lines.push(`(Fuller log lives in ${DIR_NAME}/memory.md inside the project — ask me to paste it if you need more.)`);
  return lines.join('\n') + '\n';
}

// One-level directory listing, honoring the same ignore set as the file
// index. Names only — file contents never enter the digest.
function topLevelNames(projectPath, config) {
  const ignore = new Set(config.indexIgnore || []);
  let entries;
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => !ignore.has(e.name) && !e.name.startsWith('.'))
    .map(e => (e.isDirectory() ? e.name + '/' : e.name))
    .sort()
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const dbPath = projectPath => path.join(projectPath, DIR_NAME, 'memory.json');
const mdPath = projectPath => path.join(projectPath, DIR_NAME, 'memory.md');

function loadDb(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(dbPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Rebuild the project DB + markdown from the current event history.
// Returns the list of files written (empty when nothing changed).
function updateProject(projectPath, proj, config) {
  const db = {
    version: DB_VERSION,
    project: toPosix(projectPath),
    updatedAt: new Date().toISOString(),
    fileIndex: buildFileIndex(projectPath, config),
    entries: buildEntries(projectPath, proj, config),
  };

  const written = [];
  const dir = path.join(projectPath, DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });

  // Skip writes when nothing meaningful changed (ignore volatile timestamps).
  const prev = loadDb(projectPath);
  const fingerprint = d => JSON.stringify({ e: d.entries, f: d.fileIndex.files });
  if (!prev || fingerprint(prev) !== fingerprint(db)) {
    fs.writeFileSync(dbPath(projectPath), JSON.stringify(db, null, 2));
    fs.writeFileSync(mdPath(projectPath), renderMemoryMd(projectPath, db, config));
    written.push(dbPath(projectPath), mdPath(projectPath));
  }
  return written;
}

function removeProjectMemory(projectPath) {
  const dir = path.join(projectPath, DIR_NAME);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

module.exports = { DIR_NAME, buildFileIndex, buildEntries, projectStats, renderMemoryMd, renderCopyText, topLevelNames, updateProject, loadDb, removeProjectMemory, dbPath, mdPath };
