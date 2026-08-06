'use strict';
// The desktop app's window privileges and navigation guards.
//
// WHY THIS MATTERS MORE THAN ITS SIZE. An Electron app is a browser, and a
// browser that loads the wrong thing with the wrong privileges is arbitrary
// code execution on the user's machine with their filesystem attached. This
// window loads a page from the local daemon over HTTP — not trusted app code —
// so the privilege boundary between that page and Node is the whole audit.
//
// RESULT: clean. Every check below passes. This suite exists so it stays that
// way, the same way the daemon's absent CORS header is pinned: these are
// properties that are cheap to lose in a one-line "fix" and expensive to notice.
//
// VERSION MATTERS HERE and was checked rather than assumed. package.json builds
// against electron ^43. Several of these settings changed defaults across major
// versions — `contextIsolation` defaulted false before 12, `sandbox` defaulted
// false before 20 — so "the modern default protects us" is only true for a
// version you have confirmed. On 43 the safe values ARE the defaults, and the
// code sets the two load-bearing ones explicitly anyway.
//
// METHOD, stated plainly: this reads source. Driving a real BrowserWindow needs
// a display and an Electron runtime the suite does not have, so these assert the
// configuration is written correctly, not that Electron honours it. That is
// weaker evidence than an executed test — it catches a future edit removing a
// guard, not a misunderstanding of Electron's behaviour.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app');
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');

async function main_() {
  // If the renderer can reach Node, nothing else matters. Both windows — the
  // main one and the child that window.open may create — must carry these.
  await check('every window disables Node and keeps context isolation on', () => {
    const isolation = main.match(/contextIsolation: true/g) || [];
    const nodeOff = main.match(/nodeIntegration: false/g) || [];
    assert.ok(isolation.length >= 2,
      `contextIsolation: true must be set on the main window AND the ` +
      `window.open override (found ${isolation.length})`);
    assert.strictEqual(nodeOff.length, isolation.length,
      'every window that sets contextIsolation must also set nodeIntegration: false');
    assert.ok(!/contextIsolation:\s*false|nodeIntegration:\s*true/.test(main),
      'neither may ever be weakened — the loaded page is a web page from the ' +
      'daemon, not trusted app code');
  });

  // The absent-setting invariant, the same shape as the daemon's missing CORS
  // header: on Electron 20+ the sandbox is on unless something turns it off, so
  // the protection here is the ABSENCE of a line. One `sandbox: false` added to
  // make a preload convenience work would remove it silently.
  await check('nothing disables the sandbox or web security', () => {
    for (const bad of ['sandbox: false', 'webSecurity: false',
      'allowRunningInsecureContent', 'experimentalFeatures']) {
      assert.ok(!main.includes(bad),
        `${bad} must not appear — Electron 43 defaults are safe, and each of ` +
        'these silently removes one of the protections this window relies on');
    }
  });

  // WHAT IT LOADS. The window may only ever show the local daemon origin, so no
  // remote page renders with the preload bridge attached. Strict origin
  // equality, never a substring or port-loose match.
  await check('the window may only navigate to the local dashboard origin', () => {
    assert.match(main, /contents\.on\('will-navigate'/,
      'a will-navigate guard must exist');
    assert.match(main, /if \(!origin \|\| origin !== allowedOrigin\) event\.preventDefault\(\)/,
      'will-navigate must block any origin that is not exactly the dashboard ' +
      "origin — an app that navigates its main window to an arbitrary URL is " +
      'the classic version of this bug');
  });

  await check('window.open denies non-http(s) and sends foreign links to the OS browser', () => {
    assert.match(main, /setWindowOpenHandler/, 'a window-open handler must exist');
    assert.match(main, /if \(!\/\^https\?:\$\/i\.test\(protocol \|\| ''\)\) return \{ action: 'deny' \}/,
      'non-http(s) schemes must be denied outright, before any origin check');
    assert.match(main, /shell\.openExternal\(url\);\s*\n\s*return \{ action: 'deny' \}/,
      'a foreign http(s) link must hand off to the system browser AND deny the ' +
      'in-app window — doing only the first leaves the page open in-app');
  });

  // The recursion is the part that is easy to omit and was already missed once:
  // without it a child window's own window.open falls back to Electron's default
  // allow-with-inherited-preload, and the guards stop one level down.
  await check('child windows get the same guards, recursively', () => {
    assert.match(main, /contents\.on\('did-create-window', \(child\) => \{\s*\n\s*installNavigationGuards\(child\.webContents\)/,
      'did-create-window must re-run the SAME installer on the child, or a ' +
      'grandchild window is unguarded while still carrying the preload bridge');
  });

  // THE WHOLE ATTACK SURFACE, given the renderer cannot reach Node. One channel.
  await check('the preload exposes exactly one channel, and no general passthrough', () => {
    const exposed = preload.match(/exposeInMainWorld/g) || [];
    assert.strictEqual(exposed.length, 1, 'exactly one bridge object');
    const invokes = preload.match(/ipcRenderer\.invoke\(/g) || [];
    assert.strictEqual(invokes.length, 1,
      `exactly one IPC channel may be reachable from the page (found ${invokes.length})`);
    assert.match(preload, /ipcRenderer\.invoke\('membridge:pick-paths'/,
      'the one channel is the native path picker');
    for (const bad of ['ipcRenderer.send', 'ipcRenderer.on', 'require(\'fs\')',
      'child_process', 'shell.']) {
      assert.ok(!preload.includes(bad),
        `${bad} must not be reachable from the renderer — the bridge is a ` +
        'single typed capability, not an ipcRenderer passthrough');
    }
  });

  // The one channel's own gate. A hostile page reaching it can at worst open a
  // file dialog the USER must then act on; it cannot read a path the user did
  // not choose, and it never returns file CONTENTS. The kind check is what stops
  // the options object steering showOpenDialog into some other mode.
  await check('the path picker validates its own argument in the main process', () => {
    assert.match(main, /if \(kind !== 'file' && kind !== 'folder'\)/,
      'kind must be validated in the MAIN process, never trusted from the page');
    assert.ok(!/properties\.push\(options\./.test(main),
      'the properties array must be built from validated values, not spread ' +
      'from caller-supplied options');
  });

  h.finish();
}

main_().catch(err => {
  console.error(err);
  process.exit(1);
});
