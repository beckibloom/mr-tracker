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
    if (card.yourReview.noteVerdict === 'approve') return you(`our review says approve: approve ${author}'s MR${also}`);
    if (card.yourReview.noteVerdict === 'request-changes') {
      return you(`our review asks for changes: send them to @${author}`);
    }
    return you(`review, then approve ${author}'s MR${also}`);
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
