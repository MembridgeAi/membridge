'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('./util');
const { getConfig, loadState, saveState, loadUserConfig, saveUserConfig, ensureConfig, isProjectOff, log, effectiveTargets, EXTRA_TARGETS } = require('./util');
const advisor = require('./advisor');
const digest = require('./digest');
const blockSpan = require('./block-span');
const repoRoot = require('./repo-root');
const redact = require('./redact');
const hooks = require('./hooks');
const mcpRegister = require('./mcp-register');
const memorydb = require('./memorydb');
const ledgerStore = require('./ledger-store');
const ledger = require('./ledger');
const { normalizeAvoided, normalizeHoldout, normalizeNotes, normalizeBilled } = require('./ledger-fold-state');
const roi = require('./roi');
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
const searchIndex = require('./search-index');
const teampins = require('./teampins');
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
    // `enabled`/`plaintextOff` are CONFIG — what this machine intends. They
    // said nothing about what actually arrived, which is how a plaintext
    // downgrade could sit under a green badge. `verified` is evidence: at
    // least one team has been OBSERVED sending ciphertext (teamsync's E2E
    // ledger, state.teamE2E). `plaintextRows` is the counter-evidence from
    // the last sync pass: rows that arrived with no ciphertext from a team
    // that is encrypting. They were rendered unreadable, and the badge must
    // not read "encrypted" as though nothing happened.
    encryption: {
      enabled: ((config.team || {}).encrypt !== false),
      plaintextOff: teamsync.plaintextOffFor(config),
      paused: state.teamCryptoPaused || null,
      keyAlerts: Array.isArray(state.keyAlerts) ? state.keyAlerts.length : 0,
      verified: Object.values(state.teamE2E || {}).some(t => t && t.active),
      plaintextRows: state.teamPlaintextRows || null,
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

// Newest headline-or-summary for THIS PROJECT, in {text, author, at} shape or
// null. Scans the project's own events newest-first — a summary event carries
// text as .text and can also carry a .headline; a distilled summary supersedes a
// harvested one at the same session, but ordering on ts alone is enough for the
// "newest text" question because pickSummary would only pick a NEWER distilled
// entry over an OLDER harvested one. Own events only: this is a lightweight
// per-row field, and buildEntries' full assembly would rebuild the entire feed
// for every project every /api/projects call. Team-half summaries surface
// through the feed and were never in the client's derivation anyway.
//
// Every free-text field is re-redacted at this boundary — same rule as the
// feed and the injected block. `regexes` is compiled once per projectsPayload
// call and threaded in so the loop pays for one compile, not one per project.
function latestSummaryForProject(proj, regexes) {
  const events = Array.isArray(proj && proj.events) ? proj.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== 'summary') continue;
    const text = ev.headline || ev.text;
    if (!text) continue;
    return {
      text: digest.redactText(text, regexes),
      author: 'You',
      at: ev.ts,
    };
  }
  return null;
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
      // Two fields the client used to derive by scanning a merged /api/feed
      // page. The Projects page's getProjects() fetched /api/projects AND
      // /api/feed?limit=100 in parallel and mapped rows against the feed's
      // entries; the projects call itself is 21ms local, the feed call is
      // ~800ms (measured against a 250ms/request backend) with two authenticated
      // round trips — so the projects page dragged the whole merged feed onto
      // its critical path just to compute these two fields. Serving them here
      // is the same walk projectsPayload already does over proj.events (the
      // sessionIds loop above) plus one traversal of the cached team rows.
      //
      // BEHAVIOUR CHANGE, DELIBERATE. The old derivation was
      //   "newest headline || summary in this project's slice of the newest 100
      //    merged entries across every project"
      // — which returned null for a project whose newest activity was #150 in
      // the merged feed. That is the same top-N-page defect the Insights code
      // fixed once already (see api-insights.js's 97-shared-entries incident
      // note): a per-project figure derived from a page shared with every
      // other project cannot be honest at scale. Server-side computation is
      // scoped to THIS PROJECT's own events, so a summary reappears for
      // projects the old code silently dropped. Not a regression — a
      // correction — and the alternative (a per-project /api/projects that
      // still needs the merged feed) would have been the same defect one
      // endpoint over.
      //
      // RECENT-AUTHOR IDs are drawn from the team-row CACHE only, not from
      // local sessions: this field's job is "which teammates showed up here",
      // and this install's own author id is already every project's most
      // recent local author by construction. Same set the old derivation
      // reached (feed entries are normalized-team rows for the teammate half),
      // but now without a merged-feed cap.
      latestSummary: latestSummaryForProject(proj, regexes),
      recentAuthorIds: [...new Set(util.teamRowsFor(proj).map(r => r.author_id).filter(Boolean))],
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
  // Every project's controlled-comparison block, collected for pooling below.
  // Deliberately NOT projected per project onto the wire: one project's own
  // sample is nowhere near enough to support an effect figure, and a per
  // project block on the payload is an invitation to render exactly that.
  const comparisons = [];
  const totals = {
    volume: 0, requests: 0, reads: { first: 0, sameSession: 0, crossSession: 0 },
    // Direct avoidance / holdout (spec §7.1/§7.2, Task 6). Tokens only -- no
    // dollar figure is ever computed for these, let alone served (spec
    // §8.1) -- and "avoided", never "saved" (spec §8.2): this measures
    // tokens not loaded, not a claim the bill fell.
    // tierUnknown is a BREAKDOWN of serves already counted, never a new claim:
    // tierA + tierB + tierUnknown === serves. It exists so a later reader can
    // tell a rise in the pointer tier from a rise in eligibility.
    avoided: { tokens: 0, serves: 0, tierA: 0, tierB: 0, tierUnknown: 0, partialWins: 0, netNegatives: 0 },
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
    if (led.comparison) comparisons.push(led.comparison);
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
  //
  // WHAT THE GATE IS COMPUTED FROM CHANGED (measured-savings spec, Tier 3).
  // It used to read totals.holdout.skips -- a cumulative lifetime counter that
  // has been accumulating since before there was a clean cohort, when the
  // holdout was assigned per READ and a single session was partly served and
  // partly withheld. Those skips are real events and the counter is not wrong,
  // but they are not a control group, and gating an effect figure on them
  // would be gating on the quantity of contaminated evidence.
  //
  // The gate now reads the epoch-stamped `comparison` block (lib/roi.js), which
  // zeroes itself on an epoch change, so a machine upgrading into the new
  // assignment scheme correctly reports "measuring" from zero rather than
  // inheriting a count it can no longer use. That restart is the accepted cost
  // of having a cohort at all -- see lib/holdout-epoch.js.
  const measurement = roi.poolMeasurement(comparisons);
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
    //
    // #63 — A READ MUST NOT WRITE. The gate used to be `feedEncryptOn && creds`,
    // so a signed-in install built the crypto context on EVERY /api/feed call,
    // including the solo poll where teamList is empty and there is nothing to
    // decrypt at all. buildCryptoContext bootstraps the identity, and
    // ensureIdentity re-upserts the pubkey on every call, so each 10s poll fired
    // an authenticated POST /rest/v1/member_pubkeys for zero read work.
    //
    // WHY MOVING IT IS SAFE. ensureIdentity's own header (lib/teamsync.js:435)
    // calls that upsert a SELF-HEAL: an idempotent merge on user_id covering a
    // locally-persisted keypair whose FIRST upload failed. It is not a TTL
    // keepalive, so it does not need to run on a schedule. And no consumer on
    // this path reads member_pubkeys: decryptTeamRows resolves a team key from
    // team_keys sealed to our own pubkey, and the pubkey table is fetched only
    // by reconcileTeamKeys/rekeyTeam on the sync side (mkTeamKeyDeps's
    // fetchMemberPubkeys, lib/teamsync.js:715). The self-heal therefore keeps
    // happening — syncTeams calls buildCryptoContext itself on the 60s tick
    // (lib/teamsync.js:2208), which is the push path where a teammate actually
    // needs our published key to seal a team_key to us.
    //
    // WHAT THE GATE ASKS. Exactly what decryptTeamRows needs the context for: a
    // row carrying ciphertext+nonce. Rows without ciphertext (legacy/pre-cutover)
    // pass through that function untouched whether ctx is null or not, so
    // narrowing to ciphertext-bearing rows is behaviour-preserving, and it also
    // keeps a plaintext-only team from re-opening the same write-on-read hole.
    // Fail-closed is unchanged: whenever a ciphertext row IS present the context
    // is built, and if the build fails the row still renders opaque.
    const feedEncryptOn = (((config || {}).team || {}).encrypt !== false);
    const hasRowsToDecrypt = settled.some(r => r.status === 'fulfilled'
      && Array.isArray(r.value) && r.value.some(row => row && row.ciphertext && row.nonce));
    const feedCryptoCtx = feedEncryptOn && creds && hasRowsToDecrypt
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

// Which sessions are running right now — LOCAL READ ONLY, no network, ever.
//
// WHY THIS EXISTS. The "happening now" strip used to come from
// /api/feed?limit=100, which is feedPayload above: a token refresh, my_teams, a
// team_feed RPC per membership and a crypto-context build, then every entry of
// every project assembled, merged, sorted, sliced to 100, and git-diffed for
// file changes. Measured on a real install (10 projects, 5,227 events, 200
// cached team rows) that is ~900ms, of which ~560ms is network. It is mounted by
// the LANDING route and polled every 10 seconds, so a Supabase round trip sat on
// first paint and then repeated forever. The strip's actual yield on that
// install: ONE live session. Everything else was computed and thrown away.
//
// DELIBERATELY SYNCHRONOUS. Not a style choice — a `function` that returns a
// value cannot await a round trip, so "a polled read makes no network call" is
// enforced by the signature instead of by a comment somebody has to keep true.
// If you find yourself needing `await` in here, that is the design failing, not
// the signature: put the network work on the sync path (lib/teamsync.js) and let
// this read what that leaves behind.
//
// WHAT IT COSTS TO BE LOCAL, STATED PLAINLY. Teammate rows come from
// util.teamRowsFor — the cache the team sync already wrote — rather than a live
// team_feed. So a teammate's liveness here is as of the last successful pull,
// not as of this instant. That is NOT a downgrade in what the app claims,
// because feedPayload's team rows were never a live-presence signal either:
// normalizeTeam stamps `liveBasis: 'synced-row'` and its comment says outright
// that the flag is "evidence of recent synced activity, never proof of a current
// remote session". The window is 15 minutes (util.LIVE_WINDOW_MS) and the daemon
// syncs on config.intervalSec (60s by default), so the cache is at most one
// interval behind a judgement made over fifteen. Every row carries its
// liveBasis, and the payload carries teamPulledAt, so a caller can say "as of
// 40s ago" rather than implying presence it does not have.
//
// WHAT IT DOES NOT DO: no `changes` (no git subprocess — the strip shows no file
// list), no paging, no filters, no sort by anything but recency. This answers one
// question. Ask /api/feed for the feed.
function liveSessionsPayload(opts = {}) {
  const config = getConfig();
  const state = loadState();
  const now = Number.isFinite(opts.now) ? opts.now : Date.parse(opts.now || '') || Date.now();
  // One redactor for the whole payload, same closure feedPayload threads into
  // its normalizers. Team rows are server content and are re-redacted here for
  // the same defense-in-depth reason; local entries arrive pre-redacted from
  // buildEntries, so their pass is defensive only.
  const regexes = digest.compileRedactions(config);
  const redact = text => digest.redactText(text, regexes);
  // Own user id, read straight off disk. feedPayload gets this from a token
  // REFRESH and falls back to the stored creds; the refresh is the network call,
  // the id is not — loadCredentials is a JSON.parse of credentials.json.
  //
  // Not cosmetic, and not optional. normalizeTeam decides `self` and `author`
  // from it, and the client groups live rows on `authorId || author`. With a null
  // id, a row THIS account pushed from another machine keys on its real uuid
  // while the local row keys on the string "You" — one person rendered as two,
  // which is the identity-as-display-string defect in this repo's own list.
  const creds = teamsync.loadCredentials();
  const selfUserId = creds ? creds.userId || null : null;

  const sessions = [];
  let teamPulledAt = null;
  let teamCachedRows = 0;
  for (const [key, proj] of Object.entries(state.projects || {})) {
    const events = Array.isArray(proj.events) ? proj.events : [];
    // A session is live if its newest event of ANY kind is recent — ten minutes
    // of file edits produce events but no new prompt or summary, and judging
    // that session dead is the flicker feedPayload's lastEventBySession avoids.
    // Same rule, same map, computed here first so it can be used as a FILTER.
    const lastEventBySession = new Map();
    for (const ev of events) {
      if (!ev || !ev.session || !ev.ts) continue;
      const prev = lastEventBySession.get(ev.session);
      if (!prev || String(ev.ts) > String(prev)) lastEventBySession.set(ev.session, ev.ts);
    }
    const liveLocalSessions = new Set();
    for (const [session, ts] of lastEventBySession) {
      if (util.isLive(ts, now)) liveLocalSessions.add(session);
    }

    const teamRows = util.teamRowsFor(proj);
    teamCachedRows += teamRows.length;
    if (proj.teamPullTs && (!teamPulledAt || String(proj.teamPullTs) > String(teamPulledAt))) {
      teamPulledAt = proj.teamPullTs;
    }
    const liveTeamRows = teamRows.filter(e => e && util.isLive(e.created_at || e.ts, now));
    // Nothing live in this project, from either origin: skip it entirely. This
    // is the whole reason the endpoint is cheap — buildEntries is the expensive
    // local step, and on a real install 9 of 10 projects have nothing live, so
    // it never runs for them. Skipping a project that contributes no rows cannot
    // change the answer; note that it is a SKIP, not a cheaper derivation. The
    // entries for a project that IS live are built by the same buildEntries call
    // feedPayload makes, over the same unfiltered events, so an intent shown
    // here and in the feed can never disagree. (Filtering `events` down to the
    // live sessions before building would be faster and is WRONG: buildEntries
    // carries a running `current` entry across sessions, so an edit event can
    // attach to a different entry once its neighbours are removed.)
    if (!liveLocalSessions.size && !liveTeamRows.length) continue;

    const link = teamsync.loadTeamLink(key);
    const meta = {
      projectPath: key,
      projectName: path.basename(key),
      projectId: link ? link.projectId : null,
      authorId: selfUserId,
      redact,
      lastEventBySession,
      now,
    };
    if (liveLocalSessions.size) {
      const entries = memorydb.buildEntries(key, proj, config, { deferChanges: true });
      // Newest entry per live session: a session has several entries and only
      // its latest reflects what it is doing now. Entries are ordered
      // oldest -> newest, so a plain overwrite keeps the newest.
      const newestPerSession = new Map();
      for (const e of classify.filterShareableEntries(entries, events)) {
        if (!liveLocalSessions.has(e.session || '')) continue;
        newestPerSession.set(e.session || '', e);
      }
      for (const e of newestPerSession.values()) {
        const row = feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta);
        // _highlights is feedPayload's internal carrier for deferred git-change
        // derivation. There is no change derivation here, so it must not ride
        // out in the JSON.
        delete row._highlights;
        row.changes = [];
        sessions.push(row);
      }
    }
    // Newest cached row per (author, session) — the same key lib/provenance.js
    // uses for teammate rows, so the two surfaces fold a teammate's sessions the
    // same way.
    const teamLatest = new Map();
    for (const e of liveTeamRows) {
      const k = `${e.author}|${e.session ? `s:${e.session}` : `t:${e.source}`}`;
      const prev = teamLatest.get(k);
      if (!prev || String(prev.ts) <= String(e.ts)) teamLatest.set(k, e);
    }
    for (const e of teamLatest.values()) {
      // The cache stores rows in wire shape; normalizeTeam is the one reader
      // that knows how to read them, including which clock liveness is judged
      // on. selfUserId comes from the on-disk credentials above, so a row this
      // account pushed from another machine still reads as "You" and folds into
      // the same person as the local rows.
      sessions.push(feed.normalizeTeam({ ...e, project_name: e.project_name || path.basename(key) },
        { selfUserId, redact, now }));
    }
  }

  // Newest first, the order /api/feed already returns and every caller assumes.
  sessions.sort((a, b) => String(b.lastActivityAt || b.ts).localeCompare(String(a.lastActivityAt || a.ts)));
  return {
    sessions,
    // Provenance for the team half, so a caller can label its staleness instead
    // of presenting a cached row as presence. teamPulledAt is the newest
    // per-project pull; teamLastSync is the whole-machine attempt.
    teamPulledAt,
    teamLastSync: state.teamLastSync || null,
    teamCachedRows,
    liveWindowMs: util.LIVE_WINDOW_MS,
    now: new Date(now).toISOString(),
  };
}

