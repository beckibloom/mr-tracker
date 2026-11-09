import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getIssues, hasJiraWrite, jiraMyself, jiraUrl, keysInOpenSprint } from './jira.mjs';
import { countFor, filesWeeksAgo, headFiles, removedBetween } from './pace.mjs';

/*
 * The program view (the tab named after FOCUSED_EPIC_LABEL): one row per family of the migration
 * from a plan file you keep by hand, with live file counts from the pace census and the MRs on
 * the board that belong to each family. The same file lists the gap tickets that gate families
 * and dated reminders that show in the Your move strip. Shape: README "Program tab".
 */
const RAW = process.env.MRT_PROGRAM_FILE ?? '';
export const PROGRAM_FILE = RAW.startsWith('~/') ? join(homedir(), RAW.slice(2)) : RAW;

export function loadProgram() {
  if (!PROGRAM_FILE) return null;
  try {
    return JSON.parse(readFileSync(PROGRAM_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[program] cannot read', PROGRAM_FILE, err.message);
    return null;
  }
}

/**
 * Reminders not yet done, soonest first, with days left (negative = late). A reminder tied to an
 * MR (`mr`: card key) is done once that MR merges.
 */
export function activeReminders(program = loadProgram(), cards = {}) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return (program?.reminders ?? [])
    .filter((r) => r.text && !r.done && !(r.mr && cards[r.mr]?.state === 'merged'))
    .map((r) => ({
      ...r,
      daysLeft: r.due ? Math.round((new Date(`${r.due}T12:00:00`) - today) / 86400000) : null,
    }))
    // Soonest first; on the same day, the one that unblocks more files.
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (b.unblocks ?? 0) - (a.unblocks ?? 0));
}

const regexOf = (src) => {
  try {
    return src ? new RegExp(src, 'i') : null;
  } catch {
    return null;
  }
};

/** The first family (in file order) a card belongs to: listed MR, Jira key, or title/branch match. */
export function familyOf(card, families) {
  for (const f of families) {
    if ((f.mrs ?? []).includes(card.key)) return f.id;
    if ((f.tickets ?? []).some((t) => card.jiraKeys?.includes(t))) return f.id;
    const re = regexOf(f.match);
    if (re && (re.test(card.title) || re.test(card.branch ?? ''))) return f.id;
  }
  return null;
}

const GAP_TTL_MS = 15 * 60 * 1000;
let gapCache = null; // { key, at, promise }

const AI_READY_LABEL = process.env.MRT_AI_READY_LABEL ?? 'ai-ready';
const REPO_LABEL_PREFIX = process.env.MRT_REPO_LABEL_PREFIX ?? 'repo:';

/**
 * Live Jira state for the gap tickets: status, idle days, and which of the four hand-off
 * conditions (open sprint, To Do, assigned to you, ai-ready + repo labels) are missing.
 */
async function gapStates(gaps) {
  const keys = gaps.map((g) => g.key).filter(Boolean);
  if (!hasJiraWrite() || keys.length === 0) return new Map();
  const cacheKey = keys.join(',');
  if (!gapCache || gapCache.key !== cacheKey || Date.now() - gapCache.at > GAP_TTL_MS) {
    const promise = (async () => {
      const [issues, inSprint, me] = await Promise.all([
        getIssues(keys, ['summary', 'status', 'labels', 'assignee', 'updated']),
        keysInOpenSprint(keys),
        jiraMyself(),
      ]);
      const out = new Map();
      for (const i of issues) {
        const f = i.fields ?? {};
        const labels = f.labels ?? [];
        const missing = [];
        if (!inSprint.has(i.key)) missing.push('not in sprint');
        if (f.status?.name !== 'To Do') missing.push(`status ${f.status?.name ?? '?'}`);
        if (f.assignee?.accountId !== me.accountId) missing.push('not assigned to you');
        if (!labels.includes(AI_READY_LABEL)) missing.push(`no ${AI_READY_LABEL}`);
        if (!labels.some((l) => l.startsWith(REPO_LABEL_PREFIX))) missing.push(`no ${REPO_LABEL_PREFIX}* label`);
        out.set(i.key, {
          summary: f.summary ?? null,
          status: f.status?.name ?? null,
          statusCategory: f.status?.statusCategory?.key ?? null,
          assignee: f.assignee?.displayName ?? null,
          updated: f.updated ?? null,
          idleDays: f.updated ? Math.floor((Date.now() - new Date(f.updated)) / 86400000) : null,
          aiReady: labels.includes(AI_READY_LABEL),
          handoffMissing: missing,
        });
      }
      return out;
    })();
    gapCache = { key: cacheKey, at: Date.now(), promise };
    promise.catch(() => {
      if (gapCache?.promise === promise) gapCache = null;
    });
  }
  return gapCache.promise;
}

