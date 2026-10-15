const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  notifyIncomingCall: (name, number) =>
    ipcRenderer.invoke('notify-incoming-call', name, number),

  setAutoStart: (enabled) =>
    ipcRenderer.invoke('set-auto-start', enabled),

  setMinimizeToTray: (enabled) =>
    ipcRenderer.invoke('set-minimize-to-tray', enabled),

  getSettings: () =>
    ipcRenderer.invoke('get-settings'),

  logRenderer: (level, message, data) =>
    ipcRenderer.invoke('renderer-log', level, message, data),

  getDiagnosticLogPath: () =>
    ipcRenderer.invoke('get-diagnostic-log-path'),

  storageGet: (key) =>
    ipcRenderer.invoke('storage-get', key),

  storageSet: (key, value) =>
    ipcRenderer.invoke('storage-set', key, value),

  storageRemove: (key) =>
    ipcRenderer.invoke('storage-remove', key),

  onDeepLink: (callback) =>
    ipcRenderer.on('deep-link', (_event, url) => callback(url)),
});
