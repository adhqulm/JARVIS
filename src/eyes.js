import { Container, Graphics, BlurFilter } from 'pixi.js';

export const BG = 0x0b1020;
export const EYE_W = 130;
export const EYE_H = 150;
export const EYE_GAP = 70;
export const EYE_R = 44;
export const EYES_DESIGN_W = EYE_W * 2 + EYE_GAP;

// tired = outer corners droop (reads as SAD, so no mood uses it); squint = flat upper lid (pondering / sleepy)
const DEFAULT = { size: 1, wmul: 1, tired: 0, angry: 0, happy: 0, squint: 0, lx: 0, ly: 0, curL: 0, curR: 0 };

// Mood = offsets from the neutral face. "happy" is the ^ ^ look, "tired" droops the outer lid.
export const MOODS = {
  neutral: {},
  happy: { happy: 0.36, ly: -0.1 },
  encouraging: { happy: 0.22, size: 1.08, ly: -0.05 },
  curious: { size: 1.12, ly: -0.3, lx: 0.3 },
  thinking: { squint: 0.2, size: 0.96, lx: -0.6, ly: -0.65 },
  surprised: { size: 1.2, wmul: 0.86, ly: -0.1 },
  // Borrowed from RoboEyes' macro animations: these two also shake briefly (see MACROS).
  laughing: { happy: 0.45, size: 1.04, ly: -0.05 },
  confused: { size: 1.06, lx: 0.25, ly: -0.2, squint: 0.08 },
};

// RoboEyes "laugh" is a vertical flicker, "confused" a horizontal one. Amplitudes are in eye design units.
const MACROS = {
  laughing: { axis: 'y', amp: 7, freq: 9, seconds: 0.7 },
  confused: { axis: 'x', amp: 14, freq: 7, seconds: 0.6 },
};

export const STATES = ['asleep', 'idle', 'listening', 'thinking', 'speaking'];

const STATE_COLORS = {
  asleep: [90, 106, 153],
  idle: [126, 231, 255],
  listening: [138, 255, 193],
  thinking: [185, 168, 255],
  speaking: [126, 231, 255],
};

const toInt = ([r, g, b]) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

export class Eyes extends Container {
  constructor() {
    super();
    this.glow = new Graphics();
    this.glow.filters = [new BlurFilter({ strength: 18, quality: 3 })];
    this.addChild(this.glow);

    // Each eye is clipped by a mask so lids can be drawn as background-coloured shapes.
    this.parts = [0, 1].map(() => {
      const holder = new Container();
      const mask = new Graphics();
      const body = new Graphics();
      holder.addChild(body, mask);
      holder.mask = mask;
      this.addChild(holder);
      return { mask, body };
    });

    this.state = 'asleep';
    this.mood = 'neutral';
    this.level = 0;
    this.levelSmooth = 0;
    this.cur = { ...DEFAULT, open: 0.07, color: [...STATE_COLORS.asleep] };
    this.glance = { x: 0, y: 0 };
    this.glanceT = 1.5;
    this.blinkT = 3;
    this.blinkPhase = -1;
    this.t = 0;
    this.shake = null; // { axis, amp, freq, start, seconds }
    this.gaze = { x: 0, y: 0, on: false }; // where a person is (-1..1, +x = screen right); the eyes look at them
  }

  /** Look towards a person. Pass null when nobody is there. */
  setGaze(g) {
    if (!g) this.gaze.on = false;
    else {
      this.gaze.on = true;
      this.gaze.x = Math.max(-1, Math.min(1, g.x));
      this.gaze.y = Math.max(-1, Math.min(1, g.y));
    }
  }

  setState(s) {
    if (STATES.includes(s)) this.state = s;
  }
  setMood(m) {
    this.mood = MOODS[m] ? m : 'neutral';
    const macro = MACROS[this.mood];
    if (macro && this.state !== 'asleep') this.shake = { ...macro, start: this.t };
  }
  /** 0..1 audio level (mic while listening, voice while speaking). */
  setLevel(v) {
    this.level = Math.max(0, Math.min(1, v || 0));
  }

