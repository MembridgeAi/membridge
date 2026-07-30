'use strict';
// MemBridge desktop app: lives in the macOS menu bar AND the Dock (or the
// Windows/Linux system tray). Wraps the same sync engine + local dashboard as
// the CLI daemon — the app shell is just a face on it.
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, BrowserWindow, nativeImage, dialog, shell, ipcMain } = require('electron');

// lib/ is copied into app/lib by scripts/prepare-app.js (packaged builds);
// fall back to ../lib when running straight from the repo.
function lib(m) {
  try {
    return require(path.join(__dirname, 'lib', m));
  } catch {
    return require(path.join(__dirname, '..', 'lib', m));
  }
}
const util = lib('util');
const { syncOnce } = lib('scan');
const notesStore = lib('teammate-notes-store');
const { startServer } = lib('server');
const teamsync = lib('teamsync');
const hooks = lib('hooks');

const SMOKE = process.argv.includes('--smoke');
let tray = null;
let win = null;
let paused = false;
let lastSync = null;
let syncBusy = false;

function readPid() {
  try {
    return parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10) || null;
  } catch {
    return null;
  }
}
function pidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// If a CLI daemon is running, the app takes over (one syncer at a time), and
// registers its own pid so `membridge status`/`stop` keep working.
function takeOverDaemon() {
  const pid = readPid();
  if (pid && pid !== process.pid && pidRunning(pid)) {
    try {
      process.kill(pid);
      util.log(`tray app took over from CLI daemon (pid ${pid})`);
    } catch {}
  }
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(util.pidPath(), String(process.pid));
}

async function runSync() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    syncOnce();
    const teamResult = await teamsync.syncTeams();
    // Team pulls mark the affected project dirty. Re-render immediately so
    // every local AI tool sees new teammate context in the same timer pass.
    for (const projectPath of teamResult.changed) syncOnce({ project: projectPath });
    // Same post-pull step the CLI daemon runs: rebuild the teammate-notes
    // index for changed projects and backfill any project whose entries
    // predate the feature. This loop and bin/membridge.js's are the two sync
    // loops in the product; the shared logic lives in the store so neither
    // can drift from the other (the first version lived only in bin/, and the
    // tray app -- the normal install -- never built an index at all).
    notesStore.afterTeamPull(teamResult.changed);
    lastSync = new Date();
  } catch (err) {
    util.log(`tray app sync error: ${err.stack || err}`);
  } finally {
    syncBusy = false;
  }
}

function tick() {
  if (!paused) runSync().then(updateMenu);
  else updateMenu();
}

