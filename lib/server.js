'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('./util');
const { getConfig, loadState, saveState, loadUserConfig, saveUserConfig, ensureConfig, isProjectOff, log, effectiveTargets, EXTRA_TARGETS } = require('./util');
const advisor = require('./advisor');
const digest = require('./digest');
const repoRoot = require('./repo-root');
const redact = require('./redact');
const hooks = require('./hooks');
const mcpRegister = require('./mcp-register');
const memorydb = require('./memorydb');
const ledgerStore = require('./ledger-store');
const ledger = require('./ledger');
const { normalizeAvoided, normalizeHoldout, normalizeNotes, normalizeBilled } = require('./ledger-fold-state');
const { MIN_HOLDOUT_FOR_EFFECT } = require('./ledger-fold');
const classify = require('./classify');
// The same machine-local corpus + scorer the MCP tools answer from, so the app
// and an agent searching this machine can never disagree (lib/activity.js).
const activity = require('./activity');
const commits = require('./commits');
const feed = require('./feed');
const { syncOnce, getAdapters, findProjectKey, scanAll, trackedRoots, isTrackedProject, foldWorktreeProjects, resetOffsetsForAdoption } = require('./scan');
const teamsync = require('./teamsync');
const apiAccess = require('./api-access');
const apiInsights = require('./api-insights');
const apiMachine = require('./api-machine');
const teamArchive = require('./team-archive');
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');
const autostart = require('./autostart');
const updateCheck = require('./update-check');
const { z } = require('zod');

// One definition, in util: lib/activity.js has to fold tool names the same way
// when it matches the tool filter, and a second copy here would let the feed's
// dropdown and search's matcher drift apart.
const publicSource = util.publicSource;

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// CSRF defense for the local dashboard API. Binding 127.0.0.1 stops REMOTE
// attackers but not CROSS-SITE ones: any web page the user's browser loads while
// the daemon runs can fire a "simple" form POST at 127.0.0.1:<port> and drive a
// mutating endpoint (e.g. overwrite team.url so the next sync ships the Supabase
// refresh token to an attacker). Browsers always attach an Origin header to such
// cross-origin writes, so we refuse any state-changing method whose Origin is
// present and does not match the Host it was addressed to (comparing hosts, not a
// hardcoded port, so 127.0.0.1 and localhost both work). A missing Origin is a
// non-browser client (the CLI, tests) and is allowed; reads (GET/HEAD) pass since
// no CORS headers are ever set, so a cross-site page cannot read the response.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// SECURITY (DNS rebinding): comparing Origin to Host is not enough on its own.
// An attacker who points a hostname they control at 127.0.0.1 gets a request
// whose Origin and Host are BOTH that hostname — so they match, the gate opens,
// and every endpoint is theirs (the PoC rewrote team.url to redirect the
// Supabase refresh token). The Host itself therefore has to be pinned to
// loopback. This applies to READS too: /api/feed and /api/projects return
// captured prompt text, so a rebound GET is an exfiltration channel even
// though no CORS headers are ever set.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  const bracketed = h.match(/^\[([^\]]+)\](?::\d+)?$/); // [::1]:7437 → ::1
  if (bracketed) return bracketed[1];
  return h.replace(/:\d+$/, '');
}
function localHost(req) {
  return LOOPBACK_HOSTS.has(hostnameOf(req.headers.host));
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; browsers set Origin on cross-site writes
  let originHost;
  try { originHost = new URL(origin).host; } catch (e) { return false; } // "null"/opaque/garbage
  return !!req.headers.host && originHost === req.headers.host;
}

// Only an allowlisted backend may be stored as team.url. This one config field
// decides where the Supabase refresh token is sent on every sync, so accepting
// "any string the dashboard posted" is a token-redirect primitive — it is what
// the rebinding PoC rewrote. https is required for anything off-machine;
// loopback may use http because it cannot leave the host.
const TEAM_URL_HOST_RULES = [/(^|\.)supabase\.co$/i];
function validateTeamUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, url: '' }; // clearing the backend is always allowed
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, error: 'Team backend must be a full URL, e.g. https://<project>.supabase.co' }; }
  const host = u.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) {
    return { ok: false, error: 'Team backend must use https. Anything else sends your session token in the clear.' };
  }
  if (!loopback && !TEAM_URL_HOST_RULES.some(rx => rx.test(host))) {
    return { ok: false, error: `Team backend host not allowed: ${u.hostname}. Use your Supabase project URL (<project>.supabase.co).` };
  }
  return { ok: true, url: s };
}

// The OAuth return leg. Under PKCE, Supabase puts a single-use auth code on the
// query string; under the implicit fallback it puts the session in the URL
// fragment, which only the browser can read. Either way this page forwards
// what came back to the daemon (same-origin POST, so the sameOrigin gate
// passes). It runs either in the popup the dashboard opened (closes itself;
// the opener is polling /api/team) or in the default browser when the desktop
// shell handed the flow off (close() is ignored there, so it leaves a "head
// back to the app" message instead).
//
// SECURITY (audit F1): the `state` the daemon minted for this sign-in rides
// back in the callback URL and is forwarded with the credential material. The
// daemon verifies and consumes it before it looks at a token, so a callback
// the daemon never started, or one replayed, is refused.
//
// Everything is read into locals FIRST and the address bar is then rewritten
// to the bare path, so the code or tokens do not sit in the URL or in browser
// history (the hosted join page does the same, see
// cloudflare/join/public/index.html).
function oauthCallbackPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Signing in - MemBridge</title></head>' +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">' +
    '<div style="text-align:center;padding:32px;max-width:440px">' +
    '<p id="msg" style="font-size:15px">Finishing your GitHub sign-in&hellip;</p>' +
    '<p id="err" style="display:none;color:#b91c1c;font-size:14px;line-height:1.5"></p>' +
    '<a href="/" style="color:#2563eb;font-size:14px">Back to MemBridge</a></div>' +
    '<script>(function () {' +
    'var q = new URLSearchParams(window.location.search);' +
    'var p = new URLSearchParams(window.location.hash.replace(/^#/, ""));' +
    'var state = q.get("state") || p.get("state");' +
    'var code = q.get("code");' +
    'var at = p.get("access_token"), rt = p.get("refresh_token"), ei = p.get("expires_in");' +
    'var oops = q.get("error_description") || q.get("error") || p.get("error_description") || p.get("error");' +
    // Read above, cleared here: nothing sensitive stays in the address bar.
    'try { window.history.replaceState(null, "", window.location.pathname); }' +
    'catch (e) { window.location.hash = ""; }' +
    'function fail(m) {' +
    '  document.getElementById("msg").style.display = "none";' +
    '  var e = document.getElementById("err");' +
    '  e.style.display = "block";' +
    '  e.textContent = m;' +
    '}' +
    'if (oops) { fail(oops); return; }' +
    'if (!code && !at) { fail("No sign-in tokens came back - try again from the dashboard."); return; }' +
    'var payload = code ? { state: state, code: code }' +
    '  : { state: state, accessToken: at, refreshToken: rt, expiresIn: ei };' +
    'fetch("/api/team/oauth-complete", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify(payload)' +
    '}).then(function (r) {' +
    '  return r.json().catch(function () { return {}; }).then(function (d) {' +
    '    if (!r.ok) throw new Error(d.error || "Sign-in failed");' +
    '    document.getElementById("msg").textContent = "You\\u2019re signed in. You can head back to MemBridge.";' +
    '    setTimeout(function () { window.close(); }, 400);' +
    '  });' +
    '}).catch(function (e) { fail(e.message); });' +
    '})();</script></body></html>';
}

