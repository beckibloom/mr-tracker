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
 * `column` is where the card shows (a manual override wins over the automatic column).
 */
export function whoseTurn(card, column = card.autoColumn) {
  const you = (turnReason) => ({ turn: 'you', turnReason });
  if (column === 'merge-failed') return you('fix the failed merge pipeline');
  if (card.state !== 'opened') return { turn: null, turnReason: null };
  if (card.yourReview?.needsYou) return you(`approve ${card.yourReview.author}'s MR`);
  if (card.hasConflicts || (card.openBlockers?.length ?? 0) > 0) {
    return { turn: 'blocked', turnReason: null };
  }
  if (!card.approvalsMet && card.reapprovalFrom?.length > 0) {
    return you(`ask ${card.reapprovalFrom.map((u) => `@${u}`).join(', ')} to re-approve`);
  }
  if (card.approvalsMet && !card.inMergeTrain) return you('merge or add to train');
  if (!card.yourReview && card.unresolvedHumanThreads > 0) {
    const n = card.unresolvedHumanThreads;
    return you(`answer ${n} thread${n === 1 ? '' : 's'}`);
  }
  if (column === 'ready-human') return you('request review');
  if (card.pipeline?.color === 'running' || column === 'merge-train') {
    return { turn: 'ci', turnReason: null };
  }
  if (column === 'waiting-approval') return { turn: 'reviewer', turnReason: null };
  return { turn: 'agent', turnReason: null };
}
