'use strict';
// Alpha readiness Task 5B: env-value deny-list.
//
// A short, per-project list of literal strings that are known to be secrets
// on this developer's machine. `compileForProject` reads it from the
// project's own .env family; `redactorFor` returns a closure that scrubs any
// occurrence of a literal in captured text.
//
// Why this exists: the redact.js patterns catch shape (Stripe keys, JWTs,
// Bearer tokens, connection URIs, high-entropy blobs). A low-entropy prose
// password with no recognizable prefix — `hunter2corgi` — has neither shape,
// and no threshold that catches it will also spare normal English. But the
// realistic leak is a developer PASTING a credential they already have on
// disk, not inventing one in chat. So we cross-reference: any value that
// appears in the project's own .env is redacted wherever it later appears.
//
// Determinism: this file does string equality only, no heuristics. What it
// catches is decidable; what it does not catch it does not pretend to.
//
// The values NEVER persist. They live in the process's compiled matcher and
// nowhere else — not on disk, not in state.json, not in a log line, not in
// an error message. That is a hard invariant (test: env-deny-list.test.js
// walks MEMBRIDGE_HOME for the known literal after a full pipeline pass).
//
// Cache: keyed by absolute project path + mtime of the newest .env file, so
// the matcher recompiles when any file in the family changes. In-memory only.

const fs = require('fs');
const path = require('path');

// Which .env files count. `.env.*.local` is a real convention (per-env
// overrides for a specific developer), and it holds real secrets by design.
// `.env.example` / `.env.sample` / `.env.template` are the exact opposite —
// they hold placeholders, and if we redacted "changeme" everywhere it
// appeared we would corrupt prose.
const INCLUDE_RX = /^\.env(?:\.[A-Za-z0-9_-]+)?(?:\.local)?$/;
const EXCLUDE_NAMES = new Set([
  '.env.example', '.env.sample', '.env.template',
]);
function shouldReadEnvFile(name) {
  if (!INCLUDE_RX.test(name)) return false;
  if (EXCLUDE_NAMES.has(name)) return false;
  // Belt-and-suspenders: any *.example, *.sample, *.template variant (e.g.
  // `.env.staging.example`) is skipped. The include rx already rejects
  // these by suffix shape, but a name that ends `.example.local` would
  // slip through, so exclude by substring too.
  if (/\.(example|sample|template)(\.|$)/i.test(name)) return false;
  return true;
}

// Minimum value length. Below this, false positives from ordinary short
// tokens explode — a value of `abc` would redact every appearance of the
// substring `abc` (including "abcess" if we weren't careful about
// substring vs word). 8 characters is enough to make a random value
// distinct from ordinary prose without being so long that short but real
// secrets survive.
const MIN_VALUE_LEN = 8;

// Values that look like secrets by length but obviously are not, and
// redacting them would destroy readability wholesale.
const STOP_LIST = new Set([
  'true', 'false', 'null', 'undefined',
  'localhost', '127.0.0.1', '0.0.0.0',
  'development', 'production', 'staging', 'test', 'testing',
  'debug', 'info', 'warn', 'error',
  'yes', 'no',
]);
function isStopListed(value) {
  if (STOP_LIST.has(value)) return true;
  // Bare integer (`3000`, `8443`, `2026`): a port or a number, never a
  // secret. `/^\d+$/` is deliberately strict — `123abc` still qualifies.
  if (/^-?\d+$/.test(value)) return true;
  // Pure scheme+authority URL with nothing sensitive: `https://api.example.com`,
  // `https://`. A URL WITH credentials embedded (`https://u:p@host`) is
  // caught by the connection-uri default pattern; a URL with a query
  // string might carry a token, so leave those to that pattern too, but
  // simple base URLs are not secrets.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^?#\s]*$/i.test(value) && !/[:@]/.test(value.split('//')[1] || '')) return true;
  return false;
}

