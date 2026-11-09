
const JIRA_BASE = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL ?? '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? '';
const EPIC_KEY = process.env.FOCUSED_EPIC_KEY ?? '';
const MEMBERS_TTL_MS = 60 * 60 * 1000;


const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** All Jira keys mentioned in the MR, in priority order: title, branch, description.
 * Case-sensitive on purpose: uppercasing the branch turns names like
 * docs/log-2026-10 into fake keys (LOG-2026).
 * `primary` drives the card's Jira link; `all` drives Epic-epic matching, so a
 * docs or test MR that only cites a Epic ticket in its description still lights up. */
export function extractJiraKeys(mr) {
  const all = [
    ...new Set(
      [mr.title, mr.source_branch, mr.description]
        .filter(Boolean)
        .flatMap((text) => [...text.matchAll(JIRA_KEY_RE)].map((m) => m[1])),
    ),
  ];
  return { primary: all[0] ?? null, all };
}

export const jiraUrl = (key) => (JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : null);

export const hasJiraWrite = () => Boolean(JIRA_EMAIL && JIRA_API_TOKEN);

const jiraAuth = () =>
  `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;

/** Jira summaries for a set of keys; silently skips unknown keys. */
export async function getIssueSummaries(keys) {
  if (!hasJiraWrite() || keys.length === 0) return {};
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        const res = await fetch(`${JIRA_BASE}/rest/api/3/issue/${key}?fields=summary`, {
          headers: { Authorization: jiraAuth() },
        });
        if (!res.ok) return [key, null];
        const data = await res.json();
        return [key, data.fields?.summary ?? null];
      } catch {
        return [key, null];
      }
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v));
}

/** minutes → Jira duration string ("1h 30m"); Jira rejects decimals. */
export function toJiraDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].join(' ').trim() || '0m';
}

/** Worklog write. `date` 'YYYY-MM-DD'; omit `started` when logging today. */
export async function addWorklog(key, minutes, date) {
  const body = { timeSpent: toJiraDuration(minutes) };
  const today = new Date().toLocaleDateString('en-CA');
  if (date && date !== today) {
    const d = new Date(`${date}T09:00:00`);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    body.started = `${date}T09:00:00.000${sign}${hh}${mm}`;
  }
  const res = await fetch(`${JIRA_BASE}/rest/api/3/issue/${key}/worklog`, {
    method: 'POST',
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status} logging to ${key}`);
  return body.timeSpent;
}

const localDay = (d) => d.toLocaleDateString('en-CA');

