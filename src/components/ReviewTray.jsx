import { useContext, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { shortRef } from '../links.js';
import { track } from '../track.js';

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

/** MRs a review author built for you to approve; a red dot while any is ready and unapproved. */
const ReviewTray = ({ cards, showNotes }) => {
  const [open, setOpen] = useState(false);
  const { searchSet } = useContext(BoardContext);
  const revealed = !open && cards.some((c) => searchSet?.has(c.key));
  const shown = open || revealed;
  const needs = cards.filter((c) => c.yourReview?.needsYou).length;

  return (
    <aside className={`merged-tray review-tray${shown ? ' merged-tray--open' : ''}`}>
      <button
        className="merged-toggle review-toggle"
        onClick={() => {
          if (!open) track('review:open');
          setOpen((o) => !o);
        }}
      >
        Your review ({cards.length}) <NeedsDot count={needs} /> {shown ? '▾' : '▸'}
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
                  className={`review-item${r.needsYou ? ' review-item--needs' : ''}${
                    searchSet && !searchSet.has(card.key) ? ' review-item--dim' : ''
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
                          className="chip chip--good review-note"
                          href={`/api/review-note?key=${encodeURIComponent(card.key)}`}
                          target="_blank"
                          rel="noreferrer"
                          title={r.notePath}
                          onClick={() => track('review:note')}
                        >
                          our review: saved
                        </a>
                      ) : (
                        <span
                          className="chip chip--muted"
                          title={`No mr-review-${card.iid}-${r.headSha}.md for the current head`}
                        >
                          our review: not yet
                        </span>
                      ))}
                  </span>
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
