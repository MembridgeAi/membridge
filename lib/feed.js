'use strict';

// Pure feed read-model. Transforms already-fetched arrays (no fs/network):
// local .membridge entries (memorydb.buildEntries) and team_feed RPC rows are
// normalized to one shape, merged newest-first, deduped where the same pushed
// work appears in both, and paginated with an approximate cross-source cursor.

function normalizeLocal(e, meta) {
  return {
    origin: 'local',
    ts: e.ts || '',
    self: true,
    author: 'You',
    authorId: null,
    source: e.source || '',
    project: meta.projectName || '',
    projectPath: meta.projectPath || null,
    projectId: meta.projectId || null,
    ask: e.ask || '',
    summary: e.summary || null,
    distilled: !!e.distilled,
    files: Array.isArray(e.files) ? e.files.slice() : [],
    tasks: e.tasks || null,
    cursor: null,
  };
}

function normalizeTeam(row, opts) {
  const self = !!(opts && opts.selfUserId && row.author_id === opts.selfUserId);
  return {
    origin: 'team',
    ts: row.ts || '',
    self,
    author: self ? 'You' : (row.author_name || ''),
    authorId: row.author_id || null,
    source: row.source || '',
    project: row.project_name || '',
    projectPath: null,
    projectId: row.project_id || null,
    ask: row.ask || '',
    summary: row.summary || null,
    distilled: false,
    files: Array.isArray(row.files) ? row.files.slice() : [],
    tasks: null,
    cursor: (row.created_at != null && row.id != null)
      ? { createdAt: row.created_at, id: row.id } : null,
  };
}

// Collision key for "the same pushed work in both sources". A linked local
// project shares projectId with its team rows; unlinked locals fall back to
// path, which no team row carries, so they never collide.
function dedupeKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  return proj + ' ' + (e.ts || '') + ' ' + (e.ask || '');
}

function buildFeed(input) {
  const local = Array.isArray(input.local) ? input.local : [];
  const team = Array.isArray(input.team) ? input.team : [];
  const limit = input.limit > 0 ? input.limit : 50;

  const seen = new Set(local.map(dedupeKey));
  const merged = local.concat(team.filter(t => !seen.has(dedupeKey(t))));
  merged.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const page = merged.slice(0, limit);
  const nextBefore = merged.length > limit && page.length ? page[page.length - 1].ts : null;
  return { entries: page, teamUnavailable: !!input.teamUnavailable, nextBefore };
}

module.exports = { normalizeLocal, normalizeTeam, buildFeed };
