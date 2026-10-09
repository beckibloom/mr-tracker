import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, COLUMNS } from './classify.mjs';
import { assertToken, fetchMergedCards, fetchOpenCards } from './gitlab.mjs';
import { addWorklog, hasJiraWrite } from './jira.mjs';
import { loadState, saveState } from './store.mjs';
import { buildTimeReport } from './time-signals.mjs';

const PORT = Number(process.env.MRT_PORT ?? 4178);
// MRT_PROJECT_ABBR=my-frontend=FE,design-system=DS  (short names on link chips)
const PROJECT_ABBR = Object.fromEntries(
  (process.env.MRT_PROJECT_ABBR ?? '')
    .split(',')
    .map((pair) => pair.split('=').map((x) => x.trim()))
    .filter(([k, v]) => k && v),
);
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const state = loadState();
delete state.shared;
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id));
state.todos ??= [];
state.notes ??= {};
state.links ??= [];
state.dismissed ??= {};
const LINK_TYPES = new Set(['blocked-by', 'follows']);
let syncing = false;

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    assertToken();
    const [open, merged] = await Promise.all([fetchOpenCards(), fetchMergedCards()]);
    const cards = {};
    for (const card of [...open, ...merged]) {
      cards[card.key] = { ...card, autoColumn: classify(card) };
    }
    resolveMentions(cards);
    // Drop a manual override once the MR's real state moves it somewhere new.
    for (const [key, o] of Object.entries(state.overrides)) {
      if (
        !cards[key] ||
        !COLUMN_IDS.has(o.column) ||
        cards[key].autoColumn !== o.autoColumnAtOverride
      ) {
        delete state.overrides[key];
      }
    }
    for (const key of Object.keys(state.notes)) {
      if (!cards[key]) delete state.notes[key];
    }
    state.links = state.links.filter((l) => cards[l.from] && cards[l.to]);
    for (const pair of Object.keys(state.dismissed)) {
      if (!pair.split('|').every((k) => cards[k])) delete state.dismissed[pair];
    }
    state.cards = cards;
    state.lastSync = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = String(err.message ?? err);
    console.error('[sync]', state.lastError);
  } finally {
    saveState(state);
    syncing = false;
  }
}

/** Turn each card's raw MR references into keys of other cards on the board. */
function resolveMentions(cards) {
  const all = Object.values(cards);
  const byLastSegment = new Map();
  const byIid = new Map();
  for (const { project, iid } of all) {
    const seg = project.split('/').pop();
    byLastSegment.set(seg, byLastSegment.has(seg) ? null : project);
    byIid.set(iid, byIid.has(iid) ? null : project);
  }
  const resolve = (card, project, iid) => {
    const named =
      project &&
      (all.some((c) => c.project === project)
        ? project
        : byLastSegment.get(project.split('/').pop()));
    // A non-project word before "!123" (e.g. "until !123") means a bare ref.
    for (const path of [named, card.project, byIid.get(iid)]) {
      if (path && cards[`${path}!${iid}`]) return `${path}!${iid}`;
    }
    return null;
  };
  const HINT_RANK = { 'blocked-by': 2, follows: 1, null: 0 };
  const better = (a, b) => (HINT_RANK[b] > HINT_RANK[a] ? b : a);
  for (const card of all) {
    const mentions = new Map();
    for (const { project, iid, hint } of card.mentionRefs ?? []) {
      const key = resolve(card, project, iid);
      if (!key || key === card.key) continue;
      mentions.set(key, better(mentions.get(key) ?? null, hint));
    }
    card.mentions = mentions;
    delete card.mentionRefs;
  }
  // Mutual mentions: suggest once, from the newer MR to the older one.
  for (const card of all) {
    for (const [key, hint] of card.mentions) {
      const other = cards[key];
      if (!other.mentions.has(card.key)) continue;
      const newer = card.createdAt > other.createdAt ? card : other;
      const older = newer === card ? other : card;
      newer.mentions.set(older.key, better(hint, other.mentions.get(card.key)));
      older.mentions.delete(newer.key);
    }
  }
  for (const card of all) {
    card.mentions = [...card.mentions].map(([key, hint]) => ({ key, hint }));
  }
}

/** Mentions not yet linked or dismissed, in either direction. */
function suggestionsFor(card) {
  if (card.state === 'merged') return [];
  const linked = new Set(state.links.flatMap((l) => [`${l.from}|${l.to}`, `${l.to}|${l.from}`]));
  return (card.mentions ?? []).filter(
    (m) => !linked.has(`${card.key}|${m.key}`) && !state.dismissed[`${card.key}|${m.key}`],
  );
}

// Poll window, e.g. MRT_POLL_HOURS=9-17 in MRT_TIMEZONE; outside it only Refresh syncs.
const POLL_TZ = process.env.MRT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const [POLL_START, POLL_END] = (process.env.MRT_POLL_HOURS ?? '9-17').split('-').map(Number);

