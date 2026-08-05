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
const classify = require('./classify');
const digest = require('./digest');
const teampins = require('./teampins');
const repoRootLib = require('./repo-root');
const teamArchive = require('./team-archive');
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
// Wire caps: a teammate sees the same content the author's local view shows
// (full distilled brief, its verbatim headline, the whole shared prompt), so
// these are safety nets against pathological payloads, not display clipping —
// display is the client's job. Redaction always runs regardless.
const WIRE_SUMMARY_MAX = 4000;
const WIRE_HEADLINE_MAX = 160; // capture bounds headlines at 80; redaction can grow them
// Decisions/gotchas ride the wire at the same bound they are stored at
// (digest.NOTE_MAX) rather than a second number that could drift from it: a
// teammate must read the note the author's own app shows. They used to ship
// clipped at 240 while the summary beside them shipped at 4000. Change NOTES
// stay at 240 — those are per-file one-liners, not prose.
const WIRE_NOTE_MAX = digest.NOTE_MAX;
const nodeCrypto = require('crypto'); // content signatures for drift re-push (pushProject)

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
  // Create the file 0600 up front so the refresh token is never briefly world-
  // readable in the window between write and chmod. The `mode` option only
  // applies when the file is newly created, so keep the chmod to also tighten a
  // pre-existing file that an older MemBridge left at looser permissions.
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
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
    // Carry the status on the error: classifyAuthFailure needs to tell a
    // rejected session from a backend fault, and the body's message alone
    // cannot always say which (see the PostgREST note in rest()).
    throw Object.assign(new Error(msg), { status: res.status });
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

// ---------------------------------------------------------------------------
// OAuth request binding (audit F1).
//
// Without this the loopback callback is a token-injection sink. Any page the
// user visits can navigate the browser to
// http://127.0.0.1:7437/team/oauth/callback#access_token=<ATTACKER_JWT>, and
// every gate the daemon has still passes: Host really is 127.0.0.1, the CSRF
// gates are skipped because a navigation is a GET, and the callback page's own
// POST is genuinely same-origin with the right content type. loginWithTokens
// then verifies the token against the backend, which proves the token is
// AUTHENTIC and says nothing about whose it is, so the daemon overwrites
// credentials.json with the attacker's session.
//
// The fix is the standard one: a CSPRNG value minted when the sign-in STARTS,
// held only in this process, and required (and consumed) before any token is
// looked at. A navigation the daemon did not start carries no state it can
// guess, so it is refused.
//
// The state rides in redirect_to rather than only in the OAuth `state`
// parameter, because it has to come back to us whatever the provider echoes:
// Supabase owns the round trip to GitHub and makes no promise to hand an
// arbitrary `state` through to the redirect target. A value we put into our
// own callback URL always returns. It is sent as `state` too, so a backend
// that does echo it gives us the same value by both routes.
//
// In memory on purpose. A state that does not survive a daemon restart is
// correct: the browser leg it belongs to did not survive either.
// ---------------------------------------------------------------------------
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const oauthStates = new Map(); // state -> { expiresAt, verifier }

function pruneOAuthStates(now) {
  for (const [k, v] of oauthStates) if (v.expiresAt <= now) oauthStates.delete(k);
}

// Mints the state and, with it, the PKCE verifier/challenge pair. The verifier
// never leaves this process: it is what makes an intercepted auth code useless
// to anyone but the daemon that asked for it.
function issueOAuthState(now = Date.now()) {
  pruneOAuthStates(now);
  const state = nodeCrypto.randomBytes(32).toString('base64url');
  const verifier = nodeCrypto.randomBytes(32).toString('base64url');
  const challenge = nodeCrypto.createHash('sha256').update(verifier).digest('base64url');
  oauthStates.set(state, { expiresAt: now + OAUTH_STATE_TTL_MS, verifier });
  return { state, verifier, challenge };
}

// Returns the pending record, or null. Fails closed on every path, and deletes
// the entry on the FIRST lookup whatever the outcome, so a callback URL that
// is replayed a second time finds nothing. Absent, unknown, expired and
// already-consumed all land on the same null.
function consumeOAuthState(state, now = Date.now()) {
  pruneOAuthStates(now);
  const s = String(state || '');
  if (!s) return null;
  const rec = oauthStates.get(s);
  if (!rec) return null;
  oauthStates.delete(s);
  return rec.expiresAt > now ? rec : null;
}

// GitHub OAuth. The dashboard sends the browser through Supabase's /authorize
// and the redirect hands the session back to our loopback callback; the
// callback page forwards it here. The redirect target must be on the Supabase
// redirect-URL allowlist (Authentication -> URL Configuration), and note that
// redirect_to now carries a ?state= query string, so an allowlist entry
// pinned to the bare path rather than a wildcard needs widening. That is the
// one part of this flow no offline test can prove; verify a live sign-in.
//
// PKCE is requested (locked decision 1): flow_type=pkce makes GoTrue return a
// single-use auth code on the query string instead of tokens in the fragment,
// and the code is worthless without the verifier held above. That keeps the
// session out of the address bar and out of browser history. The implicit
// fragment remains handled in oauthCallbackPage as a fallback, because a
// GoTrue that ignores the challenge would otherwise leave users unable to sign
// in at all; that fallback is state-bound exactly the same way, so it closes
// the injection either way.
function oauthAuthorizeUrl(config, redirectTo) {
  const be = backend(config);
  if (!be) return null;
  const { state, challenge } = issueOAuthState();
  const back = new URL(redirectTo);
  back.searchParams.set('state', state);
  const u = new URL(`${be.url}/auth/v1/authorize`);
  u.searchParams.set('provider', 'github');
  u.searchParams.set('flow_type', 'pkce');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 's256');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_to', back.toString());
  return u.toString();
}

