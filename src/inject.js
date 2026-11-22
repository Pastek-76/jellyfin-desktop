// Code exécuté dans le « monde principal » de la page Jellyfin (client web du serveur),
// via contextBridge.executeInMainWorld depuis preload.js, AVANT les scripts de la page.
// La fonction est sérialisée : elle ne doit utiliser aucune variable extérieure.
//
// Elle fournit :
//  - window.NativeShell : l'interface officielle d'intégration des applications Jellyfin
//    (même mécanisme que Jellyfin Media Player), en reproduisant le comportement par
//    défaut du navigateur pour tout ce qui n'est pas spécifique à l'application ;
//  - un plugin « hôte » qui récupère le gestionnaire de lecture pour piloter la lecture
//    depuis l'icône, la barre des tâches et Discord, et remonter l'état de lecture ;
//  - un lecteur vidéo mpv (si activé), choisi en priorité pour les vidéos.
module.exports = function injectJellyfinDesktop(info) {
  const host = window.jellyfinDesktopHost;
  if (!host || window.NativeShell) return;

  // ------------------------------------------------------------ NativeShell
  // Fonctions supportées : identiques à Chrome (voir appHost du client web), sans
  // Chromecast (indisponible dans Electron).
  const features = [
    'filedownload', 'externallinks', 'htmlaudioautoplay', 'htmlvideoautoplay', 'fullscreenchange',
    'remotecontrol', 'remotevideo', 'displaylanguage', 'displaymode', 'targetblank', 'screensaver',
    'subtitleappearancesettings', 'subtitleburnsettings', 'fileinput',
  ];
  if (navigator.share) features.push('sharing');

  window.NativeShell = {
    AppHost: {
      init: () => Promise.resolve({ deviceName: info.deviceName }),
      supports: (command) => features.indexOf(String(command || '').toLowerCase()) !== -1,
      getDefaultLayout: () => 'modern',
      // Profil du navigateur (lecteurs HTML) : les codecs AC3/E-AC3 ne sont pas décodés par Chromium.
      getDeviceProfile: (profileBuilder) => profileBuilder({ enableMkvProgressive: false, disableHlsVideoAudioCodecs: ['ac3', 'eac3'] }),
      deviceName: () => info.deviceName,
      appName: () => 'Jellyfin Desktop',
      appVersion: () => info.version,
    },
    getPlugins: () => (info.mpv ? ['jellyfinDesktopHostPlugin', 'jellyfinDesktopMpvPlayer'] : ['jellyfinDesktopHostPlugin']),
    enableFullscreen: () => host.setFullscreen(true),
    disableFullscreen: () => host.setFullscreen(false),
    selectServer: () => host.selectServer(),
  };

  // ------------------------------------------------------------ plugin hôte
  let playbackManager = null;
  let events = null;
  let boundPlayer = null;
  let lastReport = 0;

  function report(force) {
    if (!playbackManager) return;
    const now = Date.now();
    if (!force && now - lastReport < 1000) return;
    lastReport = now;
    const player = playbackManager.getCurrentPlayer && playbackManager.getCurrentPlayer();
    const st = player && playbackManager.getPlayerState ? playbackManager.getPlayerState(player) : null;
    const item = st && st.NowPlayingItem;
    if (!item) {
      host.reportState({ active: false });
      return;
    }
    const ps = st.PlayState || {};
    host.reportState({
      active: true,
      paused: !!ps.IsPaused,
      positionMs: (ps.PositionTicks || 0) / 10000,
      durationMs: (item.RunTimeTicks || 0) / 10000,
      mediaType: item.MediaType,
      title: item.Name || '',
      artist: (item.Artists && item.Artists.join(', ')) || item.AlbumArtist || '',
      album: item.Album || '',
      seriesName: item.SeriesName || '',
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      year: item.ProductionYear,
      itemId: item.Id,
    });
  }

  function bindPlayer(player) {
    if (!events || player === boundPlayer) return;
    if (boundPlayer) {
      for (const name of ['pause', 'unpause', 'timeupdate', 'playing']) events.off(boundPlayer, name, onPlayerEvent);
    }
    boundPlayer = player;
    if (player) {
      for (const name of ['pause', 'unpause', 'timeupdate', 'playing']) events.on(player, name, onPlayerEvent);
    }
  }

  function onPlayerEvent(e) {
    report(e && e.type !== 'timeupdate');
  }

  host.onCommand((cmd) => {
    if (!playbackManager) return;
    const player = playbackManager.getCurrentPlayer && playbackManager.getCurrentPlayer();
    if (!player) return;
    switch (cmd) {
      case 'playpause': {
        const isPaused = playbackManager.paused ? playbackManager.paused(player) : player.paused();
        if (isPaused) playbackManager.unpause(player);
        else playbackManager.pause(player);
        break;
      }
      case 'next': playbackManager.nextTrack(player); break;
      case 'previous': playbackManager.previousTrack(player); break;
      case 'stop': playbackManager.stop(player); break;
      default: break;
    }
  });

  window.jellyfinDesktopHostPlugin = async () => class {
    constructor(deps) {
      this.name = 'Jellyfin Desktop';
      this.type = 'preplayintercept';
      this.id = 'jellyfindesktophost';
      this.priority = 1000;
      if (!playbackManager) {
        playbackManager = deps.playbackManager;
        events = deps.events;
        events.on(playbackManager, 'playbackstart', (e, player) => { bindPlayer(player); report(true); });
        events.on(playbackManager, 'playbackstop', () => { bindPlayer(null); report(true); });
        events.on(playbackManager, 'playerchange', () => {
          bindPlayer(playbackManager.getCurrentPlayer());
          report(true);
        });
      }
    }

    intercept() {
      return Promise.resolve();
    }
  };

  // ------------------------------------------------------------ lecteur mpv
  if (!info.mpv) return;
  const mpv = host.mpv;

  const SUB_FORMATS_EMBED = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'sub', 'smi', 'ttml', 'pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub', 'mov_text'];
  const SUB_FORMATS_EXTERNAL = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'sub', 'smi', 'ttml'];

  // mpv lit pratiquement tout : lecture directe de tous les conteneurs et codecs.
  const MPV_PROFILE = {
    Name: 'Jellyfin Desktop (mpv)',
    MaxStreamingBitrate: 200000000,
    MaxStaticBitrate: 1000000000,
    MusicStreamingTranscodingBitrate: 1280000,
    DirectPlayProfiles: [{ Type: 'Video' }, { Type: 'Audio' }],
    TranscodingProfiles: [
      {
        Container: 'ts', Type: 'Video', Protocol: 'hls', Context: 'Streaming',
        VideoCodec: 'h264,hevc,av1', AudioCodec: 'aac,mp3,ac3,eac3,opus,flac',
        MaxAudioChannels: '8', MinSegments: '1', BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    ResponseProfiles: [],
    SubtitleProfiles: [
      ...SUB_FORMATS_EMBED.map((f) => ({ Format: f, Method: 'Embed' })),
      ...SUB_FORMATS_EXTERNAL.map((f) => ({ Format: f, Method: 'External' })),
    ],
  };

  function absoluteUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    const api = window.ApiClient;
    const base = api && api.serverAddress ? api.serverAddress() : location.origin;
    return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
  }

  window.jellyfinDesktopMpvPlayer = async () => class MpvPlayer {
    constructor(deps) {
      this.events = deps.events;
      this.playbackManager = deps.playbackManager;
      this.name = 'mpv';
      this.type = 'mediaplayer';
      this.id = 'jellyfindesktopmpv';
      this.priority = -10; // avant le lecteur vidéo HTML
      this.isLocalPlayer = true;
      this._src = null;
      this._options = null;
      this._position = 0;
      this._duration = null;
      this._paused = false;
      this._volume = 100;
      this._muted = false;
      this._rate = 1;
      this._started = false;
      this._stopped = true;

      mpv.onEvent((ev) => this._onEvent(ev));
    }

    // ---- choix du lecteur
    canPlayMediaType(mediaType) {
      return String(mediaType || '').toLowerCase() === 'video';
    }

    canPlayItem(item) {
      return !!item && !item.IsPlaceHolder;
    }

    supportsPlayMethod() {
      return true;
    }

    getDeviceProfile() {
      return Promise.resolve(JSON.parse(JSON.stringify(MPV_PROFILE)));
    }

    supports(feature) {
      return ['PlaybackRate'].indexOf(feature) !== -1;
    }

    // ---- pistes : correspondance index Jellyfin → numéro de piste mpv
    _streams(type) {
      const ms = (this._options && this._options.mediaSource) || {};
      return (ms.MediaStreams || [])
        .filter((s) => s.Type === type && !s.IsExternal)
        .sort((a, b) => a.Index - b.Index);
    }

    _isDirect() {
      const m = this._options && this._options.playMethod;
      return m === 'DirectPlay' || m === 'DirectStream';
    }

    _audioTrack(index) {
      if (index == null || index < 0 || !this._isDirect()) return undefined;
      const pos = this._streams('Audio').findIndex((s) => s.Index === index);
      return pos >= 0 ? pos + 1 : undefined;
    }

    _subtitle(index) {
      if (index == null || index < 0) return { sid: 'no' };
      const ms = (this._options && this._options.mediaSource) || {};
      const stream = (ms.MediaStreams || []).find((s) => s.Type === 'Subtitle' && s.Index === index);
      if (!stream) return { sid: 'no' };
      if (stream.DeliveryMethod === 'External' && stream.DeliveryUrl) return { url: absoluteUrl(stream.DeliveryUrl) };
      if (stream.DeliveryMethod === 'Encode') return {}; // incrusté par le serveur
      if (!this._isDirect()) return {};
      const pos = this._streams('Subtitle').findIndex((s) => s.Index === index);
      return pos >= 0 ? { sid: pos + 1 } : { sid: 'no' };
    }

    // ---- lecture
    currentSrc() {
      return this._src;
    }

    play(options) {
      this._options = options;
      this._src = options.url;
      this._started = false;
      this._stopped = false;
      this._position = (options.playerStartPositionTicks || 0) / 1e7;
      const ms = options.mediaSource || {};
      const sub = this._subtitle(ms.DefaultSubtitleStreamIndex);
      const item = options.item || {};
      const title = item.SeriesName
        ? `${item.SeriesName} — ${item.Name || ''}`
        : (item.Name || 'Jellyfin');
      return mpv.play({
        url: options.url,
        start: this._position,
        title,
        aid: this._audioTrack(ms.DefaultAudioStreamIndex),
        sid: sub.sid,
        subUrl: sub.url,
        volume: this._volume,
        muted: this._muted,
        fullscreen: !!options.fullscreen,
      }).catch((err) => {
        this._stopped = true;
        this.events.trigger(this, 'error', [{ type: 'mediadecodeerror' }]);
        throw err;
      });
    }

    _onEvent(ev) {
      switch (ev.type) {
        case 'started':
          if (!this._started) {
            this._started = true;
            this.events.trigger(this, 'playing');
          }
          break;
        case 'time':
          this._position = ev.position;
          if (ev.duration) this._duration = ev.duration;
          this.events.trigger(this, 'timeupdate');
          break;
        case 'pause':
          if (this._paused !== ev.paused) {
            this._paused = ev.paused;
            this.events.trigger(this, ev.paused ? 'pause' : 'unpause');
          }
          break;
        case 'volume':
          this._volume = Math.round(ev.volume);
          this._muted = !!ev.muted;
          this.events.trigger(this, 'volumechange');
          break;
        case 'error':
          this.events.trigger(this, 'error', [{ type: 'mediadecodeerror' }]);
          break;
        case 'ended':
          this._onStopped();
          break;
        case 'next':
          this.playbackManager.nextTrack(this);
          break;
        case 'previous':
          this.playbackManager.previousTrack(this);
          break;
        default:
          break;
      }
    }

    _onStopped() {
      if (this._stopped) return;
      this._stopped = true;
      const src = this._src;
      this._src = null;
      this.events.trigger(this, 'stopped', [{ src }]);
    }

    stop(destroyPlayer) {
      const done = () => {
        this._onStopped();
        if (destroyPlayer) this.destroy();
      };
      return mpv.stop().then(done, done);
    }

    destroy() {
      mpv.stop().catch(() => {});
    }

    // ---- position
    currentTime(ms) {
      if (ms != null) {
        mpv.command('seek', ms / 1000);
        return undefined;
      }
      return this._position * 1000;
    }

    duration() {
      return this._duration ? this._duration * 1000 : null;
    }

    seekable() {
      return true;
    }

    getBufferedRanges() {
      return [];
    }

    // ---- pause
    pause() { mpv.command('pause', true); }

    unpause() { mpv.command('pause', false); }

    resume() { this.unpause(); }

    paused() { return this._paused; }

    // ---- vitesse
    setPlaybackRate(rate) {
      this._rate = rate;
      mpv.command('speed', rate);
    }

    getPlaybackRate() { return this._rate; }

    getSupportedPlaybackRates() {
      return [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((id) => ({ name: `${id}x`, id }));
    }

    // ---- volume
    setVolume(v) { mpv.command('volume', Math.max(0, Math.min(100, v))); }

    getVolume() { return this._volume; }

    volumeUp() { this.setVolume(this._volume + 2); }

    volumeDown() { this.setVolume(this._volume - 2); }

    setMute(m) { mpv.command('mute', !!m); }

    isMuted() { return this._muted; }

    // ---- pistes
    canSetAudioStreamIndex() {
      return this._isDirect();
    }

    setAudioStreamIndex(index) {
      const aid = this._audioTrack(index);
      if (aid !== undefined) mpv.command('aid', aid);
    }

    setSubtitleStreamIndex(index) {
      const sub = this._subtitle(index);
      if (sub.url) mpv.command('sub-add', sub.url);
      else if (sub.sid !== undefined) mpv.command('sid', sub.sid);
    }

    setSecondarySubtitleStreamIndex() {}

    resetSubtitleOffset() { mpv.command('sub-delay', 0); }

    setSubtitleOffset(offset) { mpv.command('sub-delay', Number(offset) || 0); }

    getSubtitleOffset() { return 0; }

    enableShowingSubtitleOffset() {}

    disableShowingSubtitleOffset() {}

    isShowingSubtitleOffsetEnabled() { return false; }

    // ---- divers (écran d'informations du client web)
    getStats() {
      return Promise.resolve({ categories: [] });
    }

    getSupportedAspectRatios() { return []; }

    getAspectRatio() { return 'auto'; }

    setAspectRatio() {}

    isPictureInPictureEnabled() { return false; }

    isAirPlayEnabled() { return false; }
  };
};
