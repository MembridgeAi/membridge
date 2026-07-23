'use strict';
// "Is there a newer release?" — one best-effort GET to the public GitHub
// releases API, cached on disk. Everything here is FAIL-SILENT: offline, a
// rate-limit, a timeout, or a malformed response all resolve to "no update
// info" rather than throwing, so an update check can never block startup or a
// command. No auth, no telemetry — just the latest published tag.
//
// This is deliberately NOT an auto-updater: MemBridge ships unsigned (the
// `curl | sh` installer sidesteps Gatekeeper), and Electron's Squirrel updater
// would require an Apple Developer ID signature + notarization. So we only
// NOTIFY, and point the user at the one-line update command.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const pkg = require('../package.json');

const REPO = 'MembridgeAi/membridge';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const INSTALL_URL = 'https://membridge.me/install.sh';

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
async function fetchLatest({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(LATEST_URL, {
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
function updateCommand(kind = installKind()) {
  return kind === 'app' ? `curl -fsSL ${INSTALL_URL} | sh` : 'npm install -g @membridgeai/membridge';
}

module.exports = {
  REPO,
  LATEST_URL,
  RELEASES_PAGE,
  INSTALL_URL,
  CACHE_TTL_MS,
  cachePath,
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