// Turn fragment tokens into the same stored credentials a password login
// writes. The access token is verified against the backend (not trusted as
// pasted) — /auth/v1/user only answers for a token this Supabase project
// actually issued, and it supplies the user id/email the credentials need.
async function loginWithTokens(config, accessToken, refreshToken, expiresIn) {
  const be = backend(config);
  if (!be) throw new Error('team sync is not available in this build (no backend baked in)');
  if (!accessToken || !refreshToken) throw new Error('the GitHub sign-in came back without tokens — try again');
  const res = await fetch(`${be.url}/auth/v1/user`, {
    headers: { apikey: be.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  const user = await res.json().catch(() => ({}));
  if (!res.ok || !user.id) {
    throw new Error(user.msg || user.error_description || user.message || 'could not verify the GitHub sign-in');
  }
  const displayName = oauthDisplayName(user);
  const creds = sessionToCredentials(
    { user, access_token: accessToken, refresh_token: refreshToken, expires_in: Number(expiresIn) || 3600 },
    displayName,
  );
  saveCredentials(creds);
  return creds;
}

// Display name for an OAuth account. GitHub carries full_name/user_name
// metadata instead of display_name, so fall through both before giving up on
// the email local part.
function oauthDisplayName(user) {
  const m = (user && user.user_metadata) || {};
  return m.display_name || m.full_name || m.user_name || String((user && user.email) || '').split('@')[0];
}

// The PKCE leg: trade the single-use auth code for a session, presenting the
// verifier that was minted with the state. The code arrives on the query
// string where a shoulder-surfer or a browser history entry can see it, and it
// is inert without this verifier, which never left the daemon.
async function exchangeOAuthCode(config, code, verifier) {
  const be = backend(config);
  if (!be) throw new Error('team sync is not available in this build (no backend baked in)');
  if (!code || !verifier) throw new Error('the sign-in came back without a code - try again');
  const data = await authRequest(be, 'token?grant_type=pkce', {
    auth_code: String(code), code_verifier: String(verifier),
  });
  if (!data.access_token || !data.user || !data.user.id) {
    throw new Error('could not complete the sign-in');
  }
  const creds = sessionToCredentials(data, oauthDisplayName(data.user));
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
    // PostgREST puts the reason in the body ("JWT expired") and the status
    // never reaches the message, so callers that must distinguish a dead
    // session from a backend fault get the status on the error itself.
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

async function rpc(config, creds, fn, args) {
  return rest(config, creds, 'POST', `rpc/${fn}`, args || {});
}

// ---------------------------------------------------------------------------
// Paused-session reporting. Team push fails closed on an expired JWT — which
// is right — but it used to do so with no trace beyond a line in the log, so a
// team could receive nothing for days while the dashboard header still read
// "Synced · Nh ago". These two helpers put a machine-readable reason in state
// for the UI; they change no sync behavior whatsoever.
//
// Only two outcomes are worth a user's attention, and they call for opposite
// responses: a dead session needs them to sign in (nothing resumes on its
// own), while an unreachable backend fixes itself and must never nag. Anything
// else — a 500, an RLS refusal — is deliberately left unclassified: a pill
// that cries wolf is a pill nobody reads.
// ---------------------------------------------------------------------------
const NET_ERR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
function classifyAuthFailure(err) {
  if (!err) return null;
  const msg = String(err.message || '');
  // Transient first: undici reports a dead network as a bare "fetch failed",
  // which carries no auth signal at all and must not be read as one.
  if (NET_ERR_CODES.has(String(err.code || '')) ||
      /fetch failed|network|socket hang up|econnrefused|enotfound|etimedout|timed out/i.test(msg)) {
    return 'backend-unreachable';
  }
  if (err.status === 401) return 'session-expired';
  if (/\bjwt\b|refresh token|invalid token|token (is )?(expired|revoked|invalid)|session (has )?expired|not logged in|unauthorized/i.test(msg)) {
    return 'session-expired';
  }
  return null;
}

// Record (or clear) the pause on the caller's state object. The caller owns
// the save: syncTeams writes its own in-memory copy at the end of the pass, so
// a helper that persisted independently would simply be clobbered by it.
// `since` survives a repeated failure with the same reason — how long the team
// has been getting nothing is the actionable part, and restarting that clock
// every pass would hide exactly the two-day outage this exists to surface.
function noteAuthPause(state, pause) {
  if (!state) return;
  try {
    if (!pause) { delete state.teamAuthPaused; return; }
    const prev = state.teamAuthPaused;
    state.teamAuthPaused = {
      reason: pause.reason,
      detail: pause.detail || '',
      since: (prev && prev.reason === pause.reason && prev.since) ? prev.since : new Date().toISOString(),
    };
  } catch (err) {
    // Best-effort reporting must never break a sync or a render.
  }
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
      } else if (mine && deps.deleteMyRows) {
        // Self-heal: I HAVE a sealed row but it won't open with my current
        // private key — my keypair rotated (new device / reset key store),
        // orphaning the seal. Nothing re-seals me while a (dead) row exists
        // (join-seal only targets members with none). Drop my own stale row so
        // a current key-holder re-seals THIS key to my new pubkey next pass —
        // recovering my history, not just future content. They must first
        // trust my changed key (`membridge team trust`); until then I stay
        // paused. Best-effort: a failed delete just leaves today's behavior.
        try {
          await deps.deleteMyRows([maxEpoch]);
          util.log('team encrypt: this device\'s key changed — dropped the stale sealed key so a teammate can re-share it. Ask a teammate to verify your new key (`membridge team trust <you>`) and sync, or run `membridge team rekey` if you own/admin the team.');
        } catch (e) {
          util.log(`team encrypt: could not drop stale sealed key (${e.message}) — a teammate re-share or \`membridge team rekey\` will fix it`);
        }
      }
      // No row for me (or just-dropped): fail closed and wait — a teammate's
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

// Multi-device key reconciliation — run once per team per sync pass. Converges
// the team toward: every trusted member holds a row THEY can open at every
// epoch. This is what makes a NEW DEVICE recover full encrypted history (not
// just new content) automatically and securely, across the whole platform.
// Two moves, both idempotent and safe:
//   1. Self-heal — delete MY OWN rows that won't open with my current key (a
//      rotated keypair / new device). RLS confines the delete to my own rows,
//      so this can never touch a teammate. Dropping them turns me back into
//      "missing", which a holder re-seals.
//   2. Re-seal — for every epoch I CAN open, seal it to every TOFU-trusted
//      member missing a row at that epoch (join-seal, generalized past just
//      the current epoch). A changed key is withheld until trusted, exactly
//      like the current-epoch path.
// Best-effort: any failure logs once and never breaks the sync pass. Reuses
// the per-pass cache/pins already threaded through deps.
async function reconcileTeamKeys(identity, deps) {
  const { userId, teamcrypto, pins } = deps;
  if (!teamcrypto.available() || !identity || !identity.publicKey || !identity.privateKey) return;
  try {
    await teamcrypto.ready();
    const rows = (await deps.fetchTeamKeyRows()) || [];
    if (!rows.length) return;
    const members = (await deps.fetchMembers()) || [];
    const memberIds = new Set(members.map(m => m.user_id));
    const nameById = new Map(members.map(m => [m.user_id, m.display_name || '']));
    const fetched = ((await deps.fetchMemberPubkeys()) || [])
      .map(r => ({ ...r, display_name: nameById.get(r.user_id) || '' }));
    const gate = pins.check(pins.load(), fetched, new Date().toISOString());
    pins.save(gate.pins);
    if (gate.alerts.length && deps.onAlert) deps.onAlert(gate.alerts);
    const allowed = gate.allowed.filter(m => memberIds.has(m.user_id));

    // Group rows by epoch (ignore rows for ex-members).
    const byEpoch = new Map();
    for (const r of rows) {
      if (!memberIds.has(r.member_user_id)) continue;
      if (!byEpoch.has(r.epoch)) byEpoch.set(r.epoch, []);
      byEpoch.get(r.epoch).push(r);
    }

    // 1. Self-heal: my own unopenable rows, across ALL epochs.
    const stale = [];
    for (const [epoch, ers] of byEpoch) {
      const mine = ers.find(r => r.member_user_id === userId && r.sealed_team_key);
      if (mine && !teamcrypto.unsealTeamKey(mine.sealed_team_key, identity.publicKey, identity.privateKey)) {
        stale.push(epoch);
      }
    }
    if (stale.length && deps.deleteMyRows) {
      try {
        await deps.deleteMyRows(stale);
        util.log(`team encrypt: this device's key changed — dropped ${stale.length} stale sealed key(s) so a teammate can re-share your history. A teammate verifies your new key (\`membridge team trust <you>\`) and syncs; or \`membridge team rekey\` if you own/admin the team.`);
      } catch (e) {
        util.log(`team encrypt: could not drop stale sealed keys (${e.message}) — needs the team_keys delete policy (migration 016) or \`membridge team rekey\``);
      }
    }
    const staleSet = new Set(stale);

    // 2. Re-seal: every epoch I can open → trusted members missing a row there.
    const reseal = [];
    for (const [epoch, ers] of byEpoch) {
      const mine = ers.find(r => r.member_user_id === userId && r.sealed_team_key && !staleSet.has(epoch));
      const teamKey = mine
        ? teamcrypto.unsealTeamKey(mine.sealed_team_key, identity.publicKey, identity.privateKey)
        : null;
      if (!teamKey) continue; // can't open this epoch → can't re-seal it
      const present = new Set(ers.map(r => r.member_user_id));
      for (const m of allowed) {
        if (m.user_id === userId || present.has(m.user_id)) continue;
        reseal.push({ team_id: deps.teamId, epoch, member_user_id: m.user_id,
          sealed_team_key: teamcrypto.sealTeamKey(teamKey, m.public_key) });
      }
    }
    if (reseal.length && deps.insertSealedRows) {
      try {
        await deps.insertSealedRows(reseal);
        util.log(`team encrypt: re-shared ${reseal.length} key(s) with member(s) on a new device`);
      } catch (e) {
        util.log(`team encrypt: re-share failed (${e.message}) — retrying next pass`);
      }
    }
  } catch (e) {
    util.log(`team encrypt: key reconciliation skipped (${e.message})`);
  }
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
    // Self-heal for a rotated key: drop MY OWN sealed rows at these epochs so a
    // current key-holder's join-seal re-seals the same key to my new pubkey
    // (the sealed rows are opaque, so only I — by failing to unseal — can tell
    // mine is stale). RLS lets a member delete only their own rows.
    deleteMyRows: epochs => (epochs.length
      ? rest(config, creds, 'DELETE',
          `team_keys?team_id=eq.${teamId}&member_user_id=eq.${creds.userId}` +
          `&epoch=in.(${epochs.join(',')})`, undefined, { Prefer: 'return=minimal' })
      : null),
  };
}

// The cutover default: ciphertext-only unless a member explicitly sets
// `team.plaintextOff: false` (the dual-write rollback hatch from the
// runbook). Dual-write was the migration window, not the steady state —
// defaulting ON is what makes the E2E badge truthful, and it only takes
// effect when a team key actually resolves, so plaintext-hatch teams
// (encrypt: false) never reach it.
function plaintextOffFor(config) {
  return (((config || {}).team || {}).plaintextOff !== false);
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
    headline: row.headline,
  }, teamKey);
  const out = { ...row, ciphertext, nonce, key_epoch: epoch };
  if (deps.plaintextOff) {
    out.ask = null; out.goal = null; out.decisions = null; out.gotchas = null;
    out.summary = null; out.files = null; out.changes = null; out.headline = null;
  }
  return out;
}

// Build ONE plaintext memory_entries row from a local entry. `share` decides
// whether the verbatim prompt (ask/goal) rides along — the caller passes the
// isShared() result (push) or an explicit boolean (reshare). Non-prompt fields
// ship regardless. Mirrors the shape the backend upserts on
// (project_id, author_id, ts, source).
// `projectPath` is optional and trailing so every existing caller keeps working
// untouched. When supplied, `files` and `changes[].file` — which are stored
// relative to the TRACKED project dir — ship as checkout-relative wire keys, so
// a teammate tracking a different monorepo depth, or working from a nested
// worktree, agrees on file identity (lib/repo-root.js, spec §7). Omitted →
// no translation, byte-identical output.
function entryToRow(e, projectId, creds, share, regexes, projectPath) {
  // A path outside any checkout has no cross-machine identity — wireKeyFor
  // returns null. Keep the original rather than shipping a null the receiver can
  // neither match nor render: untranslated is a miss, null is a broken row.
  const wire = p => {
    if (!projectPath || typeof p !== 'string' || !p) return p;
    return repoRootLib.wireKeyFor(path.resolve(projectPath, p)) || p;
  };
  // Returns null (never the falsy input itself) so a missing field serializes as
  // an explicit `goal: null` rather than `undefined`. JSON.stringify drops
  // undefined-valued keys, and a reshare batch that mixes goaled with goal-less
  // entries would then ship rows with different key sets — PostgREST rejects
  // that array with "All object keys must match".
  const scrub = (text, n) => (text ? digest.clip(digest.redactText(text, regexes), n) : null);
  // Bullet fields cross the wire with their line breaks intact, or a
  // teammate reads as a paragraph what was written as a list.
  const scrubBullets = (text, n) => (text ? digest.bulletClip(digest.redactText(text, regexes), n) : null);
  return {
    project_id: projectId,
    author_id: creds.userId,
    author_name: creds.displayName,
    ts: e.ts,
    source: e.source,
    session: e.session || null,
    // The verbatim prompt stays clipped by policy (its unclipped twin is
    // machine-local — a pinned invariant); summaries get full parity below.
    ask: share ? scrub(e.ask, 400) : null,
    goal: share ? scrub(e.goal, 200) : null,
    decisions: e.decisions ? scrubBullets(e.decisions, WIRE_NOTE_MAX) : null,
    gotchas: e.gotchas ? scrubBullets(e.gotchas, WIRE_NOTE_MAX) : null,
    files: Array.isArray(e.files) ? e.files.map(wire) : e.files,
    changes: Array.isArray(e.changes) && e.changes.length
      ? e.changes.map(c => ({ ...c, file: wire(c.file), note: scrub(c.note, 240) }))
      : null,
    summary: (e.summaryFull || e.summary) ? scrub(e.summaryFull || e.summary, WIRE_SUMMARY_MAX) : null,
    // The card's glance line, verbatim — without it the receiving client
    // derives a title from the summary's first sentence and truncates it.
    headline: e.headline ? scrub(e.headline, WIRE_HEADLINE_MAX) : null,
    // Distilled vs harvested is a routing signal, not sensitive content, so it
    // rides alongside as plaintext metadata (never inside the ciphertext) — the
    // receiver needs it to decide whether a teammate's summary is a real brief
    // or a mid-session line, exactly as the local render does.
    distilled: !!e.distilled,
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
// An upsert is ONE statement, and Postgres refuses to touch the same row twice
// inside it: two rows sharing the on_conflict key (project_id, author_id, ts,
// source) abort the WHOLE batch with SQLSTATE 21000. `Prefer` cannot save it —
// ignore/merge-duplicates govern conflicts with rows already in the table, not
// duplicates within the payload. Locally captured entries really do collide:
// sessions backfilled from a single clock read share a millisecond and a
// source. Such a pair is permanent, so the batch fails identically on every
// pass, forever. Collapse them here, at the one boundary both push paths
// (fresh and drift-resend) funnel through, so no caller can hand the backend a
// self-conflicting statement. Last row wins: entries arrive in ascending ts
// order, so the later copy is the more current one.
function dedupeOnConflictKey(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.project_id}\x00${r.author_id}\x00${r.ts}\x00${r.source}`, r);
  return byKey.size === rows.length ? rows : [...byKey.values()];
}

async function upsertEntries(config, creds, rows, prefer, protect) {
  let attempt = dedupeOnConflictKey(rows);
  for (;;) {
    try {
      await rest(config, creds, 'POST', 'memory_entries?on_conflict=project_id,author_id,ts,source', attempt, { Prefer: prefer });
      return;
    } catch (err) {
      const m = /'(summary|goal|decisions|gotchas|changes|ciphertext|nonce|key_epoch|distilled|headline)' column/i.exec(err.message);
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
  const teams = await rpc(config, creds, 'my_teams', {});
  cacheMemberCounts(teams);
  return teams;
}

// Member counts, cached locally so the solo check never needs the network.
// /api/status is polled every few seconds and drives the header chrome, so it
// must stay offline-cheap — and it must not flip to "shared" merely because
// the backend is briefly reachable. my_teams already returns member_count
// (migration 006), so every teams fetch refreshes this for free.
function cacheMemberCounts(teams) {
  if (!Array.isArray(teams)) return;
  const state = util.loadState();
  const counts = { ...(state.teamCounts || {}) };
  let changed = false;
  for (const t of teams) {
    if (!t || !t.team_id) continue;
    const n = Number(t.member_count);
    if (!Number.isFinite(n)) continue;
    if (counts[t.team_id] !== n) { counts[t.team_id] = n; changed = true; }
  }
  if (!changed) return;
  state.teamCounts = counts;
  util.saveState(state);
}

// Pure (offline-testable): is this machine solo? Solo means nobody else is
// actually there — NOT that no team row exists. Creating a team of one is the
// normal first step of the upgrade flow, and it must not flip the header to
// "shared" before a single teammate has joined.
//
// `links` is one entry per watched project (null when unlinked); `counts` maps
// teamId -> last known member count; `signedIn` is whether this machine has
// credentials at all.
//
// Signed out is solo, whatever the links say. A team.json with no credentials
// is inert — nothing syncs, nothing is pushed, nothing is pulled — so claiming
// the work is shared would be a lie. This is also the state a freshly
// installed machine is in while a teammate's committed team.json sits in the
// repo, which is exactly when the header most needs to be honest.
//
// Signed in with an unknown count falls back to "linked means shared":
// guessing solo there would tell a real team member their memory is
// local-only, which is the worse of the two errors, and it self-corrects on
// the next sync.
function isSoloMachine(links, counts, signedIn) {
  if (!signedIn) return true;
  return !(links || []).some(link => {
    if (!link || !link.teamId) return false;
    const n = (counts || {})[link.teamId];
    return n == null ? true : n > 1;
  });
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
  // The hash form inviteUrl mints today. Only a BARE fragment is a token: the
  // join page's readFragment treats a fragment containing '=' as a query
  // string (an OAuth callback carries access_token=... there), so one of
  // those is not an invite and must be left alone.
  const hash = s.match(/#([A-Za-z0-9_-]+)\/?$/);
  if (hash) return hash[1];
  // The legacy path form. Links minted before the fix are still out there in
  // chats and emails and still name real, unexpired invites.
  const m = s.match(/\/join\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  return m ? m[1] : s;
}

// The token goes in the FRAGMENT, because that is the only place the hosted
// join page looks for it (cloudflare/join/public/index.html, readFragment:
// `location.hash.slice(1)`). The old `${base}/join/${token}` path form was
// served by the static site's SPA fallback -- a real 200, so nothing looked
// broken -- and the token was then simply ignored, leaving the invited person
// on the join page with nothing to accept. parseInviteToken still reads the
// old shape, so links already sent keep working.
function inviteUrl(config, token) {
  const base = webUrl(config);
  return base ? `${base}/#${token}` : null;
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

// Exact windowed totals for the team feed, counted in the database
// (027_team_feed_counts.sql). Insights used to count by paging team_feed and
// measuring the result, which cannot be exact: team_feed clamps every page to
// 200 rows server-side, so the client capped out and published the cap as a
// total.
//
// Returns `{ entries, sessions }`, or **null** when the backend predates the
// migration — the same degrade-don't-throw stance fetchMemoryRows takes for a
// missing optional column. A null here means "count the old way and say so",
// never a zero: a fabricated zero would read as "your team shared nothing".
async function teamFeedCounts(config, teamId, opts = {}) {
  const creds = await hubCreds(config);
  try {
    const rows = await rpc(config, creds, 'team_feed_counts', {
      p_team: teamId,
      p_author: opts.author || null,
      p_project: opts.project || null,
      p_source: opts.source || null,
      p_since: opts.since || null,
      p_until: opts.until || null,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return null;
    const entries = Number(row.entries);
    const sessions = Number(row.sessions);
    if (!Number.isFinite(entries) || !Number.isFinite(sessions)) return null;
    return { entries, sessions };
  } catch (err) {
    // PostgREST reports an unknown function as PGRST202 / "Could not find the
    // function". Anything else (auth, network, a real SQL fault) must still
    // throw, or a broken backend silently looks like an old one forever.
    if (/PGRST202|Could not find the function|does not exist/i.test(err.message || '')) return null;
    throw err;
  }
}

async function projectStats(config, teamId) {
  const creds = await hubCreds(config);
  return rest(config, creds, 'GET',
    `project_stats?team_id=eq.${encodeURIComponent(teamId)}&select=*`);
}

// Which projects of this team can this member still READ, as the backend sees
// it right now. project_stats is the right probe and the `projects` table is
// not: 025_enforce_project_access.sql puts can_see_project into the view's
// WHERE clause and deliberately leaves the base table's select policy alone
// (see its note on leaking project existence). memory_entries is no probe
// either — a revoked member and a member on a quiet project both pull zero
// rows, which is exactly why revocation went unnoticed on the client.
//
// Returns null, never an empty set, when the answer cannot be established:
// callers use absence-from-this-set to destroy local data, so "I could not
// ask" must never be mistaken for "you may see nothing". Every failure —
// network, auth, a backend too old to have the view — lands on null.
async function visibleProjectIds(config, creds, teamId) {
  if (!teamId) return null;
  try {
    const rows = await rest(config, creds, 'GET',
      `project_stats?team_id=eq.${encodeURIComponent(teamId)}&select=project_id`);
    if (!Array.isArray(rows)) return null;
    const ids = new Set();
    for (const r of rows) if (r && r.project_id) ids.add(String(r.project_id));
    // An EMPTY list is inconclusive, not "you may see nothing". A backend
    // without the view, a misconfigured deployment and a member revoked from
    // every project in the team all produce []. Since the caller deletes local
    // data on absence, the ambiguous case must fail safe — the cost of acting
    // on it wrongly is wiping every archive on the machine, and the cost of
    // ignoring it is that revocation from a member's ONLY project is not
    // detected here (a member removed from the team entirely still gets the
    // existing not-a-member error, which is its own signal).
    return ids.size ? ids : null;
  } catch {
    return null;
  }
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

// Drop this project's CACHED TEAMMATE ROWS from state.
//
// The third local copy of team content, and the last one unlink did not sweep.
// proj.teamEntries survives an unlink, so util.teamRowsFor keeps handing those
// rows to search, to the injected CLAUDE.md/AGENTS.md block and to the project
// page while the Projects grid describes the project as private — the same
// indicator-versus-behaviour split the derived notes index had, one copy over.
//
// Pruned AT THE SOURCE rather than gated in util.teamRowsFor, deliberately.
// teamRowsFor answers "may this install still read this project's team rows?",
// keyed on the positive fact `teamAccessLost`; "is a link file present" is a
// different question it does not hold today, rows-without-team.json is a shape
// the existing fixtures rely on, and adding a link probe there would make every
// reader of every project stat a filesystem check. Unlink already prunes the
// durable archive and the notes index right here, for exactly this reason; this
// is the same move on the copy that was missed.
//
// state.json HAS NO LOCKING, so this is a real cost: another process's
// concurrent save is erased if it lands between the load and the save below.
// Three things keep that window as narrow as the windows the file already has
// (cacheMemberCounts, noteAuthPause):
//   1. Nothing async or I/O-bound sits between load and save — the work is a
//      field assignment on an in-memory object.
//   2. It writes ONLY when there is something to prune, so the common
//      unlink-a-project-with-no-cached-rows case adds no window at all, and a
//      second unlink of the same project adds none either.
//   3. It never CREATES a project record. An untracked project has no cached
//      rows by definition, and inventing a record here would put a project the
//      daemon does not watch into state.
// Failure is swallowed to a boolean, like pruneArchive: an unreadable
// state.json must not turn a user's unlink into an error, and loadState's own
// rule is to refuse to write over a file it could not read.
//
// teamPullTs goes with the rows because the two are one unit: a forward cursor
// left standing over an emptied cache means a later RE-LINK of the same project
// pulls only rows newer than the cursor and silently never re-fetches the
// history behind it. syncTeams' revocation branch empties exactly this pair for
// the same reason.
function pruneTeamEntries(projectPath) {
  let state;
  try {
    state = util.loadState();
  } catch {
    return false; // unreadable state: refuse to write, never clobber
  }
  const proj = (state.projects || {})[projectPath];
  if (!proj) return false; // untracked — nothing cached, and do not mint a record
  const hadRows = Array.isArray(proj.teamEntries) && proj.teamEntries.length > 0;
  const hadCursor = proj.teamPullTs != null;
  if (!hadRows && !hadCursor) return false; // nothing to prune -> no save, no window
  proj.teamEntries = [];
  proj.teamPullTs = null;
  try {
    util.saveState(state);
  } catch {
    return false;
  }
  return true;
}

function unlinkProject(projectPath) {
  // Read the link BEFORE dropping team.json — projectId is only known while
  // the link file still exists, and pruning the durable archive needs it.
  const link = loadTeamLink(projectPath);
  // Deliberately OUTSIDE the try below, so it runs whether or not there was a
  // team.json to remove. A project that was unlinked by an older build still
  // has its cached rows sitting in state with no link file left to trigger a
  // sweep, and this is the only path a user can invoke to clear them; refusing
  // to heal that because the file is already gone would leave the leak with no
  // exit. It is idempotent and writes nothing when there is nothing to prune,
  // so the no-op unlink stays a no-op.
  pruneTeamEntries(projectPath);
  try {
    fs.unlinkSync(teamFilePath(projectPath));
    if (link && link.projectId) teamArchive.pruneArchive(link.projectId);
    // The derived teammate-notes index is the THIRD copy of team content on
    // this disk, alongside proj.teamEntries and the durable archive, and it was
    // the one nothing here cleaned up. Left behind, an unlinked project read
    // "Private · Only you" in the Projects grid while every session in it kept
    // receiving teammate decisions — the indicator and the behaviour pointing
    // in opposite directions, which is worse than either failure alone.
    //
    // This is the ONLY thing that stops the unlink leak: unlink stamps no flag
    // in state (syncTeams skips a project with no team.json, so it never gets
    // one), which is why util.mayServeTeammateNotes — the reader gate, keyed on
    // teamAccessLost — cannot cover this case and the erase has to happen here.
    // Same shape as pruneArchive on the line above, for the same reason.
    //
    // Lazily required to keep the dependency one-way: teammate-notes-store
    // requires nothing from here at load time, and by the time this runs both
    // modules are fully loaded. Best-effort, again like pruneArchive: the
    // unlink itself must not fail because a derived cache could not be swept.
    try { require('./teammate-notes-store').clearTeammateNotes(projectPath); } catch { /* best-effort */ }
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
// Stable content signature for one plaintext row: everything the row ships
// except the routing ids that cannot drift AND the share-gated fields
// (ask/goal) — a share toggle alone must never trigger a drift re-push
// (retroactive prompt backfill/scrub is reshareSession's explicit job, a
// pinned privacy behavior). Computed on the PLAINTEXT row — ciphertext embeds
// a fresh nonce every time and would never compare equal. A changed signature
// means the backend's copy of the CONTENT is stale.
function rowSig(row) {
  const { project_id: _p, author_id: _a, ask: _ask, goal: _goal, ...content } = row;
  return nodeCrypto.createHash('sha1').update(JSON.stringify(content)).digest('hex');
}

async function pushProject(config, creds, projectPath, proj, link, crypto) {
  const cursor = proj.teamPushTs || '';
  const all = classify.filterShareableEntries(memorydb.buildEntries(projectPath, proj, config), proj.events);
  if (!all.length) return 0;
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
  const sigs = proj.teamPushSig || {};
  const sigKey = e => `${e.ts}|${e.source}`;
  const rowFor = e => entryToRow(e, link.projectId, creds, isShared(config, proj, e.session), regexes, projectPath);
  const protect = crypto && crypto.plaintextOff ? ['ciphertext', 'nonce', 'key_epoch'] : null;
  const seal = plainRows => plainRows.map(r =>
    encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto, plaintextOff: crypto.plaintextOff }));
  let pushed = 0;
  const fresh = all.filter(e => e.ts > cursor);
  for (let i = 0; i < fresh.length; i += PUSH_BATCH) {
    const batch = fresh.slice(i, i + PUSH_BATCH);
    const plainRows = batch.map(rowFor);
    // Dual-write: add ciphertext/nonce/key_epoch next to the plaintext
    // fields. An encrypt failure under `required` HOLDS this batch and the
    // rest (break — cursor stays at the last uploaded batch); without
    // `required` (explicit hatch) it falls back to this batch's plaintext.
    let rows = plainRows;
    if (crypto && crypto.teamKey) {
      try {
        rows = seal(plainRows);
      } catch (err) {
        if (crypto.required) {
          util.log(`team encrypt: encrypt failed (${err.message}) — batch held for next pass`);
          break;
        }
        util.log(`team encrypt: encrypt failed (${err.message}) — pushing plaintext for this batch`);
        rows = plainRows;
      }
    }
    await upsertEntries(config, creds, rows, 'resolution=ignore-duplicates,return=minimal', protect);
    pushed += rows.length;
    // Advance only past what actually uploaded, batch by batch.
    proj.teamPushTs = batch[batch.length - 1].ts;
    batch.forEach((e, j) => { sigs[sigKey(e)] = rowSig(plainRows[j]); });
  }
  // Content drift: a distilled brief lands at session Stop and attaches to an
  // entry the cursor already passed, so without this pass the backend keeps
  // the summaryless first push forever and teammates never see the brief.
  // Re-send any already-pushed entry whose shipped content changed, with
  // merge-duplicates (overwrite in place — 012's UPDATE policy) and a bumped
  // created_at so every pull cursor and feed page re-sees the row. Entries
  // with no recorded signature (pushed before this existed) re-send once,
  // healing stale backend copies retroactively.
  const stale = [];
  for (const e of all) {
    if (e.ts > cursor) continue; // fresh or held — the loop above owns these
    const plain = rowFor(e);
    const sig = rowSig(plain);
    if (sigs[sigKey(e)] === sig) continue;
    stale.push({ plain, key: sigKey(e), sig });
  }
  if (stale.length) {
    const now = new Date().toISOString();
    for (let i = 0; i < stale.length; i += PUSH_BATCH) {
      const batch = stale.slice(i, i + PUSH_BATCH);
      let rows = batch.map(b => ({ ...b.plain, created_at: now }));
      if (crypto && crypto.teamKey) {
        try {
          rows = seal(rows);
        } catch (err) {
          if (crypto.required) {
            util.log(`team encrypt: encrypt failed (${err.message}) — drift batch held for next pass`);
            break;
          }
          util.log(`team encrypt: encrypt failed (${err.message}) — pushing plaintext for this drift batch`);
        }
      }
      await upsertEntries(config, creds, rows, 'resolution=merge-duplicates,return=minimal', protect);
      pushed += rows.length;
      batch.forEach(b => { sigs[b.key] = b.sig; });
    }
  }
  // The signature map stays bounded by the entry window itself.
  const live = new Set(all.map(sigKey));
  for (const k of Object.keys(sigs)) { if (!live.has(k)) delete sigs[k]; }
  proj.teamPushSig = sigs;
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
const OPTIONAL_PULL_COLUMNS = ['goal', 'decisions', 'gotchas', 'changes', 'ciphertext', 'nonce', 'key_epoch', 'distilled', 'headline'];

// GET memory_entries with the select-columns fallback: some backends predate
// one or more optional columns (a pre-migration install), and PostgREST
// rejects the whole select with a "column ... does not exist" error rather
// than just omitting it. Drop the offending column and retry so a pull
// degrades gracefully instead of failing outright. `where` is the
// query-string fragment after `memory_entries?` — filters, order, limit —
// built by the caller; this helper only owns the select-columns retry loop,
// shared by the forward pull and the backward backfill walker.
async function fetchMemoryRows(config, creds, where) {
  // `id` (the bigint identity PK) rides along unconditionally — it is the
  // backward backfill walker's paging cursor (never optional: unlike the
  // content columns below, a backend genuinely missing its own primary key
  // is not a degradation case worth handling).
  //
  // `author_id` is REQUIRED for the same reason, and the distinction matters:
  // it appeared in the WHERE clause (`author_id=neq.${creds.userId}`) long
  // before it appeared here, and a predicate is not a projection — so
  // `r.author_id` was `undefined` in mapPulledRow and every stored row lost
  // its author's stable identity. It cannot go in OPTIONAL_PULL_COLUMNS:
  // upsertEntries' on_conflict key is (project_id, author_id, ts, source), so
  // a backend missing this column could never have accepted a single push,
  // and treating it as droppable is exactly how the id would silently vanish
  // again. Display names are NOT a substitute — one account in production
  // holds 114 rows as 'andrewludwigbrown' and 100 as 'Andrew Brown' over
  // OVERLAPPING date ranges (two installs of one account pushing different
  // configured names), so anything keyed on the name splits one human in two.
  let selectCols = ['id', 'author_id', 'author_name', 'ts', 'source', 'session', 'ask',
    'goal', 'decisions', 'gotchas', 'summary', 'headline', 'files', 'changes',
    'ciphertext', 'nonce', 'key_epoch', 'distilled', 'created_at'];
  for (;;) {
    const q = `memory_entries?${where}&select=${selectCols.join(',')}`;
    try {
      return await rest(config, creds, 'GET', q);
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
}

// Maps ONE raw memory_entries row (as returned by fetchMemoryRows) into the
// shape stored in proj.teamEntries / the durable archive (lib/team-archive.js).
// Shared by the forward pull and the backward backfill walker — both need
// byte-identical decrypt-on-pull behavior.
//
// Decrypt-on-pull: when the row carries ciphertext, the decrypted payload IS
// the content — the row's plaintext columns are the dual-write copy for old
// clients and could diverge or be tampered server-side. Under `required`
// (encryption on — the default), a row that will not decrypt renders OPAQUE
// (null content + undecryptable flag): falling back to server-controlled
// plaintext would let a hostile server force a silent downgrade by
// corrupting ciphertext. Only the explicit encrypt:false hatch (teamCrypto ==
// null) or a non-required context reads plaintext. This never throws for a
// crypto reason.
async function mapPulledRow(r, link, teamCrypto) {
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
      // headline: null before the spread — payloads sealed before the
      // headline key existed must not fall back to a server-writable
      // plaintext column on an encrypted row.
      content = { ...r, headline: null, ...payload };
    } else if (teamCrypto.required) {
      undecryptable = true;
      content = { ask: null, goal: null, decisions: null, gotchas: null, summary: null, headline: null, files: [], changes: null };
      warnOnce(warnCtx, `pull:${link.teamId || ''}`,
        'team encrypt: cannot decrypt a pulled row — rendering it opaque (fail-closed)');
    } else {
      warnOnce(warnCtx, `pull:${link.teamId || ''}`,
        'team encrypt: cannot decrypt a pulled row — using its plaintext columns');
    }
  }
  return {
    author: r.author_name,
    // The author's STABLE identity (memory_entries.author_id — uuid not null
    // references auth.users). `author` above is a snapshot stamped
    // client-side at push time and is not stable for one account, so this is
    // the only field a person filter, a dedupe or a grouping may key on.
    // Readers three layers up (lib/feed.js normalizeTeam, lib/activity.js
    // matchesAuthor, the search index's author_id column) were all written
    // expecting it and were reading null for every row until it was carried
    // here. Null only for a row from a backend that sent none.
    authorId: r.author_id || null,
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
    // The author's verbatim glance line — inside the ciphertext on E2E
    // teams, a plaintext column on hatch teams (migration 017).
    headline: content.headline || null,
    // distilled rides as plaintext metadata (never encrypted), so it reads
    // from the row itself, not the decrypted payload — it tells the render
    // whether this teammate summary is a real brief or a harvested line.
    distilled: !!r.distilled,
    files: Array.isArray(content.files) ? content.files : [],
    changes: Array.isArray(content.changes) ? content.changes : null,
    ...(undecryptable ? { undecryptable: true } : {}),
  };
}

// `teamCrypto` (optional, Task 6 Part B): { ctx, keyDeps } — the pass-level
// crypto context and this team's resolveTeamKey deps, shared with the push
// side so both use one identity and one per-pass key cache. Null = plaintext
// pull, byte-identical to before.
async function pullProject(config, creds, proj, link, teamCrypto) {
  const cursor = proj.teamPullTs || '1970-01-01T00:00:00.000Z';
  const where = `project_id=eq.${link.projectId}` +
    `&author_id=neq.${creds.userId}` +
    `&created_at=gt.${encodeURIComponent(cursor)}` +
    `&order=created_at.asc&limit=${PULL_LIMIT}`;
  const rows = await fetchMemoryRows(config, creds, where);
  if (!rows || !rows.length) return 0;
  const existing = proj.teamEntries || [];
  // Key -> index, not a skip-set: a row that arrives again under the same
  // identity+ts+source key is by definition a NEWER version — the author
  // re-pushed it with a bumped created_at (drift re-push, reshare) — so it
  // REPLACES the stale stored copy instead of being dropped.
  //
  // The key prefers author_id over the display name because author_id is what
  // the BACKEND treats as identity: upsertEntries' on_conflict key is
  // (project_id, author_id, ts, source), so an id-keyed local key is the only
  // one that agrees with the server about which rows are the same row. Keying
  // on the name was actively wrong, not merely weak — a re-push whose install
  // had since been configured with a different display name missed the key
  // entirely and appended a SECOND copy of the same work.
  //
  // MIGRATION: every row already on disk predates authorId, so stored rows are
  // registered under BOTH keys (id-key when they have one, name-key always)
  // and an incoming row is looked up id-key first, name-key second. An id-less
  // stored row is therefore still found, by its name, and the replacement
  // written back over it carries the id — the cache heals row by row as rows
  // are re-pushed. The first pull after this change cannot duplicate anything
  // regardless: the cursor below only fetches created_at > teamPullTs, so the
  // rows arriving are ones never stored, and this key is not consulted for
  // them at all.
  const idKey = e => (e.authorId ? `id:${e.authorId}|${e.ts}|${e.source}` : null);
  const nameKey = e => `name:${e.author}|${e.ts}|${e.source}`;
  const seen = new Map();
  existing.forEach((e, i) => {
    const byId = idKey(e);
    if (byId) seen.set(byId, i);
    seen.set(nameKey(e), i);
  });
  const mappedRows = [];
  for (const r of rows) {
    const mapped = await mapPulledRow(r, link, teamCrypto);
    const byId = idKey(mapped);
    const byName = nameKey(mapped);
    const at = (byId != null && seen.has(byId)) ? seen.get(byId)
      : (seen.has(byName) ? seen.get(byName) : -1);
    mappedRows.push(mapped);
    if (at >= 0) {
      existing[at] = mapped;
      // Re-register under BOTH of the replacement's keys: the row was very
      // likely found by name and now carries an id, so a later row in this
      // same page must be able to find it by that id.
      if (byId) seen.set(byId, at);
      seen.set(byName, at);
    } else {
      if (byId) seen.set(byId, existing.length);
      seen.set(byName, existing.length);
      existing.push(mapped);
    }
  }
  existing.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  // Archive every pulled row durably BEFORE the cache slice discards the old
  // tail — search's historical reach depends on this (the state cache keeps
  // only the newest MAX_TEAM_ENTRIES rows; see lib/team-archive.js). These
  // rows are always the newest thing arriving, so the forward writer is the
  // one appendRows trims (oldest-out) once the archive is at its cap.
  try { teamArchive.appendRows(link.projectId, mappedRows, { source: 'forward' }); } catch { /* never break a pull */ }
  proj.teamEntries = existing.slice(-MAX_TEAM_ENTRIES);
  proj.teamPullTs = rows[rows.length - 1].created_at;
  return rows.length;
}

// Backward archive backfill: existing installs advanced teamPullTs long ago,
// so rows older than the cache were pulled once and discarded. Walk history
// newest-first, ONE page per sync pass (PULL_LIMIT rows — gentle on the
// backend and on the tick), archive each page, and flip backfill.done on the
// first short or empty page. Never touches proj.teamPullTs: forward pulls
// own that cursor exclusively. `proj` is accepted (matching pullProject's
// shape) but intentionally unused for anything but that non-interference
// contract.
//
// Pages on `id` (memory_entries.id, a bigint identity PK), not `created_at`
// (final whole-branch review, Finding #2). created_at is timestamptz default
// now(), and Postgres's now() is constant within one transaction, so a
// PUSH_BATCH upsert writes many rows sharing an IDENTICAL created_at — not an
// edge case, the normal shape of a batched push. A created_at cursor has no
// secondary sort key, so tied rows come back in arbitrary order and the next
// page's strict `lt.` permanently skips whichever tied siblings fell past the
// boundary: silent, nondeterministic, unrecoverable once `done` flips. `id`
// is total-ordered with no ties, so this cannot happen.
//
// The archive's row cap must never silently eat backward progress (the
// retention bug lib/team-archive.js's header documents in full): a backfill
// page is always OLDER than everything else archived, so once the archive
// is full, appendRows keeps those rows (never trims them) but the walk still
// cannot make further progress without either dropping newer forward rows
// (never) or growing past the cap forever (also never). So once full, this
// stops asking and records the honest `stopped: 'archive-full'` — never a
// `done: true` claim of having reached the true start of history. Unlike
// `done`, `stopped` is provisional: it stays cleared to resume automatically
// the moment the archive has room again (a cap raise, or any future
// compaction), from the exact cursor it paused at — see the `stopped` branch
// below. The pre-fetch check below reads only the tiny sidecar (teamArchive.
// backfillStatus), so a project that is already done/genuinely-stopped costs
// no network round trip on the sync passes after it stops.
async function backfillArchivePage(config, creds, proj, link, teamCrypto) {
  const status = teamArchive.backfillStatus(link.projectId);
  if (status.backfill.done) return 0;
  // `done` is terminal — the walk genuinely reached the true start of
  // history and must never be redone. `stopped` is NOT terminal the same
  // way: it records why a live walk paused, and 'archive-full' in
  // particular is provisional — if the cap has since been raised (or the
  // archive otherwise has room again), the very next tick must resume from
  // the SAME beforeId cursor instead of returning early forever (fix wave,
  // review of the retention rework: without this, a cap raise could never
  // unstick a walk that had already stopped for this reason). Any other
  // stop reason (there is only 'archive-full' today) still stops for good.
  if (status.backfill.stopped) {
    const roomAgain = status.backfill.stopped === 'archive-full' && status.rowCount < teamArchive.MAX_ARCHIVE_ROWS;
    if (!roomAgain) return 0;
    // else fall through: re-run the cap check below with the CURRENT limit,
    // which now finds room and proceeds to fetch.
  }
  if (status.rowCount >= teamArchive.MAX_ARCHIVE_ROWS) {
    teamArchive.setBackfill(link.projectId, {
      done: false, stopped: 'archive-full', beforeId: status.backfill.beforeId,
    });
    return 0;
  }
  const beforeId = status.backfill.beforeId;
  const where = `project_id=eq.${link.projectId}` +
    `&author_id=neq.${creds.userId}` +
    (beforeId != null ? `&id=lt.${encodeURIComponent(beforeId)}` : '') +
    `&order=id.desc&limit=${PULL_LIMIT}`;
  const rows = await fetchMemoryRows(config, creds, where);
  if (!rows || !rows.length) {
    teamArchive.setBackfill(link.projectId, { done: true, beforeId, stopped: null });
    return 0;
  }
  const mapped = [];
  for (const r of rows) mapped.push(await mapPulledRow(r, link, teamCrypto));
  const newRowCount = teamArchive.appendRows(link.projectId, mapped, { source: 'backfill' });
  // null means the archive write did not land — most often because the other
  // process (CLI vs daemon tick) held the append lock. Leave the cursor
  // exactly where it was so the very next tick refetches this same page.
  // Advancing here would skip these rows forever: the walk only ever moves
  // backwards, so nothing would come back for them, and a short final page
  // would even flip `done: true` while up to PULL_LIMIT rows were dropped.
  if (newRowCount === null) return 0;
  const nowFull = newRowCount >= teamArchive.MAX_ARCHIVE_ROWS;
  teamArchive.setBackfill(link.projectId, {
    done: !nowFull && rows.length < PULL_LIMIT,
    stopped: nowFull ? 'archive-full' : null,
    beforeId: rows[rows.length - 1].id,
  });
  return rows.length;
}

// Re-push ONE session's rows with the verbatim prompt forced on (share=true,
// backfill) or off (share=false, scrub). Overwrites already-synced rows via
// merge-duplicates and reuses encryptRow, so encrypted teams stay encrypted.
// Resolves creds/link/team-key itself unless the caller injects them (tests).
async function reshareSession(config, projectPath, sessionId, share, opts = {}) {
  // Unlinked first: a solo project has nothing to push, so it must never
  // depend on credentials or the network — the local flag flip always works.
  const key = path.resolve(projectPath);
  const link = opts.link || loadTeamLink(key);
  if (!link || !link.projectId) return { ok: true, unlinked: true };
  // Refreshed creds, like every other authenticated call — the raw
  // loadCredentials() this used before handed rest() whatever token was on
  // disk, so a session shared after the JWT went stale always 401ed while the
  // periodic sync kept quietly refreshing for everything else (the
  // "share fails on a live session" bug — failure tracked token age, which
  // correlates with when the session was last synced, not with the session).
  const creds = opts.creds || await getAccessToken(config);
  if (!creds) return { ok: false, error: 'not logged in' };

  const state = util.loadState();
  const proj = (state.projects || {})[key] || (state.projects || {})[projectPath];
  if (!proj) return { ok: false, error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];

  const rowsSrc = classify.filterShareableEntries(memorydb.buildEntries(projectPath, proj, config), proj.events)
    .filter(e => (e.session || null) === sessionId);
  // No local rows means there is nothing to push OR flip — succeeding here
  // would let the caller persist a "shared" flag the backend never saw (the
  // old ok:true/count:0 no-op). Refuse so the UI reverts honestly; the server
  // scans before calling, so a real live session has its rows by now.
  if (!rowsSrc.length) return { ok: false, error: 'session has no synced rows yet — try again in a moment' };

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
    const plainRows = rowsSrc.slice(i, i + PUSH_BATCH).map(e => entryToRow(e, link.projectId, creds, !!share, regexes, projectPath));
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
      // The one place the pause is cleared: a bootstrap that actually reached
      // the backend with a live session proves the recorded reason is gone.
      noteAuthPause(opts.state, null);
      return { identity, teamcrypto: deps.teamcrypto, cache: new Map(), warned: new Set() };
    }
    util.log('team encrypt: no identity (libsodium or keychain unavailable) — team push paused (fail-closed)');
  } catch (err) {
    // An expired JWT lands here: publishing the pubkey is the first call that
    // needs a live session. Record why, so the header can say "sign in" rather
    // than hold a stale "Synced" over a team that is receiving nothing. An
    // unclassifiable failure leaves any standing reason alone — it is neither
    // evidence the session recovered nor evidence it died.
    const reason = classifyAuthFailure(err);
    if (reason) noteAuthPause(opts.state, { reason, detail: err.message });
    util.log(`team encrypt: identity bootstrap failed (${err.message})${reason ? ` [${reason}]` : ''} — team push paused (fail-closed)`);
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
      // Same rule as pullProject: a pre-headline payload must not let the
      // server's plaintext headline column speak for an encrypted row.
      out.push({ ...r, headline: null, ...payload });
    } else {
      warnOnce(warnCtx, `feed:${teamId || ''}`,
        'team encrypt: cannot decrypt a feed row — rendering it opaque (fail-closed)');
      out.push({
        ...r,
        ask: null, goal: null, decisions: null, gotchas: null, summary: null,
        headline: null, files: [], changes: null, undecryptable: true,
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
      plaintextOff: plaintextOffFor(config) } : null;
  } catch (err) {
    util.log(`team encrypt: reshare key resolution failed (${err.message}) — plaintext`);
    return null;
  }
}

// Owner/admin recovery: mint a BRAND-NEW epoch key and seal it to every
// current, TOFU-trusted member's published pubkey (including my own new key).
// The escape hatch for when this device cannot obtain the existing key — the
// classic case being a new device whose keypair rotated, orphaning the seal —
// and cannot wait for a key-holder to re-share. Forward-only: new content
// encrypts under the new epoch; older epochs stay readable only by whoever
// already holds them (so pre-rekey encrypted history you never had stays out
// of reach — an accepted cost of self-recovery). Fail-closed: returns
// { ok:false, error } on any problem. opts.cryptoDeps injects fakes for tests.
async function rekeyTeam(config, teamId, opts = {}) {
  const creds = opts.creds || await getAccessToken(config);
  if (!creds) return { ok: false, error: 'not logged in — run `membridge login` first' };
  // Owner/admin only: rotating the team key is an administrative act.
  if (!opts.skipRoleCheck) {
    const teams = await rpc(config, creds, 'my_teams', {}).catch(() => null);
    const mine = Array.isArray(teams) ? teams.find(t => t.team_id === teamId) : null;
    if (!mine) return { ok: false, error: 'you are not a member of that team' };
    if (!['owner', 'admin'].includes(mine.role)) {
      return { ok: false, error: `only an owner or admin can rekey (your role: ${mine.role || 'member'})` };
    }
  }
  const ctx = await buildCryptoContext(config, creds, opts);
  if (!ctx) return { ok: false, error: 'encryption is unavailable on this device (no OS key store, or libsodium missing)' };
  const keyDeps = mkTeamKeyDeps(config, creds, teamId, ctx);
  await ctx.teamcrypto.ready();

  const [rows, members, pubkeys] = await Promise.all([
    keyDeps.fetchTeamKeyRows(), keyDeps.fetchMembers(), keyDeps.fetchMemberPubkeys(),
  ]);
  const memberIds = new Set((members || []).map(m => m.user_id));
  const nameById = new Map((members || []).map(m => [m.user_id, m.display_name || '']));
  // TOFU gate: seal only to first-seen/verified keys. A member whose key
  // CHANGED is withheld until trusted (`membridge team trust`) — rekey must
  // never silently bless a swapped key.
  const fetched = (pubkeys || []).map(r => ({ ...r, display_name: nameById.get(r.user_id) || '' }));
  const gate = keyDeps.pins.check(keyDeps.pins.load(), fetched, new Date().toISOString());
  keyDeps.pins.save(gate.pins);
  const allowed = (gate.allowed || []).filter(m => memberIds.has(m.user_id));
  if (!allowed.some(m => m.user_id === creds.userId)) {
    return { ok: false, error: 'your own key is not published yet — run `membridge sync` once so it uploads, then retry' };
  }

  const maxEpoch = (rows || []).reduce((m, r) => Math.max(m, Number(r.epoch) || 0), 0);
  const epoch = maxEpoch + 1;
  const teamKey = ctx.teamcrypto.genTeamKey();
  const batch = allowed.map(m => ({
    team_id: teamId, epoch, member_user_id: m.user_id,
    sealed_team_key: ctx.teamcrypto.sealTeamKey(teamKey, m.public_key),
  }));
  await keyDeps.insertSealedRows(batch);

  // Read-back proof: I must be able to open my own new row, or the rekey is a
  // no-op we should report as failed rather than claim success.
  const mine = await keyDeps.fetchMySealedRow(epoch);
  const opened = mine && ctx.teamcrypto.unsealTeamKey(mine.sealed_team_key, ctx.identity.publicKey, ctx.identity.privateKey);
  if (!opened) return { ok: false, error: 'rekey did not take — could not reopen the new key after sealing' };

  const withheld = (members || [])
    .filter(m => m.user_id !== creds.userId && !allowed.some(a => a.user_id === m.user_id))
    .map(m => m.display_name || m.user_id);
  return { ok: true, epoch, sealed: batch.length, withheld };
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
// An RLS refusal used to have one plausible cause, so this said so outright: the
// project carries a team.json (often committed by a teammate) for a team this
// account isn't in. Shared by the per-project catch and the push-only catch.
//
// SINCE 033_enforce_project_access_on_write.sql THERE ARE TWO CAUSES, and the
// refusal cannot tell them apart. can_see_project now gates memory_entries
// INSERT and UPDATE as well as SELECT, so a member in good standing on the team
// who has been REVOKED FROM THIS ONE PROJECT gets the same
// `new row violates row-level security policy` back. The old text asserted the
// wrong one of the two and then told them to run `membridge team unlink`, which
// discards a link that is very likely correct — destructive advice off a guess.
//
// So: name both causes, and stop instructing a teardown. The refusal itself is
// not a malfunction in the revoked case — it is the access control working — and
// the entries stay held locally either way (the push cursor never advances past
// a batch that did not land), so nothing is lost by asking rather than telling.
function rlsHint(message) {
  return /security|not a member/i.test(message)
    ? ` — the backend refused this. Either this project's ${memorydb.DIR_NAME}/team.json`
      + ' points at a team this account is not a member of, or a team owner/admin has'
      + ' revoked this account\'s access to this project. Check the project\'s access in'
      + ' the app first: entries stay held locally, and `membridge team unlink` would'
      + ' discard a link that may be correct.'
    : '';
}

async function syncTeams(opts = {}) {
  const config = util.getConfig();
  if (!isConfigured(config)) return { synced: [], changed: [], errors: [] };
  let creds;
  try {
    creds = await getAccessToken(config);
  } catch (err) {
    // The same silent failure as the identity bootstrap below, one layer up: a
    // refresh token the backend has rejected stops every push, and this path
    // returns before any state is loaded — so it records its own. Note the
    // asymmetry with `!creds` beneath it: a machine that never signed in is not
    // a machine whose session died, and must not be nagged to sign back in.
    const reason = classifyAuthFailure(err);
    if (reason) {
      try {
        const st = util.loadState();
        noteAuthPause(st, { reason, detail: err.message });
        util.saveState(st);
      } catch (e) {
        // Reporting is best-effort; never turn a sync error into a crash.
      }
    }
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
  // `state` is threaded in so buildCryptoContext can record a paused session on
  // the very object this pass saves at the end — a helper that saved its own
  // copy would be overwritten by that save.
  const cryptoCtx = encryptOn ? await buildCryptoContext(config, creds, { ...opts, state }) : null;
  let cryptoPausedReason = null;

  const synced = [];
  const changed = [];
  const errors = [];
  // Team id -> readable project ids, resolved at most once per team per pass
  // (a team with several linked projects must not re-probe for each).
  let visibleByTeam = null;
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (opts.project && path.resolve(opts.project) !== path.resolve(key)) continue;
    if (util.isProjectOff(key, config)) continue;
    const link = loadTeamLink(key);
    if (!link || !link.projectId) continue;
    try {
      if (!Array.isArray(proj.events)) proj.events = [];
      // Access check before anything reads or writes this project's team data.
      // Revocation is enforced server-side (025), so a revoked member already
      // gets nothing NEW — but everything already pulled sits on this disk in
      // proj.teamEntries and the durable archive, and MCP search_memory reads
      // both straight off disk with no network call in the path. Without this,
      // revoking access leaves the member answering questions about the
      // project forever, and the archive is capped by row count rather than
      // age so it never rolls over on its own.
      visibleByTeam = visibleByTeam || new Map();
      if (link.teamId && !visibleByTeam.has(link.teamId)) {
        visibleByTeam.set(link.teamId, await visibleProjectIds(config, creds, link.teamId));
      }
      const visible = link.teamId ? visibleByTeam.get(link.teamId) : null;
      if (visible && !visible.has(String(link.projectId))) {
        // Positive confirmation only: `visible` is null whenever the probe
        // could not answer, and this branch is skipped entirely then. Nothing
        // here deletes local data on a network blip.
        if (!proj.teamAccessLost) {
          proj.teamAccessLost = new Date().toISOString();
          util.log(`team access lost for ${key} — dropping cached teammate rows, the derived notes index and the durable archive`);
        }
        proj.teamEntries = [];
        proj.teamPullTs = null;
        try { teamArchive.pruneArchive(link.projectId); } catch { /* best-effort, same rule as unlink */ }
        // The teammate-notes index is a DERIVED copy of the rows just emptied
        // above, and nothing here used to touch it — so revocation stopped the
        // rows and left the copy injecting those teammates' decisions into
        // every agent session, indefinitely. Erased at the source as well as
        // gated at the readers: a derived cache that is only correct while
        // someone remembers to clear it is the defect shape this repo keeps
        // producing. Lazy require, one-way dependency (see unlinkProject).
        try { require('./teammate-notes-store').clearTeammateNotes(key); } catch { /* best-effort */ }
        continue; // no push, no pull, no backfill for a project we may not read
      }
      if (!visible && proj.teamAccessLost) {
        // The third case, which used to have no branch at all: the probe could
        // not answer THIS pass, and an earlier pass already CONFIRMED this
        // project was revoked. Both branches around this one require `visible`,
        // so such a project fell straight through to push, pull and backfill —
        // reading the control flow as though "revoked" were terminal when it
        // was not.
        //
        // Not a leak today: util.teamRowsFor still refuses on the flag, the
        // notes reconciler still erases the derived index on such a pass, and
        // the backend's own policy (025) returns nothing anyway. It is a trap:
        // the next person to add a local write to the pull path adds it to a
        // project this install has been told it may not read.
        //
        // Skipping does not strand the project. Clearing the flag needs a
        // POSITIVE answer, so recovery was always gated on the probe
        // succeeding — the very next pass that gets an answer takes the branch
        // above or below and resumes normally. Deliberately consistent with the
        // confirmed-revoked branch: not counted in `synced`, exactly as that
        // one is not.
        util.log(`team sync: skipping ${key} — access was confirmed lost and the visibility probe could not answer this pass`);
        continue;
      }
      if (visible && proj.teamAccessLost) {
        // Access came back (re-added, or the project was unarchived). Clear the
        // marker so the normal paths resume; backfill refills the archive from
        // the backend, which is the only copy that was ever authoritative.
        delete proj.teamAccessLost;
        util.log(`team access restored for ${key}`);
      }
      // Resolve this team's key (cached per pass across this team's
      // projects), through the same deps the pull side reuses. Any failure
      // logs once per team and pushes plaintext — the push itself must
      // never be lost to a key problem.
      let crypto = null;
      const keyDeps = cryptoCtx && link.teamId
        ? mkTeamKeyDeps(config, creds, link.teamId, cryptoCtx)
        : null;
      if (keyDeps) {
        // Multi-device reconciliation once per team per pass (self-heal my
        // rotated-key rows + re-seal every epoch I hold to members on new
        // devices). Runs before key resolution so a just-dropped stale row is
        // reflected. Guarded so teams with several linked projects heal once.
        cryptoCtx.reconciled = cryptoCtx.reconciled || new Set();
        if (!cryptoCtx.reconciled.has(link.teamId)) {
          cryptoCtx.reconciled.add(link.teamId);
          await reconcileTeamKeys(cryptoCtx.identity, keyDeps);
        }
        try {
          const cur = await resolveCurrentTeamKey(cryptoCtx.identity, keyDeps);
          if (cur) {
            crypto = { teamKey: cur.teamKey, epoch: cur.epoch, teamcrypto: cryptoCtx.teamcrypto, required: true,
              plaintextOff: plaintextOffFor(config) };
          } else {
            warnOnce(cryptoCtx, link.teamId, `team encrypt: no team key for ${link.teamId} — push paused (fail-closed)`);
          }
        } catch (err) {
          warnOnce(cryptoCtx, link.teamId, `team encrypt: team key for ${link.teamId} failed (${err.message}) — push paused (fail-closed)`);
        }
      }
      if (encryptOn && !crypto) {
        // Fail-closed: no usable key means nothing leaves this pass. The
        // cursor is untouched, so held entries push on a later pass. Two very
        // different sub-states, surfaced distinctly so the dashboard is
        // actionable instead of vaguely "unavailable": no crypto context means
        // this device has no key store (can't encrypt at all); a context with
        // no team key means the identity works but no teammate has sealed the
        // current key to this device yet (join-seal — resolves when a teammate
        // next syncs).
        cryptoPausedReason = cryptoCtx
          ? 'waiting for a teammate to share the team key with this device — team push paused'
          : 'encryption key store unavailable on this device — team push paused';
        errors.push(`${key}: team push paused — ${cryptoCtx
          ? 'no team key for this device yet (a teammate must sync to grant it)'
          : 'encryption key store unavailable'} (fail-closed; set team.encrypt=false only if you accept plaintext sync)`);
      } else {
        try {
          await pushProject(config, creds, key, proj, link, crypto);
        } catch (err) {
          // Publishing and reading are INDEPENDENT. A push that cannot land —
          // a wedged batch, a backend refusal — must never cost the user sight
          // of their teammates' work, which is the whole point of team sync.
          // Same best-effort treatment the archive backfill below already
          // gets; the error is still reported, so `status` and the dashboard
          // surface it rather than failing silently.
          errors.push(`${key}: team push failed — ${err.message}${rlsHint(err.message)}`);
          util.log(`team sync: push failed for ${key} (${err.message}) — pull continues`);
        }
      }
      const teamCryptoArg = encryptOn ? { ctx: cryptoCtx, keyDeps, required: true } : null;
      const pulled = await pullProject(config, creds, proj, link, teamCryptoArg);
      synced.push(key);
      if (pulled > 0) {
        proj.dirty = true; // the next injection pass rewrites this project's block
        changed.push(key);
      }
      try {
        // Best-effort, like every other non-critical step in this pass: the
        // backward backfill accelerates search's historical reach but must
        // never be able to break a sync pass. Reuses the same teamCryptoArg
        // (and so the same warnOnce dedupe set) as the forward pull above.
        await backfillArchivePage(config, creds, proj, link, teamCryptoArg);
      } catch (err) {
        util.log(`team archive: backfill page failed for ${key} (${err.message})`);
      }
    } catch (err) {
      errors.push(`${key}: ${err.message}${rlsHint(err.message)}`);
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
  signup, login, oauthAuthorizeUrl, loginWithTokens, clearCredentials, loadCredentials, getAccessToken,
  issueOAuthState, consumeOAuthState, exchangeOAuthCode,
  // Exported for the regression suite only: the TTL test needs to age an
  // issued state without sleeping five minutes.
  _oauthStates: oauthStates,
  ensureIdentity, resolveTeamKey, resolveCurrentTeamKey, encryptRow, entryToRow, isShared, plaintextOffFor,
  buildCryptoContext, classifyAuthFailure, decryptTeamRows, fingerprintReport, trustMember, rekeyTeam, reconcileTeamKeys,
  createTeam, joinTeam, listTeams, linkProject, unlinkProject, pruneTeamEntries, loadTeamLink, repoUrl,
  parseInviteToken, inviteUrl, createInvite, revokeInvite, join,
  listMembers, teamFeed, teamFeedCounts, projectStats, visibleProjectIds, isSoloMachine,
  removeMember, setRole, renameTeam, rotateInvite, leaveTeam,
  archiveProject, unarchiveProject,
  detectAutoLinks, resolveSuggestion,
  syncTeams, reshareSession, pullProject, backfillArchivePage, credentialsPath, teamFilePath,
};