// ---- Cutover: serve the rebuilt React UI at / -----------------------------
// ui/dist is a Vite build (base '/'): an index.html shell plus content-hashed
// assets under assets/, served directly at the root now that the legacy
// lib/dashboard/* renderer is deleted (see
// docs/superpowers/specs/CUTOVER-CHECKLIST.md for what was and wasn't
// verified before this cutover). '/app' is kept only as a redirect alias
// (below) so an old bookmark or an in-flight link still resolves.
//
// MEMBRIDGE_UI_DIST_ROOT lets tests point this at an empty/missing directory
// to exercise the "never built" 503 path without touching the real ui/dist,
// which a concurrent `npm run build` elsewhere in this checkout may be
// writing to at the same time. Unset in production; falls back to the real
// build output next to lib/. Read lazily (a function, not a constant) so a
// test setting the env var after this module has already been require()'d
// still takes effect.
const APP_PREFIX = '/app';
function uiDistRoot() {
  return process.env.MEMBRIDGE_UI_DIST_ROOT
    ? path.resolve(process.env.MEMBRIDGE_UI_DIST_ROOT)
    : path.join(__dirname, '..', 'ui', 'dist');
}

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};
function mimeFor(filePath) {
  return STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Maps a request path to an absolute file inside UI_DIST_ROOT, or null if the
// request cannot be proven to stay inside it. This function is the only
// thing standing between a browser and arbitrary files on disk, so it
// decodes percent-encoding itself: a raw '../' is already resolved away by
// the URL parser's own dot-segment normalization before this runs (which
// only ever acts on literal '/' characters), but an encoded '..%2f' survives
// that normalization completely intact and must be caught here, after
// decoding. Backslashes are refused outright — path.join on Windows treats
// '\' as a separator, so an encoded '%5c..%5c..' could walk back out of
// dist on that platform even though this is a URL path, not a filesystem
// one; POSIX would leave a literal backslash in a filename, which ui/dist
// never contains, so refusing it costs nothing there either.
function resolveAppAsset(pathname) {
  const rawRel = pathname || '/';
  let decoded;
  try {
    decoded = decodeURIComponent(rawRel);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(seg => seg !== '' && seg !== '.');
  if (segments.some(seg => seg === '..')) return null;
  const distRoot = uiDistRoot();
  const target = path.join(distRoot, ...segments);
  // Belt-and-suspenders: re-verify the resolved absolute path is still
  // inside the dist root, in case a future change to the segment filtering
  // above ever lets something unexpected through.
  const root = path.resolve(distRoot);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function sendAppFile(res, filePath) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    json(res, 404, { error: 'not found' });
    return;
  }
  // index.html must never be cached — it is what points the browser at the
  // CURRENT content-hashed bundle. The hashed assets are safe to cache
  // forever: any code change always produces a new filename.
  const isShell = path.basename(filePath) === 'index.html';
  res.writeHead(200, {
    'Content-Type': mimeFor(filePath),
    'Cache-Control': isShell ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

function serveAppRequest(pathname, res) {
  const distRoot = uiDistRoot();
  if (!fs.existsSync(distRoot)) {
    // Never throw: a fresh checkout whose ui/ has not been built yet must
    // still answer at / without the daemon crashing on the first request.
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('UI not built. Run: cd ui && npm run build');
    return;
  }
  const asset = resolveAppAsset(pathname);
  if (!asset) return json(res, 404, { error: 'not found' });

  let stat = null;
  try { stat = fs.statSync(asset); } catch {}
  if (stat && stat.isFile()) return sendAppFile(res, asset);

  // Not a real file. A request whose last segment looks like a filename
  // (has an extension) is a genuine 404 — never mask a missing script or
  // stylesheet as the SPA shell, which would hide a real build regression.
  // Anything else is a client-side route (e.g. /team/members): fall back to
  // index.html so the router can take over.
  const lastSegment = pathname.split('/').pop() || '';
  if (/\.[^./]+$/.test(lastSegment)) return json(res, 404, { error: 'not found' });
  sendAppFile(res, path.join(distRoot, 'index.html'));
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sync-loop liveness
// ---------------------------------------------------------------------------
// `running` used to be the literal `true`. It could not say anything else: only
// a live process answers this request at all, so it asserted "the HTTP server
// responded" while the page rendered it as "MemBridge is working". Those are
// different claims, and the gap between them is exactly the state a user opens
// Settings to diagnose — a daemon whose sync loop is wedged answers this
// endpoint instantly and reported a healthy tick forever.
//
// What makes a real answer possible is that the sync loop and this HTTP server
// are the SAME process: bin/membridge.js runs tick() and then calls
// startServer() (its only caller). So the loop's outcome is readable in memory
// here, with no persistence, no new timer and no second process to consult.
// Deliberately NOT written to state.json — that file has no locking, and a
// per-tick write would add another load→work→save window to a file the daemon
// and CLI already race on, to store something that is worthless once the
// process it describes has gone.
//
// tick() also runs once SYNCHRONOUSLY before startServer, so by the time this
// endpoint can answer, a real outcome has been recorded. 'unknown' therefore
// means "not the daemon" (a direct statusPayload() call in a test, say), and it
// reads as not-running on purpose: never claim health that was not observed.
let lastTick = null; // { at: epoch ms, ok: boolean, error: string|null }

// Called by the daemon's tick (bin/membridge.js) on every pass. `ok:false`
// records that the pass THREW; the loop itself is still alive, because the
// catch that reports this keeps it scheduled.
function noteTick(outcome = {}) {
  lastTick = {
    at: Date.now(),
    ok: outcome.ok !== false,
    error: outcome.error ? String(outcome.error) : null,
  };
  return lastTick;
}

// Test seam only: forget the recorded tick (so a suite can assert the
// unobserved 'unknown' state), or plant one at a chosen age (so it can assert
// 'stalled' without waiting out a real interval). Production never calls this.
function _resetTickForTests(planted = null) {
  lastTick = planted;
}

// How stale the newest tick may be before the loop is called stalled. The tick
// is a CHAINED setTimeout — the next pass is scheduled intervalSec after the
// previous one finished, not on a fixed cadence — so legitimate spacing is
// intervalSec plus however long a pass takes. Three intervals, with a floor for
// very short intervals, keeps a slow team-sync pass from being reported as a
// wedged daemon.
const TICK_STALE_FLOOR_MS = 90 * 1000;
function tickStaleAfterMs(config) {
  const intervalMs = Math.max(1, Number((config || {}).intervalSec) || 0) * 1000;
  return Math.max(intervalMs * 3, TICK_STALE_FLOOR_MS);
}

// 'ok'       — a pass completed within the freshness window.
// 'erroring' — the newest pass threw. The loop is alive and its work is failing,
//              which is a different thing from being dead and must not collapse
//              into it.
// 'stalled'  — nothing has completed inside the window. The loop is wedged.
// 'unknown'  — no pass has ever been observed in this process.
function tickHealth(config, now = Date.now()) {
  if (!lastTick) return { state: 'unknown', lastTickAt: null, lastTickError: null, staleForSec: null };
  const ageMs = Math.max(0, now - lastTick.at);
  const stale = ageMs > tickStaleAfterMs(config);
  return {
    state: stale ? 'stalled' : (lastTick.ok ? 'ok' : 'erroring'),
    lastTickAt: new Date(lastTick.at).toISOString(),
    lastTickError: lastTick.error,
    staleForSec: Math.round(ageMs / 1000),
  };
}

function statusPayload() {
  const config = getConfig();
  const state = loadState();
  const projects = Object.entries(state.projects || {});
  let lastSync = null;
  const tools = new Set();
  for (const [, proj] of projects) {
    if (proj.lastSync && (!lastSync || proj.lastSync > lastSync)) lastSync = proj.lastSync;
    for (const e of proj.events || []) tools.add(publicSource(e.source));
  }
  // Solo = nobody ELSE is actually there. A team row you created but nobody has
  // joined is still solo — that is the normal first step of the upgrade flow,
  // and flipping the whole header to "shared" at that moment is wrong.
  // Read from the local team.json links plus the member counts cached by the
  // last sync, never the network: /api/status is polled every few seconds and
  // drives the header chrome, so it must stay offline-cheap and must not flip
  // to "on a team" just because the backend is briefly reachable.
  const solo = teamsync.isSoloMachine(
    projects.map(([key]) => teamsync.loadTeamLink(key)),
    state.teamCounts || {},
    !!teamsync.loadCredentials(),
  );
  const health = tickHealth(config);
  return {
    // Derived, not asserted. True while the sync loop is alive — including when
    // its work is erroring, because the loop IS running and `health` below
    // carries the error. False when the loop has stalled or was never observed,
    // which is what makes a degraded state reachable at all. The shipped client
    // types this as a required boolean and renders it as a running/not-running
    // chip, so it stays a boolean; `health` is the additive field a client can
    // adopt to tell 'stalled' from 'erroring' without guessing.
    running: health.state === 'ok' || health.state === 'erroring',
    health,
    pid: process.pid,
    version: require('../package.json').version,
    intervalSec: config.intervalSec,
    projectCount: projects.length,
    solo,
    // First-run gate. Read from the raw user config (not the merged defaults)
    // so an absent key means "never finished setup" rather than a default that
    // silently suppresses the wizard. Skipping counts as done — the wizard must
    // never re-take the window on someone who dismissed it.
    setupDone: !!((loadUserConfig().setup || {}).completedAt),
    tools: [...tools],
    adapters: getAdapters(config).map(a => a.displayName),
    lastSync,
    teamLastSync: state.teamLastSync || null,
    // What the header E2E badge renders. `enabled` is default-on: only the
    // explicit team.encrypt=false hatch turns it off. `paused` carries the
    // fail-closed reason (no key / unavailable crypto) so the badge can warn
    // instead of falsely reading "encrypted"; `plaintextOff` (also default-on,
    // teamsync.plaintextOffFor) is the ciphertext-only state; `keyAlerts`
    // flags a changed teammate key.
    encryption: {
      enabled: ((config.team || {}).encrypt !== false),
      plaintextOff: teamsync.plaintextOffFor(config),
      paused: state.teamCryptoPaused || null,
      keyAlerts: Array.isArray(state.keyAlerts) ? state.keyAlerts.length : 0,
    },
    // What the header PILL renders. Team push fails closed on an expired
    // session — correct — but silently, so the pill held "Synced · Nh ago"
    // over a team that had received nothing for two days. `paused` carries the
    // reason teamsync classified: 'session-expired' is the user's to fix (sign
    // in), 'backend-unreachable' is transient and the client must not nag
    // about it. `since` is when it broke, not when we last noticed.
    auth: {
      paused: (state.teamAuthPaused || {}).reason || null,
      detail: (state.teamAuthPaused || {}).detail || null,
      since: (state.teamAuthPaused || {}).since || null,
    },
  };
}

// Whether a context file actually contains the managed block. `targets[].exists`
// only says the FILE is there, which is a different question: a CLAUDE.md can
// exist and carry no MemBridge block at all, and that is exactly the silent
// failure the card needs to surface.
//
// The Projects index polls every 5 seconds, so this must not re-read every
// context file on every poll. Cache on (path, mtimeMs, size) and re-read only
// when the file actually moves.
const injectedCache = new Map();
function targetHasBlock(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    injectedCache.delete(filePath);
    return false;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = injectedCache.get(filePath);
  if (hit && hit.stamp === stamp) return hit.injected;
  let injected = false;
  try {
    injected = fs.readFileSync(filePath, 'utf8').includes(digest.BEGIN);
  } catch {}
  injectedCache.set(filePath, { stamp, injected });
  return injected;
}

// Rolling 24h buckets (not calendar days -- the server has no notion of the
// browser's timezone), oldest first, for the Today page's per-project
// sparkline.
//
// INVARIANT: dailyCounts PARTITIONS the same session set memorydb.projectStats
// counts into sessionsThisWeek -- every in-window session lands in EXACTLY
// ONE bucket (the day of its first in-window, non-plumbing event), so
// sum(dailyCounts) === sessionsThisWeek always, by construction. The old
// version counted a session in EVERY bucket it had events in, so a session
// spanning two days made the sparkline sum exceed the total sitting right
// beside it. The predicate below (isPlumbing, Date.parse, t >= weekAgo,
// `ev.session || ''`) is kept identical to projectStats' so the two counts
// can never drift apart.
const DAY_MS = 24 * 60 * 60 * 1000;
function dailySessionBuckets(proj, now) {
  const weekAgo = now - 7 * DAY_MS;
  const firstSeen = new Map(); // session id -> its earliest in-window ts
  for (const ev of proj.events) {
    if (digest.isPlumbing(ev)) continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < weekAgo) continue;
    const sid = ev.session || '';
    const prev = firstSeen.get(sid);
    if (prev === undefined || t < prev) firstSeen.set(sid, t);
  }
  const buckets = Array.from({ length: 7 }, () => 0);
  for (const t of firstSeen.values()) {
    const age = Math.max(0, now - t); // clamp: a future-dated event still gets exactly one (today's) bucket
    buckets[6 - Math.min(6, Math.floor(age / DAY_MS))]++;
  }
  return buckets;
}

function projectsPayload() {
  const config = getConfig();
  const state = loadState();
  const regexes = digest.compileRedactions(config);
  const now = Date.now();
  const out = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = []; // added-but-empty project
    let exists = false;
    try {
      exists = fs.statSync(key).isDirectory();
    } catch {}
    // Lifetime figures, derived in the loop that already walks events.
    // projectStats is week-scoped (sessionsThisWeek) and cannot answer "how
    // much has accumulated here", which is the card's memory-as-an-asset line.
    // Narrative only: token plumbing (usage/read) outnumbers real activity
    // ~7:1 and carries the same session ids, so counting it here would inflate
    // "sessions" without a single extra piece of work having happened.
    const sessionIds = new Set();
    let firstActivity = null;
    for (const ev of proj.events) {
      if (ev.session && !digest.isPlumbing(ev)) sessionIds.add(ev.session);
      if (ev.ts && (!firstActivity || String(ev.ts) < String(firstActivity))) firstActivity = ev.ts;
    }
    // Archived is a FLAG on the one list, not a second list: the UI sections
    // on it without re-fetching. A vanished folder on an archived row is
    // reported (missing), never omitted, so its Unarchive still works.
    const archived = (config.archived || []).includes(key);
    out.push({
      path: key,
      name: path.basename(key),
      exists,
      archived,
      missing: archived && !exists,
      paused: isProjectOff(key, config),
      lastSync: proj.lastSync || null,
      lastActivity: proj.events.length ? proj.events[proj.events.length - 1].ts : null,
      sessionsTotal: sessionIds.size,
      // The new UI's Today page sparkline (spec §7): week-scoped count plus its
      // 7-day daily series, in the same shape projectStats already reports for
      // the project page -- reused rather than a second hand-rolled counter.
      sessionsThisWeek: memorydb.projectStats(key, proj, now).sessionsThisWeek,
      dailyCounts: dailySessionBuckets(proj, now),
      firstActivity,
      // Independent evidence that work is happening here: commits arrive via
      // the git post-commit hook, events via the transcript scan. The card
      // compares the two to tell "nobody is working on this" apart from
      // "MemBridge stopped capturing".
      lastCommit: exists ? commits.lastCommitTs(key) : null,
      tools: [...new Set(proj.events.map(e => publicSource(e.source)))],
      prompts: digest.recentPrompts(proj, config, regexes).reverse(),
      files: digest.recentFiles(key, proj, config),
      targets: effectiveTargets(config).map(t => {
        const full = path.join(key, t);
        const there = exists && fs.existsSync(full);
        return { file: t, exists: there, injected: there && targetHasBlock(full) };
      }),
      team: teamsync.loadTeamLink(key),
      teammateActivity: util.teamRowsFor(proj).length,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

// Per-project token ledgers. Reports TOKENS only -- never a spend figure --
// because MemBridge prices at list-price API rates while many users are on
// flat subscription plans, and a contradicting dollar number would discredit
// every figure beside it.
//
// Read that as a rule about the WIRE, not about the disk. A USD total IS
// computed and written to every user's ledger.json as inCost/outCost, and it
// is withheld from every response. The honest sentence is "computed and
// stored, never served", not "never computed".
//
// Persisting it is deliberate. It is the only thing that lets a
// user-supplied-rate feature reprice history later without re-folding every
// user's ledger from scratch, and dropping it is unrecoverable in a way that
// keeping it is not. Serving it is what would discredit the surface, so the
// gate belongs here at the boundary rather than at the fold.
function savingsPayload() {
  const state = loadState();
  const projects = [];
  const totals = {
    volume: 0, requests: 0, reads: { first: 0, sameSession: 0, crossSession: 0 },
    // Direct avoidance / holdout (spec §7.1/§7.2, Task 6). Tokens only -- no
    // dollar figure is ever computed for these, let alone served (spec
    // §8.1) -- and "avoided", never "saved" (spec §8.2): this measures
    // tokens not loaded, not a claim the bill fell.
    avoided: { tokens: 0, serves: 0, tierA: 0, tierB: 0, partialWins: 0, netNegatives: 0 },
    // Ride-along billed accrual (spec §7.5): the same avoidance as `avoided`
    // accrued over each session's OBSERVED subsequent requests -- measured,
    // not modelled, still tokens (§8.1), still "avoided" (§8.2). A flat
    // sibling so nothing doing §7.1 arithmetic picks it up by accident.
    billed: { tokens: 0 },
    holdout: { skips: 0, callTokens: 0 },
    // Teammate-note injections (spec §9). A FLAT sibling of `avoided`, never a
    // field inside it, because it must never be reachable by anything doing
    // net arithmetic: an injected note is input SPENT, and what it buys -- a
    // mistake nobody made -- this ledger cannot observe. The dashboard renders
    // it on its own line, outside the figure, with one sentence saying why.
    // Any future expression that subtracts this from avoided.tokens is a
    // spec §9 violation, not an improvement.
    notesInjectedTokens: 0,
    // Injection COUNT (as opposed to the token cost above): how many times a
    // teammate note was actually delivered into a session. Added for the
    // assists breakdown (lib/api-insights.js assistsFrom) -- the owner's ask
    // was "any instance where the memory helped", which the token figure
    // cannot answer by itself (one big note and ten small ones cost the same
    // as each other in a way that hides how many separate assists happened).
    // Same flat-sibling-of-avoided rule as notesInjectedTokens: never nest
    // this inside `avoided`, never net it against a token figure.
    notesInjections: 0,
  };
  for (const [projectPath, proj] of Object.entries(state.projects || {})) {
    const led = ledgerStore.readLedger(projectPath);
    if (!led) continue;
    // normalizeAvoided/normalizeHoldout (lib/ledger-fold-state.js) default a
    // ledger that predates Task 6 -- or any other missing/malformed shape --
    // to zero, the same way the fold itself does, instead of a second,
    // hand-rolled "what does absent mean" living here.
    const avoided = normalizeAvoided(led.avoided);
    // Explicit whitelist, not a spread of normalizeHoldout's full result:
    // that result now also carries `seenKeys` (MINOR 3, final whole-branch
    // review -- holdout-row dedupe evidence, the same internal-bookkeeping
    // category as avoided/openServes' own dedupe fields, which this payload
    // already deliberately never projects). Picking the two wire fields by
    // name keeps that bookkeeping off the wire the same way it always has.
    const holdoutFull = normalizeHoldout(led.holdout);
    const holdout = { skips: holdoutFull.skips, callTokens: holdoutFull.callTokens };
    // Same explicit pick as holdout above: `seenKeys` is dedupe bookkeeping and
    // stays off the wire. `injections` now DOES have a surface (see
    // notesInjections in the totals shape above) -- picked off the same
    // normalizeNotes() call rather than a second read of led.notes.
    const notesNormalized = normalizeNotes(led.notes);
    const notesInjectedTokens = notesNormalized.tokens;
    const notesInjections = notesNormalized.injections;
    const billed = normalizeBilled(led.billed);
    projects.push({
      path: projectPath,
      name: (proj && proj.name) || path.basename(projectPath),
      updatedAt: led.updatedAt,
      sessions: led.sessions,
      requests: led.requests,
      volume: led.volume,
      reads: led.reads,
      hotPaths: (led.hotPaths || []).length,
      avoided,
      billed,
      holdout,
      notesInjectedTokens,
      notesInjections,
    });
    totals.volume += led.volume || 0;
    totals.requests += led.requests || 0;
    for (const k of Object.keys(totals.reads)) {
      totals.reads[k] += (led.reads && led.reads[k]) || 0;
    }
    for (const k of Object.keys(totals.avoided)) totals.avoided[k] += avoided[k];
    totals.billed.tokens += billed.tokens;
    for (const k of Object.keys(totals.holdout)) totals.holdout[k] += holdout[k];
    totals.notesInjectedTokens += notesInjectedTokens;
    totals.notesInjections += notesInjections;
  }
  projects.sort((a, b) => b.volume - a.volume);
  // Sufficiency gate (measured-savings spec). The payload says in its own
  // words whether it has enough held-out evidence to support an effect
  // figure, rather than leaving every consumer to re-derive that judgement
  // from raw counts -- and, crucially, reports `null` rather than `0` when it
  // does not. A day-one install's avoided.tokens is genuinely 0, and
  // rendering that as a measured "0% saved" is a claim the evidence does not
  // support. `effect` stays null here in every case: computing the served-
  // versus-withheld difference of means and its confidence interval is the
  // next task's work, and until it lands the honest value is absent, not zero.
  const holdoutCount = totals.holdout.skips;
  const measurement = {
    state: holdoutCount >= MIN_HOLDOUT_FOR_EFFECT ? 'sufficient' : 'measuring',
    holdoutCount,
    minHoldoutCount: MIN_HOLDOUT_FOR_EFFECT,
    effect: null,
  };
  return { projects, totals, measurement };
}

// ---- Tier 1: measured spend (measured-savings spec) ----
// The one payload in this file where NOTHING is estimated. Every number here
// traces to a vendor-reported `message.usage` object the adapters already
// ingest, normalised once by lib/usage-normalize.js. That is the whole point:
// the savings surface positions its modelled figures AGAINST this, so if a
// single number here were derived from chars/4 the comparison would be
// circular and the page would be dishonest.
//
// Kept deliberately separate from savingsPayload(): that one reports the
// ledger's own bookkeeping (avoided, holdout, notes), which is a different
// provenance class. Measured and estimated never share a payload, for the
// same reason the spec says they never share a row.
const emptySpend = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

function addSpend(into, r) {
  into.input += r.input;
  into.output += r.out;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.requests += 1;
}

// The viewer-local calendar day, matching ui/src/data/localTime.ts's
// localDayKey. `toISOString().slice(0, 10)` is the bug this avoids: it is
// always a UTC day, which showed anyone west of Greenwich tomorrow's date all
// evening. The daemon and the UI run on the same machine, so the daemon's
// local day IS the viewer's local day.
function localDayKey(d) {
  return `${String(d.getFullYear()).padStart(4, '0')}-`
    + `${String(d.getMonth() + 1).padStart(2, '0')}-`
    + `${String(d.getDate()).padStart(2, '0')}`;
}

function measuredSpendPayload() {
  const state = loadState();
  const projects = [];
  const totals = emptySpend();
  for (const [key, proj] of Object.entries((state && state.projects) || {})) {
    const events = Array.isArray(proj && proj.events) ? proj.events : [];
    // buildRequests owns request identity and dedupe: one API response is
    // written as several transcript records repeating the same usage object,
    // and counting those siblings would inflate measured spend by roughly
    // 57%. Reusing it rather than re-deriving the rule keeps this payload and
    // the ledger agreeing about what "a request" is.
    let requests;
    try {
      requests = ledger.buildRequests(events.filter(e => e && e.kind === 'usage'));
    } catch {
      requests = []; // degrade, never throw: a malformed history yields no spend, not a 500
    }
    const tokens = emptySpend();
    const days = new Map();
    const sessions = new Map();
    for (const r of requests) {
      // A record whose usage carried nothing usable contributes nothing at
      // all -- not a zero-token request. normalizeUsage coerces junk (strings,
      // negatives, nulls) to 0, so an all-zero result is indistinguishable
      // from a record that never had usage, and both must be skipped rather
      // than counted as a request that happened to cost nothing.
      if (!(r.input || r.out || r.cacheRead || r.cacheWrite)) continue;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t)) continue; // cannot be attributed to a day
      addSpend(tokens, r);
      const dayKey = localDayKey(new Date(t));
      let day = days.get(dayKey);
      if (!day) days.set(dayKey, (day = emptySpend()));
      addSpend(day, r);
      // Sessions are keyed only when the record actually names one. A session
      // that produced no usage record never reaches this loop, so it is
      // ABSENT from the cohort rather than present as a zero -- counting it
      // as zero would drag every mean the comparison rests on toward zero.
      if (r.session) {
        let s = sessions.get(r.session);
        if (!s) sessions.set(r.session, (s = emptySpend()));
        addSpend(s, r);
      }
    }
    if (!tokens.requests) continue; // a project with no measured usage is absent, not zero
    projects.push({
      path: key,
      name: (proj && proj.name) || path.basename(key),
      tokens,
      days: Array.from(days.entries())
        .map(([day, t]) => ({ day, tokens: t }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      sessions: Array.from(sessions.entries())
        .map(([session, t]) => ({ session, tokens: t }))
        .sort((a, b) => b.tokens.requests - a.tokens.requests),
    });
    for (const k of Object.keys(totals)) totals[k] += tokens[k];
  }
  projects.sort((a, b) =>
    (b.tokens.input + b.tokens.cacheRead + b.tokens.cacheWrite)
    - (a.tokens.input + a.tokens.cacheRead + a.tokens.cacheWrite));
  return { projects, totals };
}

// Unified cross-project, cross-team feed. Local memory is always available;
// each team is fetched independently so one unreachable team degrades to a
// flag instead of failing the whole feed.
async function feedPayload(opts) {
  const config = getConfig();
  const state = loadState();
  // Identity metadata reads fine straight off disk, but the crypto path below
  // makes authenticated calls: a stale access token fails identity bootstrap
  // and renders EVERY team row opaque — indistinguishable from tampering, and
  // the reason a lapsed login looked like broken encryption. Refresh like
  // every other authenticated call (same fix as reshareSession), degrading to
  // the stored creds rather than throwing, so an unreachable backend still
  // returns the local feed instead of no feed at all.
  let creds = teamsync.loadCredentials();
  try {
    const fresh = await teamsync.getAccessToken(config);
    if (fresh) creds = fresh;
  } catch (err) {
    log(`team: access token refresh failed (${err.message}), using the stored token`);
  }
  const selfUserId = creds ? creds.userId : null;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  // One clock for the whole payload, so every entry's live flag is judged
  // against the same instant however long the team fetches take. opts.now is
  // an ISO string where callers pass it (same injection point `window` uses);
  // util.isLive wants epoch ms.
  const feedNow = opts.now ? Date.parse(opts.now) : Date.now();
  // Rolling-window floor for page one (the Activity view's "always show the
  // last 24 hours"): opts.window is hours (capped at a week), and buildFeed
  // grows the page past `limit` until the window is covered. Ignored on a
  // before= page — View more walks older history, where the floor would
  // re-inflate every page back to the window size. `now` is injectable so
  // tests can pin the clock against fixed fixture timestamps.
  const windowStart = (Number.isFinite(opts.window) && opts.window > 0 && !opts.before)
    ? new Date(new Date(opts.now || Date.now()).getTime() - Math.min(opts.window, 168) * 3600000).toISOString()
    : null;
  // One compiled redactor for the whole payload, threaded into the
  // normalizers: team rows are server content and must be re-redacted before
  // they surface (defense in depth against a hostile or legacy backend row,
  // same rule as the context-block render path); local entries arrive
  // pre-redacted from buildEntries, so their pass is defensive only.
  const regexes = digest.compileRedactions(config);
  const redact = text => digest.redactText(text, regexes);

  // Local: every watched project's entries, tagged with project identity.
  const local = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = [];
    const link = teamsync.loadTeamLink(key);
    // Newest event of ANY kind per session, for the live flag feed.js stamps.
    // Built from proj.events rather than from the entries below because a
    // session that is still running may not have landed a new entry recently
    // -- ten minutes of file edits produce events but no new prompt/summary,
    // and judging that session dead is exactly the flicker this avoids.
    const lastEventBySession = new Map();
    for (const ev of proj.events) {
      if (!ev || !ev.session || !ev.ts) continue;
      const prev = lastEventBySession.get(ev.session);
      if (!prev || String(ev.ts) > String(prev)) lastEventBySession.set(ev.session, ev.ts);
    }
    const meta = { projectPath: key, projectName: path.basename(key), projectId: link ? link.projectId : null, authorId: selfUserId, redact, lastEventBySession, now: feedNow };
    for (const e of classify.filterShareableEntries(memorydb.buildEntries(key, proj, config, { deferChanges: true }), proj.events)) {
      local.push(feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta));
    }
  }

  // Team: team_feed RPC per membership, fetched concurrently. Any failure ->
  // degrade (flag), never throw; a non-array teams response degrades too.
  // team_feed's p_project is a uuid; the client may filter by a local path
  // (.fproj navigation, Settings list, and Home chips for local-only projects
  // all use `#project=/abs/path`). Resolve a path to its linked team-project
  // uuid; an unlinked local project has no team rows, so skip the team query
  // rather than sending a bad uuid (which Postgres rejects, degrading the feed).
  let teamProject = opts.project || null;
  let skipTeam = false;
  if (opts.project && path.isAbsolute(opts.project)) {
    const link = teamsync.loadTeamLink(opts.project);
    if (link && link.projectId) teamProject = link.projectId;
    else { skipTeam = true; }
  }

  let team = [];
  let teamUnavailable = false;
  let teamList = [];
  if (creds && !skipTeam) {
    let teams = [];
    try {
      teams = await teamsync.listTeams(config);
    } catch { teamUnavailable = true; }
    teamList = Array.isArray(teams) ? teams : [];
    if (teams != null && !Array.isArray(teams)) teamUnavailable = true;
    // NOTE: team pagination here is the accepted "approximate seam" (plan
    // out-of-scope: true unified cursor). We pass beforeCreatedAt only (no
    // beforeId), and `before` is an entry ts not a created_at, so team rows
    // sharing the exact boundary created_at may be skipped on Load more. The
    // local source is lossless (inclusive <=); the cross-source seam is not.
    // The person filter passes a display NAME, but team_feed's p_author is a
    // UUID (author_id). Passing a name there is a type error that fails the whole
    // team query (shows "sync unreachable"). So only forward author to the RPC
    // when it is a real UUID; a name is applied to team rows by name below.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rpcAuthor = opts.author && UUID_RE.test(opts.author) ? opts.author : null;
    // Window mode team coverage: the base fetch stays at `limit` — the
    // Activity view polls every 5s and most windows fit well inside a page,
    // so the steady state must not pay a bigger fetch + decrypt. Only when a
    // team's page comes back full AND its oldest row is still inside the
    // window (deeper window rows were cut off) does a second, since-bounded
    // fetch at the RPC cap (200) top the window up. A team with >200 rows
    // inside the window still truncates — the same accepted approximate seam
    // as the cursor above.
    const settled = await Promise.allSettled(teamList.map(async t => {
      const baseOpts = {
        author: rpcAuthor, project: teamProject, source: opts.source,
        beforeCreatedAt: opts.before || null, since: opts.since || null, limit,
      };
      const rows = await teamsync.teamFeed(config, t.team_id, baseOpts);
      if (!windowStart || !Array.isArray(rows) || rows.length < limit) return rows;
      const oldest = rows[rows.length - 1];
      if (!oldest || String(oldest.ts) < windowStart) return rows;
      // A caller-supplied since= inside the window stays the tighter bound.
      const topUpSince = opts.since && String(opts.since) > windowStart ? opts.since : windowStart;
      const topUp = await teamsync.teamFeed(config, t.team_id, { ...baseOpts, since: topUpSince, limit: 200 });
      const have = new Set(rows.map(r => r.id));
      return rows.concat((Array.isArray(topUp) ? topUp : []).filter(r => !have.has(r.id)));
    }));
    // E2E feed rewrite: with encryption on (the default), team rows are
    // decrypted LOCALLY before normalization — the server's readable columns
    // are never trusted for a ciphertext row (fail-closed: an undecryptable
    // row renders opaque). The explicit encrypt:false hatch keeps the legacy
    // plaintext read.
    const feedEncryptOn = (((config || {}).team || {}).encrypt !== false);
    const feedCryptoCtx = feedEncryptOn && creds
      ? await teamsync.buildCryptoContext(config, creds, { cryptoDeps: opts.cryptoDeps })
      : null;
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        let rows = r.value || [];
        if (feedEncryptOn) rows = await teamsync.decryptTeamRows(config, creds, teamList[i].team_id, rows, feedCryptoCtx);
        for (const row of rows) team.push(feed.normalizeTeam(row, { selfUserId, redact, now: feedNow }));
      } else {
        teamUnavailable = true;
      }
    }
    // Author name filter for team rows (RPC filtered by uuid only, or not at all).
    if (opts.author && !UUID_RE.test(opts.author)) {
      team = team.filter(e => e.author === opts.author || e.authorId === opts.author);
    }
  }

  // Drop the self-authored team rows that are this machine's own local entries
  // coming back from the backend. The rule, and the three ways loosening it
  // deletes real history, live in feed.dropSelfTwins; it matches on the parsed
  // INSTANT rather than the ts string because PostgREST does not return the
  // spelling that was pushed (see feed.instantKey).
  team = feed.dropSelfTwins(local, team);

  // Client-side filters also apply to local rows (team rows already filtered by
  // the RPC). The `before` boundary is INCLUSIVE (<=) so same-second entries at
  // a page edge are never dropped on "Load more"; the client dedupes the
  // one-entry overlap when appending pages.
  const f = local.filter(e =>
    (!opts.author || e.author === opts.author || e.authorId === opts.author) &&
    (!opts.project || e.projectPath === opts.project || e.projectId === opts.project) &&
    (!opts.source || publicSource(e.source) === opts.source) &&
    (!opts.since || String(e.ts) >= String(opts.since)) &&
    (!opts.before || String(e.ts) <= String(opts.before)));

  // Pending auto-link suggestions (a teammate linked a project sharing this
  // git remote) awaiting confirm/dismiss — surfaced atop the Home feed.
  const suggestions = Object.entries(state.projects || {}).map(([projectPath, proj]) => {
    const s = proj && proj.teamSuggestion;
    if (!s || teamsync.loadTeamLink(projectPath)) return null;
    return { path: projectPath, name: path.basename(projectPath), teamName: s.teamName, repoUrl: s.repoUrl };
  }).filter(Boolean);

  // Home reads these lightweight flags to pick its empty / no-team state and
  // its suggested-links card without a second round-trip to /api/team.
  const out = feed.buildFeed({ local: f, team, teamUnavailable, limit, windowStart });
  // Deferred git-change derivation: buildEntries skipped deriveChanges for every
  // project above; run it now ONLY for the local entries that survived the page
  // slice, so a 5s poll spawns git for ~limit entries instead of every entry of
  // every project. deriveEntryChanges clips+redacts each note; the extra redact
  // mirrors normalizeLocal's defensive re-redact of inline changes (idempotent).
  for (const e of out.entries) {
    if (e.origin === 'local' && e._highlights) {
      e.changes = memorydb.deriveEntryChanges(e.projectPath, e.files, e._highlights, regexes)
        .map(c => (c.note ? { ...c, note: redact(c.note) } : c));
    }
    if (e._highlights) delete e._highlights;
  }
  // Display names resolved onto the served page, from each account's newest
  // snapshot rather than the one frozen onto each row at push time. The
  // team_feed RPC returns author_name, but that column is a push-time snapshot
  // just like the cached rows' — an account whose two installs are configured
  // with different display names renders as two people right here in the feed.
  // Resolved on the way out, alongside the deferred-change pass above, and NOT
  // inside feed.normalizeTeam: see lib/activity.js applyAuthorNames for why
  // (the memoized-normalizer freeze). Only rows carrying an author_id can be
  // resolved; rows pulled before that was stored keep their frozen name.
  activity.applyAuthorNames(out.entries, activity.authorNames(state, config));
  // When a team is unreachable, the live team_feed rows are gone, but each
  // project cached its last-pulled teammate entries. Derive distinct author
  // names from that cache so the offline headline can still say who was active
  // instead of "unavailable". Empty when the feed is healthy.
  let offlineTeammates = [];
  if (teamUnavailable) {
    const names = new Set();
    for (const proj of Object.values(state.projects || {})) {
      for (const e of util.teamRowsFor(proj)) {
        if (e && e.author && e.author !== 'You') names.add(e.author);
      }
    }
    offlineTeammates = [...names];
  }
  // One digest per author per LOCAL calendar day, spanning every project that
  // person touched (lib/digest.js buildDayDigests explains the rule and why it
  // cannot be composed client-side).
  //
  // Derived from the SERVED PAGE, on read, and stored nowhere. Two consequences,
  // both deliberate:
  //   * the digest can never describe an entry the client does not have, so a
  //     card and its sentence cannot disagree; and
  //   * there is no cached copy to go stale, which is why this needs no schema
  //     change and no migration. Every field it reads (headline, summary,
  //     distilled, session, ts) is already on the wire.
  // `nextBefore` is passed so the one day the page may have cut in half says so
  // rather than presenting a partial day as a whole one.
  const dayDigests = digest.buildDayDigests(out.entries, { truncatedBefore: out.nextBefore });
  return { ...out, dayDigests, signedIn: !!creds, hasTeam: teamList.length > 0, suggestions, offlineTeammates };
}

// One session, unsliced and uncollapsed, for the session detail page (spec:
// docs/superpowers/specs/2026-07-31-session-detail-page-design.md). The feed
// is the wrong source: /api/feed returns page-sliced, checkpoint-collapsed
// entries, so a session reconstructed from loaded pages silently truncates.
// Local sessions are assembled from memorydb.buildEntries for the owning
// project; team-origin sessions from the pulled cache (util.teamRowsFor).
// Every free-text field passes the same digest.redactText closure /api/feed
// uses -- a session page must never surface a secret the feed suppressed.
// Returns null for an unknown or evicted id (the route answers 404).
function sessionPayload(id) {
  const config = getConfig();
  const state = loadState();
  const regexes = digest.compileRedactions(config);
  const redactText = text => (text ? digest.redactText(text, regexes) : text);
  const uniqueFiles = lists => {
    const out = [];
    for (const list of lists) for (const f of (Array.isArray(list) ? list : [])) {
      if (!out.includes(f)) out.push(f);
    }
    return out;
  };

  // Local first: your own copy of a session always beats a pulled twin (it
  // carries the verbatim prompts and the checkpoint trail).
  for (const [key, proj] of Object.entries(state.projects || {})) {
    const events = Array.isArray(proj.events) ? proj.events : [];
    const sessEvents = events.filter(e => e && (e.session || '') === id);
    if (!sessEvents.length) continue;
    // Unsliced: maxEntries must not evict this session's own older prompts.
    // deferChanges skips the whole-project git pass; only the rep entry's
    // change model is derived below (same deferral /api/feed uses).
    const entries = memorydb
      .buildEntries(key, proj, { ...config, maxEntries: Number.MAX_SAFE_INTEGER }, { deferChanges: true })
      .filter(e => (e.session || '') === id);
    if (!entries.length) continue;
    // The representative entry: buildEntries' checkpoint collapse leaves at
    // most one summary-bearing entry per session -- the settled brief.
    const rep = [...entries].reverse().find(e => e.summary) || entries[entries.length - 1];
    const changes = rep._highlights
      ? memorydb.deriveEntryChanges(key, rep.files, rep._highlights, regexes)
          .map(c => (c.note ? { ...c, note: redactText(c.note) } : c))
      : (Array.isArray(rep.changes) ? rep.changes.map(c => (c.note ? { ...c, note: redactText(c.note) } : c)) : []);
    // Extreme timestamps over EVERY event kind, not just entries: a session
    // that ended on a file edit ends at that edit. Same rule as the feed's
    // lastEventBySession, so `live` here can never disagree with the feed.
    let startedAt = null, endedAt = null;
    for (const ev of sessEvents) {
      if (!ev.ts) continue;
      if (!startedAt || String(ev.ts) < String(startedAt)) startedAt = ev.ts;
      if (!endedAt || String(ev.ts) > String(endedAt)) endedAt = ev.ts;
    }
    const checkpoints = digest.sessionSummaries(events, id)
      .map(ev => ({ ts: ev.ts, text: redactText(digest.plainText(ev.text || '')) }));
    // Newest-first and NOT collapsed -- every prompt entry of the session,
    // with its unclipped ask where buildEntries kept one. buildEntries output
    // is already redacted; this pass is defensive and idempotent, mirroring
    // normalizeLocal.
    const prompts = entries.map(e => ({
      ts: e.ts,
      ask: (e.askFull || e.ask) ? redactText(e.askFull || e.ask) : null,
      files: Array.isArray(e.files) ? e.files.slice() : [],
    })).reverse();
    const creds = teamsync.loadCredentials();
    // Commits this session produced, for the detail page's analytics header.
    // Attribution is already settled in .membridge/commits.jsonl (lib/commits
    // attributes a commit's files to the session that last edited them), so
    // this only counts. Absent rather than 0 when the map cannot be read: a
    // session that genuinely produced no commits is a real 0, and reporting
    // the same number for "could not count" would make the tile lie.
    let commitCount;
    try {
      commitCount = commits.loadCommitMap(key)
        .filter(r => r && Array.isArray(r.sessions) && r.sessions.includes(id)).length;
    } catch {
      commitCount = undefined;
    }
    return {
      session: id,
      project: path.basename(key),
      projectPath: key,
      author: 'You',
      ...(commitCount === undefined ? {} : { commits: commitCount }),
      authorId: creds ? creds.userId : null,
      source: rep.source || '',
      startedAt,
      endedAt,
      live: util.isLive(endedAt, Date.now()),
      summary: redactText(rep.summary) || null,
      summaryFull: redactText(rep.summaryFull) || null,
      goal: redactText(rep.goal) || null,
      headline: redactText(rep.headline) || null,
      decisions: redactText(rep.decisions) || null,
      gotchas: redactText(rep.gotchas) || null,
      files: uniqueFiles(entries.map(e => e.files)),
      changes,
      checkpoints,
      prompts,
    };
  }

  // Team-origin: the pulled cache holds one row per pushed entry. Rows are
  // server content stored raw at pull time, so everything is re-redacted. An
  // unshared prompt is ask=null on the wire and STAYS null here -- the
  // endpoint never fabricates a prompt it does not hold ("(prompt not
  // shared)" is a render concern). No checkpoint trail crosses team sync.
  for (const [key, proj] of Object.entries(state.projects || {})) {
    const rows = util.teamRowsFor(proj).filter(r => r && (r.session || '') === id);
    if (!rows.length) continue;
    const sorted = rows.slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const rep = [...sorted].reverse().find(r => r.summary) || sorted[sorted.length - 1];
    const endedAt = sorted[sorted.length - 1].ts || null;
    // Team rows ship their full summary text in `summary` (push clips at the
    // source), so the detail header's summaryFull is the same text.
    const summaryFull = redactText(rep.summary) || null;
    return {
      session: id,
      project: path.basename(key),
      projectPath: key,
      author: rep.author || '',
      authorId: null,
      source: rep.source || '',
      startedAt: sorted[0].ts || null,
      endedAt,
      live: util.isLive(endedAt, Date.now()),
      summary: summaryFull,
      summaryFull,
      goal: redactText(rep.goal) || null,
      headline: redactText(rep.headline) || null,
      decisions: redactText(rep.decisions) || null,
      gotchas: redactText(rep.gotchas) || null,
      files: uniqueFiles(sorted.map(r => r.files)),
      changes: Array.isArray(rep.changes)
        ? rep.changes.map(c => (c.note ? { ...c, note: redactText(c.note) } : c))
        : [],
      checkpoints: [],
      // undecryptable rides along per prompt (fail-closed E2E, same marker
      // lib/feed.js propagates): content is null because this client could
      // not decrypt the row, and the page must render an encrypted state --
      // never "(prompt not shared)", which claims an author choice.
      prompts: sorted.map(r => ({
        ts: r.ts,
        ask: r.ask ? redactText(r.ask) : null,
        files: Array.isArray(r.files) ? r.files.slice() : [],
        ...(r.undecryptable ? { undecryptable: true } : {}),
      })).reverse(),
    };
  }

  return null;
}

// Read-only discovery view (dashboard equivalent of `membridge scan`): which
// adapters/session directories exist, and which projects have AI activity.
// Mirrors cmdScan's fresh-state pass exactly — nothing is persisted, so
// this must only run when the user opens the view, never on a poll timer.
function scanPayload() {
  const config = getConfig();
  const adapters = [];
  for (const a of getAdapters(config)) {
    for (const root of a.sessionRoots(config)) {
      adapters.push({ displayName: a.displayName, root, exists: fs.existsSync(root) });
    }
  }
  const state = { files: {}, projects: {} }; // fresh: scan everything from byte 0
  const events = scanAll(state, config);
  digest.mergeEvents(state, events, config);
  // Same fold syncOnce does: a git worktree is a checkout of a repo, not a
  // separate project, so `.worktrees/<branch>` fragments merge back into the
  // main repo they were spun off. Without this the discovered list is mostly
  // worktrees, and adopting one would start writing a memory block into a
  // throwaway checkout. Runs after mergeEvents so both the fragment and its
  // main repo are present as keys — fold only ever merges into an existing one.
  foldWorktreeProjects(state, config);
  // Discovery is ungated, but INGESTION is not: syncOnce drops every session
  // whose project is not tracked (scan.filterTrackedSessions). So a project can
  // show up here with real activity and still contribute nothing until it is
  // adopted. Mark that difference so the dashboard can offer to adopt, using
  // the same predicate the gate itself uses.
  const roots = trackedRoots(loadState());
  const projects = Object.entries(state.projects).map(([key, proj]) => {
    const bySource = {};
    for (const e of proj.events) {
      const src = publicSource(e.source);
      bySource[src] = (bySource[src] || 0) + 1;
    }
    return {
      path: key,
      name: path.basename(key),
      paused: isProjectOff(key, config),
      tracked: isTrackedProject(key, roots),
      // "How much work is here" drives the adoption pre-selection, so it must
      // count narrative events only — token plumbing would rank projects by
      // how many API calls they made, not by how much happened in them.
      sessionCount: proj.events.filter(e => !digest.isPlumbing(e)).length,
      bySource,
    };
  });
  const untracked = projects.filter(p => !p.tracked).length;
  return { adapters, projectCount: projects.length, untrackedCount: untracked, projects };
}

// ---------------------------------------------------------------------------
// Two small lookups the team audit routes need. Both are best-effort by
// design: an audit row is a record of something that already happened, so a
// backend hiccup here must degrade the row's labelling, never fail or undo
// the action the user asked for.
// ---------------------------------------------------------------------------

// The ?teamId= a team-scoped GET was asked about, or null for "whichever is
// first". Never trusted as authorization: apiAccess.selectTeam matches it
// against the caller's OWN team list (RLS-scoped), so an id they are not a
// member of finds nothing and the endpoint answers empty or 403.
const selectedTeamId = url => String(url.searchParams.get('teamId') || '').trim() || null;

// This machine's team, for a route whose body doesn't name one. The same
// teams[0] simplification every other team read in this daemon makes.
async function firstTeamId() {
  const teams = await teamsync.listTeams(getConfig()).catch(() => []);
  const team = (teams || [])[0];
  return team ? team.team_id : null;
}

// A member's display name while they are still ON the roster. Null (never a
// guess, and never the raw id dressed up as a name) when it can't be read.
async function memberDisplayName(teamId, userId) {
  const members = await teamsync.listMembers(getConfig(), teamId).catch(() => []);
  const found = (members || []).find(m => m && m.user_id === userId);
  return found && found.display_name ? found.display_name : null;
}

const planPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'plan.json');

function loadPlan(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Fold a shared project's cached teammate entries into the roadmap's recent
// asks so the plan reflects the whole team's recent work, not just this
// machine's. Deduped on source|ts|ask, sorted oldest-first, capped like the
// local-only path was. teamEntries carry no tasks/checkpoints (out of scope) —
// only ts/source/ask/files/summary survive into the prompt. A teammate entry's
// `ask` can be null (memory_entries.ask is nullable) — fall back to its
// summary, and drop entries where both are empty so a literal "null" never
// reaches the prompt.
function mergeRecentAsks(key, proj, config) {
  // deferChanges: buildPlanPrompt reads only ts/source/ask/files/summary, never
  // `changes`, so skip the git-subprocess derivation entirely here. Strip the
  // deferred _highlights so the merged asks keep the exact shape they had before.
  const local = memorydb.buildEntries(key, proj, config, { deferChanges: true });
  for (const e of local) delete e._highlights;
  const team = util.teamRowsFor(proj)
    .map(e => ({
      ts: e.ts,
      source: publicSource(e.source),
      ask: e.ask || e.summary || '',
      files: Array.isArray(e.files) ? e.files : [],
      summary: e.summary || undefined,
      author: e.author,
    }))
    .filter(e => e.ask);
  const seen = new Set();
  const merged = [];
  for (const e of [...local, ...team]) {
    const k = `${e.source}|${e.ts}|${e.ask}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
  }
  merged.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return merged.slice(-20);
}

// Exactly what a roadmap request sends to Anthropic — and nothing else:
// project name, the goal, already-redacted recent asks, file paths, and
// top-level names. Never file contents, never other projects. The Plan tab
// lists this verbatim next to the Generate button.
function planPayload(key, proj, config, goal) {
  const regexes = digest.compileRedactions(config);
  return {
    projectName: path.basename(key),
    goal: digest.redactText(String(goal || ''), regexes).slice(0, 2000),
    recentAsks: mergeRecentAsks(key, proj, config),
    topLevel: memorydb.topLevelNames(key, config),
  };
}

// Everything the project page needs in one payload: fuller history than the
// grid cards — entries carry which files each ask touched — plus injection
// targets and whether a memory.md exists to link to.
function projectDetail(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return null;
  if (!Array.isArray(proj.events)) proj.events = [];
  let exists = false;
  try {
    exists = fs.statSync(key).isDirectory();
  } catch {}
  const adv = advisor.getAdvisorConfig(config);
  const rx = digest.compileRedactions(config);
  const teamEntries = util.teamRowsFor(proj);
  const localLast = proj.events.length ? proj.events[proj.events.length - 1].ts : null;
  const teamLast = teamEntries.reduce((m, e) => (!m || String(e.ts) > String(m) ? e.ts : m), null);
  const lastTouched = [localLast, teamLast].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
  // The page shows the last 50 entries. Defer git-change derivation past the
  // slice so git runs for 50 entries, not all of them — this payload is fetched
  // per project on the 5s Home poll. Uses the page's already-compiled regexes.
  const shownEntries = memorydb.buildEntries(key, proj, config, { deferChanges: true }).slice(-50);
  for (const e of shownEntries) {
    if (e._highlights) {
      e.changes = memorydb.deriveEntryChanges(key, e.files, e._highlights, rx);
      delete e._highlights;
    }
  }
  return {
    hasKey: !!adv.apiKey,
    plan: loadPlan(key),
    estimate: {
      model: adv.model,
      costUsd: advisor.estimateCost(adv.model, advisor.buildPlanPrompt(planPayload(key, proj, config, '')).length),
    },
    path: key,
    name: path.basename(key),
    exists,
    paused: isProjectOff(key, config),
    lastSync: proj.lastSync || null,
    lastActivity: localLast,
    lastTouched,
    activeLabel: digest.relativeLabel(lastTouched),
    stats: memorydb.projectStats(key, proj),
    tools: [...new Set(proj.events.map(e => publicSource(e.source)))],
    entries: shownEntries,
    // Pulled teamEntries are server content stored raw at pull time; re-redact
    // the free text before it crosses the local HTTP boundary, same rule as
    // the feed routes and the context-block render.
    teamEntries: teamEntries.slice(-50).map(e => ({
      ...e,
      ask: e.ask ? digest.redactText(e.ask, rx) : e.ask,
      summary: e.summary ? digest.redactText(e.summary, rx) : e.summary,
      goal: e.goal ? digest.redactText(e.goal, rx) : e.goal,
      decisions: e.decisions ? digest.redactText(e.decisions, rx) : e.decisions,
      gotchas: e.gotchas ? digest.redactText(e.gotchas, rx) : e.gotchas,
      changes: Array.isArray(e.changes) ? e.changes.map(c => ({ ...c, note: c.note ? digest.redactText(c.note, rx) : c.note })) : [],
    })),
    team: teamsync.loadTeamLink(key),
    // Spec §6: the human surface for live teammate decisions. This page already
    // polls every 5s, so a decision is visible within seconds of the pull with
    // no new endpoint and no new mechanism. The index's own redaction is
    // defaults-only, so the free text is re-run through the user's configured
    // patterns here, exactly as teamEntries above are — a new surface must not
    // quietly exempt itself from a rule the user set.
    // The kill switch (config.teammateNotes.enabled === false) disables all
    // five delivery points, and this is delivery point 1 -- so it has to be
    // checked HERE, not only in the hooks. Turning a feature off after using it
    // is the normal case, so an index is already on disk by then and nothing
    // ever deletes it: without this gate an opted-out user kept seeing their
    // teammates' decisions on the project page indefinitely, while every agent
    // surface had gone quiet. An empty payload (never null) so the card simply
    // renders nothing, exactly as it does for a project with no notes yet.
    // The kill switch is not the only gate. The index is a DERIVED copy of the
    // teamEntries re-redacted above, so util.teamRowsFor — which those go
    // through, and which fails closed on teamAccessLost — structurally cannot
    // cover it. Without the second gate this card kept listing a revoked or
    // unlinked project's teammate decisions while the Projects grid described
    // the same project as private.
    teammateNotes: (() => {
      if (!notes.isNotesEnabled(config)) return { fresh: [], total: 0 };
      if (!util.mayServeTeammateNotes(key, proj)) return { fresh: [], total: 0 };
      const p = notes.dashboardPayload(notesStore.read(key), new Date().toISOString());
      return { ...p, fresh: p.fresh.map(n => ({ ...n, text: digest.redactText(n.text, rx) })) };
    })(),
    files: digest.recentFiles(key, proj, { ...config, maxFiles: 20 }),
    targets: effectiveTargets(config).map(t => ({
      file: t,
      exists: exists && fs.existsSync(path.join(key, t)),
    })),
    memory: {
      relPath: `${memorydb.DIR_NAME}/memory.md`,
      exists: fs.existsSync(memorydb.mdPath(key)),
    },
  };
}

// Read-only view of the project's own memory log. The served path is derived
// from a tracked project key — never from the raw query — so this cannot be
// pointed at arbitrary files.
function memoryMdPayload(projectPath) {
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  if (!key) return null;
  try {
    return fs.readFileSync(memorydb.mdPath(key), 'utf8');
  } catch {
    return null;
  }
}

// Toggle pause by adding/removing the exact project path in config exclude.
function toggleProject(projectPath) {
  ensureConfig();
  const raw = loadUserConfig();
  raw.exclude = raw.exclude || [];
  const idx = raw.exclude.indexOf(projectPath);
  if (idx === -1) raw.exclude.push(projectPath);
  else raw.exclude.splice(idx, 1);
  saveUserConfig(raw);
  return { path: projectPath, paused: idx === -1 };
}

// Register a directory so it shows on the dashboard before any AI activity.
//
// Backfills by default (alpha readiness F3). Adoption is the moment a user is
// most likely to be looking for their history and least likely to see it: the
// daemon has already consumed the transcript bytes for this project while it
// was untracked, and without a reset only future activity would ever appear.
// opts.backfill === false skips it, for the rare caller that wants the project
// registered without re-reading anything.
function addProject(projectPath, opts = {}) {
  const resolved = path.resolve(projectPath);
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {}
  if (!isDir) return { error: 'not a directory' };
  const state = loadState();
  const existing = findProjectKey(state, resolved);
  if (existing) return { path: existing, added: false };
  state.projects = state.projects || {};
  state.projects[resolved] = { events: [] };

  // A deliberately deleted project does NOT come back on re-add. `membridge
  // remove` tells the user their memory history is permanently deleted and
  // that it cannot be undone; without this, F3's backfill made that promise
  // breakable from a dashboard checkbox, by accident. Delete is also the only
  // purge a user has for a credential captured into a prompt, and a purge that
  // silently reverses is not a purge.
  //
  // opts.backfill true forces it anyway (`membridge add --backfill`), false
  // suppresses it (--no-backfill), undefined means "backfill unless this path
  // was deleted on purpose".
  const tombKey = Object.keys(state.deletedProjects || {})
    .find(k => util.normPath(k) === util.normPath(resolved));
  const previouslyDeleted = !!tombKey;
  const wantBackfill = opts.backfill === true
    ? true
    : opts.backfill === false ? false : !previouslyDeleted;
  // AFTER the key is written, so the adopted root is already tracked and the
  // reset can tell it apart from the projects it must leave alone.
  const backfilled = wantBackfill ? resetOffsetsForAdoption(state, resolved) : [];
  // Consumed either way, so a second delete-and-re-add behaves the same rather
  // than inheriting a stale tombstone.
  if (tombKey) delete state.deletedProjects[tombKey];
  saveState(state);
  return { path: resolved, added: true, backfilled: backfilled.length, previouslyDeleted };
}

// Adopt one or more discovered-but-untracked projects, so the ingestion gate
// starts keeping their sessions. Nothing is written into a project here beyond
// what addProject already does — the memory block lands on the next sync.
//
// Bulk on purpose: "Adopt all" over 40+ discovered projects should be ONE
// request, not one per row, so a half-finished sweep can't leave the list in a
// state the user has to reason about. Per-path failures are reported, never
// thrown: one bad path must not abandon the rest.
function adoptProjects(paths, opts = {}) {
  const list = Array.isArray(paths) ? paths : [paths];
  const adopted = [];
  const skipped = [];
  // Paths adopted WITHOUT their history, because they were deleted on purpose
  // before. Reported separately so every surface can say why rather than
  // silently producing an empty block.
  const historyWithheld = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) {
      skipped.push({ path: String(p), reason: 'not a path' });
      continue;
    }
    let r;
    try {
      r = addProject(p, opts);
    } catch (e) {
      skipped.push({ path: p, reason: (e && e.message) || 'failed' });
      continue;
    }
    if (r.error) skipped.push({ path: p, reason: r.error });
    else if (r.added) {
      adopted.push(r.path);
      if (r.previouslyDeleted && !r.backfilled) historyWithheld.push(r.path);
    } else skipped.push({ path: r.path, reason: 'already tracked' });
  }
  return {
    adopted, skipped, historyWithheld,
    adoptedCount: adopted.length, skippedCount: skipped.length,
  };
}

// Forget a project: strip injected blocks, drop its .membridge dir and state.
// Adopt one or more discovered-but-untracked projects, so the ingestion gate
// starts keeping their sessions. Nothing is written into a project here beyond
// what addProject already does — the memory block lands on the next sync.
//
// Bulk on purpose: "Adopt all" over 40+ discovered projects should be ONE
// request, not one per row, so a half-finished sweep can't leave the list in a
// state the user has to reason about. Per-path failures are reported, never
// thrown: one bad path must not abandon the rest.
function adoptProjects(paths, opts = {}) {
  const list = Array.isArray(paths) ? paths : [paths];
  const adopted = [];
  const skipped = [];
  // Paths adopted WITHOUT their history, because they were deleted on purpose
  // before. Reported separately so every surface can say why rather than
  // silently producing an empty block.
  const historyWithheld = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) {
      skipped.push({ path: String(p), reason: 'not a path' });
      continue;
    }
    let r;
    try {
      r = addProject(p, opts);
    } catch (e) {
      skipped.push({ path: p, reason: (e && e.message) || 'failed' });
      continue;
    }
    if (r.error) skipped.push({ path: p, reason: r.error });
    else if (r.added) {
      adopted.push(r.path);
      if (r.previouslyDeleted && !r.backfilled) historyWithheld.push(r.path);
    } else skipped.push({ path: r.path, reason: 'already tracked' });
  }
  return {
    adopted, skipped, historyWithheld,
    adoptedCount: adopted.length, skippedCount: skipped.length,
  };
}

