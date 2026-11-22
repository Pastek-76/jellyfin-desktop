const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  // Pages locales de l'application (connexion, hors ligne, paramètres).
  contextBridge.exposeInMainWorld('jellyfinDesktop', {
    listServers: () => ipcRenderer.invoke('servers:list'),
    discover: () => ipcRenderer.invoke('servers:discover'),
    connect: (url) => ipcRenderer.invoke('servers:connect', url),
    remove: (url) => ipcRenderer.invoke('servers:remove', url),
    trust: (host, fingerprint) => ipcRenderer.invoke('servers:trust', host, fingerprint),
    retryNow: () => ipcRenderer.invoke('offline:retry'),
    showConnect: () => ipcRenderer.invoke('offline:connect-page'),
    onOfflineStatus: (cb) => ipcRenderer.on('offline:status', (_e, s) => cb(s)),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    checkUpdates: () => ipcRenderer.invoke('updates:check'),
    installUpdate: () => ipcRenderer.invoke('updates:install'),
    onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (_e, s) => cb(s)),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  });
} else {
  // Client web du serveur Jellyfin courant : le processus principal ne répond
  // qu'à la page du serveur sélectionné (sinon boot est null et rien n'est exposé).
  const boot = ipcRenderer.sendSync('host:boot');
  if (boot) {
    const commandListeners = [];
    const mpvListeners = [];
    ipcRenderer.on('host:command', (_e, cmd) => commandListeners.forEach((cb) => cb(cmd)));
    ipcRenderer.on('mpv:event', (_e, ev) => mpvListeners.forEach((cb) => cb(ev)));

    contextBridge.exposeInMainWorld('jellyfinDesktopHost', {
      reportState: (state) => ipcRenderer.send('host:state', state),
      onCommand: (cb) => { if (typeof cb === 'function') commandListeners.push(cb); },
      setFullscreen: (on) => ipcRenderer.send('host:fullscreen', !!on),
      selectServer: () => ipcRenderer.send('host:select-server'),
      mpv: {
        play: (options) => ipcRenderer.invoke('mpv:play', options),
        command: (name, value) => ipcRenderer.invoke('mpv:command', name, value).catch(() => {}),
        stop: () => ipcRenderer.invoke('mpv:stop'),
        onEvent: (cb) => { if (typeof cb === 'function') mpvListeners.push(cb); },
      },
    });

    // Exécute l'intégration (src/inject.js) dans le monde de la page, avant ses scripts.
    // eslint-disable-next-line no-new-func
    const func = new Function('info', `(${boot.inject})(info);`);
    contextBridge.executeInMainWorld({ func, args: [boot.info] });
  }
}
