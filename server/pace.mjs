import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/*
 * Migration pace: how many files on a repo's main branch still import a package scope you are
 * removing, counted each Monday, and whether the removal rate meets a weekly target.
 *
 * Counting rule: files with a source extension on MRT_PACE_REF whose text has the scope in a
 * module-reference position (`from '…'`, `import '…'`, `import('…')`, `require('…')`). One
 * file counts once however many packages it imports. MRT_PACE_EXCLUDE paths are skipped;
 * MRT_PACE_SPLIT paths are counted and also reported on their own.
 */
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const csv = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const REPO = expand(process.env.MRT_PACE_REPO ?? '');
const REF = process.env.MRT_PACE_REF ?? 'origin/main';
const SCOPE = process.env.MRT_PACE_SCOPE ?? '';
const EXCLUDE = csv(process.env.MRT_PACE_EXCLUDE ?? '');
const SPLIT = process.env.MRT_PACE_SPLIT ?? '';
const SPLIT_LABEL = process.env.MRT_PACE_SPLIT_LABEL ?? '';
const TARGET = Number(process.env.MRT_PACE_TARGET ?? 50);
const LABEL = process.env.MRT_PACE_LABEL ?? 'files';
// The date the plan promises; the header shows the weekly rate that would meet it.
const GOAL_DATE = process.env.MRT_PACE_GOAL_DATE ?? '';
// A working day's share of the weekly target (Monday to Friday).
const DAILY_TARGET = Number(process.env.MRT_PACE_DAILY_TARGET ?? 0) || Math.ceil(TARGET / 5);
// Working hours for pro-rating today, local time, e.g. 9-17.
const [DAY_START, DAY_END] = (process.env.MRT_PACE_WORK_HOURS ?? '9-17').split('-').map(Number);
const DAYS = 10; // working days shown as daily bars
const WEEKS = 8;
const WINDOW_WEEKS = 4;
const REFRESH_MS = 15 * 60 * 1000; // fetch and recount; today's colour lags merges by at most this
const EXTENSIONS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];

export const PACE_ENABLED = Boolean(REPO && SCOPE);

const localDate = (d) => d.toLocaleDateString('en-CA');
const ere = (s) => s.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
const PATTERN = `(from |import\\(|require\\(|import )['"]${ere(SCOPE)}[a-z0-9._-]*`;
const PACKAGE_RE = new RegExp(`${SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z0-9._-]*`);

