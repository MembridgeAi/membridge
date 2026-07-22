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
const teampins = require('./teampins');
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
// E2E identity bootstrap (encryption client slice, Task 4). Pure by
// injection: `deps` carries { keychain, teamcrypto, uploadPubkey } so tests
// run offline against fakes and the real modules are only bound at the call
// site. NOT wired into syncTeams yet — that is Task 6; nothing on the live
// sync path calls this, so flag-off behavior is untouched.
// ---------------------------------------------------------------------------
const PRIVKEY_ACCOUNT = 'membridge.box.privatekey';
const PUBKEY_ACCOUNT = 'membridge.box.publickey';

// Ensure this machine has a box keypair and the backend has its public half.
// Fail-closed throughout: missing libsodium, missing keychain, missing creds,
// or a keychain that will not persist the key all return null, and callers
// skip encryption and keep plaintext sync exactly as-is.
//
// Both key halves are stored because teamcrypto has no derive-public-from-
// private primitive (and growing its API is out of scope here). A half-
// missing pair — an interrupted first run — self-heals by regenerating:
// nothing is sealed to the old key in this slice, so replacement is safe,
// and the upsert on user_id makes the re-upload idempotent.
async function ensureIdentity(creds, deps) {
  const { keychain, teamcrypto, uploadPubkey } = deps;
  if (!teamcrypto.available() || !keychain.available()) return null;
  if (!creds || !creds.userId) return null;
  const privateKey = keychain.load(PRIVKEY_ACCOUNT);
  const publicKey = privateKey ? keychain.load(PUBKEY_ACCOUNT) : null;
  if (privateKey && publicKey) {
    // Self-heal: re-upsert the pubkey on EVERY call (idempotent merge on
    // user_id). A locally-persisted pair whose first upload failed — e.g.
    // the keypair was generated before the backend had 009's table — would
    // otherwise never publish, and the team key could never seal to us.
    await uploadPubkey({ user_id: creds.userId, public_key: publicKey });
    return { publicKey, privateKey };
  }
  await teamcrypto.ready();
  const kp = teamcrypto.genKeypair();
  // Persist before upload: a pubkey the backend knows but whose private half
  // this machine failed to keep would be an identity nobody can ever use.
  if (!keychain.store(PRIVKEY_ACCOUNT, kp.privateKey)) return null;
  if (!keychain.store(PUBKEY_ACCOUNT, kp.publicKey)) return null;
  await uploadPubkey({ user_id: creds.userId, public_key: kp.publicKey });
  return kp;
}

