'use strict';
// Private-key storage for the E2E team-crypto identity. Zero extra
// dependencies on purpose — no native modules to build or ship. The private
// key is the one secret that lets this machine open the sealed team key: it
// must never be uploaded, and it must not sit in a plaintext file that a stray
// backup, a synced folder, or a stolen laptop would hand over.
//
// Per-platform backend, each using only a built-in OS facility:
//   macOS   → the login Keychain, via the `security` CLI.
//   Windows → DPAPI (Data Protection API), via Windows PowerShell. The key is
//             sealed to the current Windows user account, so the ciphertext on
//             disk is useless without that user's login — the same threat model
//             the Keychain gives on macOS.
//   else    → unavailable (CI/Linux): available() is false and every op no-ops
//             (false/null) so callers fail CLOSED — sync stays paused (never
//             plaintext) rather than crashing. Cross-platform native vaults are
//             a later problem.
//
// Secrets never ride argv (argv is world-readable via `ps` / Get-CimInstance):
// stores feed the secret to the child on STDIN. Reads pass no secret on argv.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One service name for every MemBridge item, so accounts namespace within it.
const SERVICE = 'membridge';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// -------------------------------------------------------------------------
// macOS backend — the `security` CLI.
// -------------------------------------------------------------------------

// Runner seam: tests swap the spawn to assert command construction (no secret
// in argv) without touching a real keychain. Returns the previous runner.
let runner = (args, input) => spawnSync('security', args, { encoding: 'utf8', input });
function _setRunner(fn) { const prev = runner; runner = fn; return prev; }
function run(args, input) { return runner(args, input); }

// Double-quote a value for security's interactive command parser. Values here
// are accounts (dotted names) and base64 keys (+ / =) — no newlines by
// construction, but escape quote/backslash so nothing can break out.
const quote = s => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

function macAvailable() {
  if (!IS_MAC) return false;
  const r = run(['help']);
  return !r.error;
}

// Store or replace a secret. -U updates an existing item instead of failing on
// a duplicate, so re-running is idempotent. The command travels on stdin (see
// header) so the secret never appears in argv. Never log the secret.
function macStore(account, secret) {
  const cmd = `add-generic-password -U -a ${quote(account)} -s ${quote(SERVICE)} -w ${quote(String(secret))}\n`;
  const r = run(['-i'], cmd);
  return r.status === 0;
}

function macLoad(account) {
  const r = run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out || null;
}

// Tri-state read: `security find-generic-password` exits non-zero both for
// "no such item" and for a keychain that could not be read at all (locked,
// no default keychain, a spawn failure), and those are NOT the same fact — a
// caller deciding whether to replace a missing key must not treat an
// unreadable one as missing. Exit status 44 is errSecItemNotFound (-25300;
// `security`'s exit code is the OSStatus truncated to a byte, and
// -25300 & 0xFF === 44 — the same constant node-keytar and Python's
// `keyring` macOS backend key off). Any other non-zero status, or a spawn
// error (r.status === null), means the read told us nothing and must be
// reported as indeterminate rather than guessed at.
function macLoadChecked(account) {
  const r = run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (r.status === 0) {
    const out = (r.stdout || '').trim();
    return { value: out || null, indeterminate: false };
  }
  if (r.status === 44) return { value: null, indeterminate: false };
  return { value: null, indeterminate: true };
}

function macRemove(account) {
  const r = run(['delete-generic-password', '-a', account, '-s', SERVICE]);
  return r.status === 0;
}

// -------------------------------------------------------------------------
// Windows backend — DPAPI via Windows PowerShell.
// -------------------------------------------------------------------------
// `powershell` (Windows PowerShell 5.1, always present) NOT `pwsh`: DPAPI's
// ProtectedData is built into .NET Framework's System.Security, but is a
// separate opt-in package on PowerShell 7 / .NET Core.

// The DPAPI ciphertext lives beside the daemon's other home-dir state (kept in
// sync with util.homeDir(), duplicated here so keychain stays dependency-free).
function keysDir() {
  const home = process.env.MEMBRIDGE_HOME || path.join(os.homedir(), '.membridge');
  return path.join(home, 'keys');
}
function keyFile(account) {
  return path.join(keysDir(), String(account).replace(/[^A-Za-z0-9._-]/g, '_') + '.dpapi');
}

