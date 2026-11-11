import { useContext, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { shortRef } from '../links.js';
import { track } from '../track.js';

import ChromaticChips from './ChromaticChips.jsx';
import SkillButton, { skillIn } from './SkillButton.jsx';
import StateDot from './StateDot.jsx';

const NeedsDot = ({ count }) =>
  count > 0 ? (
    <span
      className="pipeline-dot pipeline-dot--red review-needs-dot"
      title={`${count} need${count === 1 ? 's' : ''} your review`}
      aria-label={`${count} need${count === 1 ? 's' : ''} your review`}
    />
  ) : null;

const aiReviewText = ({ reviewed, verdict, issueCount }) => {
  if (!reviewed) return 'AI review: none yet';
  const issues = issueCount === null ? '? issues' : `${issueCount} issue${issueCount === 1 ? '' : 's'}`;
  return `AI review: ${verdict ?? 'no verdict'} · ${issues}`;
};

const approvalChip = (r) => {
  if (r.approved) return <span className="chip chip--good">approved by you</span>;
  if (r.approvalReset) {
    return (
      <span className="chip chip--reapproval" title="You approved an earlier head; approve again">
        re-approve
      </span>
    );
  }
  return <span className="chip chip--muted">not approved</span>;
};

const waitText = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

// Why approving alone is not enough (server/gitlab.mjs secondHumanInfo): each rule and its paths.
const secondHumanTitle = ({ reasons }) =>
  `Needs a second human reviewer as well as you. ${reasons
    .map((r) => `${r.rule}: ${r.paths.join(', ')}${r.count > r.paths.length ? ` and ${r.count - r.paths.length} more` : ''}`)
    .join('; ')}`;

const VERDICT_TEXT = { approve: 'our review: approve', 'request-changes': 'our review: changes' };

// The row's next step (server/classify.mjs whoseTurn). An agent already on it gets no skill button.
const NextStep = ({ card, onLaunchSkill }) => {
  if (card.handoff) {
    return (
      <div className="review-next">
        <span className="review-next-label">Agent on it.</span>
        <span className="review-next-text">Then you: {card.handoff.then}</span>
      </div>
    );
  }
  const step = card.turn === 'you' ? card.turnReason : card.waitReason;
  if (!step) return null;
  return (
    <div className={`review-next${card.turn === 'you' ? ' review-next--you' : ''}`}>
      <span className="review-next-label">{card.turn === 'you' ? 'Next:' : 'Waiting:'}</span>
      <span className="review-next-text">{step}</span>
      <SkillButton card={card} skill={skillIn(step)} onLaunchSkill={onLaunchSkill} />
    </div>
  );
};

/** MRs you review (yours to approve); a red dot while any is ready and unapproved. */
const ReviewTray = ({ cards, showNotes, onLaunchSkill, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const { searchSet } = useContext(BoardContext);
  const revealed = !open && cards.some((c) => searchSet?.has(c.key));
  const shown = open || revealed;
  const needs = cards.filter((c) => c.yourReview?.needsYou).length;
  const oldest = cards
    .filter((c) => c.yourReview?.needsYou && c.yourReview.since)
    .map((c) => c.yourReview.since)
    .sort()[0];

  return (
    <aside className={`merged-tray review-tray${shown ? ' merged-tray--open' : ''}`}>
      <button
        className="merged-toggle review-toggle"
        onClick={() => {
          if (!open) track('review:open');
          setOpen((o) => !o);
        }}
      >
        Your review ({cards.length}) <NeedsDot count={needs} />
        {oldest && <span className="review-oldest"> oldest waits {waitText(oldest)}</span>} {shown ? '▾' : '▸'}
      </button>
      {shown && (
        <div className="review-body">
          {cards.length === 0 && <p className="merged-empty">Nothing waiting on your review.</p>}
          <ul className="review-list">
            {cards.map((card) => {
              const r = card.yourReview;
              const ai = card.agentReview ?? {};
              const aiClean = ai.reviewed && ai.clean;
              return (
                <li
                  key={card.key}
                  data-card-key={card.key}
                  className={`review-item${r.needsYou ? ' review-item--needs' : ''}${
                    searchSet ? (searchSet.has(card.key) ? ' review-item--search-hit' : ' review-item--dim') : ''
                  }`}
                >
                  <StateDot card={card} />
                  <a
                    className="copy-ref review-ref"
                    href={card.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`${card.project}!${card.iid}`}
                    onClick={() => track('review:mr')}
                  >
                    {shortRef(card)}
                  </a>
                  <a
                    className="review-title"
                    href={card.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={card.title}
                    onClick={() => track('review:mr')}
                  >
                    {card.title.replace(/^Draft:\s*/, '')}
                  </a>
                  <span className="review-meta">
                    <span className={`chip ${card.draft ? 'chip--muted' : 'chip--warn'}`}>
                      {card.draft ? 'Draft' : 'ready'}
                    </span>
                    {r.needsYou && r.since && (
                      <span className="chip chip--muted" title={`Waiting on you since ${new Date(r.since).toLocaleString()}`}>
                        waiting {waitText(r.since)}
                      </span>
                    )}
                    {card.lane?.files != null && (
                      <span className="chip chip--muted">{card.lane.files} files</span>
                    )}
                    {card.lane?.secondHuman && (
                      <span className="chip chip--warn" title={secondHumanTitle(card.lane.secondHuman)}>
                        second human
                      </span>
                    )}
                    {card.pipeline.url ? (
                      <a
                        className="review-pipeline"
                        href={card.pipeline.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {card.pipeline.status}
                      </a>
                    ) : (
                      <span className="review-pipeline">{card.pipeline.status}</span>
                    )}
                    <ChromaticChips card={card} />
                    <span
                      className={`chip ${aiClean ? 'chip--good' : ai.reviewed ? 'chip--warn' : 'chip--muted'}`}
                      title={`Latest review comment by ${r.author} or a review bot`}
                    >
                      {aiReviewText(ai)}
                    </span>
                    {approvalChip(r)}
                    {showNotes &&
                      (r.notePath ? (
                        <a
                          className={`chip ${r.noteVerdict === 'request-changes' ? 'chip--warn' : 'chip--good'} review-note`}
                          href={`/api/review-note?key=${encodeURIComponent(card.key)}`}
                          target="_blank"
                          rel="noreferrer"
                          title={r.notePath}
                          onClick={() => track('review:note')}
                        >
                          {VERDICT_TEXT[r.noteVerdict] ?? 'our review: saved'}
                        </a>
                      ) : (
                        <span
                          className="chip chip--muted"
                          title={`No saved review for the latest push (no mr-review-${card.iid}-${r.headSha}.md)`}
                        >
                          our review: not run
                        </span>
                      ))}
                  </span>
                  <NextStep card={card} onLaunchSkill={onLaunchSkill} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
};

export default ReviewTray;
