// Hands-free listening that works in any browser: the microphone is watched locally, and only when someone speaks is
// that short clip sent to ElevenLabs Scribe (through our server), which is then checked for the companion's name.
// Nothing is sent while the room is quiet, and nothing is recorded while the companion itself is talking.
// Same interface as WakeWord in wake.js.
//
// With a `detectorFactory` (see openwake.js) the wake word is spotted on this computer in real time: nothing is sent until
// the name has been heard, and a bare "Halcyon" never leaves the computer at all. Without one, every short clip of speech
// is transcribed and checked for the name instead (slower, and it costs a little speech credit).
import { transcribe } from './mic.js';

const CHUNK16 = 1280; // what the wake word model eats: 80 ms at 16 kHz
const NAME_ONLY_TAIL_MS = 500; // less speech than this after the wake word means only the name was said

const TARGET_RATE = 16000;
const PREROLL_MS = 300; // audio kept from just before the voice was noticed, so the first word isn't clipped
const START_MS = 120; // loud for this long = speech has begun
const END_SILENCE_MS = 650; // quiet for this long = the sentence is over
const MIN_VOICED_MS = 350; // shorter than this is a cough or a door, not speech
const MAX_CLIP_MS = 12000;
const BUDGET = { clips: 16, perMs: 5 * 60 * 1000, pauseMs: 2 * 60 * 1000 }; // a noisy room (TV) must not run up the bill

function wav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function downsample(chunks, from, to) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) (all.set(c, o), (o += c.length));
  if (from <= to) return { data: all, rate: from };
  const ratio = from / to;
  const out = new Float32Array(Math.floor(all.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    out[i] = s / Math.max(1, b - a);
  }
  return { data: out, rate: to };
}

export class VadWake {
  constructor() {
    this.on = false;
    this.lang = 'auto';
    this.gate = () => true; // false while the companion talks, is busy, or someone is using push-to-talk
    this.getTerms = () => [];
    this.getLangs = () => [];
    this.onFinal = () => {};
    this.onError = () => {};
    this.onNotice = () => {};
    this.onState = () => {};
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.uploads = [];
    this.pausedUntil = 0;
    this.fails = 0;
    this.sending = false;
    this.reset();
    this.floor = 0.004;
    // on-device wake word
    this.detectorFactory = null; // async () => OnnxWake
    this.detector = null;
    this.threshold = 0.5;
    this.onWake = () => {};
    this.onScore = () => {};
    this.openUntil = 0; // while this is in the future, speech is sent without needing the wake word (the follow-up window)
    this.wakeAt = 0;
    this.lastWake = 0;
    this.hits = 0;
    this.segStart = 0;
    this.segOpen = false;
    this.rsPhase = 0;
    this.rsSum = 0;
    this.rsCnt = 0;
    this.out16 = [];
    this.queue = [];
    this.draining = false;
  }

  get running() {
    return this.on;
  }

  reset() {
    this.speaking = false;
    this.voiced = 0;
    this.quiet = 0;
    this.loud = 0;
    this.clipMs = 0;
    this.clip = [];
    this.pre = [];
    this.preMs = 0;
  }

  async start() {
    this.on = true;
    this.fails = 0;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.on = false;
      this.onState(false);
      this.onError(e?.name === 'NotAllowedError' ? 'Microphone access was blocked, so hands-free listening is off. Allow the microphone for this page and turn it on again.' : 'No microphone found for hands-free listening.');
      return;
    }
    if (!this.on) return this.release(); // switched off while the permission prompt was open
    if (this.detectorFactory && !this.detector) {
      try {
        this.detector = await this.detectorFactory();
      } catch (e) {
        console.warn('[hands-free] on-device wake word unavailable:', e);
        this.onNotice("The on-device wake word couldn't start, so I'll listen by transcribing instead.");
      }
      if (!this.on) return this.release();
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const resume = () => this.ctx?.state === 'suspended' && this.ctx.resume().catch(() => {});
    resume();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { once: true });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.onaudioprocess = (e) => this.process(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(mute).connect(this.ctx.destination);
    this.reset();
    this.onState(true);
  }

  stop() {
    this.on = false;
    this.release();
    this.onState(false);
  }

