import { Fragment } from 'react';

import { LINK_TYPES, isCurrent, layerChain, shortRef } from '../links.js';
import StateDot from './StateDot.jsx';

const nodeState = (card, entry) => {
  if (card.state === 'merged') return 'merged';
  if (isCurrent(card, entry)) return 'current';
  const openBlocker = entry.upstream.some(
    (u) => u.link.type === 'blocked-by' && u.card.state !== 'merged',
  );
  return openBlocker ? 'blocked' : 'waiting';
};

const STATE_LABEL = { merged: 'merged', current: 'now', blocked: 'blocked', waiting: 'waiting' };

const ChainNode = ({ card, entry }) => {
  const state = nodeState(card, entry);
  return (
    <div className={`chain-node chain-node--${state}`}>
      <div className="chain-node-top">
        <StateDot card={card} />
        <span className="chain-node-ref">{shortRef(card)}</span>
        {card.jiraKey && (
          <a className="jira-link" href={card.jiraUrl} target="_blank" rel="noreferrer">
            {card.jiraKey}
          </a>
        )}
        <span className="chain-node-state">{STATE_LABEL[state]}</span>
      </div>
      <a
        className="chain-node-title"
        href={card.webUrl}
        target="_blank"
        rel="noreferrer"
        title={card.title}
      >
        {card.title.replace(/^Draft:\s*/, '')}
      </a>
      {entry.upstream.length > 0 && (
        <div className="chain-node-rel">
          {entry.upstream
            .map((u) => `${LINK_TYPES[u.link.type].upstream} ${shortRef(u.card)}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
};

const ChainsPanel = ({ cards, index, chains }) => {
  const byKey = new Map(cards.map((c) => [c.key, c]));

  if (chains.length === 0) {
    return (
      <section className="chains">
        <p className="chains-empty">
          No linked MRs yet. Use the link button on a card to mark MRs that are blocked by, or
          follow, other MRs.
        </p>
      </section>
    );
  }

  const ordered = chains
    .map((keys) => ({
      keys,
      latest: Math.max(...keys.map((k) => new Date(byKey.get(k).updatedAt).getTime())),
    }))
    .sort((a, b) => b.latest - a.latest);

  return (
    <section className="chains">
      {ordered.map(({ keys }, i) => {
        const layers = layerChain(keys, index);
        const nodes = keys.map((k) => byKey.get(k));
        const merged = nodes.filter((c) => c.state === 'merged').length;
        const jira = [...new Set(nodes.map((c) => c.jiraKey).filter(Boolean))].slice(0, 3);
        return (
          <article className="chain" key={i}>
            <header className="chain-header">
              {jira.map((k) => (
                <span key={k} className="chain-jira">
                  {k}
                </span>
              ))}
              <span>
                {keys.length} MRs · {merged} merged
              </span>
            </header>
            <div className="chain-layers">
              {layers.map((layer, li) => (
                <Fragment key={li}>
                  {li > 0 && <span className="chain-arrow">→</span>}
                  <div className="chain-layer">
                    {layer.map((k) => (
                      <ChainNode key={k} card={byKey.get(k)} entry={index.get(k)} />
                    ))}
                  </div>
                </Fragment>
              ))}
            </div>
          </article>
        );
      })}
    </section>
  );
};

export default ChainsPanel;
