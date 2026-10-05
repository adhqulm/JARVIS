// The music player. Songs play in YouTube's own embedded player (loaded from youtube.com), radio plays in an <audio>
// element. Volume is "user volume" times a duck factor, so the music gets out of the way while people talk.

const YT_API = 'https://www.youtube.com/iframe_api';
let ytReady = null;
const loadYT = () =>
  (ytReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => (prev?.(), resolve(window.YT));
    const s = document.createElement('script');
    s.src = YT_API;
    s.onerror = () => ((ytReady = null), reject(new Error('YouTube could not be reached')));
    document.head.appendChild(s);
  }));

export class Music {
  constructor({ host, store, onChange = () => {}, onNotice = () => {} }) {
    this.host = host; // element that holds the small YouTube player
    this.store = store;
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.queue = [];
    this.i = -1;
    this.playing = false;
    this.ducked = false;
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.addEventListener('ended', () => this.next(true));
    this.audio.addEventListener('error', () => this.failed());
    this.yt = null;
    this.ytHolder = null;
    this.failures = 0;
  }

  get current() {
    return this.queue[this.i] || null;
  }
  get volume() {
    const v = Number(this.store.musicVolume);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 60;
  }
  set volume(v) {
    this.store.musicVolume = String(Math.round(Math.min(100, Math.max(0, v))));
    this.applyVolume();
    this.onChange();
  }
  applyVolume() {
    const eff = this.volume * (this.ducked ? 0.15 : 1);
    this.audio.volume = eff / 100;
    try {
      this.yt?.setVolume?.(Math.round(eff));
    } catch {
      /* player not ready */
    }
  }
  duck(on) {
    if (this.ducked === on) return;
    this.ducked = on;
    this.applyVolume();
  }

  async start(queue) {
    this.stopSources();
    this.queue = (Array.isArray(queue) ? queue : []).filter((x) => x && (x.kind === 'radio' ? /^https:/.test(x.url || '') : /^[\w-]{11}$/.test(x.id || ''))).slice(0, 12);
    this.i = this.queue.length ? 0 : -1;
    this.failures = 0;
    if (this.i < 0) return false;
    await this.playCurrent();
    return true;
  }

  async playCurrent() {
    const it = this.current;
    if (!it) return this.stop();
    this.stopSources();
    this.playing = true;
    this.onChange();
    try {
      if (it.kind === 'radio') {
        this.audio.src = it.url;
        this.applyVolume();
        await this.audio.play();
      } else {
        const YT = await loadYT();
        if (!this.yt) {
          this.ytHolder = document.createElement('div');
          this.host.appendChild(this.ytHolder);
          await new Promise((resolve) => {
            this.yt = new YT.Player(this.ytHolder, {
              width: 200,
              height: 200,
              playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, origin: location.origin },
              events: {
                onReady: resolve,
                onStateChange: (e) => {
                  if (e.data === 0) this.next(true); // ended
                  if (e.data === 1) {
                    this.playing = true;
                    this.failures = 0;
                    this.onChange();
                  }
                },
                onError: () => this.failed(),
              },
            });
          });
        }
        this.yt.loadVideoById(it.id);
        this.applyVolume();
      }
    } catch (e) {
      if (e?.name === 'NotAllowedError') {
        this.playing = false;
        this.onNotice('The browser blocked sound until you tap the page once. Tap, then ask again.');
        this.onChange();
        return;
      }
      this.failed(e);
    }
  }

  failed(e) {
    // A video that can't be embedded or a dead station: try the next one, give up after a few in a row.
    if (++this.failures >= 3 || this.i >= this.queue.length - 1) {
      this.onNotice(e?.message || "That one wouldn't play.");
      return this.stop();
    }
    this.i++;
    this.playCurrent();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.i >= this.queue.length - 1) {
      if (auto) return this.stop();
      this.onNotice('That was the last one in the queue.');
      return;
    }
    this.i++;
    this.playCurrent();
  }
  previous() {
    if (this.i > 0) {
      this.i--;
      this.playCurrent();
    }
  }
  pause() {
    if (!this.current) return;
    this.audio.pause();
    try {
      this.yt?.pauseVideo?.();
    } catch {
      /* ignore */
    }
    this.playing = false;
    this.onChange();
  }
  resume() {
    const it = this.current;
    if (!it) return;
    if (it.kind === 'radio') this.audio.play().catch(() => {});
    else {
      try {
        this.yt?.playVideo?.();
      } catch {
        /* ignore */
      }
    }
    this.playing = true;
    this.onChange();
  }
  stopSources() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.yt?.stopVideo?.();
    } catch {
      /* ignore */
    }
  }
  stop() {
    this.stopSources();
    this.queue = [];
    this.i = -1;
    this.playing = false;
    this.onChange();
  }

  /** Voice or tool commands. */
  control(action, level) {
    switch (action) {
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'next': return this.next();
      case 'previous': return this.previous();
      case 'stop': return this.stop();
      case 'louder': this.volume = this.volume + 20; return;
      case 'quieter': this.volume = this.volume - 20; return;
      case 'volume': if (Number.isFinite(Number(level))) this.volume = Number(level); return;
    }
  }
}
