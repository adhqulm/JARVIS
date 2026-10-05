import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamReply, chatAvailable, companionName } from './companion.js';
import * as settings from './settings.js';
import * as memory from './memory.js';
import * as board from './board.js';
import * as profiles from './profiles.js';
import * as lists from './lists.js';
import { synthesize, transcribe, voiceStatus, listVoices, setVoice, streamEnabled, streamSynthesize, streamSampleRate, noteStreamResult } from './voice.js';

const app = express();
const PORT = process.env.PORT || 3001;
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => {
  res.json({ chat: chatAvailable(), ...voiceStatus() });
});

// Streams Server-Sent Events: {type:'text'|'tool'|'done'|'error', ...}
app.post('/api/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  let said = '';
  const send = (ev) => {
    if (ev?.type === 'text') said += ev.text;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const ctx = {
      fresh: (req.body?.messages?.length ?? 0) <= 2,
      inView: Array.isArray(req.body?.inView) ? req.body.inView.slice(0, 6).map(String) : [],
      unknown: Boolean(req.body?.unknown),
      camera: Boolean(req.body?.camera),
      now: String(req.body?.now ?? '').slice(0, 100),
      late: Boolean(req.body?.late),
      timers: (Array.isArray(req.body?.timers) ? req.body.timers : []).slice(0, 10).map((x) => ({ label: String(x?.label ?? '').slice(0, 40), remaining: Math.max(0, Math.round(Number(x?.remaining) || 0)) })),
      steps: req.body?.steps && typeof req.body.steps === 'object' ? { title: String(req.body.steps.title ?? '').slice(0, 80), index: Number(req.body.steps.index) || 1, total: Number(req.body.steps.total) || 1, text: String(req.body.steps.text ?? '').slice(0, 200) } : null,
      expressions: Object.fromEntries(
        Object.entries(req.body?.expressions && typeof req.body.expressions === 'object' ? req.body.expressions : {})
          .filter(([, v]) => ['neutral', 'happy', 'sad', 'angry', 'scared', 'disgusted', 'surprised'].includes(v))
          .slice(0, 6),
      ),
    };
    await streamReply(req.body?.messages ?? [], send, ac.signal, ctx);
    if (!ac.signal.aborted) {
      const msgs = req.body?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m?.role === 'user');
      const lastText = typeof last?.content === 'string' ? last.content : '';
      const who = ctx.inView.length === 1 ? profiles.getProfile(ctx.inView[0])?.name || '' : '';
      memory.record(lastText, said, who);
    }
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('[chat]', e.message);
      send({ type: 'error', message: friendlyError(e) });
    }
  }
  res.end();
});

// ---- on-device wake word models: whatever .onnx files are in public/wakeword (or dist/wakeword once built) ----
app.get('/api/wakemodels', (_req, res) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = new Set();
  for (const dir of [path.resolve(here, '../dist/wakeword'), path.resolve(here, '../public/wakeword')]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.onnx') && !/^(melspectrogram|embedding_model|silero_vad)/.test(f)) found.add(f.replace(/\.onnx$/, ''));
    } catch {
      /* folder missing */
    }
  }
  res.json({ models: [...found].sort() });
});

