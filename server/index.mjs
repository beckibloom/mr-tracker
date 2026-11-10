import express from 'express';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  invalidateSessionCache,
  launchSession,
  listSessions,
  OPEN_IN,
  openPromptInVSCode,
  openSession,
  promptKey,
  projectDir,
  sessionStatus,
} from './claude.mjs';
import { classify, COLUMNS, whoseTurn } from './classify.mjs';
import {
  assertToken,
  fetchMergedCards,
  fetchOpenCards,
  getMergeRequest,
  LANE_RISK_MAX,
  REVIEW_AUTHORS,
} from './gitlab.mjs';
import { addWorklog, getLoggedTime, hasJiraWrite } from './jira.mjs';
import { buildPrompt, loadActions, loadCheatsheet } from './launcher.mjs';
import { REVIEW_NOTES_DIR } from './review-notes.mjs';
import { getPace, PACE_ENABLED } from './pace.mjs';
import { activeReminders, buildProgram, loadProgram } from './program.mjs';
import { record, report } from './usage.mjs';

// MRT_LINK_BROWSER="Google Chrome" opens the board's links in that app (useful when the board runs
// inside VS Code's browser); unset, links open wherever the page runs.
const LINK_BROWSER = process.env.MRT_LINK_BROWSER ?? '';

