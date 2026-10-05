// ElevenLabs text-to-speech and speech-to-text (Scribe).
// Everything is read lazily from process.env so the .env file is the single source of truth.

import WebSocket from 'ws';
import * as settings from './settings.js';

const key = () => process.env.ELEVENLABS_API_KEY?.trim();
// Base URL is overridable only so the code can be tested against a local fake server.
const apiBase = () => (process.env.ELEVENLABS_API_BASE?.trim() || 'https://api.elevenlabs.io').replace(/\/$/, '');
const DEFAULT_VOICE = 'cgSgspJ2msm6clMCkdW9'; // "Jessica" premade voice
// The voice picked in the app wins over .env, which wins over the default.
const voiceId = () => settings.get('voice')?.id || process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE;
// eleven_v3 is the model that lists Georgian. Override with ELEVENLABS_TTS_MODEL if needed.
const ttsModel = () => process.env.ELEVENLABS_TTS_MODEL?.trim() || 'eleven_v3';
const sttModel = () => process.env.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v2';

export function voiceLive() {
  return Boolean(key()) && process.env.MOCK !== '1';
}

/** The voices this ElevenLabs account can use, plus the one in use. Needs the key's voices_read permission. */
export async function listVoices() {
  const current = voiceId();
  if (!voiceLive()) {
    return {
      current,
      mock: true,
      voices: [
        { id: 'mock-1', name: 'Demo voice (calm)', info: 'female · demo' },
        { id: 'mock-2', name: 'Demo voice (deep)', info: 'male · demo' },
      ],
    };
  }
  const r = await fetch(`${apiBase()}/v1/voices`, { headers: { 'xi-api-key': key() } });
  if (!r.ok) {
    const e = await failure('ElevenLabs voices', r);
    return { current, voices: [], error: r.status === 401 ? 'The ElevenLabs key is not allowed to list voices (enable "Voices: read" for the key), but you can paste a voice ID below.' : e.message };
  }
  const j = await r.json();
  const voices = (j.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    info: [v.labels?.gender, v.labels?.accent, v.labels?.age, v.labels?.descriptive || v.labels?.use_case, v.category && v.category !== 'premade' ? v.category : '']
      .filter(Boolean)
      .join(' · '),
  }));
  voices.sort((a, b) => a.name.localeCompare(b.name));
  return { current, voices };
}

export function setVoice(id, name = '') {
  const clean = String(id || '').trim();
  if (clean && !/^[A-Za-z0-9_-]{6,40}$|^mock-\d$/.test(clean)) throw new Error('That does not look like a voice ID');
  settings.set('voice', clean ? { id: clean, name: String(name).slice(0, 60) } : null);
  return voiceId();
}

export function voiceStatus() {
  const live = voiceLive();
  return { tts: live, stt: live };
}

async function failure(prefix, r) {
  let detail = '';
  try {
    const j = await r.json();
    detail = j?.detail?.message || j?.detail?.status || JSON.stringify(j.detail ?? j);
  } catch {
    /* ignore */
  }
  return new Error(`${prefix} ${r.status}${detail ? ': ' + detail : ''}`);
}

// ElevenLabs limits how many requests may run in parallel per plan (e.g. 3). A reply with several
// sentences would otherwise fire them all at once, so voice requests wait their turn here.
// Default 2 leaves a slot free for transcription. Raise it with ELEVENLABS_MAX_CONCURRENT.
const maxConcurrent = () => Math.max(1, Number(process.env.ELEVENLABS_MAX_CONCURRENT) || 2);
let active = 0;
const waiting = [];

async function acquire(signal) {
  if (signal?.aborted) throw new Error('aborted');
  if (active < maxConcurrent()) {
    active++;
    return;
  }
  await new Promise((resolve, reject) => {
    const w = { resolve, reject };
    waiting.push(w);
    signal?.addEventListener(
      'abort',
      () => {
        const i = waiting.indexOf(w);
        if (i >= 0) {
          waiting.splice(i, 1);
          reject(new Error('aborted'));
        }
      },
      { once: true },
    );
  });
}

