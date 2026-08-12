const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brew', {
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  turnOn: () => ipcRenderer.invoke('turn-on'),
  turnOff: () => ipcRenderer.invoke('turn-off'),
  toggleSlackMode: () => ipcRenderer.invoke('toggle-slack-mode'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Access gate: check the signed-in SOMA user against the shared allowlist.
  // Returns { allowed, email, reason, offline }.
  checkAccess: () => ipcRenderer.invoke('access:check'),
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

  // Usage insights dashboard.
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  statsGet: () => ipcRenderer.invoke('stats:get'),
  // Admin: whether the signed-in user may see everyone's usage (decided
  // server-side from their unspoofable Google identity). Returns
  // { isAdmin, role, email }.
  adminWhoAmI: () => ipcRenderer.invoke('admin:whoami'),
  // Admin: all users' daily usage rows from the shared BrewUsage sheet. Returns
  // { ok, isAdmin, rows } — rows is [] for non-admins (the server enforces it).
  adminGetUsage: () => ipcRenderer.invoke('admin:getUsage'),
  // The main process pings this whenever the numbers change (start/stop) or the
  // dashboard is re-shown, so the view can re-pull and re-render.
  onStatsRefresh: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('stats-refresh', listener);
    return () => ipcRenderer.removeListener('stats-refresh', listener);
  },
});
