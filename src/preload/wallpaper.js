// Bridge exposed to wallpaper pages as window.host
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('host', {
  getContext: () => ipcRenderer.invoke('wp:context'),
  onContext: listeners('host:context'),
  onProps: listeners('host:props'),
  onSettings: listeners('host:settings'),
  onPause: listeners('host:pause'),
  onCovered: listeners('host:covered'),
  onIdentify: listeners('host:identify'),
  onAction: listeners('host:action'),
  getData: (key) => ipcRenderer.invoke('wp:get-data', key),
  setData: (key, value) => ipcRenderer.invoke('wp:set-data', key, value),
  log: (msg) => ipcRenderer.send('wp:log', String(msg)),
  stats: (s) => ipcRenderer.send('wp:stats', s),
});
