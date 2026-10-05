// Hand gestures from MediaPipe Hands landmarks. The runtime and model are served from /mediapipe (nothing is fetched online).
// MediaPipe only gives 21 points per hand; the gesture names come from the simple geometry rules below.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Landmark indexes: 0 wrist; thumb 1-4; index 5-8; middle 9-12; ring 13-16; pinky 17-20 (mcp, pip, dip, tip). */
const FINGERS = [
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

/** Which gesture a single hand is making right now, or null. Landmarks are normalised image coordinates (y grows downward). */
export function classifyHand(lm) {
  if (!lm || lm.length < 21) return null;
  const wrist = lm[0];
  const size = dist(wrist, lm[9]) || 1e-6; // wrist to middle knuckle: the hand's scale
  const ext = FINGERS.map(([, pip, tip]) => dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.04);
  const n = ext.filter(Boolean).length;
  const thumbOut = dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.05 && dist(lm[4], lm[5]) > dist(lm[2], lm[5]) * 0.9;
  const thumbUp = thumbOut && lm[4].y < lm[2].y - size * 0.5;
  const thumbDown = thumbOut && lm[4].y > lm[2].y + size * 0.5;

  if (n === 0 && thumbUp) return 'thumbs_up';
  if (n === 0 && thumbDown) return 'thumbs_down';
  if (n === 4 && lm[12].y < wrist.y) return 'open_palm'; // all fingers out and the hand raised
  if (n === 2 && ext[0] && ext[1]) return 'peace';
  if (n === 1 && ext[0]) return 'point';
  if (n === 0) return 'fist';
  return null;
}

/** Detects waving: a raised open hand swinging side to side a few times within about a second and a half. */
export class WaveTracker {
  constructor({ window = 1.6, swing = 0.04, swings = 4 } = {}) {
    this.window = window;
    this.swing = swing;
    this.swings = swings;
    this.pts = [];
  }

  reset() {
    this.pts = [];
  }

  /** t in seconds, x is the hand's horizontal position (0..1). Returns true when a wave has just been seen. */
  push(t, x) {
    this.pts.push({ t, x });
    while (this.pts.length && t - this.pts[0].t > this.window) this.pts.shift();
    // Count direction reversals larger than `swing`.
    let extremes = 0;
    let dir = 0;
    let anchor = this.pts[0]?.x ?? x;
    for (const p of this.pts) {
      const d = p.x - anchor;
      if (dir >= 0 && d < -this.swing) {
        if (dir === 1) extremes++;
        dir = -1;
        anchor = p.x;
      } else if (dir <= 0 && d > this.swing) {
        if (dir === -1) extremes++;
        dir = 1;
        anchor = p.x;
      } else if ((dir === 1 && p.x > anchor) || (dir === -1 && p.x < anchor)) {
        anchor = p.x;
      }
    }
    if (extremes >= this.swings) {
      this.reset();
      return true;
    }
    return false;
  }
}

let handsScript = null;
function loadHandsScript() {
  handsScript ??= new Promise((resolve, reject) => {
    if (window.Hands) return resolve();
    const s = document.createElement('script');
    s.src = '/mediapipe/hands.js';
    s.onload = () => (window.Hands ? resolve() : reject(new Error('Hand tracking failed to load')));
    s.onerror = () => reject(new Error('Hand tracking files are missing'));
    document.head.appendChild(s);
  });
  handsScript.catch(() => (handsScript = null));
  return handsScript;
}

const HOLD_FRAMES = 5; // a still gesture must be held for this many frames (about half a second)
const DEFAULT_COOLDOWNS = { wave: 6000, default: 9000 };
const STEP_MS = 90;

export class Gestures {
  constructor({ video }) {
    this.video = video;
    this.running = false;
    this.hands = null;
    this.busy = false;
    this.timer = null;
    this.waves = [new WaveTracker(), new WaveTracker()];
    this.hold = { name: null, n: 0 };
    this.lastFired = {};
    this.current = null; // what is being shown right now (for the preview label)
    this.onGesture = () => {};
    this.onError = () => {};
    this.cooldowns = { ...DEFAULT_COOLDOWNS }; // kitchen mode shortens these so steps can be stepped through quickly
    this.listeners = new Set(); // per-frame listeners: fn(names, wave)
  }

  /** Subscribe to every analysed frame: fn(names: string[]) with 'wave' included when a wave was just seen. Returns an unsubscribe. */
  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resetCooldowns() {
    this.cooldowns = { ...DEFAULT_COOLDOWNS };
  }

  async start() {
    if (this.running) return;
    await loadHandsScript();
    if (!this.hands) {
      const hands = new window.Hands({ locateFile: (f) => `/mediapipe/${f}` });
      hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
      hands.onResults((r) => this.results(r));
      await hands.initialize();
      this.hands = hands;
    }
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.waves.forEach((w) => w.reset());
    this.hold = { name: null, n: 0 };
    this.current = null;
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.running) return;
    if (document.hidden || this.video.readyState < 2 || this.busy) return this.schedule(STEP_MS);
    this.busy = true;
    const t0 = performance.now();
    try {
      await this.hands.send({ image: this.video });
    } catch (e) {
      console.warn('[gestures]', e);
      this.onError(e.message || String(e));
    }
    this.busy = false;
    this.schedule(Math.max(STEP_MS - (performance.now() - t0), 30));
  }

  fire(name) {
    const now = Date.now();
    if (now - (this.lastFired[name] || 0) < (this.cooldowns[name] ?? this.cooldowns.default)) return;
    this.lastFired[name] = now;
    this.onGesture({ name, at: now });
  }

  results(r) {
    const hands = r?.multiHandLandmarks || [];
    const t = performance.now() / 1000;
    let names = hands.map((lm) => classifyHand(lm));

    hands.forEach((lm, i) => {
      const tracker = this.waves[i] || this.waves[0];
      if (names[i] === 'open_palm') {
        if (tracker.push(t, lm[9].x)) {
          this.fire('wave');
          names[i] = 'wave';
        }
      } else tracker.reset();
    });
    for (let i = hands.length; i < this.waves.length; i++) this.waves[i].reset();

    // Still gestures: the same one must be held for a moment before it counts.
    const still = names.find((n) => n && n !== 'open_palm' && n !== 'wave' && n !== 'fist' && n !== 'point') || null;
    if (still && still === this.hold.name) this.hold.n++;
    else this.hold = { name: still, n: still ? 1 : 0 };
    if (still && this.hold.n === HOLD_FRAMES) this.fire(still);
    this.current = names.find(Boolean) || null;
    const seen = names.filter(Boolean);
    for (const fn of this.listeners) fn(seen);
  }
}
