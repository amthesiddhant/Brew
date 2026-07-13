const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brew', {
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  turnOn: () => ipcRenderer.invoke('turn-on'),
  turnOff: () => ipcRenderer.invoke('turn-off'),
  toggleSlackMode: () => ipcRenderer.invoke('toggle-slack-mode'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openDownloadUrl: (url) => ipcRenderer.invoke('open-download-url', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (event, status) => callback(status));
  },
  onTriggerUpdateCheck: (callback) => {
    ipcRenderer.on('trigger-update-check', () => callback());
  }
});
