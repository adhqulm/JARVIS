// A hidden, rolling memory of past conversations, so the companion doesn't start from zero every time the app opens.
// Recent exchanges are kept word for word; older ones get folded into a short running summary. One JSON file on this machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MEMORY_FILE || path.resolve(here, '../data/memory.json');
const MAX_RECENT = 30; // exchanges kept verbatim
const FOLD = 12; // how many of the oldest are folded into the summary at once
const SHOWN = 12; // how many recent exchanges a fresh conversation gets to see
const MAX_SUMMARY = 1800;

let db = null;
let folding = false;
let summarizer = null; // async (oldSummary, exchanges) => newSummary; set by companion.js when a model is available

const load = () => {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = {};
  }
  if (typeof db.summary !== 'string') db.summary = '';
  if (!Array.isArray(db.recent)) db.recent = [];
  return db;
};
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
};

export const setSummarizer = (fn) => (summarizer = fn);

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Fallback when no model is available: a crude running list of what was talked about. */
const crude = (old, items) => clip([old, ...items.map((e) => `${e.who || 'Someone'} said: ${clip(e.user, 90)}`)].filter(Boolean).join(' | '), MAX_SUMMARY);

async function fold() {
  const d = load();
  if (folding || d.recent.length <= MAX_RECENT) return;
  folding = true;
  const old = d.recent.slice(0, FOLD);
  try {
    let next;
    try {
      next = summarizer ? await summarizer(d.summary, old) : crude(d.summary, old);
    } catch (e) {
      console.warn('[memory] summary failed, using a crude one:', e.message);
      next = crude(d.summary, old);
    }
    d.summary = clip(String(next || '').trim(), MAX_SUMMARY);
    d.recent = d.recent.slice(old.length);
    save();
  } finally {
    folding = false;
  }
}

/** Remember one finished exchange. App events (messages in square brackets) are not conversation and are skipped. */
export function record(user, assistant, who = '') {
  const u = String(user || '').trim();
  const a = String(assistant || '').trim();
  if (!u || !a || u.startsWith('[')) return;
  const d = load();
  d.recent.push({ at: Date.now(), who: String(who).slice(0, 40), user: clip(u, 500), assistant: clip(a, 500) });
  save();
  fold().catch((e) => console.warn('[memory]', e.message));
}

const ago = (t, now = Date.now()) => {
  const m = Math.round((now - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hours ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

/** Text for the system prompt. A fresh conversation also gets the latest exchanges; a running one already has them. */
export function context({ fresh = true } = {}) {
  const d = load();
  if (!d.summary && !d.recent.length) return '';
  const lines = ['MEMORY OF EARLIER CONVERSATIONS (private; the people here do not see this text). Use it so you feel like the same companion as last time: pick up threads naturally, but never recite it or announce that you "remember". Do not pass what one person told you to another person unless it was clearly meant to be shared.'];
  if (d.summary) lines.push(`Older, in short: ${d.summary}`);
  if (fresh && d.recent.length) {
    lines.push('Most recent exchanges:');
    for (const e of d.recent.slice(-SHOWN)) lines.push(`- (${ago(e.at)}) ${e.who ? e.who + ': ' : ''}"${e.user}" -> you: "${e.assistant}"`);
  }
  return lines.join('\n');
}

export const stats = () => ({ exchanges: load().recent.length, hasSummary: Boolean(load().summary) });

export function clear() {
  db = { summary: '', recent: [] };
  save();
}
