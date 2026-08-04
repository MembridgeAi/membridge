'use strict';
// Per-project access control (who on the team can see a given shared
// project) and the team audit trail — server-side foundation for Tasks 9-11
// (no UI here). See supabase/migrations/024_project_access_and_audit.sql for
// the tables and RLS this module talks to.
//
// Every write goes through TWO independent gates: this file checks the
// caller's role (fetched fresh from the backend, never trusted from a
// request body) before ever attempting the write, AND the RLS policies on
// project_access/team_audit enforce the same rule on the backend. Losing
// either check would leak a private project or a silent audit gap, so
// neither is treated as "the UI already hid this button" — see the plan's
// Global Constraints and 023's header for the full reasoning.
const path = require('path');
const { z } = require('zod');
const util = require('./util');
const teamsync = require('./teamsync');

class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// PostgREST plumbing. teamsync.js has an identical rest()/rpc() pair but
// keeps them private (not in its module.exports) — duplicating this ~15-line
// helper here is cheaper and lower-risk than widening teamsync's public
// surface for one caller, and it's the only piece of backend-request code in
// this file (everything else is teamsync's existing exported wrappers).
// ---------------------------------------------------------------------------
async function restCall(config, creds, method, pathname, body, headers) {
  const be = teamsync.backend(config);
  if (!be) throw new AccessError(503, 'team sync is not available in this build');
  const res = await fetch(`${be.url}/rest/v1/${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: be.anonKey,
      Authorization: `Bearer ${creds.accessToken}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && (data.message || data.hint)) || `${method} ${pathname}: ${res.status}`;
    throw new AccessError(res.status, msg);
  }
  return data;
}

async function requireCreds(config) {
  const creds = await teamsync.getAccessToken(config);
  if (!creds) throw new AccessError(401, 'not logged in');
  return creds;
}

// The caller's own role, read fresh from the backend's my_teams RPC (which is
// itself RLS-scoped to auth.uid()) — never cached locally, and never taken
// from anything a request body claims. Same pattern lib/server.js's
// archiveSharedProject already uses for the archive/unarchive gate.
async function myRole(config, teamId) {
  const teams = await teamsync.listTeams(config);
  const team = (teams || []).find(t => t.team_id === teamId);
  return team ? team.role : null;
}
const isManagerRole = role => role === 'owner' || role === 'admin';

function requireLink(projectPath) {
  const link = teamsync.loadTeamLink(projectPath);
  if (!link || !link.projectId || !link.teamId) {
    throw new AccessError(404, 'this project is not shared with a team');
  }
  return link;
}

// ---------------------------------------------------------------------------
// readAccess / writeAccess — per-project, per-member visibility.
// ---------------------------------------------------------------------------
async function readAccess(config, projectPath) {
  const link = requireLink(projectPath);
  const creds = await requireCreds(config);
  const [members, rows, projectRows] = await Promise.all([
    teamsync.listMembers(config, link.teamId),
    restCall(config, creds, 'GET',
      `project_access?team_id=eq.${encodeURIComponent(link.teamId)}` +
      `&project_key=eq.${encodeURIComponent(link.projectId)}&select=member_id,can_see`),
    // Task 17: "new members join with access" default, read from
    // public.projects.default_access (migration 025). Any team member may
    // read it (same projects_select policy every project row already uses),
    // even though only owner/admin may write it (writeAccessDefault below).
    restCall(config, creds, 'GET', `projects?id=eq.${encodeURIComponent(link.projectId)}&select=default_access`),
  ]);
  const canSeeById = new Map((rows || []).map(r => [r.member_id, !!r.can_see]));
  // can_see defaults true (the table's own default): a member with no row
  // yet has never been restricted, so absence means visible, not hidden.
  return {
    members: members.map(m => ({
      memberId: m.user_id,
      name: m.display_name,
      canSee: canSeeById.has(m.user_id) ? canSeeById.get(m.user_id) : true,
    })),
    defaultAccess: Array.isArray(projectRows) && projectRows.length ? !!projectRows[0].default_access : true,
  };
}

const writeAccessSchema = z.object({
  path: z.string().min(1),
  memberId: z.string().min(1),
  canSee: z.boolean(),
});

