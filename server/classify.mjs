export const COLUMNS = [
  { id: 'draft', label: 'Draft' },
  { id: 'agent-iteration', label: 'Agent iteration' },
  { id: 'ready-human', label: 'Ready to share' },
  { id: 'waiting-approval', label: 'Waiting for approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'merge-train', label: 'Merge train' },
  { id: 'merge-failed', label: 'Merge failed' },
];

// 'merged' and 'review' are not visible columns; they feed the collapsed trays.
export function classify(card, { reviewTray = false } = {}) {
  if (card.state === 'merged') {
    if (card.pipeline.color === 'red') return 'merge-failed';
    if (card.pipeline.color === 'running') return 'merge-train'; // merge pipeline still running
    return 'merged';
  }
  // A review author's MR waiting on you lives only in the Your review tray.
  if (reviewTray && card.yourReview) return 'review';
  // Auto-merge armed before approval is still waiting on humans, not on the train.
  if (card.inMergeTrain && card.approvalsMet) return 'merge-train';
  if (card.draft) return 'draft';
  // Approval requirements met counts even with unresolved threads (by design).
  if (card.approvalsMet) return 'approved';
  // Shared = reviewers assigned, auto-merge armed, or dragged here by hand.
  if (card.inMergeTrain || card.reviewerCount > 0) return 'waiting-approval';
  const pipelinePassing = card.pipeline.color === 'green' || card.pipeline.color === 'yellow';
  // Not shareable while it can't merge: conflicts, or an MR it waits on is still open.
  const blocked = card.hasConflicts || (card.openBlockers?.length ?? 0) > 0;
  if (card.agentReview.reviewed && card.agentReview.clean && pipelinePassing && !blocked) {
    return 'ready-human';
  }
  return 'agent-iteration';
}

// Appended to steps an agent can take on its own, naming the command that runs them.
const BY_AGENT = '';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "!972" for a blocker in the card's own project, "camp-design-system!972" for another one.
const blockerRef = (card, key) => {
  const [project, iid] = key.split('!');
  return project === card.project ? `!${iid}` : `${project.split('/').pop()}!${iid}`;
};

function blockedReason(card) {
  const refs = (card.openBlockers ?? []).map((b) => blockerRef(card, b.key));
  const merge = refs.length > 0 ? `merge ${refs.join(', ')} first` : null;
  if (!card.hasConflicts) return merge;
  return merge ? `${merge}, then rebase` : `rebase to clear merge conflicts${BY_AGENT}`;
}

function agentWaitReason(card) {
  if (card.draft) return 'finish the Draft, then mark it ready';
  if (card.pipeline?.color === 'red') {
    const names = card.failedJobs?.names ?? [];
    return `fix the failed ${names.length > 0 ? names.join(', ') : 'pipeline'}${BY_AGENT}`;
  }
  const r = card.agentReview ?? {};
  if (!r.reviewed) return 'wait for the first agent review';
  if (!r.onHead) return 'wait for the agent review of the latest push';
  const found = [
    r.issueCount > 0 ? plural(r.issueCount, 'issue') : null,
    r.recommendationCount > 0 ? plural(r.recommendationCount, 'recommendation') : null,
  ].filter(Boolean);
  if (found.length > 0) return `fix ${found.join(' and ')} from the agent review${BY_AGENT}`;
  if (r.verdict && !r.verdict.startsWith('APPROVE')) {
    return `address the agent review (${r.verdict.toLowerCase()})${BY_AGENT}`;
  }
  if (card.pipeline?.color === 'none') return 'start a pipeline';
  return null;
}

/**
 * Whose move an open card waits on, for the Your move strip and the card's turn label. First
 * match wins; `turnReason` is set only for `you`.
 *
 *   you       merge failed · a review-tray MR needs you · re-approval needed · approved but not
 *             in the merge train · unresolved human threads on your own MR · Ready to share
 *   author    someone else's review-tray MR that doesn't need you right now
 *   blocked   merge conflicts, or an open blocker (board link or GitLab dependency)
 *   ci        pipeline running, or in the merge train
 *   reviewer  Waiting for approval
 *   agent     Agent iteration, Draft, and anything else
 *
 * Two agent turns carry an `agentReason`, since an agent (tend) acts on them without asking: a
 * red pipeline whose only failures are known flakes (retry), and an approved MR the merge train
 * dropped (retry the flake, then re-add).
 *
 * Every other turn carries a `waitReason`: the next step as an instruction ("merge !972 first",
 * "fix 1 issue from the agent review"), so a ‼ card waiting on someone else still says what to do.
 *
 * `column` is where the card shows (a manual override wins over the automatic column).
 */
// What a person does in Chromatic for each check that waits (server/gitlab.mjs chromaticWait).
const CHROMATIC_ACTIONS = {
  'UI Tests': 'accept or deny the snapshot changes (UI Tests)',
  'UI Review': 'approve the review (UI Review)',
};
export const chromaticStep = (chromatic) =>
  `in Chromatic, ${chromatic.checks.map((c) => CHROMATIC_ACTIONS[c.name] ?? `clear ${c.name}`).join(' and ')}`;

// GitLab merge statuses that don't stop a merge: mergeable now, or still being worked out after
// main moved (the other checks below stand in until GitLab settles).
const MERGE_STATUS_OK = new Set(['mergeable', 'checking', 'unchecked', 'approvals_syncing', 'preparing']);

/**
 * Ready to merge, for the green ref chip in Your move: the only thing left is to merge it (on a
 * review author's MR, approve and merge). Only MRs you merge count: your own and review
 * authors'; anyone else merges their own.
 *
 * All of: open, not Draft, not already in the train · pipeline passed (warnings allowed) and no
 * Chromatic check waiting · agent review clean on the head commit · no conflicts or open
 * blockers · approved: on your own MR, GitLab's approval rules met; on a review author's MR, our
 * saved review of the head says approve (or you already approved), plus another approver when
 * the MR needs a second human · and GitLab itself would merge it, which adds resolved threads
 * and no "request changes". On a review author's MR, GitLab's `not_approved` is fine: the
 * missing approval is yours.
 */
export function mergeReady(card) {
  if (card.state !== 'opened' || card.draft || card.inMergeTrain) return false;
  const review = card.yourReview;
  if (review && !review.byReviewAuthor) return false;
  const pipelinePassed = card.pipeline?.color === 'green' || card.pipeline?.color === 'yellow';
  if (!pipelinePassed || card.chromatic) return false;
  if (!card.agentReview?.clean) return false;
  if (card.hasConflicts || (card.openBlockers?.length ?? 0) > 0) return false;
  if (review) {
    if (review.noteVerdict !== 'approve' && !review.approved && !card.approvalsMet) return false;
    if (card.lane?.secondHuman && !review.othersApproved) return false;
  } else if (!card.approvalsMet) {
    return false;
  }
  const status = card.mergeStatus;
  return !status || MERGE_STATUS_OK.has(status) || (Boolean(review) && status === 'not_approved');
}

/**
 * Feedback on the MR that nobody has addressed yet, as short phrases, empty when there is none:
 * the agent review of the head (issues, recommendations, a verdict short of approve), our own
 * review (a saved review of the head asking for changes, or comments posted with no push or reply
 * since), and people's threads (unresolved, or a reviewer's "request changes"). An agent review of
 * an older commit doesn't count: the push may have addressed it, and a new review is on its way.
 */
export function unaddressedFeedback(card) {
  const out = [];
  const r = card.agentReview ?? {};
  if (r.reviewed && r.onHead) {
    if (r.issueCount > 0) out.push(`agent: ${plural(r.issueCount, 'issue')}`);
    if (r.recommendationCount > 0) out.push(`agent: ${plural(r.recommendationCount, 'recommendation')}`);
    if (!r.issueCount && !r.recommendationCount && r.verdict && !r.verdict.startsWith('APPROVE')) {
      out.push(`agent: ${r.verdict.toLowerCase()}`);
    }
  }
  const review = card.yourReview;
  if (review?.noteVerdict === 'request-changes') out.push('our review asks for changes');
  else if (review?.feedbackAt) out.push('our comments wait on the author');
  if (card.unresolvedHumanThreads > 0) out.push(plural(card.unresolvedHumanThreads, 'unresolved thread'));
  if (card.mergeStatus === 'requested_changes') out.push('a reviewer requested changes');
  else if (card.mergeStatus === 'discussions_not_resolved' && !(card.unresolvedHumanThreads > 0)) {
    out.push('unresolved threads');
  }
  return out;
}

/**
 * The ref chip's colour in Your move, first match wins: `feedback` (yellow) while any feedback
 * is unaddressed, `chromatic` (blue) while a Chromatic check waits for a person, `ready` (green)
 * when only the merge is left (mergeReady), otherwise none. `why` is the chip's tooltip.
 */
export function refChip(card) {
  if (card.state !== 'opened') return null;
  const feedback = unaddressedFeedback(card);
  if (feedback.length > 0) return { status: 'feedback', why: `Unaddressed feedback: ${feedback.join(', ')}` };
  if (card.chromatic) return { status: 'chromatic', why: `Chromatic review needed: ${card.chromatic.checks.map((c) => c.name).join(', ')}` };
  if (mergeReady(card)) return { status: 'ready', why: 'Ready to merge' };
  return null;
}

export function whoseTurn(card, column = card.autoColumn) {
  const you = (turnReason) => ({ turn: 'you', turnReason, agentReason: null, waitReason: null });
  const wait = (turn, waitReason) => ({ turn, turnReason: null, agentReason: null, waitReason });
  const agent = (agentReason) => ({ turn: 'agent', turnReason: null, agentReason, waitReason: agentReason });
  if (column === 'merge-failed') return you('fix the failed merge pipeline');
  if (card.state !== 'opened') return { turn: null, turnReason: null, agentReason: null, waitReason: null };
  if (card.yourReview?.needsYou) {
    const author = card.yourReview.author;
    // A path or risk rule wants another reviewer besides you (see README "Second human").
    const also = card.lane?.secondHuman ? ', and ask a second reviewer' : '';
    // Chromatic holds the merge, so it comes first; a change request makes a new build anyway.
    const chromaticFirst = card.chromatic ? `${chromaticStep(card.chromatic)}, then ` : '';
    if (card.yourReview.noteVerdict === 'approve') {
      return you(`our review says approve: ${chromaticFirst}approve ${author}'s MR${also}`);
    }
    if (card.yourReview.noteVerdict === 'request-changes') {
      return you(
        card.yourReview.byReviewAuthor
          ? `our review asks for changes: ask @${author} for them`
          : `our review asks for changes: post its comments for @${author}`,
      );
    }
    return you(`review, then ${chromaticFirst}approve ${author}'s MR${also}`);
  }
  // Your comments are out on someone else's MR: the author pushes or replies next.
  if (card.yourReview?.feedbackAt && !card.draft) {
    return wait('author', `comments posted: wait for @${card.yourReview.author} to push or reply`);
  }
  // A pipeline held only by Chromatic waits for a person there, whoever's MR it is.
  if (card.chromatic && !card.draft) return you(chromaticStep(card.chromatic));
  // Someone else's MR you reviewed or approved: its next step is the author's, not yours.
  if (card.yourReview && !card.yourReview.byReviewAuthor) {
    const author = `@${card.yourReview.author}`;
    if (card.draft) return wait('author', `wait for ${author} to mark it ready`);
    if (card.yourReview.approved) return wait('author', `approved: ${author} merges it`);
    return wait('author', `wait for ${author}`);
  }
  if (card.hasConflicts || (card.openBlockers?.length ?? 0) > 0) {
    return wait('blocked', blockedReason(card));
  }
  if (!card.approvalsMet && card.reapprovalFrom?.length > 0) {
    return you(`ask ${card.reapprovalFrom.map((u) => `@${u}`).join(', ')} to re-approve`);
  }
  const flakeOnly = card.pipeline?.color === 'red' && card.failedJobs?.allFlaky;
  if (card.approvalsMet && !card.inMergeTrain && card.trainDrop) {
    return agent(flakeOnly ? `retry ${card.failedJobs.names.join(', ')}, re-add to train` : 'train drop: retry, re-add');
  }
  if (card.approvalsMet && !card.inMergeTrain) return you('merge or add to train');
  if (flakeOnly) return agent(`retry ${card.failedJobs.names.join(', ')} (known flake)`);
  if (!card.yourReview && card.unresolvedHumanThreads > 0) {
    const n = card.unresolvedHumanThreads;
    return you(`answer ${n} thread${n === 1 ? '' : 's'}`);
  }
  if (column === 'ready-human') return you('request review');
  if (column === 'merge-train') return wait('ci', 'wait for the merge train');
  if (card.pipeline?.color === 'running') return wait('ci', 'wait for the pipeline');
  if (column === 'waiting-approval') return wait('reviewer', 'wait for approval');
  return wait('agent', agentWaitReason(card));
}