function ago(date) {
  if (!date) return 'never';
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const dashboardUrl = () => `http://127.0.0.1:${util.getConfig().dashboardPort}`;

// The rebuilt UI is the default now (lib/server.js serves it at / directly;
// the legacy lib/dashboard/* renderer this used to point past is deleted).
// /app still resolves too -- lib/server.js redirects it to / -- but there is
// no reason for the desktop window to take the extra hop itself.
const windowUrl = () => dashboardUrl();

function openDashboard() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 920,
    height: 720,
    title: 'MemBridge',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')),
    webPreferences: {
      // This window loads a normal web page from the daemon's own HTTP
      // server (windowUrl() above) -- it is not trusted app code, so it
      // gets no Node access. preload.js is the one narrow bridge (see
      // PICK_PATHS_CHANNEL below): contextIsolation must stay on and
      // nodeIntegration must stay off, or that page could reach Node/fs
      // directly. Do not weaken either to "fix" a renderer-side issue.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(windowUrl());
  // Anything the dashboard opens as a popup (the GitHub sign-in round trip)
  // goes to the default browser — GitHub is already signed in there, and
  // nothing external ever renders inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

// The one capability preload.js exposes to the dashboard window: a native
// "Open File"/"Open Folder" dialog. The daemon (a separate process with no
// window of its own) cannot show this -- only the Electron main process can
// -- which is the whole reason this bridge exists. Validates `kind` itself
// rather than trusting the renderer, even though the renderer here is our
// own UI: the point of the allowlist is that this handler can never be
// turned into a general-purpose fs/dialog passthrough by a future caller.
const PICK_PATHS_CHANNEL = 'membridge:pick-paths';
ipcMain.handle(PICK_PATHS_CHANNEL, async (event, options) => {
  const kind = options && options.kind;
  if (kind !== 'file' && kind !== 'folder') {
    throw new Error(`pickPaths: kind must be "file" or "folder", got ${JSON.stringify(kind)}`);
  }
  const properties = [kind === 'folder' ? 'openDirectory' : 'openFile'];
  if (options.multiple) properties.push('multiSelections');
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
  const result = await dialog.showOpenDialog(ownerWindow, { properties });
  return result.canceled ? [] : result.filePaths;
});

// Check for a newer release. Best-effort and fail-silent. MemBridge has no
// in-app auto-updater (that would need an Apple Developer signature), so we
// point the user at the one-line installer instead of updating for them.
//
// Two modes:
//  - automatic (on launch): silent unless a newer version exists, and only
//    nags once per version.
//  - manual ("Check for updates…" menu item): always reports a result, forces
//    a fresh network check, and ignores the once-per-version guard.
async function checkForUpdate({ manual = false } = {}) {
  const updateCheck = lib('update-check');
  try {
    const r = await updateCheck.check({ current: app.getVersion(), force: manual });
    if (!r.updateAvailable) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'MemBridge',
          message: r.latest
            ? `You're up to date — v${r.current} is the latest version.`
            : `Couldn't reach the update server. You're on v${r.current}.`,
          buttons: ['OK'],
        });
      }
      return;
    }
    if (!manual && updateCheck.alreadyNotified(r.latest)) return;
    updateCheck.markNotified(r.latest);
    const command = updateCheck.updateCommand('app');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `MemBridge v${r.latest} is available (you're on v${r.current}).`,
      detail: 'Install now? MemBridge will quit, update, and reopen automatically — this takes a few seconds.',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      // Install in place instead of opening a web page. Run the pinned installer
      // DETACHED (its own session) so it survives this app quitting — install.sh
      // quits the running MemBridge to replace its bundle, then reopens the new
      // version itself (its step 8 `open`). stdio is ignored; it finishes on its own.
      const { spawn } = require('child_process');
      try {
        spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
        await dialog.showMessageBox({
          type: 'info',
          title: 'Updating MemBridge',
          message: `Installing v${r.latest}…`,
          detail: 'MemBridge will quit while it updates, then reopen automatically.',
          buttons: ['OK'],
        });
      } catch {
        shell.openExternal(updateCheck.RELEASES_PAGE); // fallback if the installer can't launch
      }
    }
  } catch {
    // an update check must never take the app down
    if (manual) {
      try {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'MemBridge',
          message: 'Could not check for updates right now.',
          buttons: ['OK'],
        });
      } catch {}
    }
  }
}

