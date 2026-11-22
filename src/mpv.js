// Lecteur mpv intégré : mpv est lancé avec --wid pour s'afficher DANS la fenêtre de
// l'application, et piloté par son interface JSON (canal nommé Windows).
// Événements émis : 'started', 'time' {position, duration}, 'pause' {paused},
// 'volume' {volume, muted}, 'ended' {reason}, 'error' {message}, 'message' {args}.
const { app } = require('electron');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

function resourcePath(...parts) {
  // En développement : dossier du projet ; empaqueté : dossier resources.
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

const MPV_EXE = () => resourcePath(app.isPackaged ? 'mpv' : 'vendor/mpv', 'mpv.exe');
const MPV_CONFIG = () => resourcePath(app.isPackaged ? 'mpv-config' : 'mpv-config');

class Mpv extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.ready = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.loading = false; // un loadfile remplace le fichier courant
    this.playing = false;
    this.idleTimer = null;
  }

  static available() {
    return process.platform === 'win32' && fs.existsSync(MPV_EXE());
  }

  // Démarre mpv si nécessaire, intégré à la fenêtre parentHwnd.
  ensure(parentHwnd) {
    if (this.ready) return this.ready;
    const pipe = `\\\\.\\pipe\\jellyfin-desktop-mpv-${process.pid}-${Date.now()}`;
    const args = [
      `--wid=${parentHwnd}`,
      `--input-ipc-server=${pipe}`,
      `--config-dir=${MPV_CONFIG()}`,
      '--config=yes',
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=no',
      '--terminal=no',
      '--osc=yes',
      '--input-default-bindings=yes',
      '--input-vo-keyboard=yes',
      '--hwdec=auto-safe',
      '--sub-auto=no',
      '--audio-file-auto=no',
      '--ytdl=no',
      '--cache=yes',
      '--demuxer-max-bytes=200MiB',
    ];
    this.proc = spawn(MPV_EXE(), args, { stdio: 'ignore', windowsHide: true });
    this.proc.on('exit', () => this._onExit());
    this.proc.on('error', (err) => {
      this.emit('error', { message: `Impossible de lancer mpv : ${err.message}` });
      this._onExit();
    });

    this.ready = this._connect(pipe).then(() => {
      for (const [id, prop] of [[1, 'time-pos'], [2, 'duration'], [3, 'pause'], [4, 'volume'], [5, 'mute']]) {
        this._send(['observe_property', id, prop]);
      }
    });
    this.ready.catch(() => this.kill());
    return this.ready;
  }

  _connect(pipe, attempts = 50) {
    return new Promise((resolve, reject) => {
      const tryOnce = (left) => {
        const sock = net.connect(pipe);
        sock.once('connect', () => {
          this.sock = sock;
          sock.setEncoding('utf8');
          sock.on('data', (d) => this._onData(d));
          sock.on('close', () => { this.sock = null; });
          sock.on('error', () => {});
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (left <= 0 || !this.proc) reject(new Error('Connexion à mpv impossible'));
          else setTimeout(() => tryOnce(left - 1), 100);
        });
      };
      tryOnce(attempts);
    });
  }

  _send(command) {
    if (!this.sock) return Promise.reject(new Error('mpv non connecté'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ command, request_id: id }) + '\n');
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error === 'success') p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else if (msg.event) {
        this._onEvent(msg);
      }
    }
  }

  _onEvent(ev) {
    switch (ev.event) {
      case 'property-change':
        if (ev.name === 'time-pos' && typeof ev.data === 'number') this.position = ev.data;
        if (ev.name === 'duration' && typeof ev.data === 'number') this.duration = ev.data;
        if (ev.name === 'time-pos') this.emit('time', { position: this.position || 0, duration: this.duration || null });
        if (ev.name === 'pause') this.emit('pause', { paused: !!ev.data });
        if (ev.name === 'volume' || ev.name === 'mute') {
          if (ev.name === 'volume') this.volume = ev.data;
          if (ev.name === 'mute') this.muted = !!ev.data;
          this.emit('volume', { volume: this.volume, muted: this.muted });
        }
        break;
      case 'file-loaded':
        this.playing = true;
        this.emit('started');
        break;
      case 'end-file':
        if (this.loading && ev.reason === 'stop') break; // fichier remplacé par un loadfile
        if (!this.playing) break;
        this.playing = false;
        if (ev.reason === 'error') this.emit('error', { message: ev.file_error || 'Lecture impossible' });
        this.emit('ended', { reason: ev.reason });
        this._scheduleIdleQuit();
        break;
      case 'start-file':
        this.loading = false;
        break;
      case 'client-message':
        this.emit('message', { args: ev.args || [] });
        break;
      default:
        break;
    }
  }

  // Après la fin d'un fichier, garde mpv quelques secondes pour enchaîner l'épisode suivant
  // sans faire clignoter la fenêtre, puis le ferme.
  _scheduleIdleQuit() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.playing) this.kill(); }, 2500);
  }

  async play(parentHwnd, { url, start = 0, title, aid, sid, subUrl, volume, muted }) {
    clearTimeout(this.idleTimer);
    await this.ensure(parentHwnd);
    this.position = 0;
    this.duration = null;
    this.loading = this.playing;
    const opts = [`start=${Math.max(0, Number(start) || 0)}`];
    if (aid !== undefined) opts.push(`aid=${aid}`);
    if (sid !== undefined) opts.push(`sid=${sid}`);
    if (title) opts.push(`force-media-title=${String(title).replace(/[,"\\]/g, ' ')}`);
    if (typeof volume === 'number') await this.set('volume', volume).catch(() => {});
    if (typeof muted === 'boolean') await this.set('mute', muted).catch(() => {});
    await this._send(['loadfile', url, 'replace', -1, opts.join(',')]);
    if (subUrl) {
      this.once('started', () => this._send(['sub-add', subUrl, 'select']).catch(() => {}));
    }
  }

  set(name, value) {
    return this._send(['set_property', name, value]);
  }

  command(...args) {
    return this._send(args);
  }

  stop() {
    if (!this.proc) return Promise.resolve();
    return this._send(['stop']).catch(() => this.kill());
  }

  kill() {
    clearTimeout(this.idleTimer);
    if (this.sock) { try { this.sock.destroy(); } catch { /* */ } }
    if (this.proc) { try { this.proc.kill(); } catch { /* */ } }
  }

  _onExit() {
    const wasPlaying = this.playing;
    this.proc = null;
    this.sock = null;
    this.ready = null;
    this.playing = false;
    this.loading = false;
    for (const p of this.pending.values()) p.reject(new Error('mpv fermé'));
    this.pending.clear();
    if (wasPlaying) this.emit('ended', { reason: 'quit' });
    this.emit('exit');
  }
}

module.exports = Mpv;
