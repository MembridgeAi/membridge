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
const { startServer, boundPort } = lib('server');
const teamsync = lib('teamsync');
const hooks = lib('hooks');
const autostart = lib('autostart');

const SMOKE = process.argv.includes('--smoke');
let tray = null;
let win = null;
let paused = false;
let lastSync = null;
let lastSyncFailed = false;
let syncBusy = false;

// Pause survives a relaunch: the flag lives in config.json next to everything
// else the daemon persists, via the same loadUserConfig/saveUserConfig
// read-modify-write every other config writer uses (atomic rename, 0600).
// Best-effort both ways — a config problem must never take down a tray click
// or the launch path, so the in-memory flag always still flips.
function persistPaused(value) {
  try {
    const raw = util.loadUserConfig();
    raw.syncPaused = value;
    util.saveUserConfig(raw);
  } catch {}
}
function loadPersistedPaused() {
  try {
    return !!util.loadUserConfig().syncPaused;
  } catch {
    return false;
  }
}

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

// The pidfile (lib/util.pidPath) stores a BARE pid — nothing about what
// process it was. A stale pidfile plus OS pid reuse means "alive" alone is
// not proof it's ours, and killing on that evidence SIGTERMs some random
// process. Identity check: the live process's command line must mention
// membridge. Fail-safe — any doubt (ps unavailable, empty output, no match)
// means no kill; takeOverDaemon still claims the pidfile either way.
function pidLooksLikeMembridge(pid) {
  try {
    const { execSync } = require('child_process');
    // pid came through parseInt (readPid), so interpolation is safe.
    const cmd = process.platform === 'win32'
      ? execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
          { timeout: 5000 }).toString()
      : execSync(`ps -p ${pid} -o command=`, { timeout: 5000 }).toString();
    return /membridge/i.test(cmd);
  } catch {
    return false;
  }
}

