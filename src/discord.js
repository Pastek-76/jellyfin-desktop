// Discord Rich Presence via l'IPC local de Discord (\\?\pipe\discord-ipc-N).
// Nécessite un « Application ID » créé par l'utilisateur sur discord.com/developers.
const net = require('net');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

class DiscordPresence {
  constructor({ pipeBase = '\\\\?\\pipe\\discord-ipc-' } = {}) {
    this.pipeBase = pipeBase;
    this.clientId = '';
    this.enabled = false;
    this.sock = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.retryTimer = null;
    this.lastKey = '';
    this.activity = null;
  }

  configure({ enabled, clientId }) {
    const changed = clientId !== this.clientId;
    this.enabled = !!enabled && /^\d{15,25}$/.test(clientId || '');
    this.clientId = clientId || '';
    if (!this.enabled || changed) this._disconnect();
    if (this.enabled) this._connect();
  }

  // state : état de lecture de l'application (voir playback.js) ou null.
  update(state) {
    let activity = null;
    if (state && state.active) {
      const video = state.mediaType === 'Video';
      let details = state.title || 'Jellyfin';
      let line = '';
      if (state.seriesName) {
        details = state.seriesName;
        const ep = state.season != null && state.episode != null
          ? `S${String(state.season).padStart(2, '0')}E${String(state.episode).padStart(2, '0')} · ` : '';
        line = ep + (state.title || '');
      } else if (!video) {
        line = [state.artist, state.album].filter(Boolean).join(' — ');
      } else if (state.year) {
        line = String(state.year);
      }
      activity = {
        type: video ? 3 : 2, // 3 = « Regarde », 2 = « Écoute »
        details: details.slice(0, 128),
        state: (state.paused ? '⏸ En pause' + (line ? ' · ' + line : '') : line || (video ? 'Vidéo' : 'Musique')).slice(0, 128),
        assets: { large_text: 'Jellyfin' },
        instance: false,
      };
      if (!state.paused && state.durationMs > 0) {
        const now = Date.now();
        const start = now - state.positionMs;
        activity.timestamps = { start: Math.round(start), end: Math.round(start + state.durationMs) };
      }
    }
    // N'envoie que les vrais changements (Discord limite à 5 mises à jour / 20 s).
    const key = JSON.stringify({ ...activity, timestamps: activity && activity.timestamps
      ? Math.round(activity.timestamps.start / 5000) : null });
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.activity = activity;
    this._sendActivity();
  }

  _connect(index = 0) {
    if (!this.enabled || this.sock) return;
    clearTimeout(this.retryTimer);
    const sock = net.connect(`${this.pipeBase}${index}`);
    sock.once('connect', () => {
      this.sock = sock;
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => this._onClose());
      sock.on('error', () => {});
      this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
    sock.once('error', () => {
      sock.destroy();
      if (index < 9) this._connect(index + 1);
      else this._scheduleRetry(); // Discord n'est pas lancé
    });
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.enabled) this.retryTimer = setTimeout(() => this._connect(), 20000);
  }

  _onClose() {
    this.sock = null;
    this.connected = false;
    this.lastKey = '';
    this._scheduleRetry();
  }

  _disconnect() {
    clearTimeout(this.retryTimer);
    if (this.sock) {
      try { this.sock.destroy(); } catch { /* */ }
    }
    this.sock = null;
    this.connected = false;
    this.lastKey = '';
  }

  _write(op, payload) {
    if (!this.sock) return;
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    this.sock.write(Buffer.concat([header, json]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(this.buffer.slice(8, 8 + len).toString('utf8')); } catch { /* */ }
      this.buffer = this.buffer.slice(8 + len);
      if (op === OP.PING) this._write(OP.PONG, msg);
      else if (op === OP.CLOSE) this._disconnect();
      else if (op === OP.FRAME && msg && msg.evt === 'READY') {
        this.connected = true;
        this._sendActivity();
      }
    }
  }

  _sendActivity() {
    if (!this.connected) return;
    this._write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.activity || undefined },
      nonce: crypto.randomUUID(),
    });
  }

  dispose() {
    this.enabled = false;
    this._disconnect();
  }
}

module.exports = DiscordPresence;
