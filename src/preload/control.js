// Bridge exposed to the control panel as window.control
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('control', {
  state: () => ipcRenderer.invoke('panel:state'),
  setWallpaper: (key, id) => ipcRenderer.invoke('panel:set-wallpaper', key, id),
  setProp: (key, name, value) => ipcRenderer.invoke('panel:set-prop', key, name, value),
  resetProps: (key) => ipcRenderer.invoke('panel:reset-props', key),
  setSetting: (name, value) => ipcRenderer.invoke('panel:set-setting', name, value),
  reload: () => ipcRenderer.invoke('panel:reload'),
  openFolder: () => ipcRenderer.invoke('panel:open-folder'),
  identify: () => ipcRenderer.invoke('panel:identify'),
  action: (key, name) => ipcRenderer.invoke('panel:action', key, name),
  openExternal: (url) => ipcRenderer.invoke('panel:open-external', url),
  quit: () => ipcRenderer.invoke('panel:quit'),
  onStats: (cb) => { const fn = (_e, s) => cb(s); ipcRenderer.on('panel:stats', fn); return () => ipcRenderer.removeListener('panel:stats', fn); },
});