// Forget a project: strip injected blocks, drop its .membridge dir and state.
// Offsets are left consumed here, and a tombstone is written below so the
// re-add does NOT recover this history either. F3 cites the old line here
// ("only future activity revives it") as a defect for a NEVER-tracked
// project, which it is. For a deliberately deleted one it was the promise
// `membridge remove` makes, and that promise is now kept on purpose
// rather than as a side effect of consumed offsets.
function deleteProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  // SECURITY: only a project MemBridge actually tracks may be deleted. The old
  // `|| path.resolve(projectPath)` fallback accepted ANY path and then removed
  // <path>/.membridge and rewrote CLAUDE.md / AGENTS.md inside it — verified
  // against a directory MemBridge had never seen. addProject is the deliberate
  // exception (adopting an untracked path is its whole job); every destructive
  // handler resolves through findProjectKey or refuses.
  const key = findProjectKey(state, projectPath);
  if (!key) return { error: 'unknown project' };
  // Read the team link (if any) before removeProjectMemory wipes .membridge
  // (and team.json with it) — the durable archive is keyed by projectId, not
  // by path, so it has to be pruned explicitly rather than falling out of the
  // directory deletion.
  const link = teamsync.loadTeamLink(key);
  for (const dir of blockDirsFor(key)) {
    for (const target of effectiveTargets(config)) {
      digest.removeBlock(path.join(dir, target), { preamble: digest.preambleFor(target), projectRoot: dir });
    }
  }
  memorydb.removeProjectMemory(key);
  if (link && link.projectId) teamArchive.pruneArchive(link.projectId);
  // Tombstone the path so a later re-add does not restore what this just
  // purged. Written whether or not the key was still in state.projects, so a
  // half-removed project cannot dodge it.
  state.deletedProjects = state.deletedProjects || {};
  state.deletedProjects[key] = new Date().toISOString();
  if (state.projects && state.projects[key]) delete state.projects[key];
  saveState(state);
  // A deleted project must not stay in config.archived: re-adding the same
  // path later would bring it back already archived (hidden in the Archived
  // section, capture off) with nothing on screen connecting the two.
  //
  // config.exclude gets pruned in the same breath, and for the same reason.
  // archiveProject writes the path into BOTH lists (archive implies paused),
  // so cleaning only config.archived leaves a re-added project visible but
  // permanently paused — the identical trap wearing a different hat.
  //
  // A path can land in config.exclude for two different reasons: archiving
  // put it there, or the user hit Pause themselves. The manual-pause case is
  // NOT being overlooked here; pruning is right for it too. Delete removes
  // the project from the daemon entirely, so the entry is stale either way,
  // and a pause is a standing choice about a project that no longer exists.
  // If the user re-adds the path, that is a fresh decision to track it, and
  // it starts capturing like any other newly added project.
  try {
    const raw = loadUserConfig();
    let dirty = false;
    for (const list of ['archived', 'exclude']) {
      const idx = (raw[list] || []).indexOf(key);
      if (idx !== -1) {
        raw[list].splice(idx, 1);
        dirty = true;
      }
    }
    if (dirty) saveUserConfig(raw);
  } catch (err) {
    // Never turn a config failure into a failed delete: the destructive work
    // above already succeeded, and loadUserConfig refuses rather than
    // clobbering an unreadable config (see its own comment). A WRITE failure
    // lands here too and leaves the stale entries behind, which silently
    // restores the re-add-comes-back-archived (or -paused) trap, so it is
    // logged rather than swallowed.
    log(`delete: could not prune ${key} from config.archived/exclude: ${err.message}`);
  }
  return { path: key, deleted: true };
}

