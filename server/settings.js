// Small household settings saved on this machine (currently just the chosen voice).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.SETTINGS_FILE || path.resolve(here, '../data/settings.json');

let db = null;
const load = () => {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = {};
  }
  return db;
};

export const get = (k) => load()[k];

export function set(k, v) {
  load();
  if (v == null || v === '') delete db[k];
  else db[k] = v;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}
