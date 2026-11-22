// Jellyfin Desktop — processus principal Electron.
// L'application charge le client web officiel servi par votre serveur Jellyfin
// (https://serveur/web/), ce qui donne accès à 100 % de ses fonctionnalités, et y
// ajoute une intégration bureau : icône de notification, barre des tâches, lecteur mpv,
// Discord, reconnexion automatique et mises à jour.
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./store');
const servers = require('./servers');
const Playback = require('./playback');
const Mpv = require('./mpv');
const DiscordPresence = require('./discord');
const updater = require('./updater');
const inject = require('./inject');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
const PAGE = (name) => path.join(__dirname, `${name}.html`);

// Lecture automatique sans geste utilisateur (lecture enchaînée, thèmes musicaux)
// et décodage HEVC matériel lorsque le GPU le permet.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// La lecture ne doit jamais s'interrompre quand la fenêtre passe en arrière-plan,
// est réduite, masquée dans la zone de notification ou recouverte par une autre fenêtre.
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let win = null;
let tray = null;
let settingsWin = null;
let isQuitting = false;

const playback = new Playback(path.join(ROOT, 'build', 'thumbar'));
const mpv = new Mpv();
const discord = new DiscordPresence();

// ---------------------------------------------------------------- paramètres

const DEFAULT_SETTINGS = {
  mpvEnabled: true,
  mpvFullscreen: false,
  discordEnabled: false,
  discordAppId: '',
  autoUpdate: true,
  closeToTray: true,
  minimizeToTray: false,
};

function settings() {
  const saved = store.get('settings', {});
  // Anciennes options de la zone de notification (versions précédentes).
  const legacy = {};
  if (store.get('closeToTray') !== undefined) legacy.closeToTray = store.get('closeToTray');
  if (store.get('minimizeToTray') !== undefined) legacy.minimizeToTray = store.get('minimizeToTray');
  return { ...DEFAULT_SETTINGS, ...legacy, ...saved };
}

function updateSettings(patch) {
  const before = settings();
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    clean[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!v : String(v).trim().slice(0, 40);
  }
  const after = { ...before, ...clean };
  store.set('settings', after);
  if ('closeToTray' in clean) store.set('closeToTray', after.closeToTray);
  if ('minimizeToTray' in clean) store.set('minimizeToTray', after.minimizeToTray);
  applySettings(before, after);
  return after;
}

function applySettings(before, after) {
  discord.configure({ enabled: after.discordEnabled, clientId: after.discordAppId });
  discord.update(playback.state);
  updateTrayMenu();
  // Le lecteur mpv est déclaré au chargement du client web : recharger pour l'appliquer.
  if (before && before.mpvEnabled !== after.mpvEnabled && win && isServerPage()) {
    mpv.kill();
    win.webContents.reload();
  }
}

function mpvActive() {
  return settings().mpvEnabled && Mpv.available();
}

// ---------------------------------------------------------------- fenêtre

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  // Le clic sur l'icône retire le focus de la fenêtre : on ne peut donc pas s'y fier.
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function hideToTray() {
  win.hide();
  if (!store.get('trayHintShown', false) && tray) {
    store.set('trayHintShown', true);
    tray.displayBalloon({
      iconType: 'info',
      title: 'Jellyfin Desktop',
      content: 'L\'application continue en arrière-plan. Cliquez sur l\'icône pour la rouvrir.',
    });
  }
}

function savedBounds() {
  const b = store.get('window', { width: 1280, height: 800 });
  if (b.x !== undefined && b.y !== undefined) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
    if (!visible) {
      delete b.x;
      delete b.y;
    }
  }
  return b;
}