// Why the role probe cannot answer, phrased as the thing the user should go and
// do. The two reasons worth telling apart are the two classifyAuthFailure
// bothers with, and they call for opposite responses: a dead session needs them
// to sign in, an unreachable backend fixes itself. Every branch ends by saying
// nothing was changed, because that is the fact the user most needs and the one
// the old behaviour got wrong.
function roleUnknownMessage(err) {
  const reason = err ? teamsync.classifyAuthFailure(err) : null;
  if (reason === 'session-expired') {
    return 'could not check whether you manage this team — your MemBridge sign-in has expired. ' +
      'Sign in again and try the delete once more. Nothing on this machine was changed.';
  }
  if (reason === 'backend-unreachable') {
    return 'could not reach MemBridge to check whether you manage this team. ' +
      'Check your connection and try the delete again. Nothing on this machine was changed.';
  }
  const detail = err && err.message ? ` (${err.message})` : '';
  return `could not confirm whether you manage this team${detail}. ` +
    'Try the delete again in a moment. Nothing on this machine was changed.';
}

// WHY a shared-project delete was refused, as a value rather than as prose.
//
// The messages above say it in English, which is right for the person reading
// the dialog and useless to the code drawing it: an outage and a genuine "you
// are not a manager" arrive in the same 200 with the same field shapes, so
// ui/src/data/queries.ts deleteRefusalOf renders them identically — same
// wording weight, same finality, no retry affordance for the one case that is
// entirely retryable. The client cannot recover the distinction by matching on
// the sentence; a copy edit would silently change behaviour if it tried.
//
// ADDITIVE ONLY. Every existing field of the refusal envelope keeps its shape
// and every message keeps its text, and DeleteProjectResult already declares
// all of them optional (ui/src/data/types.ts), so this costs a client nothing
// until it opts in. It is also absent from every SUCCESS body, deliberately:
// its presence means "this delete did not happen", and adding it to a success
// would make it a second, weaker source of truth for a question `archived` and
// `deleted` already answer positively.
const REFUSAL = {
  // Indeterminate. The role probe did not answer: no connection, an expired
  // sign-in, or a backend that listed no teams at all for this account. The
  // caller MAY be a manager — nothing local was touched, and the same delete
  // may well succeed on the next attempt.
  ROLE_UNKNOWN: 'role-unknown',
  // Determinate. The caller is in this team and is neither owner nor admin.
  NOT_MANAGER: 'not-manager',
  // Determinate. team.json points at a team the caller is not in at all; this
  // machine was unlinked instead. Not merged with NOT_MANAGER because they send
  // the user to two different places, which is why they already have two
  // different sentences.
  NOT_A_MEMBER: 'not-a-member',
};

