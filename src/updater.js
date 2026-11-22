// Mises à jour automatiques via les versions publiées sur GitHub (electron-updater).
// Seule la version installée (NSIS) peut se mettre à jour ; la version portable
// signale simplement qu'une nouvelle version existe.
const { app, dialog, shell, Notification } = require('electron');
const store = require('./store');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const state = { status: 'idle', version: null, error: null, progress: 0 };
let listeners = [];
let releasesUrl = null;

function emit() {
  for (const cb of listeners) cb({ ...state });
}

function onChange(cb) {
  listeners.push(cb);
}

function setup(getWindow) {
  if (!autoUpdater || !app.isPackaged) return;
  try {
    const pkg = require('../package.json');
    const pub = [].concat((pkg.build && pkg.build.publish) || [])[0];
    if (pub && pub.owner && pub.repo) releasesUrl = `https://github.com/${pub.owner}/${pub.repo}/releases/latest`;
  } catch { /* */ }

  autoUpdater.autoDownload = !isPortable;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => { Object.assign(state, { status: 'checking', error: null }); emit(); });
  autoUpdater.on('update-not-available', () => { Object.assign(state, { status: 'uptodate' }); emit(); });
  autoUpdater.on('error', (err) => { Object.assign(state, { status: 'error', error: err ? err.message : 'Erreur' }); emit(); });
  autoUpdater.on('download-progress', (p) => { Object.assign(state, { status: 'downloading', progress: Math.round(p.percent || 0) }); emit(); });
  autoUpdater.on('update-available', (info) => {
    Object.assign(state, { status: isPortable ? 'available' : 'downloading', version: info.version, progress: 0 });
    emit();
    if (isPortable && Notification.isSupported()) {
      const n = new Notification({
        title: 'Jellyfin Desktop',
        body: `La version ${info.version} est disponible. Cliquez pour la télécharger.`,
      });
      n.on('click', () => releasesUrl && shell.openExternal(releasesUrl));
      n.show();
    }
  });
  autoUpdater.on('update-downloaded', async (info) => {
    Object.assign(state, { status: 'ready', version: info.version, progress: 100 });
    emit();
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: 'Mise à jour disponible',
      message: `Jellyfin Desktop ${info.version} est prêt à être installé.`,
      detail: 'Redémarrer maintenant pour l\'installer ? Sinon, elle sera installée à la fermeture de l\'application.',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) install();
  });

  if (releasesUrl && store.get('settings', {}).autoUpdate !== false) {
    setTimeout(check, 10000);
    setInterval(check, 6 * 60 * 60 * 1000);
  }
}

function check() {
  if (!autoUpdater || !app.isPackaged) {
    Object.assign(state, { status: 'unavailable', error: 'Les mises à jour ne fonctionnent que dans la version installée.' });
    emit();
    return;
  }
  if (!releasesUrl) {
    Object.assign(state, { status: 'unavailable', error: 'Mises à jour non configurées (aucun dépôt de publication).' });
    emit();
    return;
  }
  autoUpdater.checkForUpdates().catch(() => {});
}

function install() {
  if (!autoUpdater) return;
  app.isQuittingForUpdate = true;
  autoUpdater.quitAndInstall(false, true);
}

function getState() {
  return { ...state, portable: isPortable, packaged: app.isPackaged, releasesUrl };
}

module.exports = { setup, check, install, getState, onChange };
