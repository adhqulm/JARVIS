import './style.css';
import { createStage } from './stage.js';
import { UI } from './ui.js';
import { Speaker } from './speaker.js';
import { Mic, transcribe } from './mic.js';
import { Conductor } from './conductor.js';
import { Faces } from './faces.js';
import { Gestures } from './gestures.js';
import { store } from './store.js';
import { Timers, clock } from './timers.js';
import { GameManager } from './games.js';
import * as sound from './sound.js';
import { WakeWord, wakeSupported, matchName } from './wake.js';
import { VadWake } from './vadwake.js';
import { Music } from './music.js';
import { MOODS, STATES } from './eyes.js';

const $ = (s) => document.querySelector(s);
const MIN = 60 * 1000;

async function boot() {
  const status = await fetch('/api/status')
    .then((r) => r.json())
    .catch(() => ({ chat: false, tts: false, stt: false }));

  const stage = await createStage();
  const ui = new UI();
  const speaker = new Speaker();
  const mic = new Mic();
  const conductor = new Conductor({ stage, ui, speaker });
  const faces = new Faces({ video: $('#cam-video'), overlay: $('#cam-overlay') });
  const gestures = new Gestures({ video: $('#cam-video') });
  const { eyes } = stage;
  const timers = new Timers();
  let steps = null; // {title, list, i} while a recipe or instruction card is up
  let awake = false;
  let listening = false;
  let held = false;

  const modes = [];
  if (!status.chat) modes.push('demo brain');
  if (!status.tts) modes.push('demo voice');
  ui.setBadge(modes.length ? 'Demo mode: ' + modes.join(' + ') + ' (add keys to .env)' : '');

  // ---- one turn at a time: no talking over the companion (skip is the deliberate way out) ----
  let turnBusy = false;
  let transcribing = false;
  let gameActive = false;
  let gameToken = 0;
  const locked = () => turnBusy || transcribing || gameActive;
  const updateLock = () => ui.setLocked(locked(), turnBusy || gameActive);
  conductor.onBusy = (b) => {
    turnBusy = b;
    updateLock();
  };
  $('#skip').addEventListener('click', () => {
    gameToken++; // also cancels a game that is waiting to start
    games.stop();
    conductor.interrupt();
    if (gameActive && !games.active) {
      gameActive = false;
      updateLock();
    }
  });
  // Words that help speech recognition: your own list, the household's names, and what is on the lists and the board.
  let listTerms = [];
  const refreshListTerms = () =>
    fetch('/api/lists').then((r) => r.json()).then((d) => {
      listTerms = Object.values(d.lists || {}).flat().map((i) => i.text);
    }).catch(() => {});
  refreshListTerms();
  setInterval(refreshListTerms, 60000);
  const speechTerms = () =>
    [...new Set([...listTerms, ...store.vocab.split(',').map((s) => s.trim()), ...aliasList(), ...faces.profiles.map((p) => p.name), myName].filter(Boolean))].slice(-40); // the last ones win: names matter most
  const speechLangs = () => store.speechLangs.split(',').filter(Boolean);

  // ---- what the model is told about the camera on every turn ----
  conductor.context = () => {
    const s = faces.snapshot();
    const hour = new Date().getHours();
    const cur = steps && steps.list[steps.i];
    return {
      inView: s.ids,
      unknown: s.unknown,
      camera: s.camera,
      expressions: faces.expressions(),
      now: new Date().toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' }),
      late: hour >= 23 || hour < 5,
      timers: timers.list().slice(0, 10).map((t) => ({ label: t.label, remaining: t.remaining })),
      steps: steps ? { title: steps.title, index: steps.i + 1, total: steps.list.length, text: cur } : null,
    };
  };
  const names = () => [...faces.present].map((id) => faces.profile(id)?.name).filter(Boolean);

  // Eyes follow the loudness of whoever is making sound, and look at whoever is in front of the camera.
  stage.app.ticker.add(() => {
    eyes.setLevel(listening ? mic.level : speaker.level);
    eyes.setGaze(faces.gaze());
  });

  // ---- camera chip ----
  const chip = $('#cam-chip');
  let camState = 'off';
  function refreshChip() {
    const label = $('#cam-label');
    chip.classList.toggle('off', camState === 'off');
    chip.classList.toggle('warn', camState === 'loading');
    if (camState === 'off') label.textContent = 'Camera off';
    else if (camState === 'loading') label.textContent = 'Starting camera…';
    else {
      const n = names();
      label.textContent = n.length ? n.join(' & ') + (faces.unknownPresent ? ' + someone new' : '') : faces.unknownPresent ? 'Someone new' : 'Looking…';
    }
  }
  faces.onStatus = (s) => {
    camState = s;
    refreshChip();
  };
  faces.onError = (m) => console.warn('[camera]', m);

  async function setCamera(on) {
    if (on) {
      try {
        await faces.start();
        store.camera = true;
        gestures.start().catch((e) => {
          console.warn('[gestures] unavailable', e);
          ui.toast('Hand gestures are unavailable here, but faces still work.');
        });
      } catch (e) {
        console.error(e);
        store.camera = false;
        ui.toast(
          e?.name === 'NotAllowedError' ? 'Camera blocked. Allow camera access for this page in the browser and try again.' : 'Could not start the camera: ' + (e?.message || e),
        );
      }
    } else {
      gestures.stop();
      faces.stop();
      store.camera = false;
    }
    refreshChip();
  }
  chip.addEventListener('click', () => setCamera(!faces.running));

  // ---- reacting to people arriving ----
  const canSpeak = () => awake && !locked() && !listening;
  const greeted = new Map(); // profile id -> time
  const lastInView = new Map(); // profile id -> last time they were seen in front of the camera
  let lastStrangerAsk = 0;
  faces.onArrive = (p) => {
    refreshChip();
    wakeEyes();
    if (p) fetch(`/api/profiles/${p.id}/seen`, { method: 'POST' }).catch(() => {});
    if (!p) return;
    (async () => {
      if (await deliverBoard(p, 'just appeared in front of the camera')) return;
      // Only say hi if they have really been away: stepping out for a moment doesn't count.
      if (!canSpeak() || Date.now() - (lastInView.get(p.id) || 0) < store.greetAfter * MIN) return;
      greeted.set(p.id, Date.now());
      conductor.say(`[${p.name} just appeared in front of the camera. Greet them briefly, like a friend would. If your notes about them make for natural small talk you may use one.]`, { hidden: true });
    })();
  };

  // ---- the message board: pass things on when the person appears, then tick them off ----
  const boardBusy = new Set();
  async function deliverBoard(p, how) {
    if (boardBusy.has(p.id) || !canSpeak()) return false;
    boardBusy.add(p.id);
    try {
      const alone = faces.present.size === 1 && !faces.unknownPresent;
      const d = await fetch('/api/board/pending?to=' + encodeURIComponent(p.name)).then((r) => r.json()).catch(() => ({ messages: [] }));
      const msgs = (d.messages || []).filter((m) => !m.private || alone);
      if (!msgs.length || !canSpeak()) return false;
      const lines = msgs.map((m) => `- from ${m.from || 'someone in the house'}: ${m.text}`).join('\n');
      const done = await conductor.say(`[${p.name} ${how}. These messages were left for ${p.name}. Pass them on now, naturally, the way a friend would, saying who each one is from, and greet them briefly if you haven't just said hi:\n${lines}]`, { hidden: true });
      if (!done) return false; // interrupted: leave them on the board, they will be tried again
      for (const m of msgs) await fetch(`/api/board/${m.id}/done`, { method: 'POST' }).catch(() => {});
      greeted.set(p.id, Date.now());
      if (!$('#lists-panel').hidden) renderBoard();
      return true;
    } finally {
      boardBusy.delete(p.id);
    }
  }
  const checkBoard = () => {
    for (const id of faces.present) {
      const p = faces.profile(id);
      if (p && canSpeak()) deliverBoard(p, 'is here in front of the camera');
    }
  };
  setInterval(checkBoard, 15000);
  faces.onLeave = (p) => {
    if (p) lastInView.set(p.id, Date.now());
    refreshChip();
  };
  setInterval(() => {
    for (const id of faces.present) lastInView.set(id, Date.now()); // so an absence is measured from when they were last actually there
  }, 3000);

  // ---- how people look: the eyes mirror it; speaking about it is opt-in ----
  const MIRROR = { happy: 'happy', surprised: 'surprised', sad: 'encouraging' };
  const calm = (mood) => setTimeout(() => eyes.mood === mood && eyes.state === 'idle' && eyes.setMood('neutral'), 3000);
  const lastReact = new Map(); // profile id -> time of the last spoken comment
  faces.onExpression = (id, label) => {
    if (label !== 'neutral') wakeEyes();
    const mood = MIRROR[label];
    if (mood && eyes.state === 'idle' && !conductor.busy) {
      eyes.setMood(mood);
      calm(mood);
    }
    const p = faces.profile(id);
    if (!store.reactExpr || !p || label === 'neutral' || !canSpeak() || Date.now() - (lastReact.get(id) || 0) < 5 * MIN) return;
    lastReact.set(id, Date.now());
    conductor.say(`[${p.name} looks ${label} (a rough guess from the camera, which is often wrong). React in one short, natural sentence, the way a friend would. If it is a negative feeling, check in gently.]`, { hidden: true });
  };

  // ---- gestures ----
  const GESTURES = {
    wave: ['waved at the camera', 'laughing'],
    thumbs_up: ['gave a thumbs up', 'happy'],
    thumbs_down: ['gave a thumbs down', 'confused'],
    peace: ['made a peace sign', 'happy'],
  };
  gestures.onGesture = ({ name }) => {
    wakeEyes();
    if (alarm && (name === 'wave' || name === 'thumbs_up')) return stopAlarm();
    if (steps && !gameActive) {
      if (name === 'thumbs_up') return goStep(1, true);
      if (name === 'thumbs_down') return goStep(-1, true);
      if (name === 'wave') return goStep(0, true);
    }
    const g = GESTURES[name];
    if (!g || !awake || gameActive) return;
    const who = names().length === 1 ? names()[0] : names().length > 1 ? names().join(' or ') : 'Someone';
    if (eyes.state === 'idle' && !conductor.busy) {
      eyes.setMood(g[1]);
      calm(g[1]);
    }
    if (!canSpeak()) return;
    conductor.say(`[${who} ${g[0]}. React briefly and naturally, like a friend would${name === 'wave' ? ' (say hi back)' : ''}.]`, { hidden: true });
  };
  faces.onUnknown = (on) => {
    refreshChip();
    if (on) wakeEyes();
    if (!on || !canSpeak() || Date.now() - lastStrangerAsk < 3 * MIN) return;
    lastStrangerAsk = Date.now();
    conductor.say("[Someone you don't recognise just appeared in front of the camera. Say hi and ask who they are.]", { hidden: true });
  };

  // ---- the model asks to learn a face (it has asked the person first) ----
  const idle = async (ms = 10000) => {
    const t0 = Date.now();
    while (conductor.busy && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200));
  };
  conductor.onLearnFace = async (name) => {
    try {
      ui.toast(`Learning ${name}'s face… please look at the camera.`);
      const p = await faces.enroll(name);
      greeted.set(p.id, Date.now());
      ui.toast(`Learned ${p.name}. You can remove anyone under People.`);
      await idle();
      conductor.say(`[The app saved ${p.name}'s face. Say a quick friendly confirmation.]`, { hidden: true });
    } catch (e) {
      ui.toast(e.message);
      await idle();
      conductor.say(`[The app could not learn the face: ${e.message}. Tell them briefly and suggest they look straight at the camera, alone in view, if they want to try again.]`, { hidden: true });
    }
  };

  // ---- games (they run in the browser; the model only starts them and hears the result) ----
  const games = new GameManager({
    speaker,
    gestures,
    faces,
    caption: (t) => ui.setCaption(t),
    card: (title, text) => {
      ui.addCard({ target: title, english: text });
      stage.setCompact(true);
    },
    clearCards: () => ui.clearContent(),
    mood: (m) => eyes.setMood(m),
    report: (text) => conductor.say(text, { hidden: true }),
    onEnd: () => {
      gameActive = false;
      updateLock();
    },
  });

  // ---- timers and the alarm ----
  const timersEl = $('#timers');
  const alarmEl = $('#alarm');
  let alarm = null; // {label, say, rings, iv}
  let pendingSpeech = null;

  function renderTimers() {
    const items = timers.list();
    const have = new Map([...timersEl.children].map((c) => [c.dataset.id, c]));
    for (const t of items) {
      let el = have.get(t.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'timer-chip';
        el.dataset.id = t.id;
        el.title = 'Click to cancel this timer';
        el.innerHTML = '<span class="l"></span><span class="t"></span><span class="x">✕</span>';
        el.addEventListener('click', () => timers.remove(t.id));
        timersEl.appendChild(el);
      }
      have.delete(t.id);
      el.querySelector('.l').textContent = t.label;
      el.querySelector('.t').textContent = clock(t.remaining);
      el.classList.toggle('soon', t.remaining <= 10);
    }
    for (const el of have.values()) el.remove();
  }
  timers.onTick = renderTimers;

  function stopAlarm() {
    if (!alarm) return;
    clearInterval(alarm.iv);
    alarm = null;
    alarmEl.hidden = true;
    pendingSpeech = null;
  }
  const speakAlarm = () => {
    if (!alarm || gameActive || listening) return;
    if (!awake) {
      pendingSpeech = true;
      return;
    }
    eyes.setMood('surprised');
    conductor.replay(alarm.say);
  };
  timers.onDue = (t) => {
    stopAlarm();
    alarm = { label: t.label, say: t.say || `${t.label} is done!`, rings: 0 };
    alarmEl.textContent = `⏰ ${t.label}  ·  tap to dismiss`;
    alarmEl.hidden = false;
    const ring = () => {
      if (!alarm) return;
      if (alarm.rings++ >= 4) return stopAlarm();
      sound.alarm();
      if (alarm.rings > 1) speakAlarm();
    };
    sound.alarm();
    alarm.rings = 1;
    speakAlarm();
    alarm.iv = setInterval(ring, 25000);
  };
  alarmEl.addEventListener('click', stopAlarm);
  renderTimers();

  // ---- recipe / instruction steps, driven by buttons, gestures or the model ----
  function showStep() {
    ui.setSteps({ title: steps.title, index: steps.i + 1, total: steps.list.length, text: steps.list[steps.i] }, { onPrev: () => goStep(-1, true), onNext: () => goStep(1, true), onClose: () => closeSteps() });
    stage.setCompact(true);
  }
  function goStep(delta, speak) {
    if (!steps) return;
    const next = Math.max(0, Math.min(steps.list.length - 1, steps.i + delta));
    const changed = next !== steps.i;
    steps.i = next;
    showStep();
    if (speak && awake && !gameActive) {
      eyes.setMood('neutral');
      conductor.replay(!changed && delta ? (delta > 0 ? 'That was the last step.' : 'That is the first step.') : steps.list[steps.i]);
    }
  }
  function closeSteps() {
    if (!steps) return;
    steps = null;
    gestures.resetCooldowns();
    ui.setSteps(null);
    if (!ui.cards.children.length) stage.setCompact(false);
  }
  ui.onClearContent = () => {
    if (steps) {
      steps = null;
      gestures.resetCooldowns();
    }
  };

  // ---- tools the model calls that live in the browser ----
  // ---- music: songs through YouTube's embedded player, radio through an audio element ----
  const musicEl = $('#music');
  const music = new Music({
    host: $('#music-yt'),
    store,
    onNotice: (m) => ui.toast(m),
    onChange: () => {
      const cur = music.current;
      musicEl.hidden = !cur;
      musicEl.dataset.kind = cur?.kind || '';
      musicEl.dataset.show = store.musicShow ? '1' : '0';
      $('#music-title').textContent = cur ? `${cur.kind === 'radio' ? '📻' : '♪'} ${cur.title}${cur.by ? ' · ' + cur.by : ''}` : '';
      $('#music-play').textContent = music.playing ? '⏸' : '▶';
      $('#music-vol').value = String(music.volume);
    },
  });
  $('#music-play').addEventListener('click', () => (music.playing ? music.pause() : music.resume()));
  $('#music-next').addEventListener('click', () => music.next());
  $('#music-prev').addEventListener('click', () => music.previous());
  $('#music-stop').addEventListener('click', () => music.stop());
  $('#music-eye').addEventListener('click', () => {
    store.musicShow = !store.musicShow;
    music.onChange();
  });
  $('#music-vol').addEventListener('input', (e) => (music.volume = Number(e.target.value)));
  // The music steps back (to 15%) whenever someone is talking to me, I'm thinking or talking, or an alarm rings.
  setInterval(() => music.duck(listening || !!alarm || ['listening', 'thinking', 'speaking'].includes(eyes.state)), 150);

  conductor.onTool = (name, input) => {
    if (name === 'play_music') return music.start(input.queue);
    if (name === 'music_control') return music.control(input.action, input.level);
    if (name === 'set_timer') {
      const t = timers.add({ label: input.label, seconds: input.seconds, say: input.say_when_done });
      renderTimers();
      return t;
    }
    if (name === 'cancel_timer') return timers.cancel(input.label);
    if (name === 'show_steps') {
      const list = (Array.isArray(input.steps) ? input.steps : []).map((x) => String(x).slice(0, 220)).filter(Boolean).slice(0, 14);
      if (!list.length) return;
      steps = { title: String(input.title || 'Steps').slice(0, 60), list, i: 0 };
      gestures.cooldowns.default = 2500;
      gestures.cooldowns.wave = 2500;
      showStep();
      return;
    }
    if (name === 'step_nav') {
      const a = input.action;
      if (a === 'close') closeSteps();
      else goStep(a === 'next' ? 1 : a === 'back' ? -1 : 0, false);
      return;
    }
    if (name === 'start_game') {
      const token = ++gameToken;
      gameActive = true;
      updateLock();
      idle(20000).then(() => {
        if (token !== gameToken) return;
        games.start(input.game, { language: input.language === 'sv' ? 'sv' : 'en', rounds: input.rounds }).catch((e) => {
          console.warn('[game]', e);
          gameActive = false;
          updateLock();
        });
      });
    }
  };

  // ---- sleeping when nobody is around, waking when someone shows up ----
  let lastSeen = Date.now();
  const wakeEyes = () => {
    lastSeen = Date.now();
    if (eyes.state === 'asleep' && awake) {
      eyes.setState('idle');
      eyes.setMood('surprised');
      setTimeout(() => eyes.mood === 'surprised' && eyes.state === 'idle' && eyes.setMood('neutral'), 1500);
    }
  };
  setInterval(() => {
    if (faces.present.size || faces.unknownPresent || !faces.running) lastSeen = Date.now();
    const quiet = Date.now() - lastSeen > 5 * MIN;
    if (awake && quiet && faces.running && !conductor.busy && !locked() && !listening && !alarm && !timers.items.length && eyes.state === 'idle') eyes.setState('asleep');
  }, 5000);

  // ---- waking up ----
  function greeting() {
    const n = names();
    n.forEach((nm) => {
      const p = faces.profiles.find((x) => x.name === nm);
      if (p) greeted.set(p.id, Date.now());
    });
    if (n.length) return `[The app was just opened and ${n.join(' and ')} ${n.length > 1 ? 'are' : 'is'} in front of the camera. Greet ${n.length > 1 ? 'them' : 'them by name'} warmly in one short sentence.]`;
    if (faces.unknownPresent) {
      lastStrangerAsk = Date.now();
      return "[The app was just opened and someone you don't recognise is in front of the camera. Say hi in one short sentence and ask who they are.]";
    }
    return '[The app was just opened. Greet whoever is there warmly in one short sentence and ask what is up. The camera is ' + (faces.running ? 'on but you do not see anyone yet' : 'off') + '.]';
  }

  function wake({ greet = true } = {}) {
    if (awake) return;
    awake = true;
    $('#wake').classList.add('gone');
    speaker.ensure();
    eyes.setState('idle');
    eyes.setMood('happy');
    setTimeout(() => eyes.setMood('neutral'), 1800);
    mic.prepare().catch(() => {}); // open the mic now so the first press doesn't clip the first word
    if (pendingSpeech && alarm) setTimeout(speakAlarm, 400);
    else if (greet) conductor.say(greeting(), { hidden: true });
  }

  // ---- typing ----
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#text');
    const text = input.value.trim();
    if (!text || locked()) return;
    stopAlarm();
    input.value = '';
    wake({ greet: false });
    conductor.say(text);
  });

  // ---- push-to-talk ----
  async function startTalk() {
    if (listening || locked()) return;
    stopAlarm();
    wake({ greet: false });
    conductor.interrupt();
    try {
      await mic.start();
    } catch (e) {
      console.error(e);
      ui.toast('Microphone unavailable. Allow microphone access for this page and try again.');
      held = false;
      return;
    }
    if (!held) {
      await mic.stop();
      return;
    }
    listening = true;
    eyes.setState('listening');
    ui.setMicActive(true);
    ui.setCaption('Listening…', 'hint');
  }

  async function stopTalk() {
    if (!listening) return;
    listening = false;
    ui.setMicActive(false);
    transcribing = true;
    updateLock();
    try {
      await finishTalk();
    } finally {
      transcribing = false;
      updateLock();
    }
  }

  async function finishTalk() {
    const { blob, seconds } = await mic.stop();
    if (seconds < 0.5 || blob.size < 1000) {
      eyes.setState('idle');
      ui.setCaption('Hold the mic button (or Space) while you talk.', 'hint');
      return;
    }
    eyes.setState('thinking');
    ui.setCaption('…', 'hint');
    try {
      const { text, uncertain } = await transcribe(blob, { lang: 'auto', langs: speechLangs(), terms: speechTerms() });
      if (!text) {
        eyes.setState('idle');
        ui.setCaption("I didn't catch that. Try again, or type it.", 'hint');
        eyes.setMood('confused');
        setTimeout(() => eyes.state !== 'asleep' && eyes.mood === 'confused' && eyes.setMood('neutral'), 2500);
        return;
      }
      conductor.say(text, { uncertain, hidden: true }); // the transcript is trusted, so it is not echoed on screen
    } catch (e) {
      ui.toast(e.message);
      eyes.setState('idle');
    }
  }

  const micBtn = $('#mic');
  micBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    held = true;
    startTalk();
  });
  const release = () => {
    held = false;
    stopTalk();
  };
  micBtn.addEventListener('pointerup', release);
  micBtn.addEventListener('pointerleave', () => held && release());

  const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || typing()) return;
    e.preventDefault();
    if (!awake) return wake();
    if (locked()) return;
    held = true;
    startTalk();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || typing()) return;
    release();
  });
  window.addEventListener('pointerdown', (e) => {
    if (!awake && !e.target.closest('#dock, #topbar, #people-panel, #lists-panel, #voice-panel, #timers, #alarm')) wake();
  });

  // ---- people panel: see and delete what is stored ----
  const panel = $('#people-panel');
  const list = $('#people-list');
  const closePanel = () => (panel.hidden = true);
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'never');

  async function renderPeople() {
    await faces.reload().catch(() => {});
    list.textContent = '';
    if (!faces.profiles.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = "I don't know anyone yet. Turn the camera on and introduce yourself.";
      list.appendChild(e);
      return;
    }
    for (const p of faces.profiles) {
      const card = document.createElement('div');
      card.className = 'person';
      const head = document.createElement('div');
      head.className = 'person-head';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${p.descriptors.length} face samples · last seen ${when(p.lastSeen)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Forget this person';
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          del.textContent = 'Really forget everything?';
          setTimeout(() => ((armed = false), (del.textContent = 'Forget this person')), 4000);
          return;
        }
        await fetch('/api/profiles/' + p.id, { method: 'DELETE' });
        greeted.delete(p.id);
        await renderPeople();
        refreshChip();
      });
      head.append(nm, meta, del);
      card.appendChild(head);
      const ul = document.createElement('ul');
      if (!p.notes.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = 'No notes yet.';
        card.appendChild(e);
      }
      p.notes.forEach((n, i) => {
        const li = document.createElement('li');
        const t = document.createElement('span');
        t.textContent = n.text;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✕';
        x.title = 'Delete this note';
        x.addEventListener('click', async () => {
          await fetch(`/api/profiles/${p.id}/notes/${i}`, { method: 'DELETE' });
          renderPeople();
        });
        li.append(t, x);
        ul.appendChild(li);
      });
      if (p.notes.length) card.appendChild(ul);
      list.appendChild(card);
    }
  }

  const memBtn = $('#mem-clear');
  let memArmed = false;
  memBtn.addEventListener('click', async () => {
    if (!memArmed) {
      memArmed = true;
      memBtn.textContent = 'Really forget all past chats?';
      setTimeout(() => ((memArmed = false), (memBtn.textContent = 'Forget our past chats')), 4000);
      return;
    }
    memArmed = false;
    await fetch('/api/memory', { method: 'DELETE' });
    memBtn.textContent = 'Forgotten';
    setTimeout(() => (memBtn.textContent = 'Forget our past chats'), 2000);
  });

  $('#people-btn').addEventListener('click', async () => {
    $('#preview-toggle').checked = store.preview;
    $('#react-toggle').checked = store.reactExpr;
    $('#greet-after').value = String(store.greetAfter);
    panel.hidden = false;
    await renderPeople();
  });
  $('#people-close').addEventListener('click', closePanel);
  panel.addEventListener('pointerdown', (e) => e.target === panel && closePanel());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closePanel());
  $('#people-add').addEventListener('click', async () => {
    closePanel();
    if (!faces.running) await setCamera(true);
    if (!faces.running) return;
    wake({ greet: false });
    conductor.say('[Someone wants you to learn their face. Ask for their name and whether it is fine for you to remember their face.]', { hidden: true });
  });

  // ---- shared lists panel ----
  const lpanel = $('#lists-panel');
  const lbody = $('#lists-body');
  const closeLists = () => (lpanel.hidden = true);
  async function renderLists() {
    const data = await fetch('/api/lists').then((r) => r.json()).catch(() => ({}));
    const all = data.lists || data;
    lbody.textContent = '';
    const names = Object.keys(all || {}).filter((n) => (all[n] || []).length);
    if (!names.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No lists yet. Try saying "add milk to the shopping list".';
      lbody.appendChild(e);
    }
    for (const n of names) {
      const block = document.createElement('div');
      block.className = 'list-block';
      const h = document.createElement('h4');
      h.textContent = n;
      const ul = document.createElement('ul');
      for (const it of all[n]) {
        const li = document.createElement('li');
        const t = document.createElement('span');
        t.textContent = it.text;
        li.appendChild(t);
        if (it.by) {
          const by = document.createElement('small');
          by.textContent = it.by;
          li.appendChild(by);
        }
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✓ done';
        x.addEventListener('click', async () => {
          await fetch(`/api/lists/${encodeURIComponent(n)}/items/${it.id}`, { method: 'DELETE' });
          renderLists();
        });
        li.appendChild(x);
        ul.appendChild(li);
      }
      block.append(h, ul);
      lbody.appendChild(block);
    }
  }
  async function renderBoard() {
    const d = await fetch('/api/board').then((r) => r.json()).catch(() => ({ messages: [] }));
    const box = $('#board-body');
    box.textContent = '';
    const ms = (d.messages || []).slice().sort((a, b) => (a.doneAt ? 1 : 0) - (b.doneAt ? 1 : 0) || b.at - a.at);
    const shown = [...ms.filter((m) => !m.doneAt), ...ms.filter((m) => m.doneAt).slice(0, 4)];
    if (!shown.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No messages waiting.';
      box.appendChild(e);
    }
    for (const m of shown) {
      const row = document.createElement('div');
      row.className = 'board-item' + (m.doneAt ? ' done' : '');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = (m.doneAt ? '✓ ' : '') + m.to;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = m.text + (m.private ? ' (private)' : '');
      const meta = document.createElement('small');
      meta.textContent = (m.from ? 'from ' + m.from + ' · ' : '') + new Date(m.doneAt || m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (m.doneAt ? ' delivered' : '');
      row.append(who, what, meta);
      if (!m.doneAt) {
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✕';
        x.title = 'Cancel this message';
        x.addEventListener('click', async () => {
          await fetch('/api/board/' + m.id, { method: 'DELETE' });
          renderBoard();
        });
        row.appendChild(x);
      }
      box.appendChild(row);
    }
  }
  $('#board-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = $('#board-to').value.trim();
    const text = $('#board-text').value.trim();
    if (!to || !text) return;
    const r = await fetch('/api/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text, from: names_(), private: $('#board-private').checked }) });
    if (!r.ok) return ui.toast((await r.json().catch(() => ({}))).error || 'Could not save that message.');
    $('#board-text').value = '';
    renderBoard();
    checkBoard(); // if they are standing right there, say it now
  });
  $('#lists-btn').addEventListener('click', () => {
    lpanel.hidden = false;
    renderBoard();
    renderLists();
  });
  $('#lists-close').addEventListener('click', closeLists);
  lpanel.addEventListener('pointerdown', (e) => e.target === lpanel && closeLists());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closeLists());
  $('#list-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#list-new-name').value.trim() || 'shopping';
    const text = $('#list-new-item').value.trim();
    if (!text) return;
    await fetch(`/api/lists/${encodeURIComponent(name)}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, by: names_() }) });
    $('#list-new-item').value = '';
    renderLists();
  });
  const names_ = () => (names().length === 1 ? names()[0] : '');

  // ---- voice picker (the choice is saved on the server, so everyone in the house hears it) ----
  const vpanel = $('#voice-panel');
  const vsel = $('#voice-select');
  const vmsg = $('#voice-msg');
  const closeVoice = () => (vpanel.hidden = true);
  let voicesReady = false;
  async function saveVoice(id, name) {
    const r = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }) });
    if (!r.ok) {
      vmsg.textContent = (await r.json().catch(() => ({}))).error || 'Could not save that voice.';
      return false;
    }
    vmsg.textContent = '';
    if (!locked()) {
      wake({ greet: false });
      conductor.replay("Hi! This is how I sound now. Do you like it?");
    }
    return true;
  }
  let myName = '';
  const loadName = () =>
    fetch('/api/name').then((r) => r.json()).then((d) => {
      myName = d.name || '';
      $('#name-input').value = myName;
    }).catch(() => {});
  $('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = await fetch('/api/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#name-input').value }) }).then((r) => r.json()).catch(() => null);
    if (!d) return;
    myName = d.name;
    $('#name-input').value = myName;
    if (!myName && hf?.running) setHandsFree(false);
    refreshHf();
    if (myName && !locked()) {
      wake({ greet: false });
      conductor.replay(`Hey! My name is ${myName}. Say hey ${myName} any time.`);
    }
  });
  loadName();
  // ---- hands-free: say the name (optionally with "hey"), then the request ----
  let hf = null; // the engine doing the listening: the browser's speech service or ElevenLabs (see buildHf)
  const hfBtn = $('#hf-btn');
  const aliasList = () => store.aliases.split(',').map((s) => s.trim()).filter(Boolean);
  let armedUntil = 0; // after the name alone, the next thing said is the request
  let armTimer = null;
  let deafUntil = 0; // ignore what the microphone hears while (and just after) it talks, so it never answers itself
  let viaVoice = false;
  const refreshHf = () => {
    hfBtn.classList.toggle('on', Boolean(hf?.running));
    hfBtn.textContent = hf?.running && myName ? `Say “${myName}”` : 'Hands-free';
  };
  const disarm = () => {
    if (Date.now() < armedUntil) return;
    armedUntil = 0;
    if (hf) hf.openUntil = 0;
    if (eyes.state === 'listening' && !listening && !conductor.busy) {
      eyes.setState('idle');
      ui.setCaption('');
    }
  };
  const arm = (ms = 8000, { quiet = false } = {}) => {
    armedUntil = Date.now() + ms;
    if (hf) hf.openUntil = armedUntil;
    if (['idle', 'asleep'].includes(eyes.state)) eyes.setState('listening');
    if (!quiet) {
      sound.beep({ freq: 1175, dur: 0.08, gain: 0.08 });
      ui.setCaption("I'm listening…", 'hint');
    }
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, ms + 100);
  };
  const hfDeaf = () => !awake || locked() || listening || Date.now() < deafUntil;
  function sendVoice(text) {
    armedUntil = 0;
    if (hf) hf.openUntil = 0;
    stopAlarm();
    viaVoice = true;
    conductor.say(text, { hidden: true });
  }
  const onHfFinal = (alts) => {
    if (hfDeaf()) return;
    const known = [myName, ...aliasList()].filter(Boolean);
    for (const t of alts) {
      const m = matchName(t, known);
      if (!m.hit) continue;
      wakeEyes();
      if (m.rest) sendVoice(m.rest);
      else arm();
      return;
    }
    if (Date.now() < armedUntil) sendVoice(alts[0]);
  };
  const onHfError = (m, kind) => {
    if (kind === 'network' && store.listenEngine !== 'browser') {
      // The browser's speech service is unreachable (Brave, the desktop app, a firewall...): carry on with ElevenLabs.
      store.browserSpeechFailed = true;
      ui.toast("The browser's speech service isn't reachable, so I'll listen through ElevenLabs instead.");
      if (store.handsFree && myName) {
        hf = buildHf();
        hf.start(store.listenLang);
      }
      return;
    }
    ui.toast(m);
    store.handsFree = false;
    refreshHf();
  };
  // ---- the wake word model that runs on this computer ----
  const PRETRAINED = /^(hey_jarvis|alexa|hey_mycroft|hey_rhasspy|timer|weather)/;
  const wakeModels = { list: [], pick: '' };
  const nameFromModel = (m) =>
    m
      .replace(/^hey_/, '')
      .replace(/_v?\d+(\.\d+)*$/, '')
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  async function loadWakeModels() {
    const d = await fetch('/api/wakemodels').then((r) => r.json()).catch(() => ({ models: [] }));
    wakeModels.list = d.models || [];
    // Your own trained model beats the ready-made ones.
    wakeModels.pick = wakeModels.list.includes(store.wakeModel) ? store.wakeModel : wakeModels.list.find((m) => !PRETRAINED.test(m)) || wakeModels.list[0] || '';
    const sel = $('#wake-model');
    sel.textContent = '';
    for (const m of wakeModels.list) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = `Wake word: “${PRETRAINED.test(m) && !m.startsWith('hey_') ? '' : m.startsWith('hey_') ? 'hey ' : ''}${nameFromModel(m)}”`;
      sel.appendChild(o);
    }
    if (!wakeModels.list.length) sel.innerHTML = '<option value="">No wake word model found</option>';
    sel.value = wakeModels.pick;
  }
  const wakeReady = loadWakeModels();
  const engineKind = () => {
    const e = store.listenEngine;
    if (e === 'auto') return wakeModels.pick ? 'ondevice' : useBrowserSpeech() ? 'browser' : 'elevenlabs';
    return e;
  };
  const onWake = () => {
    wakeEyes();
    arm(8000);
  };
  const useBrowserSpeech = () => wakeSupported && store.listenEngine !== 'elevenlabs' && !(store.listenEngine === 'auto' && store.browserSpeechFailed);
  function buildHf() {
    const kind = engineKind();
    let e;
    if (kind === 'browser' && wakeSupported) e = new WakeWord();
    else {
      e = new VadWake();
      if (kind === 'ondevice' && wakeModels.pick) {
        const model = wakeModels.pick;
        e.detectorFactory = async () => (await import('./openwake.js')).OnnxWake.create({ modelUrl: `/wakeword/${model}.onnx` });
        e.threshold = store.wakeThreshold;
        e.onWake = onWake;
        if (new URLSearchParams(location.search).has('debug')) e.onScore = (s) => s > 0.2 && console.debug('[wake]', s.toFixed(2));
      }
    }
    e.onFinal = onHfFinal;
    e.onError = onHfError;
    e.onState = refreshHf;
    e.onNotice = (m) => ui.toast(m);
    e.gate = () => !hfDeaf();
    e.getTerms = speechTerms;
    e.getLangs = speechLangs;
    return e;
  }
  const prevBusy = conductor.onBusy;
  conductor.onBusy = (b) => {
    prevBusy(b);
    if (b) return;
    deafUntil = Date.now() + 900;
    if (viaVoice && hf?.running) {
      viaVoice = false;
      arm(8000, { quiet: true }); // keep the conversation going without repeating the name
    }
  };
  async function setHandsFree(on) {
    if (on) {
      await wakeReady;
      if (!myName && engineKind() === 'ondevice' && wakeModels.pick) {
        // The wake word model fixes the name, so use it until you choose another.
        const d = await fetch('/api/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameFromModel(wakeModels.pick) }) }).then((r) => r.json()).catch(() => null);
        if (d?.name) {
          myName = d.name;
          $('#name-input').value = myName;
          ui.toast(`I'll answer to ${myName}. You can rename me under Voice.`);
        }
      }
      if (!myName) {
        ui.toast('Give me a name first (Voice button), then I can listen for it.');
        $('#voice-btn').click();
        return;
      }
      wake({ greet: false });
      store.handsFree = true;
      hf?.stop();
      hf = buildHf();
      hf.start(store.listenLang);
    } else {
      hf?.stop();
      store.handsFree = false;
      armedUntil = 0;
      disarm();
    }
    refreshHf();
  }
  hfBtn.addEventListener('click', () => setHandsFree(!hf?.running));
  $('#listen-lang').value = store.listenLang;
  $('#listen-lang').addEventListener('change', (e) => {
    store.listenLang = e.target.value;
    hf?.setLang(e.target.value);
  });
  $('#wake-sens').value = String(store.wakeThreshold);
  $('#wake-sens').addEventListener('change', (e) => {
    store.wakeThreshold = Number(e.target.value);
    if (hf?.running) setHandsFree(true);
  });
  $('#wake-model').addEventListener('change', (e) => {
    store.wakeModel = e.target.value;
    wakeModels.pick = e.target.value;
    if (hf?.running) setHandsFree(true);
  });
  $('#listen-engine').value = store.listenEngine;
  $('#listen-engine').addEventListener('change', (e) => {
    store.listenEngine = e.target.value;
    if (e.target.value === 'browser') store.browserSpeechFailed = false; // try the browser again
    if (hf?.running) setHandsFree(true);
  });
  $('#vocab-input').value = store.vocab;
  $('#vocab-input').addEventListener('change', (e) => (store.vocab = e.target.value));
  for (const cb of document.querySelectorAll('.langs input')) {
    cb.checked = speechLangs().includes(cb.dataset.lang);
    cb.addEventListener('change', () => {
      const picked = [...document.querySelectorAll('.langs input')].filter((x) => x.checked).map((x) => x.dataset.lang);
      if (!picked.length) {
        cb.checked = true; // at least one
        return;
      }
      store.speechLangs = picked.join(',');
    });
  }
  $('#alias-input').value = store.aliases;
  $('#alias-input').addEventListener('change', (e) => (store.aliases = e.target.value));
  Promise.all([loadName(), wakeReady]).then(() => {
    refreshHf();
    if (store.handsFree && myName) {
      hf = buildHf();
      hf.start(store.listenLang); // it only reacts once the page has been woken
    }
  });

  async function loadVoices() {
    voicesReady = false;
    vsel.textContent = '';
    vmsg.textContent = 'Loading voices…';
    const d = await fetch('/api/voices').then((r) => r.json()).catch(() => ({ voices: [], error: 'Could not reach the server.' }));
    vmsg.textContent = d.error || (d.mock ? 'Demo mode: add an ElevenLabs key to .env to hear real voices.' : '');
    const list = d.voices || [];
    if (d.current && !list.some((v) => v.id === d.current)) list.unshift({ id: d.current, name: 'Current voice', info: d.current });
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.info ? `${v.name}  (${v.info})` : v.name;
      o.dataset.name = v.name;
      vsel.appendChild(o);
    }
    if (d.current) vsel.value = d.current;
    voicesReady = true;
  }
  $('#voice-btn').addEventListener('click', () => {
    vpanel.hidden = false;
    loadVoices();
  });
  $('#voice-close').addEventListener('click', closeVoice);
  vpanel.addEventListener('pointerdown', (e) => e.target === vpanel && closeVoice());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closeVoice());
  vsel.addEventListener('change', () => voicesReady && saveVoice(vsel.value, vsel.selectedOptions[0]?.dataset.name));
  $('#voice-custom').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#voice-custom-id').value.trim();
    if (!id) return;
    if (await saveVoice(id, 'Custom voice')) {
      $('#voice-custom-id').value = '';
      loadVoices();
    }
  });

  const applyPreview = () => {
    $('#cam-preview').hidden = !store.preview;
    faces.setPreview(store.preview);
  };
  $('#greet-after').addEventListener('change', (e) => (store.greetAfter = Number(e.target.value)));
  $('#react-toggle').addEventListener('change', (e) => (store.reactExpr = e.target.checked));
  $('#preview-toggle').addEventListener('change', (e) => {
    store.preview = e.target.checked;
    applyPreview();
  });
  applyPreview();

  // Turn the camera back on if it was on last time (the browser remembers the permission).
  if (store.camera) setCamera(true);

  // ---- debug panel (?debug) ----
  if (new URLSearchParams(location.search).has('debug')) {
    const dbg = $('#debug');
    dbg.hidden = false;
    const section = (title) => {
      const h = document.createElement('h4');
      h.textContent = title;
      dbg.appendChild(h);
    };
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      dbg.appendChild(b);
    };
    section('Eye state');
    STATES.forEach((s) => btn(s, () => eyes.setState(s)));
    section('Mood');
    Object.keys(MOODS).forEach((m) => btn(m, () => eyes.setMood(m)));
    btn('clear', () => conductor.applyTool('clear_screen'));
  }

  // Handy for debugging in the console and for automated tests.
  window.companion = { music, stage, ui, speaker, conductor, faces, gestures, wake, timers, games, get steps() { return steps; }, get hf() { return hf; } };
}

boot();
