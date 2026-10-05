/** Turns streamed text into whole sentences so each can be sent to text-to-speech as soon as it is complete. */
const MIN_LEN = 12;
const FIRST_CLAUSE_MIN = 18;

export class SentenceSplitter {
  constructor() {
    this.buf = '';
    this.emitted = 0;
  }

  push(text) {
    this.buf += text;
    const out = [];
    let start = 0;
    for (let i = 0; i < this.buf.length - 1; i++) {
      const ch = this.buf[i];
      const next = this.buf[i + 1];
      // The very first chunk of a reply may end at a comma, so speech can start sooner.
      const clause = this.emitted === 0 && /[,;:]/.test(ch) && /\s/.test(next) && i - start >= FIRST_CLAUSE_MIN;
      const boundary = ch === '\n' || (/[.!?]/.test(ch) && /\s/.test(next)) || clause;
      if (!boundary) continue;
      const piece = this.buf.slice(start, i + 1).trim();
      if (piece.length >= MIN_LEN || ch === '\n') {
        if (piece) {
          out.push(piece);
          this.emitted++;
        }
        start = i + 1;
      }
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
