'use strict';
// Team sync: push this machine's redacted per-project memory entries to a
// Supabase backend and pull teammates' entries down, so every team member's
// AI tools see what the whole team's AIs did.
//
// Zero-dependency by design: raw fetch against Supabase's GoTrue (auth) and
// PostgREST (data) APIs. Tests point MEMBRIDGE_TEAM_URL at a local mock so
// the suite stays offline.
//
// Privacy: only entries already produced by memorydb.buildEntries leave the
// machine — redacted asks and agent summaries, relative file paths,
// timestamps, tool names. Never file contents, and only for projects
// explicitly linked with `team link`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('./util');
const memorydb = require('./memorydb');
const digest = require('./digest');
// Baked-in backend shipped with the build (operator fills lib/backend.json
// once). End users never configure a backend — they just sign up.
const BAKED = (() => {
  try {
    return require('./backend.json');
  } catch {
    return {};
  }
})();

const credentialsPath = () => path.join(util.homeDir(), 'credentials.json');
const teamFilePath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'team.json');

const MAX_TEAM_ENTRIES = 100; // kept per project in state
const PUSH_BATCH = 50;
const PULL_LIMIT = 200;

// ---------------------------------------------------------------------------
// Backend location, in priority order:
//   1. env overrides            — tests/CI point at a local mock
//   2. config.team { url, ... } — self-hosters overriding the shipped backend
//   3. baked lib/backend.json   — the MemBridge-operated backend (the default)
// Users on a normal build fall straight through to (3) and never configure it.
// ---------------------------------------------------------------------------
function backend(config) {
  const team = (config && config.team) || {};
  const url = process.env.MEMBRIDGE_TEAM_URL || team.url || BAKED.url || '';
  const anonKey = process.env.MEMBRIDGE_TEAM_ANON_KEY || team.anonKey || BAKED.anonKey || '';
  return url && anonKey ? { url: url.replace(/\/+$/, ''), anonKey } : null;
}

// Base URL of the hosted web app (the /join/<token> landing pages). Optional:
// with no web app configured, invites still work as bare tokens via the CLI.
function webUrl(config) {
  const team = (config && config.team) || {};
  const u = process.env.MEMBRIDGE_TEAM_WEB_URL || team.webUrl || BAKED.webUrl || '';
  return u ? u.replace(/\/+$/, '') : null;
}

function isConfigured(config) {
  return !!backend(config || util.getConfig());
}

// ---------------------------------------------------------------------------
// Credentials: ~/.membridge/credentials.json, chmod 600. Never in a project.
// ---------------------------------------------------------------------------
function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2));
  try {
    fs.chmodSync(credentialsPath(), 0o600);
  } catch {}
}

function clearCredentials() {
  try {
    fs.unlinkSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}

async function authRequest(be, pathname, body) {
  const res = await fetch(`${be.url}/auth/v1/${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: be.anonKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.error_description || data.message || `auth error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function sessionToCredentials(session, displayName) {
  const prev = loadCredentials() || {};
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName: displayName || prev.displayName || String(session.user.email || '').split('@')[0],
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    // expires_in is seconds; keep a 60s safety margin on every check
    expiresAt: Date.now() + (session.expires_in || 3600) * 1000,
  };
}

async function signup(config, email, password, displayName) {
  const be = backend(config);
  if (!be) throw new Error('team sync is not available in this build (no backend baked in)');
  const data = await authRequest(be, 'signup', { email, password });
  // With email confirmation enabled Supabase returns a user but no session.
  if (!data.access_token) {
    return { needsConfirmation: true, email };
  }
  const creds = sessionToCredentials(data, displayName);
  saveCredentials(creds);
  return creds;
}

async function login(config, email, password, displayName) {
  const be = backend(config);
  if (!be) throw new Error('team sync is not available in this build (no backend baked in)');
  const data = await authRequest(be, 'token?grant_type=password', { email, password });
  const creds = sessionToCredentials(data, displayName);
  saveCredentials(creds);
  return creds;
}

// Valid access token, refreshing when it is stale. Returns null when logged out.
async function getAccessToken(config) {
  const be = backend(config);
  const creds = loadCredentials();
  if (!be || !creds || !creds.refreshToken) return null;
  if (creds.expiresAt && creds.expiresAt - Date.now() > 60000) return creds;
  const data = await authRequest(be, 'token?grant_type=refresh_token', {
    refresh_token: creds.refreshToken,
  });
  const next = sessionToCredentials(data, creds.displayName);
  saveCredentials(next);
  return next;
}

// ---------------------------------------------------------------------------
// PostgREST helper
// ---------------------------------------------------------------------------
async function rest(config, creds, method, pathname, body, headers) {
  const be = backend(config);
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
    throw new Error(msg);
  }
  return data;
}

async function rpc(config, creds, fn, args) {
  return rest(config, creds, 'POST', `rpc/${fn}`, args || {});
}

// ---------------------------------------------------------------------------
// Teams and project linking
// ---------------------------------------------------------------------------
async function createTeam(config, name) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'create_team', {
    p_name: name,
    p_display_name: creds.displayName,
  });
  return rows[0]; // { team_id, invite_code }
}