// The indeterminate set, in ONE place. `retryable` is derived from it rather
// than written out per branch so the two can never disagree, and so a client
// can gate a "Try again" affordance without hard-coding the value list above —
// a future fourth determinate refusal is then correctly non-retryable for a
// client that never hears about it. `refusal` is the contract; `retryable` is
// convenience computed from it.
const RETRYABLE_REFUSALS = new Set([REFUSAL.ROLE_UNKNOWN]);

function refusalFields(refusal) {
  return { refusal, retryable: RETRYABLE_REFUSALS.has(refusal) };
}

// Delete a SHARED project. Owners/admins archive it for the whole team
// (reversible soft-delete on the backend) and clean up locally; a plain member
// can only unlink their own machine. The backend archive_project RPC is the
// real authorization — the local role check just picks the branch. A path with
// no team link falls back to a plain local delete.
//
// THREE outcomes, not two. "You are not a manager" and "we could not determine
// whether you are a manager" are different answers, and only the first may take
// a destructive local action.
//
// This used to be `listTeams(config).catch(() => [])`, so an outage or an
// expired refresh token produced isManager === false, ran the plain-member
// branch — which deletes .membridge/team.json and prunes the durable teammate
// archive — and reported a PERMISSIONS problem. Fail-open plus a confident wrong
// explanation: the user goes to check their role while the real cause is their
// connection. For an adopted shared project team.json is a file COMMITTED to the
// repo, so it also showed up as a deleted tracked file in their working tree,
// and the retry afterwards found no link and silently degraded into a local-only
// delete. And the window is wide, not a race: the UI's cached role comes from
// useSettings, which has no poll, so a mounted Projects grid keeps offering a
// live Delete button for as long as the user stays on that screen.
async function archiveSharedProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  // Same rule as deleteProject — this path ends in deleteProject anyway.
  const key = findProjectKey(state, projectPath);
  if (!key) return { error: 'unknown project' };
  const link = teamsync.loadTeamLink(key);
  if (!link || !link.projectId) {
    return { ...deleteProject(key), scope: 'local' };
  }
  const refuse = message => ({ ...refusalFields(REFUSAL.ROLE_UNKNOWN), path: key, scope: 'local', archived: false, unlinked: false, message });
  let teams;
  try {
    teams = await teamsync.listTeams(config);
  } catch (err) {
    // Logged, not swallowed: the user gets the actionable sentence, and whoever
    // reads the log gets the real error behind it.
    log(`delete: could not check the caller's role on team ${link.teamId} (${err.message}) — refusing, nothing changed`);
    return refuse(roleUnknownMessage(err));
  }
  // An EMPTY list is inconclusive, not "you belong to no teams". Same judgement
  // teamsync.visibleProjectIds already makes for the same shape of answer: a
  // misconfigured deployment, a backend missing the RPC and a genuinely
  // team-less account all produce [], and this caller is holding a team.json
  // that says otherwise. Since the ambiguous reading costs local data, it fails
  // safe. A NON-empty list that lacks this team is a real answer.
  if (!Array.isArray(teams) || !teams.length) {
    log(`delete: role probe for team ${link.teamId} returned no teams at all — refusing, nothing changed`);
    return refuse('could not confirm whether you manage this team — MemBridge listed no teams for this account. ' +
      'Nothing on this machine was changed.');
  }
  const team = teams.find(t => t.team_id === link.teamId);
  const isManager = !!team && ['owner', 'admin'].includes(team.role);
  if (!isManager) {
    // Determinate: unlink this machine only; never archive for the team. Two
    // distinct facts reach here and each gets its own sentence — being a member
    // without the role, and not being in that team at all — because "only owners
    // or managers" sends the second one to argue about permissions in a team
    // they cannot even see.
    const unlinked = teamsync.unlinkProject(key);
    return {
      ...refusalFields(team ? REFUSAL.NOT_MANAGER : REFUSAL.NOT_A_MEMBER),
      path: key, scope: 'local', archived: false, unlinked,
      message: team
        ? 'only owners or managers can delete a shared project for the team'
        : `this project is linked to a team you are not a member of, so it was unlinked from this machine ` +
          'instead of deleted for the team',
    };
  }
  await teamsync.archiveProject(config, link.projectId);
  teamsync.unlinkProject(key); // drop team.json first
  deleteProject(key);          // then strip injected blocks + wipe local memory/state
  return { path: key, scope: 'team', archived: true };
}

// Every directory lib/scan.js writes this project's block into: the root plus
// each linked worktree. Removal MUST cover exactly the same set as injection.
//
// A block left in a directory nothing rewrites is the worst outcome available
// here -- it is stale forever, it is invisible (nobody looks in a worktree for
// a file they did not put there), and it costs every future agent session in
// that directory its full token weight. MemBridge already shipped that bug
// once via a renamed marker namespace, and the block it stranded is
// permanently unremovable by the current build.
//
// Deliberately NOT gated on isProjectOff, unlike injection: a worktree that
// was excluded AFTER its block was written still has one on disk, and refusing
// to clean it is how the orphan above happens. Cleanup is always wider than
// writing.
function blockDirsFor(key) {
  return [key, ...repoRoot.linkedWorktreesOf(key)];
}

// Strip the injected block from a project's context files without touching
// its .membridge history/memory or state. Syncing again will re-add the
// block unless the project is paused first.
function removeBlockFromProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  // Same rule as deleteProject: this rewrites CLAUDE.md / AGENTS.md on disk.
  const key = findProjectKey(state, projectPath);
  if (!key) return { error: 'unknown project' };
  for (const dir of blockDirsFor(key)) {
    for (const target of effectiveTargets(config)) {
      digest.removeBlock(path.join(dir, target), { preamble: digest.preambleFor(target), projectRoot: dir });
    }
  }
  return { path: key, removed: true };
}

// Archive: get a project out of the Projects list and stop MemBridge watching
// it while destroying nothing. It composes two existing, unmodified primitives
// plus one new config entry:
//   1. the path joins config.archived (same shape and mechanism as
//      config.exclude in toggleProject),
//   2. the path joins config.exclude via toggleProject, so isProjectOff
//      reports it off (archive implies paused),
//   3. removeBlockFromProject strips the injected block from the context
//      files, leaving .membridge history, memory and central state untouched.
// ORDER IS LOAD-BEARING: the pause is persisted BEFORE the strip runs,
// because removeBlockFromProject's own contract says a sync re-adds the block
// unless the project is paused first. `deps` is the test seam for the
// sequence spy; production callers pass nothing and get the real primitives.
//
// SHARED-PULL ANSWER (the spec's open question, traced 2026-07-31): archiving
// a shared project DOES stop pulling teammates' entries for it. teamsync's
// syncTeams() gates its whole per-project loop body with
// `if (util.isProjectOff(key, config)) continue;` (lib/teamsync.js:1867), and
// the forward pull (`pullProject`, called at lib/teamsync.js:1954) sits inside
// that body, as do push and backfill. detectAutoLinks skips excluded projects
// the same way (lib/teamsync.js:1746). isProjectOff reports true for any path
// in config.exclude (lib/util.js isProjectOff -> isExcluded), which is exactly
// where step 2 below puts an archived path. Entries already pulled stay in
// proj.teamEntries and keep rendering in the Feed (history is not hidden);
// only NEW teammate activity stops arriving. The archive confirmation copy in
// the UI states this in one plain sentence.
function archiveProject(projectPath, deps = {}) {
  const pause = deps.pause || toggleProject;
  const strip = deps.strip || removeBlockFromProject;
  const state = loadState();
  // Same rule as deleteProject: only a project MemBridge actually tracks may
  // be archived, and config entries are keyed by the tracked key, never the
  // raw query.
  const key = findProjectKey(state, projectPath);
  if (!key) return { error: 'unknown project' };
  ensureConfig();
  const raw = loadUserConfig();
  raw.archived = raw.archived || [];
  if (!raw.archived.includes(key)) {
    raw.archived.push(key);
    saveUserConfig(raw);
  }
  // Pause through the existing primitive, guarded so re-archiving an
  // already-archived (or manually paused) project never toggles it back ON.
  if (!(loadUserConfig().exclude || []).includes(key)) pause(key);
  try {
    const r = strip(key);
    if (r && r.error) throw new Error(r.error);
  } catch (err) {
    // Fail closed, stay recoverable: the archived entry and the pause are
    // already persisted, so nothing keeps writing into the project, and a
    // plain unarchive fully recovers. Reported as a failure, never as a
    // partial success.
    return {
      path: key,
      paused: true,
      error: `archive incomplete, the context-file strip failed: ${(err && err.message) || 'unknown error'}`,
    };
  }
  return { path: key, archived: true, paused: true };
}

// Unarchive is total: drop both config entries and let the next sync re-add
// the block. Nothing is reconstructed because archive destroyed nothing.
function unarchiveProject(projectPath, deps = {}) {
  const unpause = deps.unpause || toggleProject;
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  if (!key) return { error: 'unknown project' };
  ensureConfig();
  const raw = loadUserConfig();
  const idx = (raw.archived || []).indexOf(key);
  if (idx !== -1) {
    raw.archived.splice(idx, 1);
    saveUserConfig(raw);
  }
  // toggleProject removes an existing exclude entry; guard so unarchiving a
  // never-paused path cannot accidentally pause it.
  if ((loadUserConfig().exclude || []).includes(key)) unpause(key);
  return { path: key, archived: false };
}

// Catch-Up read pointer. GET is pure (never mutates); mark/undo rewrite the
// pointer immutably so a mis-tap is one-step reversible from Home. The cached
// briefing (Phase 2) is surfaced here so Home can render it without regenerating.
function catchupPayload() {
  const c = loadState().catchup || {};
  return {
    lastViewedTs: c.lastViewedTs || null,
    prevViewedTs: c.prevViewedTs || null,
    hasBriefing: !!(c.briefing && c.briefing.text),
    briefing: c.briefing || null,
  };
}

function markCaughtUp(ts) {
  const state = loadState();
  const c = state.catchup || {};
  const next = {
    ...c,
    prevViewedTs: c.lastViewedTs || null,
    lastViewedTs: ts || new Date().toISOString(),
  };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}

function undoCaughtUp() {
  const state = loadState();
  const c = state.catchup || {};
  const next = { ...c, lastViewedTs: c.prevViewedTs || null, prevViewedTs: null };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}

// Multi-provider advisor settings for the dashboard. Never returns a key
// value — only whether each provider has one set (keySet), plus its
// non-secret baseUrl (for local/OpenAI-compatible endpoints).
function advisorPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const stored = (raw.advisor && raw.advisor.providers) || {};
  // Legacy top-level key still counts as "set" for anthropic unless the
  // provider entry now carries its own key (mirror of getAdvisorConfig's gate,
  // so a stored model-only entry doesn't make the key look absent).
  const legacyAnthropicKey = raw.advisor && !(stored.anthropic && stored.anthropic.apiKey) ? raw.advisor.apiKey : '';
  const providers = advisor.providers.list().map(a => {
    const pconf = stored[a.id] || {};
    const keySet = !!(pconf.apiKey || (a.id === 'anthropic' && legacyAnthropicKey) || (a.keyEnv || []).some(k => process.env[k]));
    return {
      id: a.id, label: a.label, needsBaseUrl: a.needsBaseUrl,
      models: a.models, keySet,
      baseUrl: a.needsBaseUrl ? (pconf.baseUrl || '') : undefined,
      model: pconf.model || (a.id === adv.provider ? adv.model : (a.models[0] ? a.models[0].id : '')),
    };
  });
  return { provider: adv.provider, model: adv.model, providers };
}

// Settings for the dashboard. The API key itself is never sent to the page —
// only whether one exists, where it came from, and its last 4 characters.
// Pure-ish: the injected memory block for one project, read straight off disk.
// Exported for tests. Returns { file, block } for the first configured target
// that carries a block, or { file:null, block:null } when nothing is written
// yet — an honest empty answer, never a fabricated one.
function projectBlockPayload(projectPath) {
  const config = getConfig();
  const root = path.resolve(projectPath);
  for (const target of effectiveTargets(config)) {
    const file = path.join(root, target);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const start = text.indexOf(digest.BEGIN);
    const end = text.indexOf(digest.END);
    if (start === -1 || end === -1 || end < start) continue;
    const block = text.slice(start + digest.BEGIN.length, end).trim();
    if (block) return { file, block };
  }
  return { file: null, block: null };
}

// Task 17: on-demand-only network access. GET /api/settings must never make
// a real network call on its own (it can be polled) — updateAvailable here
// is a CACHE-ONLY read (never fetches; see update-check.js's readCache). The
// actual check-the-network action lives at POST /api/updates/check below.
function cachedUpdateInfo() {
  const cache = updateCheck.readCache();
  const latest = (cache && cache.latest) || null;
  const current = require('../package.json').version;
  return latest && updateCheck.isNewer(latest, current) ? latest : null;
}

// Mirrors bin/membridge.js's printMcpStatus -- same four cases, structured
// data instead of console lines. `/api/settings` used to carry no MCP field
// at all, so the dashboard fell back to a hardcoded "not registered" even on
// a machine where every agent was actually registered (mcp-register.js
// already recorded that; nothing read it). Read from the RECORDED rows via
// lastRegistration(), never re-run: `GET /api/settings` is a read-only,
// pollable endpoint, and re-registering to answer it would both write from a
// read and cost the ~2s a real reconcile takes (see mcp-register.js's
// comment on lastRegistration).
function mcpStatusPayload(config) {
  let rec = null;
  try { rec = mcpRegister.lastRegistration(); } catch { rec = null; }
  const autoRegister = (config.mcp || {}).autoRegister !== false;
  if (!autoRegister && !rec) {
    return { autoRegister: false, state: 'disabled', at: null, rows: [] };
  }
  if (!rec || !Array.isArray(rec.rows) || !rec.rows.length) {
    return { autoRegister, state: 'never', at: null, rows: [] };
  }
  const state = rec.mode === 'unregister' ? 'removed' : 'registered';
  return { autoRegister, state, at: rec.at || null, rows: rec.rows };
}

// Settings honesty: excluded folders that no longer exist on disk (Task 4a
// -- a stale fixture path leaking into a real config is exactly the bug
// that motivated this). Only plain paths are checked; an entry containing
// '*' is a glob (see util.js's isExcluded), and fs.existsSync on a glob
// pattern would just report false for a perfectly valid, matching rule --
// so glob entries are left out of the stale list entirely rather than
// risk a false "no longer exists" flag on something that was never a
// literal path to begin with.
function staleExcludes(exclude) {
  return (exclude || []).filter(p => typeof p === 'string' && p && !p.includes('*') && !fs.existsSync(p));
}

function settingsPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const team = raw.team && typeof raw.team === 'object' ? raw.team : {};
  return {
    hasKey: !!adv.apiKey,
    keySource: adv.source, // 'config' | 'env' | null
    keyHint: adv.source === 'config' ? `…${adv.apiKey.slice(-4)}` : '',
    model: adv.model,
    models: advisor.PLANNER_MODELS,
    advisor: advisorPayload(),
    intervalSec: config.intervalSec,
    targets: config.targets,
    extraTargets: config.extraTargets,
    extraTargetFiles: EXTRA_TARGETS,
    hookInstalled: hooks.isHookInstalled(),
    // Task 19: Settings' MCP and recall rows used to carry no field at all
    // and the UI defaulted to a state that reads as broken -- see
    // mcpStatusPayload and hooks.isRecallHookInstalled above/in lib/hooks.js.
    mcp: mcpStatusPayload(config),
    recall: { installed: hooks.isRecallHookInstalled() },
    // Force-update hooks: 'current' | 'outdated' | 'unknown' per hook, read
    // fresh from settings.json every call -- see lib/hooks.js's
    // hooksVersionStatus. Independent of hookInstalled/recall.installed
    // above: those answer "is it there at all", this answers "is what's
    // there the current build" (only meaningful once something is there).
    hooksVersion: hooks.hooksVersionStatus(),
    // Task 17: the mockups' Settings controls that had no backing data yet.
    // startAtLogin is read-only here (autostart.isEnabled() just checks for
    // the launcher file on disk); writes go through POST /api/settings below.
    startAtLogin: autostart.isEnabled(),
    daemonPort: boundPort(),
    updateAvailable: cachedUpdateInfo(),
    // Real, derived count -- never hardcoded, so it cannot drift from the
    // pattern table itself (Task: "built-in count unknown" was a real
    // number the payload simply never exposed; lib/redact.js's
    // DEFAULT_PATTERNS was always there, nothing read its length).
    redactionBuiltIn: redact.DEFAULT_PATTERNS.length,
    redactExtra: config.redactExtra,
    exclude: config.exclude,
    excludeStale: staleExcludes(config.exclude),
    distill: {
      enabled: config.distill.enabled,
      consent: config.distill.consent,
      minEdits: config.distill.minEdits,
      checkpointEvery: config.distill.checkpointEvery,
    },
    // Anonymous net-negative diagnostics (spec §8.5, Task 9) -- the
    // "Send anonymous diagnostics" Settings toggle. See lib/diagnostics.js.
    diagnostics: { enabled: config.diagnostics.enabled },
    team: {
      url: String(team.url || ''),
      anonKey: String(team.anonKey || ''),
      customBackend: !!(team.url && team.anonKey),
    },
  };
}