  update(dt) {
    this.t += dt;
    const s = this.state;
    const tar = { ...DEFAULT, ...MOODS[this.mood], open: 1 };

    if (s === 'asleep') {
      tar.open = 0.07;
      tar.squint = 0.3;
    }
    if (s === 'idle') {
      this.glanceT -= dt;
      if (this.glanceT <= 0) {
        this.glanceT = 1.5 + Math.random() * 3;
        if (Math.random() < 0.7) {
          this.glance.x = (Math.random() * 2 - 1) * 0.8;
          this.glance.y = (Math.random() * 2 - 1) * 0.4;
        } else {
          this.glance.x = 0;
          this.glance.y = 0;
        }
      }
      if (this.gaze.on) {
        tar.lx += this.gaze.x * 0.9;
        tar.ly += this.gaze.y * 0.5;
      } else {
        tar.lx += this.glance.x;
        tar.ly += this.glance.y;
      }
    }
    if (s === 'listening') {
      // Always wide-eyed and attentive: a leftover mood from earlier must never leak in here.
      Object.assign(tar, DEFAULT, { open: 1, size: 1.08, ly: -0.1 });
      if (this.gaze.on) tar.lx = this.gaze.x * 0.6;
    }
    if (s === 'thinking') {
      tar.lx = -0.55 + Math.sin(this.t * 0.9) * 0.25;
      tar.ly = -0.6 + Math.sin(this.t * 0.6) * 0.1;
      tar.squint = Math.max(tar.squint, 0.14);
    }

    if (s === 'speaking' && this.gaze.on) tar.lx += this.gaze.x * 0.5;

    this.levelSmooth += (this.level - this.levelSmooth) * (1 - Math.exp(-dt * 18));
    if (s === 'speaking' || s === 'listening') {
      const k = s === 'speaking' ? 0.22 : 0.12;
      tar.size *= 1 + k * this.levelSmooth;
      tar.wmul *= 1 - 0.05 * this.levelSmooth;
    }

    // Blinking
    let blink = 1;
    if (s !== 'asleep') {
      this.blinkT -= dt;
      if (this.blinkT <= 0 && this.blinkPhase < 0) {
        this.blinkPhase = 0;
        this.blinkT = 2 + Math.random() * 4;
      }
      if (this.blinkPhase >= 0) {
        this.blinkPhase += dt / 0.16;
        if (this.blinkPhase >= 1) this.blinkPhase = -1;
        else blink = 1 - 0.94 * Math.sin(Math.PI * this.blinkPhase);
      }
    }

    // RoboEyes "curiosity": the eye you are looking towards grows a little.
    tar.curL = tar.lx < -0.55 ? 1 : 0;
    tar.curR = tar.lx > 0.55 ? 1 : 0;

    // Ease everything toward the target
    const k = 1 - Math.exp(-dt * (s === 'asleep' ? 3 : 9));
    for (const key of Object.keys(tar)) this.cur[key] += (tar[key] - this.cur[key]) * k;
    const tc = STATE_COLORS[s];
    for (let i = 0; i < 3; i++) this.cur.color[i] += (tc[i] - this.cur.color[i]) * (1 - Math.exp(-dt * 6));

    this.draw(blink);
  }

  draw(blink) {
    const c = this.cur;
    const w = EYE_W * c.size * c.wmul;
    const baseH = Math.max(6, EYE_H * c.size * c.open * blink);
    const color = toInt(c.color);
    this.glow.clear();

    let shakeX = 0;
    let shakeY = 0;
    if (this.shake) {
      const age = this.t - this.shake.start;
      if (age >= this.shake.seconds) this.shake = null;
      else {
        const wobble = Math.sin(age * this.shake.freq * Math.PI * 2) * this.shake.amp * (1 - age / this.shake.seconds);
        if (this.shake.axis === 'x') shakeX = wobble;
        else shakeY = wobble;
      }
    }

    [-1, 1].forEach((side, i) => {
      const h = baseH * (1 + 0.1 * (side < 0 ? c.curL : c.curR));
      const cx = side * (EYE_W / 2 + EYE_GAP / 2) + c.lx * 16 + shakeX;
      const cy = c.ly * 14 + shakeY;
      const x0 = cx - w / 2;
      const y0 = cy - h / 2;
      const x1 = cx + w / 2;
      const y1 = cy + h / 2;
      const r = Math.min(EYE_R, w / 2, h / 2);
      const { mask, body } = this.parts[i];
      const outerLeft = side < 0;

      mask.clear().roundRect(x0, y0, w, h, r).fill(0xffffff);
      body.clear().roundRect(x0, y0, w, h, r).fill(color);

      if (c.tired > 0.01) {
        const d = h * c.tired;
        body.poly(outerLeft ? [x0 - 2, y0 - 2, x1 + 2, y0 - 2, x0 - 2, y0 + d] : [x0 - 2, y0 - 2, x1 + 2, y0 - 2, x1 + 2, y0 + d]).fill(BG);
      }
      if (c.squint > 0.01) {
        const d = h * c.squint;
        body.rect(x0 - 2, y0 - 2, w + 4, d + 2).fill(BG);
      }
      if (c.angry > 0.01) {
        const d = h * c.angry;
        body.poly(outerLeft ? [x0 - 2, y0 - 2, x1 + 2, y0 - 2, x1 + 2, y0 + d] : [x0 - 2, y0 - 2, x1 + 2, y0 - 2, x0 - 2, y0 + d]).fill(BG);
      }
      if (c.happy > 0.01) {
        // An ellipse rising from below carves the ^ ^ happy shape.
        const ry = h * 0.9;
        body.ellipse(cx, y1 - h * c.happy + ry, w * 0.8, ry).fill(BG);
      }
      this.glow.roundRect(x0 - 8, y0 - 8, w + 16, h + 16, r + 8).fill({ color, alpha: 0.32 });
    });
  }
}