async function joinTeam(config, inviteCode) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'join_team', {
    p_code: inviteCode,
    p_display_name: creds.displayName,
  });
  return rows[0]; // { team_id, team_name }
}

async function listTeams(config) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  return rpc(config, creds, 'my_teams', {});
}

// ---------------------------------------------------------------------------
// Invite links (schema v2): short URL-safe tokens that map to
// https://<web app>/join/<token> and `membridge join <token>`. The legacy
// UUID invite_code keeps working — join() routes on the input's shape.
// ---------------------------------------------------------------------------
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accepts a bare token, a legacy UUID code, or a pasted /join/<token> URL.
function parseInviteToken(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/join\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  return m ? m[1] : s;
}

function inviteUrl(config, token) {
  const base = webUrl(config);
  return base ? `${base}/join/${token}` : null;
}

async function createInvite(config, teamId, opts = {}) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'create_invite', {
    p_team: teamId,
    p_expires_at: opts.expiresAt || null,
    p_max_uses: opts.maxUses || null,
  });
  const inv = rows[0]; // { token, expires_at, max_uses }
  return { ...inv, url: inviteUrl(config, inv.token) };
}

async function revokeInvite(config, token) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  await rpc(config, creds, 'revoke_invite', { p_token: parseInviteToken(token) });
}

// ---------------------------------------------------------------------------
// Team hub reads and management (schema v2 RPCs / views). Thin wrappers: the
// dashboard server is the only caller, and RLS on the backend is the real
// authorization layer — these just require a login and pass arguments through.
// ---------------------------------------------------------------------------
async function hubCreds(config) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  return creds;
}

async function listMembers(config, teamId) {
  const creds = await hubCreds(config);
  return rpc(config, creds, 'team_members_list', { p_team: teamId });
}

async function teamFeed(config, teamId, opts = {}) {
  const creds = await hubCreds(config);
  return rpc(config, creds, 'team_feed', {
    p_team: teamId,
    p_before_created_at: opts.beforeCreatedAt || null,
    p_before_id: opts.beforeId || null,
    p_limit: opts.limit || 50,
    p_author: opts.author || null,
    p_project: opts.project || null,
    p_source: opts.source || null,
    p_since: opts.since || null,
    p_until: opts.until || null,
  });
}

async function projectStats(config, teamId) {
  const creds = await hubCreds(config);
  return rest(config, creds, 'GET',
    `project_stats?team_id=eq.${encodeURIComponent(teamId)}&select=*`);
}

async function removeMember(config, teamId, userId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'remove_member', { p_team: teamId, p_user: userId });
}

async function setRole(config, teamId, userId, role) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'set_role', { p_team: teamId, p_user: userId, p_role: role });
}

async function renameTeam(config, teamId, name) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'rename_team', { p_team: teamId, p_name: name });
}

async function rotateInvite(config, teamId) {
  const creds = await hubCreds(config);
  return rpc(config, creds, 'rotate_invite', { p_team: teamId });
}

async function leaveTeam(config, teamId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'leave_team', { p_team: teamId });
}

