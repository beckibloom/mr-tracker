import { useState } from 'react';

import { shortRef } from '../links.js';

const READY = 'request review';

const Row = ({ card, onReveal, extra }) => (
  <li className={`yourmove-row${card.important ? ' yourmove-row--important' : ''}`}>
    {card.column === 'review' ? (
      <span className="copy-ref yourmove-ref" title="In the Your review tray">
        {shortRef(card)}
      </span>
    ) : (
      <button
        type="button"
        className="copy-ref yourmove-ref"
        onClick={() => onReveal(card.key)}
        title="Show on the board"
      >
        {shortRef(card)}
      </button>
    )}
    <a className="yourmove-title" href={card.webUrl} target="_blank" rel="noreferrer" title={card.title}>
      {card.important && '‼ '}
      {card.title.replace(/^Draft:\s*/, '')}
    </a>
    <span className="yourmove-reason">{card.turnReason}</span>
    {extra}
  </li>
);

/** Every open MR waiting on you: ‼ first, then the one waiting longest. */
const YourMoveStrip = ({ cards, onReveal, requestReviews }) => {
  const [readyOpen, setReadyOpen] = useState(false);
  const mine = cards
    .filter((c) => c.turn === 'you')
    .sort(
      (a, b) =>
        (b.important ? 1 : 0) - (a.important ? 1 : 0) || new Date(a.updatedAt) - new Date(b.updatedAt),
    );
  const ready = mine.filter((c) => c.turnReason === READY);
  const collapseReady = ready.length > 1;

  const rows = [];
  for (const card of mine) {
    if (collapseReady && card.turnReason === READY) {
      if (card !== ready[0]) continue;
      rows.push(
        <li key="ready" className="yourmove-row yourmove-row--ready">
          <button
            type="button"
            className="yourmove-ready-toggle"
            aria-expanded={readyOpen}
            onClick={() => setReadyOpen((o) => !o)}
          >
            {ready.length} ready to share {readyOpen ? '▾' : '▸'}
          </button>
          {requestReviews && <span className="yourmove-reason">→</span>}
          {requestReviews}
        </li>,
      );
      if (readyOpen) {
        for (const r of ready) rows.push(<Row key={r.key} card={r} onReveal={onReveal} />);
      }
      continue;
    }
    rows.push(
      <Row
        key={card.key}
        card={card}
        onReveal={onReveal}
        extra={card.turnReason === READY ? requestReviews : null}
      />,
    );
  }

  return (
    <section className="yourmove" aria-label="Your move">
      <span className="yourmove-label">
        Your move{mine.length > 0 && <span className="view-count">{mine.length}</span>}
      </span>
      {mine.length === 0 ? (
        <p className="yourmove-empty">Nothing waiting on you</p>
      ) : (
        <ul className="yourmove-list">{rows}</ul>
      )}
    </section>
  );
};

export default YourMoveStrip;
