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
    files: Array.isArray(e.files) ? e.files : [],
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
    files: Array.isArray(row.files) ? row.files : [],
    tasks: null,
    cursor: (row.created_at != null && row.id != null)
      ? { createdAt: row.created_at, id: row.id } : null,
  };
}

module.exports = { normalizeLocal, normalizeTeam };