// One join for every input shape: legacy UUID codes take the v1 RPC, short
// tokens take redeem_invite. Returns { team_id, team_name } either way.
async function join(config, input) {
  const token = parseInviteToken(input);
  if (UUID_RX.test(token)) return joinTeam(config, token);
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'redeem_invite', {
    p_token: token,
    p_display_name: creds.displayName,
  });
  return rows[0];
}

// Normalized git remote so every teammate's clone maps to one project row:
// git@github.com:user/repo.git and https://github.com/user/repo both become
// github.com/user/repo.
function repoUrl(projectPath) {
  try {
    const r = spawnSync('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status !== 0) return null;
    let u = String(r.stdout || '').trim();
    if (!u) return null;
    u = u.replace(/\.git$/, '');
    const ssh = u.match(/^[\w.-]+@([\w.-]+):(.+)$/);
    if (ssh) u = `${ssh[1]}/${ssh[2]}`;
    u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
    return u.toLowerCase();
  } catch {
    return null;
  }
}

function loadTeamLink(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(teamFilePath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

async function linkProject(config, projectPath, teamId, teamName) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const resolved = path.resolve(projectPath);
  // A team.json already in the project — committed by a teammate, or left by a
  // previous link — is the source of truth: adopt its project row so clones on
  // different fork remotes converge on one shared project instead of each
  // minting an island keyed to its own remote. Only a missing or incomplete
  // file falls through to the remote-based upsert below.
  const existing = loadTeamLink(resolved);
  if (existing && existing.projectId && existing.teamId) {
    const teams = await rpc(config, creds, 'my_teams', {});
    const team = (teams || []).find(t => t.team_id === existing.teamId);
    if (!team) {
      const label = existing.teamName ? `"${existing.teamName}"` : existing.teamId;
      throw new Error(
        `${path.join(memorydb.DIR_NAME, 'team.json')} already links this project to team ${label}, ` +
        'which you are not a member of — join that team first (`membridge team join <invite>`), ' +
        'or `membridge team unlink` here to link it elsewhere');
    }
    // Leave the committed file byte-identical: rewriting it would dirty every
    // teammate's working tree without changing any data.
    return { ...existing, teamName: existing.teamName || team.team_name, adopted: true };
  }
  const projectId = await rpc(config, creds, 'link_project', {
    p_team: teamId,
    p_name: path.basename(resolved),
    p_repo_url: repoUrl(resolved) || '',
  });
  const link = { projectId, teamId, teamName: teamName || '', linkedBy: creds.email, linkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(resolved, memorydb.DIR_NAME), { recursive: true });
  fs.writeFileSync(teamFilePath(resolved), JSON.stringify(link, null, 2));
  return link;
}

function unlinkProject(projectPath) {
  try {
    fs.unlinkSync(teamFilePath(projectPath));
    return true;
  } catch {
    return false;
  }
}

// Soft-delete a shared project for the whole team (reversible). The backend
// archive_project / unarchive_project RPCs enforce the owner/admin gate — these
// are thin wrappers, exactly like removeMember/setRole above.
async function archiveProject(config, projectId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'archive_project', { p_project: projectId });
}

async function unarchiveProject(config, projectId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'unarchive_project', { p_project: projectId });
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------
async function pushProject(config, creds, projectPath, proj, link) {
  const cursor = proj.teamPushTs || '';
  const entries = memorydb.buildEntries(projectPath, proj, config)
    .filter(e => e.ts > cursor);
  if (!entries.length) return 0;
  // buildEntries already redacts ask and summary; re-run the same pipeline at
  // the network boundary as defense in depth — nothing leaves the machine
  // without a final pass, even if a future caller hands in raw text.
  const regexes = digest.compileRedactions(config);
  const scrub = (text, n) => (text ? digest.clip(digest.redactText(text, regexes), n) : text);
  // Verbatim prompts are the most sensitive field in an entry: they leave the
  // machine only when the user opts in (config.team.sharePrompts, same
  // convention as team.autoLink). Summary and files upload either way.
  // TODO(privacy): existing rows predate the gate — whether to backfill or
  // scrub already-uploaded asks is a product decision, not made here.
  const share = ((config && config.team) || {}).sharePrompts === true;
  let pushed = 0;
  for (let i = 0; i < entries.length; i += PUSH_BATCH) {
    const rows = entries.slice(i, i + PUSH_BATCH).map(e => ({
      project_id: link.projectId,
      author_id: creds.userId,
      author_name: creds.displayName,
      ts: e.ts,
      source: e.source,
      session: e.session || null,
      ask: share ? scrub(e.ask, 400) : null,
      files: e.files,
      summary: e.summary ? scrub(e.summary, 300) : null,
    }));
    try {
      await rest(config, creds, 'POST',
        'memory_entries?on_conflict=project_id,author_id,ts,source',
        rows,
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    } catch (err) {
      // A backend whose schema predates the summary column (PostgREST
      // PGRST204) must not kill team sync: drop the field and retry the
      // batch. Stateless on purpose — summaries resume by themselves once
      // the backend gains the column.
      if (!/'summary' column/i.test(err.message)) throw err;
      await rest(config, creds, 'POST',
        'memory_entries?on_conflict=project_id,author_id,ts,source',
        rows.map(({ summary, ...bare }) => bare),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
    pushed += rows.length;
  }
  proj.teamPushTs = entries[entries.length - 1].ts;
  return pushed;
}

async function pullProject(config, creds, proj, link) {
  const cursor = proj.teamPullTs || '1970-01-01T00:00:00.000Z';
  const q = `memory_entries?project_id=eq.${link.projectId}` +
    `&author_id=neq.${creds.userId}` +
    `&created_at=gt.${encodeURIComponent(cursor)}` +
    `&order=created_at.asc&limit=${PULL_LIMIT}` +
    '&select=author_name,ts,source,session,ask,summary,files,created_at';
  const rows = await rest(config, creds, 'GET', q);
  if (!rows || !rows.length) return 0;
  const existing = proj.teamEntries || [];
  const seen = new Set(existing.map(e => `${e.author}|${e.ts}|${e.source}`));
  for (const r of rows) {
    const k = `${r.author_name}|${r.ts}|${r.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    existing.push({
      author: r.author_name,
      ts: r.ts,
      source: r.source,
      // teamInjectSlice dedupes by (author, session) when present, falling
      // back to (author, source) only for rows pushed before this field
      // existed — carry it through so a teammate's distinct sessions on the
      // same tool don't collapse into just the newest one.
      session: r.session || null,
      ask: r.ask,
      summary: r.summary || null,
      files: Array.isArray(r.files) ? r.files : [],
    });
  }
  existing.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  proj.teamEntries = existing.slice(-MAX_TEAM_ENTRIES);
  proj.teamPullTs = rows[rows.length - 1].created_at;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Auto-link (schema v2): when a local project's normalized git remote matches
// a project a teammate already linked, surface it. Privacy-first default:
// record a suggestion the user confirms in the dashboard (or `team link`);
// linking-and-uploading happens automatically only with config
// team.autoLink === true.
// ---------------------------------------------------------------------------
async function detectAutoLinks(config, creds, state) {
  const auto = ((config && config.team) || {}).autoLink === true;
  const changedKeys = [];
  // Local candidates: tracked, unlinked, undismissed projects with a remote.
  const candidates = [];
  for (const key of Object.keys(state.projects || {})) {
    if (util.isProjectOff(key, config) || loadTeamLink(key)) continue;
    const remote = repoUrl(key);
    if (remote) candidates.push({ key, remote });
  }
  if (!candidates.length) return changedKeys;

  const remote = await rest(config, creds, 'GET',
    'projects?select=id,team_id,name,repo_url&repo_url=not.is.null');
  if (!remote || !remote.length) return changedKeys;
  let teams = null; // fetched lazily, only when something matches

  for (const c of candidates) {
    const match = remote.find(r => String(r.repo_url).toLowerCase() === c.remote);
    if (!match) continue;
    const proj = state.projects[c.key];
    if (proj.teamSuggestionDismissed === c.remote) continue;
    if (!teams) teams = await rpc(config, creds, 'my_teams', {});
    const team = (teams || []).find(t => t.team_id === match.team_id);
    if (!team) continue; // a team we're no longer in
    if (auto) {
      await linkProject(config, c.key, match.team_id, team.team_name);
      delete proj.teamSuggestion;
      util.log(`team: auto-linked ${c.key} to ${team.team_name} (matching remote ${c.remote})`);
      changedKeys.push(c.key);
    } else if (!proj.teamSuggestion || proj.teamSuggestion.repoUrl !== c.remote) {
      proj.teamSuggestion = {
        teamId: match.team_id,
        teamName: team.team_name,
        repoUrl: c.remote,
        suggestedAt: new Date().toISOString(),
      };
      util.log(`team: ${c.key} matches ${team.team_name}'s remote ${c.remote} — suggested link (confirm in the dashboard or with \`membridge team link\`)`);
      changedKeys.push(c.key);
    }
  }
  return changedKeys;
}

// Confirm or dismiss a stored auto-link suggestion for a project.
async function resolveSuggestion(config, projectPath, accept) {
  const state = util.loadState();
  const key = Object.keys(state.projects || {})
    .find(k => path.resolve(k) === path.resolve(projectPath));
  const proj = key ? state.projects[key] : null;
  if (!proj || !proj.teamSuggestion) throw new Error('no pending team suggestion for this project');
  const s = proj.teamSuggestion;
  if (accept) {
    const link = await linkProject(config, key, s.teamId, s.teamName);
    delete proj.teamSuggestion;
    util.saveState(state);
    return link;
  }
  proj.teamSuggestionDismissed = s.repoUrl; // this remote, never again
  delete proj.teamSuggestion;
  util.saveState(state);
  return null;
}

// One team-sync pass over every linked, unpaused project. Returns the project
// keys whose teamEntries changed (their context blocks need a re-render).
// Never throws on a per-project failure: team sync is best-effort on top of
// local sync, and one bad project or a network blip must not break the rest.
async function syncTeams(opts = {}) {
  const config = util.getConfig();
  if (!isConfigured(config)) return { synced: [], changed: [], errors: [] };
  let creds;
  try {
    creds = await getAccessToken(config);
  } catch (err) {
    return { synced: [], changed: [], errors: [`auth: ${err.message}`] };
  }
  if (!creds) return { synced: [], changed: [], errors: [] };

  const state = util.loadState();
  let suggested = [];
  try {
    // Before the per-project pass, so a just-auto-linked project syncs now.
    suggested = await detectAutoLinks(config, creds, state);
  } catch (err) {
    // Best-effort like everything else here; a feed of suggestions can wait.
  }
  const synced = [];
  const changed = [];
  const errors = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (opts.project && path.resolve(opts.project) !== path.resolve(key)) continue;
    if (util.isProjectOff(key, config)) continue;
    const link = loadTeamLink(key);
    if (!link || !link.projectId) continue;
    try {
      if (!Array.isArray(proj.events)) proj.events = [];
      await pushProject(config, creds, key, proj, link);
      const pulled = await pullProject(config, creds, proj, link);
      synced.push(key);
      if (pulled > 0) {
        proj.dirty = true; // the next injection pass rewrites this project's block
        changed.push(key);
      }
    } catch (err) {
      // A membership/RLS refusal here almost always means the project carries
      // a team.json (often committed by a teammate) for a team this account
      // isn't in — say so, instead of leaving a bare backend error.
      const hint = /security|not a member/i.test(err.message)
        ? ` — this project's ${memorydb.DIR_NAME}/team.json points at a team you're not a member of; join it or run \`membridge team unlink\` here`
        : '';
      errors.push(`${key}: ${err.message}${hint}`);
    }
  }
  if (synced.length || suggested.length) {
    if (synced.length) state.teamLastSync = new Date().toISOString();
    util.saveState(state);
  }
  return { synced, changed, errors, suggested };
}

module.exports = {
  isConfigured, backend, webUrl,
  signup, login, clearCredentials, loadCredentials, getAccessToken,
  createTeam, joinTeam, listTeams, linkProject, unlinkProject, loadTeamLink, repoUrl,
  parseInviteToken, inviteUrl, createInvite, revokeInvite, join,
  listMembers, teamFeed, projectStats,
  removeMember, setRole, renameTeam, rotateInvite, leaveTeam,
  archiveProject, unarchiveProject,
  detectAutoLinks, resolveSuggestion,
  syncTeams, credentialsPath, teamFilePath,
};