// Team-key handling (encryption client slice, Task 5). Same injection
// convention as ensureIdentity: deps carries { teamId, teamcrypto,
// fetchMySealedRow, fetchMemberPubkeys, insertSealedRows, cache? } so every
// path tests offline. Two deps beyond the plan's list, both deliberate:
//   • teamId — the inserted team_keys rows carry it, so the resolver must
//     know which team its closures are bound to.
//   • cache — an optional caller-owned Map keyed `${teamId}|${epoch}`. The
//     "cache for one sync run" lifetime is expressed by injection (Task 6
//     creates one Map per pass), not by hidden module state; a (team, epoch)
//     key is immutable, so any lifetime the caller picks is safe.
// NOT wired into push/pull yet (Task 6); membership-change rotation (minting
// a new epoch) is deferred per the plan.
//
// PULL-side resolution: my sealed row for the epoch exists -> unseal it (null
// on any unseal failure — fail-closed, and failures are never cached). No row
// -> null, full stop. Pull NEVER mints: an epoch this member was never sealed
// into is unreadable by design, and minting here would fork the team key.
async function resolveTeamKey(identity, epoch, deps) {
  const { teamId, teamcrypto, fetchMySealedRow, cache } = deps;
  if (!teamcrypto.available()) return null;
  if (!identity || !identity.publicKey || !identity.privateKey) return null;
  const cacheKey = `${teamId}|${epoch}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
  const row = await fetchMySealedRow(epoch);
  await teamcrypto.ready();
  if (!row || !row.sealed_team_key) return null;
  const teamKey = teamcrypto.unsealTeamKey(row.sealed_team_key, identity.publicKey, identity.privateKey);
  if (!teamKey) return null;
  if (cache) cache.set(cacheKey, teamKey);
  return teamKey;
}

// PUSH-side resolution (E2E completion Task 3): discover the current epoch
// from the team-wide key rows (013 widens their visibility to all members),
// rotate when membership shrank, join-seal members missing at the current
// epoch, and gate every seal target through the TOFU pin store. Returns
// { teamKey, epoch } or null (fail-closed — the caller skips the push).
//
// Race rule: a mint is only a CANDIDATE. After inserting (ignore-duplicates
// on the (team, epoch, member) PK), the authoritative answer is whatever my
// own read-back row unseals to — if a concurrent minter won, that is THEIR
// key sealed to me, and their key is the team key.
async function resolveCurrentTeamKey(identity, deps) {
  const { teamId, userId, teamcrypto, cache, pins } = deps;
  if (!teamcrypto.available()) return null;
  if (!identity || !identity.publicKey || !identity.privateKey) return null;
  const cacheKey = `${teamId}|current`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
  await teamcrypto.ready();

  const rows = (await deps.fetchTeamKeyRows()) || [];
  const members = (await deps.fetchMembers()) || [];
  const memberIds = new Set(members.map(m => m.user_id));

  // TOFU gate — every pass, not only when sealing, so a server-side key swap
  // is detected continuously, not just at the next membership change.
  const nameById = new Map(members.map(m => [m.user_id, m.display_name || '']));
  const fetched = ((await deps.fetchMemberPubkeys()) || [])
    .map(r => ({ ...r, display_name: nameById.get(r.user_id) || '' }));
  const gate = pins.check(pins.load(), fetched, new Date().toISOString());
  pins.save(gate.pins);
  if (gate.alerts.length && deps.onAlert) deps.onAlert(gate.alerts);
  const allowed = gate.allowed.filter(m => memberIds.has(m.user_id));

  const sealRows = (teamKey, epoch, targets) => targets.map(m => ({
    team_id: teamId,
    epoch,
    member_user_id: m.user_id,
    sealed_team_key: teamcrypto.sealTeamKey(teamKey, m.public_key),
  }));

  const mint = async epoch => {
    const candidate = teamcrypto.genTeamKey();
    const batch = sealRows(candidate, epoch, allowed);
    if (batch.length) await deps.insertSealedRows(batch);
    const mine = await deps.fetchMySealedRow(epoch);
    if (!mine || !mine.sealed_team_key) return null;
    const teamKey = teamcrypto.unsealTeamKey(mine.sealed_team_key, identity.publicKey, identity.privateKey);
    return teamKey ? { teamKey, epoch } : null;
  };

  let result = null;
  const maxEpoch = rows.reduce((m, r) => Math.max(m, Number(r.epoch) || 0), 0);
  if (!maxEpoch) {
    result = await mint(1);
  } else {
    const curRows = rows.filter(r => Number(r.epoch) === maxEpoch);
    if (curRows.some(r => !memberIds.has(r.member_user_id))) {
      // Membership shrank: rotate. New content moves to a fresh key the
      // removed member never receives; old epochs stay readable on purpose.
      result = await mint(maxEpoch + 1);
    } else {
      const mine = curRows.find(r => r.member_user_id === userId && r.sealed_team_key);
      const teamKey = mine
        ? teamcrypto.unsealTeamKey(mine.sealed_team_key, identity.publicKey, identity.privateKey)
        : null;
      if (teamKey) {
        result = { teamKey, epoch: maxEpoch };
        // Join-seal: hand the current key to pinned members not yet sealed at
        // this epoch. Best-effort — a failure must not cost this pass's push.
        const missing = allowed.filter(m => !curRows.some(r => r.member_user_id === m.user_id));
        if (missing.length) {
          try {
            await deps.insertSealedRows(sealRows(teamKey, maxEpoch, missing));
          } catch (e) {
            util.log(`team encrypt: join-seal failed (${e.message}) — retrying next pass`);
          }
        }
      }
      // No row for me, or unseal failed: fail closed and wait — a teammate's
      // pass join-seals me; minting over a live epoch would fork the key.
    }
  }
  if (cache && result) {
    cache.set(cacheKey, result);
    // Pull-side lookups of this epoch reuse the resolution.
    cache.set(`${teamId}|${result.epoch}`, result.teamKey);
  }
  return result;
}

// One log line per condition per pass — crypto fallbacks repeat per team and
// per row, and the log must say "this pass degraded" without scrolling.
function warnOnce(ctx, key, msg) {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  util.log(msg);
}

// The team-key resolver deps for one team, bound to real REST reads/writes.
// Built once per project in syncTeams and shared by the push (current-key
// resolution) and pull (per-row epoch) sides, so both hit the same per-pass
// cache. Pins are the real teampins store; alerts land on the ctx (state
// surfacing happens in syncTeams) and log once per member per pass.
function mkTeamKeyDeps(config, creds, teamId, ctx) {
  return {
    teamId,
    userId: creds.userId,
    teamcrypto: ctx.teamcrypto,
    cache: ctx.cache,
    pins: { load: teampins.load, save: teampins.save, check: teampins.check },
    onAlert: alerts => {
      ctx.keyAlerts = (ctx.keyAlerts || []).concat(alerts);
      for (const a of alerts) {
        warnOnce(ctx, `pin:${a.user_id}`,
          `team encrypt: KEY CHANGE for ${a.name || a.user_id} — key withheld until verified with \`membridge team trust\``);
      }
    },
    fetchMySealedRow: async epoch => {
      const rows = await rest(config, creds, 'GET',
        `team_keys?team_id=eq.${teamId}&epoch=eq.${epoch}` +
        `&member_user_id=eq.${creds.userId}&select=sealed_team_key`);
      return rows && rows[0] ? rows[0] : null;
    },
    // Team-wide key rows (013 widens SELECT to every member): who is sealed
    // into which epoch. sealed_team_key rides along but only my own rows'
    // blobs are usable — that is the crypto, not the policy.
    fetchTeamKeyRows: async () =>
      await rest(config, creds, 'GET',
        `team_keys?team_id=eq.${teamId}&select=epoch,member_user_id,sealed_team_key`) || [],
    fetchMembers: async () =>
      await rpc(config, creds, 'team_members_list', { p_team: teamId }) || [],
    fetchMemberPubkeys: async () => {
      const members = await rpc(config, creds, 'team_members_list', { p_team: teamId });
      const ids = (members || []).map(m => m.user_id);
      if (!ids.length) return [];
      return await rest(config, creds, 'GET',
        `member_pubkeys?user_id=in.(${ids.join(',')})&select=user_id,public_key`) || [];
    },
    // ignore-duplicates on the (team, epoch, member) PK: concurrent minters
    // race safely — losers detect the winner via read-back (resolveCurrentTeamKey).
    insertSealedRows: rows => (rows.length
      ? rest(config, creds, 'POST', 'team_keys?on_conflict=team_id,epoch,member_user_id', rows,
          { Prefer: 'resolution=ignore-duplicates,return=minimal' })
      : null),
  };
}

