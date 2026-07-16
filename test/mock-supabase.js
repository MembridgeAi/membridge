'use strict';
// Minimal in-memory Supabase stand-in for the offline test suite: just enough
// GoTrue (signup / password grant / refresh) and PostgREST (the RPCs and the
// memory_entries table, with membership checks standing in for RLS) for
// lib/teamsync.js to run end-to-end without a network.
const http = require('http');
const crypto = require('crypto');

function createMockSupabase() {
  const users = new Map();          // email -> { id, email, password }
  const sessions = new Map();       // accessToken -> userId
  const refreshTokens = new Map();  // refreshToken -> userId
  const teams = new Map();          // teamId -> { id, name, inviteCode }
  const members = [];               // { teamId, userId, displayName, role }
  const projects = [];              // { id, teamId, name, repoUrl }
  const entries = [];               // memory_entries rows
  const invites = new Map();        // token -> { token, teamId, expiresAt, maxUses, useCount, revokedAt }
  const stats = { refreshCalls: 0, inserts: 0, deniedInserts: 0 };
  // Test knobs for backend quirks. rejectSummary is kept for back-compat;
  // rejectColumns is the general form — any column name added here provokes the
  // PostgREST "schema cache" error until the POST body no longer carries it, so
  // the client's drop-and-retry loop can be exercised across multiple columns.
  const flags = { rejectSummary: false, rejectColumns: new Set() };

  const uuid = () => crypto.randomUUID();
  const shortToken = () => crypto.randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10);
  const isMember = (teamId, userId) => members.some(m => m.teamId === teamId && m.userId === userId);
  const memberRole = (teamId, userId) => (members.find(m => m.teamId === teamId && m.userId === userId) || {}).role || null;
  const isManager = (teamId, userId) => ['owner', 'admin'].includes(memberRole(teamId, userId));
  const projectTeam = projectId => (projects.find(p => p.id === projectId) || {}).teamId;

  function newSession(user) {
    const access = `at-${uuid()}`;
    const refresh = `rt-${uuid()}`;
    sessions.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      user: { id: user.id, email: user.email },
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
      const team = { id: uuid(), name: body.p_name, inviteCode: uuid(), createdAt: new Date().toISOString() };
      teams.set(team.id, team);
      members.push({ teamId: team.id, userId, displayName: body.p_display_name, role: 'owner', joinedAt: new Date().toISOString() });
      return json(res, 200, [{ team_id: team.id, invite_code: team.inviteCode }]);
    }
    if (fn === 'join_team') {
      const team = [...teams.values()].find(t => t.inviteCode === body.p_code);
      if (!team) return json(res, 400, { message: 'invalid invite code' });
      if (!isMember(team.id, userId)) {
        members.push({ teamId: team.id, userId, displayName: body.p_display_name, role: 'member', joinedAt: new Date().toISOString() });
      }
      return json(res, 200, [{ team_id: team.id, team_name: team.name }]);
    }
    if (fn === 'link_project') {
      if (!isMember(body.p_team, userId)) return json(res, 403, { message: 'not a member of this team' });
      let row = body.p_repo_url
        ? projects.find(p => p.teamId === body.p_team && p.repoUrl === body.p_repo_url)
        : null;
      if (!row) row = projects.find(p => p.teamId === body.p_team && p.name === body.p_name);
      if (!row) {
        row = { id: uuid(), teamId: body.p_team, name: body.p_name, repoUrl: body.p_repo_url || null };
        projects.push(row);
      }
      return json(res, 200, row.id);
    }
    if (fn === 'my_teams') {
      const rows = members.filter(m => m.userId === userId).map(m => {
        const t = teams.get(m.teamId);
        return {
          team_id: m.teamId,
          team_name: t.name,
          role: m.role,
          invite_code: t.inviteCode,
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
        expiresAt: body.p_expires_at || null, maxUses: body.p_max_uses || null,
        useCount: 0, revokedAt: null,
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
        members.push({ teamId: team.id, userId, displayName: body.p_display_name, role: 'member', joinedAt: new Date().toISOString() });
        inv.useCount++;
      }
      return json(res, 200, [{ team_id: team.id, team_name: team.name }]);
    }
    if (fn === 'remove_member') {
      if (!isManager(body.p_team, userId)) return json(res, 403, { message: 'only a team owner or admin can remove members' });
      if (memberRole(body.p_team, body.p_user) === 'owner') return json(res, 400, { message: 'the team owner cannot be removed' });
      const i = members.findIndex(m => m.teamId === body.p_team && m.userId === body.p_user);
      if (i !== -1) members.splice(i, 1);
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
      if (i !== -1) members.splice(i, 1);
      return json(res, 200, null);
    }
    if (fn === 'team_members_list') {
      if (!isMember(body.p_team, userId)) return json(res, 200, []);
      const rows = members
        .filter(m => m.teamId === body.p_team)
        .sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))
        .map(m => ({ user_id: m.userId, display_name: m.displayName, role: m.role, joined_at: m.joinedAt || null }));
      return json(res, 200, rows);
    }
    if (fn === 'team_feed') {
      if (!isMember(body.p_team, userId)) return json(res, 200, []);
      let rows = entries
        .map(e => ({ ...e, project_name: (projects.find(p => p.id === e.project_id) || {}).name }))
        .filter(e => projectTeam(e.project_id) === body.p_team)
        .filter(e => !(projects.find(p => p.id === e.project_id) || {}).archivedAt)
        .filter(e => !body.p_author || e.author_id === body.p_author)
        .filter(e => !body.p_project || e.project_id === body.p_project)
        .filter(e => !body.p_source || e.source === body.p_source)
        .filter(e => !body.p_since || e.ts >= body.p_since)
        .filter(e => !body.p_until || e.ts <= body.p_until)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      if (body.p_before_created_at) {
        rows = rows.filter(e => e.created_at < body.p_before_created_at ||
          (e.created_at === body.p_before_created_at && e.id < body.p_before_id));
      }
      return json(res, 200, rows.slice(0, Math.min(Math.max(body.p_limit || 50, 1), 200)));
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
    json(res, 404, { message: `unknown rpc ${fn}` });
  }

  function handleEntries(res, url, method, body, userId) {
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
      for (const r of rows) {
        if (r.author_id !== userId || !isMember(projectTeam(r.project_id), userId)) {
          stats.deniedInserts++;
          return json(res, 403, { message: 'row-level security violation' });
        }
        const dup = entries.some(e => e.project_id === r.project_id &&
          e.author_id === r.author_id && e.ts === r.ts && e.source === r.source);
        if (dup) continue; // Prefer: resolution=ignore-duplicates
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
    const gt = decodeURIComponent((p.get('created_at') || '').replace(/^gt\./, ''));
    if (!isMember(projectTeam(eq), userId)) return json(res, 200, []);
    const rows = entries
      .filter(e => e.project_id === eq && e.author_id !== neq && e.created_at > gt)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, parseInt(p.get('limit') || '200', 10));
    // Real PostgREST only returns the requested columns — project to
    // selectCols (when the caller sent one) so a dropped-and-retried select
    // (the goal/decisions/gotchas/changes fallback loop) actually exercises
    // the client's "missing column" degradation instead of leaking a value
    // the client didn't ask for.
    const projected = selectCols.length
      ? rows.map(r => Object.fromEntries(selectCols.filter(c => c in r).map(c => [c, r[c]])))
      : rows;
    json(res, 200, projected);
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
      if (url.pathname === '/auth/v1/token') {
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
        return handleEntries(res, url, req.method, body, authedUser(req));
      }
      if (url.pathname === '/rest/v1/project_stats' && req.method === 'GET') {
        // The security_invoker view: per-project last activity / contributor /
        // entry counts, RLS-filtered to the caller's teams.
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const teamEq = (url.searchParams.get('team_id') || '').replace(/^eq\./, '');
        const rows = projects
          .filter(p => (!teamEq || p.teamId === teamEq) && isMember(p.teamId, userId) && !p.archivedAt)
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
      if (url.pathname === '/rest/v1/projects' && req.method === 'GET') {
        // Auto-link fetch: RLS means only projects in the caller's teams.
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const rows = projects
          .filter(p => isMember(p.teamId, userId) && p.repoUrl)
          .map(p => ({ id: p.id, team_id: p.teamId, name: p.name, repo_url: p.repoUrl }));
        return json(res, 200, rows);
      }
      json(res, 404, { message: 'not found' });
    });
  });

  return { server, users, teams, members, projects, entries, invites, stats, flags };
}

module.exports = { createMockSupabase };
