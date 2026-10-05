// Shared household lists (shopping, todo, anything). One JSON file on this machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.LISTS_FILE || path.resolve(here, '../data/lists.json');
const MAX_ITEMS = 100;
const MAX_LISTS = 20;

let db = null;
const load = () => {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = { lists: {} };
  }
  if (!db.lists || typeof db.lists !== 'object') db.lists = {};
  return db;
};
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
};

const ALIASES = { groceries: 'shopping', grocery: 'shopping', 'shopping list': 'shopping', inköp: 'shopping', inköpslista: 'shopping', matlista: 'shopping', 'to-do': 'todo', 'to do': 'todo', tasks: 'todo', task: 'todo', 'att göra': 'todo', todos: 'todo' };
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function listName(raw) {
  const n = clean(raw || 'shopping', 30).toLowerCase().replace(/\s+list$/, '');
  return ALIASES[n] ?? (n || 'shopping');
}

export const all = () => load().lists;
export const get = (name) => load().lists[listName(name)] ?? [];

export function add(name, text, by = '') {
  load();
  const key = listName(name);
  if (!db.lists[key] && Object.keys(db.lists).length >= MAX_LISTS) throw new Error('Too many lists');
  const t = clean(text, 120);
  if (!t) return null;
  const items = (db.lists[key] ??= []);
  const dupe = items.find((i) => i.text.toLowerCase() === t.toLowerCase());
  if (dupe) return dupe;
  const item = { id: crypto.randomUUID(), text: t, by: clean(by, 40), at: Date.now() };
  items.push(item);
  if (items.length > MAX_ITEMS) items.shift();
  save();
  return item;
}

/** Removes the item whose text matches exactly, or else the only item that contains the text. Returns the removed item. */
export function removeByText(name, text) {
  load();
  const key = listName(name);
  const items = db.lists[key] ?? [];
  const t = clean(text, 120).toLowerCase();
  let hit = items.find((i) => i.text.toLowerCase() === t);
  if (!hit) {
    const partial = items.filter((i) => i.text.toLowerCase().includes(t) || t.includes(i.text.toLowerCase()));
    if (partial.length === 1) hit = partial[0];
  }
  if (!hit) return null;
  db.lists[key] = items.filter((i) => i !== hit);
  if (!db.lists[key].length) delete db.lists[key];
  save();
  return hit;
}

export function removeById(name, id) {
  load();
  const key = listName(name);
  const items = db.lists[key] ?? [];
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  if (next.length) db.lists[key] = next;
  else delete db.lists[key];
  save();
  return true;
}

export function clear(name) {
  load();
  const key = listName(name);
  const had = Boolean(db.lists[key]);
  delete db.lists[key];
  if (had) save();
  return had;
}

/** Compact text for the model. */
export function summary() {
  const entries = Object.entries(load().lists);
  if (!entries.length) return 'There are no household lists yet.';
  return entries.map(([k, items]) => `${k}: ${items.slice(0, 25).map((i) => i.text + (i.by ? ` (added by ${i.by})` : '')).join('; ')}`).join('\n');
}
