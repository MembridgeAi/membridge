'use strict';
// "Is there a newer release?" — one best-effort GET to the public GitHub
// releases API, cached on disk. Everything here is FAIL-SILENT: offline, a
// rate-limit, a timeout, or a malformed response all resolve to "no update
// info" rather than throwing, so an update check can never block startup or a
// command. No auth, no telemetry — just the latest published tag.
//
// This is deliberately NOT an auto-updater. Release builds are signed and
// notarized in CI now, so a signature no longer blocks Squirrel; what remains
// is that the `curl | sh` installer is the update path we actually ship and
// test, and a real in-app auto-updater on top of it is still future work. So
// we only NOTIFY, and point the user at the one-line update command.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const pkg = require('../package.json');

const REPO = 'MembridgeAi/membridge';
const DEFAULT_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const INSTALL_URL = 'https://membridge.app/install.sh';

// MEMBRIDGE_UPDATE_LATEST_URL: an override for the version endpoint.
// This is the fourth baked default in the codebase, and it existed for a while
// with no env lever at all — so every test process that ended up calling
// check() (nothing does today, but nothing guaranteed nothing would) hit
// api.github.com from the real user's IP, on an unauthenticated 60-req/hr
// budget. Landing this lever means test/no-egress.js can pin it, and any
// operator running against a mirror can point it there without a source patch.
//
// Semantics deliberately match the empty-string-is-off pattern
// lib/counters.js already uses, and lib/teamsync.js does NOT — the trap in the
// team lane was that `env || config || BAKED` reads an EMPTY env var as unset
// and falls through to production, so 39 `finally` blocks doing
// `delete process.env.MEMBRIDGE_TEAM_URL` restored the production default
// (fix: test/no-egress.js resetTeamEnv). Rather than repeat that trap here:
//
//   • unset          → use DEFAULT_LATEST_URL (ships GitHub, existing behaviour)
//   • empty string   → the check is DISABLED. check() returns without a fetch.
//                      A test setting this to "" cannot accidentally hit the
//                      network, and an operator can turn the check off without
//                      patching source.
//   • non-empty      → that URL is used verbatim. Same shape as
//                      MEMBRIDGE_TEAM_URL after no-egress.setSink.
//
// Explicit precedence over trimmed truthiness: `typeof env === 'string'` alone
// decides, so whitespace is treated as an explicit opt-out too (matches
// lib/counters.js:countersUrl and lib/diagnostics.js:diagnosticsUrl).
function latestUrl() {
  const env = process.env.MEMBRIDGE_UPDATE_LATEST_URL;
  if (typeof env === 'string') {
    const trimmed = env.trim();
    return trimmed === '' ? null : trimmed;
  }
  return DEFAULT_LATEST_URL;
}

// Re-hit the API at most this often; the answer is cached between runs so a
// relaunch loop can't burn through the unauthenticated 60-req/hr/IP budget.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 4000;

const cachePath = () => path.join(util.homeDir(), 'update-check.json');

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeCache(obj) {
  try {
    fs.mkdirSync(util.homeDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(obj, null, 2));
  } catch {
    // a cache we can't persist just means we re-check next time — never fatal
  }
}

// "v1.2.10" / "1.2" -> [1,2,10] (missing parts are 0). Unparseable -> null.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

// >0 if a newer than b, <0 if older, 0 if equal or either is unparseable.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// Hit the API directly (no cache). Resolves to a bare version string ("1.2.0")
// or null on any failure. fetchImpl is injectable so tests never touch the net.
// An empty MEMBRIDGE_UPDATE_LATEST_URL resolves the URL to null and this
// returns null before the fetch — the opt-out honoured at the leaf, not just
// in check().
async function fetchLatest({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = latestUrl();
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          // GitHub rejects API requests with no User-Agent.
          'User-Agent': `membridge/${pkg.version}`,
          Accept: 'application/vnd.github+json',
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return null;
    const body = await res.json();
    const tag = body && (body.tag_name || body.name);
    return parseVersion(tag) ? String(tag).trim().replace(/^v/i, '') : null;
  } catch {
    return null;
  }
}

// Cached update check. Returns { current, latest, updateAvailable }; `latest`
// is null when the API has never been reached. Pass force:true to ignore the
// TTL, or `current` to compare against a specific running version (the app
// passes app.getVersion(); the CLI defaults to its own package version).
async function check({ current = pkg.version, force = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const cache = readCache();
  let latest = cache.latest || null;
  const stale = force || !cache.checkedAt || now - cache.checkedAt > CACHE_TTL_MS;
  if (stale) {
    // Early return honours the opt-out WITHOUT stamping checkedAt, so turning
    // the switch back off later means the next real check runs immediately
    // rather than waiting out the TTL. Cached `latest` is left alone -- an
    // opt-out is not a claim to forget what we already know.
    if (!latestUrl()) {
      return { current, latest, updateAvailable: latest ? isNewer(latest, current) : false };
    }
    const fetched = await fetchLatest({ fetchImpl });
    if (fetched) latest = fetched;
    // Stamp the attempt either way so a flaky network doesn't re-hit every run;
    // keep the last known `latest` when the fetch failed.
    writeCache({ ...cache, latest, checkedAt: now });
  }
  return { current, latest, updateAvailable: latest ? isNewer(latest, current) : false };
}

// Once-per-version notification guard (for the desktop popup): has the user
// already been shown this exact latest version?
function alreadyNotified(latest) {
  return !!latest && readCache().notified === latest;
}
function markNotified(latest) {
  if (latest) writeCache({ ...readCache(), notified: latest });
}

// How was this copy installed? The macOS app ships a CLI wrapper that runs the
// bundled Electron as Node, so process.execPath sits inside MemBridge.app.
// Everything else (a global npm install) runs under a plain node binary.
function installKind() {
  return /MemBridge\.app\//.test(process.execPath) ? 'app' : 'npm';
}

// The exact command to update, per install kind.
// Derived from package.json, never re-typed: the printed command and the one
// `membridge update` actually executes must always name the same package.
const PKG_NAME = require('../package.json').name;
function updateCommand(kind = installKind()) {
  return kind === 'app' ? `curl -fsSL ${INSTALL_URL} | sh` : `npm install -g ${PKG_NAME}`;
}

module.exports = {
  REPO,
  // Historical name kept for callers that read the constant (e.g. test/run-tests.js
  // asserts it targets api.github.com). It is the default the resolver returns
  // when the env override is absent, never the actual URL fetched — that comes
  // from latestUrl() below.
  LATEST_URL: DEFAULT_LATEST_URL,
  DEFAULT_LATEST_URL,
  latestUrl,
  RELEASES_PAGE,
  INSTALL_URL,
  CACHE_TTL_MS,
  cachePath,
  // Exposed so a caller that must never touch the network on its own (e.g.
  // GET /api/settings, which can be polled) can read whatever the last
  // background check found without triggering a new one. Pure disk read,
  // same fail-quiet-to-{} shape check() itself relies on.
  readCache,
  parseVersion,
  compareVersions,
  isNewer,
  fetchLatest,
  check,
  alreadyNotified,
  markNotified,
  installKind,
  updateCommand,
};