/** The whole program view: families with counts and MRs, the gap queue, reminders. */
export async function buildProgram(cards, pace) {
  const program = loadProgram();
  if (!program) return { enabled: false, file: PROGRAM_FILE || null };
  const families = program.families ?? [];
  const [files, monthAgo, gaps] = await Promise.all([
    pace?.enabled ? headFiles().catch(() => null) : null,
    pace?.enabled ? filesWeeksAgo(4).catch(() => null) : null,
    gapStates(program.gaps ?? []).catch((err) => {
      console.error('[program] gap tickets:', err.message);
      return new Map();
    }),
  ]);

  const byFamily = new Map(families.map((f) => [f.id, { open: [], merged: [] }]));
  // `projects` limits family MRs to the repos being migrated; gap MRs elsewhere stay out.
  const projects = program.projects?.length ? new Set(program.projects) : null;
  for (const card of cards) {
    if (card.state === 'closed') continue;
    if (projects && !projects.has(card.project)) continue;
    const id = familyOf(card, families);
    if (!id) continue;
    byFamily.get(id)[card.state === 'merged' ? 'merged' : 'open'].push(card.key);
  }

  // Packages the plan doesn't name still count; they show as one extra row.
  const named = new Set(families.flatMap((f) => f.packages ?? []));
  const unnamed = [];
  if (files) {
    const seen = new Set();
    for (const pkgs of files.values()) for (const p of pkgs) seen.add(p);
    for (const p of seen) if (![...named].some((n) => p.endsWith(`/${n}`) || p === n)) unnamed.push(p);
  }

  const rows = families.map((f) => {
    const left = files && f.packages?.length ? countFor(files, f.packages) : null;
    const removed4w = monthAgo && files && f.packages?.length ? removedBetween(monthAgo, files, f.packages) : null;
    const { open, merged } = byFamily.get(f.id);
    const gated = f.gate === 'gated';
    return {
      ...f,
      filesLeft: left?.total ?? null,
      splitLeft: left?.split ?? null,
      removed4w,
      openMrs: open,
      mergedMrs: merged,
      // An ungated family with files left and at most one MR open is running one MR at a time.
      serial: !gated && (left?.total ?? 0) > 0 && open.length <= 1 && !f.done,
    };
  });
  if (unnamed.length && files) {
    const left = countFor(files, unnamed);
    rows.push({
      id: '_unnamed',
      name: 'Not in the plan',
      packages: unnamed.map((p) => p.split('/').pop()),
      filesLeft: left.total,
      splitLeft: left.split,
      removed4w: null,
      openMrs: [],
      mergedMrs: [],
      serial: false,
      note: 'Packages still imported that no family lists.',
    });
  }

  const gapRows = (program.gaps ?? []).map((g) => ({
    ...g,
    url: g.key ? jiraUrl(g.key) : null,
    jira: gaps.get(g.key) ?? null,
  }));

  return {
    enabled: true,
    file: PROGRAM_FILE,
    title: program.title ?? null,
    updated: program.updated ?? null,
    families: rows,
    gaps: gapRows,
    reminders: activeReminders(program, Object.fromEntries(cards.map((c) => [c.key, c]))),
    gapIdleDays: program.gapIdleDays ?? 7,
  };
}