// Parse ONE line of a .env file. Returns null when the line has no value or
// the value fails the sniff. dotenv accepts `KEY=value`, `KEY="quoted"`,
// `KEY='single'`, and comments starting with `#`. Export statements are
// tolerated because devs paste them.
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const stripped = trimmed.replace(/^export\s+/, '');
  const eq = stripped.indexOf('=');
  if (eq < 1) return null;
  // Key must be a plausible env identifier; we do not use it, but a line
  // like `sudo apt-get install foo=bar` should not parse as an env value.
  const key = stripped.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = stripped.slice(eq + 1);
  // Trim inline comments AFTER an unquoted value — dotenv's convention.
  // Quoted values keep everything inside the quotes verbatim.
  const first = value.charAt(0);
  if (first === '"' || first === "'") {
    const end = value.indexOf(first, 1);
    if (end < 0) return null;
    value = value.slice(1, end);
  } else {
    const hash = value.indexOf(' #');
    if (hash >= 0) value = value.slice(0, hash);
    value = value.trim();
  }
  return value;
}

function readValues(root) {
  const out = new Set();
  let names;
  try { names = fs.readdirSync(root); } catch { return out; }
  const files = names.filter(shouldReadEnvFile).map(n => path.join(root, n));
  for (const file of files) {
    // Explicit no-symlink: the rule "never follow symlinks out of the root"
    // is enforced here (readFileSync would happily read through a symlink
    // pointing at ~/.ssh/config).
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const value = parseLine(raw);
      if (!value) continue;
      if (value.length < MIN_VALUE_LEN) continue;
      if (isStopListed(value)) continue;
      out.add(value);
    }
  }
  return out;
}

// Newest mtime across all include-matching files in `root`. -1 when the dir
// has none — the cache key still resolves stably ("no env files" bucket).
function newestEnvMtimeMs(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return -1; }
  let newest = -1;
  for (const n of names) {
    if (!shouldReadEnvFile(n)) continue;
    let st;
    try { st = fs.lstatSync(path.join(root, n)); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

// Cache. In-memory only, per absolute project path. Key is `path\0mtime` so
// a matching mtime on a re-read is a cache hit; any change bumps the key
// and forces a fresh read.
const cache = new Map();

// Public: array of the literal secret values for a project. Empty when the
// project has no matching .env files (unlinked scratch, freshly cloned repo
// without .env, etc.). Deduplicated across files. Order does not matter.
function compileForProject(projectPath) {
  const abs = path.resolve(projectPath || '');
  if (!abs) return [];
  const mtime = newestEnvMtimeMs(abs);
  const key = `${abs}\0${mtime}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // Cap the cache. A dev's laptop rarely holds >32 projects; more usually
  // means test churn or an accidental leak, and the LRU-ish trim keeps
  // memory bounded either way.
  if (cache.size > 32) {
    for (const k of cache.keys()) { cache.delete(k); break; }
  }
  const literals = [...readValues(abs)];
  cache.set(key, literals);
  return literals;
}

// Escape ALL regex metacharacters so `p@ss.w+rd` matches only that byte
// sequence — treating it as a regex would silently match unrelated text.
function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Public: return a { replace(text) } object the redactor can call. Case
// sensitive by design (secrets are). Multi-value replace is one regex
// alternation, which is faster than N passes and prevents an earlier
// replacement from re-triggering a later one.
function redactorFor(projectPath) {
  const literals = compileForProject(projectPath);
  if (!literals.length) return null;
  // Sort longest first so an alternation prefers the longer literal when
  // one is a prefix of another (`hunter2corgi` before `hunter2c`).
  const parts = literals.slice().sort((a, b) => b.length - a.length).map(escapeForRegex);
  const rx = new RegExp(parts.join('|'), 'g');
  return {
    // Debug ONLY — never persisted. The count is safe to expose; the values
    // are not, and this object does not offer them.
    size: literals.length,
    replace(text) {
      if (!text) return text;
      return String(text).replace(rx, '[redacted:env]');
    },
  };
}

// Test-only: clear the cache. Used by suites that mutate fixture .env files
// then need a clean read; production code has no need to call this.
function _clearCacheForTests() { cache.clear(); }

module.exports = { compileForProject, redactorFor, _clearCacheForTests };
