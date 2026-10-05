// The message board: things people ask the companion to pass on ("say hello to Kristina", "tell Kim dinner is at six").
// A message waits here until the person it is for shows up in front of the camera; then the app delivers it and marks it done.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.BOARD_FILE || path.resolve(here, '../data/board.json');
const MAX_PENDING = 50;
const KEEP_DONE_MS = 7 * 24 * 3600 * 1000;

let db = null;
const load = () => {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = {};
  }
  if (!Array.isArray(db.messages)) db.messages = [];
  return db;
};
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
};
const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** "Kristina" is for a profile called "Kristina" or "Kristina Andersson", and the other way round. */
export const isFor = (m, name) => {
  const a = norm(m.to);
  const b = norm(name);
  return Boolean(a && b) && (a === b || b.startsWith(a + ' ') || a.startsWith(b + ' '));
};

export function add(to, text, from = '', { isPrivate = false, done = false } = {}) {
  const d = load();
  const t = clean(to, 30);
  const x = clean(text, 200);
  if (!t || !x) return null;
  if (d.messages.filter((m) => !m.doneAt).length >= MAX_PENDING) throw new Error('The board is full. Cancel some messages first.');
  const dup = d.messages.find((m) => !m.doneAt && norm(m.to) === norm(t) && norm(m.text) === norm(x));
  if (dup) return dup;
  const m = { id: crypto.randomUUID(), to: t, from: clean(from, 30), text: x, private: Boolean(isPrivate), at: Date.now(), doneAt: done ? Date.now() : null };
  d.messages.push(m);
  prune();
  save();
  return m;
}

function prune() {
  const d = load();
  const cut = Date.now() - KEEP_DONE_MS;
  d.messages = d.messages.filter((m) => !m.doneAt || m.doneAt > cut).slice(-200);
}

export const pendingFor = (name) => load().messages.filter((m) => !m.doneAt && isFor(m, name));
export const all = () => load().messages;

export function markDone(id) {
  const m = load().messages.find((x) => x.id === id && !x.doneAt);
  if (!m) return false;
  m.doneAt = Date.now();
  save();
  return true;
}

export function cancel(id) {
  const d = load();
  const n = d.messages.length;
  d.messages = d.messages.filter((m) => m.id !== id);
  if (d.messages.length === n) return false;
  save();
  return true;
}

/** For the model: cancel pending messages for someone, optionally only those containing some words. */
export function cancelBy(to, contains = '') {
  const d = load();
  const c = norm(contains);
  const hit = d.messages.filter((m) => !m.doneAt && isFor(m, to) && (!c || norm(m.text).includes(c)));
  if (!hit.length) return 0;
  d.messages = d.messages.filter((m) => !hit.includes(m));
  save();
  return hit.length;
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** Text for the system prompt. */
export function summary() {
  const ms = load().messages;
  const pend = ms.filter((m) => !m.doneAt);
  const done = ms.filter((m) => m.doneAt).slice(-5);
  const lines = [];
  if (pend.length) lines.push('Waiting to be passed on (the app delivers them itself when the person appears):\n' + pend.map((m) => `- for ${m.to}${m.from ? ' from ' + m.from : ''}, left ${ago(m.at)}${m.private ? ' (private)' : ''}: ${m.text}`).join('\n'));
  if (done.length) lines.push('Recently passed on:\n' + done.map((m) => `- to ${m.to}${m.from ? ' from ' + m.from : ''}, delivered ${ago(m.doneAt)}: ${m.text}`).join('\n'));
  return lines.join('\n') || '(empty)';
}
