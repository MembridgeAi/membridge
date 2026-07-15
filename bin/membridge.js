#!/usr/bin/env node
'use strict';
// Fast path: the Claude Code Stop hook fires on every session stop and must
// not pay for the full CLI require tree below (server, dashboard, team sync).
if (process.argv[2] === 'hook' && process.argv[3] === 'stop') {
  require('../lib/hooks').runStop();
  return;
}
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const util = require('../lib/util');
const { scanAll, syncOnce, getAdapters, findProjectKey } = require('../lib/scan');
const digest = require('../lib/digest');
const memorydb = require('../lib/memorydb');
const { startServer } = require('../lib/server');
const autostart = require('../lib/autostart');
const teamsync = require('../lib/teamsync');
const hooks = require('../lib/hooks');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = name => args.includes(name);
const opt = name => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function readPid() {
  try {
    return parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10) || null;
  } catch {
    return null;
  }
}
function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printChanges(result) {
  for (const c of result.changes) console.log(`  ${c.action}: ${c.file}`);
  for (const s of result.skipped || []) console.log(`  skipped ${s.project} (${s.reason})`);
  if (!result.changes.length) console.log('  nothing to update');
}

function cmdSync() {
  util.ensureConfig();
  const dryRun = flag('--dry-run');
  const result = syncOnce({ dryRun, project: opt('--project') });
  console.log(`${dryRun ? '[dry run] ' : ''}${result.newEvents} new event(s), ${result.projects.length} project(s) affected`);
  printChanges(result);
  if (!dryRun && teamsync.isConfigured(util.getConfig())) {
    return teamSyncPass({ project: opt('--project') }).catch(err => console.error(`team sync failed: ${err.message}`));
  }
}

// One team push/pull pass; pulled teammate entries re-render those projects'
// context blocks right away.
async function teamSyncPass(opts = {}) {
  const r = await teamsync.syncTeams(opts);
  for (const key of r.changed) syncOnce({ project: key });
  for (const e of r.errors) util.log(`team sync: ${e}`);
  if (r.synced.length || r.errors.length) {
    console.log(`team sync: ${r.synced.length} project(s), ${r.changed.length} with new teammate activity${r.errors.length ? `, ${r.errors.length} error(s) (see log)` : ''}`);
  }
  return r;
}

function cmdScan() {
  util.ensureConfig();
  const config = util.getConfig();
  console.log('Read-only scan (nothing is written).\n');
  console.log('Adapters:');
  for (const a of getAdapters(config)) {
    for (const root of a.sessionRoots(config)) {
      const exists = fs.existsSync(root);
      console.log(`  ${a.displayName.padEnd(14)} ${root} ${exists ? '' : '(not found)'}`);
    }
  }
  const state = { files: {}, projects: {} }; // fresh: scan everything from byte 0
  const events = scanAll(state, config);
  digest.mergeEvents(state, events, config);
  const projects = Object.entries(state.projects);
  console.log(`\nProjects with AI activity: ${projects.length}`);
  for (const [key, proj] of projects) {
    const bySource = {};
    for (const e of proj.events) bySource[e.source] = (bySource[e.source] || 0) + 1;
    const parts = Object.entries(bySource).map(([s, n]) => `${s}: ${n}`).join(', ');
    const off = util.isProjectOff(key, config) ? '  [paused]' : '';
    console.log(`  ${key}${off}\n    ${parts}`);
  }
}

