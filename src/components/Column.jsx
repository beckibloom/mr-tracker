import { useContext, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { groupId, stackId } from '../fold.js';
import { track } from '../track.js';

import Card from './Card.jsx';

// Folded cards: a toggle row, and the cards once expanded (or while search or a reveal needs them).
const Fold = ({ id, label, cards, renderCard }) => {
  const { openFolds, onToggleFold, searchSet } = useContext(BoardContext);
  const forced = !openFolds.has(id) && cards.some((c) => searchSet?.has(c.key));
  const shown = openFolds.has(id) || forced;
  return (
    <div className={`fold${shown ? ' fold--open' : ''}`}>
      <button
        type="button"
        className="fold-toggle"
        aria-expanded={shown}
        onClick={() => {
          if (!openFolds.has(id)) track('card:fold');
          onToggleFold(id);
        }}
      >
        {label} {shown ? '▾' : '▸'}
      </button>
      {shown && <div className="fold-cards">{cards.map(renderCard)}</div>}
    </div>
  );
};

const Column = ({ column, cards, onDropCard, onSaveNote, headerAction }) => {
  const [dragOver, setDragOver] = useState(false);
  const { folds } = useContext(BoardContext);

  const renderCard = (card) => (
    <Card
      key={card.key}
      card={card}
      onClearOverride={() => onDropCard(card.key, null)}
      onSaveNote={onSaveNote}
    />
  );

  // Top-level cards in order; a card's stack follows it, and an off-board blocker's group sits
  // where its first card would have been.
  const items = [];
  const groups = new Map();
  let count = 0;
  for (const card of cards) {
    if (folds?.rootOf.has(card.key)) continue;
    const ext = folds?.externalOf.get(card.key);
    if (ext) {
      count += 1;
      if (!groups.has(ext.key)) {
        const group = { blocker: ext, cards: [] };
        groups.set(ext.key, group);
        items.push({ group });
      }
      groups.get(ext.key).cards.push(card);
      continue;
    }
    const stack = folds?.stacks.get(card.key) ?? [];
    count += 1 + stack.length;
    items.push({ card, stack });
  }

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
        <span className="column-count">{count}</span>
      </header>
      {headerAction && <div className="column-action">{headerAction}</div>}
      <div className="column-cards">
        {items.map((item) =>
          item.group ? (
            <div key={`group:${item.group.blocker.key}`} className="fold-group">
              <div className="fold-group-head">
                ⛓ blocked by{' '}
                <a
                  href={item.group.blocker.webUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  title={item.group.blocker.title}
                >
                  {item.group.blocker.ref}
                </a>
              </div>
              <Fold
                id={groupId(column.id, item.group.blocker.key)}
                label={`${item.group.cards.length} MR${item.group.cards.length === 1 ? '' : 's'}`}
                cards={item.group.cards}
                renderCard={renderCard}
              />
            </div>
          ) : (
            <div key={item.card.key} className="fold-root">
              {renderCard(item.card)}
              {item.stack.length > 0 && (
                <Fold
                  id={stackId(item.card.key)}
                  label={`+${item.stack.length} blocked by this`}
                  cards={item.stack}
                  renderCard={renderCard}
                />
              )}
            </div>
          ),
        )}
      </div>
    </section>
  );
};

export default Column;
