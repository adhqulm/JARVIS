// On-device wake word detection with openWakeWord models (https://github.com/dscripka/openWakeWord) running in the
// browser through onnxruntime-web. Nothing leaves the computer. Audio in, a 0..1 score out, once per 80 ms.
//
// Pipeline (same as the reference Python library): 16 kHz audio in 1280-sample chunks -> mel spectrogram model ->
// embedding model (every 76 mel frames) -> small wake word model over the last 16 embeddings.

import * as ort from 'ort-bundle';

ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.wasm' }; // the bundle build has its own JS glue; only the binary is fetched
ort.env.wasm.numThreads = 1; // multi-threading needs cross-origin isolation; one thread is plenty for this

export const CHUNK = 1280; // 80 ms at 16 kHz
const MEL_CONTEXT = 160 * 3;
const MEL_MAX = 970;
const FEAT_MAX = 120;
const WARMUP_CHUNKS = 5; // the library ignores the first few scores while its buffers fill

export class OnnxWake {
  /** baseUrl holds melspectrogram.onnx and embedding_model.onnx; modelUrl is the wake word model itself. */
  static async create({ modelUrl, baseUrl = '/wakeword/', loadBytes }) {
    const get = loadBytes || (async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()));
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [mel, emb, wake] = await Promise.all(
      [baseUrl + 'melspectrogram.onnx', baseUrl + 'embedding_model.onnx', modelUrl].map(async (u) => ort.InferenceSession.create(await get(u), opts)),
    );
    const w = new OnnxWake(mel, emb, wake);
    await w.reset();
    return w;
  }

  constructor(mel, emb, wake) {
    this.mel = mel;
    this.emb = emb;
    this.wake = wake;
    this.wakeInput = wake.inputNames[0];
    this.raw = new Float32Array(0);
    this.melBuf = [];
    this.feats = [];
    this.chunks = 0;
  }

  async reset() {
    this.raw = new Float32Array(0);
    this.chunks = 0;
    this.melBuf = Array.from({ length: 76 }, () => new Float32Array(32).fill(1));
    // Start the embedding history from the embedding of silence, as the reference does.
    const silent = await this.melOf(new Float32Array(16000 * 3));
    const rows = silent.map((r) => r.map((v) => v / 10 + 2));
    this.feats = [];
    for (let i = 0; i + 76 <= rows.length; i += 8) this.feats.push(await this.embed(rows.slice(i, i + 76)));
    this.feats = this.feats.slice(-FEAT_MAX);
    while (this.feats.length < 16) this.feats.unshift(this.feats[0] || new Float32Array(96));
  }

  async melOf(samples) {
    const out = await this.mel.run({ input: new ort.Tensor('float32', samples, [1, samples.length]) });
    const t = out[this.mel.outputNames[0]];
    const frames = t.dims[t.dims.length - 2];
    const rows = [];
    for (let i = 0; i < frames; i++) rows.push(t.data.slice(i * 32, (i + 1) * 32));
    return rows;
  }

  async embed(window76) {
    const flat = new Float32Array(76 * 32);
    window76.forEach((r, i) => flat.set(r, i * 32));
    const out = await this.emb.run({ input_1: new ort.Tensor('float32', flat, [1, 76, 32, 1]) });
    return out[this.emb.outputNames[0]].data.slice(0, 96);
  }

  /** One chunk of exactly 1280 samples, floats in -1..1 at 16 kHz. Resolves to the wake word score (0 while warming up). */
  async push(chunk) {
    // The models were trained on 16-bit integer sample values.
    const pcm = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, chunk[i])) * 32767);
    const keep = Math.min(this.raw.length, 16000 * 10);
    const joined = new Float32Array(keep + pcm.length);
    joined.set(this.raw.subarray(this.raw.length - keep));
    joined.set(pcm, keep);
    this.raw = joined.length > 16000 * 4 ? joined.slice(joined.length - 16000 * 4) : joined;

    const take = Math.min(this.raw.length, pcm.length + MEL_CONTEXT);
    const rows = await this.melOf(this.raw.slice(this.raw.length - take));
    for (const r of rows) this.melBuf.push(r.map((v) => v / 10 + 2));
    if (this.melBuf.length > MEL_MAX) this.melBuf = this.melBuf.slice(-MEL_MAX);

    this.feats.push(await this.embed(this.melBuf.slice(-76)));
    if (this.feats.length > FEAT_MAX) this.feats = this.feats.slice(-FEAT_MAX);

    const flat = new Float32Array(16 * 96);
    this.feats.slice(-16).forEach((f, i) => flat.set(f, i * 96));
    const out = await this.wake.run({ [this.wakeInput]: new ort.Tensor('float32', flat, [1, 16, 96]) });
    this.chunks++;
    const score = out[this.wake.outputNames[0]].data[0];
    return this.chunks <= WARMUP_CHUNKS ? 0 : score;
  }
}
