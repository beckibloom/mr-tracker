export const COLUMNS = [
  { id: 'draft', label: 'Draft' },
  { id: 'agent-iteration', label: 'Agent iteration' },
  { id: 'ready-human', label: 'Ready to share' },
  { id: 'waiting-approval', label: 'Waiting for approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'merge-train', label: 'Merge train' },
  { id: 'merge-failed', label: 'Merge failed' },
];

// 'merged' is not a visible column; it feeds the collapsed tray.
export function classify(card) {
  if (card.state === 'merged') {
    if (card.pipeline.color === 'red') return 'merge-failed';
    if (card.pipeline.color === 'running') return 'merge-train'; // merge pipeline still running
    return 'merged';
  }
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