function release() {
  const next = waiting.shift();
  if (next) next.resolve(); // hand our slot straight to the next waiter
  else active--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a Buffer of mp3 audio, or null in mock mode. Never runs more than the allowed requests at once. */
export async function synthesize(text, signal) {
  if (!voiceLive()) return null;
  await acquire(signal);
  try {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new Error('aborted');
      const r = await fetch(
        `${apiBase()}/v1/text-to-speech/${voiceId()}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: ttsModel() }),
          signal,
        },
      );
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      // Still over the limit (e.g. transcription running at the same time): back off and retry.
      if (r.status === 429 && attempt < 4) {
        console.warn('[tts] 429 from ElevenLabs, retrying (%d)', attempt);
        await sleep(500 * attempt);
        continue;
      }
      throw await failure('ElevenLabs voice', r);
    }
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Streaming voice. Eleven v4 Turbo is the low-latency model that lists Georgian, Swedish, Russian and Finnish.
// It is reached through the text-to-dialogue websocket. We relay its audio to the browser as raw PCM
// so playback can start within a fraction of a second, long before the whole sentence is synthesized.
// If streaming fails, the caller falls back to the standard (slower) request above.
// ---------------------------------------------------------------------------
const streamModel = () => process.env.ELEVENLABS_STREAM_MODEL?.trim() || 'eleven_v4_turbo';
const streamFormat = () => process.env.ELEVENLABS_STREAM_FORMAT?.trim() || 'pcm_24000';
export const streamSampleRate = () => Number((streamFormat().match(/^pcm_(\d+)$/) || [])[1]) || 0;

let streamFailures = 0;
let streamPausedUntil = 0;

/** Streaming is used when enabled, configured for PCM, and not paused after repeated failures. */
export function streamEnabled() {
  return (
    voiceLive() &&
    process.env.ELEVENLABS_STREAMING !== '0' &&
    streamSampleRate() > 0 &&
    Date.now() >= streamPausedUntil
  );
}

export function noteStreamResult(ok, err) {
  if (ok) {
    streamFailures = 0;
    return;
  }
  streamFailures++;
  console.warn('[tts] streaming failed (%d in a row): %s', streamFailures, err?.message || err);
  if (streamFailures >= 2) {
    streamPausedUntil = Date.now() + 5 * 60 * 1000;
    console.warn('[tts] pausing streaming for 5 minutes and using the standard voice (set ELEVENLABS_STREAMING=0 to silence this)');
    streamFailures = 0;
  }
}

/**
 * Streams PCM audio for `text`, calling onChunk(Buffer) as it arrives.
 * Resolves when the audio is complete; rejects if the stream fails (check whether any chunk arrived).
 */
export async function streamSynthesize(text, signal, onChunk) {
  await acquire(signal);
  const started = Date.now();
  let bytes = 0;
  let firstMs = 0;
  let closed = Promise.resolve(); // resolves when the socket has fully closed
  try {
    await new Promise((resolve, reject) => {
      const url = `${apiBase().replace(/^http/, 'ws')}/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(streamModel())}&output_format=${encodeURIComponent(streamFormat())}`;
      const ws = new WebSocket(url);
      closed = new Promise((r) => ws.once('close', r));
      let settled = false;
      let timer;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          err ? ws.terminate() : ws.close();
        } catch {
          /* already closed */
        }
        err ? reject(err) : resolve();
      };
      const onAbort = () => finish(new Error('aborted'));
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('timed out waiting for audio')), 15000);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      arm();

      ws.on('open', () => {
        ws.send(JSON.stringify({ voices: [voiceId()], xi_api_key: key() }));
        ws.send(JSON.stringify({ inputs: [{ text, voice_id: voiceId(), new_turn: false }] }));
        ws.send(JSON.stringify({ close_socket: true })); // flushes the buffered text, then closes
      });
      ws.on('message', (data) => {
        let m;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (m.error || m.detail || m.type === 'error') {
          return finish(new Error(`ElevenLabs stream error: ${JSON.stringify(m.error ?? m.detail ?? m).slice(0, 300)}`));
        }
        if (m.audio) {
          const buf = Buffer.from(m.audio, 'base64');
          if (buf.length) {
            if (!bytes) firstMs = Date.now() - started;
            bytes += buf.length;
            onChunk(buf);
            arm();
          }
        }
        if (m.is_final) finish();
      });
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => finish(new Error(`ElevenLabs stream HTTP ${res.statusCode}: ${body.slice(0, 300)}`)));
      });
      ws.on('error', (e) => finish(e));
      ws.on('close', (code, reason) =>
        bytes ? finish() : finish(new Error(`stream closed before any audio (code ${code} ${reason?.toString() || ''})`)),
      );
    });
    console.log('[tts] streamed %d bytes, first audio after %dms, total %dms', bytes, firstMs, Date.now() - started);
  } finally {
    // Hold the slot until the socket is really gone: ElevenLabs counts a closing connection too.
    await Promise.race([closed, sleep(400)]);
    release();
  }
}

const LANG_CODES = { georgian: 'kat', ka: 'kat', kat: 'kat', swedish: 'swe', sv: 'swe', swe: 'swe', russian: 'rus', ru: 'rus', rus: 'rus', finnish: 'fin', fi: 'fin', fin: 'fin', english: 'eng', en: 'eng', eng: 'eng' };

/**
 * Returns { text, language, uncertain }.
 * lang: "auto" | "english" | the language she is learning (e.g. "georgian", "swedish") — forcing the language
 * is the biggest accuracy win, because auto-detect often guesses wrong on short phrases.
 * terms: words she has been taught, used to bias recognition (retried without if the API rejects them).
 */
export async function transcribe(audio, mime, { lang = 'auto', langs = [], terms = [] } = {}) {
  if (!voiceLive()) return { text: process.env.MOCK_STT_TEXT || 'Hello! Can you teach me a new word?', language: 'eng', uncertain: false, mock: true };
  if (!audio?.length) throw new Error('No audio received');

  // The languages this household speaks. One language: force it (the biggest accuracy win). Several: let the service
  // guess, and only when it is unsure, try each of them and keep the transcript it was most confident about.
  const wanted = [...new Set((Array.isArray(langs) && langs.length ? langs : [lang]).map((l) => LANG_CODES[String(l).toLowerCase()]).filter(Boolean))];
  const keyterms =
    process.env.ELEVENLABS_KEYTERMS === '0'
      ? []
      : [...new Set(terms.map((t) => String(t).trim()).filter((t) => t && t.length <= 50 && t.split(/\s+/).length <= 5))].slice(-40);
  const ext = /mp4|aac/.test(mime || '') ? 'm4a' : /ogg/.test(mime || '') ? 'ogg' : 'webm';

  const call = (code, useTerms) => {
    const form = new FormData();
    form.append('model_id', sttModel());
    form.append('tag_audio_events', 'false');
    if (code) form.append('language_code', code);
    if (useTerms) for (const t of keyterms) form.append('keyterms', t);
    form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `speech.${ext}`);
    return fetch(`${apiBase()}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key() }, body: form });
  };

  /** One transcription, with the word-hints dropped if the service rejects them. */
  const run = async (code) => {
    let r = await call(code, keyterms.length > 0);
    if (!r.ok && keyterms.length && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      console.warn('[stt] request with keyterms rejected (%d), retrying without', r.status);
      r = await call(code, false);
    }
    if (!r.ok) throw await failure('ElevenLabs transcription', r);
    const j = await r.json();
    const words = (j.words || []).filter((w) => w.type === 'word' && Number.isFinite(w.logprob));
    const meanLogprob = words.length ? words.reduce((a, w) => a + w.logprob, 0) / words.length : null;
    const text = (j.text || '').trim();
    console.log('[stt] forced=%s detected=%s p=%s meanLogprob=%s text=%j', code || 'auto', j.language_code, j.language_probability?.toFixed?.(2), meanLogprob?.toFixed?.(2), text.slice(0, 80));
    return { text, language: j.language_code, prob: j.language_probability, meanLogprob, code };
  };

  let best = await run(wanted.length === 1 ? wanted[0] : null);
  const shaky = (x) => x.meanLogprob != null && x.meanLogprob < -0.8;
  if (wanted.length > 1) {
    const sure = wanted.includes(best.language) && (best.prob ?? 1) >= 0.85 && !shaky(best);
    if (!sure) {
      // Unsure: try every language this household speaks and keep the most confident transcript.
      const score = (x) => (x.text ? (x.meanLogprob ?? -3) : -9) + (wanted.includes(x.language) ? 0.05 : 0);
      // Most likely language first, and stop as soon as one transcript is clearly good (saves time and credit).
      const order = [...wanted].sort((a, b) => (a === best.language ? -1 : 0) - (b === best.language ? -1 : 0)).slice(0, 4);
      for (const code of order) {
        try {
          const t = await run(code);
          if (score(t) > score(best)) best = t;
          if (score(best) > -0.35) break;
        } catch (e) {
          console.warn('[stt] retry in %s failed: %s', code, e.message);
        }
      }
    }
  }
  const forced = best.code;
  const uncertain = (!forced && best.prob != null && best.prob < 0.75) || (best.meanLogprob != null && best.meanLogprob < -1.0);
  return { text: best.text, language: best.language, uncertain };
}