// One session, unsliced and uncollapsed, for the session detail page (spec:
// docs/superpowers/specs/2026-07-31-session-detail-page-design.md). The feed
// is the wrong source: /api/feed returns page-sliced, checkpoint-collapsed
// entries, so a session reconstructed from loaded pages silently truncates.
// Local sessions are assembled from memorydb.buildEntries for the owning
// project; team-origin sessions from the pulled cache (util.teamRowsFor).
// Every free-text field passes the same digest.redactText closure /api/feed
// uses -- a session page must never surface a secret the feed suppressed.
// Returns null ONLY when no store on this machine holds the id (the route
// answers 404). That used to include sessions this machine demonstrably still
// held: search reads the durable team archive (lib/activity.js freshenProject
// passes includeArchive), while this function read only the working cache, so
// a teammate's session past the cache window was offered by /api/search and
// then 404'd by /api/session -- 39 of 99 indexed sessions on one real install,
// every one of them a teammate's. The archive pass below closes that, and 404
// now means what it says.
//
// What a team-origin session page structurally does not have, named rather
// than left for the reader to infer from an empty array. `checkpoints: []`
// alone is ambiguous between "this session had none" and "the checkpoint trail
// never crosses team sync", and that ambiguity is the exact kind this product
// exists to remove. `commits` is absent from every team payload because
// attribution is computed from the local commit map, which only covers work
// done on this machine.
const TEAM_UNAVAILABLE = ['checkpoints', 'commits'];

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
    // Tier split, not a collapse-to-latest: digest.sessionSummaries (lib/digest.js
    // 568-575) guarantees its return is HOMOGENEOUS -- every element distilled,
    // or none -- because it is built as `distilled.length ? distilled : all`, and
    // an empty `distilled` means no element of `all` could satisfy that same
    // predicate either. That guarantee is exactly what `.some()` below leans on:
    // checking any one element would already be enough today, but naming the
    // check as "does any element claim the distilled tier" is what keeps this
    // call site correct if sessionSummaries' guarantee is ever loosened to
    // return a mixed list -- it would then fail toward showing LESS (collapsing
    // on any restatement present) rather than toward showing the noise this
    // ticket exists to remove. If that guarantee changes, this site needs
    // re-reading, not just re-running.
    //
    // Distilled checkpoints are each a WHOLE-SESSION restatement by the Stop
    // hook's own contract (lib/digest.js:787, lib/hooks.js:177) -- `summary`
    // above already carries the latest one, so shipping the trail here would
    // put a near-duplicate bullet directly beneath it, and PromptChain would
    // attach a whole-session restatement to whichever single prompt it
    // happened to follow, misattributing the rest of the session's work to
    // that one prompt. Harvested checkpoints (no distilled events for this
    // session) carry none of that risk -- they are last-text-per-checkpoint,
    // genuinely distinct -- so they ship exactly as before.
    const rawCheckpoints = digest.sessionSummaries(events, id);
    const isDistilledTier = rawCheckpoints.some(ev => ev.distilled || ev.source === 'Distilled');
    const checkpoints = isDistilledTier ? [] : rawCheckpoints
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
      heldBy: 'local-events',
      // Your own session, assembled unsliced from your own events: nothing is
      // structurally missing. The one exception is the commit count, which is
      // already omitted above when the commit map could not be read -- naming
      // it here turns that silent omission into a stated one.
      unavailable: commitCount === undefined ? ['commits'] : [],
    };
  }

  // Team-origin, for BOTH stores, through one builder. The working cache holds
  // teamsync pullProject `mapped` rows; the durable archive holds those same
  // rows, normalized through feed.normalizeTeam by activity.loadArchiveEntries.
  // The field names line up, and the only thing that differs is which file the
  // rows came out of -- so this is one function with two call sites rather than
  // two near-identical bodies, which is how one path would keep re-redacting
  // while the other quietly stopped.
  //
  // Rows are server content, so everything is re-redacted here; on the archive
  // path that is a second, idempotent pass over already-redacted text, exactly
  // as the local path re-redacts buildEntries output. An unshared prompt is
  // ask=null on the wire and STAYS null -- the endpoint never fabricates a
  // prompt it does not hold ("(prompt not shared)" is a render concern). No
  // checkpoint trail crosses team sync, on either path.
  const teamSession = (key, rows, heldBy, unavailable) => {
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
      heldBy,
      unavailable,
    };
  };

  // PROVENANCE ONLY, never a gate: the gate already ran inside
  // activity.projectArchiveEntries and let these rows through. An archive whose
  // backward backfill has not finished may not hold this session's earliest
  // rows, which is the difference between a genuinely short session and a
  // silently truncated one.
  const archiveGap = key => {
    try {
      const link = teamsync.loadTeamLink(key);
      if (!link || !link.projectId) return ['earlier-activity'];
      return teamArchive.backfillStatus(link.projectId).backfill.done === true
        ? [] : ['earlier-activity'];
    } catch {
      // The archive's own meta could not be read, so whether the history is
      // complete is UNKNOWN -- and unknown is reported as missing, not as
      // complete. Failing the other way would set a completeness marker the
      // code never verified, which is this codebase's signature defect.
      return ['earlier-activity'];
    }
  };

  // The working cache first: it is the freshest copy of a row it still holds.
  for (const [key, proj] of Object.entries(state.projects || {})) {
    const rows = util.teamRowsFor(proj).filter(r => r && (r.session || '') === id);
    if (!rows.length) continue;
    return teamSession(key, rows, 'team-cache', TEAM_UNAVAILABLE);
  }

  // Then the durable archive -- the long tail past the cache window, and the
  // store /api/search has been answering from all along. Read through
  // activity.projectArchiveEntries, which is the single gate on it: both
  // teamAccessLost and the revocation ledger are checked in there, on every
  // call, ahead of the memo. Never call loadArchiveEntries from here.
  for (const [key, proj] of Object.entries(state.projects || {})) {
    const rows = activity.projectArchiveEntries(key, proj, regexes)
      .filter(r => r && (r.session || '') === id);
    if (!rows.length) continue;
    return teamSession(key, rows, 'team-archive', [...TEAM_UNAVAILABLE, ...archiveGap(key)]);
  }

  // Nothing on this machine holds it. This is now the honest 404 the UI always
  // assumed it was.
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
//
// NOT filtered through activeMembers, unlike the roster endpoint and the
// last-manager guard below. Its one caller resolves the name of a member about
// to be removed, to stamp into that removal's audit row -- attribution, not
// present-tense state. Filtering would write a null name into the permanent
// record of a real action, which is the same mistake as rendering an audit
// actor as 'Unknown' (see lib/api-access.js readAudit).
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
  return { path: key, deleted: true, ...purgeSearchIndex(key) };
}

