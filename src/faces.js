import * as faceapi from '@vladmandic/face-api';

const INTERVAL_MS = 450; // how often a frame is analysed
const WINDOW = 12; // frames remembered (about 5 seconds)
const RECENT = 5; // frames used to decide someone has arrived
const THRESHOLD = Number(new URLSearchParams(location.search).get('thresh')) || 0.5; // lower = stricter
const SAMPLES = 6;
const EXPR_FRAMES = 5;
const EXPR_NAMES = { fearful: 'scared', disgusted: 'disgusted' };

let modelsReady = null;
function loadModels() {
  modelsReady ??= (async () => {
    try {
      await faceapi.tf.setBackend('webgl');
    } catch {
      await faceapi.tf.setBackend('cpu');
    }
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      faceapi.nets.faceExpressionNet.loadFromUri('/models'),
    ]);
  })();
  modelsReady.catch(() => (modelsReady = null));
  return modelsReady;
}

/**
 * Camera + in-browser face recognition. Nothing leaves the machine except face descriptors
 * (128 numbers per sample) that are saved to the local profile store when someone is enrolled.
 */
export class Faces {
  constructor({ video, overlay }) {
    this.video = video;
    this.overlay = overlay;
    this.running = false;
    this.profiles = []; // [{id, name, notes, descriptors: Float32Array[]}]
    this.ring = []; // recent frame summaries
    this.present = new Set(); // profile ids currently in front of the camera
    this.unknownPresent = false;
    this.last = { faces: [], w: 640, h: 480, at: 0 };
    this.collect = null;
    this.timer = null;
    this.stream = null;
    this.showBoxes = false;

    this.onArrive = () => {};
    this.onLeave = () => {};
    this.onUnknown = () => {};
    this.onStatus = () => {};
    this.onError = () => {};
    this.onExpression = () => {};
    this.exprState = new Map(); // profile id -> { shown, pending, n }

    document.addEventListener('visibilitychange', () => this.running && !document.hidden && this.schedule(0));
  }

  async reload() {
    const r = await fetch('/api/profiles');
    const j = await r.json();
    this.profiles = (j.profiles || []).map((p) => ({ ...p, descriptors: (p.descriptors || []).map((d) => Float32Array.from(d)) }));
    return this.profiles;
  }

  profile(id) {
    return this.profiles.find((p) => p.id === id);
  }

  /** Ids of everyone currently in view, and whether a stranger is too. */
  snapshot() {
    return { ids: [...this.present], unknown: this.unknownPresent, camera: this.running };
  }

  async start() {
    if (this.running) return;
    this.onStatus('loading');
    try {
      await Promise.all([loadModels(), this.reload()]);
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    } catch (e) {
      this.onStatus('off');
      throw e;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.running = true;
    this.ring = [];
    this.onStatus('on');
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.ring = [];
    this.exprState.clear();
    this.last = { faces: [], w: 640, h: 480, at: 0 };
    for (const id of [...this.present]) {
      this.present.delete(id);
      this.onLeave(this.profile(id));
    }
    if (this.unknownPresent) {
      this.unknownPresent = false;
      this.onUnknown(false);
    }
    this.collect?.reject(new Error('The camera was turned off'));
    this.collect = null;
    this.draw();
    this.onStatus('off');
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.running) return;
    if (document.hidden || this.video.readyState < 2) return this.schedule(INTERVAL_MS);
    const t0 = performance.now();
    try {
      const w = this.video.videoWidth || 640;
      const h = this.video.videoHeight || 480;
      const found = await faceapi
        .detectAllFaces(this.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks(true)
        .withFaceExpressions()
        .withFaceDescriptors();
      if (!this.running) return;
      const faces = found.map((f) => {
        const m = this.match(f.descriptor);
        const b = f.detection.box;
        return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, score: f.detection.score, descriptor: f.descriptor, id: m.id, dist: m.dist, expr: { ...f.expressions } };
      });
      this.last = { faces, w, h, at: Date.now() };
      this.feedCollector(faces);
      this.update(faces);
      this.draw();
    } catch (e) {
      console.warn('[faces]', e);
      this.onError(e.message || String(e));
    }
    // adapt: never run more than ~60% of the time, so the page stays smooth on slow machines
    this.schedule(Math.max(INTERVAL_MS - (performance.now() - t0), 120));
  }

  /** Closest known profile (min distance over its samples) or unknown. */
  match(descriptor) {
    let best = { id: null, dist: Infinity };
    for (const p of this.profiles) {
      for (const d of p.descriptors) {
        const dist = faceapi.euclideanDistance(d, descriptor);
        if (dist < best.dist) best = { id: p.id, dist };
      }
    }
    return best.dist < THRESHOLD ? best : { id: null, dist: best.dist };
  }

  update(faces) {
    const ids = new Set(faces.filter((f) => f.id).map((f) => f.id));
    const unknownFaces = faces.filter((f) => !f.id).length;
    // One face that is "unknown" while someone is already present is most likely a bad frame of that person.
    const stranger = unknownFaces > 0 && !(this.present.size > 0 && faces.length === 1);
    const expr = new Map(faces.filter((f) => f.id).map((f) => [f.id, f.expr]));
    this.ring.push({ ids, stranger, expr });
    if (this.ring.length > WINDOW) this.ring.shift();
    const recent = this.ring.slice(-RECENT);

    const candidates = new Set(this.ring.flatMap((f) => [...f.ids]));
    for (const id of candidates) {
      const hits = recent.filter((f) => f.ids.has(id)).length;
      const anywhere = this.ring.some((f) => f.ids.has(id));
      if (!this.present.has(id) && hits >= 2) {
        this.present.add(id);
        this.onArrive(this.profile(id));
      } else if (this.present.has(id) && !anywhere) {
        this.present.delete(id);
        this.onLeave(this.profile(id));
      }
    }
    for (const id of [...this.present]) {
      if (!candidates.has(id)) {
        this.present.delete(id);
        this.onLeave(this.profile(id));
      }
    }

    const strangerHits = recent.filter((f) => f.stranger).length;
    if (!this.unknownPresent && strangerHits >= 3) {
      this.unknownPresent = true;
      this.onUnknown(true);
    } else if (this.unknownPresent && recent.length >= RECENT && recent.every((f) => !f.stranger)) {
      this.unknownPresent = false;
      this.onUnknown(false);
    }
    this.updateExpressions();
    this.onStatus('on');
  }