function updateMenu() {
  if (!tray) return;
  let projects = 0;
  // The tray made the same claim the header pill used to: "last sync <time>" on
  // a machine that syncs with nobody. Solo says what is actually true.
  let solo = false;
  try {
    const state = util.loadState();
    const keys = Object.keys(state.projects || {});
    projects = keys.length;
    solo = teamsync.isSoloMachine(
      keys.map(k => teamsync.loadTeamLink(k)),
      state.teamCounts || {},
      !!teamsync.loadCredentials(),
    );
  } catch {}
  const menu = Menu.buildFromTemplate([
    { label: paused ? 'MemBridge — paused' : 'MemBridge — running', enabled: false },
    {
      label: solo
        ? `${projects} project(s) · local only`
        : `${projects} project(s) · last sync ${ago(lastSync)}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Open dashboard', click: openDashboard },
    {
      label: 'Sync now',
      click: () => {
        runSync().then(updateMenu);
      },
    },
    {
      label: 'Pause syncing',
      type: 'checkbox',
      checked: paused,
      click: item => {
        paused = item.checked;
        updateMenu();
      },
    },
    { type: 'separator' },
    { label: `Check for updates… (v${app.getVersion()})`, click: () => checkForUpdate({ manual: true }) },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit MemBridge', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// Headless launch-at-login toggle: `MemBridge --set-login=on|off` flips the
// login item and exits, without opening the tray/UI. Lets an installer (or a
// script) manage autostart, and stays in sync with the tray "Start at login"
// checkbox since both use Electron's login-item settings. Handled before the
// single-instance lock so it works even while the app is already running.
const loginArg = process.argv.find(a => a.startsWith('--set-login='));
if (loginArg) {
  app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: loginArg.split('=')[1] !== 'off' });
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Re-launching the app while it's already running (double-clicking the icon
  // again) opens the dashboard instead of doing nothing — the single-instance
  // lock otherwise just quietly quits the second copy.
  app.on('second-instance', openDashboard);
  app.whenReady().then(async () => {
    // Windows groups taskbar buttons and picks the window/jump-list icon by
    // AppUserModelID; without this it can fall back to the generic Electron
    // icon. Must match build.appId and be set before any window is created.
    if (process.platform === 'win32') app.setAppUserModelId('com.membridge.app');
    util.ensureConfig();
    takeOverDaemon();
    const config = util.getConfig();
    startServer(config.dashboardPort);

    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
    tray = new Tray(icon);
    tray.setToolTip('MemBridge — shared memory across your AI coding tools');
    // Left-click (or a double-click) the tray icon opens the dashboard — the
    // primary way to open the app on Windows/Linux, where the context menu is
    // right-click only. On macOS a click opens the menu by convention, so the
    // menu already carries "Open dashboard" there.
    tray.on('click', openDashboard);
    tray.on('double-click', openDashboard);
    updateMenu();

    // First-run consent for session summaries
    const consent = lib('consent');
    if (!SMOKE && consent.needsConsentPrompt(config)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Enable session summaries?',
        message: 'MemBridge can ask your AI tools to leave a short note about what they worked on, so your other tools stay in the loop. This adds one line to each project\'s AGENTS.md and installs a Claude Code hook.',
        buttons: ['Enable', 'Not now'],
        defaultId: 0,
        cancelId: 1,
      });
      consent.applyConsent(response === 0 ? 'granted' : 'declined');
    }

    // smoke mode verifies tray + server boot only — it must never sync/write
    if (!SMOKE) {
      // Auto-register the Claude Code Stop hook when the app launches, so users
      // who only ever download and open MemBridge.app get it without a manual
      // `setup-hooks` step. Silent and fail-open. Kept inside !SMOKE so the
      // CI/build boot-check never writes to a real ~/.claude/settings.json.
      hooks.ensureInstalled();
      tick();
      setInterval(tick, config.intervalSec * 1000);
      // Fire-and-forget: notify once per version if a newer release exists.
      checkForUpdate();
    }

    if (SMOKE) {
      setTimeout(async () => {
        try {
          const res = await fetch(`${dashboardUrl()}/api/status`);
          const body = await res.json();
          const ok = res.ok && body.running === true && !!tray;
          console.log(ok ? 'SMOKE OK' : `SMOKE FAIL status=${res.status}`);
          app.exit(ok ? 0 : 1);
        } catch (err) {
          console.log(`SMOKE FAIL ${err.message}`);
          app.exit(1);
        }
      }, 1500);
    }
  });
}

// keep living in the tray when the dashboard window is closed
// Keep running with no windows (the tray/daemon is the app); clicking the
// Dock icon (re)opens the dashboard window.
app.on('window-all-closed', () => {});
app.on('activate', () => {
  openDashboard();
});

app.on('before-quit', () => {
  try {
    if (readPid() === process.pid) fs.unlinkSync(util.pidPath());
  } catch {}
});
