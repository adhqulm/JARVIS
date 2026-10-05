/**
 * Plays the tutor's sentences in order.
 *
 * Each sentence's audio is requested as soon as it is enqueued, so the next one is usually ready when the
 * current one ends. The server answers in one of two ways:
 *   - audio/pcm: a live stream (low latency). We schedule each chunk in WebAudio as it arrives, so speech
 *     starts after the first ~120ms of audio instead of after the whole sentence is synthesized.
 *   - audio/mpeg: a complete clip (standard voice). Decoded in one go.
 * With no voice key the server answers 204 and we simulate speaking so the eyes still animate.
 */

/** Tiny async queue of binary chunks: push() from the network, await next() from playback. */
function chunkQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(x) {
      items.push(x);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    async next() {
      while (!items.length) {
        if (ended) return null;
        await new Promise((r) => (wake = r));
      }
      return items.shift();
    },
  };
}

const PREBUFFER_SECONDS = 0.12; // small jitter buffer before the first sound of each sentence

export class Speaker {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.queue = [];
    this.running = false;
    this.epoch = 0;
    this.sampler = null;
    this.current = null;
    this.endCurrent = null;
    this.pcmSources = new Set();
    this.waiters = [];
    this.fetchCtrl = new AbortController(); // aborted on stop() so queued voice requests are dropped
    this.onSentenceStart = () => {};
    this.onError = () => {};
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
      this.buf = new Uint8Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** 0..1 loudness of whatever is playing right now. */
  get level() {
    return this.sampler ? this.sampler() : 0;
  }

  enqueue(text) {
    const clean = String(text).replace(/[*_#`>~]/g, '').trim();
    if (!clean) return;
    this.ensure();
    this.queue.push(this.fetchAudio(clean, this.fetchCtrl.signal));
    this.pump();
  }

  /** Starts the request immediately and returns an item whose `ready` promise says how to play it. */
  fetchAudio(text, signal) {
    const item = { text, mode: null, rate: 24000, buffer: null, q: chunkQueue(), ready: null };
    item.ready = (async () => {
      try {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal,
        });
        if (r.status === 204) {
          item.mode = 'mock';
          return;
        }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `Voice failed (${r.status})`);
        }
        if ((r.headers.get('content-type') || '').includes('audio/pcm')) {
          item.mode = 'pcm';
          item.rate = Number(r.headers.get('x-sample-rate')) || 24000;
          (async () => {
            try {
              const reader = r.body.getReader();
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                item.q.push(value);
              }
            } catch (e) {
              if (e.name !== 'AbortError') this.onError(e.message);
            } finally {
              item.q.end();
            }
          })();
        } else {
          item.buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
          item.mode = 'buffer';
        }
      } catch (e) {
        if (e.name !== 'AbortError') this.onError(e.message);
        item.mode = 'mock';
        item.q.end();
      }
    })();
    return item;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    while (this.queue.length && epoch === this.epoch) {
      const item = this.queue.shift();
      await item.ready;
      if (epoch !== this.epoch) return;
      this.onSentenceStart(item.text);
      await this.play(item);
    }
    if (epoch === this.epoch) {
      this.running = false;
      this.sampler = null;
      this.flushWaiters();
    }
  }

  play(item) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.current = null;
        this.endCurrent = null;
        resolve();
      };
      this.endCurrent = finish;

      if (item.mode === 'pcm') return this.playPcm(item, finish, () => done);

      if (item.mode === 'buffer') {
        const src = this.ctx.createBufferSource();
        src.buffer = item.buffer;
        src.connect(this.analyser);
        src.onended = finish;
        this.current = src;
        this.sampler = this.analyserLevel;
        src.start();
        return;
      }

      // Simulated speech: ~60ms per character, wobbling level.
      this.sampler = () => 0.25 + 0.5 * Math.abs(Math.sin(performance.now() / 90));
      setTimeout(finish, Math.max(1200, item.text.length * 60));
    });
  }

  analyserLevel = () => {
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
  };

  /** Plays a live 16-bit mono PCM stream, scheduling each chunk back-to-back as it arrives. */
  playPcm(item, finish, isDone) {
    const ctx = this.ctx;
    const rate = item.rate;
    this.sampler = this.analyserLevel;

    let nextTime = 0;
    let lastSrc = null;
    let streamEnded = false;
    let started = false;
    let pending = [];
    let pendingSeconds = 0;
    let carry = null; // a chunk can end in the middle of a 2-byte sample

    const schedule = (floats) => {
      const buffer = ctx.createBuffer(1, floats.length, rate);
      buffer.copyToChannel(floats, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      const t = Math.max(ctx.currentTime + 0.03, nextTime);
      src.start(t);
      nextTime = t + buffer.duration;
      lastSrc = src;
      this.pcmSources.add(src);
      src.onended = () => {
        this.pcmSources.delete(src);
        if (streamEnded && src === lastSrc) finish();
      };
    };
    const startPlayback = () => {
      started = true;
      for (const f of pending) schedule(f);
      pending = [];
    };

    (async () => {
      for (;;) {
        const chunk = await item.q.next();
        if (isDone()) return;
        if (chunk === null) break;
        let bytes = chunk;
        if (carry) {
          bytes = new Uint8Array(carry.length + chunk.length);
          bytes.set(carry);
          bytes.set(chunk, carry.length);
          carry = null;
        }
        const usable = bytes.length - (bytes.length % 2);
        if (usable < bytes.length) carry = bytes.slice(usable);
        if (!usable) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
        const n = usable / 2;
        const floats = new Float32Array(n);
        for (let i = 0; i < n; i++) floats[i] = view.getInt16(i * 2, true) / 32768;

        if (started) schedule(floats);
        else {
          pending.push(floats);
          pendingSeconds += n / rate;
          if (pendingSeconds >= PREBUFFER_SECONDS) startPlayback();
        }
      }
      streamEnded = true;
      if (!started) startPlayback();
      if (!lastSrc || ctx.currentTime >= nextTime) finish();
    })();
  }

  stop() {
    this.fetchCtrl.abort();
    this.fetchCtrl = new AbortController();
    this.epoch++;
    this.queue = [];
    this.running = false;
    this.sampler = null;
    for (const s of this.pcmSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.pcmSources.clear();
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.endCurrent?.();
    this.flushWaiters();
  }

  drained() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((r) => r());
  }
}
