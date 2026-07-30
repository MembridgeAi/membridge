// Durable per-project archive of pulled teammate rows.
//
// proj.teamEntries in state.json is a WORKING CACHE: pullProject truncates
// it to the newest MAX_TEAM_ENTRIES (100) — roughly 20 days for a 2-person
// team, under a week for a busy 5-person one — and the pull cursor advances,
// so older rows are gone from this machine forever. Search needs the long
// tail (cross-teammate overlap has a ~50-day median), so every pull also
// appends its mapped rows here, and search reads cache + archive merged.
//
// Storage: one JSON file per server-side project id under
// <homeDir>/team-archive/<projectId>.json. projectId is the team backend's
// UUID — stable across machines and worktrees, never derived from a path
// (lib/repo-root.js documents why path-derived keys fragment).
//
// Rows are stored in pullProject's `mapped` shape, RAW at rest — exactly
// like proj.teamEntries. Redaction happens at every read boundary (the feed
// normalizers' redact closure), never trusted from rest.
//
// Every function fails open: an unreadable archive is an empty one, and a
// failed write must never break a pull or a search.

const fs = require('fs');
const path = require('path');
const util = require('./util');

const MAX_ARCHIVE_ROWS = 5000;
const rowKey = r => `${r.author}|${r.ts}|${r.source}`;

function archiveDir() {
  return path.join(util.homeDir(), 'team-archive');
}

function archivePath(projectId) {
  // projectId is a server-issued UUID; strip anything path-hostile anyway.
  return path.join(archiveDir(), `${String(projectId).replace(/[^A-Za-z0-9-]/g, '_')}.json`);
}

function emptyArchive(projectId) {
  return { version: 1, projectId, backfill: { done: false, before: null }, rows: [] };
}

function loadArchive(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivePath(projectId), 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rows)) return emptyArchive(projectId);
    if (!parsed.backfill || typeof parsed.backfill !== 'object') parsed.backfill = { done: false, before: null };
    return parsed;
  } catch {
    return emptyArchive(projectId);
  }
}

function saveArchive(arc) {
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    const p = archivePath(arc.projectId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arc), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* fail-open: the archive is an accelerator, never a blocker */ }
}

// Merge-by-key with replace-on-collision — the same rule as pullProject's
// cache merge: a row re-arriving under the same (author, ts, source) is by
// definition a NEWER version (drift re-push, reshare).
function appendRows(projectId, mappedRows) {
  if (!Array.isArray(mappedRows) || !mappedRows.length) return 0;
  const arc = loadArchive(projectId);
  const seen = new Map(arc.rows.map((r, i) => [rowKey(r), i]));
  for (const r of mappedRows) {
    if (!r || !r.author || !r.ts) continue;
    const k = rowKey(r);
    if (seen.has(k)) arc.rows[seen.get(k)] = r;
    else { seen.set(k, arc.rows.length); arc.rows.push(r); }
  }
  arc.rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  arc.rows = arc.rows.slice(-MAX_ARCHIVE_ROWS);
  saveArchive(arc);
  return arc.rows.length;
}

function setBackfill(projectId, backfill) {
  const arc = loadArchive(projectId);
  // Fail-open like everything else here: a missing/malformed backfill arg
  // (a caller bug, not a disk failure) must not throw past this module's
  // documented contract — treat it as "not done, no checkpoint" instead.
  const safe = (backfill && typeof backfill === 'object') ? backfill : {};
  arc.backfill = { done: !!safe.done, before: safe.before || null };
  saveArchive(arc);
}

module.exports = { archivePath, loadArchive, appendRows, setBackfill, MAX_ARCHIVE_ROWS };