function nativeHandle() {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

function createWindow() {
  const bounds = savedBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Jellyfin',
    icon: ICON,
    backgroundColor: '#101010',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // La page reste « visible » pour le client web même fenêtre réduite ou masquée :
      // pas de pause automatique ni de ralentissement en arrière-plan.
      backgroundThrottling: false,
    },
  });

  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  playback.attach(win);

  win.on('close', (event) => {
    store.set('window', { ...win.getNormalBounds(), maximized: win.isMaximized() });
    if (!isQuitting && tray && settings().closeToTray) {
      event.preventDefault();
      // Une vidéo ne continue pas en arrière-plan une fois la fenêtre fermée
      // (la musique, elle, continue : c'est l'intérêt de la zone de notification).
      if (playback.state.active && playback.state.mediaType === 'Video') playback.command('stop');
      mpv.stop().catch(() => {});
      hideToTray();
    }
  });
  win.on('minimize', () => {
    if (tray && settings().minimizeToTray) hideToTray();
  });
  win.on('closed', () => { win = null; });

  // Boutons « précédent / suivant » de la souris.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    if (cmd === 'browser-forward') goForward();
  });

  const wc = win.webContents;

  // Liens externes (IMDb, TMDB, documentation…) → navigateur par défaut.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('did-navigate', () => {
    playback.reset();
    mpv.stop().catch(() => {});
  });

  // Plantage de la page (processus de rendu) : sinon la fenêtre resterait noire.
  // On recharge automatiquement ; au-delà de 3 plantages en une minute, retour à l'écran
  // de connexion pour éviter une boucle.
  let crashes = [];
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    playback.reset();
    mpv.stop().catch(() => {});
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60000);
    crashes.push(now);
    if (crashes.length > 3) {
      showConnect(`La page Jellyfin a planté plusieurs fois (${details.reason}). Reconnectez-vous au serveur.`);
      return;
    }
    const cur = servers.current();
    if (cur) loadServer(cur);
    else showConnect();
  });

  // Serveur injoignable → écran de reconnexion automatique ; certificat refusé → écran de connexion.
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */ || url.startsWith('file:')) return;
    if (code <= -200 && code > -300) {
      showConnect(`Impossible de charger ${url} (${desc}). Le certificat a peut-être changé : `
        + 'cliquez sur le serveur pour le vérifier à nouveau.');
      return;
    }
    showOffline(desc);
  });

  const current = servers.current();
  if (current) loadServer(current);
  else showConnect();
}

// ---------------------------------------------------------------- navigation

let offline = null; // { url, timer, attempt }

function stopOfflineRetry() {
  if (offline) clearTimeout(offline.timer);
  offline = null;
}

function showConnect(error) {
  if (!win) return;
  stopOfflineRetry();
  win.loadFile(PAGE('connect'), error ? { query: { error } } : undefined);
}

function loadServer(url) {
  if (!win) return;
  stopOfflineRetry();
  win.loadURL(url + '/web/index.html');
  updateTrayMenu();
}

// Reconnexion automatique : on sonde le serveur toutes les 10 s et on recharge dès qu'il répond.
const RETRY_DELAY = 10;

function showOffline(reason) {
  const server = servers.currentServer();
  if (!win || !server) {
    showConnect(reason);
    return;
  }
  stopOfflineRetry();
  offline = { url: server.url, attempt: 0, timer: null };
  win.loadFile(PAGE('offline'), { query: { name: server.name || server.url, url: server.url, reason: reason || '' } });
  scheduleRetry(RETRY_DELAY);
}

function sendOfflineStatus(status) {
  if (win && !win.isDestroyed()) win.webContents.send('offline:status', status);
}

function scheduleRetry(seconds) {
  if (!offline) return;
  clearTimeout(offline.timer);
  const state = offline;
  let left = seconds;
  const tick = () => {
    if (offline !== state) return;
    sendOfflineStatus({ attempt: state.attempt, nextRetryIn: left, checking: false });
    if (left <= 0) { retryNow(); return; }
    left -= 1;
    state.timer = setTimeout(tick, 1000);
  };
  tick();
}

async function retryNow() {
  if (!offline) return;
  const state = offline;
  clearTimeout(state.timer);
  state.attempt += 1;
  sendOfflineStatus({ attempt: state.attempt, checking: true });
  try {
    await servers.probe(state.url, { timeout: 5000 });
    if (offline === state) loadServer(state.url);
  } catch (err) {
    if (offline !== state) return;
    sendOfflineStatus({ attempt: state.attempt, checking: false, error: err.message });
    scheduleRetry(RETRY_DELAY);
  }
}

