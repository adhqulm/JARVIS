// Tiny WebAudio beeps for timers and games (no audio files needed).
let ctx = null;
const ac = () => {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};

export function beep({ freq = 880, dur = 0.14, gain = 0.14, delay = 0, type = 'sine' } = {}) {
  try {
    const c = ac();
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch {
    /* audio blocked: ignore */
  }
}

export const tick = () => beep({ freq: 660, dur: 0.06, gain: 0.08 });
export const go = () => beep({ freq: 1046, dur: 0.25, gain: 0.16 });
export const good = () => (beep({ freq: 784, dur: 0.12 }), beep({ freq: 1175, dur: 0.2, delay: 0.12 }));
export const bad = () => (beep({ freq: 330, dur: 0.18, type: 'triangle' }), beep({ freq: 247, dur: 0.3, delay: 0.18, type: 'triangle' }));
/** The timer alarm: three rising pairs. */
export function alarm() {
  for (let i = 0; i < 3; i++) {
    beep({ freq: 880, dur: 0.16, gain: 0.18, delay: i * 0.55 });
    beep({ freq: 1175, dur: 0.16, gain: 0.18, delay: i * 0.55 + 0.2 });
  }
}