  /** Smoothed expression per person: the average over the last few frames, only if it is clearly one expression. */
  smoothExpression(id) {
    const frames = this.ring.slice(-EXPR_FRAMES).map((f) => f.expr?.get(id)).filter(Boolean);
    if (frames.length < 2) return null;
    const avg = {};
    for (const e of frames) for (const [k, v] of Object.entries(e)) avg[k] = (avg[k] || 0) + v / frames.length;
    const [k, v] = Object.entries(avg).sort((a, b) => b[1] - a[1])[0];
    return v >= 0.5 ? EXPR_NAMES[k] || k : 'neutral';
  }

  updateExpressions() {
    for (const id of this.present) {
      const label = this.smoothExpression(id);
      if (!label) continue;
      const st = (this.exprState.get(id) ?? { shown: 'neutral', pending: null, n: 0 });
      if (st.pending === label) st.n++;
      else (st.pending = label), (st.n = 1);
      if (st.n >= 3 && st.shown !== label) {
        st.shown = label;
        this.onExpression(id, label);
      }
      this.exprState.set(id, st);
    }
    for (const id of [...this.exprState.keys()]) if (!this.present.has(id)) this.exprState.delete(id);
  }

  /** The biggest face's expression in the latest frame (unsmoothed, any person, known or not). Null if nobody is there. */
  biggestExpression() {
    if (!this.running || Date.now() - this.last.at > 2500 || !this.last.faces.length) return null;
    const f = this.last.faces.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
    const [k, v] = Object.entries(f.expr || {}).sort((a, b) => b[1] - a[1])[0] || [];
    if (!k) return null;
    return v >= 0.55 ? EXPR_NAMES[k] || k : 'neutral';
  }

  /** { profileId: 'happy' | 'sad' | ... } for everyone in view. Crude: expression models are often wrong. */
  expressions() {
    const out = {};
    for (const id of this.present) out[id] = this.exprState.get(id)?.shown ?? 'neutral';
    return out;
  }

  /** Where the biggest recent face is, as -1..1 (x: +right on the screen, y: +down). Null if nobody is there. */
  gaze() {
    if (!this.running || Date.now() - this.last.at > 2500 || !this.last.faces.length) return null;
    const f = this.last.faces.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
    const cx = (f.box.x + f.box.w / 2) / this.last.w;
    const cy = (f.box.y + f.box.h / 2) / this.last.h;
    return { x: (0.5 - cx) * 2, y: (cy - 0.5) * 2 }; // the camera sees a mirror image of the screen's left/right
  }

  // ---- teaching a new face ----
  feedCollector(faces) {
    const c = this.collect;
    if (!c) return;
    if (Date.now() > c.deadline) {
      this.collect = null;
      return c.reject(new Error(c.sawMany ? 'There was more than one person in view' : "I couldn't get a clear look at one face"));
    }
    if (faces.length > 1) {
      c.sawMany = true;
      return;
    }
    const f = faces[0];
    if (!f || f.score < 0.7 || Math.min(f.box.w, f.box.h) < 90) return;
    c.descriptors.push(Array.from(f.descriptor));
    c.deadline = Date.now() + 6000; // keep going while samples are arriving
    c.lastId = f.id;
    if (c.descriptors.length >= SAMPLES) {
      this.collect = null;
      c.resolve(c);
    }
  }

  /** Captures several samples of the single face in view and saves them under `name`. */
  async enroll(name) {
    if (!this.running) throw new Error('The camera is off');
    if (this.collect) throw new Error('Already learning a face');
    const sample = await new Promise((resolve, reject) => {
      this.collect = { descriptors: [], resolve, reject, deadline: Date.now() + 12000, sawMany: false, lastId: null };
    });
    // A face that already belongs to someone else must not be saved under a new name.
    const owner = sample.lastId && this.profile(sample.lastId);
    if (owner && owner.name.toLowerCase() !== String(name).trim().toLowerCase()) {
      throw new Error(`That face already belongs to ${owner.name}`);
    }
    const r = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, descriptors: sample.descriptors }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not save');
    await this.reload();
    return j.profile;
  }

  setPreview(on) {
    this.showBoxes = on;
    this.draw();
  }

  draw() {
    const c = this.overlay;
    if (!c) return;
    const w = this.last.w;
    const h = this.last.h;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!this.showBoxes || !this.running) return;
    ctx.lineWidth = 3;
    ctx.font = '600 22px system-ui, sans-serif';
    for (const f of this.last.faces) {
      const known = f.id ? this.profile(f.id) : null;
      ctx.strokeStyle = known ? '#8affc1' : '#ffb454';
      ctx.strokeRect(f.box.x, f.box.y, f.box.w, f.box.h);
      // the canvas is mirrored by CSS, so flip the text back
      ctx.save();
      ctx.translate(f.box.x + f.box.w / 2, f.box.y - 8);
      ctx.scale(-1, 1);
      ctx.textAlign = 'center';
      ctx.fillStyle = known ? '#8affc1' : '#ffb454';
      ctx.fillText(known ? known.name : '?', 0, 0);
      ctx.restore();
    }
  }
}
