import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  epicMembersJql,
  getIssues,
  hasJiraWrite,
  jiraMyself,
  jiraUrl,
  keysInOpenSprint,
  searchIssues,
} from './jira.mjs';
import { countFor, filesWeeksAgo, headFiles, removedBetween } from './pace.mjs';

/*
 * The program view (the tab named after FOCUSED_EPIC_LABEL): one row per family of the migration,
 * with live file counts from the pace census and the MRs on the board that belong to each family.
 * With `jira` in the plan file, Jira is the source of truth: families are the epic's tickets the
 * file lists or whose summary matches `jira.families`, and gaps are the open tickets that block
 * them. The file then only adds what Jira doesn't hold (packages, MR matching, notes). Without
 * `jira`, the file lists families and gaps itself. Shape: README "Program tab".
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

/**
 * The family a card belongs to: a listed MR or Jira key in any family first, then the first
 * family (in order) whose `match` hits the title or branch.
 */
export function familyOf(card, families) {
  for (const f of families) {
    if ((f.mrs ?? []).includes(card.key)) return f.id;
    if ((f.tickets ?? []).some((t) => card.jiraKeys?.includes(t))) return f.id;
  }
  for (const f of families) {
    const re = regexOf(f.match);
    if (re && (re.test(card.title) || re.test(card.branch ?? ''))) return f.id;
  }
  return null;
}

const FAMILY_TTL_MS = 5 * 60 * 1000;
const FAMILY_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'issuelinks', 'duedate', 'subtasks'];
let familyCache = null; // { key, at, promise }

const isDone = (issue) => issue?.fields?.status?.statusCategory?.key === 'done';

/** "[UI] Wave umbrella: modal → new modal (165 files)" → "modal". */
export function familyName(summary = '') {
  const rest = summary.replace(/^(\[[^\]]+\]\s*)?((wave umbrella|wave|stretch)\s*:\s*)?/i, '');
  return rest.split(/\s+(?:→|—|-|\()\s*/)[0].trim() || summary;
}

/** The epic's open tickets plus every ticket the file lists, cached for five minutes. */
function familyIssues(listed) {
  const base = epicMembersJql();
  const parts = [base && `((${base}) AND statusCategory != Done)`, listed.length && `key in (${listed.join(',')})`];
  const jql = parts.filter(Boolean).join(' OR ');
  if (!familyCache || familyCache.key !== jql || Date.now() - familyCache.at > FAMILY_TTL_MS) {
    const promise = searchIssues(jql, FAMILY_FIELDS);
    familyCache = { key: jql, at: Date.now(), promise };
    promise.catch(() => {
      if (familyCache?.promise === promise) familyCache = null;
    });
  }
  return familyCache.promise;
}

/**
 * Families and gaps from Jira. A family is a ticket the file lists (`jira` on a family entry) or
 * an epic ticket whose summary matches `jira.families`; its open "is blocked by" tickets are its
 * gaps. Status, owner (assignee), due date, areas (sub-tasks) and gate come from Jira; the file's
 * entry adds packages, match, mrs, extra tickets, note and a fallback forecast. File entries
 * without `jira` stay as file-only rows.
 */