// MRT_HIDE=chains,time,todos  hides features without removing them (see README).
const HIDDEN = (process.env.MRT_HIDE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// The Your review tray: on when MRT_REVIEW_AUTHORS names someone. Hiding it puts those MRs back
// in the columns.
const REVIEW_TRAY = REVIEW_AUTHORS.size > 0 && !HIDDEN.includes('review');
import { loadState, saveState } from './store.mjs';
import { buildTimeReport } from './time-signals.mjs';

const PORT = Number(process.env.MRT_PORT ?? 4178);
// The board's sort until you pick one: epic, unblock, newest or oldest.
const DEFAULT_SORT = process.env.MRT_DEFAULT_SORT || 'epic';
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
state.important ??= {};
// ‼ flags were plain `true` before they carried a reason and a snapshot.
for (const [key, flag] of Object.entries(state.important)) {
  if (flag === true) state.important[key] = { reason: null, by: null, at: null, snapshot: null };
}
state.links ??= [];
state.dismissed ??= {};
state.claudeSessions ??= {};
state.handoffs ??= {};
state.launcherSessions ??= [];
state.pendingLaunches ??= [];
state.since ??= {};
state.staged ??= [];
const LINK_TYPES = new Set(['blocked-by', 'follows']);
let syncing = false;

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    assertToken();
    const [open, merged] = await Promise.all([fetchOpenCards(), fetchMergedCards()]);
    const cards = {};
    for (const card of [...open, ...merged]) cards[card.key] = card;
    resolveMentions(cards);
    reclassify(cards);
    trackSince(cards);
    await refreshStaged(cards);
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
    clearStaleImportant(cards);
    clearStaleHandoffs(cards);
    state.links = state.links.filter((l) => cards[l.from] && cards[l.to]);
    for (const key of Object.keys(state.claudeSessions)) {
      if (!cards[key]) delete state.claudeSessions[key];
    }
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

// Columns whose waits get a visible age: ready to share and waiting for approval.
const AGED_COLUMNS = new Set(['ready-human', 'waiting-approval']);

/**
 * When each open card entered the column it shows in, for the ready and waiting ages. A card
 * first seen there starts from what GitLab knows: its clean agent review for Ready to share, its
 * newest review request for Waiting for approval.
 */
function trackSince(cards) {
  const next = {};
  for (const card of Object.values(cards)) {
    if (card.state !== 'opened') continue;
    const column = state.overrides[card.key]?.column ?? card.autoColumn;
    if (!AGED_COLUMNS.has(column)) continue;
    const prev = state.since[card.key];
    if (prev?.column === column) next[card.key] = prev;
    else {
      const seed = column === 'ready-human' ? card.agentReview?.at : card.reviewRequestedAt;
      next[card.key] = { column, at: seed ?? new Date().toISOString() };
    }
  }
  state.since = next;
}

/** Staged branches: work built on an open MR's diff, waiting for that MR to merge. */
const git = (cwd, args) =>
  new Promise((resolve) =>
    execFile('git', ['-C', cwd, ...args], (err, stdout) => resolve(err ? null : stdout.trim())),
  );

async function refreshStaged(cards) {
  const byBranch = new Map(
    Object.values(cards)
      .filter((c) => c.state === 'opened' && c.branch)
      .map((c) => [c.branch, c]),
  );
  const kept = [];
  for (const s of state.staged) {
    // Opened as an MR: it's a card now, so the staged entry has done its job.
    if (byBranch.has(s.branch)) continue;
    const exists = s.repo ? (await git(s.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`])) !== null : null;
    let blocker = cards[s.blockedBy] ?? null;
    let blockerState = blocker?.state ?? null;
    if (!blocker && s.blockedBy?.includes('!')) {
      const [project, iid] = s.blockedBy.split('!');
      try {
        const mr = await getMergeRequest(project, iid);
        blockerState = mr.state;
        blocker = { key: s.blockedBy, title: mr.title, webUrl: mr.web_url, state: mr.state };
      } catch {
        blockerState = s.blockerState ?? null;
      }
    }
    kept.push({
      ...s,
      branchExists: exists,
      blockerState,
      blockerTitle: blocker?.title ?? s.blockerTitle ?? null,
      blockerUrl: blocker?.webUrl ?? s.blockerUrl ?? null,
      status: exists === false ? 'missing-branch' : blockerState === 'merged' ? 'ready-to-open' : 'waiting',
    });
  }
  state.staged = kept;
}

// At most this many MRs carry the ‼ flag at once.
const IMPORTANT_CAP = 3;

/** What a ‼ flag was set against; the flag clears once any of it changes. */
const importantSnapshot = (card) => ({
  autoColumn: card.autoColumn ?? null,
  headSha: card.headSha ?? null,
  approvalsMet: Boolean(card.approvalsMet),
  pipelineColor: card.pipeline?.color ?? null,
});

/** Drop ‼ flags whose MR merged or closed, or whose situation moved since the flag was set. */
function clearStaleImportant(cards) {
  for (const [key, flag] of Object.entries(state.important)) {
    const card = cards[key];
    if (!card || card.state !== 'opened') {
      delete state.important[key];
      continue;
    }
    const now = importantSnapshot(card);
    if (!flag.snapshot) flag.snapshot = now;
    else if (Object.keys(now).some((k) => flag.snapshot[k] !== now[k])) delete state.important[key];
  }
}

// Handoffs (README "Handing a move to an agent"): a Your move card parked while an agent works on
// it. It comes back when the MR changes, when the move itself changes, or after a day.
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

const columnOf = (card) => state.overrides[card.key]?.column ?? card.autoColumn;

const handoffSnapshot = (card) => ({
  ...importantSnapshot(card),
  turnReason: whoseTurn(card, columnOf(card)).turnReason ?? null,
});

function clearStaleHandoffs(cards) {
  for (const [key, h] of Object.entries(state.handoffs)) {
    const card = cards[key];
    const expired = Date.now() - new Date(h.at).getTime() >= HANDOFF_TTL_MS;
    if (!card || card.state !== 'opened' || expired) {
      delete state.handoffs[key];
      continue;
    }
    const now = handoffSnapshot(card);
    if (Object.keys(now).some((k) => h.snapshot[k] !== now[k])) delete state.handoffs[key];
  }
}

/** A `you` turn that an agent holds (handed off, or its Claude session busy) waits on the agent. */
function withHandoff(card, turn, session) {
  if (turn.turn !== 'you') return { ...turn, handoff: null };
  const h = state.handoffs[card.key];
  const live = h && Date.now() - new Date(h.at).getTime() < HANDOFF_TTL_MS ? h : null;
  if (!live && session?.status !== 'busy') return { ...turn, handoff: null };
  return {
    turn: 'agent',
    turnReason: null,
    agentReason: null,
    waitReason: `wait for the agent, then ${turn.turnReason}`,
    handoff: {
      at: live?.at ?? null,
      by: live?.by ?? null,
      note: live?.note ?? null,
      then: turn.turnReason,
      session: !live,
    },
  };
}

const importantInfo = (key) => {
  const flag = state.important[key];
  return flag ? { reason: flag.reason, by: flag.by, at: flag.at } : null;
};

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
  adoptPending();
  const cards = Object.values(state.cards).map((card) => {
    const column = columnOf(card);
    const session = withStatus(state.claudeSessions[card.key]);
    return {
      ...card,
      column,
      ...withHandoff(card, whoseTurn(card, column), session),
      columnSince: state.since[card.key]?.column === column ? state.since[card.key].at : null,
      overridden: Boolean(state.overrides[card.key]),
      note: state.notes[card.key] ?? '',
      important: Boolean(state.important[card.key]),
      importantInfo: importantInfo(card.key),
      suggestions: suggestionsFor(card),
      claudeSession: session,
    };
  });
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
    hidden: HIDDEN,
    reviewTray: REVIEW_TRAY,
    reviewNotes: Boolean(REVIEW_NOTES_DIR),
    defaultSort: DEFAULT_SORT,
    linkBrowser: Boolean(LINK_BROWSER),
    laneRiskMax: LANE_RISK_MAX,
    reminders: HIDDEN.includes('program') ? [] : activeReminders(undefined, state.cards),
    staged: state.staged,
    pace: PACE_ENABLED && !HIDDEN.includes('pace'),
    program: Boolean(loadProgram()) && !HIDDEN.includes('program'),
  });
});

// Migration pace (README "Pace header"). ?fresh=1 fetches and recounts now.
app.get('/api/pace', async (req, res) => {
  try {
    res.json(await getPace({ fresh: req.query.fresh === '1' }));
  } catch (err) {
    res.status(500).json({ enabled: true, error: String(err.message ?? err) });
  }
});

// The program tab: families, gap queue, reminders (README "Program tab").
app.get('/api/program', async (_req, res) => {
  try {
    const pace = PACE_ENABLED ? await getPace().catch(() => null) : null;
    // With a focused epic, only its cards join families; without one, every card can.
    const epicKey = process.env.FOCUSED_EPIC_KEY ?? '';
    const cards = Object.values(state.cards).filter((c) => !epicKey || c.epic);
    res.json({ ...(await buildProgram(cards, pace)), pace });
  } catch (err) {
    res.status(500).json({ enabled: true, error: String(err.message ?? err) });
  }
});

// Staged branches (README "Staged tray"). Body: { repo, branch, blockedBy, title?, ticket?, by? }.
// `blockedBy` is a card key ("group/project!123"). The entry leaves the tray once an MR from the
// branch shows on the board.
app.get('/api/staged', (_req, res) => res.json(state.staged));

app.post('/api/staged', async (req, res) => {
  const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  const branch = text(req.body?.branch, 200);
  const blockedBy = text(req.body?.blockedBy, 200);
  const repo = text(req.body?.repo, 400);
  if (!branch || !blockedBy || !repo) {
    return res.status(400).json({ error: 'repo, branch and blockedBy are required.' });
  }
  if (!/^[\w.-]+(\/[\w.-]+)+![0-9]+$/.test(blockedBy)) {
    return res.status(400).json({ error: 'blockedBy must be a full MR key, e.g. group/project!123.' });
  }
  state.staged = state.staged.filter((s) => s.branch !== branch || s.repo !== repo);
  const entry = {
    id: randomUUID(),
    repo,
    branch,
    blockedBy,
    title: text(req.body?.title, 200),
    ticket: text(req.body?.ticket, 40),
    by: text(req.body?.by, 60),
    createdAt: new Date().toISOString(),
  };
  state.staged.push(entry);
  await refreshStaged(state.cards);
  saveState(state);
  res.json(state.staged.find((s) => s.id === entry.id) ?? entry);
});

app.delete('/api/staged/:id', (req, res) => {
  state.staged = state.staged.filter((s) => s.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

// Your saved review for a tray MR, as plain text. Only paths found by the notes scan are served.
app.get('/api/review-note', (req, res) => {
  const path = state.cards[String(req.query.key ?? '')]?.yourReview?.notePath;
  if (!path) return res.status(404).send('No saved review for this MR head.');
  // Notes folders often sit under a dot-folder such as ~/.claude; sendFile refuses those by default.
  res.type('text/plain; charset=utf-8').sendFile(path, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).send('Review file is gone.');
  });
});

app.post('/api/open-url', (req, res) => {
  let url;
  try {
    url = new URL(String(req.body?.url ?? ''));
  } catch {
    return res.status(400).json({ error: 'Not a URL.' });
  }
  if (!LINK_BROWSER || !['http:', 'https:'].includes(url.protocol)) {
    return res.status(400).json({ error: 'Link opening is off or the URL is not http(s).' });
  }
  execFile('open', ['-a', LINK_BROWSER, url.href], (err) =>
    err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }),
  );
});

app.post('/api/usage', (req, res) => {
  res.json({ ok: record(String(req.body?.feature ?? '')) });
});

app.get('/api/usage', (_req, res) => {
  res.json({ ...report(loadActions()), hidden: HIDDEN });
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

// Body: { key, handoff, by?, note? }. Parks a Your move card while an agent works on it; see
// clearStaleHandoffs for when it comes back.
app.post('/api/handoff', (req, res) => {
  const { key } = req.body ?? {};
  const card = state.cards[key];
  if (!card) return res.status(404).json({ error: `Unknown card ${key}` });
  if (!req.body?.handoff) {
    delete state.handoffs[key];
    saveState(state);
    return res.json({ ok: true, handoff: false });
  }
  if (card.state !== 'opened') return res.status(400).json({ error: 'Only open MRs can be handed off.' });
  const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  state.handoffs[key] = {
    at: new Date().toISOString(),
    by: text(req.body.by, 60),
    note: text(req.body.note, 200),
    snapshot: handoffSnapshot(card),
  };
  saveState(state);
  res.json({ ok: true, handoff: true });
});

// Body: { key, important, reason?, by?, replace? }. Flagging a fourth MR answers 409 with the
// current three unless `replace` names one of them, which is unflagged in its place.
app.post('/api/important', (req, res) => {
  const { key, replace } = req.body ?? {};
  const card = state.cards[key];
  if (!card) return res.status(404).json({ error: `Unknown card ${key}` });
  if (!req.body?.important) {
    delete state.important[key];
    saveState(state);
    return res.json({ ok: true, important: false });
  }
  if (card.state !== 'opened') return res.status(400).json({ error: 'Only open MRs can be flagged.' });
  const others = Object.keys(state.important).filter((k) => k !== key);
  if (!state.important[key] && others.length >= IMPORTANT_CAP) {
    if (!replace || !others.includes(replace)) {
      return res.status(409).json({
        error: `At most ${IMPORTANT_CAP} MRs can be flagged ‼. Pass replace: <key> to drop one.`,
        flagged: others.map((k) => ({ key: k, reason: state.important[k].reason, at: state.important[k].at })),
      });
    }
    delete state.important[replace];
  }
  const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  state.important[key] = {
    reason: text(req.body.reason, 300),
    by: text(req.body.by, 60),
    at: new Date().toISOString(),
    snapshot: importantSnapshot(card),
  };
  saveState(state);
  res.json({ ok: true, important: true, ...importantInfo(key) });
});

/** Unmerged MRs a card waits on, from board links and GitLab's dependency field. */
function openBlockersFor(card, cards) {
  const byKey = new Map();
  for (const l of state.links) {
    if (l.from !== card.key || l.type !== 'blocked-by') continue;
    const other = cards[l.to];
    if (other && other.state !== 'merged') byKey.set(other.key, { key: other.key, source: 'board' });
  }
  for (const b of card.gitlabBlockers ?? []) {
    if (b.state !== 'merged' && !byKey.has(b.key)) byKey.set(b.key, { ...b, source: 'gitlab' });
  }
  return [...byKey.values()];
}

function reclassify(cards) {
  for (const card of Object.values(cards)) {
    card.openBlockers = card.state === 'merged' ? [] : openBlockersFor(card, cards);
    card.autoColumn = classify(card, { reviewTray: REVIEW_TRAY });
  }
}

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
  reclassify(state.cards);
  saveState(state);
  res.json(link);
});

const withStatus = (s) => (s ? { ...s, status: sessionStatus(s.sessionId) } : null);

const refOf = (card) => `${card.project.split('/').pop()}!${card.iid}`;

/** Everything the card shows, as Markdown for the first Claude message. */
function cardBrief(card, userPrompt) {
  const lines = [
    `# ${card.title}`,
    '',
    `- MR: ${card.webUrl} (${refOf(card)})`,
    `- Project: ${card.project}`,
    `- State: ${card.state}${card.draft ? ', draft' : ''}; board column: ${state.overrides[card.key]?.column ?? card.autoColumn}`,
    `- Pipeline: ${card.pipeline.status}`,
  ];
  if (card.jiraKey) lines.push(`- Jira: ${card.jiraKey}${card.jiraUrl ? ` (${card.jiraUrl})` : ''}`);
  if (card.agentReview?.reviewed) {
    const r = card.agentReview;
    const open = [
      `${r.issueCount ?? '?'} open issue(s)`,
      r.recommendationCount ? `${r.recommendationCount} recommendation(s)` : null,
      r.onHead ? null : 'not on the head commit',
    ].filter(Boolean);
    lines.push(`- AI review: ${r.clean ? 'clean' : open.join(', ')}` + (r.verdict ? `, verdict ${r.verdict}` : ''));
  } else if (card.state !== 'merged') {
    lines.push('- AI review: none yet');
  }
  if (card.lane) {
    const l = card.lane;
    lines.push(
      `- Review lane: ${l.lane}${l.files != null ? `, ${l.files} files` : ''}` +
        (l.risk ? `, risk ${l.risk.score} (auto-approve at ≤ ${LANE_RISK_MAX})` : '') +
        (l.humanPaths?.length ? `, human-only paths: ${l.humanPaths.join(', ')}` : '') +
        (l.warn ? ` — ${l.warn}` : ''),
    );
    for (const r of l.secondHuman?.reasons ?? []) {
      lines.push(`- Needs a second human reviewer: ${r.rule} (${r.paths.join(', ')}${r.count > r.paths.length ? ', …' : ''})`);
    }
  }
  if (card.trainDrop) lines.push(`- Dropped from the merge train ${card.trainDrop.at}${card.trainDrop.reason ? `: ${card.trainDrop.reason}` : ''}`);
  if (card.failedJobs?.names?.length) {
    lines.push(`- Failed jobs: ${card.failedJobs.names.join(', ')}${card.failedJobs.allFlaky ? ' (all known flakes)' : ''}`);
  }
  if (card.approvalsMet) lines.push('- Approvals: met');
  if (card.unresolvedHumanThreads > 0) {
    lines.push(`- Unresolved human feedback threads: ${card.unresolvedHumanThreads}`);
  }
  const rel = [];
  for (const l of state.links) {
    const other = state.cards[l.from === card.key ? l.to : l.from];
    if (!other || (l.from !== card.key && l.to !== card.key)) continue;
    const verb =
      l.from === card.key
        ? l.type === 'blocked-by' ? 'blocked by' : 'follows'
        : l.type === 'blocked-by' ? 'blocks' : 'followed by';
    rel.push(`  - ${verb} ${refOf(other)} (${other.state}): ${other.title} — ${other.webUrl}`);
  }
  if (rel.length) lines.push('- Related MRs:', ...rel);
  const note = state.notes[card.key];
  if (note) lines.push(`- My note on the card: ${note}`);
  const flag = state.important[card.key];
  if (flag) lines.push(`- Flagged important (‼)${flag.reason ? `: ${flag.reason}` : ''}`);
  lines.push('', '## Request', '', userPrompt.trim());
  return lines.join('\n');
}

app.post('/api/claude/launch', (req, res) => {
  const { key } = req.body ?? {};
  const prompt = String(req.body?.prompt ?? '').trim();
  const card = state.cards[key];
  if (!card) return res.status(404).json({ error: `Unknown card ${key}` });
  if (!prompt) return res.status(400).json({ error: 'A prompt is required.' });
  const cwd = projectDir(card.project);
  const brief = cardBrief(card, prompt);
  if (OPEN_IN === 'vscode') {
    const result = openPending({ key, cwd, brief, prompt });
    return result.error ? res.status(500).json(result) : res.json(result);
  }
  let sessionId;
  try {
    sessionId = launchSession({ cwd, prompt: brief, name: `${refOf(card)} · ${prompt.slice(0, 60)}` });
  } catch (err) {
    return res.status(500).json({ error: `Could not start Claude: ${err.message}` });
  }
  const session = { sessionId, cwd, prompt, startedAt: new Date().toISOString() };
  state.claudeSessions[key] = session;
  invalidateSessionCache();
  saveState(state);
  res.json(withStatus(session));
});

// VS Code mode: open a tab with the prompt filled in. The session id exists only once the person
// presses Enter, so remember the launch and adopt the session when its transcript appears.
function openPending({ key = null, cwd, brief, prompt }) {
  try {
    openPromptInVSCode(brief);
  } catch (err) {
    return { error: `Could not open VS Code: ${err.message}` };
  }
  state.pendingLaunches.push({ key, cwd, prompt, match: promptKey(brief), startedAt: new Date().toISOString() });
  saveState(state);
  return { pending: true, opened: 'vscode' };
}

const PENDING_TTL_MS = 60 * 60 * 1000;

function adoptPending() {
  if (!state.pendingLaunches.length) return;
  const now = Date.now();
  let changed = false;
  const sessions = listSessions();
  state.pendingLaunches = state.pendingLaunches.filter((p) => {
    const hit = sessions.find(
      (s) => s.lastActive >= p.startedAt && s.title && promptKey(s.title).startsWith(p.match.slice(0, 100)),
    );
    if (hit) {
      const session = { sessionId: hit.sessionId, cwd: hit.cwd ?? p.cwd, prompt: p.prompt, startedAt: p.startedAt };
      if (p.key && state.cards[p.key]) state.claudeSessions[p.key] = session;
      else state.launcherSessions = [session, ...state.launcherSessions].slice(0, 20);
      changed = true;
      return false;
    }
    if (now - new Date(p.startedAt).getTime() > PENDING_TTL_MS) {
      changed = true;
      return false;
    }
    return true;
  });
  if (changed) saveState(state);
}

app.get('/api/launcher', (_req, res) => {
  res.json(loadActions());
});

app.get('/api/cheatsheet', (_req, res) => {
  res.json({ text: loadCheatsheet() });
});

// Start a quick action and show it (Terminal, or a VS Code tab with MRT_OPEN_IN=vscode). An MR input that matches a card launches with the
// card brief in that MR's checkout, like the card's own Claude button.
app.post('/api/launcher/launch', (req, res) => {
  const action = loadActions().find((a) => a.id === req.body?.id);
  if (!action) return res.status(404).json({ error: `Unknown action ${req.body?.id}` });
  const input = String(req.body?.input ?? '').trim();
  if (action.input !== 'none' && !input) {
    return res.status(400).json({ error: 'This action needs input.' });
  }
  const prompt = buildPrompt(action, input);
  const card =
    action.input === 'mr'
      ? Object.values(state.cards).find((c) => refOf(c) === input || c.webUrl === input)
      : null;
  const cwd = card ? projectDir(card.project) : (action.cwd ?? process.env.MRT_LAUNCHER_CWD ?? homedir());
  if (OPEN_IN === 'vscode') {
    const result = openPending({ key: card?.key, cwd, brief: card ? cardBrief(card, prompt) : prompt, prompt });
    return result.error ? res.status(500).json(result) : res.json(result);
  }
  let sessionId;
  try {
    sessionId = launchSession({
      cwd,
      prompt: card ? cardBrief(card, prompt) : prompt,
      name: `${action.label}${input ? ` · ${input.slice(0, 50)}` : ''}`,
    });
  } catch (err) {
    return res.status(500).json({ error: `Could not start Claude: ${err.message}` });
  }
  const session = { sessionId, cwd, prompt, startedAt: new Date().toISOString() };
  if (card) state.claudeSessions[card.key] = session;
  else state.launcherSessions = [session, ...state.launcherSessions].slice(0, 20);
  invalidateSessionCache();
  saveState(state);
  let opened = null;
  try {
    opened = openSession({ sessionId, cwd });
  } catch {
    // Still running in the background; the Sessions list can open it.
  }
  res.json({ ...withStatus(session), opened });
});

app.post('/api/claude/open', (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '')) {
    return res.status(400).json({ error: 'A session id is required.' });
  }
  const known = [...Object.values(state.claudeSessions), ...state.launcherSessions].find(
    (s) => s.sessionId === sessionId,
  );
  const cwd =
    known?.cwd ?? listSessions().find((s) => s.sessionId === sessionId)?.cwd ?? homedir();
  try {
    res.json({ ok: true, result: openSession({ sessionId, cwd }) });
  } catch (err) {
    res.status(500).json({ error: `Could not open Terminal: ${err.message}` });
  }
});

app.get('/api/claude/sessions', (_req, res) => {
  adoptPending();
  const byId = new Map(
    Object.entries(state.claudeSessions).map(([key, s]) => [s.sessionId, { key, s }]),
  );
  // Board-launched sessions open with the card brief; show the person's prompt instead.
  const rows = listSessions().map((s) => {
    const known = byId.get(s.sessionId);
    return {
      ...s,
      mrKey: known?.key ?? null,
      title: known?.s.prompt ?? s.title,
      status: sessionStatus(s.sessionId),
    };
  });
  // A just-launched background session has no transcript yet; list it anyway.
  const listed = new Set(rows.map((r) => r.sessionId));
  for (const [key, s] of Object.entries(state.claudeSessions)) {
    if (listed.has(s.sessionId)) continue;
    rows.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      project: s.cwd.split('/').pop(),
      title: s.prompt,
      lastActive: s.startedAt,
      bytes: 0,
      mrKey: key,
      status: sessionStatus(s.sessionId),
    });
  }
  for (const s of state.launcherSessions) {
    if (listed.has(s.sessionId)) continue;
    rows.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      project: s.cwd.split('/').pop(),
      title: s.prompt,
      lastActive: s.startedAt,
      bytes: 0,
      mrKey: null,
      status: sessionStatus(s.sessionId),
    });
  }
  rows.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
  res.json(rows);
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
  reclassify(state.cards);
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

// Jira worklog reads take a few seconds (one request per ticket), so the totals are cached briefly
// and dropped whenever this server writes a worklog.
const LOGGED_TTL_MS = 5 * 60 * 1000;
let loggedCache = null; // { key, at, promise }

app.get('/api/time/logged', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
  const key = `${days}:${new Date().toLocaleDateString('en-CA')}`;
  const fresh = req.query.fresh === '1';
  if (fresh || !loggedCache || loggedCache.key !== key || Date.now() - loggedCache.at > LOGGED_TTL_MS) {
    loggedCache = { key, at: Date.now(), promise: getLoggedTime(days) };
  }
  const entry = loggedCache;
  try {
    res.json({ ...(await entry.promise), fetchedAt: entry.at });
  } catch (err) {
    if (loggedCache === entry) loggedCache = null;
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
  loggedCache = null;
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
