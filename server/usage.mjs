import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local feature-usage counts (data/usage.json), so unused features can be found and hidden.
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'usage.json');

// Every trackable feature, so ones never used still show up in the report.
export const FEATURES = {
  'tab:board': 'Board tab',
  'tab:sessions': 'Sessions tab',
  'tab:chains': 'Chains tab',
  'tab:time': 'Time tab',
  search: 'Top-bar MR search',
  sort: 'Sort by control',
  theme: 'Light/dark toggle',
  refresh: 'Refresh button',
  'card:drag': 'Dragging a card to another column',
  'card:note': 'Card notes',
  'card:link': 'Linking MRs (blocks / follows)',
  'card:dismiss-suggestion': 'Dismissing a suggested link',
  'card:copy-review-request': 'Copy review-request message (megaphone)',
  'card:claude-prompt': 'Card Claude prompt (typed)',
  'card:claude-open': 'Opening a card’s Claude session',
  'card:open-mr': 'Opening an MR from its card',
  'session:open': 'Opening a session from the Sessions list',
  cheatsheet: 'Cheat sheet panel',
  'todo:add': 'Adding a to-do',
  'todo:toggle': 'Checking off a to-do',
  'tray:todos': 'Opening the to-do tray',
  'tray:merged': 'Opening the merged tray',
};

let usage = { since: new Date().toISOString(), features: {} };
if (existsSync(FILE)) {
  try {
    usage = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    // Start over on a corrupt file.
  }
}

let timer = null;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(usage, null, 2));
  }, 1000);
};

const VALID = /^[a-z]+(?::[a-z0-9-]+)?$/;

export function record(feature) {
  if (!VALID.test(feature ?? '')) return false;
  const f = (usage.features[feature] ??= { count: 0, last: null });
  f.count += 1;
  f.last = new Date().toISOString();
  save();
  return true;
}

/** Every known feature plus any launcher action used, least used first. */
export function report(launcherActions = []) {
  const names = { ...FEATURES };
  for (const a of launcherActions) names[`launch:${a.id}`] = `Quick action: ${a.label}`;
  for (const id of Object.keys(usage.features)) names[id] ??= id;
  const rows = Object.entries(names).map(([id, name]) => ({
    id,
    name,
    count: usage.features[id]?.count ?? 0,
    last: usage.features[id]?.last ?? null,
  }));
  rows.sort((a, b) => a.count - b.count || a.id.localeCompare(b.id));
  return { since: usage.since, features: rows };
}
