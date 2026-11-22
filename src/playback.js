// État de lecture remonté par le client web (src/inject.js) et intégration à la barre
// des tâches Windows : boutons ⏮ ⏯ ⏭ dans l'aperçu de la fenêtre et barre de progression.
const { nativeImage } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

const EMPTY = Object.freeze({ active: false });

function str(v, max = 300) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Les données viennent de la page web : on ne garde que des champs typés.
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !raw.active) return EMPTY;
  return {
    active: true,
    paused: !!raw.paused,
    positionMs: Math.max(0, num(raw.positionMs) || 0),
    durationMs: Math.max(0, num(raw.durationMs) || 0),
    mediaType: raw.mediaType === 'Video' ? 'Video' : 'Audio',
    title: str(raw.title),
    artist: str(raw.artist),
    album: str(raw.album),
    seriesName: str(raw.seriesName),
    season: num(raw.season),
    episode: num(raw.episode),
    year: num(raw.year),
    itemId: str(raw.itemId, 64),
  };
}

class Playback extends EventEmitter {
  constructor(iconDir) {
    super();
    this.state = EMPTY;
    this.win = null;
    this.thumbarKey = '';
    const icon = (name) => nativeImage.createFromPath(path.join(iconDir, `${name}.png`));
    this.icons = { previous: icon('previous'), play: icon('play'), pause: icon('pause'), next: icon('next') };
  }

  attach(win) {
    this.win = win;
    // Windows retire les boutons quand la fenêtre est masquée : on les remet à l'affichage.
    win.on('show', () => { this.thumbarKey = ''; this.applyTaskbar(); });
  }

  update(raw) {
    const next = sanitize(raw);
    const prev = this.state;
    this.state = next;
    this.applyTaskbar();
    const changed = prev.active !== next.active || prev.paused !== next.paused
      || prev.itemId !== next.itemId || prev.title !== next.title;
    this.emit('change', next, changed);
  }

  reset() {
    this.update(EMPTY);
  }

  command(cmd) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('host:command', cmd);
  }

  applyTaskbar() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const s = this.state;

    if (s.active && s.durationMs > 0) {
      win.setProgressBar(Math.min(1, s.positionMs / s.durationMs), { mode: s.paused ? 'paused' : 'normal' });
    } else {
      win.setProgressBar(-1);
    }

    const key = s.active ? (s.paused ? 'paused' : 'playing') : 'none';
    if (key === this.thumbarKey) return;
    this.thumbarKey = key;
    if (!s.active) {
      win.setThumbarButtons([]);
      return;
    }
    win.setThumbarButtons([
      { tooltip: 'Précédent', icon: this.icons.previous, click: () => this.command('previous') },
      {
        tooltip: s.paused ? 'Lecture' : 'Pause',
        icon: s.paused ? this.icons.play : this.icons.pause,
        click: () => this.command('playpause'),
      },
      { tooltip: 'Suivant', icon: this.icons.next, click: () => this.command('next') },
    ]);
  }
}

module.exports = Playback;