function cmdDaemon() {
  util.ensureConfig();
  const config = util.getConfig();
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(util.pidPath(), String(process.pid));
  util.log(`daemon started (pid ${process.pid}, interval ${config.intervalSec}s, v${pkg.version})`);

  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(util.pidPath());
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const tick = () => {
    try {
      // An npm upgrade can migrate the state while this daemon keeps running:
      // never write a state version this code did not produce — exit instead
      // so a restart picks up the new code.
      let onDisk = null;
      try {
        onDisk = JSON.parse(fs.readFileSync(util.statePath(), 'utf8'));
      } catch {}
      if (onDisk && typeof onDisk.version === 'number' && onDisk.version > util.STATE_VERSION) {
        util.log(`state v${onDisk.version} is newer than this daemon writes (v${util.STATE_VERSION}); exiting for restart`);
        cleanup();
        return;
      }
      const r = syncOnce();
      if (r.changes.length) {
        util.log(`sync: ${r.newEvents} new event(s) -> ${r.changes.map(c => c.file).join('; ')}`);
      }
      teamTick();
    } catch (err) {
      util.log(`sync error: ${err.stack || err}`);
    }
  };
  // Team sync rides the same tick, guarded so a slow network round cannot
  // overlap the next one. Best-effort: errors are logged, local sync is never
  // blocked by the backend being unreachable.
  let teamBusy = false;
  const teamTick = () => {
    if (teamBusy || !teamsync.isConfigured(util.getConfig())) return;
    teamBusy = true;
    teamsync.syncTeams()
      .then(r => {
        for (const key of r.changed) syncOnce({ project: key });
        for (const e of r.errors) util.log(`team sync: ${e}`);
        if (r.changed.length) util.log(`team sync: pulled teammate activity into ${r.changed.length} project(s)`);
      })
      .catch(err => util.log(`team sync error: ${err.message}`))
      .finally(() => { teamBusy = false; });
  };
  // Chained timeout instead of setInterval: the delay is re-read from config
  // each round, so an interval change in Settings applies from the next check
  // without restarting the daemon.
  const schedule = () => setTimeout(() => {
    tick();
    schedule();
  }, util.getConfig().intervalSec * 1000);
  tick();
  schedule();
  startServer(config.dashboardPort);
}

function cmdStart() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`MemBridge is already running (pid ${pid}).`);
    return;
  }
  util.ensureConfig();
  const out = fs.openSync(util.logPath(), 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  const config = util.getConfig();
  console.log(`MemBridge daemon started in the background (pid ${child.pid}).`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);
}

function cmdStop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log('MemBridge is not running.');
    return;
  }
  process.kill(pid);
  try {
    fs.unlinkSync(util.pidPath());
  } catch {}
  console.log(`Stopped MemBridge (pid ${pid}).`);
}

function cmdStatus() {
  const config = util.getConfig();
  const state = util.loadState();
  const pid = readPid();
  const running = isRunning(pid);
  console.log(`MemBridge v${pkg.version}`);
  console.log(`Daemon:    ${running ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}${running ? '' : ' (offline)'}`);
  console.log(`Home:      ${util.homeDir()}`);
  console.log(`Interval:  ${config.intervalSec}s   Targets: ${util.effectiveTargets(config).join(', ')}`);
  console.log(`Autostart: ${autostart.isEnabled() ? 'enabled' : 'disabled'}`);
  const distillOn = !config.distill || config.distill.enabled !== false;
  console.log(`Distill:   ${distillOn ? 'enabled' : 'disabled'} — Claude Code hook ${hooks.isHookInstalled() ? 'installed' : 'not installed (run \`membridge setup-hooks\`)'}`);
  const projects = Object.entries(state.projects || {});
  console.log(`Projects:  ${projects.length}`);
  for (const [key, proj] of projects) {
    const paused = util.isProjectOff(key, config) ? ' [paused]' : '';
    console.log(`  ${key}${paused} — ${proj.events.length} event(s), last sync ${proj.lastSync || 'never'}`);
  }
}

function cmdRemove() {
  const state = util.loadState();
  const config = util.getConfig();
  const only = opt('--project');
  let keys = Object.keys(state.projects || {});
  if (only) {
    const k = findProjectKey(state, only);
    keys = k ? [k] : [path.resolve(only)];
  }
  let n = 0;
  for (const key of keys) {
    for (const target of util.effectiveTargets(config)) {
      const file = path.join(key, target);
      const res = digest.removeBlock(file, { preamble: digest.preambleFor(target), projectRoot: key });
      if (res) {
        console.log(`  ${res === 'deleted' ? 'deleted (was only the memory block)' : 'block removed'}: ${file}`);
        n++;
      }
    }
    if (memorydb.removeProjectMemory(key)) {
      console.log(`  removed: ${path.join(key, memorydb.DIR_NAME)}`);
      n++;
    }
  }
  console.log(n ? `Done — ${n} file(s) cleaned.` : 'No MemBridge blocks found.');
}

