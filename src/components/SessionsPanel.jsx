import { useContext, useEffect, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { shortRef } from '../links.js';
import { track } from '../track.js';

const REFRESH_MS = 60 * 1000;

const relTime = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
};

const SessionsPanel = ({ onOpen }) => {
  const { cardByKey } = useContext(BoardContext);
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/claude/sessions');
      setSessions(await res.json());
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (!sessions) return <section className="sessions sessions-empty">Loading sessions…</section>;
  if (sessions.length === 0) {
    return (
      <section className="sessions">
        <p className="sessions-empty">No Claude Code sessions found under ~/.claude/projects.</p>
      </section>
    );
  }

  return (
    <section className="sessions">
      {sessions.map((s) => {
        const card = s.mrKey ? cardByKey.get(s.mrKey) : null;
        return (
          <button
            key={s.sessionId}
            type="button"
            className="session-row"
            onClick={() => {
              track('session:open');
              onOpen(s.sessionId);
            }}
            title={`Open session\n${s.cwd ?? ''}\n${s.sessionId}`}
          >
            <span className="session-time" title={new Date(s.lastActive).toLocaleString()}>
              {relTime(s.lastActive)}
            </span>
            <span className="session-project">{s.project}</span>
            <span className="session-title">{s.title}</span>
            {['busy', 'idle', 'stopped'].includes(s.status) && (
              <span className={`session-status session-status--${s.status}`}>{s.status}</span>
            )}
            {card && <span className="session-mr">{shortRef(card)}</span>}
          </button>
        );
      })}
    </section>
  );
};

export default SessionsPanel;