// If a CLI daemon is running, the app takes over (one syncer at a time), and
// registers its own pid so `membridge status`/`stop` keep working.
function takeOverDaemon() {
  const pid = readPid();
  if (pid && pid !== process.pid && pidRunning(pid)) {
    if (pidLooksLikeMembridge(pid)) {
      try {
        process.kill(pid);
        util.log(`tray app took over from CLI daemon (pid ${pid})`);
      } catch {}
    } else {
      util.log(`pidfile pid ${pid} is alive but doesn't look like a MemBridge process — not killing it (stale pidfile + pid reuse?)`);
    }
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
    lastSyncFailed = false;
  } catch (err) {
    // Still swallowed (a sync error must never take the app down), but no
    // longer invisible: the tray menu shows a failure row until a sync
    // succeeds again.
    lastSyncFailed = true;
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

// Prefer the port the dashboard server ACTUALLY bound (lib/server.js records
// it from the listening socket — startServer here and boundPort come from the
// same module instance, so the app sees it directly). config.dashboardPort is
// only the requested port; it stays as the fallback for the moment before the
// async listen completes.
const dashboardUrl = () => `http://127.0.0.1:${boundPort() || util.getConfig().dashboardPort}`;

// The rebuilt UI is the default now (lib/server.js serves it at / directly;
// the legacy lib/dashboard/* renderer this used to point past is deleted).
// /app still resolves too -- lib/server.js redirects it to / -- but there is
// no reason for the desktop window to take the extra hop itself.
const windowUrl = () => dashboardUrl();

// URL parsing that never throws: malformed/exotic URLs come back with a
// null origin/protocol, which fails every allowlist check below (fail closed).
function safeOrigin(url) {
  try {
    const u = new URL(url);
    return { origin: u.origin, protocol: u.protocol };
  } catch {
    return { origin: null, protocol: null };
  }
}

// Navigation lockdown for EVERY window that renders dashboard content -- the
// main window AND any child the same-origin window.open carve-out spawns.
// One installer, applied to both, so the guards cannot drift (review finding:
// the child window used to get NO guards at all -- it carried preload.js and
// the membridge:pick-paths IPC bridge, and a teammate-authored link clicked
// inside it could navigate that capability anywhere, reopening the exact
// injection gap the hardening closed).
//
// Three rules, identical everywhere:
//   * will-navigate: the window itself may only ever show the local
//     dashboard origin (preload stays attached across navigations).
//   * window.open: non-http(s) is denied outright; the LOCAL dashboard
//     origin (strict origin equality against the bound url -- never a
//     substring or port-loose match) opens a real BrowserWindow with the
//     same locked-down webPreferences (session detail spec: middle/cmd-click
//     on a feed row); every other http(s) url goes to the default browser.
//   * did-create-window: any child allowed by the carve-out is run through
//     THIS SAME installer, recursively, so grandchildren are guarded too --
//     without this, a child's window.open would fall back to Electron's
//     default allow-with-inherited-preload.
function installNavigationGuards(contents) {
  const allowedOrigin = safeOrigin(windowUrl()).origin;
  contents.on('will-navigate', (event, url) => {
    const { origin } = safeOrigin(url);
    if (!origin || origin !== allowedOrigin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const { origin, protocol } = safeOrigin(url);
    if (!/^https?:$/i.test(protocol || '')) return { action: 'deny' };
    if (origin && origin === allowedOrigin) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => {
    installNavigationGuards(child.webContents);
  });
}

function openDashboard() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
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
  // If the dashboard server isn't reachable (crashed, still binding, port
  // fight lost), Chrome's raw ERR_CONNECTION_REFUSED page is what the user
  // saw — no product name, no way back. Replace it with a minimal inline
  // page carrying a working Retry link. errorCode -3 is ERR_ABORTED (a load
  // superseded by another navigation, not a failure), and subframe failures
  // must not clobber a dashboard that is otherwise up.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const target = windowUrl();
    const port = new URL(target).port || '80';
    // The Retry link navigates back to the dashboard origin, which the
    // will-navigate allowlist below already permits; everything else on this
    // data: page is inert.
    const html = '<!doctype html><meta charset="utf-8"><title>MemBridge</title>'
      + '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee">'
      + '<div style="text-align:center;max-width:26em">'
      + '<h1 style="font-size:1.2em">Dashboard not reachable</h1>'
      + `<p>MemBridge couldn't load its dashboard on port ${port}. `
      + 'The local server may still be starting up.</p>'
      + `<p><a href="${target}" style="color:#7ab7ff">Retry</a></p>`
      + '</div></body>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
  // Popup + navigation lockdown, shared with every child window this one is
  // allowed to spawn -- see installNavigationGuards above for the rules.
  installNavigationGuards(win.webContents);
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
  try {
    // Inside the try on purpose: lib() resolution can itself throw (a
    // broken/partial install), and out here that was an unhandled rejection
    // taking the app down instead of the documented fail-silent.
    const updateCheck = lib('update-check');
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
      // The curl|sh installer is macOS-only. On win32 there is no /bin/sh at
      // all, and spawn's missing-executable failure arrives as an async
      // 'error' EVENT — the try/catch below never sees it, so the old code
      // died on an uncaught exception instead of updating. Non-mac goes
      // straight to the releases page.
      if (process.platform !== 'darwin') {
        shell.openExternal(updateCheck.RELEASES_PAGE);
        return;
      }
      // Install in place instead of opening a web page. Run the pinned installer
      // DETACHED (its own session) so it survives this app quitting — install.sh
      // quits the running MemBridge to replace its bundle, then reopens the new
      // version itself (its step 8 `open`). stdio is ignored; it finishes on its own.
      const { spawn } = require('child_process');
      try {
        const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
        // spawn failures surface as an 'error' event, not a throw — without
        // this listener the whole app goes down on an uncaught exception.
        child.on('error', () => shell.openExternal(updateCheck.RELEASES_PAGE));
        child.unref();
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

// Two start-at-login mechanisms exist: Electron's login item (this tray
// checkbox) and lib/autostart's LaunchAgent/systemd/VBS daemon launcher (the
// dashboard's Settings toggle → POST /api/settings → autostart.enable()).
// Inside the packaged app the LaunchAgent variant is broken anyway — it
// launches process.execPath (the Electron binary) WITHOUT ELECTRON_RUN_AS_NODE,
// so at login it opens the GUI instead of a daemon. The app makes the Electron
// login item the single source of truth: the checkbox reflects EITHER
// mechanism, and toggling it writes the login item and removes the daemon
// launcher, so exactly one mechanism survives every toggle.
function startAtLoginEnabled() {
  let daemonAutostart = false;
  try {
    daemonAutostart = autostart.isEnabled();
  } catch {}
  return app.getLoginItemSettings().openAtLogin || daemonAutostart;
}
function setStartAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  try {
    autostart.disable(); // whichever way the toggle went, the daemon launcher goes
  } catch {}
  updateMenu();
}

// Self-heal at launch (packaged builds only): if the dashboard toggle left a
// daemon launcher behind, convert it into the login item it was meant to be.
function migrateDaemonAutostart() {
  if (!app.isPackaged) return; // dev runs must not eat a real CLI-daemon setup
  try {
    if (autostart.isEnabled()) {
      autostart.disable();
      app.setLoginItemSettings({ openAtLogin: true });
      util.log('migrated daemon autostart (LaunchAgent/unit/VBS) to the app login item');
    }
  } catch {}
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
  // The icon itself has one state, so the menu carries the health signal:
  // paused wins (a paused app failing its last sync is not news), then a
  // failed last sync — errors are swallowed in runSync by design, and until
  // this row they were invisible outside the log file.
  const indicator = paused
    ? { label: 'Paused — syncing is off', enabled: false }
    : lastSyncFailed
      ? { label: '⚠ Last sync failed — see membridge.log', enabled: false }
      : null;
  const menu = Menu.buildFromTemplate([
    { label: paused ? 'MemBridge — paused' : 'MemBridge — running', enabled: false },
    {
      label: solo
        ? `${projects} project(s) · local only`
        : `${projects} project(s) · last sync ${ago(lastSync)}`,
      enabled: false,
    },
    ...(indicator ? [indicator] : []),
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
        persistPaused(paused); // a relaunch stays paused
        updateMenu();
      },
    },
    { type: 'separator' },
    { label: `Check for updates… (v${app.getVersion()})`, click: () => checkForUpdate({ manual: true }) },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: startAtLoginEnabled(),
      click: item => setStartAtLogin(item.checked),
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
    // Restore a persisted pause BEFORE the first tick, or a relaunch of a
    // paused app would run one sync pass the user had switched off.
    paused = loadPersistedPaused();
    startServer(config.dashboardPort);

    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
    tray = new Tray(icon);
    tray.setToolTip('MemBridge — shared memory across your AI coding tools');
    // Left-click (or a double-click) the tray icon opens the dashboard — the
    // primary way to open the app on Windows/Linux, where the context menu is
    // right-click only. On macOS a click opens the menu by convention (and
    // registering 'click' there would open the menu AND a window on every
    // left-click), so these handlers are non-mac only; the menu already
    // carries "Open dashboard" on macOS.
    if (process.platform !== 'darwin') {
      tray.on('click', openDashboard);
      tray.on('double-click', openDashboard);
    }
    updateMenu();

    // smoke mode verifies tray + server boot only — it must never sync/write
    if (!SMOKE) {
      migrateDaemonAutostart();
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

    // Windows/Linux get a real window at launch: those platforms are
    // tray-only otherwise, and Windows 11 hides new tray icons behind the
    // overflow chevron — a first launch that shows NOTHING reads as broken.
    // macOS keeps its menu-bar-only convention.
    if (!SMOKE && process.platform !== 'darwin') openDashboard();

    // First-run consent for session summaries — AWAITED LAST, deliberately.
    // This dialog used to run before ensureInstalled()/tick()/setInterval,
    // which meant no hook install and no sync happened until the user noticed
    // an unowned dialog, while the tray already said "running". The dialog
    // gates ONLY consent.applyConsent (recording distill.consent, and running
    // hooks.setupHooks() on a grant); none of the machinery above is
    // consent-gated — it already ran unconditionally after the dialog — so
    // starting it first changes nothing about what consent controls. Sync
    // output honors the decision at render time: lib/digest.js only adds the
    // AGENTS.md summary line when distill.consent === 'granted', so a sync
    // pass that ran while the dialog was still open wrote nothing a "Not now"
    // should have prevented.
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
      // A grant used to be visible in the very first sync pass (dialog ran
      // first). Keep that: re-sync now so the AGENTS.md line lands
      // immediately instead of one full interval later.
      if (response === 0) tick();
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
