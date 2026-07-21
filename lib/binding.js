'use strict';
// Declared project identity: a per-machine binding of a folder path to a team
// project_id, set by an explicit user action and read by team sync in place of
// the old git-remote-derived link. A sub-folder or worktree with no binding of
// its own inherits the nearest bound ancestor, so a monorepo binds sub-projects
// independently and a worktree needs no separate bind.
//
// State (~/.membridge/state.json) is the source of truth; the per-project
// .membridge/team.json is a best-effort, gitignored mirror the Stop hook and
// CLI can read without loading global state.
const fs = require('fs');
const path = require('path');
const { normPath } = require('./util');

const DIR_NAME = '.membridge';
const MIRROR = 'team.json';
const mirrorPath = folder => path.join(folder, DIR_NAME, MIRROR);

// The binding for `folder`, or the nearest bound ancestor's, or null.
function resolveBinding(state, folder) {
  const projects = (state && state.projects) || {};
  const bound = new Map(); // normPath -> { projectId, teamId }
  for (const [k, p] of Object.entries(projects)) {
    if (p && p.boundProjectId) {
      bound.set(normPath(k), { projectId: p.boundProjectId, teamId: p.boundTeamId || null });
    }
  }
  let dir = path.resolve(String(folder));
  for (;;) {
    const hit = bound.get(normPath(dir));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Best-effort mirror write. State is the source of truth; a mirror we can't
// write must never fail the bind.
function writeMirror(folder, projectId, teamId) {
  try {
    fs.mkdirSync(path.join(folder, DIR_NAME), { recursive: true });
    fs.writeFileSync(mirrorPath(folder), JSON.stringify(
      { projectId, teamId: teamId || null, boundAt: new Date().toISOString() }, null, 2));
  } catch {}
}

function bindFolder(state, folder, projectId, teamId) {
  state.projects = state.projects || {};
  const proj = state.projects[folder] || (state.projects[folder] = { events: [] });
  proj.boundProjectId = projectId;
  proj.boundTeamId = teamId || null;
  delete proj.bindSuggestion;
  writeMirror(folder, projectId, teamId);
  return proj;
}

function unbindFolder(state, folder) {
  const proj = (state.projects || {})[folder];
  if (proj) { delete proj.boundProjectId; delete proj.boundTeamId; }
  try { fs.unlinkSync(mirrorPath(folder)); } catch {}
}

// Seed bindings from legacy committed team.json files, once. Sets the binding
// in state WITHOUT rewriting the mirror (the legacy file already exists).
// Returns the count migrated; idempotent. teamsync is required lazily to avoid
// a teamsync <-> binding require cycle.
function migrateLegacyLinks(state) {
  const { loadTeamLink } = require('./teamsync');
  let n = 0;
  for (const [key, proj] of Object.entries((state && state.projects) || {})) {
    if (!proj) continue;
    const link = loadTeamLink(key);
    if (!link || !link.projectId) continue;               // no committed file -> keep any existing binding
    if (proj.boundProjectId === link.projectId) continue; // already in sync
    // Seed (binding absent) or RECONCILE: a legacy unlink+relink rewrote the
    // committed team.json to a different project, so the stale binding must not
    // shadow it. The freshly written file is the current declared intent during
    // the migration window. (bindFolder's mirror IS this same file, so a
    // binding made by the new flow always matches and never triggers here.)
    proj.boundProjectId = link.projectId;
    proj.boundTeamId = link.teamId || null;
    n++;
  }
  return n;
}

module.exports = { resolveBinding, bindFolder, unbindFolder, migrateLegacyLinks, DIR_NAME, MIRROR, mirrorPath };
