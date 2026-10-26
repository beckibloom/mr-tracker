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

export async function glAll(path, params = {}) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gl(path, { ...params, per_page: 100, page });
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Latest non-outdated agent review comment, parsed. */
function parseAgentReview(discussions) {
  let latest = null;
  for (const d of discussions) {
    for (const n of d.notes ?? []) {
      if (!isBot(n.author?.username ?? '')) continue;
      if (!n.body?.includes('AI_CODE_REVIEW')) continue;
      if (n.body.includes('Outdated Review')) continue;
      if (!latest || n.created_at > latest.created_at) latest = n;
    }
  }
  if (!latest) return { reviewed: false, clean: false, issueCount: null, verdict: null };

  const counts = latest.body.match(/AI_REVIEW_COUNTS critical=(\d+) major=(\d+) minor=(\d+)/);
  const issueCount = counts ? Number(counts[1]) + Number(counts[2]) + Number(counts[3]) : null;
  const assessment = latest.body.match(/\*\*Overall Assessment\*\*:?\s*([A-Za-z_ ]+)/);
  const verdict = assessment ? assessment[1].trim().toUpperCase() : null;
  // "Any issues at all (even minor)" keeps the MR in agent iteration.
  const clean = issueCount === 0 && (verdict === null || verdict.startsWith('APPROVE'));
  return { reviewed: true, clean, issueCount, verdict };
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
    title: mr.title,
    webUrl: mr.web_url,
    state: mr.state,
    draft: Boolean(mr.draft),
    updatedAt: mr.updated_at,
    createdAt: mr.created_at,
    mergedAt: mr.merged_at ?? null,
  };
}

export async function fetchOpenCards() {
  const [open, epicMembers] = await Promise.all([
    listMyMergeRequests({ state: 'opened' }),
    getEpicMembers(),
  ]);
  const cards = await Promise.all(
    open.map(async (mr) => {
      const pid = mr.project_id;
      const [detail, approvals, discussions] = await Promise.all([
        gl(`/projects/${pid}/merge_requests/${mr.iid}`),
        gl(`/projects/${pid}/merge_requests/${mr.iid}/approvals`),
        glAll(`/projects/${pid}/merge_requests/${mr.iid}/discussions`),
      ]);
      const pipeline = await pipelineHealth(pid, detail.head_pipeline);
      const required = approvals.approvals_required ?? 0;
      return {
        ...baseCard(mr, epicMembers),
        pipeline,
        agentReview: parseAgentReview(discussions),
        unresolvedHumanThreads: countUnresolvedHumanThreads(discussions, mr.author?.username),
        reviewerCount: (detail.reviewers ?? []).filter((r) => !isBot(r.username ?? '')).length,
        approvalsMet:
          required > 0
            ? approvals.approvals_left === 0
            : (approvals.approved_by?.length ?? 0) > 0,
        hasConflicts: Boolean(detail.has_conflicts),
        inMergeTrain: Boolean(
          detail.merge_when_pipeline_succeeds || detail.auto_merge_enabled,
        ),
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