// Remove the deleted project from the FTS index.
//
// WHY IT IS HERE AND NOT EARLIER IN deleteProject. Everything above this line
// destroys something; this removes a DERIVED copy, and it has to run after
// saveState rather than before it. Once the key is out of state.projects,
// lib/activity.js freshenIndex structurally cannot refill this project (it
// only ever visits tracked projects), so the purge is safe to repeat and a
// failure here can be retried. Run BEFORE the state write, the same purge
// leaves a window in which a concurrent daemon tick re-indexes the project
// between the delete and the save, and the rows come straight back.
//
// WHY THE RESULT IS SHAPED LIKE THIS. This file's characteristic defect is a
// flag recording a success the code never achieved, and a deletion that claims
// to have deleted is its most damaging form. Three processes write search.db,
// so this genuinely can fail. Therefore:
//   - `searchRowsPurged` is set ONLY on the path where the delete ran. It is a
//     count read from the database, not a boolean anyone can assume.
//   - a failure sets `searchPurgeFailed` and never sets `searchRowsPurged`, so
//     no caller can read a success out of the failure shape.
//   - the failure is logged as well as returned: the caller may drop the
//     field, and a silent leak is the whole bug this fixes.
// It does NOT fail the delete. The destructive work above already succeeded
// and cannot be undone, so reporting "delete failed" would be its own lie; the
// reconciliation sweep in freshenIndex is what eventually closes the gap.
function purgeSearchIndex(key) {
  let db = null;
  try {
    db = searchIndex.open();
    return { searchRowsPurged: searchIndex.pruneProject(db, key) };
  } catch (err) {
    log(`delete: could not purge ${key} from the search index (${err.message}) — ` +
      'its rows stay searchable until the next reconciliation pass');
    return { searchPurgeFailed: true, searchPurgeError: err.message };
  } finally {
    if (db) searchIndex.close(db);
  }
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
    // lib/block-span.js resolves this span, and it is the SAME module
    // digest.inject() writes through. This is the READER for the bytes the
    // writer REWRITES, so the two must agree or the dashboard describes a
    // block the writer does not agree exists.
    const inner = blockSpan.firstBlockInner(text);
    if (inner === null) continue;
    const block = inner.trim();
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
      // Alpha readiness Task 5A: the three-value prompt-sharing mode, always
      // normalized through teamsync.readShareMode so a legacy boolean value
      // on disk reads out as 'verbatim' or 'off' — the UI never sees the raw
      // boolean, so a follow-up UI branch (task #17) can render three
      // options without a compatibility branch of its own.
      sharePrompts: teamsync.readShareMode(config),
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
    // Two dashboard-editable fields today (backend URL/anon key), plus the
    // three-value prompt-sharing mode from Task 5A. Everything else under
    // `team` (linked projects, per-session shares, etc.) is preserved.
    //
    // ALL fields validate BEFORE anything writes: a rejected save must
    // persist NOTHING, or a bad value could ride in alongside a good one.
    let teamUrl = null;
    if (body.team.url !== undefined || body.team.anonKey !== undefined) {
      teamUrl = validateTeamUrl(body.team.url);
      if (!teamUrl.ok) return { error: teamUrl.error };
    }
    let sharePrompts = null;
    if (body.team.sharePrompts !== undefined) {
      const v = body.team.sharePrompts;
      // Accept the three modes plus the two legacy aliases the CLI honors,
      // for a matching UI convenience. Anything else is a 400 — the API is
      // strict on this so the UI cannot silently ship a typo across the
      // machine boundary.
      const normalized = v === 'on' ? 'verbatim' : v;
      if (!['off', 'distilled', 'verbatim'].includes(normalized)) {
        return { error: `team.sharePrompts must be one of off, distilled, verbatim (got ${JSON.stringify(v)})` };
      }
      sharePrompts = normalized;
    }
    const nextTeam = { ...(raw.team && typeof raw.team === 'object' ? raw.team : {}) };
    if (teamUrl) {
      nextTeam.url = teamUrl.url;
      nextTeam.anonKey = String(body.team.anonKey || '').trim();
    }
    if (sharePrompts !== null) {
      nextTeam.sharePrompts = sharePrompts;
    }
    raw.team = nextTeam;
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

// Defaults applied by POST /api/team/invite when the caller names no lifetime.
// See the long note at that route: these make a minted token single-purpose,
// which is what DataClient.ts:196-198 already documents it as. Changing either
// value changes every future invite, so change them here and nowhere else.
const INVITE_DEFAULT_EXPIRES_DAYS = 7;
const INVITE_DEFAULT_MAX_USES = 1;

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

// #59 The signal for Search's person filter. Every teammate row on this machine
// used to have an author (name) but no author_id -- that column was projected
// by teamsync only after a later fix, so any row pulled before it has
// authorId=null. The Search picker's option value is the member's uuid
// (ui/src/features/search/SearchPage.tsx: `value={m.id}`) and the daemon's
// author match keys on that uuid first (`entry.authorId === want || …`,
// lib/activity.js). A filter for member M therefore silently misses every
// pre-fix row of M's -- and the empty result is byte-identical to "M has done
// nothing." The interface offers a filter it cannot honestly answer, with no
// signal for the user to notice.
//
// The remedy (`membridge team repull`) already exists and works forward:
// re-pulling a project re-annotates every row it re-fetches with the author_id
// the backend now has. What was missing is a signal the UI can render as
// "some of M's history predates the fix; run repull for that project."
//
// Semantics of the field. BOTH are counts, and both count only what is on
// THIS machine -- a pre-fix row is a local storage property, not a backend
// one, so nothing here can be answered by asking the server:
//   entries  -- how many local team rows have authorId===null and an `author`
//               equal to the member's display_name.
//   projects -- how many DISTINCT local projects those rows are spread over.
//               A count, not a list: it lets the UI say "across 3 projects"
//               instead of "somewhere", but it deliberately does not name
//               them. Naming them would put teammate project paths into a
//               payload whose whole point is that it carries identity
//               metadata only, and the Projects screen already names them.
//
// A member with no matches carries { entries: 0, projects: 0 } rather than no
// field at all. That is the entire point of the ticket: an ABSENT field is
// indistinguishable from "no problem", which is the same silent zero being
// fixed. The UI's condition is `if (m.preFixLocal.entries > 0)`, and it can
// only be written that way because the field is always there.
//
// Name matching is EXACT after trim+lowercase, not the substring fallback
// lib/activity.js's matchesAuthor uses for human input. Exact is right here
// for a specific reason: this counts the rows a repull WOULD attribute, and
// repull stamps author_id from the backend, whose name for the member is
// their display_name verbatim. A substring match would count "Andy" toward
// "Andy Brown" and inflate a number the user is being asked to act on. Two
// members who genuinely share a display name still over-attribute to both --
// a real limit, named here rather than silently miscounted.
//
// COST, measured rather than asserted (scripts are throwaway; numbers are
// from this machine's real 6.1MB state.json, 10 projects / 200 team rows):
//   - the walk itself is free: 0.03ms at 1k rows, 0.39ms at 20k, 0.95ms at
//     50k. teamEntries is capped at MAX_TEAM_ENTRIES=100 per project
//     (lib/teamsync.js), so the corpus is 100 x projects and 50k means 500
//     tracked projects.
//   - loadState() is the real cost: ~12ms, because it re-reads and re-parses
//     the whole 6.1MB file. That is ~400x the walk.
// It is still not worth caching, because this handler ALREADY awaits
// teamsync.listMembers -- a Supabase RPC over the network, tens to hundreds
// of ms -- so the local read is noise inside the request it sits in, and
// loadState is how 20+ other handlers in this file answer local questions.
// If that ever changes, the place to cache is teamPayload's own state read
// (pass `state` in as an argument), NOT a derived count persisted into
// state.json: a stored count needs its own invalidation and would introduce a
// second class of wrong answer -- a stale number reported to the user as
// fact, which is worse than the silent zero this replaces.
function annotatePreFixLocal(members) {
  if (!Array.isArray(members) || members.length === 0) return members || [];
  const state = loadState();
  // One pass over all team rows. Grouped by lower(author): the picker sends
  // uuids, but the corpus for THIS field is exactly the rows the picker
  // cannot match by uuid, and the only signal those rows carry about who
  // wrote them is their `author` name.
  const byName = new Map(); // lower(name) -> { entries: N, projects: Set<projectPath> }
  for (const [projectPath, proj] of Object.entries(state.projects || {})) {
    // util.teamRowsFor, never proj.teamEntries directly. It is the one
    // supported reader of team rows and the only thing that knows a project's
    // access was revoked (it returns [] for teamAccessLost). Reading the array
    // raw would count rows the user may no longer see, and then tell them to
    // repull a project they have lost access to -- reporting a gap for content
    // that is supposed to be invisible. Same reason the other 7 call sites in
    // this file go through it.
    const rows = util.teamRowsFor(proj);
    for (const e of rows) {
      if (e && e.authorId) continue; // has an id, so the uuid filter reaches it — not the gap this reports
      const name = String((e && e.author) || '').trim().toLowerCase();
      if (!name) continue;
      let g = byName.get(name);
      if (!g) { g = { entries: 0, projects: new Set() }; byName.set(name, g); }
      g.entries += 1;
      g.projects.add(projectPath);
    }
  }
  return members.map(m => {
    const key = String(m && m.display_name || '').trim().toLowerCase();
    const g = key ? byName.get(key) : null;
    return { ...m, preFixLocal: g ? { entries: g.entries, projects: g.projects.size } : { entries: 0, projects: 0 } };
  });
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
      avatar: creds.avatar || null,
      avatarColor: creds.avatarColor || null,
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

// Per-member key-alert state for GET /api/team/members.
//
// WHY THIS EXISTS. A teammate's box pubkey is fetched from the server, so a
// compromised backend could substitute its own and read the sealed team key.
// lib/teampins.js pins the first key ever seen and raises an ALERT on any
// later disagreement; that member is then excluded from sealing until a human
// re-pins with `membridge team trust` after comparing fingerprints
// out-of-band. It is the single most important thing the app can tell a user
// about their team — and until now there was no way for it to reach them
// per-member: the UI's chip was gated on a field the daemon never sent, and
// statusPayload's COUNT is only a number. A count says "somebody's key
// changed" and cannot say whose, which is the one thing you need in order to
// go and check.
//
// THREE STATES, NOT TWO, because this is a security signal:
//
//   'alert'   — this member's key does not match what we pinned. Act on it.
//   'ok'      — we hold a pin for them and the last gate run agreed with it.
//   'unknown' — we cannot say. NOT the same as 'ok', and the whole reason
//               this is a string rather than a boolean.
//
// A boolean cannot carry this. `false` for "we never checked" is exactly the
// silent-safe default being fixed here — the UI would render the same nothing
// for "verified" as for "never verified", and the user would read the absence
// of a warning as an assurance nobody made. So the field is always present
// (an ABSENT field is indistinguishable from "no problem", the same pattern
// annotatePreFixLocal follows) and it names the case explicitly.
//
// FOR THE CONSUMER: test it as `keyStatus === 'alert'`. All three values are
// truthy strings, so `if (m.keyStatus)` fires on every member — and the one
// edit that silently puts this bug back is exactly that shortcut.
//
// 'unknown' is the honest answer in three situations, all real:
//   * no pin for this member — they have published no key, or we have never
//     sealed to them. TOFU has not happened yet, so there is nothing to
//     disagree with. Calling that 'ok' would claim a check that never ran.
//   * encryption is off (the team.encrypt=false hatch) — no keys, no gate.
//   * the crypto gate is PAUSED (state.teamCryptoPaused: no key, unavailable
//     crypto). The pins on disk may be stale and nothing is re-checking them,
//     so a green answer would be a claim about a check that is not running.
//
// An 'alert' outranks all of that, deliberately: a key change that was found
// stays found. Turning encryption off afterwards must not silence a finding
// about a key that really did change (syncTeams only rewrites state.keyAlerts
// while encryption is ON, so the record survives exactly that way).
//
// A DEPARTED MEMBER GETS NO ROW, which is the point. This annotates the
// CURRENT roster from the backend, so someone removed from the team simply is
// not here to be flagged; a stale pin for a gone account cannot surface as a
// security warning about them. (statusPayload's count is the other surface and
// is local-only — see removeMember in lib/teamsync.js, which now prunes the
// alert as it removes them, and the sync pass, which rewrites the whole list
// from the roster the backend returns.)
//
// Extracted as a payload function (like teamProjectsPayload below) rather than
// left inline at the route, so the shape can be tested without standing up an
// HTTP server — the roster comes from the backend and the status from three
// local sources, and it is the JOIN of those that has to be right.
async function teamMembersPayload(teamId) {
  // activeMembers: this IS the roster. A soft-deleted account (auth.users
  // .deleted_at set) keeps its team_members row, so listMembers still
  // returns it and the app would present somebody who no longer exists as
  // a current teammate. Present-tense state, so it is filtered here.
  // annotatePreFixLocal adds the "you have local rows the picker cannot
  // attribute" hint downstream of the roster filter, so it operates on the
  // same set the UI sees.
  return annotatePreFixLocal(annotateKeyStatus(teamsync.activeMembers(await teamsync.listMembers(getConfig(), teamId))));
}

function annotateKeyStatus(members) {
  if (!Array.isArray(members) || members.length === 0) return members || [];
  const state = loadState();
  const config = getConfig();
  const encryptionOn = ((config || {}).team || {}).encrypt !== false;
  const gateRunning = encryptionOn && !state.teamCryptoPaused;
  const alerted = new Set((Array.isArray(state.keyAlerts) ? state.keyAlerts : [])
    .map(a => a && a.user_id).filter(Boolean).map(String));
  let pins = {};
  try { pins = teampins.load(); } catch { pins = {}; } // load() is already total; belt and braces
  return members.map(m => {
    const id = String((m && m.user_id) || '');
    if (id && alerted.has(id)) return { ...m, keyStatus: 'alert' };
    if (!gateRunning) return { ...m, keyStatus: 'unknown' };
    return { ...m, keyStatus: (id && pins[id]) ? 'ok' : 'unknown' };
  });
}

// Team projects for the hub: backend stats joined with whichever local folder
// (if any) is linked to each team project, so the UI can cross-link the views.
//
// ARCHIVED PROJECTS ARE EXCLUDED HERE, not by the view. They have always been
// excluded — 005_project_archive.sql put `archived_at is null` into
// project_stats' WHERE clause for this endpoint's benefit — and that is the
// bug: the same absence then also means "you may not see this project", so the
// revocation path reading the same view cannot tell an archived project from a
// revoked one (041_project_stats_carry_archived.sql, and lib/teamsync.js
// visibleProjectIds, which acts on absence by destroying local data).
//
// The product decision is right and stays; it just belongs at the layer that
// wants it rather than baked into a view two unrelated callers share. This
// filter is deliberately shipped BEFORE that migration and works either way:
// against today's backend the view still filters archived rows and this sees
// none, and against the migrated one it drops them here. Tolerant client
// first, widening migration second — so applying 041 cannot change what this
// endpoint returns.
async function teamProjectsPayload(teamId) {
  const rows = await teamsync.projectStats(getConfig(), teamId);
  const state = loadState();
  const localByProjectId = {};
  for (const projectPath of Object.keys(state.projects || {})) {
    const link = teamsync.loadTeamLink(projectPath);
    if (link && link.projectId) localByProjectId[link.projectId] = projectPath;
  }
  return (rows || [])
    // `archived_at` is absent entirely on a pre-041 backend, which is not the
    // same as null and must not read as archived — hence a truthiness test on
    // the value rather than a `in`/hasOwnProperty check on the key.
    .filter(r => r && !r.archived_at)
    .map(r => ({ ...r, localPath: localByProjectId[r.project_id] || null }));
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
    } else if (req.method === 'GET' && url.pathname === '/api/live-sessions') {
      // Local read, no network: safe to poll. See liveSessionsPayload's header
      // for what the team half's cache does and does not claim. Not awaited
      // because it is deliberately synchronous.
      json(res, 200, liveSessionsPayload({}));
    } else if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const query = String(url.searchParams.get('q') || '').trim();
      // An empty query is a legitimate UI state (the box before you type), not
      // a client error: answer with an empty result set so the page renders
      // its resting state instead of an error banner.
      if (!query) return json(res, 200, { query: '', totalKnownHere: 0, totalIsFloor: true, total: 0, results: [] });
      const rawLimit = parseInt(url.searchParams.get('limit'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
      // Same function the MCP tool calls, so the project-visibility gate and
      // the date-bound validation both apply here without a second copy.
      // A rejected date bound is a client error and answers 400 like every
      // other bad-argument route, rather than a 200 whose empty result set
      // reads as "nothing matched".
      const found = activity.searchMemory({
        query, limit,
        author: q('author'), project: q('project'), tool: q('tool'),
        since: q('since'), until: q('until'), file: q('file'),
      });
      // A rejected date bound is a client error: 400, and none of the
      // success-shaped aliasing below applies to it.
      if (found.error) return json(res, 400, found);
      // `total` is a TRANSITIONAL ALIAS on this route only, and it is the field
      // lib/activity.js just stopped shipping because the name is wrong: the
      // count is a floor of what this machine holds (see searchMemory). The
      // app's search page renders it as "N matches" — the same overclaim, aimed
      // at a human instead of an agent — and dropping the key here would blank
      // that count rather than fix it, which is not a trade worth making from
      // this side of the wire.
      //
      // Owned by the UI lane: switch SearchPage to `totalKnownHere` and label
      // it as a floor the way `truncated`/`exact` are already labelled, then
      // this alias comes out. Until then the honest fields ride alongside it,
      // so nothing has to wait on that to be correct.
      json(res, 200, { ...found, total: found.totalKnownHere });
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
      // 200 rather than 409: this is an ordinary outcome of submitting the
      // form, structurally identical to needsConfirmation, which is already a
      // 200. It extends a union the UI contract models rather than adding an
      // error path that has to carry a machine-readable code. The two flags
      // are mutually exclusive -- teamsync.signup never sets both.
      json(res, 200, {
        emailExists: !!result.emailExists,
        needsConfirmation: !!result.needsConfirmation,
        email: result.email,
      });
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
      // Signing out is TWO outcomes, not one: this machine forgot the session,
      // and the backend ended it. The first always happens (see
      // teamsync.signOut — a user offline must still be able to sign out of
      // their own laptop); the second can fail, and when it does, a copy of
      // this machine's credentials taken earlier still works. So `revoked`
      // rides on the response and is true only when the backend confirmed it.
      // A caller that renders a clean "signed out" over revoked:false is
      // making a security claim nothing here supports.
      const out = await teamsync.signOut(getConfig());
      json(res, 200, {
        authenticated: false,
        revoked: out.revoked,
        revokeError: out.revoked ? null : out.error,
      });
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
      // INV-1: an OMITTED lifetime is not a request for an eternal invite.
      //
      // This route has always accepted expiresDays and maxUses. Nothing ever
      // sent them — ui/src/data/LocalDaemonClient.ts posted { teamId } alone —
      // and absent used to mean null, which is "never expires, unlimited uses".
      // Every invite the app has ever minted is therefore permanent, and one
      // minted on 2026-07-25 was still open when this was written.
      //
      // The defaults below make the minted token match what this codebase
      // already says it is: DataClient.ts:196-198 calls these "single-purpose
      // tokens", explicitly contrasted with the standing teams.invite_code,
      // which is "long-lived and unlimited-use by design". The broadcast case
      // already has a mechanism; this one was never meant to be it.
      //
      // A non-positive value is the deliberate opt-out and still means "no
      // limit", so a caller who genuinely wants an open link can say so
      // explicitly. Absent now means the default, not the opt-out — that
      // distinction is the whole fix.
      const asLimit = (raw, fallback) => {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return fallback; // omitted -> safe default
        return n > 0 ? n : null;                  // <= 0 -> deliberately unlimited
      };
      const days = asLimit(body.expiresDays, INVITE_DEFAULT_EXPIRES_DAYS);
      const maxUses = asLimit(body.maxUses, INVITE_DEFAULT_MAX_USES);
      const invite = await teamsync.createInvite(getConfig(), teamId, {
        expiresAt: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
        maxUses,
      });
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'invite-created', objectType: 'invite', objectKey: invite && invite.token, detail: null,
      });
      json(res, 200, invite);
    } else if (req.method === 'GET' && url.pathname === '/api/team/members') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { members: await teamMembersPayload(teamId) });
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
      // Removal now rotates the team key so the removed device's copy stops
      // opening new content (teamsync.removeMember). The rotation is
      // best-effort — it must never undo a removal that already landed — so
      // its outcome rides back to the client instead of being swallowed: a
      // removal whose key did NOT rotate is a materially weaker removal, and
      // the UI has to be able to say so.
      const removal = await teamsync.removeMember(getConfig(), teamId, userId);
      // Logged AFTER the mutation resolved, and never in a way that can fail
      // it (apiAccess.recordAudit swallows its own errors by design).
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'member-removed', objectType: 'member', objectKey: userId,
        detail: { memberId: userId, targetName: removedName },
      });
      const rekey = (removal && removal.rekey) || null;
      json(res, 200, {
        removed: true,
        // null under the encrypt:false hatch (there is no key to rotate).
        keyRotated: rekey ? !!rekey.ok : null,
        keyEpoch: rekey && rekey.ok ? rekey.epoch : null,
        keyRotationError: rekey && !rekey.ok ? (rekey.error || 'rekey failed') : null,
        keyWithheldFrom: rekey && rekey.ok ? (rekey.withheld || []) : [],
      });
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
      // activeMembers, and here it makes the guard CORRECT rather than tidy.
      // lastManagerBlock refuses a demotion that would leave the team with no
      // manager. A soft-deleted owner counted as a manager, so `othersLeft`
      // could be satisfied by an account nobody can sign into -- letting you
      // demote the last REAL manager and strand the team. Filtering makes the
      // guard see the team as it actually is. Same family as the last-owner
      // prerequisite in docs/ACCOUNT-DELETION.md §4.1.
      const members = teamsync.activeMembers(
        await teamsync.listMembers(getConfig(), teamId).catch(() => null));
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
    } else if (req.method === 'POST' && url.pathname === '/api/team/set-display-name') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const avatar = body.avatar ? String(body.avatar) : null;
      const avatarColor = body.avatarColor ? String(body.avatarColor) : null;
      // Refused here, before the network: a name that trims to nothing is not
      // a backend question. `code: 'MB002'` is carried on these too, not just
      // the RPC-derived ones below -- MB002 already means "validation
      // failure", and a caller (Task 6's dialog) should not have to know
      // whether the rule that rejected it ran in JavaScript or SQL to react
      // correctly. Without this, the two rejections a user hits most often
      // (empty name, over-length name) would arrive with no code at all.
      if (!name) return json(res, 400, { error: 'a display name is required', code: 'MB002' });
      if (name.length > 80) return json(res, 400, { error: 'a display name must be 80 characters or fewer', code: 'MB002' });
      let result;
      try {
        result = await teamsync.setDisplayName(getConfig(), name, avatar, avatarColor);
      } catch (err) {
        // Keyed off the SQLSTATE-derived RPC code, never the message text: the
        // message is user-facing prose and will be reworded. A malformed-RPC-
        // result error carries no .code and must fall through to the generic
        // 500 below rather than being flattened into a 400/409.
        if (err.code === 'MB001') return json(res, 409, { error: err.message, code: err.code });
        if (err.code === 'MB002') return json(res, 400, { error: err.message, code: err.code });
        throw err;
      }
      // No apiAccess.recordAudit call here, deliberately: team_audit's insert
      // policy is `is_team_manager(team_id) and actor_id = auth.uid()` (024
      // §5, tightened by 025 §5) -- manager-only -- but renaming yourself is
      // self-service for every member, so for any non-manager that call would
      // be refused by RLS and swallowed by recordAudit's design, landing this
      // 200 with no audit row anywhere. Same shape as `/api/team/delete-my-data`
      // just above (035 §3): the `member-renamed` row is written by
      // set_display_name itself, inside the same transaction as the UPDATE,
      // because a security-definer RPC is the only thing that can insert this
      // row for a non-manager. Do not add a recordAudit call back here.
      json(res, 200, result);
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
    } else if (req.method === 'POST' && url.pathname === '/api/team/transfer-ownership') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const userId = String(body.userId || '').trim();
      if (!teamId || !userId) return json(res, 400, { error: 'team and member are required' });
      // Resolved from the roster, never from the request body -- same rule as
      // remove-member: the audit trail is exactly where caller-supplied
      // strings must not be able to write whatever they like. Read before the
      // transfer only for consistency with that route; unlike a removal, both
      // parties are still on the roster afterwards.
      const newOwnerName = await memberDisplayName(teamId, userId);
      await teamsync.transferOwnership(getConfig(), teamId, userId);
      // After the mutation resolved, and unable to fail it (recordAudit
      // swallows its own errors by design). Handing over the owner role is the
      // single most consequential team change short of disbanding, so it must
      // leave a record even though no membership row appeared or vanished --
      // neither the join trigger nor the departure trigger fires on a role
      // change, so without this line the handover is invisible.
      await apiAccess.recordAudit(getConfig(), {
        teamId, action: 'ownership-transferred', objectType: 'member', objectKey: userId,
        detail: { memberId: userId, targetName: newOwnerName },
      });
      json(res, 200, { transferred: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/disband') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      // No audit row, deliberately. team_audit.team_id references the team
      // being deleted and cascades with it (024:43), so a row written here
      // would be destroyed by the statement it describes. There is nobody left
      // to read it either: delete_team only runs when the caller is the sole
      // remaining member. The record that survives is the per-departure
      // `member-removed` trail from emptying the team beforehand.
      await teamsync.deleteTeam(getConfig(), teamId);
      json(res, 200, { disbanded: true });
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

module.exports = { startServer, boundPort, oauthCallbackPage, statusPayload, noteTick, tickHealth, _resetTickForTests, projectBlockPayload, projectsPayload, projectDetail, planPayload, toggleProject, addProject, adoptProjects, deleteProject, removeBlockFromProject, archiveProject, unarchiveProject, copyPayload, settingsPayload, saveSettings, teamPayload, teamProjectsPayload, teamMembersPayload, _annotateKeyStatus: annotateKeyStatus, runTeamSync, scanPayload, savingsPayload, measuredSpendPayload, feedPayload, liveSessionsPayload, sessionPayload, catchupPayload, markCaughtUp, undoCaughtUp, dailySessionBuckets, lastManagerBlock };