function withinPollWindow() {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: POLL_TZ, hour: 'numeric', hour12: false }).format(
      new Date(),
    ),
  );
  return hour >= POLL_START && hour < POLL_END;
}

const app = express();
app.use(express.json());

app.get('/api/board', (_req, res) => {
  const cards = Object.values(state.cards).map((card) => ({
    ...card,
    column: state.overrides[card.key]?.column ?? card.autoColumn,
    overridden: Boolean(state.overrides[card.key]),
    note: state.notes[card.key] ?? '',
    suggestions: suggestionsFor(card),
  }));
  res.json({
    columns: COLUMNS,
    cards,
    todos: state.todos,
    links: state.links,
    lastSync: state.lastSync,
    lastError: state.lastError,
    syncing,
    pollWindowActive: withinPollWindow(),
    projectAbbr: PROJECT_ABBR,
    epicKey: process.env.FOCUSED_EPIC_KEY ?? '',
    epicLabel: process.env.FOCUSED_EPIC_LABEL || 'FOCUS',
  });
});

app.post('/api/refresh', async (_req, res) => {
  await sync();
  res.json({ ok: !state.lastError, lastSync: state.lastSync, lastError: state.lastError });
});

app.post('/api/override', (req, res) => {
  const { key, column } = req.body ?? {};
  const card = state.cards[key];
  if (!card) return res.status(404).json({ error: `Unknown card ${key}` });
  if (!column || column === card.autoColumn) {
    delete state.overrides[key];
  } else {
    state.overrides[key] = { column, autoColumnAtOverride: card.autoColumn };
  }
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/note', (req, res) => {
  const { key } = req.body ?? {};
  if (!state.cards[key]) return res.status(404).json({ error: `Unknown card ${key}` });
  const note = String(req.body?.note ?? '').trim().slice(0, 200);
  if (note) state.notes[key] = note;
  else delete state.notes[key];
  saveState(state);
  res.json({ ok: true, note });
});

// `from` depends on `to`: "from is blocked by to" / "from follows to".
app.post('/api/links', (req, res) => {
  const { from, to, type } = req.body ?? {};
  if (!LINK_TYPES.has(type)) return res.status(400).json({ error: `Unknown link type ${type}` });
  if (from === to) return res.status(400).json({ error: 'A card cannot link to itself.' });
  const missing = [from, to].find((k) => !state.cards[k]);
  if (missing) return res.status(404).json({ error: `Unknown card ${missing}` });
  if (state.links.some((l) => l.from === from && l.to === to && l.type === type)) {
    return res.status(409).json({ error: 'Link already exists.' });
  }
  const link = { id: randomUUID(), from, to, type, createdAt: new Date().toISOString() };
  state.links.push(link);
  saveState(state);
  res.json(link);
});

app.post('/api/suggestions/dismiss', (req, res) => {
  const { from, to } = req.body ?? {};
  if (!state.cards[from] || !state.cards[to]) return res.status(404).json({ error: 'Unknown card' });
  state.dismissed[`${from}|${to}`] = true;
  saveState(state);
  res.json({ ok: true });
});

app.delete('/api/links/:id', (req, res) => {
  state.links = state.links.filter((l) => l.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/todos', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'To-do text is required.' });
  const todo = { id: randomUUID(), text, done: false, createdAt: new Date().toISOString() };
  state.todos.push(todo);
  saveState(state);
  res.json(todo);
});

app.patch('/api/todos/:id', (req, res) => {
  const todo = state.todos.find((t) => t.id === req.params.id);
  if (!todo) return res.status(404).json({ error: `Unknown to-do ${req.params.id}` });
  if (typeof req.body?.done === 'boolean') todo.done = req.body.done;
  saveState(state);
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  state.todos = state.todos.filter((t) => t.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.get('/api/time', async (req, res) => {
  const date = req.query.date ?? new Date().toLocaleDateString('en-CA');
  try {
    res.json(await buildTimeReport(date, state.cards));
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.post('/api/time/log', async (req, res) => {
  const { date, entries } = req.body ?? {};
  if (!hasJiraWrite()) {
    return res.status(400).json({ error: 'Set JIRA_EMAIL and JIRA_API_TOKEN to log time.' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'No entries to log.' });
  }
  const results = [];
  for (const { key, minutes } of entries) {
    try {
      const timeSpent = await addWorklog(key, minutes, date);
      results.push({ key, ok: true, logged: timeSpent });
    } catch (err) {
      results.push({ key, ok: false, error: String(err.message ?? err) });
    }
  }
  res.json({ results });
});

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`MR Tracker server on http://localhost:${PORT}`);
  sync(); // always sync on startup so the board is fresh when opened
  setInterval(() => {
    if (withinPollWindow()) sync();
  }, SYNC_INTERVAL_MS);
});
