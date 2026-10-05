// Camera games run entirely in the browser (reliable and fast); the chat model only gets a short result afterwards.
import { tick, go, good, bad } from './sound.js';

const MOVES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const FROM_GESTURE = { fist: 'rock', open_palm: 'paper', peace: 'scissors' };
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

/** 'user' | 'me' | 'tie' */
export function rpsOutcome(user, me) {
  return user === me ? 'tie' : BEATS[user] === me ? 'user' : 'me';
}

/** The move shown most often in these frames ([{names}]), if it was seen at least `min` times. */
export function dominantMove(frames, min = 2) {
  const counts = {};
  for (const f of frames) {
    const m = f.names.map((n) => FROM_GESTURE[n]).find(Boolean);
    if (m) counts[m] = (counts[m] || 0) + 1;
  }
  const [move, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return n >= min ? move : null;
}

const TEXT = {
  en: {
    rpsIntro: (n) => `Rock, paper, scissors, best of ${n}! Show me your hand when I say shoot.`,
    rpsCount: 'Rock, paper, scissors, shoot!',
    noHand: "I couldn't see your hand. Let's do that round again.",
    moves: { rock: 'rock', paper: 'paper', scissors: 'scissors' },
    mine: (m) => `I picked ${m}.`,
    win: 'You win this round!',
    lose: 'I win this round!',
    tie: "It's a tie!",
    rpsGaveUp: "I can't seem to see your hand. Make sure it's in view and try again later.",
    simonIntro: (n) => `Simon says! I'll give you ${n} commands. Only do them if I say Simon says.`,
    simonSays: 'Simon says ',
    commands: { thumbs_up: 'give me a thumbs up', peace: 'make a peace sign', wave: 'wave at me', fist: 'make a fist', open_palm: 'show me your open hand' },
    simonOk: 'Good one!',
    simonSlow: "Too slow!",
    trickCaught: "Simon didn't say it! Gotcha!",
    trickPassed: 'Well done, you waited!',
    faceIntro: (n) => `Let's make faces! I'll ask for ${n}.`,
    faces: { happy: 'a happy face', surprised: 'a surprised face', sad: 'a sad pouty face' },
    makeFace: (f) => `Make ${f}!`,
    faceOk: 'Nice one!',
    faceMiss: 'Not quite, but nice try!',
    final: (a, b) => `That's it! You got ${a} out of ${b}.`,
    finalRps: (u, m) => (u > m ? `You win ${u} to ${m}!` : m > u ? `I win ${m} to ${u}!` : `We tied ${u} to ${m}.`),
    needCamera: 'Turn the camera on first and I will play with you.',
  },
  sv: {
    rpsIntro: (n) => `Sten, sax, påse, bäst av ${n}! Visa din hand när jag säger kör.`,
    rpsCount: 'Sten, sax, påse, kör!',
    noHand: 'Jag såg inte din hand. Vi tar om rundan.',
    moves: { rock: 'sten', paper: 'påse', scissors: 'sax' },
    mine: (m) => `Jag valde ${m}.`,
    win: 'Du vann den här rundan!',
    lose: 'Jag vann den här rundan!',
    tie: 'Det blev oavgjort!',
    rpsGaveUp: 'Jag ser inte din hand. Se till att den syns och försök igen.',
    simonIntro: (n) => `Simon säger! Jag ger dig ${n} kommandon. Gör bara det om jag säger Simon säger.`,
    simonSays: 'Simon säger ',
    commands: { thumbs_up: 'visa tummen upp', peace: 'gör ett fredstecken', wave: 'vinka till mig', fist: 'knyt näven', open_palm: 'visa din öppna hand' },
    simonOk: 'Bra!',
    simonSlow: 'För långsamt!',
    trickCaught: 'Simon sa inte det! Fångad!',
    trickPassed: 'Bra, du väntade!',
    faceIntro: (n) => `Nu gör vi miner! Jag ber om ${n}.`,
    faces: { happy: 'en glad min', surprised: 'en förvånad min', sad: 'en ledsen min' },
    makeFace: (f) => `Gör ${f}!`,
    faceOk: 'Snyggt!',
    faceMiss: 'Inte riktigt, men bra försök!',
    final: (a, b) => `Det var allt! Du fick ${a} av ${b}.`,
    finalRps: (u, m) => (u > m ? `Du vann med ${u} mot ${m}!` : m > u ? `Jag vann med ${m} mot ${u}!` : `Vi spelade lika, ${u} mot ${m}.`),
    needCamera: 'Sätt på kameran först så spelar jag med dig.',
  },
};

const sleepAbortable = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export class GameManager {
  /**
   * io: {
   *   speaker, gestures, faces,               // the app's pieces
   *   caption(text), card(title, text), clearCards(), mood(name), report(text), onEnd()
   * }
   */
  constructor(io) {
    this.io = io;
    this.ctl = null;
    this.frames = []; // recent gesture frames [{t, names}]
    io.gestures.onFrame((names) => {
      const t = performance.now();
      this.frames.push({ t, names });
      while (this.frames.length && t - this.frames[0].t > 6000) this.frames.shift();
    });
  }

  get active() {
    return Boolean(this.ctl);
  }

  stop() {
    this.ctl?.abort();
    this.io.speaker.stop();
  }

  framesSince(t0) {
    return this.frames.filter((f) => f.t >= t0);
  }

  async say(text) {
    this.io.speaker.ensure();
    this.io.speaker.enqueue(text);
    await Promise.race([this.io.speaker.drained(), new Promise((_, rej) => this.ctl.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true }))]);
  }

  sleep(ms) {
    return sleepAbortable(ms, this.ctl.signal);
  }

  /** Resolves true as soon as test() is true, or false after timeoutMs. */
  async until(test, timeoutMs, step = 100) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (test()) return true;
      await this.sleep(step);
    }
    return test();
  }

  async start(game, { language = 'en', rounds } = {}) {
    if (this.ctl) this.stop();
    const { io } = this;
    const L = TEXT[language] || TEXT.en;
    this.ctl = new AbortController();
    this.L = L;
    try {
      const needsHands = game === 'rock_paper_scissors' || game === 'simon_says';
      if ((needsHands && !io.gestures.running) || (game === 'make_a_face' && !io.faces.running)) {
        await this.say(L.needCamera);
        return;
      }
      if (game === 'rock_paper_scissors') await this.rps(Math.max(1, Math.min(7, rounds || 3)));
      else if (game === 'simon_says') await this.simon(Math.max(2, Math.min(10, rounds || 5)));
      else if (game === 'make_a_face') await this.makeFace(Math.max(1, Math.min(5, rounds || 3)));
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      this.ctl = null;
      io.mood('neutral');
      io.caption('');
      io.onEnd?.();
    }
  }

  // ---------------------------------------------------------------- rock paper scissors
  async rps(rounds) {
    const { io, L } = this;
    const score = { user: 0, me: 0 };
    io.mood('curious');
    await this.say(L.rpsIntro(rounds));
    let played = 0;
    let misses = 0;
    while (played < rounds && misses < 3) {
      const mine = MOVES[Math.floor(Math.random() * 3)]; // chosen before the countdown, revealed after her move
      io.caption(`${EMOJI.rock} ${EMOJI.paper} ${EMOJI.scissors}`);
      for (let i = 0; i < 3; i++) {
        tick();
        await this.sleep(350);
      }
      await this.say(L.rpsCount); // she shows her hand on "shoot", which is the end of this line
      go();
      io.caption('✊ ✋ ✌️');
      const shotAt = performance.now();
      await this.sleep(900);
      const move = dominantMove(this.framesSince(shotAt - 700));
      if (!move) {
        misses++;
        io.mood('confused');
        await this.say(L.noHand);
        continue;
      }
      const result = rpsOutcome(move, mine);
      played++;
      if (result === 'user') score.user++;
      else if (result === 'me') score.me++;
      io.clearCards();
      io.card(`${EMOJI[move]}  vs  ${EMOJI[mine]}`, `${score.user} – ${score.me}`);
      io.mood(result === 'user' ? 'surprised' : result === 'me' ? 'laughing' : 'curious');
      (result === 'user' ? good : result === 'me' ? bad : tick)();
      await this.say(`${L.mine(L.moves[mine])} ${result === 'user' ? L.win : result === 'me' ? L.lose : L.tie}`);
    }
    if (misses >= 3) {
      await this.say(L.rpsGaveUp);
      return;
    }
    await this.say(L.finalRps(score.user, score.me));
    io.report(`[Game over: rock paper scissors. Final score: the player ${score.user}, you ${score.me}, over ${played} rounds.]`);
  }

  // ---------------------------------------------------------------- simon says
  async simon(rounds) {
    const { io, L } = this;
    const keys = Object.keys(L.commands);
    let right = 0;
    io.mood('curious');
    await this.say(L.simonIntro(rounds));
    for (let r = 0; r < rounds; r++) {
      const key = keys[Math.floor(Math.random() * keys.length)];
      const trick = r > 0 && Math.random() < 0.3;
      // hands down first, so the previous gesture is not counted again
      await this.until(() => this.framesSince(performance.now() - 500).length >= 3 && this.framesSince(performance.now() - 500).every((f) => !f.names.length), 2500);
      const t0 = performance.now();
      io.caption(L.commands[key]);
      await this.say((trick ? '' : L.simonSays) + L.commands[key]);
      const from = Math.min(t0, performance.now() - 200);
      const did = await this.until(() => this.did(key, from), 4000);
      let ok;
      if (trick) {
        ok = !did;
        io.mood(ok ? 'happy' : 'laughing');
        (ok ? good : bad)();
        await this.say(ok ? L.trickPassed : L.trickCaught);
      } else {
        ok = did;
        io.mood(ok ? 'happy' : 'confused');
        (ok ? good : bad)();
        await this.say(ok ? L.simonOk : L.simonSlow);
      }
      if (ok) right++;
    }
    await this.say(L.final(right, rounds));
    io.report(`[Game over: Simon says. The player got ${right} of ${rounds} right.]`);
  }

  /** Has the gesture `key` been shown since time `from`? Still gestures need ~4 frames in a row; a wave is seen once. */
  did(key, from) {
    const frames = this.framesSince(from);
    if (key === 'wave') return frames.some((f) => f.names.includes('wave'));
    let run = 0;
    for (const f of frames) {
      run = f.names.includes(key) ? run + 1 : 0;
      if (run >= 4) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- make a face
  async makeFace(rounds) {
    const { io, L } = this;
    const targets = ['happy', 'surprised', 'sad'].sort(() => Math.random() - 0.5);
    while (targets.length < rounds) targets.push(targets[targets.length % 3]);
    let right = 0;
    io.mood('curious');
    await this.say(L.faceIntro(rounds));
    for (let r = 0; r < rounds; r++) {
      const target = targets[r];
      io.mood(target === 'happy' ? 'happy' : target === 'surprised' ? 'surprised' : 'neutral');
      io.caption(L.faces[target]);
      await this.say(L.makeFace(L.faces[target]));
      let streak = 0;
      const ok = await this.until(() => {
        streak = io.faces.biggestExpression() === target ? streak + 1 : 0;
        return streak >= 3;
      }, 6500, 250);
      io.mood(ok ? 'laughing' : 'confused');
      (ok ? good : bad)();
      await this.say(ok ? L.faceOk : L.faceMiss);
      if (ok) right++;
    }
    await this.say(L.final(right, rounds));
    io.report(`[Game over: make a face. The player matched ${right} of ${rounds} expressions.]`);
  }
}
