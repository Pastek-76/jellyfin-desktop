const api = window.jellyfinDesktop;
const $ = (id) => document.getElementById(id);
const TOGGLES = ['mpvEnabled', 'mpvFullscreen', 'discordEnabled', 'autoUpdate', 'closeToTray', 'minimizeToTray'];

let savedTimer = null;
function flashSaved(text = 'Enregistré') {
  const el = $('saved');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

async function save(patch, message) {
  await api.setSettings(patch);
  flashSaved(message);
}

function renderUpdate(u) {
  const status = $('update-status');
  const install = $('install');
  status.className = 'status';
  install.hidden = true;
  switch (u.status) {
    case 'checking': status.textContent = 'Recherche en cours…'; break;
    case 'uptodate': status.textContent = 'Vous avez la dernière version.'; status.classList.add('ok'); break;
    case 'downloading': status.textContent = `Téléchargement de la version ${u.version || ''}… ${u.progress || 0} %`; break;
    case 'available':
      status.textContent = `La version ${u.version} est disponible (version portable : téléchargez-la manuellement).`;
      break;
    case 'ready':
      status.textContent = `La version ${u.version} est prête.`;
      status.classList.add('ok');
      install.hidden = false;
      break;
    case 'error': status.textContent = `Erreur : ${u.error}`; status.classList.add('err'); break;
    case 'unavailable': status.textContent = u.error; break;
    default:
      status.textContent = u.packaged ? '' : 'Mode développement : mises à jour désactivées.';
  }
}

(async () => {
  const data = await api.getSettings();
  const s = data.settings;
  $('version').textContent = data.version;
  for (const id of TOGGLES) $(id).checked = !!s[id];
  $('discordAppId').value = s.discordAppId || '';

  if (!data.mpvAvailable) {
    $('mpvEnabled').checked = false;
    $('mpvEnabled').disabled = true;
    $('mpv-hint').textContent = 'mpv n\'est pas inclus dans cette version de l\'application.';
  }
  renderUpdate(data.updates);

  for (const id of TOGGLES) {
    $(id).addEventListener('change', () => {
      const msg = id === 'mpvEnabled' ? 'Enregistré — Jellyfin est rechargé' : undefined;
      save({ [id]: $(id).checked }, msg);
    });
  }

  const appId = $('discordAppId');
  appId.addEventListener('change', () => {
    const v = appId.value.trim();
    const valid = v === '' || /^\d{15,25}$/.test(v);
    appId.classList.toggle('invalid', !valid);
    if (valid) save({ discordAppId: v });
  });

  $('discord-portal').addEventListener('click', () => api.openExternal('https://discord.com/developers/applications'));
  $('check').addEventListener('click', () => api.checkUpdates());
  $('install').addEventListener('click', () => api.installUpdate());
  api.onUpdateStatus(renderUpdate);
})();