async function git(args) {
  const { stdout } = await run('git', ['-C', REPO, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const censusCache = new Map(); // sha -> Promise<Map<path, Set<pkg>>>

/** Every counted file at `sha` and the packages it imports. */
function census(sha) {
  if (!censusCache.has(sha)) {
    const pathspecs = [...EXTENSIONS, ...EXCLUDE.map((p) => `:!${p.replace(/\/?$/, '/')}**`)];
    const promise = git(['grep', '-o', '-E', PATTERN, sha, '--', ...pathspecs])
      .catch((err) => {
        // git grep exits 1 when nothing matches.
        if (err.code === 1 && !err.stderr) return '';
        throw err;
      })
      .then((out) => {
        const files = new Map();
        const prefix = `${sha}:`;
        for (const line of out.split('\n')) {
          if (!line.startsWith(prefix)) continue;
          const rest = line.slice(prefix.length);
          const cut = rest.indexOf(':');
          const path = rest.slice(0, cut);
          const pkg = rest.slice(cut + 1).match(PACKAGE_RE)?.[0];
          if (!pkg) continue;
          if (!files.has(path)) files.set(path, new Set());
          files.get(path).add(pkg);
        }
        return files;
      });
    promise.catch(() => censusCache.delete(sha));
    censusCache.set(sha, promise);
  }
  return censusCache.get(sha);
}

const isSplit = (path) => Boolean(SPLIT) && path.startsWith(SPLIT);

function summarize(files) {
  let split = 0;
  const perPackage = {};
  for (const [path, pkgs] of files) {
    if (isSplit(path)) split += 1;
    for (const p of pkgs) perPackage[p] = (perPackage[p] ?? 0) + 1;
  }
  return { total: files.size, split, perPackage };
}

/** Files importing any of `packages` (names with or without the scope's org prefix). */
export function countFor(files, packages) {
  const want = new Set(packages.map((p) => (p.startsWith('@') ? p : `${SCOPE.split('/')[0]}/${p}`)));
  let total = 0;
  let split = 0;
  for (const [path, pkgs] of files) {
    if (![...pkgs].some((p) => want.has(p))) continue;
    total += 1;
    if (isSplit(path)) split += 1;
  }
  return { total, split };
}

/** Files that imported any of `packages` in `before` and no longer do in `after`. */
export function removedBetween(before, after, packages) {
  const want = new Set(packages.map((p) => (p.startsWith('@') ? p : `${SCOPE.split('/')[0]}/${p}`)));
  const hits = (pkgs) => Boolean(pkgs) && [...pkgs].some((p) => want.has(p));
  let removed = 0;
  for (const [path, pkgs] of before) if (hits(pkgs) && !hits(after.get(path))) removed += 1;
  return removed;
}

/** How much of the working week (Monday 00:00 to Friday 24:00) has passed, 0 to 1. */
function weekFraction(d = new Date()) {
  const day = (d.getDay() + 6) % 7; // Monday 0
  if (day >= 5) return 1;
  return Math.min((day + (d.getHours() + d.getMinutes() / 60) / 24) / 5, 1);
}

/** How much of today's working hours has passed, 0 to 1; null on a weekend. */
function dayFraction(d = new Date()) {
  const day = (d.getDay() + 6) % 7;
  if (day >= 5) return null;
  const h = d.getHours() + d.getMinutes() / 60;
  return Math.min(Math.max((h - DAY_START) / (DAY_END - DAY_START), 0), 1);
}

/** Midnight of the last `n` working days before today, oldest first, then today's midnight. */
function workdayStarts(n) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  const d = new Date(today);
  while (out.length < n) {
    d.setDate(d.getDate() - 1);
    if ((d.getDay() + 6) % 7 < 5) out.unshift(new Date(d));
  }
  return [...out, today];
}

const mondayOf = (d) => {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};

async function shaAt(date) {
  const out = await git(['rev-list', '-1', '--first-parent', `--before=${date.toISOString()}`, REF]);
  return out.trim() || null;
}

let current = null; // { at, promise }
let fetchedAt = 0;

async function compute() {
  if (Date.now() - fetchedAt > REFRESH_MS) {
    const branch = REF.replace(/^origin\//, '');
    await git(['fetch', '--quiet', 'origin', branch]).catch((err) => {
      console.error('[pace] fetch failed, counting the last fetched ref:', err.message);
    });
    fetchedAt = Date.now();
  }
  const headSha = (await git(['rev-parse', REF])).trim();
  const head = await census(headSha);
  const headDate = (await git(['show', '-s', '--format=%cI', headSha])).trim();

  // Mondays, oldest first, then the current head.
  const thisMonday = mondayOf(new Date());
  const mondays = [];
  for (let i = WEEKS; i >= 0; i--) {
    const d = new Date(thisMonday);
    d.setDate(d.getDate() - 7 * i);
    mondays.push(d);
  }
  // Each point carries the files removed from and added to the count since the point before.
  // Removed is a set difference, so code moved in from elsewhere doesn't hide a week's progress.
  const points = [];
  let prev = null;
  const diff = (a, b) => {
    let removed = 0;
    let added = 0;
    for (const k of a.keys()) if (!b.has(k)) removed += 1;
    for (const k of b.keys()) if (!a.has(k)) added += 1;
    return { removed, added };
  };
  for (const d of mondays) {
    const sha = await shaAt(d);
    if (!sha) continue;
    const files = await census(sha);
    points.push({
      date: d.toISOString().slice(0, 10),
      sha: sha.slice(0, 11),
      ...summarize(files),
      ...(prev ? diff(prev, files) : { removed: null, added: null }),
    });
    prev = files;
  }
  const now = {
    date: headDate.slice(0, 10),
    sha: headSha.slice(0, 11),
    ...summarize(head),
    ...(prev ? diff(prev, head) : { removed: null, added: null }),
    head: true,
  };

  // Rate: mean files removed per week over the last WINDOW_WEEKS whole weeks (Monday to Monday).
  const recent = points.slice(-WINDOW_WEEKS).filter((p) => p.removed != null);
  const perWeek = recent.length
    ? Math.round((recent.reduce((n, p) => n + p.removed, 0) / recent.length) * 10) / 10
    : null;

  const weeksToGoal = GOAL_DATE
    ? Math.max((new Date(`${GOAL_DATE}T12:00:00`) - Date.now()) / (7 * 24 * 3600 * 1000), 0.1)
    : null;
  const neededForGoal = weeksToGoal ? Math.ceil(now.total / weeksToGoal) : null;
  const finishAtRate =
    perWeek && perWeek > 0
      ? new Date(Date.now() + (now.total / perWeek) * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
      : null;
  const avgStatus =
    perWeek == null ? 'unknown' : perWeek >= TARGET ? 'good' : perWeek >= TARGET * 0.8 ? 'warn' : 'bad';
  // The header's colour is this week against the target, pro-rated over the working week
  // (Monday to Friday): by Wednesday noon the week should have removed half the target.
  const expectedByNow = Math.ceil(TARGET * weekFraction());
  const weekStatus =
    now.removed == null ? 'unknown' : now.removed >= TARGET ? 'good' : now.removed >= expectedByNow ? 'warn' : 'bad';

  // Daily: files removed each working day (midnight to midnight, or to now for today). The
  // header's colour is today against the daily target, pro-rated over working hours.
  const starts = workdayStarts(DAYS);
  const daySets = [];
  for (const d of starts) {
    const sha = await shaAt(d);
    daySets.push(sha ? await census(sha) : null);
  }
  const daily = starts.map((d, i) => {
    const from = daySets[i];
    const to = i + 1 < starts.length ? daySets[i + 1] : head;
    // Each day runs to the next working day's midnight, so weekend merges count for Friday.
    return {
      date: localDate(d),
      ...(from && to ? diff(from, to) : { removed: null, added: null }),
      today: i === starts.length - 1,
    };
  });
  const today = daily[daily.length - 1];
  const fraction = dayFraction();
  const expectedToday = fraction == null ? null : Math.ceil(DAILY_TARGET * fraction);
  const status =
    fraction == null || today.removed == null
      ? 'rest'
      : today.removed >= DAILY_TARGET
        ? 'good'
        : today.removed >= expectedToday
          ? 'warn'
          : 'bad';

  return {
    enabled: true,
    label: LABEL,
    splitLabel: SPLIT ? SPLIT_LABEL : null,
    repo: REPO,
    ref: REF,
    target: TARGET,
    goalDate: GOAL_DATE || null,
    windowWeeks: WINDOW_WEEKS,
    perWeek,
    thisWeek: now.removed,
    expectedByNow,
    weekStatus,
    avgStatus,
    dailyTarget: DAILY_TARGET,
    expectedToday,
    today: { removed: today.removed, added: today.added },
    daily,
    neededForGoal,
    finishAtRate,
    status,
    now,
    points,
    computedAt: new Date().toISOString(),
  };
}

/** The pace report, recomputed at most hourly. */
export async function getPace({ fresh = false } = {}) {
  if (!PACE_ENABLED) return { enabled: false };
  if (fresh) fetchedAt = 0;
  if (fresh || !current || Date.now() - current.at > REFRESH_MS) {
    const entry = { at: Date.now(), promise: compute() };
    entry.promise.catch(() => {
      if (current === entry) current = null;
    });
    current = entry;
  }
  return current.promise;
}

/** Counted files on the current head, for per-family counts. Null when pace is off. */
export async function headFiles() {
  if (!PACE_ENABLED) return null;
  const pace = await getPace();
  const sha = (await git(['rev-parse', pace.now.sha])).trim();
  return census(sha);
}

/** Counted files `weeks` weeks ago, for per-family deltas. */
export async function filesWeeksAgo(weeks) {
  if (!PACE_ENABLED) return null;
  const d = new Date();
  d.setDate(d.getDate() - 7 * weeks);
  const sha = await shaAt(d);
  return sha ? census(sha) : null;
}