// The three scripts are constant (no interpolation): the target path arrives
// via the MEMBRIDGE_KEYFILE env var and the secret via stdin, so nothing
// user-controlled is ever spliced into the script text. Passed as
// -EncodedCommand (base64 of UTF-16LE) to sidestep all shell quoting.
const PS_PROBE = [
  "Add-Type -AssemblyName System.Security",
  "$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$b=[System.Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3),$null,$s)",
  "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,$s)|Out-Null",
  "[Console]::Out.Write('ok')",
].join('\n');
const PS_PROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$in=[Console]::In.ReadToEnd()",
  "$bytes=[System.Text.Encoding]::UTF8.GetBytes($in)",
  "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,$s)",
  "[System.IO.File]::WriteAllText($env:MEMBRIDGE_KEYFILE,[Convert]::ToBase64String($enc))",
].join('\n');
const PS_UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$b64=[System.IO.File]::ReadAllText($env:MEMBRIDGE_KEYFILE)",
  "$enc=[Convert]::FromBase64String($b64)",
  "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,$s)",
  "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))",
].join('\n');

const encodeCommand = script => Buffer.from(script, 'utf16le').toString('base64');

function ps(script, { input, keyfile } = {}) {
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
    encoding: 'utf8',
    input,
    env: { ...process.env, MEMBRIDGE_KEYFILE: keyfile || '' },
    windowsHide: true,
  });
}

// Probed once, not assumed: confirms DPAPI actually round-trips for this user
// before we rely on it. Cached — the probe spawns PowerShell, which is heavy.
let winProbe;
function winAvailable() {
  if (!IS_WIN) return false;
  if (winProbe !== undefined) return winProbe;
  const r = ps(PS_PROBE);
  winProbe = !r.error && r.status === 0 && /ok/.test(r.stdout || '');
  return winProbe;
}

function winStore(account, secret) {
  try { fs.mkdirSync(keysDir(), { recursive: true }); } catch { return false; }
  const r = ps(PS_PROTECT, { input: String(secret), keyfile: keyFile(account) });
  return !r.error && r.status === 0;
}

function winLoad(account) {
  const f = keyFile(account);
  if (!fs.existsSync(f)) return null;
  const r = ps(PS_UNPROTECT, { keyfile: f });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || '').trim(); // base64 secret has no surrounding whitespace
  return out || null;
}

// Tri-state read, Windows side. The two stages differ in kind: the file
// check is a real filesystem fact (present or not, never ambiguous), but a
// DPAPI unprotect failure on a file that DOES exist — a transient PowerShell
// error, a user-profile change — is not the same fact as "no file" and must
// not be reported the same way.
function winLoadChecked(account) {
  const f = keyFile(account);
  if (!fs.existsSync(f)) return { value: null, indeterminate: false };
  const r = ps(PS_UNPROTECT, { keyfile: f });
  if (r.error || r.status !== 0) return { value: null, indeterminate: true };
  const out = (r.stdout || '').trim();
  return { value: out || null, indeterminate: false };
}

function winRemove(account) {
  const f = keyFile(account);
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Platform dispatch. Every op fails closed (false/null) where no backend
// exists, so a missing vault pauses encryption rather than crashing sync.
// -------------------------------------------------------------------------
function available() { return IS_WIN ? winAvailable() : macAvailable(); }
function store(account, secret) {
  if (!available()) return false;
  return IS_WIN ? winStore(account, secret) : macStore(account, secret);
}
function load(account) {
  if (!available()) return null;
  return IS_WIN ? winLoad(account) : macLoad(account);
}
// Tri-state counterpart to `load`, for callers where an unreadable keychain
// must not be mistaken for an empty one — see ensureIdentity in teamsync.js.
// `available()` already fails a caller closed before this would run in
// practice, but reports the honest thing here too: "unavailable" is not
// proof of absence either.
function loadChecked(account) {
  if (!available()) return { value: null, indeterminate: true };
  return IS_WIN ? winLoadChecked(account) : macLoadChecked(account);
}
function remove(account) {
  if (!available()) return false;
  return IS_WIN ? winRemove(account) : macRemove(account);
}

module.exports = { available, store, load, loadChecked, remove, SERVICE, _setRunner };
