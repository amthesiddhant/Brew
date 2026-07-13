const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brew', {
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  turnOn: () => ipcRenderer.invoke('turn-on'),
  turnOff: () => ipcRenderer.invoke('turn-off'),
  toggleSlackMode: () => ipcRenderer.invoke('toggle-slack-mode'),
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (event, status) => callback(status));
  }
});