// Pure row-level encryption for push. No team key -> the EXACT same row
// object back, so the hatch-off wire format cannot drift even by key order.
// With a key: the seven content fields are JSON-serialized and secretbox-
// encrypted by teamcrypto; ciphertext/nonce/key_epoch ride ALONGSIDE the
// untouched plaintext fields (dual-write) until the coordinated cutover.
// deps.plaintextOff IS that cutover (E2E completion Task 5): every content
// column ships null — routing metadata (project/author/ts/source/session)
// stays so upserts and threading keep working, and legacy readers see
// "nothing shared" rather than garbage.
function encryptRow(row, teamKey, epoch, deps) {
  if (!teamKey) return row;
  const { ciphertext, nonce } = deps.teamcrypto.encrypt({
    ask: row.ask, summary: row.summary, goal: row.goal,
    decisions: row.decisions, gotchas: row.gotchas,
    files: row.files, changes: row.changes,
  }, teamKey);
  const out = { ...row, ciphertext, nonce, key_epoch: epoch };
  if (deps.plaintextOff) {
    out.ask = null; out.goal = null; out.decisions = null; out.gotchas = null;
    out.summary = null; out.files = null; out.changes = null;
  }
  return out;
}

// Build ONE plaintext memory_entries row from a local entry. `share` decides
// whether the verbatim prompt (ask/goal) rides along — the caller passes the
// isShared() result (push) or an explicit boolean (reshare). Non-prompt fields
// ship regardless. Mirrors the shape the backend upserts on
// (project_id, author_id, ts, source).
function entryToRow(e, projectId, creds, share, regexes) {
  const scrub = (text, n) => (text ? digest.clip(digest.redactText(text, regexes), n) : text);
  return {
    project_id: projectId,
    author_id: creds.userId,
    author_name: creds.displayName,
    ts: e.ts,
    source: e.source,
    session: e.session || null,
    ask: share ? scrub(e.ask, 400) : null,
    goal: share ? scrub(e.goal, 200) : null,
    decisions: e.decisions ? scrub(e.decisions, 240) : null,
    gotchas: e.gotchas ? scrub(e.gotchas, 240) : null,
    files: e.files,
    changes: Array.isArray(e.changes) && e.changes.length ? e.changes.map(c => ({ ...c, note: scrub(c.note, 80) })) : null,
    summary: e.summary ? scrub(e.summary, 300) : null,
  };
}

