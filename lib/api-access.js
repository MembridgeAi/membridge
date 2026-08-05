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
  const [role, members, rows, projectRows] = await Promise.all([
    // MANAGER-ONLY, and this gate is load-bearing rather than tidiness.
    //
    // project_access_select is `using (public.is_team_manager(team_id))`
    // (025_enforce_project_access.sql §6). RLS on SELECT **FILTERS ROWS, IT
    // DOES NOT RAISE** — so a non-manager's request below does not fail, it
    // succeeds with `200 []`, which is byte-identical to "this project has no
    // explicit access rows". Every member then fell through to the
    // defaultAccess branch, which is `true` for every project that has not been
    // closed, and this function cheerfully reported THE WHOLE TEAM AS ABLE TO
    // SEE A PROJECT most of them may have been explicitly revoked from.
    //
    // 028 did not close it and could not have: it improved the fallback from a
    // hardcoded `true` to the project's real default_access, but the fallback
    // was being applied to EVERY member rather than only to row-less ones,
    // because the rows were invisible rather than absent. A better fallback
    // cannot fix a caller that mistakes "not allowed to look" for "nothing
    // there".
    //
    // So the honest answer for a non-manager is "you cannot know", not a
    // narrower guess — a filled-in access list is a value asserting something
    // the code never established. Refusing also closes the exposure: this
    // endpoint had no gate at all, so it was the one-project-at-a-time back door
    // to exactly the data 025 §6 narrowed the policy to protect and that
    // accessMatrix already refuses ("a member reading this endpoint would
    // enumerate every project ... and every other member's flags").
    //
    // Same gate, same source of truth: role comes from my_teams, RLS-scoped to
    // auth.uid(), never from the request. In the Promise.all rather than ahead
    // of it so the refusal costs no extra round-trip; the other reads are
    // RLS-scoped anyway and their results are simply discarded when it throws.
    //
    // Note this only ALIGNS the Node gate with the policy already in force. The
    // UI never calls it as a non-manager either (ProjectPage's showAccessPanel
    // requires isTeamAdmin), but that is a client-side gate and therefore not a
    // control — anything that can reach the loopback port bypassed it.
    myRole(config, link.teamId),
    teamsync.listMembers(config, link.teamId),
    restCall(config, creds, 'GET',
      `project_access?team_id=eq.${encodeURIComponent(link.teamId)}` +
      `&project_key=eq.${encodeURIComponent(link.projectId)}&select=member_id,can_see`),
    // Task 17: "new members join with access" default, read from
    // public.projects.default_access (migration 026). Any team member may
    // read it (same projects_select policy every project row already uses),
    // even though only owner/admin may write it (writeAccessDefault below).
    restCall(config, creds, 'GET', `projects?id=eq.${encodeURIComponent(link.projectId)}&select=default_access`),
  ]);
  if (!isManagerRole(role)) {
    throw new AccessError(403, 'only a team owner or admin can view project access');
  }
  const canSeeById = new Map((rows || []).map(r => [r.member_id, !!r.can_see]));
  const defaultAccess = Array.isArray(projectRows) && projectRows.length ? !!projectRows[0].default_access : true;
  // A member with no project_access row falls back to the PROJECT's default,
  // not to a hardcoded true. This line used to read `? ... : true` with a
  // comment claiming "can_see defaults true (the table's own default)" — the
  // table default only governs a row that EXISTS, and reading absence as
  // "visible" is what made the "new members join with access" toggle a
  // decoration: it stored the owner's choice and nothing displayed or
  // enforced it. Enforcement is can_see_project's job
  // (028_enforce_project_access_default.sql); this must agree with it, or the
  // panel tells an admin the opposite of what the backend will do.
  return {
    members: members.map(m => ({
      memberId: m.user_id,
      name: m.display_name,
      canSee: canSeeById.has(m.user_id) ? canSeeById.get(m.user_id) : defaultAccess,
    })),
    defaultAccess,
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
// (migration 026), enforced by can_see_project (migration 028), written only
// through the set_project_access_default RPC
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
async function accessMatrix(config, teamId) {
  let creds;
  try {
    creds = await requireCreds(config);
  } catch {
    return { members: [], rows: [] }; // signed out / solo: an empty matrix, not an error
  }
  const teams = await teamsync.listTeams(config);
  // The team the caller is looking at (selectTeam above), not an unconditional
  // teams[0] — this grid has to describe the same team the rest of the screen
  // is describing.
  const team = selectTeam(teams, teamId);
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

  // The shared project ids this grid is about, resolved before the fetches so
  // the default_access lookup below can be a single `in.(...)` request instead
  // of one request per project — Task 10's no-N+1 rule covers this read too.
  const sharedProjectIds = [...new Set(projectPaths
    .map(p => links.get(p))
    .filter(link => team && link && link.teamId === team.team_id && link.projectId)
    .map(link => link.projectId))];

  let accessRows = [];
  // Per-project "new members join with access" defaults. This grid DISPLAYS
  // can_see, and a display that disagrees with enforcement is worse than no
  // display: the matrix is what an admin audits "who sees what" with, and it
  // used to answer `?? true` for every member with no explicit row, so a
  // project with default_access = false rendered as visible-to-everyone.
  // Mirrors readAccess above and can_see_project itself
  // (028_enforce_project_access_default.sql).
  let projectRows = [];
  if (team) {
    [accessRows, projectRows] = await Promise.all([
      restCall(config, creds, 'GET',
        `project_access?team_id=eq.${encodeURIComponent(team.team_id)}&select=project_key,member_id,can_see`),
      sharedProjectIds.length
        ? restCall(config, creds, 'GET',
          `projects?id=in.(${sharedProjectIds.map(encodeURIComponent).join(',')})&select=id,default_access`)
        // No shared projects means no ids to filter on, and PostgREST rejects
        // an empty `in.()` — skip the request rather than send a broken one.
        : Promise.resolve([]),
    ]);
    accessRows = accessRows || [];
    projectRows = projectRows || [];
  }
  const canSeeByKey = new Map(accessRows.map(r => [`${r.project_key}:${r.member_id}`, !!r.can_see]));
  const defaultByProjectId = new Map(projectRows.map(r => [r.id, r.default_access !== false]));

  const rows = projectPaths.map(projectPath => {
    const link = links.get(projectPath);
    const shared = !!(team && link && link.teamId === team.team_id);
    // A project that is NOT shared with this team has no access rules to
    // report at all (it is local-only), so it stays true — unchanged, and
    // unrelated to the default this migration enforces.
    const projectDefault = shared && defaultByProjectId.has(link.projectId)
      ? defaultByProjectId.get(link.projectId)
      : true;
    const access = {};
    for (const m of memberList) {
      access[m.id] = shared ? (canSeeByKey.get(`${link.projectId}:${m.id}`) ?? projectDefault) : true;
    }
    return { projectPath, projectName: path.basename(projectPath), shared, access };
  });
  return { members: memberList, rows };
}

// ---------------------------------------------------------------------------
// selectTeam — which of the caller's teams a team-scoped read is about.
//
// Every team read in this daemon used to take teams[0] unconditionally, so a
// user on two teams silently got one of them, with the audit trail, the
// invite list and the access matrix all quietly pointing at it. Callers now
// pass the team the UI is actually showing.
//
// Fail-closed by construction: `teams` is what listTeams returned, which is
// RLS-scoped to the caller, so a teamId they are not a member of simply does
// not match and this returns null — the caller then answers empty or 403,
// never another team's rows. An absent/unknown id falls back to the first
// team, which keeps every existing caller and older client working.
// ---------------------------------------------------------------------------
function selectTeam(teams, teamId) {
  const list = teams || [];
  if (teamId) {
    const picked = list.find(t => t && t.team_id === teamId);
    if (picked) return picked;
  }
  return list[0] || null;
}

// ---------------------------------------------------------------------------
// readAudit / writeAudit — the team audit trail. Owner/admin only, both ways
// (RLS has no update/delete policy at all, so it is append-only end to end).
// ---------------------------------------------------------------------------
async function readAudit(config, limit, teamId) {
  const creds = await requireCreds(config);
  const teams = await teamsync.listTeams(config);
  const team = selectTeam(teams, teamId);
  if (!team) return { events: [] };
  if (!isManagerRole(team.role)) throw new AccessError(403, 'only a team owner or admin can view the audit trail');
  const members = await teamsync.listMembers(config, team.team_id);
  const nameById = new Map(members.map(m => [m.user_id, m.display_name]));
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = await restCall(config, creds, 'GET',
    `team_audit?team_id=eq.${encodeURIComponent(team.team_id)}&order=created_at.desc&limit=${n}` +
    '&select=id,actor_id,action,object_type,object_key,detail,created_at') || [];
  return {
    events: rows.map(r => {
      const detail = r.detail && typeof r.detail === 'object' ? r.detail : null;
      return {
        id: r.id,
        at: r.created_at,
        actorName: nameById.get(r.actor_id) || 'Unknown',
        action: r.action,
        objectType: r.object_type,
        objectLabel: r.object_key || '',
        // The two fields that make a row READABLE, resolved here because this
        // is the only place both maps exist. object_key is a backend project
        // UUID and detail.memberId a user id — rendering either verbatim
        // answers neither "which project" nor "which person", which is the
        // whole job of the row. Null (never a fabricated label) when the
        // event carries no such detail: absent and unknown must stay
        // distinguishable downstream.
        objectName: (detail && typeof detail.path === 'string' ? detail.path : null),
        targetName: (detail && typeof detail.memberId === 'string'
          ? nameById.get(detail.memberId) || detail.memberId
          : (detail && typeof detail.targetName === 'string' ? detail.targetName : null)),
        detail: r.detail == null ? null : JSON.stringify(r.detail),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// readInvites — the outstanding invite links for this machine's team.
//
// There was no listing path at all before this: invites could be minted and
// revoked, but never SEEN, so an admin who handed out three links over a week
// had no record of any of them and no way to kill one that leaked (revoking
// needs the token, which the UI showed once at copy time and never again).
//
// Manager-only, matching readAudit. RLS on public.invites permits any team
// member to select (002_team_v2.sql), so this gate is a product decision
// rather than the security boundary: invite tokens ARE the credential, and
// handing every member a list of live ones widens who can add people.
// ---------------------------------------------------------------------------
async function readInvites(config, teamId) {
  const creds = await requireCreds(config);
  const teams = await teamsync.listTeams(config);
  const team = selectTeam(teams, teamId);
  if (!team) return { invites: [] };
  if (!isManagerRole(team.role)) throw new AccessError(403, 'only a team owner or admin can list invites');
  const rows = await restCall(config, creds, 'GET',
    `invites?team_id=eq.${encodeURIComponent(team.team_id)}&order=created_at.desc&limit=100` +
    '&select=token,created_at,expires_at,max_uses,use_count,revoked_at') || [];
  return {
    invites: rows.map(r => ({
      // The token IS the id: it is the primary key, and it is also exactly
      // what revoke_invite takes, so the revoke button needs nothing else.
      id: r.token,
      createdAt: r.created_at,
      expiresAt: r.expires_at || null,
      maxUses: Number.isFinite(Number(r.max_uses)) && r.max_uses !== null ? Number(r.max_uses) : null,
      useCount: Number(r.use_count) || 0,
      revoked: !!r.revoked_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// inviteTeamId — which team an invite token belongs to.
//
// POST /api/team/revoke-invite takes a token and nothing else, because the
// token identifies the invite on its own and revoke_invite gates on THAT
// invite's team. The audit row that follows had no such source of truth and
// used firstTeamId() (lib/server.js) — plain teams[0] — so revoking a second
// team's invite filed the event against the first team. Two live failure
// modes, both silent: the wrong team's trail gains an event about a token
// that was never its own, and the right team's trail stays empty; or, if the
// caller is only a MEMBER of teams[0], the insert fails team_audit's
// manager-only RLS check and recordAudit swallows it, so the revocation is
// recorded nowhere at all. Either way an admin auditing the team after a leak
// sees no record of anybody killing the invite.
//
// One GET against public.invites, whose select policy is
// `is_team_member(team_id)` (002:68) — the caller just revoked this invite, so
// they are a manager of its team and therefore a member of it, and the row is
// visible. Returns null on anything unexpected rather than throwing: this is
// used to LABEL a record of something that already happened, and the same rule
// recordAudit follows applies here — a lookup failure must degrade the row,
// never undo the revocation the user asked for. A null answer means the event
// is skipped, which is strictly better than filing it against a team it has
// nothing to do with.
// ---------------------------------------------------------------------------
async function inviteTeamId(config, token) {
  try {
    const creds = await requireCreds(config);
    // Same normalization teamsync.revokeInvite applies before calling the RPC:
    // this route accepts a whole invite URL as well as a bare token, and the
    // lookup has to name the same row the revoke just acted on.
    const bare = teamsync.parseInviteToken(token);
    const rows = await restCall(config, creds, 'GET',
      `invites?token=eq.${encodeURIComponent(bare)}&select=team_id&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row && row.team_id ? String(row.team_id) : null;
  } catch {
    return null;
  }
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

// The audit trail's entry point for callers OUTSIDE this file — the team
// mutation routes in lib/server.js (remove-member, set-role, rename, join,
// invite, revoke-invite). Two differences from writeAudit above, both
// deliberate:
//
//   1. It resolves its own credentials, so a route handler does not have to
//      plumb them through just to log.
//   2. IT NEVER THROWS. The audit row is a record OF an action that already
//      succeeded; a failed log must not turn a completed removal into a 500
//      the user reads as "it didn't work" and retries. The failure is
//      swallowed here and nowhere else — every other write in this file
//      reports its errors.
//
// Callers must therefore only call this AFTER the mutation itself resolved,
// never before or in parallel, or the trail records things that did not
// happen.
async function recordAudit(config, entry) {
  try {
    const creds = await requireCreds(config);
    await writeAudit(config, creds, entry);
  } catch {
    // Intentionally silent: see above.
  }
}

// isManagerRole is exported for lib/api-insights.js (Task 12), which needs
// the exact same owner/admin gate this file already applies to accessMatrix
// and readAudit — reusing the one-line check rather than writing a second one.
module.exports = { readAccess, writeAccess, writeAccessDefault, accessMatrix, readAudit, readInvites, inviteTeamId, writeAudit, recordAudit, selectTeam, AccessError, isManagerRole };
