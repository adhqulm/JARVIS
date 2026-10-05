import { SentenceSplitter } from './splitter.js';

async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            /* ignore malformed event */
          }
        }
      }
    }
  }
}

/** Runs one conversational turn: chat stream -> speech queue + screen tools, with barge-in support. */
export class Conductor {
  constructor({ stage, ui, speaker }) {
    this.stage = stage;
    this.ui = ui;
    this.speaker = speaker;
    this.history = [];
    this.ctrl = null;
    this.turn = 0;
    this.moodTimer = null;
    /** Extra context sent with every chat turn: who is in view, whether the camera is on. */
    this.context = () => ({});
    /** Called when the model asks to learn the face in front of the camera. */
    this.onLearnFace = () => {};
    /** Any other tool (timers, steps, games, checklists) is handed to the app: fn(name, input). */
    this.onTool = () => {};
    /** True from the moment a turn starts until the companion has finished speaking (or was skipped). */
    this.busy = false;
    this.onBusy = () => {};

    speaker.onSentenceStart = (text) => {
      ui.setCaption(text);
      stage.eyes.setState('speaking');
    };
    speaker.onError = (msg) => ui.toast(msg);
    ui.onCardClick = (target) => this.replay(target);
  }

  setBusy(v) {
    if (this.busy === v) return;
    this.busy = v;
    this.onBusy(v);
  }

  interrupt() {
    this.setBusy(false);
    this.turn++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.speaker.stop();
    clearTimeout(this.moodTimer);
    this.stage.eyes.setMood('neutral'); // a new turn starts from a neutral face
    if (this.stage.eyes.state !== 'asleep') this.stage.eyes.setState('idle');
  }

  /** Forget the conversation and clear the screen . */
  reset() {
    this.interrupt();
    this.history = [];
    this.stage.sketch.clear();
    this.ui.clearContent();
    this.stage.setCompact(false);
  }

  /** Re-say a card's text when it is tapped. */
  async replay(text) {
    this.interrupt();
    const turn = this.turn;
    this.speaker.ensure();
    this.setBusy(true);
    this.speaker.enqueue(text);
    await this.speaker.drained();
    if (turn === this.turn) {
      this.stage.eyes.setState('idle');
      this.setBusy(false);
    }
  }

  applyTool(name, input = {}) {
    const { ui, stage } = this;
    switch (name) {
      case 'show_card':
        ui.addCard({ target: input.title, english: input.text, note: input.note });
        stage.setCompact(true);
        break;
      case 'learn_face':
        this.onLearnFace(input.name);
        break;
      case 'show_checklist':
        ui.addChecklist(input);
        stage.setCompact(true);
        break;
      case 'set_timer':
      case 'cancel_timer':
      case 'show_steps':
      case 'step_nav':
      case 'start_game':
      case 'play_music':
      case 'music_control':
        this.onTool(name, input);
        break;
      case 'sketch':
        stage.sketch.show(input);
        ui.showSketch(input);
        stage.setCompact(true);
        break;
      case 'set_mood':
        stage.eyes.setMood(input.mood);
        break;
      case 'clear_screen':
        stage.sketch.clear();
        ui.clearContent();
        stage.setCompact(false);
        break;
    }
  }

  async say(text, { hidden = false, uncertain = false } = {}) {
    this.interrupt();
    const turn = this.turn;
    const { eyes } = this.stage;
    this.setBusy(true);
    this.history.push({ role: 'user', content: uncertain ? `[low-confidence transcript] ${text}` : text });
    if (!hidden) this.ui.setCaption('“' + text + '”', 'you');
    eyes.setState('thinking');

    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const splitter = new SentenceSplitter();
    const speak = (s) => turn === this.turn && this.speaker.enqueue(s);
    let record = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.history, ...this.context() }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Chat failed (${res.status})`);

      for await (const ev of readSSE(res.body)) {
        if (turn !== this.turn) return;
        if (ev.type === 'text') splitter.push(ev.text).forEach(speak);
        else if (ev.type === 'tool') this.applyTool(ev.name, ev.input);
        else if (ev.type === 'done') record = ev.record;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
      if (turn !== this.turn) return;
      splitter.flush().forEach(speak);
      this.history.push({ role: 'assistant', content: record || '(no reply)' });

      await this.speaker.drained();
      if (turn === this.turn) {
        eyes.setState('idle');
        this.setBusy(false);
        this.moodTimer = setTimeout(() => eyes.setMood('neutral'), 4000);
        return true; // the whole turn finished, nobody interrupted it
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error(e);
      this.ui.toast(e.message);
      if (turn === this.turn) {
        eyes.setState('idle');
        this.setBusy(false);
      }
    }
  }
}