  release() {
    try {
      this.node?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.node = this.stream = this.ctx = null;
    this.queue = [];
    this.out16 = [];
    this.reset();
  }

  setLang() {} // Scribe detects the language itself

  /** Resamples the microphone to 16 kHz (simple averaging) and hands 80 ms chunks to the wake word model, never blocking audio. */
  feedDetector(chunk) {
    const ratio = this.ctx.sampleRate / 16000;
    for (let i = 0; i < chunk.length; i++) {
      this.rsSum += chunk[i];
      this.rsCnt++;
      this.rsPhase += 1;
      if (this.rsPhase >= ratio) {
        this.rsPhase -= ratio;
        this.out16.push(this.rsSum / this.rsCnt);
        this.rsSum = 0;
        this.rsCnt = 0;
      }
    }
    while (this.out16.length >= CHUNK16) {
      const c = Float32Array.from(this.out16.splice(0, CHUNK16));
      if (this.queue.length > 12) this.queue.shift(); // fell behind: drop the oldest audio rather than lag
      this.queue.push(c);
    }
    if (!this.draining && this.queue.length) this.drain();
  }

  async drain() {
    this.draining = true;
    try {
      while (this.queue.length && this.detector && this.on) {
        let score = 0;
        try {
          score = await this.detector.push(this.queue.shift());
        } catch (e) {
          console.warn('[hands-free] wake word model error', e);
          this.detector = null; // carry on by transcribing instead
          this.onNotice('The on-device wake word stopped working, so I will listen by transcribing instead.');
          break;
        }
        this.onScore(score);
        this.hits = score >= this.threshold ? this.hits + 1 : 0;
        if (this.hits >= 2 && Date.now() - this.lastWake > 1500 && this.gate()) {
          this.hits = 0;
          this.lastWake = this.wakeAt = Date.now();
          this.onWake(score);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  process(chunk) {
    if (!this.on || !this.ctx) return;
    const ms = (chunk.length / this.ctx.sampleRate) * 1000;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    if (this.detector) this.feedDetector(chunk);
    const threshold = Math.max(0.015, this.floor * 3);
    const isLoud = rms > threshold;
    if (!this.speaking && !isLoud) this.floor = Math.max(0.002, this.floor * 0.98 + rms * 0.02);

    if (!this.speaking) {
      this.pre.push(chunk);
      this.preMs += ms;
      while (this.preMs > PREROLL_MS && this.pre.length > 1) this.preMs -= (this.pre.shift().length / this.ctx.sampleRate) * 1000;
      this.loud = isLoud ? this.loud + ms : 0;
      if (this.loud >= START_MS && Date.now() >= this.pausedUntil && this.gate()) {
        this.speaking = true;
        this.segStart = Date.now() - this.preMs - this.loud;
        this.segOpen = Date.now() < this.openUntil; // was the follow-up window already open when this speech began?
        this.clip = [...this.pre];
        this.clipMs = this.preMs;
        this.voiced = this.loud;
        this.quiet = 0;
      }
      return;
    }
    this.clip.push(chunk);
    this.clipMs += ms;
    if (isLoud) {
      this.voiced += ms;
      this.quiet = 0;
    } else this.quiet += ms;
    if (this.quiet >= END_SILENCE_MS || this.clipMs >= MAX_CLIP_MS) this.finish();
  }

  finish() {
    const chunks = this.clip;
    const voiced = this.voiced;
    const rate = this.ctx.sampleRate;
    this.speaking = false;
    this.clip = [];
    this.pre = [];
    this.preMs = 0;
    this.loud = 0;
    if (voiced < MIN_VOICED_MS || !this.gate() || this.sending) return;
    const now = Date.now();
    if (this.detector) {
      const heardName = this.wakeAt >= this.segStart && this.wakeAt <= now;
      if (!heardName && !this.segOpen) return; // not meant for me, and it never leaves this computer
      // Only the name, nothing after it: the app is already listening for the next sentence, so there is nothing to send.
      if (heardName && !this.segOpen && now - this.quiet - this.wakeAt < NAME_ONLY_TAIL_MS) return;
    }
    this.uploads = this.uploads.filter((t) => now - t < BUDGET.perMs);
    if (this.uploads.length >= BUDGET.clips) {
      this.pausedUntil = now + BUDGET.pauseMs;
      this.uploads = [];
      this.onNotice('It is noisy in here, so I am pausing hands-free listening for two minutes to save speech credit.');
      return;
    }
    this.uploads.push(now);
    const { data, rate: r } = downsample(chunks, rate, TARGET_RATE);
    this.send(wav(data, r));
  }

  async send(blob) {
    this.sending = true;
    try {
      const { text } = await transcribe(blob, { lang: 'auto', langs: this.getLangs(), terms: this.getTerms() });
      this.fails = 0;
      if (text && this.on) this.onFinal([text]);
    } catch (e) {
      console.warn('[hands-free]', e.message);
      if (++this.fails >= 3 && this.on) {
        this.on = false;
        this.release();
        this.onState(false);
        this.onError("Hands-free listening can't reach the speech service, so it is off: " + e.message);
      }
    } finally {
      this.sending = false;
    }
  }
}
