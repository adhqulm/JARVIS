// Hands-free listening: the browser's speech recognition runs while the mode is on and we only act when the companion's
// name is heard (or during a short follow-up window after it). In Chrome and Edge that recognition is done by the browser
// vendor's cloud service, so this is opt-in. Push-to-talk (which uses ElevenLabs) stays the more accurate way to talk.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const wakeSupported = Boolean(SR);

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
// A rough consonant skeleton, so "Vesper" and "Vester" or "Lumen" and "Lumin" still line up.
const skeleton = (w) => w.replace(/[aeiouyåäö]/g, '').replace(/(.)\1+/g, '$1');

/** Does this heard word count as that name? Short names must match exactly; longer ones may be one letter off. */
export function sounds(heard, name) {
  if (!heard || !name) return false;
  if (heard === name || heard === name + 's' || heard === name + "'s") return true;
  if (name.length < 5) return false;
  if (lev(heard, name) <= 1) return true;
  return name.length >= 6 && skeleton(heard).length >= 3 && skeleton(heard) === skeleton(name) && Math.abs(heard.length - name.length) <= 1;
}

const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'hej', 'hallå', 'hallo', 'oi', 'ey', 'eh', 'hei', 'moi', 'привет']);

/**
 * Looks for any of `names` in what was heard. Returns { hit, rest } where rest is the request that came with it:
 * what follows the name ("Vesper, set a timer") or, if nothing does, what came before ("set a timer, Vesper").
 */
export function matchName(text, names) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const flat = words.map(norm);
  for (const raw of names) {
    const n = norm(raw).split(' ').filter(Boolean);
    if (!n.length) continue;
    for (let i = 0; i + n.length <= words.length; i++) {
      // a name said as one word that was heard as two ("ve sper") is not handled; names spoken as several words are
      if (!n.every((part, k) => sounds(flat[i + k], part))) continue;
      const clean = (arr) => arr.join(' ').replace(/^[\s,.!?;:-]+|[\s,.!?;:-]+$/g, '');
      let before = words.slice(0, i);
      while (before.length && GREETINGS.has(norm(before[0]))) before.shift();
      const after = words.slice(i + n.length);
      const rest = clean(after) || clean(before);
      return { hit: true, rest };
    }
  }
  return { hit: false, rest: '' };
}

export class WakeWord {
  constructor() {
    this.rec = null;
    this.on = false;
    this.lang = 'en-US';
    this.onFinal = () => {};
    this.onInterim = () => {};
    this.onError = () => {};
    this.onState = () => {};
    this.fails = 0;
  }

  get running() {
    return this.on;
  }

  start(lang) {
    if (!SR) throw new Error('unsupported');
    if (lang) this.lang = lang;
    this.on = true;
    this.fails = 0;
    this.open();
    this.onState(true);
  }

  stop() {
    this.on = false;
    try {
      this.rec?.abort();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.onState(false);
  }

  setLang(lang) {
    this.lang = lang;
    if (this.on) {
      try {
        this.rec?.abort(); // onend reopens it with the new language
      } catch {
        /* ignore */
      }
    }
  }

  open() {
    if (!this.on) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      this.fails = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const alts = [...r].map((a) => a.transcript).filter(Boolean);
        if (!alts.length) continue;
        if (r.isFinal) this.onFinal(alts);
        else this.onInterim(alts[0]);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.on = false;
        this.onState(false);
        this.onError('Microphone access was blocked, so hands-free listening is off. Allow the microphone for this page and turn it on again.');
      } else if (e.error === 'audio-capture') {
        this.on = false;
        this.onState(false);
        this.onError('No microphone found for hands-free listening.');
      } else if (e.error === 'network') {
        this.fails++;
      }
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.on) return;
      if (this.fails >= 4) {
        this.on = false;
        this.onState(false);
        return this.onError("Hands-free listening can't reach the speech service right now, so it is off. Check the internet connection.", 'network');
      }
      setTimeout(() => this.open(), this.fails ? 1500 : 250); // continuous mode ends every so often; just reopen
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      setTimeout(() => this.open(), 1000);
    }
  }
}
