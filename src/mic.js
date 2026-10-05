/**
 * Push-to-talk recorder.
 * The microphone stream is opened once (prepare) and kept warm, so pressing the button starts
 * recording instantly. Reopening the mic on every press used to clip the first syllable.
 * Records opus/webm (Chrome) or mp4 (Safari) and exposes a live input level.
 */
const TRAILING_PAD_MS = 350; // keep recording briefly after release so the last word isn't cut off

export class Mic {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.startedAt = 0;
    this.recording = false;
  }

  async prepare() {
    if (this.stream?.getAudioTracks().some((t) => t.readyState === 'live')) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
  }

  async start() {
    await this.prepare();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder?.isTypeSupported?.(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(100);
    this.startedAt = performance.now();
    this.recording = true;
  }

  get level() {
    if (!this.analyser || !this.recording) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 5);
  }

  /** Resolves with { blob, seconds }. */
  async stop() {
    const seconds = (performance.now() - this.startedAt) / 1000;
    this.recording = false;
    if (!this.rec || this.rec.state === 'inactive') return { blob: new Blob([]), seconds: 0 };
    await new Promise((r) => setTimeout(r, TRAILING_PAD_MS));
    return new Promise((resolve) => {
      this.rec.onstop = () =>
        resolve({ blob: new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }), seconds: seconds + TRAILING_PAD_MS / 1000 });
      this.rec.stop();
    });
  }
}

/** lang: "auto" | "english" | the language being learned (e.g. "swedish"); terms: words she has been taught. */
export async function transcribe(blob, { lang = 'auto', langs = [], terms = [] } = {}) {
  const qs = new URLSearchParams({ lang, langs: langs.join(','), terms: JSON.stringify(terms.slice(-40)) });
  const r = await fetch('/api/stt?' + qs, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Transcription failed (${r.status})`);
  return { text: (j.text || '').trim(), uncertain: Boolean(j.uncertain) };
}
