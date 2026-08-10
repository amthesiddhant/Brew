const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brew', {
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  turnOn: () => ipcRenderer.invoke('turn-on'),
  turnOff: () => ipcRenderer.invoke('turn-off'),
  toggleSlackMode: () => ipcRenderer.invoke('toggle-slack-mode'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (event, status) => callback(status));
  },
  onTriggerUpdateCheck: (callback) => {
    ipcRenderer.on('trigger-update-check', () => callback());
  },
  // App updates (via SOMA releases)
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateOpenTokenPage: () => ipcRenderer.invoke('update:openTokenPage'),
  updateConnect: (token) => ipcRenderer.invoke('update:connect', { token }),
  updateDisconnect: () => ipcRenderer.invoke('update:disconnect'),
  // Leave the SOMA lock screen and load the main UI (only works once a
  // verified token is saved — the main process re-checks before unlocking).
  unlock: () => ipcRenderer.invoke('unlock'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateProgress: () => ipcRenderer.invoke('update:progress'),
  // Push notification: a background check found a newer release. Returns an
  // unsubscribe fn. Payload: { version, name, notes, hasInstaller, ... }.
  onUpdateAvailable: (handler) => {
    const listener = (_evt, info) => handler(info);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
});