async function jiraPlan(program) {
  const cfg = program.jira ?? {};
  const overlay = program.families ?? [];
  const byKey = new Map(overlay.filter((f) => f.jira).map((f) => [f.jira, f]));
  const re = regexOf(cfg.families);
  const linkType = cfg.blockLink ?? 'Blocks';
  const extra = [...byKey.values()].flatMap((o) => o.tickets ?? []);
  const issues = await familyIssues([...new Set([...byKey.keys(), ...extra])]);
  const issueByKey = new Map(issues.map((i) => [i.key, i]));

  const rowOf = (issue) => {
    const f = issue.fields ?? {};
    const o = byKey.get(issue.key) ?? {};
    // Open tickets that block the family ticket or any ticket the file lists for it.
    const linked = [issue, ...(o.tickets ?? []).map((t) => issueByKey.get(t)).filter(Boolean)];
    const blockerMap = new Map();
    for (const t of linked) {
      for (const l of t.fields?.issuelinks ?? []) {
        const b = l.type?.name === linkType ? l.inwardIssue : null;
        if (b && b.key !== issue.key && !isDone(b)) blockerMap.set(b.key, b);
      }
    }
    const blockers = [...blockerMap.values()];
    const subtasks = f.subtasks ?? [];
    return {
      ...o,
      id: issue.key,
      key: issue.key,
      url: jiraUrl(issue.key),
      name: o.name ?? familyName(f.summary),
      summary: f.summary ?? null,
      status: f.status?.name ?? null,
      done: isDone(issue),
      owner: f.assignee?.displayName ?? 'unassigned',
      forecast: f.duedate ?? o.forecast ?? null,
      forecastFrom: f.duedate ? 'jira' : o.forecast ? 'file' : null,
      tickets: [issue.key, ...subtasks.map((t) => t.key), ...(o.tickets ?? [])],
      areas: subtasks.length ? { open: subtasks.filter((t) => !isDone(t)).length, total: subtasks.length } : null,
      gate: blockers.length ? 'gated' : 'ready',
      gateNote: blockers.length ? `Blocked by ${blockers.map((b) => b.key).join(', ')}` : null,
      blockers: blockers.map((b) => ({ key: b.key, url: jiraUrl(b.key), summary: b.fields?.summary ?? null })),
    };
  };

  const rows = [];
  const used = new Set();
  for (const o of overlay) {
    if (!o.jira) {
      rows.push({ ...o, fileOnly: true });
      continue;
    }
    const issue = issueByKey.get(o.jira);
    if (!issue) continue;
    rows.push(rowOf(issue));
    used.add(issue.key);
  }
  const claimed = new Set(overlay.flatMap((o) => o.tickets ?? []));
  for (const issue of issues) {
    if (used.has(issue.key) || claimed.has(issue.key) || isDone(issue)) continue;
    if (!re?.test(issue.fields?.summary ?? '')) continue;
    rows.push(rowOf(issue));
  }

  // One gap row per blocker, naming every family it blocks; the file's `gaps` add files and a note.
  const gapNotes = new Map((program.gaps ?? []).map((g) => [g.key, g]));
  const gaps = new Map();
  for (const r of rows) {
    if (r.done) continue;
    for (const b of r.blockers ?? []) {
      const g = gaps.get(b.key) ?? { ...gapNotes.get(b.key), key: b.key, families: [] };
      g.families.push(r.name);
      gaps.set(b.key, g);
    }
  }
  const gapList = [...gaps.values()].map(({ families, ...g }) => ({ ...g, family: families.join(', ') }));
  return { families: rows, gaps: gapList, jiraFamilies: rows.filter((r) => r.key).length };
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
  let plan = { families: program.families ?? [], gaps: program.gaps ?? [], jiraFamilies: null };
  let jiraError = null;
  if (program.jira) {
    try {
      plan = await jiraPlan(program);
    } catch (err) {
      // Jira down: fall back to the file's own rows so the tab still shows counts.
      console.error('[program] Jira families:', err.message);
      jiraError = String(err.message ?? err);
      plan = { families: (program.families ?? []).map((f) => ({ ...f, id: f.jira ?? f.id })), gaps: [], jiraFamilies: null };
    }
  }
  const families = plan.families;
  const [files, monthAgo, gaps] = await Promise.all([
    pace?.enabled ? headFiles().catch(() => null) : null,
    pace?.enabled ? filesWeeksAgo(4).catch(() => null) : null,
    gapStates(plan.gaps).catch((err) => {
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

  const gapRows = plan.gaps.map((g) => ({
    ...g,
    url: g.key ? jiraUrl(g.key) : null,
    jira: gaps.get(g.key) ?? null,
  }));

  return {
    enabled: true,
    file: PROGRAM_FILE,
    title: program.title ?? null,
    updated: program.updated ?? null,
    source: program.jira ? 'jira' : 'file',
    jiraFamilies: plan.jiraFamilies,
    jiraError,
    families: rows,
    gaps: gapRows,
    reminders: activeReminders(program, Object.fromEntries(cards.map((c) => [c.key, c]))),
    gapIdleDays: program.gapIdleDays ?? 7,
  };
}