// POST a batch of memory_entries rows, degrading gracefully when the backend
// predates one of the optional columns (PGRST204): drop that column and retry
// until the insert lands. `prefer` selects insert-vs-overwrite semantics:
//   'resolution=ignore-duplicates,return=minimal' → normal push (never clobber)
//   'resolution=merge-duplicates,return=minimal'  → reshare (overwrite in place)
// `protect` names columns that must NOT be dropped: a ciphertext-only push
// (plaintextOff) that loses its ciphertext column would upload contentless
// rows, so it throws instead — entries are held until the backend migrates.
async function upsertEntries(config, creds, rows, prefer, protect) {
  let attempt = rows;
  for (;;) {
    try {
      await rest(config, creds, 'POST', 'memory_entries?on_conflict=project_id,author_id,ts,source', attempt, { Prefer: prefer });
      return;
    } catch (err) {
      const m = /'(summary|goal|decisions|gotchas|changes|ciphertext|nonce|key_epoch)' column/i.exec(err.message);
      if (!m) throw err;
      const drop = m[1];
      if (protect && protect.includes(drop)) {
        throw new Error(`backend lacks the ${drop} column required for ciphertext-only push — apply migrations 009/013 (entries held)`);
      }
      attempt = attempt.map(({ [drop]: _omit, ...bare }) => bare);
    }
  }
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
// Single source of truth for "does this session's verbatim prompt leave the
// machine?". Per-session (proj.sharedSessions), default off. Legacy honor
// window: a project that has NEVER been touched by the per-session UI (no
// sharedSessions array at all) still respects the old global config.team
// .sharePrompts flag, so pre-migration users keep their current behavior until
// they flip any per-session toggle.
function isShared(config, proj, sessionId) {
  if (!sessionId) return false;
  const list = proj && proj.sharedSessions;
  if (Array.isArray(list)) return list.includes(sessionId);
  return (((config && config.team) || {}).sharePrompts === true);
}

// `crypto` (optional): { teamKey, epoch, teamcrypto, required } from the
// syncTeams wiring, or null for the explicit-plaintext (encrypt:false) push.
// `required` is the fail-closed switch (E2E completion Task 4): with it set,
// no team key or an encrypt error means the affected entries are HELD — the
// cursor only ever advances past batches that actually uploaded, so held
// entries retry next pass. Plaintext is never the fallback when encryption
// is required; it IS the path only under the explicit escape hatch.
async function pushProject(config, creds, projectPath, proj, link, crypto) {
  const cursor = proj.teamPushTs || '';
  const entries = memorydb.buildEntries(projectPath, proj, config)
    .filter(e => e.ts > cursor);
  if (!entries.length) return 0;
  if (crypto && crypto.required && !crypto.teamKey) return 0;
  // buildEntries already redacts ask and summary; re-run the same pipeline at
  // the network boundary as defense in depth — nothing leaves the machine
  // without a final pass, even if a future caller hands in raw text.
  const regexes = digest.compileRedactions(config);
  // Verbatim prompts are the most sensitive field in an entry: they leave the
  // machine only when the user opts in per session (isShared, above), with a
  // legacy fallback to config.team.sharePrompts for projects untouched by the
  // per-session UI. Summary and files upload either way.
  // TODO(privacy): existing rows predate the gate — whether to backfill or
  // scrub already-uploaded asks is a product decision, not made here.
  let pushed = 0;
  for (let i = 0; i < entries.length; i += PUSH_BATCH) {
    const batch = entries.slice(i, i + PUSH_BATCH);
    const plainRows = batch
      .map(e => entryToRow(e, link.projectId, creds, isShared(config, proj, e.session), regexes));
    // Dual-write: add ciphertext/nonce/key_epoch next to the plaintext
    // fields. An encrypt failure under `required` HOLDS this batch and the
    // rest (break — cursor stays at the last uploaded batch); without
    // `required` (explicit hatch) it falls back to this batch's plaintext.
    let rows = plainRows;
    if (crypto && crypto.teamKey) {
      try {
        rows = plainRows.map(r => encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto, plaintextOff: crypto.plaintextOff }));
      } catch (err) {
        if (crypto.required) {
          util.log(`team encrypt: encrypt failed (${err.message}) — batch held for next pass`);
          break;
        }
        util.log(`team encrypt: encrypt failed (${err.message}) — pushing plaintext for this batch`);
        rows = plainRows;
      }
    }
    await upsertEntries(config, creds, rows, 'resolution=ignore-duplicates,return=minimal',
      crypto && crypto.plaintextOff ? ['ciphertext', 'nonce', 'key_epoch'] : null);
    pushed += rows.length;
    // Advance only past what actually uploaded, batch by batch.
    proj.teamPushTs = batch[batch.length - 1].ts;
  }
  return pushed;
}

// PostgREST's error for a `select=` column the backend doesn't have — e.g.
// `column memory_entries.goal does not exist` (unquoted/quoted column name
// both match). Distinct from the POST PGRST204 shape (`'<col>' column ...`)
// matched above, but the same idea: recover instead of failing the pull.
const SELECT_COLUMN_MISSING_RX = /column\s+(?:memory_entries\.)?"?'?(\w+)'?"?\s+does not exist/i;

// Optional select columns a pre-migration backend may be missing. Every
// entry here has a safe local default when absent, so dropping one from the
// select list and retrying degrades gracefully instead of losing the pull.
// The 009 ciphertext columns belong here too: absent, the pull simply keeps
// reading plaintext.
const OPTIONAL_PULL_COLUMNS = ['goal', 'decisions', 'gotchas', 'changes', 'ciphertext', 'nonce', 'key_epoch'];