async function writeAccess(config, rawBody) {
  const parsed = writeAccessSchema.safeParse(rawBody);
  if (!parsed.success) throw new AccessError(400, 'path, memberId, and canSee (boolean) are required');
  const { path: projectPath, memberId, canSee } = parsed.data;
  const link = requireLink(projectPath);
  const creds = await requireCreds(config);
  const role = await myRole(config, link.teamId);
  if (!isManagerRole(role)) throw new AccessError(403, 'only a team owner or admin can change project access');
  await restCall(config, creds, 'POST', 'project_access?on_conflict=team_id,project_key,member_id', {
    team_id: link.teamId,
    project_key: link.projectId,
    member_id: memberId,
    can_see: canSee,
    updated_at: new Date().toISOString(),
    updated_by: creds.userId,
  }, { Prefer: 'resolution=merge-duplicates' });
  await writeAudit(config, creds, {
    teamId: link.teamId,
    action: canSee ? 'access-granted' : 'access-revoked',
    objectType: 'project',
    objectKey: link.projectId,
    detail: { path: projectPath, memberId, canSee },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// writeAccessDefault — "new members join with access" (Task 17). This is a
// per-PROJECT setting (one value), distinct from writeAccess above (a
// per-member row): it decides what a member who has no project_access row
// yet sees, going forward. Stored on public.projects.default_access
// (migration 025), written only through the set_project_access_default RPC
// (security definer + is_team_manager gate — the same defense-in-depth split
// as writeAccess: this Node-side role check picks the branch fast, the RPC
// is the real authorization boundary).
// ---------------------------------------------------------------------------
const writeAccessDefaultSchema = z.object({
  path: z.string().min(1),
  defaultAccess: z.boolean(),
});

async function writeAccessDefault(config, rawBody) {
  const parsed = writeAccessDefaultSchema.safeParse(rawBody);
  if (!parsed.success) throw new AccessError(400, 'path and defaultAccess (boolean) are required');
  const { path: projectPath, defaultAccess } = parsed.data;
  const link = requireLink(projectPath);
  const creds = await requireCreds(config);
  const role = await myRole(config, link.teamId);
  if (!isManagerRole(role)) throw new AccessError(403, "only a team owner or admin can change this project's default access");
  await restCall(config, creds, 'POST', 'rpc/set_project_access_default', {
    p_project: link.projectId,
    p_default: defaultAccess,
  });
  await writeAudit(config, creds, {
    teamId: link.teamId,
    action: defaultAccess ? 'access-default-granted' : 'access-default-revoked',
    objectType: 'project',
    objectKey: link.projectId,
    detail: { path: projectPath, defaultAccess },
  });
  return { ok: true, defaultAccess };
}

// ---------------------------------------------------------------------------
// accessMatrix — every local project x every team member, in one grid.
// Exactly one project_access request regardless of project count (Task 10
// depends on this: N+1 here is a spec violation), plus the one team_members
// and one my_teams RPC every other team-hub read already makes.
// ---------------------------------------------------------------------------
async function accessMatrix(config) {
  let creds;
  try {
    creds = await requireCreds(config);
  } catch {
    return { members: [], rows: [] }; // signed out / solo: an empty matrix, not an error
  }
  const teams = await teamsync.listTeams(config);
  // The product models one team per user (Settings.team is singular — see
  // ui/src/data/types.ts); a user who is on more than one team sees their
  // first for this grid, same simplification teamPayload's callers already
  // make elsewhere in the dashboard.
  const team = (teams || [])[0];
  // Manager-only, same gate readAudit already applies below: a member reading
  // this endpoint would enumerate every project (including ones can_see has
  // hidden from them) and every other member's flags. team.role comes from
  // my_teams, RLS-scoped to auth.uid() — never taken from the request.
  if (team && !isManagerRole(team.role)) {
    throw new AccessError(403, 'only a team owner or admin can view the access matrix');
  }
  const members = team ? await teamsync.listMembers(config, team.team_id) : [];
  const memberList = members.map(m => ({ id: m.user_id, name: m.display_name }));

  const state = util.loadState();
  const projectPaths = Object.keys(state.projects || {});
  const links = new Map(projectPaths.map(p => [p, teamsync.loadTeamLink(p)]));

  let accessRows = [];
  if (team) {
    accessRows = await restCall(config, creds, 'GET',
      `project_access?team_id=eq.${encodeURIComponent(team.team_id)}&select=project_key,member_id,can_see`) || [];
  }
  const canSeeByKey = new Map(accessRows.map(r => [`${r.project_key}:${r.member_id}`, !!r.can_see]));

  const rows = projectPaths.map(projectPath => {
    const link = links.get(projectPath);
    const shared = !!(team && link && link.teamId === team.team_id);
    const access = {};
    for (const m of memberList) {
      access[m.id] = shared ? (canSeeByKey.get(`${link.projectId}:${m.id}`) ?? true) : true;
    }
    return { projectPath, projectName: path.basename(projectPath), shared, access };
  });
  return { members: memberList, rows };
}

// ---------------------------------------------------------------------------
// readAudit / writeAudit — the team audit trail. Owner/admin only, both ways
// (RLS has no update/delete policy at all, so it is append-only end to end).
// ---------------------------------------------------------------------------
async function readAudit(config, limit) {
  const creds = await requireCreds(config);
  const teams = await teamsync.listTeams(config);
  const team = (teams || [])[0];
  if (!team) return { events: [] };
  if (!isManagerRole(team.role)) throw new AccessError(403, 'only a team owner or admin can view the audit trail');
  const members = await teamsync.listMembers(config, team.team_id);
  const nameById = new Map(members.map(m => [m.user_id, m.display_name]));
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = await restCall(config, creds, 'GET',
    `team_audit?team_id=eq.${encodeURIComponent(team.team_id)}&order=created_at.desc&limit=${n}` +
    '&select=id,actor_id,action,object_type,object_key,detail,created_at') || [];
  return {
    events: rows.map(r => ({
      id: r.id,
      at: r.created_at,
      actorName: nameById.get(r.actor_id) || 'Unknown',
      action: r.action,
      objectType: r.object_type,
      objectLabel: r.object_key || '',
      detail: r.detail == null ? null : JSON.stringify(r.detail),
    })),
  };
}

// ---------------------------------------------------------------------------
// readInvites: the team's outstanding invite links. Owner/admin only, the
// same gate readAudit applies above, and for the same reason: create_invite
// and revoke_invite are both is_team_manager-only in 002_team_v2.sql, so a
// plain member who cannot mint or revoke has no business enumerating live
// join secrets either. The invites_select RLS policy is deliberately wider
// (any team member may SELECT), so this Node-side check is what actually
// keeps a member from reading them, exactly as it does for the audit trail.
//
// No teamId comes from the request: the caller's first team is derived from
// my_teams, which is itself RLS-scoped to auth.uid(). Taking a team id from
// the client would let a request name a team the caller only used to belong
// to, and the manager check below would then run against the wrong row.
// ---------------------------------------------------------------------------
async function readInvites(config) {
  const creds = await requireCreds(config);
  const teams = await teamsync.listTeams(config);
  const team = (teams || [])[0];
  if (!team) return { invites: [] };
  if (!isManagerRole(team.role)) throw new AccessError(403, 'only a team owner or admin can view invite links');
  // revoked_at=is.null keeps revoked rows out: a revoked invite is not
  // outstanding, and listing one next to a Revoke button would offer an
  // action that can only ever no-op (revoke_invite's UPDATE is already
  // guarded by `revoked_at is null`).
  const rows = await restCall(config, creds, 'GET',
    `invites?team_id=eq.${encodeURIComponent(team.team_id)}&revoked_at=is.null&order=created_at.desc` +
    '&select=token,created_at,expires_at,max_uses,use_count') || [];
  // The token IS the identity here (it is the table's primary key) and it is
  // what revoke_invite(p_token) targets, so it is passed through under its
  // own name rather than being renamed to a generic id the revoke path would
  // then have to guess at.
  return {
    invites: rows.map(r => ({
      token: r.token,
      created_at: r.created_at,
      expires_at: r.expires_at ?? null,
      max_uses: r.max_uses ?? null,
      use_count: r.use_count ?? 0,
    })),
  };
}

async function writeAudit(config, creds, { teamId, action, objectType, objectKey, detail }) {
  await restCall(config, creds, 'POST', 'team_audit', {
    team_id: teamId,
    actor_id: creds.userId,
    action,
    object_type: objectType,
    object_key: objectKey || null,
    detail: detail === undefined ? null : detail,
  });
}

// isManagerRole is exported for lib/api-insights.js (Task 12), which needs
// the exact same owner/admin gate this file already applies to accessMatrix
// and readAudit — reusing the one-line check rather than writing a second one.
module.exports = { readAccess, writeAccess, writeAccessDefault, accessMatrix, readAudit, readInvites, writeAudit, AccessError, isManagerRole };
