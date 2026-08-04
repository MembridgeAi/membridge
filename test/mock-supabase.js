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
  const stats = { refreshCalls: 0, inserts: 0, deniedInserts: 0 };
  // Test knobs for backend quirks. rejectSummary is kept for back-compat;
  // rejectColumns is the general form — any column name added here provokes the
  // PostgREST "schema cache" error until the POST body no longer carries it, so
  // the client's drop-and-retry loop can be exercised across multiple columns.
  const flags = { rejectSummary: false, rejectColumns: new Set(), failEntryInserts: false };

  const uuid = () => crypto.randomUUID();
  const shortToken = () => crypto.randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10);
  const isMember = (teamId, userId) => members.some(m => m.teamId === teamId && m.userId === userId);
  const memberRole = (teamId, userId) => (members.find(m => m.teamId === teamId && m.userId === userId) || {}).role || null;
  const isManager = (teamId, userId) => ['owner', 'admin'].includes(memberRole(teamId, userId));
  const projectTeam = projectId => (projects.find(p => p.id === projectId) || {}).teamId;
  // 025_enforce_project_access.sql §1 (can_see_project): default-allow — a
  // project with no project_access row for this member is visible; an
  // explicit can_see=false row for THIS user is a revoke and wins. Mirrors
  // the predicate exactly, not a permissive stand-in.
  const canSeeProject = (projectId, userId) => {
    const row = projectAccess.find(r =>
      r.team_id === projectTeam(projectId) && r.project_key === projectId && r.member_id === userId);
    return !row || row.can_see !== false;
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
        // 024 §4: team_feed is security definer, so RLS does not cover it —
        // the can_see_project predicate is written into the RPC body itself.
        .filter(e => canSeeProject(e.project_id, userId))
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
        if (r.author_id !== userId || !isMember(projectTeam(r.project_id), userId)) {
          stats.deniedInserts++;
          return json(res, 403, { message: 'row-level security violation' });
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
    if (isGt) rows = rows.filter(e => e.created_at > createdAtBound);
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
      if (url.pathname === '/rest/v1/projects' && req.method === 'GET') {
        const userId = authedUser(req);
        if (!userId) return json(res, 401, { message: 'not authenticated' });
        const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        if (idEq) {
          // 026_project_access_default.sql: single-project default_access
          // lookup (lib/api-access.js readAccess). Same projects_select
          // policy as the auto-link fetch below (is_team_member(team_id)).
          const p = projects.find(x => x.id === idEq && isMember(x.teamId, userId));
          if (!p) return json(res, 200, []);
          return json(res, 200, [{ default_access: p.defaultAccess !== false }]);
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

  return { server, users, sessions, authCodes, teams, members, projects, entries, invites, pubkeys, teamKeys, projectAccess, teamAudit, stats, flags };
}

module.exports = { createMockSupabase };
