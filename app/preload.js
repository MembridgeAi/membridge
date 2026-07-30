'use strict';
// Loaded into the dashboard BrowserWindow via webPreferences.preload (see
// openDashboard() in main.js). That window renders a normal web page fetched
// over http://127.0.0.1:<port>/app/ -- contextIsolation stays on and
// nodeIntegration stays off, so this is the ONLY door between the page and
// Node/Electron. It exposes exactly one narrow capability (opening a native
// Finder/Explorer picker) and nothing else: no arbitrary fs access, no
// shell, no ipcRenderer passthrough.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('membridge', {
  /**
   * Opens a native "Open File"/"Open Folder" dialog and resolves to the
   * chosen absolute paths, or [] if the user cancels. The main process (see
   * PICK_PATHS_CHANNEL's handler in main.js) validates `kind` itself -- this
   * is just a thin, typed-in-comments passthrough over ipcRenderer.invoke.
   * @param {{ kind: 'file' | 'folder', multiple?: boolean }} options
   * @returns {Promise<string[]>}
   */
  pickPaths(options) {
    return ipcRenderer.invoke('membridge:pick-paths', options);
  },
});
