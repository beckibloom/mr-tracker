import { execFileSync } from 'node:child_process';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import readline from 'node:readline';

import { glAll } from './gitlab.mjs';
import { getIssueSummaries, hasJiraWrite } from './jira.mjs';

const DEV_ROOT = process.env.MRT_DEV_ROOT ?? join(homedir(), 'dev');
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
// Gaps longer than this between Claude messages count as away time, not work.
const GAP_CAP_MS = 30 * 60 * 1000;
// Nominal signal weights (minutes) for point-in-time events.
const COMMIT_WEIGHT = 15;
const GITLAB_EVENT_WEIGHT = 5;

const fmtTime = (d) =>
  d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

function gitAuthor() {
  if (process.env.MRT_GIT_AUTHOR) return process.env.MRT_GIT_AUTHOR;
  try {
    return execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function findRepos() {
  try {
    const out = execFileSync(
      'find',
      [DEV_ROOT, '-maxdepth', '3', '-type', 'd', '-name', '.git'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/\/\.git$/, ''));
  } catch {
    return [];
  }
}

/** Commits authored on `date` across every repo under ~/dev. */
function scanGit(date) {
  const author = gitAuthor();
  const perKey = new Map();
  for (const repo of findRepos()) {
    let log = '';
    let branch = '';
    try {
      log = execFileSync(
        'git',
        [
          'log',
          '--all',
          `--since=${date} 00:00`,
          `--until=${date} 23:59`,
          `--author=${author}`,
          '--pretty=%ct|%s',
        ],
        { cwd: repo, encoding: 'utf8' },
      );
      branch = execFileSync('git', ['branch', '--show-current'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    } catch {
      continue;
    }
    const commits = log.split('\n').filter(Boolean);
    if (commits.length === 0) continue;
    const branchKey = branch.match(KEY_RE)?.[1] ?? null;
    const byKey = new Map();
    for (const line of commits) {
      const [ts, subject] = [line.slice(0, line.indexOf('|')), line.slice(line.indexOf('|') + 1)];
      // Commit subject key wins; otherwise attribute to the checked-out branch's key.
      const key = subject.match(KEY_RE)?.[1] ?? branchKey ?? `(no ticket: ${basename(repo)})`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(Number(ts) * 1000);
    }
    for (const [key, stamps] of byKey) {
      stamps.sort((a, b) => a - b);
      const entry = perKey.get(key) ?? { weight: 0, derivation: [] };
      entry.weight += stamps.length * COMMIT_WEIGHT;
      const range =
        stamps.length > 1
          ? `${fmtTime(new Date(stamps[0]))}–${fmtTime(new Date(stamps.at(-1)))}`
          : fmtTime(new Date(stamps[0]));
      entry.derivation.push(
        `git ${basename(repo)}: ${stamps.length} commit${stamps.length === 1 ? '' : 's'} ${range}`,
      );
      perKey.set(key, entry);
    }
  }
  return perKey;
}

/** Active Claude Code minutes on `date`, attributed per git branch's ticket key. */
async function scanClaude(date) {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + 86_400_000;
  const perKey = new Map();
  let dirs = [];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS);
  } catch {
    return perKey;
  }
  for (const dir of dirs) {
    const dirPath = join(CLAUDE_PROJECTS, dir);
    let files = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dirPath, file);
      // mtime pre-filter: a file untouched since before the target day has no entries on it.
      try {
        if (statSync(path).mtimeMs < dayStart) continue;
      } catch {
        continue;
      }
      const entries = [];
      const rl = readline.createInterface({ input: createReadStream(path) });
      for await (const line of rl) {
        try {
          const obj = JSON.parse(line);
          if (!obj.timestamp) continue;
          const t = new Date(obj.timestamp).getTime();
          if (t < dayStart || t >= dayEnd) continue;
          entries.push({ t, branch: obj.gitBranch ?? '', cwd: obj.cwd ?? '' });
        } catch {
          /* non-JSON line */
        }
      }
      if (entries.length === 0) continue;
      entries.sort((a, b) => a.t - b.t);
      const label = (e) =>
        e.branch.match(KEY_RE)?.[1] ?? `(no ticket: ${basename(e.cwd || dir)})`;
      const perKeyMs = new Map();
      for (let i = 1; i < entries.length; i++) {
        const gap = entries[i].t - entries[i - 1].t;
        if (gap > GAP_CAP_MS) continue;
        const key = label(entries[i]);
        perKeyMs.set(key, (perKeyMs.get(key) ?? 0) + gap);
      }
      for (const [key, ms] of perKeyMs) {
        const minutes = Math.round(ms / 60_000);
        if (minutes === 0) continue;
        const keyEntries = entries.filter((e) => label(e) === key);
        const entry = perKey.get(key) ?? { weight: 0, derivation: [] };
        entry.weight += minutes;
        entry.derivation.push(
          `Claude Code ${basename(keyEntries[0].cwd || dir)} ${fmtTime(new Date(keyEntries[0].t))}–${fmtTime(new Date(keyEntries.at(-1).t))} (${minutes}m active)`,
        );
        perKey.set(key, entry);
      }
    }
  }
  return perKey;
}

/** GitLab activity events on `date`, mapped to tickets via the tracked cards. */
async function scanGitLab(date, cards) {
  const perKey = new Map();
  const before = new Date(new Date(`${date}T00:00:00`).getTime() + 2 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const after = new Date(new Date(`${date}T00:00:00`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  let events = [];
  try {
    events = await glAll('/events', { after, before });
  } catch {
    return perKey;
  }
  const byMr = new Map(
    Object.values(cards).map((c) => [`${c.projectId}:${c.iid}`, c]),
  );
  const counts = new Map();
  for (const ev of events) {
    if (!ev.created_at?.startsWith(date)) continue;
    let key = null;
    const iid = ev.target_iid ?? ev.note?.noteable_iid;
    const card = byMr.get(`${ev.project_id}:${iid}`);
    if (card?.jiraKey) key = card.jiraKey;
    else if (ev.push_data?.ref) key = ev.push_data.ref.match(KEY_RE)?.[1] ?? null;
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counts) {
    perKey.set(key, {
      weight: n * GITLAB_EVENT_WEIGHT,
      derivation: [`GitLab: ${n} event${n === 1 ? '' : 's'} (pushes/comments/MR actions)`],
    });
  }
  return perKey;
}

export async function buildTimeReport(date, cards) {
  const [git, claude, gitlab] = await Promise.all([
    Promise.resolve(scanGit(date)),
    scanClaude(date),
    scanGitLab(date, cards),
  ]);
  const merged = new Map();
  for (const source of [git, claude, gitlab]) {
    for (const [key, { weight, derivation }] of source) {
      const entry = merged.get(key) ?? { weight: 0, derivation: [] };
      entry.weight += weight;
      entry.derivation.push(...derivation);
      merged.set(key, entry);
    }
  }
  const realKeys = [...merged.keys()].filter((k) => !k.startsWith('(no ticket'));
  const summaries = await getIssueSummaries(realKeys);
  const tickets = [...merged.entries()]
    .map(([key, { weight, derivation }]) => ({
      key: key.startsWith('(no ticket') ? null : key,
      label: key,
      summary: summaries[key] ?? null,
      weight,
      derivation,
    }))
    .sort((a, b) => b.weight - a.weight);
  return { date, hasJiraWrite: hasJiraWrite(), tickets };
}