function openBrowser(url) {
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

function cmdDashboard() {
  const config = util.getConfig();
  const url = `http://127.0.0.1:${config.dashboardPort}`;
  if (!isRunning(readPid())) {
    cmdStart();
    // give the detached daemon a moment to bind the port
    setTimeout(() => openBrowser(url), 1500);
  } else {
    openBrowser(url);
  }
  console.log(`Dashboard: ${url}`);
}

// ---------------------------------------------------------------------------
// Team sync commands (Supabase backend, see supabase/schema.sql + README)
// ---------------------------------------------------------------------------
function die(msg) {
  console.error(msg);
  process.exit(1);
}

function credArgs() {
  const email = opt('--email');
  const password = opt('--password') || process.env.MEMBRIDGE_PASSWORD || null;
  if (!email || !password) {
    die('Usage: membridge <signup|login> --email you@company.com --password <pass> [--name "Your Name"]\n(The password can also come from the MEMBRIDGE_PASSWORD env var.)');
  }
  return { email, password, name: opt('--name') };
}

async function cmdSignup() {
  util.ensureConfig();
  const { email, password, name } = credArgs();
  const r = await teamsync.signup(util.getConfig(), email, password, name);
  if (r.needsConfirmation) {
    console.log(`Check ${email} for a confirmation link, then run: membridge login --email ${email} --password ...`);
    return;
  }
  console.log(`Signed up and logged in as ${r.email} (display name: ${r.displayName}).`);
}

async function cmdLogin() {
  util.ensureConfig();
  const { email, password, name } = credArgs();
  const r = await teamsync.login(util.getConfig(), email, password, name);
  console.log(`Logged in as ${r.email} (display name: ${r.displayName}).`);
}

function cmdLogout() {
  console.log(teamsync.clearCredentials() ? 'Logged out.' : 'Already logged out.');
}

// One command from invite to member: `membridge join <link-or-token-or-code>`.
// Logged out + --email given -> logs in, or signs up if the account is new.
async function cmdJoin() {
  util.ensureConfig();
  const config = util.getConfig();
  const input = args[1];
  if (!input || input.startsWith('--')) {
    die('Usage: membridge join <invite link or code> [--email you@company.com --password <pass> [--name "Your Name"]]');
  }
  if (!teamsync.isConfigured(config)) {
    die('Team sync is not available in this build (see the Team sync section of the README).');
  }
  if (!teamsync.loadCredentials()) {
    const email = opt('--email');
    const password = opt('--password') || process.env.MEMBRIDGE_PASSWORD || null;
    if (!email || !password) {
      die('You are not logged in. Add --email and --password and MemBridge will log you in — or create the account if it is new.');
    }
    try {
      await teamsync.login(config, email, password, opt('--name'));
    } catch {
      const r = await teamsync.signup(config, email, password, opt('--name'));
      if (r.needsConfirmation) {
        die(`Account created — check ${email} for a confirmation link, then run this join command again.`);
      }
    }
  }
  const t = await teamsync.join(config, input);
  console.log(`Joined team "${t.team_name}".`);
  console.log('Next: link a project with `membridge team link` inside it — or just work; matching git remotes are detected and suggested automatically.');
}

async function cmdTeam() {
  util.ensureConfig();
  const sub = args[1] || 'list';
  const config = util.getConfig();

  // Advanced/self-host override: point MemBridge at your own backend instead
  // of the one shipped with the build. Normal users never need this.
  if (sub === 'setup') {
    const url = opt('--url');
    const anonKey = opt('--anon-key');
    if (!url || !anonKey) {
      die('Usage: membridge team setup --url https://<ref>.supabase.co --anon-key <anon key>\n(Advanced — self-hosting your own backend. On a normal build team sync already works; just run `membridge signup`.)');
    }
    const raw = util.loadUserConfig();
    raw.team = { ...(raw.team && typeof raw.team === 'object' ? raw.team : {}), url, anonKey };
    util.saveUserConfig(raw);
    console.log('Custom team backend saved (overrides the built-in one).');
    return;
  }

  // Privacy gate: verbatim prompts upload with team sync only when this is on
  // (summaries and file lists always sync). Local config only, so it works
  // before login and on unconfigured builds.
  if (sub === 'share-prompts') {
    const v = args[2];
    if (!['on', 'off'].includes(v)) die('Usage: membridge team share-prompts <on|off>');
    const raw = util.loadUserConfig();
    raw.team = { ...(raw.team && typeof raw.team === 'object' ? raw.team : {}), sharePrompts: v === 'on' };
    util.saveUserConfig(raw);
    console.log(v === 'on'
      ? 'Prompt sharing ON: future pushes include your (redacted) asks.'
      : 'Prompt sharing OFF: future pushes upload summaries and file lists only.');
    return;
  }

  if (!teamsync.isConfigured(config)) {
    die('Team sync is not available in this build. If you are building MemBridge yourself, an operator must fill lib/backend.json (see the Team sync section of the README); or point at your own backend with `membridge team setup`.');
  }

  if (sub === 'create') {
    const name = args[2];
    if (!name) die('Usage: membridge team create <name>');
    const t = await teamsync.createTeam(config, name);
    console.log(`Team created.\n  id:          ${t.team_id}\n  invite code: ${t.invite_code}\nTeammates join with: membridge team join ${t.invite_code}`);
    return;
  }

  if (sub === 'join') {
    const code = args[2];
    if (!code) die('Usage: membridge team join <invite link or code>');
    const t = await teamsync.join(config, code);
    console.log(`Joined team "${t.team_name}" (${t.team_id}).`);
    return;
  }

  if (sub === 'invite') {
    let teamId = opt('--team');
    const teams = await teamsync.listTeams(config);
    if (!teamId && teams.length === 1) teamId = teams[0].team_id;
    if (!teamId) {
      die(`Pick a team with --team <id>:\n` + teams.map(t => `  ${t.team_id}  ${t.team_name}`).join('\n'));
    }
    const days = parseInt(opt('--expires-days') || '', 10);
    const maxUses = parseInt(opt('--max-uses') || '', 10);
    const inv = await teamsync.createInvite(config, teamId, {
      expiresAt: Number.isFinite(days) ? new Date(Date.now() + days * 86400000).toISOString() : null,
      maxUses: Number.isFinite(maxUses) ? maxUses : null,
    });
    console.log(`Invite link created${inv.expires_at ? `, expires ${inv.expires_at.slice(0, 10)}` : ''}${inv.max_uses ? `, max ${inv.max_uses} use(s)` : ''}.`);
    if (inv.url) console.log(`  ${inv.url}`);
    console.log(`  membridge join ${inv.token}`);
    return;
  }

  if (sub === 'revoke-invite') {
    const token = args[2];
    if (!token) die('Usage: membridge team revoke-invite <token or link>');
    await teamsync.revokeInvite(config, token);
    console.log('Invite revoked. Anyone holding that link can no longer join.');
    return;
  }

  if (sub === 'link') {
    const projectPath = path.resolve(opt('--project') || process.cwd());
    let teamId = opt('--team');
    const teams = await teamsync.listTeams(config);
    if (!teams.length) die('You are not in any team yet — `membridge team create <name>` or `team join <code>` first.');
    if (!teamId && teams.length === 1) teamId = teams[0].team_id;
    if (!teamId) {
      die(`You are in ${teams.length} teams — pick one with --team <id>:\n` +
        teams.map(t => `  ${t.team_id}  ${t.team_name}`).join('\n'));
    }
    const team = teams.find(t => t.team_id === teamId);
    const link = await teamsync.linkProject(config, projectPath, teamId, team ? team.team_name : '');
    console.log(`Linked ${projectPath} to team "${team ? team.team_name : teamId}".\nRedacted memory entries for this project now sync with your team (${path.join(memorydb.DIR_NAME, 'team.json')} — commit it so teammates' clones auto-link).`);
    // First pass right away so the link is visible without waiting a tick.
    await teamSyncPass({ project: projectPath });
    return void link;
  }

  if (sub === 'unlink') {
    const projectPath = path.resolve(opt('--project') || process.cwd());
    console.log(teamsync.unlinkProject(projectPath)
      ? `Unlinked ${projectPath} — this project no longer syncs with any team.`
      : 'This project was not linked.');
    return;
  }

  if (sub === 'list') {
    const creds = teamsync.loadCredentials();
    console.log(creds ? `Logged in as ${creds.email} (${creds.displayName})` : 'Not logged in.');
    if (!creds) return;
    const teams = await teamsync.listTeams(config);
    if (!teams.length) {
      console.log('No teams yet — create one with: membridge team create <name>');
      return;
    }
    console.log('Teams:');
    for (const t of teams) {
      console.log(`  ${t.team_name} (${t.role})  id: ${t.team_id}${t.role === 'owner' ? `  invite: ${t.invite_code}` : ''}`);
    }
    const state = util.loadState();
    const linked = Object.keys(state.projects || {}).filter(k => teamsync.loadTeamLink(k));
    if (linked.length) {
      console.log('Linked projects:');
      for (const k of linked) {
        const l = teamsync.loadTeamLink(k);
        console.log(`  ${k} -> ${l.teamName || l.teamId}`);
      }
    }
    return;
  }

  die(`Unknown team subcommand: ${sub}\nUsage: membridge team <setup|create|invite|revoke-invite|join|link|unlink|list|share-prompts>`);
}

// ---------------------------------------------------------------------------
// Distillation (Claude Code Stop hook, see lib/hooks.js)
// ---------------------------------------------------------------------------
function cmdHook() {
  const sub = args[1];
  if (sub === 'stop') return hooks.runStop();
  die('Usage: membridge hook stop  (invoked by the Claude Code Stop hook — see `membridge setup-hooks`)');
}

function cmdHelp() {
  console.log(`MemBridge v${pkg.version} — shared memory across your AI coding tools

Your AI tools each keep their own session history. MemBridge watches them all,
distills a brief per-project memory, and writes it into the context files every
tool reads (CLAUDE.md, AGENTS.md, ...) — so Codex knows what Claude Code did,
and vice versa. Everything stays on your machine.

Usage: membridge <command>

  start               run the background daemon (sync + dashboard)
  stop                stop the background daemon
  status              daemon state, watched projects, config summary
  dashboard           open the local web dashboard (starts daemon if needed)
  sync [--dry-run] [--project <path>]   one sync pass right now
  scan                read-only: show which tools/projects were discovered
  remove [--project <path>]             strip injected memory blocks
  enable-autostart    launch MemBridge automatically at login
  disable-autostart   remove the login launcher
  daemon              run in the foreground (used internally / by services)
  help                this text

Distillation (agent-written session summaries — see README):
  setup-hooks         add a Claude Code Stop hook: the agent that did the work
                      writes a 2-3 line summary before each session ends
  remove-hooks        remove the MemBridge Stop hook (your other hooks are kept)
  hook stop           the hook itself (invoked by Claude Code, not by you)

Team sync (share project memory with your team — see README):
  join <link-or-code> [--email <e> --password <p>]   one command from invite to member
  signup / login --email <e> --password <p> [--name "You"]
  logout
  team create <name>       new team (prints the invite code)
  team invite [--team <id>] [--expires-days N] [--max-uses N]   create an invite link
  team revoke-invite <token>                   kill an invite link
  team join <link-or-code> join a teammate's team (same as top-level join)
  team link [--project <path>] [--team <id>]   sync this project with the team
  team unlink [--project <path>]               stop syncing this project
  team list                your login, teams and linked projects
  team share-prompts <on|off>  also upload your (redacted) prompts; off = summaries/files only
  team setup ...           advanced: point at your own self-hosted backend

Config: ${util.configPath()}
Docs:   https://github.com/mmelika/membridge#readme`);
}

const commands = {
  sync: cmdSync,
  scan: cmdScan,
  daemon: cmdDaemon,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  remove: cmdRemove,
  dashboard: cmdDashboard,
  signup: cmdSignup,
  login: cmdLogin,
  logout: cmdLogout,
  join: cmdJoin,
  team: cmdTeam,
  hook: cmdHook,
  'setup-hooks': () => {
    console.log(hooks.setupHooks());
    const raw = util.loadUserConfig();
    if (!raw.distill) raw.distill = {};
    if (raw.distill.consent !== 'granted') {
      raw.distill.consent = 'granted';
      util.saveUserConfig(raw);
    }
  },
  'remove-hooks': () => console.log(hooks.removeHooks()),
  'enable-autostart': () => console.log(autostart.enable()),
  'disable-autostart': () => console.log(autostart.disable()),
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
  '--version': () => console.log(pkg.version),
  version: () => console.log(pkg.version),
};

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(1);
}
// .then(fn), not .resolve(fn()): a synchronous throw must reach the same
// clean error path as an async rejection.
Promise.resolve().then(fn).catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
