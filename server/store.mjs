import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'state.json');

export function loadState() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { cards: {}, overrides: {}, todos: [], lastSync: null, lastError: null };
  }
}

export function saveState(state) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}