// Task 17's three additions to POST /api/settings, validated together so a
// malformed value in any one of them rejects the whole write rather than
// silently applying the others (the fields that already existed before this
// task keep their own looser, pre-existing coercion below — not rewritten
// here to avoid changing behavior this task was not asked to touch).
const settingsExtraSchema = z.object({
  startAtLogin: z.boolean().optional(),
  redactExtra: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

function saveSettings(body) {
  ensureConfig();
  const raw = loadUserConfig();
  const extra = settingsExtraSchema.safeParse({
    startAtLogin: body.startAtLogin,
    redactExtra: body.redactExtra,
    exclude: body.exclude,
  });
  if (!extra.success) return { error: 'startAtLogin must be a boolean; redactExtra/exclude must be arrays of strings' };
  if (extra.data.startAtLogin !== undefined) {
    // autostart touches real OS state (a login item), so it is called via
    // the module object (autostart.enable/.disable), never destructured —
    // tests substitute these two functions rather than actually registering
    // or removing a login item on the machine running the suite.
    if (extra.data.startAtLogin) autostart.enable(); else autostart.disable();
  }
  if (extra.data.redactExtra !== undefined) {
    raw.redactExtra = extra.data.redactExtra.map(s => s.trim()).filter(Boolean);
  }
  if (extra.data.exclude !== undefined) {
    raw.exclude = extra.data.exclude.map(s => s.trim()).filter(Boolean);
  }
  if (body.apiKey !== undefined) {
    raw.advisor = raw.advisor || {};
    raw.advisor.apiKey = String(body.apiKey || '').trim();
  }
  if (body.model !== undefined && advisor.PLANNER_MODELS.some(m => m.id === body.model)) {
    raw.advisor = raw.advisor || {};
    raw.advisor.model = body.model;
  }
  if (body.intervalSec !== undefined) {
    const n = parseInt(body.intervalSec, 10);
    if (Number.isFinite(n)) raw.intervalSec = Math.max(15, n);
  }
  // First-run wizard completion. Written once, by finishing OR skipping — both
  // are a decision the user made, and re-taking the window after a skip is the
  // rudest thing onboarding can do.
  if (body.setupCompletedAt !== undefined) {
    raw.setup = raw.setup && typeof raw.setup === 'object' ? raw.setup : {};
    raw.setup.completedAt = body.setupCompletedAt ? String(body.setupCompletedAt) : null;
  }
  if (Array.isArray(body.targets)) {
    const t = body.targets.map(s => String(s).trim()).filter(Boolean);
    if (t.length) raw.targets = t;
  }
  if (body.extraTargets && typeof body.extraTargets === 'object') {
    const next = { ...(raw.extraTargets && typeof raw.extraTargets === 'object' ? raw.extraTargets : {}) };
    for (const key of Object.keys(EXTRA_TARGETS)) {
      if (body.extraTargets[key] !== undefined) next[key] = !!body.extraTargets[key];
    }
    raw.extraTargets = next;
  }
  if (body.distill && typeof body.distill === 'object') {
    const current = getConfig().distill;
    const next = { ...(raw.distill || {}) };
    if (body.distill.enabled !== undefined) {
      const nowEnabled = !!body.distill.enabled;
      next.enabled = nowEnabled;
      // Unconditional, not just on transition: setupHooks/removeHooks are
      // idempotent, and the config's enabled flag may already say true while
      // the hook itself was never installed (e.g. consent was skipped).
      // Also record consent here, exactly like consent.js's applyConsent —
      // otherwise the first-run popup keeps nagging even though the hook
      // is now installed/removed from the Settings toggle.
      if (nowEnabled) {
        hooks.setupHooks();
        next.consent = 'granted';
      } else {
        hooks.removeHooks();
        next.consent = 'declined';
      }
    }
    if (body.distill.minEdits !== undefined) {
      const n = Number(body.distill.minEdits);
      next.minEdits = Number.isFinite(n) && n >= 1 ? n : current.minEdits;
    }
    if (body.distill.checkpointEvery !== undefined) {
      const n = Number(body.distill.checkpointEvery);
      next.checkpointEvery = Number.isFinite(n) && n >= 1 ? n : current.checkpointEvery;
    }
    // Explicit consent (e.g. re-showing the first-run prompt from Settings)
    // overrides whatever the enabled toggle above implied.
    if (['granted', 'declined', null].includes(body.distill.consent)) {
      next.consent = body.distill.consent;
    }
    raw.distill = next;
  }
  if (body.advisor && typeof body.advisor === 'object') {
    const b = body.advisor;
    raw.advisor = raw.advisor || {};
    raw.advisor.providers = raw.advisor.providers || {};
    const pid = advisor.providers.byId(b.provider) ? b.provider
      : (advisor.providers.byId(raw.advisor.provider) ? raw.advisor.provider : 'anthropic');
    if (b.provider !== undefined && advisor.providers.byId(b.provider)) raw.advisor.provider = b.provider;
    // Only materialize a provider-scoped entry when there is actually a field
    // to store — a bare provider switch (no key/baseUrl/model) must not
    // create an empty `providers[pid]` object, since its mere presence
    // shadows the legacy top-level advisor.apiKey fallback for 'anthropic'
    // in advisor.getAdvisorConfig (an empty object is still truthy).
    if (b.apiKey !== undefined || b.baseUrl !== undefined || b.model !== undefined) {
      const p = raw.advisor.providers[pid] = { ...(raw.advisor.providers[pid] || {}) };
      if (b.apiKey !== undefined) {
        p.apiKey = String(b.apiKey || '').trim();
        // Once the anthropic key is set through the new UI, the provider entry is
        // authoritative — retire the legacy top-level key so an explicit clear
        // (apiKey:'') actually takes effect instead of the legacy value winning
        // via getAdvisorConfig's !pconf.apiKey fallback.
        if (pid === 'anthropic') delete raw.advisor.apiKey;
      }
      if (b.baseUrl !== undefined) p.baseUrl = String(b.baseUrl || '').trim();
      if (b.model !== undefined) {
        const adapter = advisor.providers.byId(pid);
        const ok = adapter.models.length ? adapter.models.some(m => m.id === b.model) : !!String(b.model || '').trim();
        if (ok) p.model = String(b.model).trim();
      }
    }
  }
  if (body.team && typeof body.team === 'object') {
    // Only the backend fields are dashboard-editable; keep flags like
    // sharePrompts that live under the same config key.
    // The URL is validated before anything is written: a rejected save must
    // persist NOTHING, or a bad backend could ride in alongside a good field.
    const teamUrl = validateTeamUrl(body.team.url);
    if (!teamUrl.ok) return { error: teamUrl.error };
    raw.team = {
      ...(raw.team && typeof raw.team === 'object' ? raw.team : {}),
      url: teamUrl.url,
      anonKey: String(body.team.anonKey || '').trim(),
    };
  }
  saveUserConfig(raw);
  return settingsPayload();
}

// "Copy for AI" digest: a trimmed, already-redacted handoff the dashboard
// puts on the clipboard for pasting into web AIs (ChatGPT, claude.ai, ...)
// that cannot see this disk. The manual bridge until importers/MCP (M5).
function copyPayload(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return { error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];
  return { path: key, text: memorydb.renderCopyText(key, proj, config) };
}

// Roles that can administer a team. Mirrors the backend's is_team_manager()
// (002_team_v2.sql) -- if that predicate ever gains a role, this set has to
// gain it too or this guard starts refusing writes the backend would allow.
const MANAGER_ROLES = ['owner', 'admin'];

/**
 * Would this role change leave the team with nobody who can administer it?
 * Returns the refusal message, or null to let the write through.
 *
 * The failure this prevents is an availability one, not a privilege one: a
 * team whose last manager is demoted to 'member' has no member left who can
 * promote anyone, invite anyone, or manage projects, and no member left who
 * can undo the demotion either. There is no in-app recovery from that state
 * -- it takes a direct database edit -- so it must not be reachable by an
 * HTTP request.
 *
 * WHY HERE, and the honest limits of it. On a backend at the current
 * migration level this guard cannot fire, and that is deliberate rather than
 * accidental: 002_team_v2.sql makes the owner permanent (set_role refuses a
 * self-targeted change and refuses any p_role outside admin|member,
 * remove_member refuses the owner, leave_team refuses the owner), so a team
 * always retains its owner and therefore always retains a manager. This is
 * defense in depth for the states that sit outside those guarantees: a team
 * whose owner row was removed by a direct database edit or a partial
 * migration, and any future backend that makes ownership transferable --
 * which is exactly the change the dashboard's "Transfer ownership" flow is
 * already written against. The check costs one members read on a rare write.
 *
 * Deliberately NOT enforced here:
 *   * authorization. Who may change roles is the RPC's call and stays there
 *     (set_role is owner-only, security definer); this only answers whether
 *     the resulting team is still administerable. A daemon-side role check
 *     would be a second, drifting copy of a rule RLS already owns.
 *   * anything on a members list we could not read. listMembers can fail on
 *     a network blip, an old backend, or a 403, and refusing on absence
 *     would turn every such blip into "you cannot change roles" -- so an
 *     unreadable list falls through to the backend, which is the real
 *     authority regardless.
 */
function lastManagerBlock(members, userId, nextRole) {
  if (!Array.isArray(members) || members.length === 0) return null;
  // A promotion (to admin, or the transfer flow's 'owner') only ever ADDS a
  // manager, so it can never be the write that empties the set.
  if (MANAGER_ROLES.includes(String(nextRole))) return null;
  const target = members.find(m => m && String(m.user_id) === String(userId));
  // Not a manager today (or not a member at all): demoting them removes
  // nobody from the manager set. An unknown id is the backend's 404 to give.
  if (!target || !MANAGER_ROLES.includes(String(target.role))) return null;
  const othersLeft = members.some(m => m && String(m.user_id) !== String(userId) && MANAGER_ROLES.includes(String(m.role)));
  if (othersLeft) return null;
  return 'this is the team\'s last owner or admin: promote someone else first, or the team will have nobody who can manage it';
}

// A token-free view of team state for the dashboard. Credentials never cross
// the local HTTP boundary; the browser only receives identity metadata.
async function teamPayload() {
  const config = getConfig();
  const creds = teamsync.loadCredentials();
  const state = loadState();
  const linkedProjects = Object.keys(state.projects || {}).map(projectPath => {
    const link = teamsync.loadTeamLink(projectPath);
    if (!link) return null;
    return {
      path: projectPath,
      name: path.basename(projectPath),
      teamId: link.teamId,
      teamName: link.teamName || '',
      linkedAt: link.linkedAt || null,
      teammateActivity: util.teamRowsFor(state.projects[projectPath]).length,
    };
  }).filter(Boolean);
  // Pending auto-link suggestions (a teammate linked a project with the same
  // git remote) awaiting the user's confirm/dismiss.
  const suggestions = Object.entries(state.projects || {}).map(([projectPath, proj]) => {
    const s = proj && proj.teamSuggestion;
    if (!s || teamsync.loadTeamLink(projectPath)) return null;
    return { path: projectPath, name: path.basename(projectPath), teamName: s.teamName, repoUrl: s.repoUrl };
  }).filter(Boolean);
  let teams = [];
  let error = null;
  if (creds) {
    try {
      teams = await teamsync.listTeams(config);
    } catch (err) {
      error = err.message;
    }
  }
  return {
    configured: teamsync.isConfigured(config),
    authenticated: !!creds,
    webUrl: teamsync.webUrl(config),
    user: creds ? {
      userId: creds.userId,
      email: creds.email,
      displayName: creds.displayName,
    } : null,
    // Task 17: closes the self-id gap -- the projects grid's self-revoke
    // guard was comparing against the literal 'me', which never matches a
    // real user id. Same identity /api/feed already tags entries with as
    // `self` (see feedPayload's selfUserId), promoted to the top level here.
    viewerId: creds ? creds.userId : null,
    // The spread is deliberate (every my_teams column reaches the UI), which
    // is exactly why invite_code has to be taken OUT of it by name. That
    // column is the team's permanent, non-expiring, un-revocable join
    // credential, and until 044 my_teams handed it to every member whatever
    // their role — so this payload published it to anyone who opened the
    // dashboard, and a member could keep it and walk back in after being
    // removed. 044 §2 makes the backend return null for a non-manager; this
    // is the same rule stated on the daemon side, so a backend that has not
    // had 044 applied yet does not leak through the client either. Belt and
    // braces on purpose: the two ship separately and one of them is applied
    // by hand.
    teams: (teams || []).map(t => ({
      ...t,
      invite_code: apiAccess.isManagerRole(t.role) ? t.invite_code || null : null,
      memberCount: typeof t.member_count === 'number' ? t.member_count : null,
      createdAt: t.created_at || null,
    })),
    // Task 17: the CURRENT invite code (my_teams already returns it — see
    // migrations/006_team_meta.sql) for "Copy invite link". Never rotated by
    // reading it; only POST /api/team/rotate-invite changes this value.
    // The product models one team per user (see accessMatrix's identical
    // teams[0] simplification in lib/api-access.js) -- null when solo or
    // between teams, and now also null when the viewer is an ordinary member
    // of teams[0]: they have no operation that needs it (create_invite and
    // revoke_invite are both manager-gated) and nothing to gain from holding
    // a credential they cannot manage.
    inviteCode: teams && teams[0] && apiAccess.isManagerRole(teams[0].role)
      ? teams[0].invite_code || null
      : null,
    linkedProjects,
    suggestions,
    projects: projectsPayload().map(p => ({
      path: p.path,
      name: p.name,
      exists: p.exists,
      paused: p.paused,
      team: p.team,
    })),
    error,
  };
}

// Team projects for the hub: backend stats joined with whichever local folder
// (if any) is linked to each team project, so the UI can cross-link the views.
async function teamProjectsPayload(teamId) {
  const rows = await teamsync.projectStats(getConfig(), teamId);
  const state = loadState();
  const localByProjectId = {};
  for (const projectPath of Object.keys(state.projects || {})) {
    const link = teamsync.loadTeamLink(projectPath);
    if (link && link.projectId) localByProjectId[link.projectId] = projectPath;
  }
  return (rows || []).map(r => ({ ...r, localPath: localByProjectId[r.project_id] || null }));
}

async function runTeamSync(projectPath) {
  const result = await teamsync.syncTeams(projectPath ? { project: projectPath } : {});
  for (const key of result.changed) syncOnce({ project: key });
  return result;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    // Reject cross-site writes before any route runs (see sameOrigin). The
    // content-type gate is defense-in-depth: it independently refuses the
    // text/plain form-POST trick that "simple requests" use to dodge preflight,
    // in case an Origin header is ever absent on a hostile request.
    // Anti-DNS-rebinding, before anything else and for EVERY method: the daemon
    // binds loopback, so a request whose Host is not a loopback name did not
    // come from a page that legitimately knows it is talking to this machine.
    // Reads are gated too — the feed and project endpoints return captured
    // prompt text.
    if (!localHost(req)) return json(res, 403, { error: 'host not allowed' });
    if (!SAFE_METHODS.has(req.method)) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request blocked' });
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return json(res, 403, { error: 'content-type must be application/json' });
      }
    }
    if (req.method === 'GET' && url.pathname === APP_PREFIX) {
      // Legacy alias: the rebuilt UI used to live at /app while the old
      // dashboard held /. It now owns / outright, so an old bookmark or
      // in-flight link to bare /app just redirects home.
      res.writeHead(302, { Location: '/' + url.search });
      res.end();
    } else if (req.method === 'GET' && url.pathname.startsWith(APP_PREFIX + '/')) {
      res.writeHead(302, { Location: url.pathname.slice(APP_PREFIX.length) + url.search });
      res.end();
    } else if (req.method === 'GET' && url.pathname === '/team/oauth/github') {
      // Kick off the GitHub round trip. The redirect target must be on the
      // Supabase redirect-URL allowlist (e.g. http://localhost:7437/**), or
      // Supabase silently lands the user on the Site URL instead.
      const host = String(req.headers.host || `127.0.0.1:${getConfig().dashboardPort || 7437}`);
      const target = teamsync.oauthAuthorizeUrl(getConfig(), `http://${host}/team/oauth/callback`);
      if (!target) return json(res, 503, { error: 'team sync is not available in this build' });
      res.writeHead(302, { Location: target });
      res.end();
    } else if (req.method === 'GET' && url.pathname === '/team/oauth/callback') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthCallbackPage());
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, statusPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/projects') {
      json(res, 200, projectsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/project') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const d = projectDetail(p);
      if (!d) return json(res, 404, { error: 'unknown project' });
      json(res, 200, d);
    } else if (req.method === 'GET' && url.pathname === '/api/project/block') {
      // The memory block as it actually sits in the project's context file.
      // /api/project/memory returns the memory LOG, which is a different thing:
      // setup's proof step has to show the text agents really read at startup,
      // not a summary of it. Returns the first target that has a block.
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, projectBlockPayload(p));
    } else if (req.method === 'GET' && url.pathname === '/api/project/memory') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const text = memoryMdPayload(p);
      res.writeHead(text === null ? 404 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text === null ? 'No memory log for this project yet.' : text);
    } else if (req.method === 'GET' && url.pathname === '/api/feed') {
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const raw = parseInt(url.searchParams.get('limit'), 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;
      const rawWindow = parseInt(url.searchParams.get('window'), 10);
      const window = Number.isFinite(rawWindow) ? Math.min(Math.max(rawWindow, 1), 168) : null;
      json(res, 200, await feedPayload({
        author: q('author'), project: q('project'), source: q('source'),
        before: q('before'), since: q('since'), limit, window,
      }));
    } else if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const query = String(url.searchParams.get('q') || '').trim();
      // An empty query is a legitimate UI state (the box before you type), not
      // a client error: answer with an empty result set so the page renders
      // its resting state instead of an error banner.
      if (!query) return json(res, 200, { query: '', total: 0, results: [] });
      const rawLimit = parseInt(url.searchParams.get('limit'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
      json(res, 200, activity.searchMemory({
        query, limit,
        author: q('author'), project: q('project'), tool: q('tool'),
        since: q('since'), until: q('until'), file: q('file'),
      }));
    } else if (req.method === 'GET' && url.pathname === '/api/session') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return json(res, 400, { error: 'id required' });
      const s = sessionPayload(id);
      if (!s) return json(res, 404, { error: 'unknown session' });
      json(res, 200, s);
    } else if (req.method === 'GET' && url.pathname === '/api/catchup') {
      json(res, 200, catchupPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/scan') {
      json(res, 200, scanPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/savings') {
      json(res, 200, savingsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/spend') {
      json(res, 200, measuredSpendPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/settings') {
      json(res, 200, settingsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/team') {
      json(res, 200, await teamPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      const saved = saveSettings(body);
      json(res, saved && saved.error ? 400 : 200, saved);
    } else if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      // Tests the pasted key if one is provided, else the stored/env key.
      const body = await readBody(req);
      const adv = advisor.getAdvisorConfig(getConfig());
      const key = String(body.apiKey || '').trim() || adv.apiKey;
      json(res, 200, await advisor.testKey(key, adv.model));
    } else if (req.method === 'GET' && url.pathname === '/api/advisor') {
      json(res, 200, advisorPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/advisor') {
      const body = await readBody(req);
      saveSettings({ advisor: body });
      json(res, 200, advisorPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/advisor/test') {
      const body = await readBody(req);
      const config = getConfig();
      const provider = advisor.providers.byId(body.provider) ? body.provider : advisor.getAdvisorConfig(config).provider;
      const adv = advisor.getAdvisorConfig({ ...config, advisor: { ...(config.advisor || {}), provider } });
      const adapter = advisor.providers.byId(provider);
      const callerKey = String(body.apiKey || '').trim();
      const callerBase = String(body.baseUrl || '').trim();
      // SECURITY: a caller-supplied base URL must NEVER be paired with a
      // server-held key. Pairing them turned this route into a key-exfiltration
      // endpoint for anything that can reach the daemon: the OpenAI and Google
      // adapters honour any base URL they are handed, so a POST naming an
      // attacker host shipped the victim's OPENAI_API_KEY / GEMINI_API_KEY
      // straight to it. Two rules, both required:
      //   • only a provider that genuinely needs a base URL may be retargeted.
      //     getAdvisorConfig already refuses to READ a stored baseUrl for the
      //     others (needsBaseUrl: false); honouring one from the body bypassed
      //     exactly that decision.
      //   • whoever supplies a base URL must supply the key that goes with it.
      if (callerBase) {
        if (!adapter.needsBaseUrl) {
          return json(res, 400, { ok: false, error: `${adapter.label} does not use a custom base URL.` });
        }
        if (!callerKey) {
          return json(res, 400, { ok: false, error: 'Enter the API key for that base URL. A stored key is never sent to a custom endpoint.' });
        }
      }
      const key = callerKey || adv.apiKey;
      const baseUrl = callerBase || adv.baseUrl;
      json(res, 200, await advisor.testKey(key, adv.model, { provider, baseUrl }));
    } else if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim() || null;
      const local = syncOnce(projectPath ? { project: projectPath } : {});
      const team = await runTeamSync(projectPath);
      json(res, 200, { ...local, team });
    } else if (req.method === 'POST' && url.pathname === '/api/share-session') {
      // Apply the change to the backend FIRST, then persist the local flag only
      // if that succeeded. A normal sync only pushes entries newer than the push
      // cursor, so it never revisits an already-synced row — meaning a failed
      // reshare is NOT reconciled later. Persisting the flag regardless would let
      // the local badge claim a team-visibility state the backend never accepted.
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim();
      const session = String(body.session || '').trim();
      const share = !!body.share;
      if (!projectPath || !session) return json(res, 400, { error: 'project and session required' });
      // Scan first: a LIVE session's newest events may not be in persisted
      // state yet (the feed scans on its own cadence). Ingesting now means
      // reshareSession finds the rows and INSERTS them as part of the share —
      // share-on-live works instead of no-opping on an empty row set.
      try { syncOnce({ project: projectPath }); }
      catch (err) { log(`share-session: pre-scan failed: ${err.message}`); }
      const state = loadState();
      const key = findProjectKey(state, projectPath);
      const proj = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      let reshare;
      try { reshare = await teamsync.reshareSession(getConfig(), key, session, share); }
      catch (err) { reshare = { ok: false, error: err.message }; }
      if (!reshare.ok) {
        // Leave sharedSessions untouched so isShared (and the card badge) keep
        // reporting the last state the team actually saw — and log the reason,
        // which never used to reach the log at all.
        log(`share-session: reshare failed for ${session}: ${reshare.error || 'unknown'}`);
        return json(res, 200, { ok: false, shared: teamsync.isShared(getConfig(), proj, session), reshare });
      }
      const set = new Set(Array.isArray(proj.sharedSessions) ? proj.sharedSessions : []);
      if (share) set.add(session); else set.delete(session);
      proj.sharedSessions = [...set];
      saveState(state);
      json(res, 200, { ok: true, shared: share, reshare });
    } else if (req.method === 'POST' && url.pathname === '/api/team/signup') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim();
      if (!email || !password || !displayName) return json(res, 400, { error: 'name, email, and password are required' });
      const result = await teamsync.signup(getConfig(), email, password, displayName);
      json(res, 200, { needsConfirmation: !!result.needsConfirmation, email: result.email });
    } else if (req.method === 'POST' && url.pathname === '/api/team/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) return json(res, 400, { error: 'email and password are required' });
      const result = await teamsync.login(getConfig(), email, password, String(body.displayName || '').trim());
      json(res, 200, { email: result.email, displayName: result.displayName });
    } else if (req.method === 'POST' && url.pathname === '/api/team/oauth-complete') {
      // SECURITY (audit F1): this route adopts a Supabase session, so it is the
      // one endpoint where an absent Origin cannot be read as "a friendly local
      // client". sameOrigin() allows a missing Origin on purpose, because the
      // CLI and the tests post without one, and that global behavior is left
      // exactly as it is. Here it is tightened: only a browser ever completes a
      // sign-in, and browsers always set Origin on a POST, so requiring it
      // costs no real caller and denies any other local process the ability to
      // hand the daemon a session.
      if (!req.headers.origin) return json(res, 403, { error: 'origin required' });
      const body = await readBody(req);
      // Verified AND consumed before a single token is looked at. Absent,
      // unknown, expired and already-used all return null, so a callback the
      // daemon never started, or one replayed, never reaches teamsync at all.
      const pending = teamsync.consumeOAuthState(body.state);
      if (!pending) {
        return json(res, 403, {
          error: 'this sign-in did not start here, or it already finished - start again from MemBridge',
        });
      }
      // PKCE first: a code is exchanged with the verifier held alongside the
      // state. The fragment tokens remain accepted for a backend that ignored
      // the challenge, and are equally state-bound.
      const result = body.code
        ? await teamsync.exchangeOAuthCode(getConfig(), String(body.code), pending.verifier)
        : await teamsync.loginWithTokens(
          getConfig(), String(body.accessToken || ''), String(body.refreshToken || ''), body.expiresIn,
        );
      json(res, 200, { email: result.email, displayName: result.displayName });
    } else if (req.method === 'POST' && url.pathname === '/api/team/logout') {
      teamsync.clearCredentials();
      json(res, 200, { authenticated: false });
    } else if (req.method === 'POST' && url.pathname === '/api/team/create') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'team name is required' });
      json(res, 200, await teamsync.createTeam(getConfig(), name));
    } else if (req.method === 'POST' && url.pathname === '/api/team/join') {
      const body = await readBody(req);
      const inviteCode = String(body.inviteCode || '').trim();
      if (!inviteCode) return json(res, 400, { error: 'invite code is required' });
      const joined = await teamsync.join(getConfig(), inviteCode);
      // NO recordAudit HERE, and its absence is the fix rather than an
      // omission. This route used to write the `member-joined` row itself,
      // under a comment claiming the row "lands on a team the caller is now a
      // member of — team_audit's RLS insert policy requires exactly that". The
      // policy is `is_team_manager(team_id) and actor_id = auth.uid()`
      // (024 §5, tightened by 025 §5): it requires MANAGER, not member. A
      // fresh joiner is always role 'member', so the insert was refused by
      // RLS every time, and recordAudit swallows its own failures by design —
      // so the one event that records somebody GAINING access to the team's
      // memory has never once landed. Confirmed against production: team_audit
      // holds invite-created and invite-revoked rows and zero joins.
      //
      // Migration 046 writes it from an AFTER INSERT trigger on
      // team_members instead, where it fires from the membership insert itself
      // and cannot be composed by a caller. A client-side call alongside that
      // would be dead weight at best — a call that can only ever fail reads as
      // coverage — and a double-count if the policy were ever widened.
      json(res, 200, joined);
    } else if (req.method === 'POST' && url.pathname === '/api/team/invite') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      const days = parseInt(body.expiresDays, 10);
      const maxUses = parseInt(body.maxUses, 10);
      const invite = await teamsync.createInvite(getConfig(), teamId, {
        expiresAt: Number.isFinite(days) ? new Date(Date.now() + days * 86400000).toISOString() : null,
        maxUses: Number.isFinite(maxUses) ? maxUses : null,
      });
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'invite-created', objectType: 'invite', objectKey: invite && invite.token, detail: null,
      });
      json(res, 200, invite);
    } else if (req.method === 'GET' && url.pathname === '/api/team/members') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { members: await teamsync.listMembers(getConfig(), teamId) });
    } else if (req.method === 'GET' && url.pathname === '/api/team/feed') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const limit = parseInt(url.searchParams.get('limit'), 10);
      const beforeId = parseInt(url.searchParams.get('beforeId'), 10);
      const config = getConfig();
      const rows = await teamsync.teamFeed(config, teamId, {
        author: q('author'),
        project: q('project'),
        source: q('source'),
        beforeCreatedAt: q('beforeCreatedAt'),
        beforeId: Number.isFinite(beforeId) ? beforeId : null,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      // Same read-side redaction as feedPayload: these are server rows, and a
      // hostile or legacy backend row must not surface raw free text.
      const rx = digest.compileRedactions(config);
      const scrubRow = r => ({
        ...r,
        ask: r.ask ? digest.redactText(r.ask, rx) : r.ask,
        summary: r.summary ? digest.redactText(r.summary, rx) : r.summary,
      });
      // Fail closed: anything but the expected array (or the null of an empty
      // 204) must not pass through unscrubbed.
      json(res, 200, { entries: Array.isArray(rows) ? rows.map(scrubRow) : (rows == null ? rows : []) });
    } else if (req.method === 'GET' && url.pathname === '/api/team/projects') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { projects: await teamProjectsPayload(teamId) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/remove-member') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const userId = String(body.userId || '').trim();
      if (!teamId || !userId) return json(res, 400, { error: 'team and member are required' });
      // Read the name BEFORE the removal, from the roster rather than from
      // the request body: readAudit resolves names against the CURRENT
      // roster, and a removed member is not on it, so this event would
      // otherwise render as a bare user id forever. Not taken from the body —
      // that is unvalidated free text, and the audit trail is exactly where
      // caller-supplied strings must not be able to write whatever they like.
      const removedName = await memberDisplayName(teamId, userId);
      await teamsync.removeMember(getConfig(), teamId, userId);
      // Logged AFTER the mutation resolved, and never in a way that can fail
      // it (apiAccess.recordAudit swallows its own errors by design).
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'member-removed', objectType: 'member', objectKey: userId,
        detail: { memberId: userId, targetName: removedName },
      });
      json(res, 200, { removed: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/set-role') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const userId = String(body.userId || '').trim();
      const role = String(body.role || '').trim();
      if (!teamId || !userId || !role) return json(res, 400, { error: 'team, member, and role are required' });
      // Availability guard, not an authorization one. Hiding the self-demote
      // select in the dashboard fixes the dashboard; POST /api/team/set-role
      // is reachable by anything that can talk to 127.0.0.1, so the rule that
      // actually matters has to be enforced where the write is, not where the
      // button was. See lastManagerBlock for what is and is not checked, and
      // for why this is the daemon's job rather than the RPC's.
      const members = await teamsync.listMembers(getConfig(), teamId).catch(() => null);
      const blocked = lastManagerBlock(members, userId, role);
      // 409, not 403: the caller is allowed to change roles, the TEAM is just
      // in a state where this particular change has no way back.
      if (blocked) return json(res, 409, { error: blocked });
      await teamsync.setRole(getConfig(), teamId, userId, role);
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'role-changed', objectType: 'member', objectKey: userId,
        detail: { memberId: userId, role },
      });
      json(res, 200, { role });
    } else if (req.method === 'POST' && url.pathname === '/api/team/rename') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const name = String(body.name || '').trim();
      if (!teamId || !name) return json(res, 400, { error: 'team and name are required' });
      await teamsync.renameTeam(getConfig(), teamId, name);
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'team-renamed', objectType: 'team', objectKey: teamId, detail: { name },
      });
      json(res, 200, { name });
    } else if (req.method === 'POST' && url.pathname === '/api/team/rotate-invite') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { inviteCode: await teamsync.rotateInvite(getConfig(), teamId) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/revoke-invite') {
      const body = await readBody(req);
      const raw = String(body.token || '').trim();
      if (!raw) return json(res, 400, { error: 'invite token is required' });
      // Normalized ONCE, here, and used for the revoke, the team lookup and
      // the audit row alike. This route accepts a whole invite URL as well as
      // a bare token (parseInviteToken reads both the `#token` and legacy
      // `/join/token` shapes), and the audit row used to record whatever the
      // caller pasted. So revoking by pasting a link filed
      // `objectKey: "https://app.membridge.app/#kbmYFKG06w"` against an
      // invite-created row whose objectKey was `kbmYFKG06w` — two rows about
      // one invite that a reader cannot connect, and a revocation that appears
      // to be for an invite the trail never saw created.
      const token = teamsync.parseInviteToken(raw);
      await teamsync.revokeInvite(getConfig(), token);
      // teamId is not in the body for this route (the token identifies the
      // invite on its own), so it is looked up FROM THE INVITE — never
      // firstTeamId(), which is plain teams[0] and files a second team's
      // revocation against the first. See apiAccess.inviteTeamId for the two
      // failure modes that produced. Resolved after the revoke, not before,
      // so the mutation stays first and a lookup that fails cannot stop it;
      // null means the event is skipped rather than misfiled.
      const revokeTeam = await apiAccess.inviteTeamId(getConfig(), token);
      if (revokeTeam) {
        await apiAccess.recordAudit(getConfig(), {
          teamId: revokeTeam, action: 'invite-revoked', objectType: 'invite', objectKey: token, detail: null,
        });
      }
      json(res, 200, { revoked: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/leave') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      await teamsync.leaveTeam(getConfig(), teamId);
      json(res, 200, { left: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/suggestion') {
      // Confirm or dismiss an auto-link suggestion; linking starts a sync.
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      if (!projectPath) return json(res, 400, { error: 'project is required' });
      const link = await teamsync.resolveSuggestion(getConfig(), projectPath, !!body.accept);
      if (link) await runTeamSync(projectPath);
      json(res, 200, { linked: !!link });
    } else if (req.method === 'POST' && url.pathname === '/api/team/link') {
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      const teamId = String(body.teamId || '').trim();
      const teamName = String(body.teamName || '').trim();
      if (!projectPath || !teamId) return json(res, 400, { error: 'project and team are required' });
      const projectKey = findProjectKey(loadState(), projectPath);
      if (!projectKey) return json(res, 404, { error: 'unknown project' });
      const link = await teamsync.linkProject(getConfig(), projectKey, teamId, teamName);
      await runTeamSync(projectKey);
      json(res, 200, link);
    } else if (req.method === 'POST' && url.pathname === '/api/team/unlink') {
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      if (!projectPath) return json(res, 400, { error: 'project is required' });
      const projectKey = findProjectKey(loadState(), projectPath);
      if (!projectKey) return json(res, 404, { error: 'unknown project' });
      json(res, 200, { unlinked: teamsync.unlinkProject(projectKey) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/archive-project') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const archived = await archiveSharedProject(p);
      json(res, archived && archived.error ? 404 : 200, archived);
    } else if (req.method === 'POST' && url.pathname === '/api/team/sync') {
      const body = await readBody(req);
      json(res, 200, await runTeamSync(String(body.path || '').trim() || null));
    } else if (req.method === 'GET' && url.pathname === '/api/project/access') {
      // Task 8: per-project access control. Errors carry their own status
      // (401/403/404) from lib/api-access.js — do not let them fall through
      // to the generic 500 handler below.
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      try {
        json(res, 200, await apiAccess.readAccess(getConfig(), p));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'POST' && url.pathname === '/api/project/access') {
      // Manager-only (owner/admin); apiAccess.writeAccess re-derives the
      // caller's role from the backend and 403s a member before writing —
      // the request body's fields are never trusted for authorization.
      const body = await readBody(req);
      try {
        json(res, 200, await apiAccess.writeAccess(getConfig(), body));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'POST' && url.pathname === '/api/project/access-default') {
      // Task 17: "new members join with access". Manager-only, same
      // defense-in-depth split as every other apiAccess write — errors
      // carry their own status (400/403/404), do not fall through to the
      // generic 500 handler below.
      const body = await readBody(req);
      try {
        json(res, 200, await apiAccess.writeAccessDefault(getConfig(), body));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'GET' && url.pathname === '/api/team/access-matrix') {
      try {
        json(res, 200, await apiAccess.accessMatrix(getConfig(), selectedTeamId(url)));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'GET' && url.pathname === '/api/team/audit') {
      const limit = parseInt(url.searchParams.get('limit'), 10);
      try {
        json(res, 200, await apiAccess.readAudit(getConfig(), Number.isFinite(limit) ? limit : undefined, selectedTeamId(url)));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    // -----------------------------------------------------------------------
    // Self-serve deletion of the caller's OWN synced entries (migration 035).
    //
    // NOT IN lib/api-access.js, on purpose, and please do not move them there.
    // That file is the MANAGER-GATED surface: every write in it opens with
    // `if (!isManagerRole(role)) throw new AccessError(403, ...)`, and
    // accessMatrix/readAudit/readInvites do the same on the read side. These
    // two routes are the exact opposite. They must stay available to EVERY
    // member, explicitly including one who was just demoted from admin, and
    // (for the deletion) one who has already left the team. The backend policy
    // is scoped on authorship alone for that reason (035 §1). Anyone
    // pattern-matching the neighbouring team routes onto these and adding a
    // role check would silently lock people out of erasing their own data,
    // which is the one thing this feature exists to make possible.
    //
    // The only gate here is the typed confirmation on the POST, and that is an
    // are-you-sure, not an authorization check.
    // -----------------------------------------------------------------------
    } else if (req.method === 'GET' && url.pathname === '/api/team/my-data') {
      // The preview the confirmation screen reads its number from. Counts come
      // from the my_entry_counts RPC (security definer), NOT from a local read:
      // what matters is what is on the BACKEND, which is not the same set as
      // what is on this disk (other machines push too, and a revoked project
      // would under-report through the normal select path).
      const teamId = selectedTeamId(url) || await firstTeamId();
      if (!teamId) return json(res, 200, { projects: [], total: 0 });
      const rows = await teamsync.myEntryCounts(getConfig(), teamId);
      // The local path for each backend project, where this machine has one.
      // Lets the UI name a folder instead of a uuid. Absent for a project only
      // ever synced from another machine, which is a real and different state
      // from "unknown".
      const pathByProjectId = new Map();
      for (const key of Object.keys(loadState().projects || {})) {
        const link = teamsync.loadTeamLink(key);
        if (link && link.projectId) pathByProjectId.set(String(link.projectId), key);
      }
      const projects = rows.map(r => ({
        projectId: String(r.project_id),
        name: r.project_name || '',
        path: pathByProjectId.get(String(r.project_id)) || null,
        entries: Number(r.entries) || 0,
        firstTs: r.first_ts || null,
        lastTs: r.last_ts || null,
      }));
      json(res, 200, { projects, total: projects.reduce((n, p) => n + p.entries, 0) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/delete-my-data') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim() || await firstTeamId();
      const projectId = String(body.projectId || '').trim() || null;
      if (!teamId) return json(res, 400, { error: 'team is required' });
      // Second deliberate step, after whatever disclosure the control lives
      // behind. 400 rather than 403: the caller is allowed to do this, they
      // just have not confirmed it.
      if (String(body.confirm || '') !== 'DELETE') {
        return json(res, 400, { error: 'confirm must be the string DELETE' });
      }
      // teamsync.deleteMyEntries also writes the deletion watermark that stops
      // the next sync pass re-uploading everything it just removed, and the
      // audit row is written inside the RPC's own transaction (035 §3) rather
      // than through apiAccess.recordAudit, which a plain member's JWT cannot
      // satisfy and which swallows its failures.
      //
      // `projects` is how many LOCAL projects that watermark landed on, which
      // is not the same number as the projects the backend emptied: only the
      // ones this machine has linked can be marked. Reported because it is the
      // only visible sign of the scope of a write nothing else surfaces.
      const r = await teamsync.deleteMyEntries(getConfig(), teamId, projectId);
      json(res, 200, { deleted: r.deleted, projects: r.projects.length });
    } else if (req.method === 'GET' && url.pathname === '/api/team/invites') {
      // The read half of an invite's life. Minting and revoking already had
      // routes; without this one a live invite could never be reviewed or
      // found again, so the revoke route was unreachable from the app.
      // Same error passthrough as the audit route above: apiAccess carries
      // its own 401/403 and must not fall through to the generic 500.
      try {
        json(res, 200, await apiAccess.readInvites(getConfig(), selectedTeamId(url)));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'GET' && url.pathname === '/api/team/insights') {
      // Task 12: manager-only (lib/api-insights.js re-derives the caller's
      // role from the backend, same gate as access-matrix/audit above) —
      // errors carry their own status, do not fall through to the generic
      // 500 handler below. savingsPayload() is this machine's own ledger
      // totals, already computed the same way /api/savings reports them.
      const w = parseInt(url.searchParams.get('window'), 10);
      const windowDays = [7, 30, 90].includes(w) ? w : 30;
      try {
        json(res, 200, await apiInsights.insightsPayload(getConfig(), windowDays, savingsPayload(), selectedTeamId(url)));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'POST' && url.pathname === '/api/open') {
      // Task 17: reveal a known file/folder in the OS file manager.
      // lib/api-machine.js's resolveTrackedPath is the ENTIRE security
      // boundary — it resolves `path` against MemBridge's own tracked
      // project list and verifies the real, symlink-resolved target stays
      // inside that project's real directory before anything is opened.
      // Errors carry their own status (400 for anything that fails that
      // check, 404 for a target that legitimately isn't there).
      const body = await readBody(req);
      try {
        json(res, 200, apiMachine.openTarget(loadState(), body));
      } catch (err) {
        json(res, err.status || 500, { error: err.message });
      }
    } else if (req.method === 'POST' && url.pathname === '/api/daemon/restart') {
      // This process cannot report that it successfully restarted — if it had,
      // it would be gone — so `restarting: true` is a claim about the ATTEMPT,
      // never about completion. The client resolves completion itself, by
      // watching for a daemon to answer again.
      //
      // But it used to write that response BEFORE trying anything, so a restart
      // that failed outright still reported ok:true and the failure existed
      // only in a log no user opens. The spawn is now attempted first and
      // confirmed by the OS (apiMachine.spawnReplacement resolves on the
      // 'spawn' event), so ok:true means a replacement really did start.
      //
      // Ordering still matters for the ONE thing the old comment got right:
      // this process must not exit until the response has been flushed, or the
      // client sees a dropped socket and reports failure for a restart that
      // worked. Hence the exit is scheduled from res 'finish', after the write.
      //
      // On failure this process deliberately does NOT exit. That is the safe
      // direction: leaving a working daemon running costs the user nothing,
      // while exiting after a failed spawn would leave them with no daemon at
      // all — the failure mode the old code could produce silently. A spawn
      // that started but never confirmed is treated as failure for the same
      // reason; if it did start, it will fail to bind the port and exit, which
      // is recoverable, whereas guessing in the other direction is not.
      try {
        await apiMachine.spawnReplacement();
      } catch (err) {
        log(`daemon restart failed: ${err.message}`);
        return json(res, err.status || 500, { error: err.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, restarting: true }));
      res.on('finish', () => apiMachine.scheduleExit());
    } else if (req.method === 'POST' && url.pathname === '/api/mcp/register') {
      // Owner-triggered re-registration: Settings reports MCP as installed
      // from the RECORDED rows (mcpStatusPayload reads lastRegistration(),
      // never re-runs -- see that function's comment), so when a tool
      // claims installed but is actually misbehaving there was no way to
      // force a fresh reconcile short of the CLI. This is the same
      // registerNow() path `membridge mcp register` runs (bin/membridge.js's
      // cmdMcpRegister) -- always available, not gated on the current
      // reported state -- returned as JSON instead of printed to a
      // terminal. mcp-register.js's own isTestHarness guard still applies
      // underneath, so this can never touch a real agent config from a
      // MEMBRIDGE_HOME under the system temp dir.
      const { rows } = mcpRegister.registerNow();
      json(res, 200, { rows });
    } else if (req.method === 'POST' && url.pathname === '/api/hooks/update') {
      // Owner-triggered force-update: rewrites the Stop and recall hooks to
      // the current build regardless of whether hooksVersion already read
      // 'current' (this IS the correct way to get from 'unknown'/'outdated'
      // to 'current' on demand, mirroring /api/mcp/register above). Each
      // hook reports its own ok/detail -- see hooks.forceUpdateHooks -- so a
      // Stop-hook failure can never hide behind a successful recall result.
      json(res, 200, hooks.forceUpdateHooks());
    } else if (req.method === 'POST' && url.pathname === '/api/updates/check') {
      // Task 17: on-demand update check (the only place in this API that is
      // allowed to hit the network for this — GET /api/settings reads the
      // cache only, see settingsPayload's cachedUpdateInfo). Called via the
      // module object (updateCheck.check), not destructured, so tests can
      // substitute it and never touch the real GitHub API.
      const r = await updateCheck.check({ force: true });
      json(res, 200, { current: r.current, latest: r.latest, updateAvailable: r.updateAvailable ? r.latest : null });
    } else if (req.method === 'POST' && url.pathname === '/api/projects/toggle') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: 'path required' });
      json(res, 200, toggleProject(body.path));
    } else if (req.method === 'POST' && (url.pathname === '/api/projects/archive' || url.pathname === '/api/projects/unarchive')) {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      // The handler catches its own errors: an untracked path is a 404 with a
      // JSON body, a failed strip after a persisted pause is a 500 whose body
      // names the recoverable state. Never a partial success reported as 200.
      let r;
      try {
        r = url.pathname === '/api/projects/archive' ? archiveProject(p) : unarchiveProject(p);
      } catch (err) {
        r = { error: (err && err.message) || 'archive failed' };
      }
      json(res, r.error ? (r.error === 'unknown project' ? 404 : 500) : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/projects/adopt') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length) return json(res, 400, { error: 'paths required' });
      json(res, 200, adoptProjects(paths));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/add') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = addProject(p);
      json(res, r.error ? 400 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/projects/delete') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const deleted = deleteProject(p);
      json(res, deleted && deleted.error ? 404 : 200, deleted);
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/mark') {
      const body = await readBody(req);
      const ts = String(body.ts || '').trim() || null;
      json(res, 200, markCaughtUp(ts));
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/undo') {
      json(res, 200, undoCaughtUp());
    } else if (req.method === 'POST' && url.pathname === '/api/projects/remove') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const removed = removeBlockFromProject(p);
      json(res, removed && removed.error ? 404 : 200, removed);
    } else if (req.method === 'POST' && url.pathname === '/api/projects/copy') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = copyPayload(p);
      json(res, r.error ? 404 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/plan/generate') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      const goal = String(body.goal || '').trim();
      if (!p || !goal) return json(res, 400, { error: 'path and goal required' });
      const config = getConfig();
      const state = loadState();
      const key = findProjectKey(state, p);
      const proj = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      if (!Array.isArray(proj.events)) proj.events = [];
      const adv = advisor.getAdvisorConfig(config);
      if (!adv.apiKey && !adv.baseUrl) return json(res, 400, { error: `Add your ${adv.adapter.label} key in Settings first.` });
      const payload = planPayload(key, proj, config, goal);
      const r = await advisor.generatePlan(adv.apiKey, adv.model, payload, { provider: adv.provider, baseUrl: adv.baseUrl });
      if (!r.ok) return json(res, r.status || 502, { error: r.error });
      const saved = {
        goal: payload.goal,
        generatedAt: new Date().toISOString(),
        model: r.model,
        costUsd: r.costUsd,
        usage: r.usage,
        plan: r.plan,
      };
      fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
      fs.writeFileSync(planPath(key), JSON.stringify(saved, null, 2));
      // Re-render this project's memory block right away so the roadmap line
      // reaches CLAUDE.md/AGENTS.md now, not on the next activity. syncOnce
      // skips paused/missing projects on its own.
      syncOnce({ project: key });
      json(res, 200, { ok: true, plan: saved });
    } else if (req.method === 'POST' && url.pathname === '/api/briefing/generate') {
      const body = await readBody(req);
      // Default the window to "since you last looked" so a briefing is always a
      // catch-up even if the client omits `since` (review MEDIUM #2).
      const catchupState = loadState().catchup || {};
      const since = String(body.since || '').trim() || catchupState.lastViewedTs || null;
      const config = getConfig();
      const adv = advisor.getAdvisorConfig(config);
      // No key -> degrade, exactly like the roadmap path does (the FE offers
      // "add an API key" instead of a briefing).
      if (!adv.apiKey && !adv.baseUrl) return json(res, 200, { degraded: true });
      // Only teammates' work belongs in a catch-up briefing: drop our own rows
      // (self), then group what's left by author. feedPayload already tags each
      // entry with { self, author, ... } and forwards `since` to the team feed.
      const feedRes = await feedPayload({ since, limit: 200 });
      const byAuthor = new Map();
      for (const e of feedRes.entries || []) {
        if (e.self) continue;
        const name = e.author || 'Teammate';
        if (!byAuthor.has(name)) byAuthor.set(name, []);
        byAuthor.get(name).push({ ts: e.ts, source: e.source, ask: e.ask, summary: e.summary, files: e.files, project: e.project });
      }
      const teammates = [...byAuthor.entries()].map(([name, entries]) => ({ name, entries }));
      const now = new Date().toISOString();
      const r = await advisor.generateBriefing(adv.apiKey, adv.model, { since, until: now, teammates }, { provider: adv.provider, baseUrl: adv.baseUrl });
      if (r.error) return json(res, 502, { error: r.error });
      // Cache the briefing (overwrite = "Regenerate", same as the roadmap). Merge
      // defensively so we never clobber the catch-up read pointers.
      const state = loadState();
      const catchup = state.catchup || { lastViewedTs: null, prevViewedTs: null, briefing: null };
      saveState({ ...state, catchup: { ...catchup, briefing: { text: r.text, generatedAt: now, since } } });
      json(res, 200, { text: r.text, generatedAt: now, degraded: false });
    } else if (req.method === 'GET') {
      // SPA fallback, now that the rebuilt UI owns / instead of /app: any
      // other GET is either the shell, one of its static assets, or a
      // client-side route (e.g. /projects, /team/members) -- serveAppRequest
      // decides which, and 404s a genuinely missing asset rather than
      // masking it as the shell.
      serveAppRequest(url.pathname, res);
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    log(`dashboard error ${req.method} ${url.pathname}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

// The port the dashboard server actually bound, for Task 17's GET
// /api/settings daemonPort field. Not just config.dashboardPort echoed back:
// this is set from the listening socket itself, the same value startServer's
// own retry loop eventually succeeds at binding.
let lastBoundPort = null;
function boundPort() {
  return lastBoundPort;
}

// Local-only by design: binds 127.0.0.1, never an external interface.
// A fast stop→start can find the port still held by the dying daemon; without
// a retry the new daemon would keep syncing forever with a dead dashboard.
function startServer(port, opts = {}) {
  const retries = opts.retries === undefined ? 20 : opts.retries;
  const retryDelayMs = opts.retryDelayMs === undefined ? 500 : opts.retryDelayMs;
  const server = http.createServer(handle);
  let attempt = 0;
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      if (attempt < retries) {
        attempt++;
        log(`dashboard port ${port} in use, retrying (${attempt}/${retries})`);
        setTimeout(() => server.listen(port, '127.0.0.1'), retryDelayMs).unref();
      } else {
        log(`dashboard port ${port} still in use after ${retries} retries; giving up (is another MemBridge running?). Sync continues without the dashboard.`);
      }
      return;
    }
    log(`dashboard server error: ${err.message}`);
  });
  server.listen(port, '127.0.0.1', () => {
    lastBoundPort = server.address().port;
    log(`dashboard on http://127.0.0.1:${port}`);
  });
  server.on('close', () => {
    if (lastBoundPort === port) lastBoundPort = null;
  });
  return server;
}

module.exports = { startServer, boundPort, oauthCallbackPage, statusPayload, noteTick, tickHealth, _resetTickForTests, projectBlockPayload, projectsPayload, projectDetail, planPayload, toggleProject, addProject, adoptProjects, deleteProject, removeBlockFromProject, archiveProject, unarchiveProject, copyPayload, settingsPayload, saveSettings, teamPayload, teamProjectsPayload, runTeamSync, scanPayload, savingsPayload, measuredSpendPayload, feedPayload, sessionPayload, catchupPayload, markCaughtUp, undoCaughtUp, dailySessionBuckets, lastManagerBlock };
