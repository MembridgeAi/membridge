'use strict';
// Minimal in-memory Supabase stand-in for the offline test suite: just enough
// GoTrue (signup / password grant / refresh) and PostgREST (the RPCs and the
// memory_entries table, with membership checks standing in for RLS) for
// lib/teamsync.js to run end-to-end without a network.
const http = require('http');
const crypto = require('crypto');

// Render an instant the way PostgREST actually returns a `timestamptz`.
//
// THIS IS NOT COSMETIC. A mock that stores and returns pushed rows verbatim
// out of a JS array cannot observe an entire class of defect: everything the
// client compares as a STRING against a value it pushed appears to work,
// because the mock hands back the exact bytes it was given and Postgres does
// not. Verified against Postgres 17 (Supabase runs 17.6.1), which is what
// PostgREST builds its JSON through:
//
//   input:   '2026-08-05T12:00:00.550Z'::timestamptz
//   to_json: "2026-08-05T12:00:00.55+00:00"
//
// Two transformations: Z becomes +00:00, and trailing zeros in the fractional
// seconds are trimmed (an all-zero fraction disappears entirely). That is how
// lib/feed.js's self-twin dedupe came to compare two spellings of one instant
// and conclude they were two different rows, with the whole suite green.
//
// Applied on the READ path only, exactly like the real thing: what is stored
// is what the client sent, and the difference appears when it is rendered.
function pgTimestamptz(value) {
  if (value == null || value === '') return value;
  const t = new Date(value);
  if (!Number.isFinite(t.getTime())) return value; // not a timestamp; leave it alone
  const iso = t.toISOString();                      // ...THH:MM:SS.mmmZ
  const fraction = iso.slice(19, 23).replace(/0+$/, '').replace(/^\.$/, '');
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

// Apply pgTimestamptz to a row's timestamp-typed columns. Named explicitly
// rather than sniffed by regex: a column is timestamptz because the schema
// says so, and guessing from the value would silently start reformatting a
// text column that happens to hold a date.
const TIMESTAMPTZ_COLUMNS = ['ts', 'created_at', 'first_ts', 'last_ts', 'updated_at', 'joined_at', 'expires_at', 'revoked_at', 'archived_at'];
function renderRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const col of TIMESTAMPTZ_COLUMNS) {
    if (out[col] != null) out[col] = pgTimestamptz(out[col]);
  }
  return out;
}

// Compare two timestamps the way Postgres compares two timestamptz values:
// as INSTANTS. This matters now that reads are rendered (see pgTimestamptz),
// because every cursor the client sends back is a value it read, so a bound
// spelled '...55+00:00' is compared against a stored '...550Z'. Postgres casts
// both sides and compares points in time; a mock doing localeCompare would
// invent a cursor bug that does not exist in production ('+' sorts below '0').
// Unparseable values fall back to a string compare so junk still orders
// deterministically rather than collapsing to equal.
function tsCmp(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb ? 0 : (ta < tb ? -1 : 1);
  return String(a).localeCompare(String(b));
}

