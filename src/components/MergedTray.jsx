import { useState } from 'react';

import Card from './Card.jsx';

const MergedTray = ({ cards }) => {
  const [open, setOpen] = useState(false);

  return (
    <aside className={`merged-tray${open ? ' merged-tray--open' : ''}`}>
      <button className="merged-toggle" onClick={() => setOpen((o) => !o)}>
        Merged · last 7 days ({cards.length}) {open ? '▾' : '▸'}
      </button>
      {open && (
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
