'use strict';
// Find the `claude` binary, for `claude mcp add` (mcp spec §5.1.1).
//
// WHY THIS IS NOT JUST spawnSync('claude', ...). A macOS app launched from
// Finder inherits roughly /usr/bin:/bin:/usr/sbin:/sbin. `claude` installs
// per-user -- ~/.local/bin, nvm, volta, asdf, homebrew, custom prefixes. The
// packaged app would frequently fail to find it while the identical code run
// from a terminal finds it instantly. That asymmetry is dangerous precisely
// because it looks like success to whoever tests from a terminal, while every
// app user silently gets nothing -- indistinguishable from the bug this whole
// feature exists to fix.
//
// So: ask authorities in order, and treat "not found" as a REPORTED outcome
// (never a silent skip, never a bare 'claude' handed to spawnSync in hope).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// LAST RESORT ONLY, and knowingly incomplete -- it cannot cover nvm, volta,
// asdf or a custom prefix, which is exactly why the login-shell query above it
// exists. Exported so `membridge status` can show what was tried.
const CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

// 5s, per spec §5.1.3. The timeout is the contract, not a suggestion: an rc
// file that waits on a terminal would otherwise block the daemon launch.
const SHELL_TIMEOUT_MS = 5000;

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Pick the binary out of a login shell's stdout.
//
// `command -v claude` is one line, but it is NOT the only line: the rc files
// run first and may print (nvm's "Now using node v20", update notices, a
// motd), and for a LOGIN shell .zlogout / .bash_logout run afterwards and may
// print too. So noise can land on either side of the answer, and taking the
// last line alone silently loses the path -- which degrades to "not found" on
// exactly the machines (version managers, chatty rc) this query exists to
// serve. Scan every line instead, keep the absolute ones, and prefer the last
// that is a real file on disk.
function pickPath(stdout, exists) {
  const abs = String(stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && path.isAbsolute(l));
  if (!abs.length) return null;
  for (let i = abs.length - 1; i >= 0; i--) if (exists(abs[i])) return abs[i];
  return abs[abs.length - 1];
}

// Ask the user's LOGIN + INTERACTIVE shell where claude is. -l reads the
// profile, -i reads the rc file, so this returns the real PATH including every
// version manager's shims -- most of which are installed by .zshrc, not
// .zprofile, so dropping -i would defeat the point of asking at all. This is
// asking the authority rather than guessing.
//
// Bounded and quiet: timeout above, stdin closed (`input: ''`) so an rc file
// that reads stdin fails instead of blocking, and stdout captured rather than
// inherited so shell chatter never reaches our logs. windowsHide matches
// lib/keychain.js so no console window can flash on Windows.
// Which shell to ask. $SHELL when set -- but a GUI-launched app is exactly the
// case this module exists for, and launchd does not reliably put SHELL in a
// .app's environment. Falling straight to /bin/sh there would be the same bug
// one level down: `sh -lic` reads /etc/profile and ~/.profile, never ~/.zshrc,
// which is where nvm/asdf/volta actually put their shims. So consult the user
// RECORD (os.userInfo) before giving up on knowing the user's shell.
function loginShell(env) {
  if (env && env.SHELL) return env.SHELL;
  try {
    const s = os.userInfo().shell;
    if (s) return s;
  } catch { /* no user record (some containers) -- fall through */ }
  return '/bin/sh';
}

function defaultRunShell(env, exists = isFile) {
  const shell = loginShell(env);
  let r;
  try {
    r = spawnSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, windowsHide: true, input: '',
    });
  } catch {
    return null;
  }
  // A timeout is NOT a throw: spawnSync returns with .error set (ETIMEDOUT)
  // and a null status. Both that and a non-zero exit mean "no answer".
  if (!r || r.error || r.status !== 0) return null;
  return pickPath(r.stdout, exists);
}

function resolveClaudeBin(opts = {}) {
  const config = opts.config || {};
  const env = opts.env || process.env;
  const exists = opts.exists || isFile;
  const candidates = opts.candidates || CANDIDATES;
  const runShell = opts.runShell || defaultRunShell;

  // 1. Explicit override. Always wins, no existence check second-guessing the
  //    user -- if they named it, we use it.
  const override = config.mcp && config.mcp.claudeBin;
  if (override) return { path: override, source: 'config' };

  // 2. What install.sh recorded, IF it still exists. A stale record (upgraded
  //    node, removed tool) must fall through rather than be handed onward.
  if (opts.recorded && exists(opts.recorded)) return { path: opts.recorded, source: 'recorded' };

  // 3. Ask the login shell. Wrapped because a caller-injected runShell may
  //    throw; defaultRunShell itself never does.
  let fromShell = null;
  try { fromShell = runShell(env, exists); } catch { fromShell = null; }
  if (fromShell && exists(fromShell)) return { path: fromShell, source: 'shell' };

  // 4. Probe list, last resort.
  for (const c of candidates) if (exists(c)) return { path: c, source: 'probe' };

  // Nothing. Deliberately NOT a bare 'claude' for spawnSync to maybe resolve:
  // that would convert a knowable, reportable miss into a silent one.
  return null;
}

module.exports = { resolveClaudeBin, defaultRunShell, loginShell, CANDIDATES, SHELL_TIMEOUT_MS };
