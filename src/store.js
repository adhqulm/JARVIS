// Tiny localStorage wrapper. If storage is blocked the app still works for the session.
const mem = {};
const read = (k, d = '') => {
  try {
    return localStorage.getItem(k) ?? mem[k] ?? d;
  } catch {
    return mem[k] ?? d;
  }
};
const write = (k, v) => {
  mem[k] = v;
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export const store = {
  /** Whether the camera was on last time (the browser remembers the permission). */
  get camera() { return read('companion.camera', '0') === '1'; },
  set camera(v) { write('companion.camera', v ? '1' : '0'); },
  /** Whether it may comment out loud on expressions (otherwise only its eyes react). */
  get reactExpr() { return read('companion.reactExpr', '0') === '1'; },
  set reactExpr(v) { write('companion.reactExpr', v ? '1' : '0'); },
  /** Minutes someone must have been out of view before it says hi again when they come back. */
  get greetAfter() { return Number(read('companion.greetAfter', '12')) || 12; },
  set greetAfter(v) { write('companion.greetAfter', String(v)); },
  /** Hands-free mode: listen for the companion's name (opt-in, because the browser's speech service does the listening). */
  get handsFree() { return read('companion.handsFree', '0') === '1'; },
  set handsFree(v) { write('companion.handsFree', v ? '1' : '0'); },
  /** Language the browser listens in for the name. */
  get listenLang() { return read('companion.listenLang', (navigator.language || '').toLowerCase().startsWith('sv') ? 'sv-SE' : 'en-US'); },
  set listenLang(v) { write('companion.listenLang', v); },
  /** Music volume, 0 to 100. */
  get musicVolume() { return read('companion.musicVolume', '60'); },
  set musicVolume(v) { write('companion.musicVolume', v); },
  /** Whether the little YouTube player is shown (it must stay on the page, but can be tucked out of sight). */
  get musicShow() { return read('companion.musicShow', '1') === '1'; },
  set musicShow(v) { write('companion.musicShow', v ? '1' : '0'); },
  /** Languages the household speaks (ElevenLabs codes). One = forced, several = detected and double-checked when unsure. */
  get speechLangs() { return read('companion.speechLangs', 'eng,swe,rus,fin'); },
  set speechLangs(v) { write('companion.speechLangs', v); },
  /** Extra words to help speech recognition hear (comma separated). */
  get vocab() { return read('companion.vocab', ''); },
  set vocab(v) { write('companion.vocab', v); },
  /** File name (without .onnx) of the on-device wake word model in public/wakeword. */
  get wakeModel() { return read('companion.wakeModel', ''); },
  set wakeModel(v) { write('companion.wakeModel', v); },
  /** How sure the wake word model must be (0..1). Lower hears you more easily and also false-triggers more. */
  get wakeThreshold() { return Number(read('companion.wakeThreshold', '0.5')) || 0.5; },
  set wakeThreshold(v) { write('companion.wakeThreshold', String(v)); },
  /** 'auto' | 'ondevice' | 'browser' | 'elevenlabs': what does the listening for the name. */
  get listenEngine() { return read('companion.listenEngine', 'auto'); },
  set listenEngine(v) { write('companion.listenEngine', v); },
  /** Set when the browser's own speech service could not be reached, so auto mode uses ElevenLabs instead. */
  get browserSpeechFailed() { return read('companion.browserSpeechFailed', '0') === '1'; },
  set browserSpeechFailed(v) { write('companion.browserSpeechFailed', v ? '1' : '0'); },
  /** Other spellings the speech recogniser might produce for the name, comma separated. */
  get aliases() { return read('companion.aliases', ''); },
  set aliases(v) { write('companion.aliases', v); },
  /** Whether the small camera preview with face boxes is shown. */
  get preview() { return read('companion.preview', '0') === '1'; },
  set preview(v) { write('companion.preview', v ? '1' : '0'); },
};