function goBack() {
  const h = win && win.webContents.navigationHistory;
  if (h && h.canGoBack()) h.goBack();
}

function goForward() {
  const h = win && win.webContents.navigationHistory;
  if (h && h.canGoForward()) h.goForward();
}

function isServerPage() {
  try {
    const cur = servers.current();
    return !!cur && new URL(win.webContents.getURL()).origin === new URL(cur).origin;
  } catch {
    return false;
  }
}

function senderIsLocalPage(event) {
  try {
    return new URL(event.senderFrame.url).protocol === 'file:';
  } catch {
    return false;
  }
}

// La page du serveur courant (cadre principal de la fenêtre principale) uniquement.
function senderIsServerPage(event) {
  try {
    const cur = servers.current();
    return !!cur && !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      && new URL(event.senderFrame.url).origin === new URL(cur).origin;
  } catch {
    return false;
  }
}

function isServerUrl(url) {
  try {
    const cur = servers.current();
    const u = new URL(url);
    return !!cur && (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === new URL(cur).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- paramètres (fenêtre)

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: win && win.isVisible() ? win : undefined,
    title: 'Paramètres — Jellyfin Desktop',
    icon: ICON,
    backgroundColor: '#101010',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(PAGE('settings'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- zone de notification

function updateTrayMenu() {
  if (!tray) return;
  const s = playback.state;
  const nowPlaying = s.active
    ? [s.seriesName || s.title, s.seriesName ? s.title : s.artist].filter(Boolean).join(' — ')
    : '';
  tray.setToolTip(nowPlaying ? `Jellyfin — ${s.paused ? '⏸' : '▶'} ${nowPlaying}`.slice(0, 127) : 'Jellyfin Desktop');

  const current = servers.current();
  const serverItems = servers.list().map((srv) => ({
    label: srv.name && srv.name !== srv.url ? `${srv.name}  (${srv.url.replace(/^https?:\/\//, '')})` : srv.url,
    type: 'radio',
    checked: srv.url === current,
    click: () => {
      servers.select(srv.url);
      showWindow();
      loadServer(srv.url);
    },
  }));

  const opts = settings();
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(nowPlaying ? [{ label: nowPlaying.length > 60 ? nowPlaying.slice(0, 59) + '…' : nowPlaying, enabled: false }] : []),
    { label: s.active && !s.paused ? '⏸  Pause' : '▶  Lecture', enabled: s.active, click: () => playback.command('playpause') },
    { label: '⏮  Précédent', enabled: s.active, click: () => playback.command('previous') },
    { label: '⏭  Suivant', enabled: s.active, click: () => playback.command('next') },
    { label: '⏹  Arrêter', enabled: s.active, click: () => playback.command('stop') },
    { type: 'separator' },
    { label: 'Afficher Jellyfin', click: showWindow },
    { label: 'Masquer', click: () => win && win.hide() },
    { type: 'separator' },
    {
      label: 'Serveurs',
      submenu: [
        ...serverItems,
        ...(serverItems.length ? [{ type: 'separator' }] : []),
        { label: 'Ajouter ou gérer les serveurs…', click: () => { showWindow(); showConnect(); } },
      ],
    },
    { label: 'Paramètres…', click: openSettings },
    { type: 'separator' },
    {
      label: 'Réduire dans la zone de notification',
      type: 'checkbox',
      checked: opts.minimizeToTray,
      click: (item) => updateSettings({ minimizeToTray: item.checked }),
    },
    {
      label: 'Fermer dans la zone de notification',
      type: 'checkbox',
      checked: opts.closeToTray,
      click: (item) => updateSettings({ closeToTray: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip('Jellyfin Desktop');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

playback.on('change', (state, changed) => {
  if (changed) updateTrayMenu();
  discord.update(state);
});

// ---------------------------------------------------------------- menu de l'application

function buildMenu() {
  const template = [
    {
      label: 'Jellyfin',
      submenu: [
        { label: 'Changer de serveur…', accelerator: 'CmdOrCtrl+Shift+S', click: () => showConnect() },
        { label: 'Accueil', accelerator: 'Alt+Home', click: () => { const cur = servers.current(); if (cur) loadServer(cur); } },
        { label: 'Paramètres…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { label: 'Quitter', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Précédent', accelerator: 'Alt+Left', click: goBack },
        { label: 'Suivant', accelerator: 'Alt+Right', click: goForward },
        { role: 'reload', label: 'Recharger', accelerator: 'F5' },
        { role: 'forceReload', label: 'Recharger (sans cache)' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran', accelerator: 'F11' },
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        { label: 'Documentation Jellyfin', click: () => shell.openExternal('https://jellyfin.org/docs/') },
        { label: 'Rechercher des mises à jour', click: () => { openSettings(); updater.check(); } },
        { label: `Jellyfin Desktop ${app.getVersion()} — Electron ${process.versions.electron}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- mpv

let mpvAutoFullscreen = false;
let mpvWantsFullscreen = false;

function sendMpvEvent(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('mpv:event', ev);
}

mpv.on('started', () => {
  sendMpvEvent({ type: 'started' });
  if (mpvWantsFullscreen && settings().mpvFullscreen && win && !win.isFullScreen()) {
    mpvAutoFullscreen = true;
    win.setFullScreen(true);
  }
});
mpv.on('time', (e) => sendMpvEvent({ type: 'time', position: e.position, duration: e.duration }));
mpv.on('pause', (e) => sendMpvEvent({ type: 'pause', paused: e.paused }));
mpv.on('volume', (e) => sendMpvEvent({ type: 'volume', volume: e.volume, muted: e.muted }));
mpv.on('error', (e) => sendMpvEvent({ type: 'error', message: e.message }));
mpv.on('ended', (e) => {
  sendMpvEvent({ type: 'ended', reason: e.reason });
  // Laisse le temps à l'épisode suivant de démarrer avant de quitter le plein écran.
  setTimeout(() => {
    if (!mpv.playing && mpvAutoFullscreen && win) {
      mpvAutoFullscreen = false;
      win.setFullScreen(false);
    }
  }, 3000);
});
mpv.on('message', ({ args }) => {
  switch (args[0]) {
    case 'jfd-fullscreen':
      if (win) win.setFullScreen(!win.isFullScreen());
      mpvAutoFullscreen = false;
      break;
    case 'jfd-escape':
      if (win && win.isFullScreen()) {
        win.setFullScreen(false);
        mpvAutoFullscreen = false;
      } else {
        mpv.stop().catch(() => {});
      }
      break;
    case 'jfd-next': sendMpvEvent({ type: 'next' }); break;
    case 'jfd-previous': sendMpvEvent({ type: 'previous' }); break;
    default: break;
  }
});

const MPV_PROPERTIES = {
  pause: (v) => !!v,
  volume: (v) => Math.max(0, Math.min(100, Number(v) || 0)),
  mute: (v) => !!v,
  speed: (v) => Math.max(0.25, Math.min(4, Number(v) || 1)),
  aid: (v) => (v === 'no' ? 'no' : Math.max(1, Math.floor(Number(v) || 1))),
  sid: (v) => (v === 'no' ? 'no' : Math.max(1, Math.floor(Number(v) || 1))),
  'sub-delay': (v) => Math.max(-600, Math.min(600, Number(v) || 0)),
};

ipcMain.handle('mpv:play', async (e, o) => {
  if (!senderIsServerPage(e) || !mpvActive() || !o || !isServerUrl(o.url)) throw new Error('Refusé');
  if (o.subUrl && !isServerUrl(o.subUrl)) throw new Error('Refusé');
  const track = (v) => (v === 'no' ? 'no' : (Number.isInteger(v) && v > 0 ? v : undefined));
  mpvWantsFullscreen = !!o.fullscreen;
  await mpv.play(nativeHandle(), {
    url: o.url,
    start: Number(o.start) || 0,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : 'Jellyfin',
    aid: track(o.aid),
    sid: track(o.sid),
    subUrl: o.subUrl || undefined,
    volume: typeof o.volume === 'number' ? Math.max(0, Math.min(100, o.volume)) : undefined,
    muted: typeof o.muted === 'boolean' ? o.muted : undefined,
  });
});

ipcMain.handle('mpv:command', async (e, name, value) => {
  if (!senderIsServerPage(e)) return;
  if (name === 'seek') {
    await mpv.command('seek', Math.max(0, Number(value) || 0), 'absolute');
  } else if (name === 'sub-add') {
    if (isServerUrl(value)) await mpv.command('sub-add', value, 'select');
  } else if (MPV_PROPERTIES[name]) {
    await mpv.set(name, MPV_PROPERTIES[name](value));
  }
});

ipcMain.handle('mpv:stop', async (e) => {
  if (!senderIsServerPage(e)) return;
  await mpv.stop();
});

// ---------------------------------------------------------------- IPC : page du serveur

ipcMain.on('host:boot', (e) => {
  if (!senderIsServerPage(e)) {
    e.returnValue = null;
    return;
  }
  e.returnValue = {
    inject: inject.toString(),
    info: { version: app.getVersion(), deviceName: os.hostname(), mpv: mpvActive() },
  };
});

ipcMain.on('host:state', (e, state) => {
  if (senderIsServerPage(e)) playback.update(state);
});

ipcMain.on('host:fullscreen', (e, on) => {
  if (senderIsServerPage(e) && win) win.setFullScreen(!!on);
});

ipcMain.on('host:select-server', (e) => {
  if (senderIsServerPage(e)) showConnect();
});

// ---------------------------------------------------------------- IPC : pages locales

ipcMain.handle('servers:list', (e) => {
  if (!senderIsLocalPage(e)) return null;
  return { servers: servers.list(), current: servers.current() };
});

ipcMain.handle('servers:discover', async (e) => {
  if (!senderIsLocalPage(e)) return [];
  return servers.discover();
});

ipcMain.handle('servers:connect', async (e, input) => {
  if (!senderIsLocalPage(e)) return { ok: false, error: 'Non autorisé' };
  try {
    const server = await servers.testServer(input);
    servers.remember(server);
    loadServer(server.url);
    return { ok: true, server };
  } catch (err) {
    return { ok: false, error: err.message, certificate: err.certificate };
  }
});

ipcMain.handle('servers:trust', (e, host, fingerprint) => {
  if (!senderIsLocalPage(e)) return false;
  return servers.trustCertificate(host, fingerprint);
});

ipcMain.handle('servers:remove', (e, url) => {
  if (!senderIsLocalPage(e)) return null;
  const list = servers.forget(url);
  updateTrayMenu();
  return list;
});

ipcMain.handle('offline:retry', (e) => {
  if (senderIsLocalPage(e)) retryNow();
});

ipcMain.handle('offline:connect-page', (e) => {
  if (senderIsLocalPage(e)) showConnect();
});

ipcMain.handle('settings:get', (e) => {
  if (!senderIsLocalPage(e)) return null;
  return {
    settings: settings(),
    mpvAvailable: Mpv.available(),
    version: app.getVersion(),
    updates: updater.getState(),
  };
});

ipcMain.handle('settings:set', (e, patch) => {
  if (!senderIsLocalPage(e)) return null;
  return updateSettings(patch);
});

ipcMain.handle('updates:check', (e) => {
  if (senderIsLocalPage(e)) updater.check();
});

ipcMain.handle('updates:install', (e) => {
  if (senderIsLocalPage(e)) {
    isQuitting = true;
    updater.install();
  }
});

ipcMain.handle('app:open-external', (e, url) => {
  if (senderIsLocalPage(e) && /^https:\/\/(discord\.com|github\.com)\//.test(String(url))) shell.openExternal(url);
});

updater.onChange((status) => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('updates:status', updater.getState());
  void status;
});

// ---------------------------------------------------------------- cycle de vie

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    mpv.kill();
    discord.dispose();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('local.jellyfin.desktop');
    buildMenu();
    createWindow();
    createTray();
    applySettings(null, settings());
    updater.setup(() => win);
  });

  app.on('window-all-closed', () => app.quit());
}
