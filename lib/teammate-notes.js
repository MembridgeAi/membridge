'use strict';
// Pure logic for the teammate-notes index: build it from decrypted teammate
// rows, decide what to deliver, mark what was delivered, format it.
//
// NO fs AND NO CLOCK LIVE HERE. Every function that needs the time takes an
// injected `now` (ISO string), so the repetition rules below are table-testable
// with plain object literals -- the same contract lib/ledger-fold.js holds.
// The fs layer is lib/teammate-notes-store.js.
//
// THE RULES (spec §5), because they are the whole feature:
//   - Prose decisions deliver ONCE, GLOBALLY. A rename is a fact; once told,
//     you know.
//   - File notes deliver once PER SESSION, per file. A standing condition is
//     still true tomorrow and tomorrow's agent does not know it.
//   - The clock governs REPETITION, NOT FIRST DELIVERY. Anything never shown
//     never expires -- a teammate on holiday must not lose decisions made
//     while they were away.
//   - REFIRE_DAYS bounds only the re-firing of file notes on contact.
const crypto = require('crypto');
const redact = require('./redact');

const PROSE_CAP = 3;        // spec §5: hard cap per injection
const REFIRE_DAYS = 7;      // spec §5: governs re-firing only
const MAX_PROSE = 200;      // spec §4: index bounds; the feed is the full record
const MAX_FILES = 500;
const SEEN_PRUNE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const str = v => (typeof v === 'string' ? v : '');

// Stable across rebuilds: the index is rewritten on every team pull, and an id
// that changed would re-deliver everything already marked seen.
function noteId(author, ts, text) {
  return crypto.createHash('sha1').update(`${author} ${ts} ${text}`).digest('hex').slice(0, 16);
}

function emptyIndex() {
  return { version: 1, updatedAt: null, prose: [], byFile: {}, seen: { prose: {}, file: {} } };
}

// Belt and braces (spec §8): the text was already redacted locally before push
// and scrubbed again in teamsync's entryToRow. This is the last gate before it
// can reach an agent context, and it is the only one this module controls.
const clean = s => redact.redactDefault(str(s)).trim();

// entries: decrypted teammate rows. prev: the previous index, whose `seen` is
// carried forward -- rebuilding must never resurrect an already-delivered note.
function buildIndex(entries, prev, now) {
  const carried = prev && prev.seen ? prev.seen : { prose: {}, file: {} };
  const index = emptyIndex();
  index.updatedAt = now;
  index.seen = {
    prose: { ...(carried.prose || {}) },
    file: { ...(carried.file || {}) },
  };

  const prose = [];
  const byFile = {};

  for (const row of Array.isArray(entries) ? entries : []) {
    if (!row || typeof row !== 'object') continue;
    const author = str(row.author_name) || 'a teammate';
    const ts = str(row.ts);
    if (!ts) continue;

    for (const kind of ['decision', 'gotcha']) {
      const text = clean(kind === 'decision' ? row.decisions : row.gotchas);
      if (!text) continue;
      prose.push({ id: noteId(author, ts, text), author, ts, kind, text });
    }

    for (const c of Array.isArray(row.changes) ? row.changes : []) {
      if (!c || typeof c !== 'object') continue;
      const file = str(c.file);
      const note = clean(c.note);
      if (!file || !note) continue;
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push({ id: noteId(author, ts, note), author, ts, note });
    }
  }

  // Newest first, then bounded. Dropping the OLDEST keeps the bound from
  // silently hiding what just happened.
  prose.sort((a, b) => ms(b.ts) - ms(a.ts));
  index.prose = dedupeById(prose).slice(0, MAX_PROSE);

  const paths = Object.keys(byFile).sort((a, b) => newestOf(byFile[b]) - newestOf(byFile[a]));
  for (const p of paths.slice(0, MAX_FILES)) {
    index.byFile[p] = dedupeById(byFile[p].sort((a, b) => ms(b.ts) - ms(a.ts)));
  }
  return index;
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

const newestOf = list => list.reduce((max, n) => Math.max(max, ms(n.ts)), 0);

// Unseen prose, newest first, capped. NO age filter: spec §5's "the clock
// governs repetition, not first delivery" is exactly this absence.
function selectProse(index, now) {
  const ix = index || emptyIndex();
  const seen = (ix.seen && ix.seen.prose) || {};
  const unseen = (ix.prose || []).filter(p => !seen[p.id]);
  return { items: unseen.slice(0, PROSE_CAP), overflow: Math.max(0, unseen.length - PROSE_CAP) };
}

// Notes for one path, excluding what this session already saw, and excluding
// anything past the re-fire window.
function selectFileNotes(index, relPath, sessionId, now) {
  const ix = index || emptyIndex();
  const list = (ix.byFile || {})[relPath];
  if (!Array.isArray(list) || !list.length) return [];
  const seenHere = ((ix.seen && ix.seen.file) || {})[sessionId] || {};
  const cutoff = ms(now) - REFIRE_DAYS * DAY_MS;
  return list.filter(n => !seenHere[n.id] && ms(n.ts) >= cutoff);
}

function markProseSeen(index, ids, now) {
  const ix = index || emptyIndex();
  const next = { ...((ix.seen && ix.seen.prose) || {}) };
  for (const id of ids || []) next[id] = now;
  return { ...ix, seen: { prose: next, file: { ...((ix.seen && ix.seen.file) || {}) } } };
}

function markFileSeen(index, sessionId, ids, now) {
  const ix = index || emptyIndex();
  const files = { ...((ix.seen && ix.seen.file) || {}) };
  const forSession = { ...(files[sessionId] || {}) };
  for (const id of ids || []) forSession[id] = now;
  files[sessionId] = forSession;
  return { ...ix, seen: { prose: { ...((ix.seen && ix.seen.prose) || {}) }, file: files } };
}

// Session records are keyed by session id and would otherwise grow forever.
// Prose markers are NOT pruned: "delivers once, globally" has no expiry, and
// dropping a marker would re-deliver a decision the user already read.
function pruneSeen(index, now) {
  const ix = index || emptyIndex();
  const cutoff = ms(now) - SEEN_PRUNE_DAYS * DAY_MS;
  const files = {};
  for (const [sessionId, marks] of Object.entries((ix.seen && ix.seen.file) || {})) {
    const newest = Object.values(marks).reduce((max, t) => Math.max(max, ms(t)), 0);
    if (newest >= cutoff) files[sessionId] = marks;
  }
  return { ...ix, seen: { prose: { ...((ix.seen && ix.seen.prose) || {}) }, file: files } };
}

function formatProse(items, overflow) {
  if (!items || !items.length) return '';
  const lines = items.map(i => `- ${i.author}: ${i.text}`);
  const head = overflow > 0
    ? `Teammate decisions you have not seen yet (${items.length} of ${items.length + overflow} — the rest are in the MemBridge feed):`
    : 'Teammate decisions you have not seen yet:';
  return [head, ...lines].join('\n');
}

function formatFileNotes(items) {
  if (!items || !items.length) return '';
  const lines = items.map(i => `- ${i.author}: ${i.note}`);
  return ['Teammate notes on this file:', ...lines].join('\n');
}

module.exports = {
  PROSE_CAP, REFIRE_DAYS, MAX_PROSE, MAX_FILES, SEEN_PRUNE_DAYS,
  emptyIndex, buildIndex, selectProse, selectFileNotes,
  markProseSeen, markFileSeen, pruneSeen,
  formatProse, formatFileNotes, noteId,
};
