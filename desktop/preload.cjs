const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('teamDesktop', Object.freeze({
  openNativeHarness: (url,options) => invoke('team:native-open', url,options),
  projectHome: entry => invoke('team:project-home',entry),
  projectRequest: (path,method,body) => invoke('team:project-request',path,method,body),
  selectHostFolder: initialPath => invoke('team:select-host-folder', initialPath),
  receivedMedia: () => invoke('team:received-media'),
  saveProjectFile: spec => invoke('team:save-project-file', spec),
  saveMedia: id => invoke('team:save-media', id),
  accountDirectory: () => invoke('team:account-directory'),
  accountLogin: body => invoke('team:account-login',body),
  accountOpen: id => invoke('team:account-open',id),
  accountLogout: () => invoke('team:account-logout'),
  info: () => invoke('team:info'),
  rememberStatus: () => invoke('team:remember-status'),
  restoreLogin: () => invoke('team:remember-restore'),
  forgetLogin: () => invoke('team:remember-clear'),
  connect: (origin, serverId) => invoke('team:connect', origin, serverId),
  restore: () => invoke('team:restore'),
  disconnect: () => invoke('team:disconnect'),
  discover: () => invoke('team:discover'),
  request: (path, method, body) => invoke('team:request', path, method, body),
  hostStatus: () => invoke('team:host-status'),
  hostStart: () => invoke('team:host-start'),
  hostStop: () => invoke('team:host-stop'),
  loginStart: enabled => invoke('team:login-start', enabled)
}));
