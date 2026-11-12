const BASE =
  (process.env.GITLAB_BASE_URL ?? 'https://gitlab.com').replace(/\/$/, '') +
  '/api/v4';
const TOKEN = process.env.GITLAB_MCP_TOKEN ?? process.env.GITLAB_TOKEN ?? '';

// Review bots whose comments count as "agent review" and whose threads never
// count as human feedback: MRT_BOT_USERS=comma,separated,names.
const BOT_USERNAMES = new Set(
  (process.env.MRT_BOT_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Authors whose MRs you approve yourself (an agent that builds MRs for you). Their open MRs where
// you are assignee or reviewer leave the columns for the Your review tray. Empty hides the tray.
export const REVIEW_AUTHORS = new Set(
  (process.env.MRT_REVIEW_AUTHORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export function assertToken() {
  if (!TOKEN) {
    throw new Error('No GitLab token found. Export GITLAB_MCP_TOKEN (or GITLAB_TOKEN).');
  }
}

// project_<id>_bot_<hash> / group_<id>_bot_<hash> are GitLab access-token users.
const TOKEN_BOT = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/;
const isBot = (username) =>
  BOT_USERNAMES.has(username) || username.endsWith('-bot') || TOKEN_BOT.test(username);

async function gl(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': TOKEN } });
  if (!res.ok) throw new Error(`GitLab ${res.status} on ${path}`);
  return res.json();
}

// Which MRs are "yours": created_by_me (default), assigned_to_me, or both.
// Remote agents open MRs as their own account, usually assigned to the requester.
const MR_SCOPES = (process.env.MRT_MR_SCOPE ?? 'created_by_me') === 'both'
  ? ['created_by_me', 'assigned_to_me']
  : [process.env.MRT_MR_SCOPE ?? 'created_by_me'];

/** MRs in every configured scope, deduped (an MR you authored and are assigned to). */
async function listMyMergeRequests(params) {
  const seen = new Map();
  for (const scope of MR_SCOPES) {
    for (const mr of await glAll('/merge_requests', { ...params, scope })) {
      seen.set(`${mr.project_id}!${mr.iid}`, mr);
    }
  }
  return [...seen.values()];
}

let currentUser = null;
/** The token's user, fetched once. */
function me() {
  currentUser ??= gl('/user').catch((err) => {
    currentUser = null;
    throw err;
  });
  return currentUser;
}

/**
 * Open MRs for the Your review tray, whatever MRT_MR_SCOPE says: a review author's MRs where you
 * are assignee or reviewer, plus (with `others`) anyone else's MR where you are a reviewer.
 */
async function listReviewMergeRequests(params, username, { others = false } = {}) {
  const seen = new Map();
  if (others) {
    const batch = await glAll('/merge_requests', { ...params, scope: 'all', reviewer_username: username });
    for (const mr of batch) {
      if (mr.author?.username !== username) seen.set(`${mr.project_id}!${mr.iid}`, mr);
    }
  }
  for (const author of REVIEW_AUTHORS) {
    for (const role of ['assignee_username', 'reviewer_username']) {
      const batch = await glAll('/merge_requests', {
        ...params,
        scope: 'all',
        author_username: author,
        [role]: username,
      });
      for (const mr of batch) seen.set(`${mr.project_id}!${mr.iid}`, mr);
    }
  }
  return [...seen.values()];
}

/** One MR by project path and iid, as GitLab returns it. */
export function getMergeRequest(project, iid) {
  return gl(`/projects/${encodeURIComponent(project)}/merge_requests/${iid}`);
}

export async function glAll(path, params = {}) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gl(path, { ...params, per_page: 100, page });
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * Latest non-outdated agent review comment, parsed. Clean means what /request-reviews requires:
 * verdict APPROVE, zero issues, no Recommendations items, and published on the head commit.
 */
function parseAgentReview(discussions, headSha) {
  let latest = null;
  for (const d of discussions) {
    for (const n of d.notes ?? []) {
      const author = n.author?.username ?? '';
      if (!isBot(author) && !REVIEW_AUTHORS.has(author)) continue;
      if (!n.body?.includes('AI_CODE_REVIEW')) continue;
      if (n.body.includes('Outdated Review')) continue;
      if (!latest || n.created_at > latest.created_at) latest = n;
    }
  }
  if (!latest) {
    return {
      reviewed: false,
      clean: false,
      issueCount: null,
      recommendationCount: null,
      verdict: null,
      onHead: false,
      at: null,
    };
  }

  const body = latest.body;
  const counts = body.match(/AI_REVIEW_COUNTS critical=(\d+) major=(\d+) minor=(\d+)/);
  const issueCount = counts ? Number(counts[1]) + Number(counts[2]) + Number(counts[3]) : null;
  const assessment = body.match(/\*\*Overall Assessment\*\*:?\s*([A-Za-z_ ]+)/);
  const verdict = assessment ? assessment[1].trim().toUpperCase() : null;
  const recs = body.match(/### Recommendations\s*([\s\S]*?)(?:\n---|\n### |$)/);
  const recommendationCount = recs ? (recs[1].match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) ?? []).length : 0;
  const sha = (body.match(/AI_REVIEW_PUBLISHED (?:[a-z]+ )?([0-9a-f]{7,40})/) ??
    body.match(/Review commit: ([0-9a-f]{7,40})/))?.[1];
  // A push after the review means the bot has not looked at what would be shared.
  const onHead = Boolean(sha && headSha?.startsWith(sha));
  const clean =
    issueCount === 0 && verdict?.startsWith('APPROVE') === true && recommendationCount === 0 && onHead;
  return { reviewed: true, clean, issueCount, recommendationCount, verdict, onHead, at: latest.created_at };
}

/**
 * Files a risk note lists under its "<heading>: N historically risky file(s) changed" line, one
 * "- `path` — …" item each, up to the first line that is not a list item. Empty heading: none.
 */
function historyRiskyFiles(body) {
  if (!HISTORY_RE) return [];
  const block = body.match(HISTORY_RE);
  return block ? [...block[1].matchAll(/^[ \t]*- `([^`\n]+)`/gm)].map((m) => m[1]) : [];
}

/**
 * The latest risk verdict a review bot posted (`<!-- AI_RISK_VERDICT verdict=… score=N
 * threshold=N -->`), or null. The score decides whether the bot can approve on its own.
 */
function parseRisk(discussions) {
  let latest = null;
  for (const d of discussions) {
    for (const n of d.notes ?? []) {
      const author = n.author?.username ?? '';
      if (!isBot(author) && !REVIEW_AUTHORS.has(author)) continue;
      const m = n.body?.match(/AI_RISK_VERDICT verdict=([\w-]+) score=(\d+)(?: threshold=(\d+))?/);
      if (m && (!latest || n.created_at > latest.at)) {
        latest = {
          verdict: m[1],
          score: Number(m[2]),
          threshold: m[3] ? Number(m[3]) : null,
          at: n.created_at,
          historyRisky: historyRiskyFiles(n.body),
        };
      }
    }
  }
  return latest;
}

/**
 * People whose approval a push reset ("reset approvals from @x by pushing to the branch") and who
 * have not approved again: the review request already went out, so follow up instead of re-asking.
 */
function resetApprovers(discussions, approvedBy) {
  const current = new Set((approvedBy ?? []).map((a) => a.user?.username));
  const notes = discussions
    .flatMap((d) => d.notes ?? [])
    .filter((n) => n.system)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const state = new Map();
  for (const n of notes) {
    const body = n.body ?? '';
    const author = n.author?.username ?? '';
    if (/^approved this merge request/i.test(body)) state.set(author, 'approved');
    else if (/^unapproved this merge request/i.test(body)) state.delete(author);
    else if (/^reset approvals from /i.test(body)) {
      for (const [, user] of body.matchAll(/@([\w.-]+)/g)) state.set(user, 'reset');
    }
  }
  return [...state.entries()]
    .filter(([user, s]) => s === 'reset' && !current.has(user) && !isBot(user))
    .map(([user]) => user);
}

const latestSystemNote = (discussions, test) =>
  discussions
    .flatMap((d) => d.notes ?? [])
    .filter((n) => n.system && test(n))
    .reduce((at, n) => (!at || n.created_at > at ? n.created_at : at), null);

const csv = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Review lanes (see README "Review lanes"). Projects where a review bot can approve small MRs on
// its own; empty turns lane chips off.
const LANE_PROJECTS = new Set(csv(process.env.MRT_LANE_PROJECTS ?? ''));
const LANE_MAX_FILES = Number(process.env.MRT_LANE_MAX_FILES ?? 7);
export const LANE_RISK_MAX = Number(process.env.MRT_LANE_RISK_MAX ?? 45);
// Paths that always need a person, whatever the size.
const LANE_HUMAN_PATHS = process.env.MRT_LANE_HUMAN_PATHS ?? '';
const LANE_HUMAN_RE = LANE_HUMAN_PATHS ? new RegExp(LANE_HUMAN_PATHS) : null;

// Failed jobs known to flake: a red pipeline whose only failures match is an agent's retry.
const FLAKY_JOBS = process.env.MRT_FLAKY_JOBS ?? '';
const FLAKY_RE = FLAKY_JOBS ? new RegExp(FLAKY_JOBS) : null;

// Chromatic's commit statuses. Pending on the head sha after every CI job has finished means a
// person has to act in Chromatic: accept the snapshots (UI Tests) or approve the review (UI Review).
const CHROMATIC_PROJECTS = new Set(
  csv(process.env.MRT_CHROMATIC_PROJECTS ?? ''),
);
const CHROMATIC_STATUSES = csv(process.env.MRT_CHROMATIC_STATUS ?? 'UI Tests,UI Review');
const ACTIVE_STATUSES = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running']);

// Second human (see README "Second human"): a review author's MR that you could otherwise approve
// alone still needs another reviewer when it touches these paths. Globs in CODEOWNERS syntax, each
// optionally scoped to one project as `group/project:glob`.
const SECOND_REVIEW_PATHS = csv(process.env.MRT_SECOND_REVIEW_PATHS ?? '').map((entry) => {
  const at = entry.indexOf(':');
  const [project, glob] = at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : [null, entry];
  return { project, glob, re: globToRegExp(glob) };
});
// `group/project:Section`: that project's CODEOWNERS section (on the MR's target branch) adds its
// paths to the list above.
const SECOND_REVIEW_CODEOWNERS = csv(process.env.MRT_SECOND_REVIEW_CODEOWNERS ?? '').map((entry) => {
  const at = entry.lastIndexOf(':');
  return { project: entry.slice(0, at), section: entry.slice(at + 1) };
});
// The risk note's heading over its list of historically risky files; those files need a second
// human too. Empty ignores the list.
const HISTORY_HEADING = process.env.MRT_SECOND_REVIEW_HISTORY_HEADING ?? '';
const HISTORY_RE = HISTORY_HEADING
  ? new RegExp(
      `${HISTORY_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*\\d+ historically risky file[^\\n]*\\n((?:[ \\t]*- \`[^\`\\n]+\`[^\\n]*\\n?)+)`,
    )
  : null;

/**
 * A CODEOWNERS pattern as a RegExp over repo-relative paths (gitignore rules): a leading or
 * inner `/` anchors it to the root, a trailing `/` means everything under that directory, `*`
 * stays within one segment and `**` crosses them.
 */
function globToRegExp(glob) {
  let g = glob.trim();
  const anchored = g.startsWith('/') || g.slice(0, -1).includes('/');
  g = g.replace(/^\/+/, '');
  const dir = g.endsWith('/');
  if (dir) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}${dir ? '/' : '(?:$|/)'}`);
}

/** Path patterns in the named CODEOWNERS sections, in order; `!pattern` lines exclude. */
function codeownersSection(text, section) {
  const want = section.toLowerCase();
  const rules = [];
  let inSection = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\^?\[([^\]]+)\]/);
    if (header) {
      inSection = header[1].trim().toLowerCase() === want;
      continue;
    }
    if (!inSection) continue;
    const pattern = line.match(/^(?:\\.|\S)+/)[0].replace(/\\(.)/g, '$1');
    const exclude = pattern.startsWith('!');
    const glob = exclude ? pattern.slice(1) : pattern;
    rules.push({ glob, exclude, re: globToRegExp(glob) });
  }
  return rules;
}

const CODEOWNERS_TTL_MS = 60 * 60 * 1000;
const codeownersCache = new Map(); // `${project}@${ref}` -> { at, rules: Promise<rules by section> }
/** The project's CODEOWNERS sections named in MRT_SECOND_REVIEW_CODEOWNERS, cached for an hour. */
function codeownersRules(project, ref) {
  const sections = SECOND_REVIEW_CODEOWNERS.filter((c) => c.project === project).map((c) => c.section);
  if (sections.length === 0) return Promise.resolve([]);
  const cacheKey = `${project}@${ref}`;
  const hit = codeownersCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CODEOWNERS_TTL_MS) return hit.rules;
  const rules = (async () => {
    const pid = encodeURIComponent(project);
    // GitLab reads the first of these that exists.
    for (const path of ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']) {
      const file = await gl(`/projects/${pid}/repository/files/${encodeURIComponent(path)}`, { ref }).catch(
        () => null,
      );
      if (!file?.content) continue;
      const text = Buffer.from(file.content, 'base64').toString('utf8');
      return sections.map((section) => ({ section, file: path, rules: codeownersSection(text, section) }));
    }
    return [];
  })().catch((err) => {
    codeownersCache.delete(cacheKey);
    throw err;
  });
  codeownersCache.set(cacheKey, { at: Date.now(), rules });
  return rules;
}

/**
 * Why a review author's MR needs a second human reviewer, or null: the configured paths it
 * touches, the CODEOWNERS sections it touches, and the files the risk note calls historically
 * risky. Each reason names its rule and up to five matching paths.
 */
async function secondHumanInfo({ project, paths, risk, ref }) {
  const reasons = [];
  const add = (rule, matched) => {
    if (matched.length > 0) reasons.push({ rule, paths: matched.slice(0, 5), count: matched.length });
  };
  for (const p of SECOND_REVIEW_PATHS) {
    if (p.project && p.project !== project) continue;
    add(p.glob, paths.filter((path) => p.re.test(path)));
  }
  for (const { section, file, rules } of await codeownersRules(project, ref).catch(() => [])) {
    // Within a section the last matching pattern wins, so a later `!pattern` lifts an earlier one.
    const owned = paths.filter((path) => {
      let hit = false;
      for (const r of rules) if (r.re.test(path)) hit = !r.exclude;
      return hit;
    });
    add(`[${section}] in ${file}`, owned);
  }
  if (HISTORY_HEADING) add(`${HISTORY_HEADING} (historically risky)`, risk?.historyRisky ?? []);
  return reasons.length > 0 ? { reasons } : null;
}

const diffCache = new Map(); // `${key}@${sha}` -> paths
async function changedPaths(pid, iid, key, sha) {
  const cacheKey = `${key}@${sha}`;
  if (!diffCache.has(cacheKey)) {
    diffCache.set(
      cacheKey,
      glAll(`/projects/${pid}/merge_requests/${iid}/diffs`)
        .then((diffs) => [...new Set(diffs.flatMap((d) => [d.new_path, d.old_path]).filter(Boolean))])
        .catch((err) => {
          diffCache.delete(cacheKey);
          throw err;
        }),
    );
  }
  return diffCache.get(cacheKey);
}

/**
 * Which review lane an open MR is in: `agent` (a review author built it; you approve),
 * `auto` (small and off the human-only paths, so the bot may approve it alone) or `human`.
 * `warn` says how to get an MR of yours into the auto lane when it nearly fits.
 */
async function laneInfo({ mr, detail, discussions, key, project }) {
  const sha = detail.sha ?? mr.sha ?? '';
  if (REVIEW_AUTHORS.has(mr.author?.username)) {
    const risk = parseRisk(discussions);
    const paths = await changedPaths(mr.project_id, mr.iid, key, sha).catch(() => []);
    const secondHuman = await secondHumanInfo({
      project,
      paths,
      risk,
      ref: detail.target_branch ?? mr.target_branch ?? 'main',
    });
    return { lane: 'agent', files: Number.parseInt(detail.changes_count, 10) || null, risk, secondHuman };
  }
  if (!LANE_PROJECTS.has(project)) return null;
  const paths = await changedPaths(mr.project_id, mr.iid, key, sha).catch(() => null);
  const files = paths?.length ?? (Number.parseInt(detail.changes_count, 10) || null);
  const humanPaths = (paths ?? []).filter((p) => LANE_HUMAN_RE?.test(p));
  const risk = parseRisk(discussions);
  // Before the bot scores the MR, size and paths predict its lane; after, its score decides.
  const fits = files != null && files <= LANE_MAX_FILES && humanPaths.length === 0;
  const autoByRisk = risk ? risk.score <= LANE_RISK_MAX : null;
  const lane = (autoByRisk ?? fits) ? 'auto' : 'human';
  let warn = null;
  const nearlyFits = files != null && files > LANE_MAX_FILES && files <= LANE_MAX_FILES * 2;
  if (lane === 'human' && nearlyFits && humanPaths.length === 0) {
    // Splitting it would likely move it to the auto lane. Far bigger MRs are human by design.
    warn = `${files} files · split to ≤ ${LANE_MAX_FILES}?`;
  } else if (risk && !autoByRisk && files != null && files <= LANE_MAX_FILES) {
    warn = files > 2 ? `risk ${risk.score} · split?` : `risk ${risk.score} · needs a person`;
  }
  return {
    lane,
    predicted: !risk,
    files,
    maxFiles: LANE_MAX_FILES,
    humanPaths: humanPaths.slice(0, 5),
    risk,
    autoApprovable: autoByRisk === true,
    warn,
  };
}

/**
 * Dropped from the merge train and not back in it: the latest "removed … from the merge train"
 * note is newer than the latest add. `addedBy` is who put it in the train last.
 */
function trainDrop(discussions, inTrain) {
  if (inTrain) return null;
  const notes = discussions.flatMap((d) => d.notes ?? []).filter((n) => n.system);
  let added = null;
  let removed = null;
  for (const n of notes) {
    const body = n.body ?? '';
    if (/(added this merge request to the merge train|started a merge train)/i.test(body)) {
      if (!added || n.created_at > added.created_at) added = n;
    } else if (/removed this merge request from the merge train/i.test(body)) {
      if (!removed || n.created_at > removed.created_at) removed = n;
    }
  }
  if (!removed || (added && added.created_at > removed.created_at)) return null;
  const reason = (removed.body.match(/because (.+)$/is)?.[1] ?? '').trim().slice(0, 200) || null;
  return { at: removed.created_at, reason, addedBy: added?.author?.username ?? null };
}

/** Failed, blocking jobs on a red pipeline, and whether every one of them is a known flake. */
async function failedJobs(projectId, pipelineId) {
  const jobs = await glAll(`/projects/${projectId}/pipelines/${pipelineId}/jobs`);
  // A retried job leaves its failed attempt behind; only the newest attempt per name counts.
  const latest = new Map();
  for (const j of jobs) {
    const prev = latest.get(j.name);
    if (!prev || j.id > prev.id) latest.set(j.name, j);
  }
  const failed = [...latest.values()].filter((j) => j.status === 'failed' && !j.allow_failure);
  return {
    names: failed.map((j) => j.name),
    jobIds: failed.map((j) => j.id),
    allFlaky: failed.length > 0 && Boolean(FLAKY_RE) && failed.every((j) => FLAKY_RE.test(j.name)),
  };
}

/**
 * The Chromatic checks on the head that wait for a person, or null. `checks` lists each pending
 * one (UI Tests, UI Review) with its link; `since` is the oldest.
 */
async function chromaticWait(projectId, sha, pipelineId) {
  if (!sha || CHROMATIC_STATUSES.length === 0) return null;
  const statuses = await gl(`/projects/${projectId}/repository/commits/${sha}/statuses`, {
    per_page: 100,
  }).catch(() => []);
  const isChromatic = (s) => CHROMATIC_STATUSES.includes(s.name);
  const waiting = statuses.filter((s) => isChromatic(s) && ACTIVE_STATUSES.has(s.status));
  if (waiting.length === 0) return null;
  // The chromatic job waits for its build, so while any CI job runs the build may still be capturing.
  const ciActive = statuses.some(
    (s) => !isChromatic(s) && ACTIVE_STATUSES.has(s.status) && (!pipelineId || s.pipeline_id === pipelineId),
  );
  if (ciActive) return null;
  const checks = waiting
    .map((s) => ({ name: s.name, description: s.description ?? null, url: s.target_url ?? null, since: s.created_at }))
    .sort((a, b) => CHROMATIC_STATUSES.indexOf(a.name) - CHROMATIC_STATUSES.indexOf(b.name));
  const since = checks.map((c) => c.since).sort()[0];
  return { since, checks, url: checks[0].url, description: checks[0].description };
}

/**
 * Where a review-author MR stands for you: your approval on the current head (a push after your
 * approval, or a push that reset it, means approve again) and whether your own saved review
 * matches the head sha. `needsYou`: ready (not Draft), not approved by you on the head, and no
 * comments of yours waiting on the author (`feedbackAt`).
 */
function yourReviewState({ mr, detail, approvals, discussions, username, reviewNotes }) {
  const approvedBy = (approvals.approved_by ?? []).some((a) => a.user?.username === username);
  const approvedAt = latestSystemNote(
    discussions,
    (n) => n.author?.username === username && /^approved this merge request/i.test(n.body ?? ''),
  );
  const pushedAt = latestSystemNote(discussions, (n) => /^added \d+ (new )?commits?/i.test(n.body ?? ''));
  const approvedOnHead = approvedBy && !(approvedAt && pushedAt && pushedAt > approvedAt);
  const sha = detail.sha ?? mr.sha ?? '';
  const notePath = reviewNotes.get(`${mr.iid}-${sha.slice(0, 8).toLowerCase()}`) ?? null;
  const readyAt = latestSystemNote(discussions, (n) => /^marked this merge request as \*\*ready\*\*/i.test(n.body ?? ''));
  // Waiting on you since the newest push or un-drafting, whichever came last.
  const since = [pushedAt, readyAt, mr.created_at].filter(Boolean).sort().pop();
  const author = mr.author?.username ?? '';
  // A review author built it for you, so you also merge it; anyone else merges their own MR.
  const byReviewAuthor = REVIEW_AUTHORS.has(author);
  const verdict = notePath ? noteVerdict(notePath) : null;
  // Comments you posted after the newest push hand the move to the author, unless our review
  // says approve: then the approval is still yours to give.
  const feedbackAt =
    verdict === 'approve' ? null : feedbackOutAt(discussions, username, author, pushedAt, byReviewAuthor);
  return {
    since,
    noteVerdict: verdict,
    author,
    byReviewAuthor,
    feedbackAt,
    headSha: sha.slice(0, 8),
    approved: approvedOnHead,
    // A person besides you and the author approved (bots don't count): the second human a path
    // or risk rule asks for.
    othersApproved: (approvals.approved_by ?? []).some((a) => {
      const who = a.user?.username;
      return Boolean(who) && who !== username && who !== author && !isBot(who);
    }),
    // You approved an earlier head, or a push reset your approval.
    approvalReset:
      !approvedOnHead &&
      (approvedBy || resetApprovers(discussions, approvals.approved_by).includes(username)),
    notePath,
    needsYou: !detail.draft && !mr.draft && !approvedOnHead && !feedbackAt,
  };
}

/**
 * When your newest comment went out, if the next step is now the author's: no push since, and
 * (for a human author) no reply to you since. A review author answers with a push, so only a
 * push brings its MR back; its own bot chatter in your thread doesn't.
 */
function feedbackOutAt(discussions, username, author, pushedAt, byReviewAuthor) {
  const notes = (d) => (d.notes ?? []).filter((n) => !n.system);
  const yourAt = discussions
    .flatMap(notes)
    .filter((n) => n.author?.username === username)
    .reduce((at, n) => (!at || n.created_at > at ? n.created_at : at), null);
  if (!yourAt || (pushedAt && pushedAt > yourAt)) return null;
  if (byReviewAuthor) return yourAt;
  const mention = new RegExp(`@${username}\\b`, 'i');
  const replied = discussions.some((d) => {
    const ns = notes(d);
    const yourThread = ns.some((n) => n.author?.username === username);
    return ns.some(
      (n) =>
        n.author?.username === author && n.created_at > yourAt && (yourThread || mention.test(n.body ?? '')),
    );
  });
  return replied ? null : yourAt;
}

/** Whether an MR belongs in the Your review tray (see fetchOpenCards). */
function forYourReview({ mr, detail, username, reviewTray }) {
  const author = mr.author?.username;
  if (author === username) return false;
  const has = (users) => (users ?? []).some((u) => u.username === username);
  if (REVIEW_AUTHORS.has(author)) return has(detail.assignees) || has(detail.reviewers);
  return reviewTray && has(detail.reviewers);
}

/** Unresolved threads STARTED by a human reviewer (not a bot, not the MR author). */
function countUnresolvedHumanThreads(discussions, authorUsername) {
  return discussions.filter((d) => {
    const starter = (d.notes ?? [])[0];
    if (!starter?.resolvable) return false;
    const resolved = (d.notes ?? []).every((n) => !n.resolvable || n.resolved);
    const username = starter.author?.username ?? '';
    return !resolved && !isBot(username) && username !== authorUsername;
  }).length;
}

/**
 * Who started each unresolved thread from a person other than the given users (the author and
 * you), one entry per thread: the threads only a person can answer, not an agent.
 */
function unresolvedThreadStarters(discussions, exclude) {
  return discussions.flatMap((d) => {
    const starter = (d.notes ?? [])[0];
    if (!starter?.resolvable) return [];
    if ((d.notes ?? []).every((n) => !n.resolvable || n.resolved)) return [];
    const username = starter.author?.username ?? '';
    return !username || isBot(username) || exclude.includes(username) ? [] : [username];
  });
}

/** Maps a pipeline to a card health color: red | yellow | green | running | none. */
async function pipelineHealth(projectId, pipeline) {
  if (!pipeline) return { color: 'none', status: 'no pipeline', url: null };
  const base = { status: pipeline.status, url: pipeline.web_url ?? null };
  if (pipeline.status === 'failed' || pipeline.status === 'canceled') {
    return { ...base, color: 'red' };
  }
  if (pipeline.status === 'success') {
    // "Passed with warnings" = an allow_failure job failed; REST doesn't flag it on the pipeline.
    const jobs = await glAll(`/projects/${projectId}/pipelines/${pipeline.id}/jobs`);
    const warned = jobs.some((j) => j.status === 'failed' && j.allow_failure);
    return warned
      ? { ...base, color: 'yellow', status: 'passed with warnings' }
      : { ...base, color: 'green', status: 'passed' };
  }
  return { ...base, color: 'running' };
}

// A red merge-commit pipeline stops mattering once a later pipeline on the
// target branch (which contains the commit) passes; a canceled one was
// usually auto-canceled by the next merge, so it defers to that successor.
async function laterBranchHealth(projectId, mergePipeline, branchPipelines, health) {
  const later = branchPipelines.filter(
    (p) => p.id > mergePipeline.id && !['skipped', 'manual', 'created'].includes(p.status),
  );
  const passed = later.findLast((p) => p.status === 'success');
  if (passed) {
    const h = await pipelineHealth(projectId, passed);
    return { ...h, status: `${mergePipeline.status}, then ${h.status} on #${passed.id}` };
  }
  const running = later.find((p) => ['running', 'pending'].includes(p.status));
  if (mergePipeline.status === 'canceled' && running) {
    return { status: `canceled, superseded by #${running.id}`, url: running.web_url, color: 'running' };
  }
  return health;
}

import { extractJiraKeys, getEpicMembers, jiraUrl, resolveEpicByJira } from './jira.mjs';
import { findReviewNotes, noteVerdict } from './review-notes.mjs';

// Branch-name shapes used by Epic wave work, for MRs that carry no ticket key.
// Branch-name patterns that mark an MR as part of the epic; empty disables.
const EPIC_BRANCH_RE = process.env.FOCUSED_EPIC_BRANCH_PATTERNS
  ? new RegExp(process.env.FOCUSED_EPIC_BRANCH_PATTERNS, 'i')
  : /(?!)/;

/** Second-pass Epic detection through the Jira graph for cards the direct
 * membership check missed (moved keys, parents, labels, issue links). */
async function withJiraEpicResolution(card, epicMembers) {
  if (card.epic || card.jiraKeys.length === 0) return card;
  for (const key of card.jiraKeys) {
    if (await resolveEpicByJira(key, epicMembers)) return { ...card, epic: true };
  }
  return card;
}

function projectPath(mr) {
  // references.full looks like "group/project!123"
  return mr.references?.full?.split('!')[0] ?? `project-${mr.project_id}`;
}

const MR_URL_RE = /https?:\/\/[^\s)>\]]+?\/([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+)\/-\/merge_requests\/(\d+)/gi;
// Optional "project-name " or "group/project" immediately before "!123".
const MR_REF_RE = /(?:([a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)*)\s?)?!(\d+)\b/gi;
const BLOCKED_HINT_RE =
  /\b(merge first|prerequisite|depends? on|blocked|blocks? on|requires?|needs?|must (?:merge|land) (?:first|before)|before this)\b/i;
const FOLLOWS_HINT_RE = /\b(until|after|follow[- ]?up|fast[- ]follow|once|in production)\b/i;

/** Guess the relationship from the words around a mention, on the same line. */
function hintAround(text, at) {
  const start = text.lastIndexOf('\n', at) + 1;
  const end = (text.indexOf('\n', at) + 1 || text.length + 1) - 1;
  const line = text.slice(Math.max(start, at - 120), Math.min(end, at + 120));
  if (BLOCKED_HINT_RE.test(line)) return 'blocked-by';
  if (FOLLOWS_HINT_RE.test(line)) return 'follows';
  return null;
}

/** Other MRs this MR's title/description refer to. `project` is null for bare "!123". */
function extractMentionRefs(mr) {
  const text = `${mr.title}\n${mr.description ?? ''}`;
  const refs = [];
  let m;
  for (const re of [MR_URL_RE, MR_REF_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      refs.push({ project: m[1]?.toLowerCase() ?? null, iid: Number(m[2]), hint: hintAround(text, m.index) });
    }
  }
  return refs;
}

function baseCard(mr, epicMembers) {
  const { primary, all } = extractJiraKeys(mr);
  return {
    mentionRefs: extractMentionRefs(mr),
    key: `${projectPath(mr)}!${mr.iid}`,
    projectId: mr.project_id,
    jiraKey: primary,
    jiraKeys: all,
    jiraUrl: primary ? jiraUrl(primary) : null,
    epic:
      epicMembers.size > 0 &&
      (all.some((key) => epicMembers.has(key)) || EPIC_BRANCH_RE.test(mr.source_branch ?? '')),
    project: projectPath(mr),
    iid: mr.iid,
    branch: mr.source_branch ?? null,
    author: mr.author?.username ?? null,
    title: mr.title,
    webUrl: mr.web_url,
    state: mr.state,
    draft: Boolean(mr.draft),
    updatedAt: mr.updated_at,
    createdAt: mr.created_at,
    mergedAt: mr.merged_at ?? null,
  };
}

/**
 * `reviewTray`: the Your review tray is on, so other people's MRs where you are a reviewer are
 * fetched for it. Off, only a review author's MRs come in, and they show in the columns.
 */
export async function fetchOpenCards({ reviewTray = false } = {}) {
  // GitLab only recomputes has_conflicts when asked; without this it stays stale for days.
  const openParams = { state: 'opened', with_merge_status_recheck: true };
  const username = reviewTray || REVIEW_AUTHORS.size > 0 ? (await me()).username : null;
  const [mine, forReview, epicMembers] = await Promise.all([
    listMyMergeRequests(openParams),
    username ? listReviewMergeRequests(openParams, username, { others: reviewTray }) : [],
    getEpicMembers(),
  ]);
  const open = new Map(mine.map((mr) => [`${mr.project_id}!${mr.iid}`, mr]));
  for (const mr of forReview) open.set(`${mr.project_id}!${mr.iid}`, mr);
  const reviewNotes = username ? findReviewNotes() : new Map();
  const cards = await Promise.all(
    [...open.values()].map(async (mr) => {
      const pid = mr.project_id;
      const [detail, approvals, discussions, blocks] = await Promise.all([
        gl(`/projects/${pid}/merge_requests/${mr.iid}`),
        gl(`/projects/${pid}/merge_requests/${mr.iid}/approvals`),
        glAll(`/projects/${pid}/merge_requests/${mr.iid}/discussions`),
        gl(`/projects/${pid}/merge_requests/${mr.iid}/blocks`).catch(() => []),
      ]);
      const pipeline = await pipelineHealth(pid, detail.head_pipeline);
      const required = approvals.approvals_required ?? 0;
      const base = baseCard(mr, epicMembers);
      const inMergeTrain = Boolean(detail.merge_when_pipeline_succeeds || detail.auto_merge_enabled);
      const [lane, failed, chromatic] = await Promise.all([
        laneInfo({ mr, detail, discussions, key: base.key, project: base.project }).catch(() => null),
        pipeline.color === 'red' && detail.head_pipeline
          ? failedJobs(pid, detail.head_pipeline.id).catch(() => null)
          : null,
        CHROMATIC_PROJECTS.has(base.project) ? chromaticWait(pid, detail.sha, detail.head_pipeline?.id) : null,
      ]);
      return {
        ...base,
        lane,
        failedJobs: failed,
        chromatic,
        trainDrop: trainDrop(discussions, inMergeTrain),
        // Newest "requested review from" note: when the MR went to people.
        reviewRequestedAt: latestSystemNote(discussions, (n) => /^requested review from/i.test(n.body ?? '')),
        headSha: detail.sha ?? mr.sha ?? null,
        // A pipeline held only by Chromatic says so instead of "running".
        pipeline: chromatic && pipeline.color === 'running' ? { ...pipeline, status: 'waiting on Chromatic' } : pipeline,
        agentReview: parseAgentReview(discussions, detail.sha ?? mr.sha),
        unresolvedHumanThreads: countUnresolvedHumanThreads(discussions, mr.author?.username),
        otherThreadStarters: unresolvedThreadStarters(discussions, [mr.author?.username, username]),
        reviewerCount: (detail.reviewers ?? []).filter((r) => !isBot(r.username ?? '')).length,
        approvalsMet:
          required > 0
            ? approvals.approvals_left === 0
            : (approvals.approved_by?.length ?? 0) > 0,
        hasConflicts: Boolean(detail.has_conflicts) || detail.detailed_merge_status === 'conflict',
        // GitLab's own verdict on merging now: 'mergeable', 'not_approved', 'discussions_not_resolved'…
        mergeStatus: detail.detailed_merge_status ?? null,
        reapprovalFrom: resetApprovers(discussions, approvals.approved_by),
        // GitLab "Merge request dependencies": MRs that must merge before this one.
        gitlabBlockers: blocks
          .map((b) => b.blocking_merge_request)
          .filter(Boolean)
          .map((b) => {
            const [project] = (b.references?.full ?? '').split('!');
            return {
              key: `${project}!${b.iid}`,
              project,
              iid: b.iid,
              title: b.title,
              webUrl: b.web_url,
              state: b.state,
            };
          }),
        inMergeTrain,
        // Set for a review author's MR where you are assignee or reviewer, and (with the tray on)
        // for anyone else's MR where you are a reviewer.
        yourReview:
          username && forYourReview({ mr, detail, username, reviewTray })
            ? yourReviewState({ mr, detail, approvals, discussions, username, reviewNotes })
            : null,
      };
    }),
  );
  return Promise.all(cards.map((c) => withJiraEpicResolution(c, epicMembers)));
}

export async function fetchMergedCards() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [merged, epicMembers] = await Promise.all([
    listMyMergeRequests({ state: 'merged', updated_after: since }),
    getEpicMembers(),
  ]);
  const recent = merged.filter((mr) => mr.merged_at && mr.merged_at >= since);
  const branchPipelines = new Map();
  const pipelinesOn = (pid, ref) => {
    const key = `${pid}:${ref}`;
    if (!branchPipelines.has(key)) {
      branchPipelines.set(key, gl(`/projects/${pid}/pipelines`, { ref, per_page: 100 }));
    }
    return branchPipelines.get(key);
  };
  const cards = await Promise.all(
    recent.map(async (mr) => {
      const pid = mr.project_id;
      const sha = mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha;
      let postMergePipeline = { color: 'none', status: 'no pipeline', url: null };
      if (sha) {
        const pipes = await gl(`/projects/${pid}/pipelines`, { sha, per_page: 1 });
        postMergePipeline = await pipelineHealth(pid, pipes[0]);
        if (postMergePipeline.color === 'red') {
          postMergePipeline = await laterBranchHealth(
            pid,
            pipes[0],
            await pipelinesOn(pid, mr.target_branch),
            postMergePipeline,
          );
        }
      }
      return { ...baseCard(mr, epicMembers), pipeline: postMergePipeline, postMerge: true };
    }),
  );
  return Promise.all(cards.map((c) => withJiraEpicResolution(c, epicMembers)));
}
