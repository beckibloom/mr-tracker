import { useState } from 'react';

import Card from './Card.jsx';

const Column = ({ column, cards, onDropCard, onSaveNote }) => {
  const [dragOver, setDragOver] = useState(false);

  return (
    <section
      className={`column${dragOver ? ' column--drag-over' : ''}`}
      data-column={column.id}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const key = e.dataTransfer.getData('text/mr-key');
        if (key) onDropCard(key, column.id);
      }}
    >
      <header className="column-header">
        <span>{column.label}</span>
        <span className="column-count">{cards.length}</span>
      </header>
      <div className="column-cards">
        {cards.map((card) => (
          <Card
            key={card.key}
            card={card}
            onClearOverride={() => onDropCard(card.key, null)}
            onSaveNote={onSaveNote}
          />
        ))}
      </div>
    </section>
  );
};

export default Column;