// `teamCrypto` (optional, Task 6 Part B): { ctx, keyDeps } — the pass-level
// crypto context and this team's resolveTeamKey deps, shared with the push
// side so both use one identity and one per-pass key cache. Null = plaintext
// pull, byte-identical to before.
async function pullProject(config, creds, proj, link, teamCrypto) {
  const cursor = proj.teamPullTs || '1970-01-01T00:00:00.000Z';
  let selectCols = ['author_name', 'ts', 'source', 'session', 'ask',
    'goal', 'decisions', 'gotchas', 'summary', 'files', 'changes',
    'ciphertext', 'nonce', 'key_epoch', 'created_at'];
  let rows;
  for (;;) {
    const q = `memory_entries?project_id=eq.${link.projectId}` +
      `&author_id=neq.${creds.userId}` +
      `&created_at=gt.${encodeURIComponent(cursor)}` +
      `&order=created_at.asc&limit=${PULL_LIMIT}` +
      `&select=${selectCols.join(',')}`;
    try {
      rows = await rest(config, creds, 'GET', q);
      break;
    } catch (err) {
      const m = SELECT_COLUMN_MISSING_RX.exec(err.message);
      const col = m && m[1];
      // Only ever drop one of the known-optional columns — an unrelated
      // missing-column error (or one on a required column) must still throw,
      // so team sync doesn't silently pull nothing forever.
      if (!col || !OPTIONAL_PULL_COLUMNS.includes(col) || !selectCols.includes(col)) throw err;
      selectCols = selectCols.filter(c => c !== col);
    }
  }
  if (!rows || !rows.length) return 0;
  const existing = proj.teamEntries || [];
  const seen = new Set(existing.map(e => `${e.author}|${e.ts}|${e.source}`));
  for (const r of rows) {
    const k = `${r.author_name}|${r.ts}|${r.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Decrypt-on-pull: when the row carries ciphertext, the decrypted payload
    // IS the content — the row's plaintext columns are the dual-write copy
    // for old clients and could diverge or be tampered server-side. Under
    // `required` (encryption on — the default), a row that will not decrypt
    // renders OPAQUE (null content + undecryptable flag): falling back to
    // server-controlled plaintext would let a hostile server force a silent
    // downgrade by corrupting ciphertext. Only the explicit encrypt:false
    // hatch (teamCrypto == null) or a non-required context reads plaintext.
    // A pull never throws for a crypto reason.
    let content = r;
    let undecryptable = false;
    if (teamCrypto && r.ciphertext && r.nonce) {
      const warnCtx = teamCrypto.ctx || (teamCrypto._warn = teamCrypto._warn || { warned: new Set() });
      let payload = null;
      if (teamCrypto.ctx && teamCrypto.keyDeps) {
        try {
          const teamKey = await resolveTeamKey(
            teamCrypto.ctx.identity, r.key_epoch || 1, teamCrypto.keyDeps);
          payload = teamKey
            ? teamCrypto.ctx.teamcrypto.decrypt(r.ciphertext, r.nonce, teamKey)
            : null;
        } catch (err) {
          payload = null;
          warnOnce(warnCtx, `pull:${link.teamId || ''}:err`,
            `team encrypt: decrypt on pull failed (${err.message})`);
        }
      }
      if (payload) {
        content = { ...r, ...payload };
      } else if (teamCrypto.required) {
        undecryptable = true;
        content = { ask: null, goal: null, decisions: null, gotchas: null, summary: null, files: [], changes: null };
        warnOnce(warnCtx, `pull:${link.teamId || ''}`,
          'team encrypt: cannot decrypt a pulled row — rendering it opaque (fail-closed)');
      } else {
        warnOnce(warnCtx, `pull:${link.teamId || ''}`,
          'team encrypt: cannot decrypt a pulled row — using its plaintext columns');
      }
    }
    existing.push({
      author: r.author_name,
      ts: r.ts,
      source: r.source,
      // teamInjectSlice dedupes by (author, session) when present, falling
      // back to (author, source) only for rows pushed before this field
      // existed — carry it through so a teammate's distinct sessions on the
      // same tool don't collapse into just the newest one.
      session: r.session || null,
      ask: content.ask,
      goal: content.goal || null,
      decisions: content.decisions || null,
      gotchas: content.gotchas || null,
      summary: content.summary || null,
      files: Array.isArray(content.files) ? content.files : [],
      changes: Array.isArray(content.changes) ? content.changes : null,
      ...(undecryptable ? { undecryptable: true } : {}),
    });
  }
  existing.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  proj.teamEntries = existing.slice(-MAX_TEAM_ENTRIES);
  proj.teamPullTs = rows[rows.length - 1].created_at;
  return rows.length;
}

// Re-push ONE session's rows with the verbatim prompt forced on (share=true,
// backfill) or off (share=false, scrub). Overwrites already-synced rows via
// merge-duplicates and reuses encryptRow, so encrypted teams stay encrypted.
// Resolves creds/link/team-key itself unless the caller injects them (tests).
async function reshareSession(config, projectPath, sessionId, share, opts = {}) {
  const creds = opts.creds || loadCredentials();
  if (!creds) return { ok: false, error: 'not logged in' };
  const key = path.resolve(projectPath);
  const link = opts.link || loadTeamLink(key);
  if (!link || !link.projectId) return { ok: true, unlinked: true };

  const state = util.loadState();
  const proj = (state.projects || {})[key] || (state.projects || {})[projectPath];
  if (!proj) return { ok: false, error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];

  const rowsSrc = memorydb.buildEntries(projectPath, proj, config).filter(e => (e.session || null) === sessionId);
  if (!rowsSrc.length) return { ok: true, count: 0 };

  const regexes = digest.compileRedactions(config);
  const encryptedTeam = (((config || {}).team || {}).encrypt !== false);
  let crypto = opts.crypto;
  if (crypto === undefined) crypto = await resolveOneShotCrypto(config, creds, link, opts);

  // Fail-closed on an encrypted team we can't encrypt for. A merge-duplicates
  // upsert only overwrites the columns it carries, so a plaintext-only row would
  // (a) leave any prior ciphertext — still holding the un-scrubbed prompt —
  // untouched, and (b) silently downgrade the row out of E2E. Refuse and let the
  // caller surface it, rather than half-updating a privacy control. (When the
  // caller injects opts.crypto directly — e.g. tests — that key is used as-is.)
  if (encryptedTeam && !(crypto && crypto.teamKey)) {
    return { ok: false, error: 'encryption key unavailable — could not update sharing; try again' };
  }

  for (let i = 0; i < rowsSrc.length; i += PUSH_BATCH) {
    const plainRows = rowsSrc.slice(i, i + PUSH_BATCH).map(e => entryToRow(e, link.projectId, creds, !!share, regexes));
    let rows = plainRows;
    if (crypto && crypto.teamKey) {
      try { rows = plainRows.map(r => encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto, plaintextOff: crypto.plaintextOff })); }
      catch (err) {
        // On an encrypted team, do NOT fall back to plaintext — that would strand
        // stale ciphertext and downgrade E2E. Abort so the caller can retry.
        if (encryptedTeam) return { ok: false, error: `encryption failed — could not update sharing (${err.message})` };
        util.log(`team encrypt: reshare encrypt failed (${err.message}) — plaintext`);
        rows = plainRows;
      }
    }
    await upsertEntries(config, creds, rows, 'resolution=merge-duplicates,return=minimal',
      crypto && crypto.plaintextOff ? ['ciphertext', 'nonce', 'key_epoch'] : null);
  }
  return { ok: true, count: rowsSrc.length };
}

// One pass-scoped crypto context: identity from the keychain, a fresh
// per-pass key cache, and the warnOnce dedupe set. Shared by syncTeams and
// the dashboard feed (decryptTeamRows). Null when encryption is explicitly
// off or the identity is unavailable — callers fail closed on null.
// opts.cryptoDeps MERGES over the real deps (it does not replace them):
// tests inject only { keychain, teamcrypto } and keep the real REST pubkey
// upsert, so the wiring under test is the shipping wiring.
async function buildCryptoContext(config, creds, opts = {}) {
  if ((((config || {}).team || {}).encrypt === false)) return null;
  try {
    const deps = {
      keychain: require('./keychain'),
      teamcrypto: require('./teamcrypto'),
      uploadPubkey: row => rest(config, creds, 'POST',
        'member_pubkeys?on_conflict=user_id', [row],
        { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      ...(opts.cryptoDeps || {}),
    };
    const identity = await ensureIdentity(creds, deps);
    if (identity) {
      return { identity, teamcrypto: deps.teamcrypto, cache: new Map(), warned: new Set() };
    }
    util.log('team encrypt: no identity (libsodium or keychain unavailable) — team push paused (fail-closed)');
  } catch (err) {
    util.log(`team encrypt: identity bootstrap failed (${err.message}) — team push paused (fail-closed)`);
  }
  return null;
}

// Decrypt team_feed rows for local rendering (the feed rewrite: the server
// stops being trusted with readable text, so the desktop decrypts). Fail-
// closed mirror of the pull path: a ciphertext row either decrypts or comes
// back with null content + undecryptable:true — never its server-controlled
// plaintext columns. Rows without ciphertext (legacy/pre-cutover) pass
// through untouched. ctx may be null (identity unavailable): every
// ciphertext row is then opaque. Callers under the explicit encrypt:false
// hatch skip this function entirely.
async function decryptTeamRows(config, creds, teamId, rows, ctx) {
  const keyDeps = ctx && teamId ? mkTeamKeyDeps(config, creds, teamId, ctx) : null;
  const warnCtx = ctx || { warned: new Set() };
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.ciphertext || !r.nonce) { out.push(r); continue; }
    let payload = null;
    if (keyDeps) {
      try {
        const teamKey = await resolveTeamKey(ctx.identity, r.key_epoch || 1, keyDeps);
        payload = teamKey ? ctx.teamcrypto.decrypt(r.ciphertext, r.nonce, teamKey) : null;
      } catch (err) {
        payload = null;
      }
    }
    if (payload) {
      out.push({ ...r, ...payload });
    } else {
      warnOnce(warnCtx, `feed:${teamId || ''}`,
        'team encrypt: cannot decrypt a feed row — rendering it opaque (fail-closed)');
      out.push({
        ...r,
        ask: null, goal: null, decisions: null, gotchas: null, summary: null,
        files: [], changes: null, undecryptable: true,
      });
    }
  }
  return out;
}

// Human-verifiable key fingerprints (`membridge team fingerprint`): mine from
// the keychain, teammates' from the TOFU pin store. Two humans comparing
// these over a trusted channel (call, in person) is the authenticity check
// the pins enforce; `team trust` is the only way to accept a changed key.
async function fingerprintReport(opts = {}) {
  const teamcrypto = (opts.cryptoDeps && opts.cryptoDeps.teamcrypto) || require('./teamcrypto');
  const keychain = (opts.cryptoDeps && opts.cryptoDeps.keychain) || require('./keychain');
  if (!teamcrypto.available()) return { ok: false, error: 'encryption unavailable (libsodium missing)' };
  await teamcrypto.ready();
  const myPub = keychain.available() ? keychain.load(PUBKEY_ACCOUNT) : null;
  const pins = teampins.load();
  return {
    ok: true,
    mine: myPub ? teamcrypto.fingerprint(myPub) : null,
    members: Object.entries(pins).map(([userId, pin]) => ({
      userId,
      name: pin.name || '',
      fingerprint: teamcrypto.fingerprint(pin.publicKey),
      firstSeen: pin.firstSeen || null,
    })),
  };
}

// Deliberate re-pin (`membridge team trust <user-id or name>`): refetch the
// member's published key and overwrite the pin, clearing any standing alert.
// This is the ONLY path that replaces a pinned key — sync never does — so a
// key-substitution attack requires tricking the human, not the software.
async function trustMember(config, needle, opts = {}) {
  const creds = await getAccessToken(config);
  if (!creds) return { ok: false, error: 'not logged in — run `membridge login` first' };
  const teamcrypto = (opts.cryptoDeps && opts.cryptoDeps.teamcrypto) || require('./teamcrypto');
  if (!teamcrypto.available()) return { ok: false, error: 'encryption unavailable (libsodium missing)' };
  await teamcrypto.ready();
  const teams = (await listTeams(config)) || [];
  const seen = new Map();
  for (const t of teams) {
    for (const m of (await rpc(config, creds, 'team_members_list', { p_team: t.team_id })) || []) {
      seen.set(m.user_id, m.display_name || '');
    }
  }
  const matches = [...seen.entries()].filter(([id, name]) => id === needle || name === needle);
  if (!matches.length) return { ok: false, error: `no teammate matching "${needle}"` };
  if (matches.length > 1) return { ok: false, error: `"${needle}" is ambiguous — use the user id` };
  const [userId, name] = matches[0];
  const rows = await rest(config, creds, 'GET',
    `member_pubkeys?user_id=in.(${userId})&select=user_id,public_key`) || [];
  if (!rows.length || !rows[0].public_key) {
    return { ok: false, error: `${name || userId} has not published a key yet` };
  }
  const pins = teampins.load();
  const prev = pins[userId] || null;
  teampins.save({
    ...pins,
    [userId]: {
      publicKey: rows[0].public_key,
      name: name || (prev && prev.name) || '',
      firstSeen: (prev && prev.firstSeen) || new Date().toISOString(),
    },
  });
  const state = util.loadState();
  if (Array.isArray(state.keyAlerts)) {
    state.keyAlerts = state.keyAlerts.filter(a => a.user_id !== userId);
    if (!state.keyAlerts.length) delete state.keyAlerts;
    util.saveState(state);
  }
  return {
    ok: true, userId, name,
    previous: prev ? teamcrypto.fingerprint(prev.publicKey) : null,
    current: teamcrypto.fingerprint(rows[0].public_key),
  };
}

// One-shot crypto resolution for an out-of-band reshare — mirrors the per-pass
// block in syncTeams, scoped to a single call. Fail-closed to null (plaintext)
// on any error, exactly like the sync path. opts.cryptoDeps injects fakes.
async function resolveOneShotCrypto(config, creds, link, opts = {}) {
  if ((((config || {}).team || {}).encrypt === false) || !link.teamId) return null;
  try {
    const ctx = await buildCryptoContext(config, creds, opts);
    if (!ctx) return null;
    const keyDeps = mkTeamKeyDeps(config, creds, link.teamId, ctx);
    const cur = await resolveCurrentTeamKey(ctx.identity, keyDeps);
    return cur ? { teamKey: cur.teamKey, epoch: cur.epoch, teamcrypto: ctx.teamcrypto,
      plaintextOff: (((config || {}).team || {}).plaintextOff === true) } : null;
  } catch (err) {
    util.log(`team encrypt: reshare key resolution failed (${err.message}) — plaintext`);
    return null;
  }
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

  // Encrypt-on-push, resolved ONCE per pass. Encryption is ON by default
  // (E2E completion Task 4): only the explicit team.encrypt === false hatch
  // restores plaintext sync. When encryption is on and unusable — no
  // libsodium, no keychain, no resolvable team key — the pass FAILS CLOSED:
  // pushes are held (cursor unmoved, retried next pass), the reason lands in
  // state.teamCryptoPaused for the dashboard/status to surface, and pulls
  // still run (rendering undecryptable rows opaque). Sync itself never
  // throws for a crypto reason. opts.cryptoDeps is the test seam — live
  // callers get the real keychain/teamcrypto and a REST pubkey upsert.
  const encryptOn = (((config || {}).team || {}).encrypt !== false);
  const cryptoCtx = encryptOn ? await buildCryptoContext(config, creds, opts) : null;
  let cryptoPausedReason = null;

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
      // Resolve this team's key (cached per pass across this team's
      // projects), through the same deps the pull side reuses. Any failure
      // logs once per team and pushes plaintext — the push itself must
      // never be lost to a key problem.
      let crypto = null;
      const keyDeps = cryptoCtx && link.teamId
        ? mkTeamKeyDeps(config, creds, link.teamId, cryptoCtx)
        : null;
      if (keyDeps) {
        try {
          const cur = await resolveCurrentTeamKey(cryptoCtx.identity, keyDeps);
          if (cur) {
            crypto = { teamKey: cur.teamKey, epoch: cur.epoch, teamcrypto: cryptoCtx.teamcrypto, required: true,
              plaintextOff: (((config || {}).team || {}).plaintextOff === true) };
          } else {
            warnOnce(cryptoCtx, link.teamId, `team encrypt: no team key for ${link.teamId} — push paused (fail-closed)`);
          }
        } catch (err) {
          warnOnce(cryptoCtx, link.teamId, `team encrypt: team key for ${link.teamId} failed (${err.message}) — push paused (fail-closed)`);
        }
      }
      if (encryptOn && !crypto) {
        // Fail-closed: no usable key means nothing leaves this pass. The
        // cursor is untouched, so held entries push on a later pass.
        cryptoPausedReason = 'encryption unavailable — team push paused until a key resolves';
        errors.push(`${key}: team push paused — encryption unavailable (fail-closed; set team.encrypt=false only if you accept plaintext sync)`);
      } else {
        await pushProject(config, creds, key, proj, link, crypto);
      }
      const pulled = await pullProject(config, creds, proj, link,
        encryptOn ? { ctx: cryptoCtx, keyDeps, required: true } : null);
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
  // Pause + pin-alert bookkeeping (dashboard/status surface these). Alerts
  // are recomputed each pass by the continuous TOFU gate, so a pass where the
  // gate ran and found nothing clears them; a pass with no crypto context at
  // all leaves the last known alerts standing.
  if (encryptOn) {
    if (cryptoPausedReason) state.teamCryptoPaused = cryptoPausedReason;
    else delete state.teamCryptoPaused;
    if (cryptoCtx && cryptoCtx.keyAlerts && cryptoCtx.keyAlerts.length) state.keyAlerts = cryptoCtx.keyAlerts;
    else if (cryptoCtx) delete state.keyAlerts;
  }
  if (synced.length) state.teamLastSync = new Date().toISOString();
  util.saveState(state);
  return { synced, changed, errors, suggested };
}

module.exports = {
  isConfigured, backend, webUrl,
  signup, login, clearCredentials, loadCredentials, getAccessToken,
  ensureIdentity, resolveTeamKey, resolveCurrentTeamKey, encryptRow, isShared,
  buildCryptoContext, decryptTeamRows, fingerprintReport, trustMember,
  createTeam, joinTeam, listTeams, linkProject, unlinkProject, loadTeamLink, repoUrl,
  parseInviteToken, inviteUrl, createInvite, revokeInvite, join,
  listMembers, teamFeed, projectStats,
  removeMember, setRole, renameTeam, rotateInvite, leaveTeam,
  archiveProject, unarchiveProject,
  detectAutoLinks, resolveSuggestion,
  syncTeams, reshareSession, credentialsPath, teamFilePath,
};
