// Countdown timers that survive a page reload (kept in localStorage).
const KEY = 'companion.timers';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((t) => t && Number.isFinite(t.end) && typeof t.label === 'string') : [];
  } catch {
    return [];
  }
}

export class Timers {
  constructor() {
    this.items = read();
    this.onTick = () => {}; // every half second, to redraw
    this.onDue = () => {}; // a timer finished
    this.interval = setInterval(() => this.tick(), 500);
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      /* ignore */
    }
  }

  add({ label, seconds, say = '' }) {
    const s = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 0)));
    const t = {
      id: Math.random().toString(36).slice(2, 9),
      label: String(label || 'Timer').slice(0, 40),
      end: Date.now() + s * 1000,
      total: s,
      say: String(say || '').slice(0, 160),
    };
    this.items.push(t);
    this.save();
    this.onTick();
    return t;
  }

  /** Cancels timers whose label matches (exactly, or by containing the text). Returns how many. */
  cancel(label) {
    const n = String(label || '').trim().toLowerCase();
    const hit = this.items.filter((t) => t.label.toLowerCase() === n || (n && t.label.toLowerCase().includes(n)));
    if (!hit.length) return 0;
    this.items = this.items.filter((t) => !hit.includes(t));
    this.save();
    this.onTick();
    return hit.length;
  }

  remove(id) {
    this.items = this.items.filter((t) => t.id !== id);
    this.save();
    this.onTick();
  }

  list() {
    const now = Date.now();
    return this.items.map((t) => ({ ...t, remaining: Math.max(0, Math.round((t.end - now) / 1000)) })).sort((a, b) => a.remaining - b.remaining);
  }

  tick() {
    const now = Date.now();
    const due = this.items.filter((t) => t.end <= now);
    if (due.length) {
      this.items = this.items.filter((t) => t.end > now);
      this.save();
      due.forEach((t) => this.onDue(t));
    }
    this.onTick();
  }
}

export const clock = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
};
