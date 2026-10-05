// Local profile store: names, face descriptors (numbers, not photos) and notes. One JSON file, never leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.PROFILES_FILE || path.resolve(here, '../data/profiles.json');
const MAX_DESCRIPTORS = 16;
const MAX_NOTES = 40;

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = { profiles: [] };
  }
  if (!Array.isArray(db.profiles)) db.profiles = [];
  return db;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => Number.isFinite(x));

export const listProfiles = () => load().profiles;
export const getProfile = (id) => load().profiles.find((p) => p.id === id);
export const findByName = (name) => {
  const n = clean(name, 40).toLowerCase();
  return load().profiles.find((p) => p.name.toLowerCase() === n);
};

/** Creates a profile, or adds more face samples to the one with the same name. */
export function enroll(name, descriptors) {
  const nm = clean(name, 40);
  if (!nm) throw new Error('A name is needed');
  const good = (descriptors || []).filter(validDescriptor);
  if (good.length < 2) throw new Error('Not enough clear face samples');
  load();
  let p = findByName(nm);
  if (!p) {
    p = { id: crypto.randomUUID(), name: nm, descriptors: [], notes: [], created: Date.now(), lastSeen: null };
    db.profiles.push(p);
  }
  p.descriptors = [...p.descriptors, ...good].slice(-MAX_DESCRIPTORS);
  save();
  return p;
}

export function rename(id, name) {
  const p = getProfile(id);
  const nm = clean(name, 40);
  if (!p || !nm) return null;
  p.name = nm;
  save();
  return p;
}

export function removeProfile(id) {
  load();
  const before = db.profiles.length;
  db.profiles = db.profiles.filter((p) => p.id !== id);
  if (db.profiles.length !== before) save();
  return db.profiles.length !== before;
}

export function addNote(id, text) {
  const p = getProfile(id);
  const t = clean(text, 200);
  if (!p || !t) return false;
  if (p.notes.some((n) => n.text.toLowerCase() === t.toLowerCase())) return true;
  p.notes.push({ text: t, at: Date.now() });
  p.notes = p.notes.slice(-MAX_NOTES);
  save();
  return true;
}

export function removeNote(id, index) {
  const p = getProfile(id);
  if (!p || !p.notes[index]) return false;
  p.notes.splice(index, 1);
  save();
  return true;
}

/** Removes notes containing the text (used when someone says "forget that"). */
export function forgetNotes(id, contains) {
  const p = getProfile(id);
  const needle = clean(contains, 100).toLowerCase();
  if (!p || !needle) return 0;
  const before = p.notes.length;
  p.notes = p.notes.filter((n) => !n.text.toLowerCase().includes(needle));
  if (p.notes.length !== before) save();
  return before - p.notes.length;
}

export function touch(id) {
  const p = getProfile(id);
  if (p) {
    p.lastSeen = Date.now();
    save();
  }
}

export const publicView = (p) => ({ id: p.id, name: p.name, notes: p.notes, created: p.created, lastSeen: p.lastSeen, samples: p.descriptors.length });