async function jiraGet(url) {
  const res = await fetch(url, { headers: { Authorization: jiraAuth(), Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${new URL(url).pathname}`);
  return res.json();
}

/**
 * Time the Jira user has logged over the last `days` days, today included, bucketed by
 * local day: { dates: ['YYYY-MM-DD', …], rows: [{ key, summary, url, minutes: {date: n} }] }.
 */
export async function getLoggedTime(days = 7) {
  if (!hasJiraWrite()) throw new Error('Set JIRA_EMAIL and JIRA_API_TOKEN to read logged time.');
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    dates.push(localDay(d));
  }
  const startMs = new Date(`${dates[0]}T00:00:00`).getTime();

  const [me, issues] = await Promise.all([
    jiraGet(`${JIRA_BASE}/rest/api/3/myself`),
    (async () => {
      const found = [];
      let pageToken = '';
      do {
        const url = new URL(`${JIRA_BASE}/rest/api/3/search/jql`);
        url.searchParams.set(
          'jql',
          `worklogAuthor = currentUser() AND worklogDate >= "${dates[0]}" ORDER BY key`,
        );
        url.searchParams.set('fields', 'summary');
        url.searchParams.set('maxResults', '100');
        if (pageToken) url.searchParams.set('nextPageToken', pageToken);
        const data = await jiraGet(url);
        found.push(...(data.issues ?? []));
        pageToken = data.nextPageToken ?? '';
      } while (pageToken);
      return found;
    })(),
  ]);

  const rows = await Promise.all(
    issues.map(async (issue) => {
      const minutes = Object.fromEntries(dates.map((d) => [d, 0]));
      let startAt = 0;
      for (;;) {
        const url = new URL(`${JIRA_BASE}/rest/api/3/issue/${issue.key}/worklog`);
        url.searchParams.set('startedAfter', String(startMs - 1));
        url.searchParams.set('startAt', String(startAt));
        url.searchParams.set('maxResults', '1000');
        const data = await jiraGet(url);
        const page = data.worklogs ?? [];
        for (const wl of page) {
          if (wl.author?.accountId !== me.accountId) continue;
          const day = localDay(new Date(wl.started));
          if (day in minutes) minutes[day] += Math.round(wl.timeSpentSeconds / 60);
        }
        startAt += page.length;
        if (page.length === 0 || startAt >= (data.total ?? 0)) break;
      }
      return { key: issue.key, summary: issue.fields?.summary ?? null, url: jiraUrl(issue.key), minutes };
    }),
  );

  return { dates, rows: rows.filter((r) => Object.values(r.minutes).some(Boolean)) };
}

const EPIC_LABELS = new Set(
  (process.env.FOCUSED_EPIC_LABELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;
const resolveCache = new Map(); // key -> { at, promise }

/**
 * Epic linkage for a key that isn't a direct epic member, via the Jira graph:
 * the issue was moved to a member key (e.g. OLD-12 → NEW-34), its parent is the
 * epic or a member, it carries a Epic label, or it links to the epic or a member.
 */
export function resolveEpicByJira(key, members) {
  if (!hasJiraWrite()) return Promise.resolve(false);
  const cached = resolveCache.get(key);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.promise;
  const promise = (async () => {
    try {
      const res = await fetch(
        `${JIRA_BASE}/rest/api/3/issue/${key}?fields=parent,labels,issuelinks`,
        { headers: { Authorization: jiraAuth() } },
      );
      if (!res.ok) return false;
      const data = await res.json();
      const f = data.fields ?? {};
      const linkedKeys = (f.issuelinks ?? [])
        .map((l) => (l.inwardIssue ?? l.outwardIssue)?.key)
        .filter(Boolean);
      return (
        members.has(data.key) || // issue was moved onto a member key
        (f.parent && members.has(f.parent.key)) ||
        (f.labels ?? []).some((l) => EPIC_LABELS.has(l)) ||
        linkedKeys.some((k) => members.has(k))
      );
    } catch {
      return false;
    }
  })();
  resolveCache.set(key, { at: Date.now(), promise });
  return promise;
}

// Children of the epic, plus anything carrying one of FOCUSED_EPIC_JQL_LABELS (tickets filed under
// another parent but labelled for the epic's program). Empty labels: children only.
const EPIC_JQL_LABELS = (process.env.FOCUSED_EPIC_JQL_LABELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function epicMembersJql() {
  const labels = EPIC_JQL_LABELS.map((l) => `"${l.replace(/"/g, '')}"`).join(', ');
  return labels ? `parent = ${EPIC_KEY} OR labels in (${labels})` : `parent = ${EPIC_KEY}`;
}

/** Jira issues by key with the given fields; [] without credentials or on error. */
export async function getIssues(keys, fields) {
  if (!hasJiraWrite() || keys.length === 0) return [];
  const url = new URL(`${JIRA_BASE}/rest/api/3/search/jql`);
  url.searchParams.set('jql', `key in (${keys.join(',')})`);
  url.searchParams.set('fields', fields.join(','));
  url.searchParams.set('maxResults', '100');
  const data = await jiraGet(url);
  return data.issues ?? [];
}

/** The subset of `keys` that sit in an open sprint. */
export async function keysInOpenSprint(keys) {
  if (!hasJiraWrite() || keys.length === 0) return new Set();
  const url = new URL(`${JIRA_BASE}/rest/api/3/search/jql`);
  url.searchParams.set('jql', `key in (${keys.join(',')}) AND sprint in openSprints()`);
  url.searchParams.set('fields', 'key');
  url.searchParams.set('maxResults', '100');
  const data = await jiraGet(url);
  return new Set((data.issues ?? []).map((i) => i.key));
}

let myself = null;
/** The Jira user behind JIRA_EMAIL, fetched once. */
export function jiraMyself() {
  myself ??= jiraGet(`${JIRA_BASE}/rest/api/3/myself`).catch((err) => {
    myself = null;
    throw err;
  });
  return myself;
}

let epicMembers = null;
let epicFetchedAt = 0;

/**
 * Tickets in the Epic epic. Live JQL query when Jira creds are present
 * (refreshed hourly); otherwise the bundled seed list.
 */
export async function getEpicMembers() {
  if (!EPIC_KEY) return new Set();
  if (epicMembers && Date.now() - epicFetchedAt < MEMBERS_TTL_MS) return epicMembers;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    epicMembers = new Set([EPIC_KEY]);
    epicFetchedAt = Date.now();
    return epicMembers;
  }
  try {
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
    const members = new Set([EPIC_KEY]);
    let pageToken = '';
    do {
      const url = new URL(`${JIRA_BASE}/rest/api/3/search/jql`);
      url.searchParams.set('jql', epicMembersJql());
      url.searchParams.set('fields', 'key');
      url.searchParams.set('maxResults', '200');
      if (pageToken) url.searchParams.set('nextPageToken', pageToken);
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) throw new Error(`Jira ${res.status}`);
      const data = await res.json();
      for (const issue of data.issues ?? []) members.add(issue.key);
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    epicMembers = members;
  } catch (err) {
    console.error('[jira] falling back to seed list:', err.message);
    epicMembers = new Set([EPIC_KEY]);
  }
  epicFetchedAt = Date.now();
  return epicMembers;
}
