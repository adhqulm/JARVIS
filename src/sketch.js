import { Container, Graphics, GraphicsPath, Text } from 'pixi.js';

const MAX_SHAPES = 80;
const DEFAULT_FILL = '#7ee7ff';
const TEXT_FONT = '"Noto Sans Georgian", ui-rounded, system-ui, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';

const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

function paint(g, s) {
  const fill = s.fill !== undefined ? s.fill : s.stroke ? null : DEFAULT_FILL;
  if (fill && fill !== 'none') g.fill(fill);
  if (s.stroke && s.stroke !== 'none') {
    g.stroke({ width: s.strokeWidth ?? 2, color: s.stroke, cap: 'round', join: 'round' });
  }
  return g;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function pairsToFlat(points) {
  if (!Array.isArray(points)) return [];
  if (Array.isArray(points[0])) return points.flat().map(Number);
  return points.map(Number);
}

/** Build a Pixi display object from one shape description. Throws on bad input (caller catches). */
function buildShape(s) {
  switch (s?.type) {
    case 'circle':
      return paint(new Graphics().circle(num(s.cx), num(s.cy), Math.max(0.1, num(s.r, 5))), s);
    case 'ellipse':
      return paint(new Graphics().ellipse(num(s.cx), num(s.cy), Math.max(0.1, num(s.rx, 5)), Math.max(0.1, num(s.ry, 5))), s);
    case 'rect': {
      const g = new Graphics();
      if (s.rx) g.roundRect(num(s.x), num(s.y), num(s.w, 10), num(s.h, 10), num(s.rx));
      else g.rect(num(s.x), num(s.y), num(s.w, 10), num(s.h, 10));
      return paint(g, s);
    }
    case 'line':
      return new Graphics()
        .moveTo(num(s.x1), num(s.y1))
        .lineTo(num(s.x2), num(s.y2))
        .stroke({ width: s.strokeWidth ?? 3, color: s.stroke ?? s.fill ?? '#ffffff', cap: 'round' });
    case 'poly': {
      const pts = pairsToFlat(s.points);
      if (pts.length < 6) return null;
      return paint(new Graphics().poly(pts), s);
    }
    case 'path': {
      if (!s.d) return null;
      return paint(new Graphics().path(new GraphicsPath(String(s.d))), s);
    }
    case 'text':
    case 'emoji': {
      const isEmoji = s.type === 'emoji';
      const content = isEmoji ? s.emoji : s.text;
      if (!content) return null;
      const size = num(s.size, isEmoji ? 20 : 10);
      // Render big and scale down so text stays crisp when the 100-unit scene is scaled up.
      const t = new Text({
        text: String(content),
        style: {
          fontFamily: isEmoji ? EMOJI_FONT : TEXT_FONT,
          fontSize: size * 10,
          fontWeight: '700',
          fill: s.fill ?? '#ffffff',
        },
        resolution: 2,
      });
      t.anchor.set(0.5);
      t.scale.set(0.1);
      t.position.set(num(s.x, 50), num(s.y, 50));
      return t;
    }
    default:
      return null;
  }
}

/** Panel on the canvas that draws the tutor's sketches in a 100x100 coordinate space. */
export class SketchView extends Container {
  constructor() {
    super();
    this.panel = new Graphics();
    this.scene = new Container();
    this.addChild(this.panel, this.scene);
    this.items = [];
    this.visible = false;
  }

  show(spec) {
    this.clear();
    const shapes = Array.isArray(spec?.shapes) ? spec.shapes.slice(0, MAX_SHAPES) : [];
    shapes.forEach((s, i) => {
      try {
        const obj = buildShape(s);
        if (!obj) return;
        const wrap = new Container();
        wrap.addChild(obj);
        const b = wrap.getLocalBounds();
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        wrap.pivot.set(cx, cy);
        wrap.position.set(cx, cy);
        wrap.alpha = 0;
        wrap.scale.set(0.6);
        this.scene.addChild(wrap);
        this.items.push({ wrap, delay: 0.1 + i * 0.14, t: 0 });
      } catch (e) {
        console.warn('Skipping bad sketch shape', s, e);
      }
    });
    this.visible = true;
  }

  clear() {
    for (const c of this.scene.removeChildren()) c.destroy({ children: true });
    this.items = [];
    this.visible = false;
  }

  /** Position over a DOM rectangle (the #sketch-slot element). */
  place(rect) {
    if (!this.visible || !rect || rect.width < 4) return;
    this.panel
      .clear()
      .roundRect(rect.x, rect.y, rect.width, rect.height, 24)
      .fill({ color: 0x141b34, alpha: 0.85 })
      .stroke({ width: 1, color: 0x2a3563 });
    const side = Math.max(20, Math.min(rect.width, rect.height) - 40);
    this.scene.scale.set(side / 100);
    this.scene.position.set(rect.x + (rect.width - side) / 2, rect.y + (rect.height - side) / 2);
  }

  update(dt) {
    for (const it of this.items) {
      it.t += dt;
      const p = Math.max(0, Math.min(1, (it.t - it.delay) / 0.35));
      it.wrap.alpha = Math.min(1, p * 2);
      it.wrap.scale.set(0.6 + 0.4 * easeOutBack(p));
    }
  }
}
