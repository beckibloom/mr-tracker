import { useState } from 'react';

import { shortRef } from '../links.js';
import { track } from '../track.js';

const STATUS = {
  'ready-to-open': { text: 'blocker merged · open it now', tone: 'good' },
  waiting: { text: 'waiting on its blocker', tone: 'muted' },
  'missing-branch': { text: 'branch is gone', tone: 'warn' },
};

/**
 * Branches built on an open MR's diff and parked until that MR merges (an agent registers them
 * through POST /api/staged). Ready ones float to the top; an entry leaves once its MR opens.
 */
const StagedTray = ({ staged, onRemove }) => {
  const [open, setOpen] = useState(false);
  const ready = staged.filter((s) => s.status === 'ready-to-open').length;
  const sorted = [...staged].sort(
    (a, b) => (b.status === 'ready-to-open' ? 1 : 0) - (a.status === 'ready-to-open' ? 1 : 0) || a.createdAt.localeCompare(b.createdAt),
  );
  return (
    <aside className={`merged-tray staged-tray${open ? ' merged-tray--open' : ''}`}>
      <button
        className="merged-toggle"
        onClick={() => {
          if (!open) track('tray:staged');
          setOpen((o) => !o);
        }}
      >
        Staged ({staged.length})
        {ready > 0 && <span className="staged-ready"> · {ready} ready to open</span>} {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="review-body">
          {staged.length === 0 && (
            <p className="merged-empty">Nothing staged. Agents park waves here while their bump is in review.</p>
          )}
          <ul className="review-list">
            {sorted.map((s) => {
              const st = STATUS[s.status] ?? STATUS.waiting;
              const [project, iid] = s.blockedBy.split('!');
              return (
                <li key={s.id} className={`review-item${s.status === 'ready-to-open' ? ' review-item--needs' : ''}`}>
                  <code className="staged-branch" title={`${s.repo}`}>
                    {s.branch}
                  </code>
                  <span className="review-title" title={s.title ?? undefined}>
                    {s.title ?? ''}
                  </span>
                  <span className="review-meta">
                    {s.ticket && <span className="chip chip--muted">{s.ticket}</span>}
                    <a
                      className="chip chip--blocked"
                      href={s.blockerUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={s.blockerTitle ?? s.blockedBy}
                    >
                      after {shortRef({ project, iid })}
                      {s.blockerState ? ` (${s.blockerState})` : ''}
                    </a>
                    <span className={`chip chip--${st.tone}`}>{st.text}</span>
                    {s.by && <span className="chip chip--muted">by {s.by}</span>}
                    <button
                      type="button"
                      className="link-chip-remove"
                      title="Remove from the tray"
                      aria-label="Remove from the tray"
                      onClick={() => onRemove(s.id)}
                    >
                      ×
                    </button>
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

export default StagedTray;