// ---- message board ----
app.get('/api/board', (_req, res) => res.json({ messages: board.all() }));
app.get('/api/board/pending', (req, res) => res.json({ messages: board.pendingFor(String(req.query.to ?? '')) }));
app.post('/api/board', (req, res) => {
  try {
    const m = board.add(req.body?.to, req.body?.text, req.body?.from, { isPrivate: Boolean(req.body?.private) });
    m ? res.json({ message: m }) : res.status(400).json({ error: 'Needs a name and a message' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/board/:id/done', (req, res) => (board.markDone(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
app.delete('/api/board/:id', (req, res) => (board.cancel(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));

// ---- shared household lists ----
app.get('/api/lists', (_req, res) => res.json({ lists: lists.all() }));
app.post('/api/lists/:name/items', (req, res) => {
  try {
    const item = lists.add(req.params.name, req.body?.text, req.body?.by);
    item ? res.json({ item }) : res.status(400).json({ error: 'Empty item' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/lists/:name/items/:id', (req, res) => (lists.removeById(req.params.name, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
app.delete('/api/lists/:name', (req, res) => (lists.clear(req.params.name) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));

// ---- people: names, face descriptors and notes live in data/profiles.json on this machine ----
app.get('/api/profiles', (_req, res) => {
  res.json({ profiles: profiles.listProfiles().map((p) => ({ ...profiles.publicView(p), descriptors: p.descriptors })) });
});
app.post('/api/profiles', (req, res) => {
  try {
    const p = profiles.enroll(req.body?.name, req.body?.descriptors);
    res.json({ profile: { ...profiles.publicView(p), descriptors: p.descriptors } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.patch('/api/profiles/:id', (req, res) => {
  const p = profiles.rename(req.params.id, req.body?.name);
  p ? res.json({ profile: profiles.publicView(p) }) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/profiles/:id', (req, res) => (profiles.removeProfile(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
app.delete('/api/profiles/:id/notes/:index', (req, res) =>
  profiles.removeNote(req.params.id, Number(req.params.index)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' }),
);
app.post('/api/profiles/:id/seen', (req, res) => (profiles.touch(req.params.id), res.json({ ok: true })));

app.get('/api/voices', async (_req, res) => {
  try {
    res.json(await listVoices());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.delete('/api/memory', (_req, res) => (memory.clear(), res.json({ ok: true })));
app.get('/api/memory', (_req, res) => res.json(memory.stats()));
app.get('/api/name', (_req, res) => res.json({ name: companionName() }));
app.post('/api/name', (req, res) => {
  const n = String(req.body?.name ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 30);
  settings.set('name', n || null);
  res.json({ name: companionName() });
});
app.post('/api/voice', (req, res) => {
  try {
    res.json({ current: setVoice(req.body?.id, req.body?.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Text -> audio. Streams raw PCM when possible (fast), otherwise returns a whole mp3 (204 with no voice key).
app.post('/api/tts', async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 1200);
  if (!text.trim()) return res.status(400).json({ error: 'No text' });
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(); // she interrupted: don't waste a voice slot
  });

  if (streamEnabled()) {
    let started = false;
    try {
      await streamSynthesize(text, ac.signal, (chunk) => {
        if (!started) {
          started = true;
          res.writeHead(200, {
            'Content-Type': 'audio/pcm',
            'X-Sample-Rate': String(streamSampleRate()),
            'Cache-Control': 'no-store',
          });
        }
        res.write(chunk);
      });
      if (started) {
        noteStreamResult(true);
        return res.end();
      }
      throw new Error('stream produced no audio');
    } catch (e) {
      if (ac.signal.aborted) return res.end();
      if (started) {
        // Already sending audio: end it here, she keeps what arrived.
        console.warn('[tts] stream ended early:', e.message);
        return res.end();
      }
      noteStreamResult(false, e);
      // fall through to the standard request
    }
  }

  try {
    const audio = await synthesize(text, ac.signal);
    if (!audio) return res.status(204).end();
    res.type('audio/mpeg').send(audio);
  } catch (e) {
    if (e.message === 'aborted' || e.name === 'AbortError') return res.end();
    console.error('[tts]', e.message);
    if (!res.headersSent) res.status(502).json({ error: friendlyError(e) });
    else res.end();
  }
});

// Raw audio body -> { text }
app.post('/api/stt', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  try {
    let terms = [];
    try {
      terms = JSON.parse(String(req.query.terms ?? '[]'));
    } catch {
      /* ignore */
    }
    const out = await transcribe(req.body, req.headers['content-type'], {
      lang: String(req.query.lang ?? 'auto'),
      langs: String(req.query.langs ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5),
      terms,
    });
    res.json(out);
  } catch (e) {
    console.error('[stt]', e.message);
    res.status(502).json({ error: friendlyError(e) });
  }
});

// Serve the built frontend if it exists (npm start)
const dist = path.resolve(here, '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/401|invalid x-api-key|authentication/i.test(m)) return 'API key was rejected — check your .env file.';
  if (/429|rate/i.test(m)) return 'Rate limited — wait a moment and try again.';
  return m.slice(0, 300);
}

// On a server HOST=127.0.0.1 keeps the app reachable only through the reverse proxy.
app.listen(PORT, process.env.HOST || undefined, () => {
  const st = { chat: chatAvailable(), ...voiceStatus() };
  console.log(`\n  AI companion server on http://localhost:${PORT}`);
  console.log(`  Claude:      ${st.chat ? 'live' : 'MOCK (no ANTHROPIC_API_KEY or MOCK=1)'}`);
  console.log(`  ElevenLabs:  ${st.tts ? 'live' : 'MOCK (no ELEVENLABS_API_KEY or MOCK=1)'}`);
  console.log(`  Web search:  ${process.env.BRAVE_API_KEY ? 'Brave' : 'off (add BRAVE_API_KEY to .env)'}`);
  console.log(`  Songs:       ${process.env.YOUTUBE_API_KEY ? 'YouTube' : 'off, radio only (add YOUTUBE_API_KEY to .env)'}\n`);
});
