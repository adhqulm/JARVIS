import { Application } from 'pixi.js';
import { Eyes, BG, EYE_H, EYES_DESIGN_W } from './eyes.js';
import { SketchView } from './sketch.js';

const TOPBAR_H = 52;

/** PixiJS canvas holding the eyes and the sketch panel; the eyes shrink to the top when content is shown. */
export async function createStage() {
  const app = new Application();
  await app.init({
    background: BG,
    resizeTo: window,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById('stage').appendChild(app.canvas);

  const eyes = new Eyes();
  const sketch = new SketchView();
  app.stage.addChild(sketch, eyes);

  const dock = document.getElementById('dock');
  const slot = document.getElementById('sketch-slot');
  const root = document.documentElement;
  const layout = { compact: 0, target: 0, lastEyesH: 0, lastDockH: 0 };

  app.ticker.add((t) => {
    const dt = Math.min(t.deltaMS / 1000, 0.1);
    eyes.update(dt);
    sketch.update(dt);
    layout.compact += (layout.target - layout.compact) * (1 - Math.exp(-dt * 6));

    const vw = app.screen.width;
    const vh = app.screen.height;
    const dockH = dock.offsetHeight;
    const area = vh - dockH;
    const eyesAreaH = Math.round(Math.min(Math.max(vh * 0.24, 120), 210));
    const top = TOPBAR_H; // keep the eyes clear of the language pickers and the window edge

    if (eyesAreaH !== layout.lastEyesH) root.style.setProperty('--eyes-h', eyesAreaH + top + 'px');
    if (dockH !== layout.lastDockH) root.style.setProperty('--dock-h', dockH + 'px');
    layout.lastEyesH = eyesAreaH;
    layout.lastDockH = dockH;

    const fullScale = Math.min((vw * 0.55) / EYES_DESIGN_W, (area * 0.55) / EYE_H);
    const compScale = (eyesAreaH * 0.7) / EYE_H;
    const sc = fullScale + (compScale - fullScale) * layout.compact;
    const fullY = area * 0.46;
    const compY = top + eyesAreaH / 2;
    eyes.scale.set(sc);
    eyes.position.set(vw / 2, fullY + (compY - fullY) * layout.compact);

    sketch.place(slot.getBoundingClientRect());
  });

  return {
    app,
    eyes,
    sketch,
    setCompact(on) {
      layout.target = on ? 1 : 0;
    },
  };
}