function createMockSupabase() {
  const users = new Map();          // email -> { id, email, password }
  const sessions = new Map();       // accessToken -> userId
  const refreshTokens = new Map();  // refreshToken -> userId
  // PKCE auth codes: authCode -> { userId, challenge }. GoTrue hands one of
  // these to the redirect target when the authorize request carried a
  // code_challenge, and only trades it for a session against the matching
  // verifier. Seeded by tests, since the GitHub round trip has no stand-in.
  const authCodes = new Map();
  const teams = new Map();          // teamId -> { id, name, inviteCode }
  const members = [];               // { teamId, userId, displayName, role }
  const projects = [];              // { id, teamId, name, repoUrl }
  const entries = [];               // memory_entries rows
  const invites = new Map();        // token -> { token, teamId, expiresAt, maxUses, useCount, revokedAt }
  const pubkeys = new Map();        // member_pubkeys: userId -> public_key (009)
  const teamKeys = [];              // team_keys rows: { team_id, epoch, member_user_id, sealed_team_key } (009)
  const projectAccess = [];         // project_access rows (023): { team_id, project_key, member_id, can_see, updated_at, updated_by }
  const teamAudit = [];             // team_audit rows (023): { id, team_id, actor_id, action, object_type, object_key, detail, created_at }
  // logoutCalls counts POST /auth/v1/logout — the GoTrue call that actually
  // ends a session server-side by revoking its refresh token. It is a counter
  // rather than a boolean because "signed out" must be provable per sign-out,
  // not once per process: a daemon that deletes its local credentials file and
  // never tells the backend leaves a refresh token that keeps minting valid
  // access tokens for anyone holding a copy of that file.
  const stats = { refreshCalls: 0, inserts: 0, deniedInserts: 0, logoutCalls: 0 };
  // Test knobs for backend quirks. rejectSummary is kept for back-compat;
  // rejectColumns is the general form — any column name added here provokes the
  // PostgREST "schema cache" error until the POST body no longer carries it, so
  // the client's drop-and-retry loop can be exercised across multiple columns.
  const flags = {
    rejectSummary: false, rejectColumns: new Set(), failEntryInserts: false,
    // Stands in for "032 not applied": suppresses the AFTER INSERT trigger on
    // public.projects so a direct POST lands a row-less project, which is the
    // pre-032 backend.
    noProjectInsertTrigger: false,
    // Stands in for "033 not applied": drops can_see_project from the
    // memory_entries write check, restoring the pre-033 backend where a revoked
    // member could still push into a project they cannot read.
    noWriteAccessCheck: false,
    // Stands in for "046 not applied": suppresses the AFTER INSERT trigger on
    // public.team_members, restoring the backend where a join cannot be
    // audited at all — the joiner is role 'member', team_audit's insert policy
    // is manager-only, and recordAudit swallows the refusal.
    noMemberJoinTrigger: false,
    // Stands in for "049 not applied": suppresses the AFTER DELETE trigger on
    // public.team_members, restoring the backend where a voluntary departure
    // is recorded nowhere -- the leaver is not a manager, and by the time the
    // row would be written they are not a member either.
    noMemberLeaveTrigger: false,
    // Removes 049's teams-existence guard while LEAVING the trigger in place,
    // so a test can demonstrate that the guard is what stops a team deletion
    // from aborting on team_audit's own foreign key.
    noLeaveCascadeGuard: false,
    // Stands in for "050 not applied": team_audit.actor_id keeps its original
    // no-on-delete-action foreign key, so any audit row naming a user as actor
    // blocks deleting that account. Since 046 that is every member.
    noAuditActorSetNull: false,
    // Stands in for the WRONG version of 050: `on delete cascade` instead of
    // `on delete set null`, which deletes every audit row the departing user
    // was the actor for -- including rows about what they did to OTHER people.
    auditActorCascade: false,
    // Faults the base-projects list read that lib/teamsync.js teamHasLiveProject
    // uses to corroborate an EMPTY project_stats. Exists so a suite can prove
    // that a corroboration which cannot answer refuses to authorize destroying
    // local data, rather than falling through to "revoked".
    failProjectsList: false,
  };

  const uuid = () => crypto.randomUUID();
  const shortToken = () => crypto.randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10);
  const isMember = (teamId, userId) => members.some(m => m.teamId === teamId && m.userId === userId);
  const memberRole = (teamId, userId) => (members.find(m => m.teamId === teamId && m.userId === userId) || {}).role || null;
  const isManager = (teamId, userId) => ['owner', 'admin'].includes(memberRole(teamId, userId));
  const projectTeam = projectId => (projects.find(p => p.id === projectId) || {}).teamId;
  // 028_enforce_project_access_default.sql (can_see_project): three tiers, in
  // order — an explicit project_access row for THIS member wins, otherwise the
  // project's own default_access decides, otherwise (no project row at all)
  // allow. 025 shipped only the first and third tiers, hardcoding default-allow
  // in between, which is what left the "new members join with access" toggle
  // stored-but-unenforced. Mirrors the predicate exactly, not a permissive
  // stand-in: a mock that keeps 025's rule passes over the bug, since these
  // four call sites (memory_entries, project_stats, team_feed,
  // team_feed_counts) are the only places the suite can observe enforcement.
  const canSeeProject = (projectId, userId) => {
    const row = projectAccess.find(r =>
      r.team_id === projectTeam(projectId) && r.project_key === projectId && r.member_id === userId);
    if (row) return row.can_see !== false;
    const p = projects.find(x => x.id === projectId);
    if (!p) return true;
    return p.defaultAccess !== false;
  };

  // 029_materialize_project_access.sql. `on conflict do nothing` on the
  // (team_id, project_key, member_id) primary key: an existing row is NEVER
  // rewritten, so a deliberate can_see = false survives every path below and
  // every re-run. can_see is read from the project's default AT THIS MOMENT,
  // which is what makes the flag govern arrivals rather than history.
  const grantAccessRow = (project, memberId) => {
    const exists = projectAccess.some(r =>
      r.team_id === project.teamId && r.project_key === project.id && r.member_id === memberId);
    if (exists) return false;
    projectAccess.push({
      team_id: project.teamId,
      project_key: project.id,
      member_id: memberId,
      can_see: project.defaultAccess !== false,
      updated_at: new Date().toISOString(),
      // NULL in the migration too: no human made this choice.
      updated_by: null,
    });
    return true;
  };
  // 029 §2: one member x every project the team already shares (join paths).
  const materializeForMember = (teamId, memberId) => {
    for (const p of projects.filter(x => x.teamId === teamId)) grantAccessRow(p, memberId);
  };
  // 029 §3: one project x every current member (link_project).
  const materializeForProject = project => {
    for (const m of members.filter(x => x.teamId === project.teamId)) grantAccessRow(project, m.userId);
  };
  // 032_materialize_project_access_on_insert.sql: the AFTER INSERT trigger on
  // public.projects. Same materialization as 029 §3, but reached from the INSERT
  // itself rather than from the RPC, so it also covers the direct
  // POST /rest/v1/projects that `projects_insert` permits and no client uses.
  //
  // A SEPARATE FUNCTION, not a call to materializeForProject inlined at the
  // route, so the trigger can be disabled on its own to prove the checks that
  // depend on it actually fail without it. flags.noProjectInsertTrigger stands
  // in for "032 not applied".
  const projectsInsertTrigger = project => {
    if (flags.noProjectInsertTrigger) return;
    materializeForProject(project);
  };
  // team_audit.team_id is `references public.teams (id) on delete cascade`
  // (024:43). The mock has no FK engine, so the constraint is enforced here,
  // and it THROWS rather than skipping — because that is what Postgres does,
  // and the consequence is the whole point: an insert naming a team that is
  // being deleted aborts the statement that triggered it. A trigger on
  // team_members that writes during a `delete from teams` cascade therefore
  // does not make team deletion chatty, it makes team deletion FAIL.
  const insertAuditRow = row => {
    if (!teams.has(row.team_id)) {
      throw new Error(
        'insert or update on table "team_audit" violates foreign key constraint ' +
        `"team_audit_team_id_fkey" (team ${row.team_id} does not exist)`);
    }
    teamAudit.push(row);
  };
  // 046_audit_member_joined.sql: the AFTER INSERT trigger on
  // public.team_members. Modelled as a function called from every membership
  // insert -- the same shape projectsInsertTrigger uses for 032 -- rather than
  // inlined at the three RPCs, so it can be disabled on its own to prove the
  // checks that depend on it actually fail without it.
  //
  // Two properties are the whole point and both are load-bearing here:
  //   * it fires from the INSERT, so a repeat join (`on conflict do nothing`,
  //     modelled below as the isMember guard) writes nothing;
  //   * `when (new.role <> 'owner')` excludes create_team's founder row -- a
  //     team's creator is not joining it.
  // The row itself is composed entirely from the inserted values: no argument
  // reaches it, which is why the real one is a trigger and not an RPC.
  // flags.noMemberJoinTrigger stands in for "046 not applied".
  const memberInsertTrigger = row => {
    if (flags.noMemberJoinTrigger) return;
    if (row.role === 'owner') return;
    insertAuditRow({
      id: uuid(),
      team_id: row.teamId,
      actor_id: row.userId,
      action: 'member-joined',
      object_type: 'member',
      object_key: row.userId,
      detail: { memberId: row.userId, targetName: row.displayName },
      // Offset by the current row count, the same convention the POST route
      // below uses, so two events written inside one millisecond still sort
      // deterministically against each other.
      created_at: new Date(Date.now() + teamAudit.length).toISOString(),
    });
  };
  // 049_audit_member_left.sql: the AFTER DELETE trigger on team_members.
  //
  // `deleter` is the mock's stand-in for auth.uid() — the authed caller of
  // whatever statement removed the row. The WHEN clause is the whole
  // removal-vs-departure decision and is modelled exactly: fires only when the
  // person who ended the membership IS the person whose membership ended, so
  // remove_member (a manager deleting somebody else's row) writes nothing here
  // and the daemon's member-removed stays the only row for a removal.
  //
  // The teams-existence check is the cascade guard, and it is a correctness
  // guard rather than a tidiness one: team_audit.team_id references teams on
  // delete cascade, so a row inserted for a team being deleted violates that
  // FK and aborts the delete. deleteTeamCascade below exercises exactly that.
  // flags.noMemberLeaveTrigger stands in for "049 not applied".
  const memberDeleteTrigger = (row, deleter) => {
    if (flags.noMemberLeaveTrigger) return;
    if (!deleter || deleter !== row.userId) return;          // 049's WHEN clause
    // 049's BODY guard, separate from the FK below on purpose: the guard is
    // the migration's, the FK is the database's, and flags.noLeaveCascadeGuard
    // removes only the former so a test can show what the latter then does.
    if (!flags.noLeaveCascadeGuard && !teams.has(row.teamId)) return;
    insertAuditRow({
      id: uuid(),
      team_id: row.teamId,
      actor_id: row.userId,
      action: 'member-left',
      object_type: 'member',
      object_key: row.userId,
      // old.display_name — the only place the name still exists once the row
      // is gone. Captured here or lost for good.
      detail: { memberId: row.userId, targetName: row.displayName },
      created_at: new Date(Date.now() + teamAudit.length).toISOString(),
    });
  };
  // 029 §5: project_access carries `foreign key (team_id, member_id)
  // references team_members (team_id, user_id) on delete cascade` (024:38-39),
  // so deleting a membership deletes its access rows in the real backend with
  // no RPC change. The mock has to model the cascade or remove_member/
  // leave_team would look like they leave grants behind.
  const cascadeAccessRows = (teamId, memberId) => {
    for (let i = projectAccess.length - 1; i >= 0; i--) {
      const r = projectAccess[i];
      if (r.team_id === teamId && r.member_id === memberId) projectAccess.splice(i, 1);
    }
  };

  function newSession(user) {
    const access = `at-${uuid()}`;
    const refresh = `rt-${uuid()}`;
    sessions.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      user: { id: user.id, email: user.email, user_metadata: user.metadata || {} },
    };
  }

  function authedUser(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    return m ? sessions.get(m[1]) || null : null;
  }

  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  function handleRpc(res, fn, body, userId) {
    if (!userId) return json(res, 401, { message: 'not authenticated' });
    if (fn === 'create_team') {
      // createdBy: teams.created_by is NOT NULL and references auth.users with
      // no on-delete action (schema.sql:13), so it blocks deleting the creator's
      // account. Recorded here or deleteUserCascade's blocker list is vacuous.
      const team = { id: uuid(), name: body.p_name, inviteCode: uuid(), createdBy: userId, createdAt: new Date().toISOString() };
      teams.set(team.id, team);
      const ownerRow = { teamId: team.id, userId, displayName: body.p_display_name, role: 'owner', joinedAt: new Date().toISOString() };
      members.push(ownerRow);
      memberInsertTrigger(ownerRow); // 046: no-op for an owner row, called anyway so the gate is what excludes it
      return json(res, 200, [{ team_id: team.id, invite_code: team.inviteCode }]);
    }
    if (fn === 'join_team') {
      const team = [...teams.values()].find(t => t.inviteCode === body.p_code);
      if (!team) return json(res, 400, { message: 'invalid invite code' });
      if (!isMember(team.id, userId)) {
        const joinRow = { teamId: team.id, userId, displayName: body.p_display_name, role: 'member', joinedAt: new Date().toISOString() };
        members.push(joinRow);
        memberInsertTrigger(joinRow); // 046
      }
      // 029 §2: record this member's access to every project the team already
      // shares. Runs on a repeat join too, where it is a no-op.
      materializeForMember(team.id, userId);
      return json(res, 200, [{ team_id: team.id, team_name: team.name }]);
    }
    if (fn === 'link_project') {
      if (!isMember(body.p_team, userId)) return json(res, 403, { message: 'not a member of this team' });
      let row = body.p_repo_url
        ? projects.find(p => p.teamId === body.p_team && p.repoUrl === body.p_repo_url)
        : null;
      if (!row) row = projects.find(p => p.teamId === body.p_team && p.name === body.p_name);
      if (!row) {
        // createdBy: projects.created_by, same shape as teams.created_by
        // (schema.sql:31) and the same blocking effect.
        row = { id: uuid(), teamId: body.p_team, name: body.p_name, repoUrl: body.p_repo_url || null, createdBy: userId };
        projects.push(row);
      }
      // 029 §3: unconditional, on the adopt-existing branch as well as the
      // create branch — a project created before 029 and re-linked after it
      // must pick up rows for the current membership too.
      materializeForProject(row);
      return json(res, 200, row.id);
    }
    if (fn === 'my_teams') {
      const rows = members.filter(m => m.userId === userId).map(m => {
        const t = teams.get(m.teamId);
        return {
          team_id: m.teamId,
          team_name: t.name,
          role: m.role,
          // 044 §2: the standing invite code goes to MANAGERS only. A plain
          // member's row keeps the column and carries null in it — the
          // RETURNS TABLE signature is fixed, so this is a null value rather
          // than an absent key, and clients that read it positionally are
          // unaffected. Modelled here because it is the difference between
          // "an ordinary member can read a permanent join credential" and
          // "they cannot", which no client-side check can prove on its own.
          invite_code: ['owner', 'admin'].includes(m.role) ? t.inviteCode : null,
          member_count: members.filter(x => x.teamId === m.teamId).length,
          created_at: t.createdAt || null,
        };
      });
      return json(res, 200, rows);
    }
    // ---- schema v2 (002_team_v2.sql) ----
    if (fn === 'create_invite') {
      if (!isManager(body.p_team, userId)) return json(res, 403, { message: 'only a team owner or admin can create invite links' });
      const inv = {
        token: shortToken(), teamId: body.p_team,
        // invites.created_by, NOT NULL, no on-delete (002:58).
        createdBy: userId,
        expiresAt: body.p_expires_at || null, maxUses: body.p_max_uses || null,
        useCount: 0, revokedAt: null,
        // Offset by the current row count so two invites minted inside the
        // same millisecond still sort deterministically newest-first, which
        // the GET /rest/v1/invites ordering below is asserted on.
        createdAt: new Date(Date.now() + invites.size).toISOString(),
      };
      invites.set(inv.token, inv);
      return json(res, 200, [{ token: inv.token, expires_at: inv.expiresAt, max_uses: inv.maxUses }]);
    }
    if (fn === 'revoke_invite') {
      const inv = invites.get(body.p_token);
      if (!inv) return json(res, 400, { message: 'unknown invite' });
      if (!isManager(inv.teamId, userId)) return json(res, 403, { message: 'only a team owner or admin can revoke invite links' });
      inv.revokedAt = new Date().toISOString();
      return json(res, 200, null);
    }
    if (fn === 'redeem_invite') {
      const inv = invites.get(body.p_token);
      if (!inv) return json(res, 400, { message: 'invalid invite link' });
      if (inv.revokedAt) return json(res, 400, { message: 'this invite link has been revoked' });
      if (inv.expiresAt && inv.expiresAt <= new Date().toISOString()) return json(res, 400, { message: 'this invite link has expired' });
      if (inv.maxUses !== null && inv.useCount >= inv.maxUses) return json(res, 400, { message: 'this invite link has already been used' });
      const team = teams.get(inv.teamId);
      if (!isMember(team.id, userId)) {
        const joinRow = { teamId: team.id, userId, displayName: body.p_display_name, role: 'member', joinedAt: new Date().toISOString() };
        members.push(joinRow);
        memberInsertTrigger(joinRow); // 046
        inv.useCount++;
      }
      // 029 §2. In the real function this insert comes AFTER the membership
      // result is captured into v_joined, because FOUND would otherwise be
      // clobbered before the use_count update reads it; here useCount is
      // already incremented above, so ordering carries no such trap.
      materializeForMember(team.id, userId);
      return json(res, 200, [{ team_id: team.id, team_name: team.name }]);
    }
    if (fn === 'remove_member') {
      if (!isManager(body.p_team, userId)) return json(res, 403, { message: 'only a team owner or admin can remove members' });
      if (memberRole(body.p_team, body.p_user) === 'owner') return json(res, 400, { message: 'the team owner cannot be removed' });
      const i = members.findIndex(m => m.teamId === body.p_team && m.userId === body.p_user);
      const removedRow = i !== -1 ? members[i] : null;
      if (i !== -1) members.splice(i, 1);
      if (removedRow) memberDeleteTrigger(removedRow, userId); // 049: no-op, actor is not the subject
      cascadeAccessRows(body.p_team, body.p_user); // 024's FK cascade (see 029 §5)
      // 044 §1: removal rotates the team's standing invite code AND revokes
      // every outstanding invite link, unconditionally. Both halves matter: a
      // departing member may hold either credential, and create_invite
      // defaults to no expiry and no use cap, so the link they joined with
      // redeems again after they are removed. Same two statements
      // rotate_invite runs, and with the same blast radius — everyone else's
      // copy of the code and every live link die too.
      const removedFrom = teams.get(body.p_team);
      if (removedFrom) removedFrom.inviteCode = uuid();
      for (const inv of invites.values()) {
        if (inv.teamId === body.p_team && !inv.revokedAt) inv.revokedAt = new Date().toISOString();
      }
      return json(res, 200, null);
    }
    if (fn === 'set_role') {
      if (memberRole(body.p_team, userId) !== 'owner') return json(res, 403, { message: 'only the team owner can change roles' });
      if (!['admin', 'member'].includes(body.p_role)) return json(res, 400, { message: 'role must be admin or member' });
      const m = members.find(x => x.teamId === body.p_team && x.userId === body.p_user);
      if (m) m.role = body.p_role;
      return json(res, 200, null);
    }
    if (fn === 'rename_team') {
      if (!isManager(body.p_team, userId)) return json(res, 403, { message: 'only a team owner or admin can rename the team' });
      teams.get(body.p_team).name = body.p_name;
      return json(res, 200, null);
    }
    if (fn === 'rotate_invite') {
      if (!isManager(body.p_team, userId)) return json(res, 403, { message: 'only a team owner or admin can rotate the invite code' });
      const t = teams.get(body.p_team);
      t.inviteCode = uuid();
      for (const inv of invites.values()) if (inv.teamId === body.p_team && !inv.revokedAt) inv.revokedAt = new Date().toISOString();
      return json(res, 200, t.inviteCode);
    }
    if (fn === 'leave_team') {
      if (memberRole(body.p_team, userId) === 'owner') return json(res, 400, { message: 'the owner cannot leave their own team' });
      const i = members.findIndex(m => m.teamId === body.p_team && m.userId === userId);
      const leftRow = i !== -1 ? members[i] : null;
      if (i !== -1) members.splice(i, 1);
      if (leftRow) memberDeleteTrigger(leftRow, userId); // 049
      cascadeAccessRows(body.p_team, userId); // 024's FK cascade (see 029 §5)
      // 045: a voluntary departure rotates the standing invite code and
      // revokes outstanding invite links, exactly as a removal does. Same two
      // statements as 044 §1 -- see 045's header for why the same remedy fits
      // a departure nobody else chose: leaving is one-shot per membership, and
      // after 044 §2 an admin who resigns is the role most certain to be
      // holding the code.
      const leftFrom = teams.get(body.p_team);
      if (leftFrom) leftFrom.inviteCode = uuid();
      for (const inv of invites.values()) {
        if (inv.teamId === body.p_team && !inv.revokedAt) inv.revokedAt = new Date().toISOString();
      }
      return json(res, 200, null);
    }
    if (fn === 'team_members_list') {
      if (!isMember(body.p_team, userId)) return json(res, 200, []);
      const rows = members
        .filter(m => m.teamId === body.p_team)
        .sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))
        // 053: the column that lets a client tell a soft-deleted account from a
        // live one. Modelled here because the offline suite never sees the real
        // backend, so without it a test cannot exercise the filter at all.
        // Fixtures that do not set it get null, i.e. live -- matching a
        // pre-053 backend, which is the state production is in right now.
        .map(m => ({ user_id: m.userId, display_name: m.displayName, role: m.role,
                     joined_at: m.joinedAt || null, deleted_at: m.deletedAt || null }));
      return json(res, 200, rows);
    }
    if (fn === 'team_feed') {
      if (!isMember(body.p_team, userId)) return json(res, 200, []);
      let rows = entries
        .map(e => ({ ...e, project_name: (projects.find(p => p.id === e.project_id) || {}).name }))
        .filter(e => projectTeam(e.project_id) === body.p_team)
        .filter(e => !(projects.find(p => p.id === e.project_id) || {}).archivedAt)
        // 024 §4: team_feed is security definer, so RLS does not cover it —
        // the can_see_project predicate is written into the RPC body itself.
        .filter(e => canSeeProject(e.project_id, userId))
        .filter(e => !body.p_author || e.author_id === body.p_author)
        .filter(e => !body.p_project || e.project_id === body.p_project)
        .filter(e => !body.p_source || e.source === body.p_source)
        .filter(e => !body.p_since || tsCmp(e.ts, body.p_since) >= 0)
        .filter(e => !body.p_until || tsCmp(e.ts, body.p_until) <= 0)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      if (body.p_before_created_at) {
        rows = rows.filter(e => tsCmp(e.created_at, body.p_before_created_at) < 0 ||
          (tsCmp(e.created_at, body.p_before_created_at) === 0 && e.id < body.p_before_id));
      }
      // Rendered on the way out, never in storage: see pgTimestamptz. This is
      // the path lib/feed.js consumes, and the one where a ts spelled
      // differently from the pushed original stops a string-keyed dedupe dead.
      return json(res, 200, rows.slice(0, Math.min(Math.max(body.p_limit || 50, 1), 200)).map(renderRow));
    }
    // 027_team_feed_counts.sql. Exact windowed totals counted in the database,
    // because paging team_feed to count rows published its 200-row-per-page
    // ceiling as if it were a total.
    //
    // The predicate here is team_feed's above, VERBATIM, minus only the keyset
    // paging and the row limit. The migration says to change both together if
    // it ever changes, and the same rule applies to this mock: a counts
    // function that outlives its feed's access rules reports totals over rows
    // the caller may no longer read, and a count is a disclosure even with no
    // row content attached.
    //
    // Returns ONE row even when nothing matches, never []. The real function
    // is an aggregate over a WHERE clause, so a non-member gets {0, 0} rather
    // than an empty result. A mock that returned [] here would let a client
    // that mishandles the empty case pass locally and fail against Postgres.
    if (fn === 'team_feed_counts') {
      const visible = !isMember(body.p_team, userId) ? [] : entries
        .filter(e => projectTeam(e.project_id) === body.p_team)
        .filter(e => !(projects.find(p => p.id === e.project_id) || {}).archivedAt)
        .filter(e => canSeeProject(e.project_id, userId))
        .filter(e => !body.p_author || e.author_id === body.p_author)
        .filter(e => !body.p_project || e.project_id === body.p_project)
        .filter(e => !body.p_source || e.source === body.p_source)
        .filter(e => !body.p_since || tsCmp(e.ts, body.p_since) >= 0)
        .filter(e => !body.p_until || tsCmp(e.ts, body.p_until) <= 0);
      // count(distinct e.session) ignores NULLs, so the session-less rows are
      // added back one unit each. lib/api-insights.js sessionKeyOf does the
      // same thing (`r.session || 'entry:' + r.id`), and the two must agree or
      // the page shows a different session count than the list beneath it.
      const named = new Set(visible.filter(e => e.session).map(e => e.session));
      const sessionless = visible.filter(e => !e.session).length;
      return json(res, 200, [{ entries: visible.length, sessions: named.size + sessionless }]);
    }
    if (fn === 'archive_project') {
      const teamId = projectTeam(body.p_project);
      if (!isManager(teamId, userId)) return json(res, 403, { message: 'only a team owner or admin can delete a project for the team' });
      const p = projects.find(x => x.id === body.p_project);
      if (p) p.archivedAt = new Date().toISOString();
      return json(res, 200, null);
    }
    if (fn === 'unarchive_project') {
      const teamId = projectTeam(body.p_project);
      if (!isManager(teamId, userId)) return json(res, 403, { message: 'only a team owner or admin can restore a project' });
      const p = projects.find(x => x.id === body.p_project);
      if (p) p.archivedAt = null;
      return json(res, 200, null);
    }
    // 026_project_access_default.sql: "new members join with access" toggle.
    // Same manager gate as archive/unarchive, same security-definer shape.
    if (fn === 'set_project_access_default') {
      const teamId = projectTeam(body.p_project);
      if (!isManager(teamId, userId)) {
        return json(res, 403, { message: "only a team owner or admin can change this project's default access" });
      }
      const p = projects.find(x => x.id === body.p_project);
      if (p) p.defaultAccess = !!body.p_default;
      return json(res, 200, null);
    }
    // 035_delete_own_entries.sql: self-serve deletion of the caller's OWN
    // synced rows, plus the preview the confirmation screen counts from.
    //
    // Both mirror the migration exactly on the point that matters: the
    // predicate is `author_id = auth.uid()` AND the project's team, and
    // NOTHING else. No isMember check and no canSeeProject check, because
    // 035 §1/§2 deliberately omit both. A member who just left the team, or
    // whose project access was revoked, must still be able to see and erase
    // what they wrote. A mock that "helpfully" added a membership gate here
    // would make the exact regression this feature exists to prevent pass
    // locally.
    //
    // Archived projects are included, unlike team_feed / team_feed_counts:
    // archiving hides a project, it does not remove its rows, and the preview
    // must count what the delete will actually take.
    if (fn === 'my_entry_counts') {
      const mine = entries.filter(e => projectTeam(e.project_id) === body.p_team && e.author_id === userId);
      const byProject = new Map();
      for (const e of mine) {
        const acc = byProject.get(e.project_id) || { entries: 0, first: null, last: null };
        acc.entries++;
        if (acc.first === null || tsCmp(e.ts, acc.first) < 0) acc.first = e.ts;
        if (acc.last === null || tsCmp(e.ts, acc.last) > 0) acc.last = e.ts;
        byProject.set(e.project_id, acc);
      }
      const rows = [...byProject.entries()].map(([projectId, acc]) => ({
        project_id: projectId,
        project_name: (projects.find(p => p.id === projectId) || {}).name || '',
        entries: acc.entries,
        first_ts: acc.first,
        last_ts: acc.last,
      })).sort((a, b) => String(a.project_name).localeCompare(String(b.project_name)));
      return json(res, 200, rows.map(renderRow));
    }
    if (fn === 'delete_my_entries') {
      const doomed = entries.filter(e =>
        projectTeam(e.project_id) === body.p_team &&
        e.author_id === userId &&
        (!body.p_project || e.project_id === body.p_project));
      for (const e of doomed) entries.splice(entries.indexOf(e), 1);
      // The audit row is written INSIDE the function in the real migration
      // (035 §3), in the same transaction, because team_audit's insert policy
      // requires is_team_manager and a plain member's own insert is refused.
      // Mirrored here with no role check for the same reason: a mock that only
      // logged for managers would hide the bug that motivated putting the
      // insert in the RPC at all.
      if (doomed.length) {
        // unshift + the offset created_at, matching the REST insert path
        // below, so two audit rows written in the same millisecond still sort
        // deterministically newest-first for the GET.
        teamAudit.unshift({
          id: uuid(),
          team_id: body.p_team,
          actor_id: userId,
          action: 'own-data-deleted',
          object_type: 'member',
          object_key: userId,
          detail: {
            memberId: userId,
            deleted: doomed.length,
            projectKey: body.p_project || null,
          },
          created_at: new Date(Date.now() + teamAudit.length).toISOString(),
        });
      }
      // One row per project actually emptied, the migration's shape (035 §3).
      // A scalar total is what the caller cannot act on: the deletion
      // watermark it writes on the client is per project, so a total made it
      // mark every linked project of the team, including ones this deletion
      // never touched. A mock that kept returning a number would let that
      // regression back in without a single test going red.
      const byProject = new Map();
      for (const e of doomed) byProject.set(e.project_id, (byProject.get(e.project_id) || 0) + 1);
      return json(res, 200, [...byProject.entries()].map(([projectId, n]) => ({
        project_id: projectId,
        deleted: n,
      })));
    }
    json(res, 404, { message: `unknown rpc ${fn}` });
  }

  function handleEntries(res, url, method, body, userId, prefer) {
    if (!userId) return json(res, 401, { message: 'not authenticated' });
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      // Simulates a backend whose schema predates one or more columns
      // (PostgREST rejects the whole insert with PGRST204). Reports the first
      // still-present rejected column; the client drops it and retries, so a
      // batch missing several columns recovers one round-trip at a time.
      const rejected = new Set(flags.rejectColumns);
      if (flags.rejectSummary) rejected.add('summary');
      for (const col of rejected) {
        if (rows.some(r => Object.prototype.hasOwnProperty.call(r, col))) {
          return json(res, 400, { message: `Could not find the '${col}' column of 'memory_entries' in the schema cache` });
        }
      }
      // An upsert is ONE statement, and Postgres refuses to update the same
      // row twice within it: two payload rows sharing the on_conflict key
      // abort the whole batch with SQLSTATE 21000, whatever `Prefer` says
      // (that only governs conflicts with rows ALREADY in the table). The
      // row-at-a-time loop below silently tolerated such a batch, which is
      // why a self-conflicting push looked fine here while failing in
      // production. Only upserts (on_conflict present) can raise this.
      if (url.searchParams.has('on_conflict')) {
        const seen = new Set();
        for (const r of rows) {
          const k = [r.project_id, r.author_id, r.ts, r.source].join('\x00');
          if (seen.has(k)) {
            return json(res, 400, {
              code: '21000',
              message: 'ON CONFLICT DO UPDATE command cannot affect row a second time',
            });
          }
          seen.add(k);
        }
      }
      // Blunt "the insert failed" knob, independent of the schema-drift and
      // duplicate-key paths above: lets a test prove what survives a push
      // that simply does not land.
      if (flags.failEntryInserts) return json(res, 500, { message: 'insert failed' });
      const merge = /merge-duplicates/.test(prefer || '');
      for (const r of rows) {
        // 033_enforce_project_access_on_write.sql: can_see_project now gates
        // memory_entries_insert AND memory_entries_update, not just _select.
        // Before it, a member revoked from a project could still push into it —
        // write-only access to a project they cannot read back.
        //
        // ONE CHECK COVERS BOTH POLICIES because 033 gives them the same
        // predicate, and covers the UPDATE policy's USING and WITH CHECK
        // together for the same reason: the loop below reaches the update path
        // via `merge`, and both clauses would refuse it identically.
        //
        // Message matches real PostgREST's wording rather than the mock's older
        // 'row-level security violation', because lib/teamsync.js rlsHint()
        // greps the message text and a test below depends on what it says.
        if (r.author_id !== userId || !isMember(projectTeam(r.project_id), userId)
            || (!flags.noWriteAccessCheck && !canSeeProject(r.project_id, userId))) {
          stats.deniedInserts++;
          return json(res, 403, {
            message: 'new row violates row-level security policy for table "memory_entries"',
          });
        }
        const idx = entries.findIndex(e => e.project_id === r.project_id &&
          e.author_id === r.author_id && e.ts === r.ts && e.source === r.source);
        if (idx >= 0) {
          if (merge) entries[idx] = { ...entries[idx], ...r }; // Prefer: resolution=merge-duplicates (overwrite in place)
          continue; // Prefer: resolution=ignore-duplicates (leave as-is)
        }
        stats.inserts++;
        entries.push({ ...r, id: entries.length + 1, created_at: new Date(Date.now() + entries.length).toISOString() });
      }
      res.writeHead(201);
      return res.end();
    }
    // GET with the exact filter shapes teamsync emits
    const p = url.searchParams;
    // Simulates a backend whose schema predates one or more columns being
    // requested in `select=` — real PostgREST returns a 400 with a
    // "column ... does not exist" message (distinct shape from the POST
    // PGRST204 case above), and the client's select-trimming loop should
    // drop the column and retry rather than losing the whole pull.
    const selectCols = (p.get('select') || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const col of flags.rejectColumns) {
      if (selectCols.includes(col)) {
        return json(res, 400, { message: `column memory_entries.${col} does not exist` });
      }
    }
    const eq = (p.get('project_id') || '').replace(/^eq\./, '');
    const neq = (p.get('author_id') || '').replace(/^neq\./, '');
    // created_at carries the forward pull's operator: `gt.` (ascending,
    // "everything since the cursor"). The backward backfill walker now pages
    // on `id` instead (an id cursor has no ties; see lib/teamsync.js
    // backfillArchivePage for why created_at's ties made it unsafe to page
    // on). Real PostgREST would AND every filter sent; teamsync only ever
    // sends one shape per call, so matching just what is present is enough.
    const createdAtRaw = p.get('created_at') || '';
    const isGt = /^gt\./.test(createdAtRaw);
    const createdAtBound = decodeURIComponent(createdAtRaw.replace(/^gt\./, ''));
    const idRaw = p.get('id') || '';
    const isIdLt = /^lt\./.test(idRaw);
    const idBound = isIdLt ? Number(decodeURIComponent(idRaw.replace(/^lt\./, ''))) : null;
    const order = p.get('order') || '';
    const descById = order === 'id.desc';
    const descByCreatedAt = order === 'created_at.desc';
    // 025 §2: memory_entries_select ANDs can_see_project onto the membership
    // check — a revoked member's direct pull sees nothing for this project.
    if (!isMember(projectTeam(eq), userId) || !canSeeProject(eq, userId)) return json(res, 200, []);
    let rows = entries.filter(e => e.project_id === eq && e.author_id !== neq);
    if (isGt) rows = rows.filter(e => tsCmp(e.created_at, createdAtBound) > 0);
    if (isIdLt) rows = rows.filter(e => Number(e.id) < idBound);
    // Order THEN limit — a descending page must return the NEWEST rows below
    // the bound (the tail closest to the cursor), not just the first `limit`
    // rows encountered in storage order before sorting.
    rows = rows
      .slice()
      .sort((a, b) => {
        if (descById) return b.id - a.id;
        return descByCreatedAt ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at);
      })
      .slice(0, parseInt(p.get('limit') || '200', 10));
    // Real PostgREST only returns the requested columns — project to
    // selectCols (when the caller sent one) so a dropped-and-retried select
    // (the goal/decisions/gotchas/changes fallback loop) actually exercises
    // the client's "missing column" degradation instead of leaking a value
    // the client didn't ask for.
    const projected = selectCols.length
      ? rows.map(r => Object.fromEntries(selectCols.filter(c => c in r).map(c => [c, r[c]])))
      : rows;
    // Rendered on the way out, never in storage: see pgTimestamptz.
    json(res, 200, projected.map(renderRow));
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {}
      const url = new URL(req.url, 'http://127.0.0.1');

      if (url.pathname === '/auth/v1/signup') {
        if (users.has(body.email)) return json(res, 400, { msg: 'User already registered' });
        const user = { id: uuid(), email: body.email, password: body.password };
        users.set(body.email, user);
        return json(res, 200, newSession(user));
      }
      // GoTrue's session teardown. Revoking here is what makes a sign-out
      // durable: the refresh token stops working, so a leaked or copied
      // credentials file cannot be replayed into a fresh access token. Modelled
      // faithfully (the token really is dropped) so a test can tell "the daemon
      // called this" apart from "the daemon deleted a local file and stopped".
      if (url.pathname === '/auth/v1/logout') {
        stats.logoutCalls++;
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const userId = sessions.get(token);
        if (userId) {
          for (const [rt, uid] of refreshTokens) if (uid === userId) refreshTokens.delete(rt);
          sessions.delete(token);
        }
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/auth/v1/user') {
        // What loginWithTokens calls to verify an OAuth access token. Only
        // tokens this mock issued (or a test seeded into `sessions`) resolve.
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { msg: 'invalid JWT' });
        const user = [...users.values()].find(u => u.id === userId);
        return json(res, 200, { id: user.id, email: user.email, user_metadata: user.metadata || {} });
      }
      if (url.pathname === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'pkce') {
          // The PKCE exchange. The code alone is worthless: the caller must
          // present the verifier whose s256 hash is the challenge that was
          // sent with the authorize request.
          const rec = authCodes.get(body.auth_code);
          if (!rec) return json(res, 400, { error_description: 'invalid auth code' });
          const digest = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
          if (digest !== rec.challenge) {
            return json(res, 400, { error_description: 'code challenge does not match' });
          }
          authCodes.delete(body.auth_code); // single use, as GoTrue does
          const codeUser = [...users.values()].find(u => u.id === rec.userId);
          return json(res, 200, newSession(codeUser));
        }
        if (url.searchParams.get('grant_type') === 'password') {
          const user = users.get(body.email);
          if (!user || user.password !== body.password) {
            return json(res, 400, { error_description: 'Invalid login credentials' });
          }
          return json(res, 200, newSession(user));
        }
        const userId = refreshTokens.get(body.refresh_token);
        if (!userId) return json(res, 400, { error_description: 'Invalid refresh token' });
        stats.refreshCalls++;
        const user = [...users.values()].find(u => u.id === userId);
        return json(res, 200, newSession(user));
      }
      const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (rpcMatch) return handleRpc(res, rpcMatch[1], body, authedUser(req));
      if (url.pathname === '/rest/v1/memory_entries') {
        return handleEntries(res, url, req.method, body, authedUser(req), req.headers.prefer || '');
      }
      if (url.pathname === '/rest/v1/project_stats' && req.method === 'GET') {
        // The security_invoker view: per-project last activity / contributor /
        // entry counts, RLS-filtered to the caller's teams. 024 §3 ANDs
        // can_see_project into the view itself — a revoked member's row
        // disappears entirely, not just its stats.
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const teamEq = (url.searchParams.get('team_id') || '').replace(/^eq\./, '');
        const rows = projects
          .filter(p => (!teamEq || p.teamId === teamEq) && isMember(p.teamId, userId) && !p.archivedAt &&
            canSeeProject(p.id, userId))
          .map(p => {
            const es = entries.filter(e => e.project_id === p.id);
            return {
              project_id: p.id, team_id: p.teamId, name: p.name, repo_url: p.repoUrl,
              last_activity: es.length ? es.map(e => e.ts).sort().pop() : null,
              contributors: new Set(es.map(e => e.author_id)).size,
              entries: es.length,
            };
          });
        return json(res, 200, rows);
      }
      // POST /rest/v1/projects — the capability schema.sql:118's `projects_insert`
      // policy grants and NO CLIENT USES. It is routed here purely so the suite
      // can exercise the path a member could take with the anon key and a bearer
      // token, which is what 029 §3 flagged and 032 closes. Do not reach for this
      // from lib/ — the only supported way to create a project is link_project.
      if (url.pathname === '/rest/v1/projects' && req.method === 'POST') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const rows = Array.isArray(body) ? body : [body];
        const created = [];
        for (const r of rows) {
          // projects_insert: `is_team_member(team_id) and created_by = auth.uid()`.
          // Both halves, or the mock would be more permissive than the policy.
          if (!isMember(r.team_id, userId)) return json(res, 403, { message: 'not a member of this team' });
          if (r.created_by && r.created_by !== userId) {
            return json(res, 403, { message: 'new row violates row-level security policy for table "projects"' });
          }
          // `unique (team_id, name)` (schema.sql:33) is a table constraint, so it
          // binds this path too — unlike link_project's repo_url dedup, which is
          // RPC logic and is genuinely bypassed here.
          if (projects.some(p => p.teamId === r.team_id && p.name === r.name)) {
            return json(res, 409, { message: 'duplicate key value violates unique constraint "projects_team_id_name_key"' });
          }
          const project = {
            id: uuid(), teamId: r.team_id, name: r.name, repoUrl: r.repo_url || null,
            defaultAccess: r.default_access !== false,
          };
          projects.push(project);
          projectsInsertTrigger(project);
          created.push({ id: project.id, team_id: project.teamId, name: project.name, repo_url: project.repoUrl });
        }
        return json(res, 201, created);
      }
      if (url.pathname === '/rest/v1/projects' && req.method === 'GET') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const idRaw = url.searchParams.get('id') || '';
        const idEq = /^eq\./.test(idRaw) ? idRaw.replace(/^eq\./, '') : '';
        // `id=in.(a,b,c)` — lib/api-access.js accessMatrix reads every shared
        // project's default_access in ONE request (no N+1), so the mock has to
        // understand the list form too, not just the single-id form readAccess
        // uses. Real PostgREST projects to `select`; both callers ask for a
        // subset, so honour it rather than returning the whole row.
        const idIn = /^in\.\(/.test(idRaw)
          ? idRaw.replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean)
          : null;
        if (idEq || idIn) {
          // 026_project_access_default.sql: default_access lookup. Same
          // projects_select policy as the auto-link fetch below
          // (is_team_member(team_id)).
          const wanted = idIn || [idEq];
          const cols = (url.searchParams.get('select') || 'default_access').split(',').map(s => s.trim());
          const rows = projects
            .filter(x => wanted.includes(x.id) && isMember(x.teamId, userId))
            .map(p => {
              const full = { id: p.id, team_id: p.teamId, name: p.name, repo_url: p.repoUrl, default_access: p.defaultAccess !== false };
              return Object.fromEntries(cols.filter(c => c in full).map(c => [c, full[c]]));
            });
          return json(res, 200, rows);
        }
        // `team_id=eq.<uuid>` — lib/teamsync.js teamHasLiveProject, the
        // corroborating probe for an empty project_stats.
        //
        // NOTE, and it is the whole point of that probe: this filters on
        // is_team_member ONLY. It does NOT call canSeeProject, and it does NOT
        // drop archived rows — because the live projects_select policy does
        // neither (supabase/schema.sql; verified against the live catalog, and
        // pinned by test/suites/revocation-empty-visibility.test.js). That is
        // precisely how it differs from project_stats above, and mirroring it
        // wrongly here would make the probe's test a fiction.
        const teamEq = (url.searchParams.get('team_id') || '').replace(/^eq\./, '');
        if (teamEq) {
          if (flags.failProjectsList) return json(res, 500, { message: 'projects list failed' });
          const cols = (url.searchParams.get('select') || 'id').split(',').map(s => s.trim());
          const rows = projects
            .filter(p => p.teamId === teamEq && isMember(p.teamId, userId))
            .map(p => {
              const full = {
                id: p.id, team_id: p.teamId, name: p.name, repo_url: p.repoUrl,
                archived_at: p.archivedAt || null,
              };
              return Object.fromEntries(cols.filter(c => c in full).map(c => [c, full[c]]));
            });
          return json(res, 200, rows);
        }
        // Auto-link fetch: RLS means only projects in the caller's teams.
        const rows = projects
          .filter(p => isMember(p.teamId, userId) && p.repoUrl)
          .map(p => ({ id: p.id, team_id: p.teamId, name: p.name, repo_url: p.repoUrl }));
        return json(res, 200, rows);
      }
      // ---- 009_e2e_encryption.sql tables, RLS mirrored from its policies ----
      if (url.pathname === '/rest/v1/member_pubkeys') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        if (req.method === 'POST') {
          // Upsert on user_id, own row only (009: insert/update policies).
          const rows = Array.isArray(body) ? body : [body];
          for (const r of rows) {
            if (r.user_id !== userId) return json(res, 403, { message: 'row-level security violation' });
            pubkeys.set(r.user_id, r.public_key);
          }
          res.writeHead(201);
          return res.end();
        }
        // GET ?user_id=in.(a,b): own row always; a teammate's only when the
        // caller shares a team with them (009: select policy).
        const inRaw = (url.searchParams.get('user_id') || '').replace(/^in\.\(/, '').replace(/\)$/, '');
        const ids = inRaw ? inRaw.split(',') : [...pubkeys.keys()];
        const sharesTeam = other => other === userId ||
          members.some(m => m.userId === userId &&
            members.some(x => x.teamId === m.teamId && x.userId === other));
        const rows = ids
          .filter(id => pubkeys.has(id) && sharesTeam(id))
          .map(id => ({ user_id: id, public_key: pubkeys.get(id) }));
        return json(res, 200, rows);
      }
      if (url.pathname === '/rest/v1/team_keys') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        if (req.method === 'POST') {
          // Any member may seal rows for the team, including rows addressed
          // to teammates (009: insert policy checks the WRITER's membership).
          // The (team_id, epoch, member_user_id) PK is enforced here: with
          // Prefer resolution=ignore-duplicates conflicting rows are skipped
          // (the concurrent-mint race), without it the insert 409s.
          const rows = Array.isArray(body) ? body : [body];
          const ignoreDup = /ignore-duplicates/.test(req.headers.prefer || '');
          for (const r of rows) {
            if (!isMember(r.team_id, userId)) return json(res, 403, { message: 'row-level security violation' });
            const dup = teamKeys.some(k => k.team_id === r.team_id &&
              String(k.epoch) === String(r.epoch) && k.member_user_id === r.member_user_id);
            if (dup) {
              if (ignoreDup) continue;
              return json(res, 409, { message: 'duplicate key value violates unique constraint "team_keys_pkey"' });
            }
            teamKeys.push({ ...r });
          }
          res.writeHead(201);
          return res.end();
        }
        if (req.method === 'DELETE') {
          // A member may delete only their OWN sealed rows (self-heal for a
          // rotated key). RLS: member_user_id must equal the caller.
          const q0 = url.searchParams;
          const tEq0 = (q0.get('team_id') || '').replace(/^eq\./, '');
          const mEq0 = (q0.get('member_user_id') || '').replace(/^eq\./, '');
          const epIn = (q0.get('epoch') || '').replace(/^in\./, '').replace(/[()]/g, '');
          const epochs = new Set(epIn ? epIn.split(',').map(s => s.trim()) : []);
          if (mEq0 && mEq0 !== userId) return json(res, 403, { message: 'row-level security violation' });
          for (let i = teamKeys.length - 1; i >= 0; i--) {
            const k = teamKeys[i];
            if ((!tEq0 || k.team_id === tEq0) && k.member_user_id === userId &&
                (!epochs.size || epochs.has(String(k.epoch)))) {
              teamKeys.splice(i, 1);
            }
          }
          res.writeHead(204);
          return res.end();
        }
        // GET (013 policy): every key row of a team the caller belongs to is
        // visible — epoch membership is how any member detects rotation and
        // join needs. Sealed blobs ride along; only the target's private key
        // can open one, so visibility is not a confidentiality leak. The
        // member_user_id filter is honored when the client sends it.
        const q = url.searchParams;
        const tEq = (q.get('team_id') || '').replace(/^eq\./, '');
        const eEq = (q.get('epoch') || '').replace(/^eq\./, '');
        const mEq = (q.get('member_user_id') || '').replace(/^eq\./, '');
        const rows = teamKeys
          .filter(k => isMember(k.team_id, userId) &&
            (!tEq || k.team_id === tEq) && (!eEq || String(k.epoch) === eEq) &&
            (!mEq || k.member_user_id === mEq))
          .map(k => ({ epoch: k.epoch, member_user_id: k.member_user_id, sealed_team_key: k.sealed_team_key }));
        return json(res, 200, rows);
      }
      // ---- 002_team_v2.sql public.invites, RLS mirrored from its policies ----
      // invites_select is `is_team_member(team_id)` -- deliberately WIDER than
      // the owner/admin gate lib/api-access.js readInvites applies on top. The
      // mock mirrors the policy, not the Node gate, so a test that loses the
      // Node gate fails here instead of silently passing on a mock that was
      // stricter than the real backend.
      if (url.pathname === '/rest/v1/invites' && req.method === 'GET') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const q = url.searchParams;
        const teamEq = (q.get('team_id') || '').replace(/^eq\./, '');
        // token=eq.<token> — the single-row lookup lib/api-access.js
        // inviteTeamId uses to answer "which team is this invite for?", so the
        // revoke route can file its audit event against the invite's OWN team
        // instead of teams[0]. Supported as an ALTERNATIVE to the team_id
        // filter, never as a way around RLS: invites_select is
        // `is_team_member(team_id)`, and RLS on select FILTERS rather than
        // raising, so a caller who is not a member of the invite's team must
        // see an empty result and not a 403. That is exactly what the
        // isMember check below produces.
        const tokenEq = (q.get('token') || '').replace(/^eq\./, '');
        if (tokenEq) {
          const inv = invites.get(tokenEq);
          if (!inv || !isMember(inv.teamId, userId)) return json(res, 200, []);
          return json(res, 200, [{
            token: inv.token, team_id: inv.teamId, created_at: inv.createdAt,
            expires_at: inv.expiresAt, max_uses: inv.maxUses,
            use_count: inv.useCount, revoked_at: inv.revokedAt || null,
          }]);
        }
        if (!teamEq || !isMember(teamEq, userId)) return json(res, 200, []);
        // revoked_at is both a supported FILTER and a returned column:
        // readInvites selects it and derives `revoked` from it, so dropping it
        // from the row would make every invite look live regardless.
        const revokedFilter = q.get('revoked_at');
        const limit = parseInt(q.get('limit') || '100', 10);
        const rows = [...invites.values()]
          .filter(i => i.teamId === teamEq)
          .filter(i => (revokedFilter === 'is.null' ? !i.revokedAt : true))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, Math.max(1, limit))
          .map(i => ({
            token: i.token, created_at: i.createdAt, expires_at: i.expiresAt,
            max_uses: i.maxUses, use_count: i.useCount, revoked_at: i.revokedAt || null,
          }));
        return json(res, 200, rows);
      }
      // ---- 024_project_access_and_audit.sql tables, RLS mirrored from its policies ----
      if (url.pathname === '/rest/v1/project_access') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        if (req.method === 'POST') {
          // Manager-only write (023: project_access_insert/update policies).
          // Manual upsert on the (team_id, project_key, member_id) PK — the
          // on_conflict query param is accepted but not parsed, same as the
          // team_keys mock above.
          const rows = Array.isArray(body) ? body : [body];
          for (const r of rows) {
            if (!isManager(r.team_id, userId)) return json(res, 403, { message: 'row-level security violation' });
            const idx = projectAccess.findIndex(x =>
              x.team_id === r.team_id && x.project_key === r.project_key && x.member_id === r.member_id);
            const row = {
              team_id: r.team_id, project_key: r.project_key, member_id: r.member_id,
              can_see: !!r.can_see, updated_at: r.updated_at || new Date().toISOString(),
              updated_by: r.updated_by || userId,
            };
            if (idx >= 0) projectAccess[idx] = row; else projectAccess.push(row);
          }
          res.writeHead(201);
          return res.end();
        }
        // GET (024 §6: project_access_select narrowed to owner/admin — a
        // member reading the whole grid would learn about projects they
        // cannot see and every other member's flags).
        const q = url.searchParams;
        const teamEq = (q.get('team_id') || '').replace(/^eq\./, '');
        const keyEq = (q.get('project_key') || '').replace(/^eq\./, '');
        if (teamEq && !isManager(teamEq, userId)) return json(res, 200, []);
        const rows = projectAccess.filter(r =>
          (!teamEq || r.team_id === teamEq) && (!keyEq || r.project_key === keyEq));
        return json(res, 200, rows.map(r => ({ project_key: r.project_key, member_id: r.member_id, can_see: r.can_see })));
      }
      if (url.pathname === '/rest/v1/team_audit') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        if (req.method === 'POST') {
          // Manager-only insert, no update/delete route at all — append-only
          // (023: team_audit_insert is the only write policy on this table).
          // 024 §5 additionally requires actor_id = auth.uid(): a role check
          // alone let an owner/admin POST with someone else's id and blame
          // them for the write.
          const rows = Array.isArray(body) ? body : [body];
          for (const r of rows) {
            if (!isManager(r.team_id, userId)) return json(res, 403, { message: 'row-level security violation' });
            const actorId = r.actor_id || userId;
            if (actorId !== userId) {
              return json(res, 403, { message: 'row-level security violation: actor_id must equal auth.uid()' });
            }
            teamAudit.unshift({
              id: uuid(), team_id: r.team_id, actor_id: actorId,
              action: r.action, object_type: r.object_type, object_key: r.object_key || null,
              detail: r.detail === undefined ? null : r.detail,
              created_at: new Date(Date.now() + teamAudit.length).toISOString(),
            });
          }
          res.writeHead(201);
          return res.end();
        }
        // GET (023: team_audit_select policy) — manager-only read.
        const q = url.searchParams;
        const teamEq = (q.get('team_id') || '').replace(/^eq\./, '');
        if (!teamEq || !isManager(teamEq, userId)) return json(res, 200, []);
        const limit = parseInt(q.get('limit') || '50', 10);
        const rows = [...teamAudit]
          .filter(r => r.team_id === teamEq)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, Math.max(1, limit));
        return json(res, 200, rows);
      }
      json(res, 404, { message: 'not found' });
    });
  });

  // 029 §4's backfill, mirrored so the suite can assert its two guarantees
  // (idempotent, never overturns an explicit can_see = false). It is a
  // migration statement, not an endpoint, so it is exposed as a function on the
  // mock rather than a route — nothing over HTTP can reach it, same as the real
  // thing. Returns how many rows it inserted, which is what makes "running it
  // twice inserts nothing the second time" directly assertable.
  const backfillProjectAccess = () => {
    let inserted = 0;
    for (const p of projects) {
      for (const m of members.filter(x => x.teamId === p.teamId)) {
        if (grantAccessRow(p, m.userId)) inserted++;
      }
    }
    return inserted;
  };

  // Postgres' `delete from auth.users where id = ...`, constraints and all.
  //
  // Not an HTTP route: no client can delete an account. This models the
  // operator/GoTrue action, and it models the BLOCKING constraints rather than
  // only the cascading ones, because the blockers are the interesting part —
  // every `references auth.users (id)` declared with no on-delete action stops
  // the delete dead. Six of them do, and only ONE (team_audit.actor_id) is
  // this session's doing. A model that skipped the other five would let a test
  // claim 050 "unblocks account deletion", which it does not.
  //
  // Throws with the offending constraint name, as Postgres does, so a test can
  // assert WHICH constraint refused rather than merely that something did.
  const deleteUserCascade = userId => {
    const blockers = [
      // teams.created_by NOT NULL, no on-delete (schema.sql:13)
      [[...teams.values()].some(t => t.createdBy === userId), 'teams_created_by_fkey'],
      // projects.created_by NOT NULL, no on-delete (schema.sql:31)
      [projects.some(p => p.createdBy === userId), 'projects_created_by_fkey'],
      // memory_entries.author_id NOT NULL, no on-delete (schema.sql:46) — this
      // is the one that makes account deletion impossible for every real user,
      // and it predates today by a long way.
      [entries.some(e => e.author_id === userId), 'memory_entries_author_id_fkey'],
      // invites.created_by NOT NULL, no on-delete (002:58)
      [[...invites.values()].some(i => i.createdBy === userId), 'invites_created_by_fkey'],
      // team_audit.actor_id, nullable, no on-delete (024:44) UNTIL 050 makes
      // it `on delete set null`. flags.noAuditActorSetNull stands in for
      // "050 not applied".
      [flags.noAuditActorSetNull && teamAudit.some(r => r.actor_id === userId), 'team_audit_actor_id_fkey'],
    ];
    for (const [blocked, constraint] of blockers) {
      if (blocked) {
        throw new Error(
          `update or delete on table "users" violates foreign key constraint "${constraint}"`);
      }
    }
    // 050: the surviving rows keep the event and lose the link.
    if (flags.auditActorCascade) {
      for (let i = teamAudit.length - 1; i >= 0; i--) {
        if (teamAudit[i].actor_id === userId) teamAudit.splice(i, 1);
      }
    } else if (!flags.noAuditActorSetNull) {
      for (const r of teamAudit) if (r.actor_id === userId) r.actor_id = null;
    }
    // The three FKs that already cascade: team_members.user_id (schema.sql:19),
    // member_pubkeys.user_id (009:30), team_keys.member_user_id (009:46).
    // NOTE: no memberDeleteTrigger call. 049's trigger is gated on
    // auth.uid() = old.user_id and this path runs as the operator, so it does
    // not fire — modelled by simply not calling it, which is what the WHEN
    // clause amounts to here.
    for (let i = members.length - 1; i >= 0; i--) if (members[i].userId === userId) members.splice(i, 1);
    for (const [k, v] of pubkeys) if (k === userId || (v && v.user_id === userId)) pubkeys.delete(k);
    for (let i = teamKeys.length - 1; i >= 0; i--) if (teamKeys[i].member_user_id === userId) teamKeys.splice(i, 1);
    users.delete([...users.entries()].find(([, u]) => u.id === userId)?.[0]);
  };
  // Postgres' `delete from public.teams where id = ...`, cascades and all.
  // Not an HTTP route: no client can delete a team (there is no policy and no
  // RPC), so this models an operator action taken in the SQL editor -- which
  // is precisely the path 049's cascade guard exists for. Order matches
  // Postgres: the parent row goes first, THEN the referencing rows are
  // cascade-deleted, which is why the trigger sees a team that no longer
  // exists. `actor` stands in for auth.uid() of whoever ran it.
  const deleteTeamCascade = (teamId, actor) => {
    teams.delete(teamId);
    for (let i = members.length - 1; i >= 0; i--) {
      if (members[i].teamId !== teamId) continue;
      const row = members[i];
      members.splice(i, 1);
      memberDeleteTrigger(row, actor);
    }
    // team_audit.team_id references teams on delete cascade (024:43).
    for (let i = teamAudit.length - 1; i >= 0; i--) {
      if (teamAudit[i].team_id === teamId) teamAudit.splice(i, 1);
    }
  };
  return { server, users, sessions, authCodes, teams, members, projects, entries, invites, pubkeys, teamKeys, projectAccess, teamAudit, stats, flags, backfillProjectAccess, deleteTeamCascade, deleteUserCascade };
}

module.exports = { createMockSupabase, pgTimestamptz };
