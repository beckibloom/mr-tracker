import { useContext, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { track } from '../track.js';

import Card from './Card.jsx';

const MergedTray = ({ cards }) => {
  const [open, setOpen] = useState(false);
  // A search hit among merged cards opens the tray so the hit can be shown.
  const { searchSet } = useContext(BoardContext);
  const revealed = !open && cards.some((c) => searchSet?.has(c.key));
  const shown = open || revealed;

  return (
    <aside className={`merged-tray${shown ? ' merged-tray--open' : ''}`}>
      <button className="merged-toggle" onClick={() => {
          if (!open) track('tray:merged');
          setOpen((o) => !o);
        }}>
        Merged · last 7 days ({cards.length}) {shown ? '▾' : '▸'}
      </button>
      {shown && (
        <div className="merged-cards">
          {cards.length === 0 && <p className="merged-empty">Nothing merged this week.</p>}
          {cards.map((card) => (
            <Card key={card.key} card={card} onClearOverride={() => {}} />
          ))}
        </div>
      )}
    </aside>
  );
};

export default MergedTray;
