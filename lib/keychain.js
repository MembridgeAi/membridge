'use strict';
// Private-key storage in the macOS Keychain, via the built-in `security` CLI
// (E2E spec build-sequence step 1). Zero extra dependencies on purpose — no
// native modules to build or ship.
//
// Why the keychain at all: the private key is the one secret that lets this
// machine open the sealed team key. It must never be uploaded, and it must not
// sit in a plaintext file that a stray backup, a synced folder, or a stolen
// laptop would hand over. The OS vault is the right home for it.
//
// Off macOS (CI/Linux), `security` doesn't exist: available() is false and every
// op no-ops (false/null) so callers fail CLOSED — sync keeps working in
// plaintext rather than crashing. Cross-platform key storage is a later problem.
//
// Secrets never ride argv: argv is world-readable via `ps`, so store() feeds
// the whole add command to `security -i` on STDIN (the -i interactive mode
// executes commands from stdin and propagates their exit status). Reads pass
// no secret on argv, so they stay plain calls.
const { spawnSync } = require('child_process');

// One service name for every MemBridge item, so accounts namespace within it.
const SERVICE = 'membridge';

// Runner seam: tests swap the spawn to assert command construction (no secret
// in argv) without touching a real keychain. Returns the previous runner.
let runner = (args, input) => spawnSync('security', args, { encoding: 'utf8', input });
function _setRunner(fn) { const prev = runner; runner = fn; return prev; }

function run(args, input) {
  return runner(args, input);
}

// Double-quote a value for security's interactive command parser. Values here
// are accounts (dotted names) and base64 keys (+ / =) — no newlines by
// construction, but escape quote/backslash so nothing can break out.
const quote = s => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

// darwin + a working `security` binary. Probed, not assumed.
function available() {
  if (process.platform !== 'darwin') return false;
  const r = run(['help']);
  return !r.error;
}

// Store or replace a secret. -U updates an existing item instead of failing on
// a duplicate, so re-running is idempotent. The command travels on stdin (see
// header) so the secret never appears in argv. Never log the secret.
function store(account, secret) {
  if (!available()) return false;
  const cmd = `add-generic-password -U -a ${quote(account)} -s ${quote(SERVICE)} -w ${quote(String(secret))}\n`;
  const r = run(['-i'], cmd);
  return r.status === 0;
}

// The stored secret, or null when absent (or unreadable — a locked keychain and
// a missing item are both "we don't have it", and callers treat them the same).
function load(account) {
  if (!available()) return null;
  const r = run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out || null;
}

function remove(account) {
  if (!available()) return false;
  const r = run(['delete-generic-password', '-a', account, '-s', SERVICE]);
  return r.status === 0;
}

module.exports = { available, store, load, remove, SERVICE, _setRunner };
