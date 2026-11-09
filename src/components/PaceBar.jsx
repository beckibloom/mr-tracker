import { useEffect, useState } from 'react';

import { track } from '../track.js';

const REFRESH_MS = 10 * 60 * 1000;

const shortDate = (iso) =>
  iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// This week against the target, pro-rated over Monday to Friday (server/pace.mjs).
const STATUS_TEXT = {
  good: 'target met this week',
  warn: 'on track this week',
  bad: 'behind this week',
  unknown: 'no count yet',
};

/** Weekly removals as tiny bars, oldest first; the current partial week is hollow. */
const Bars = ({ points, now, target }) => {
  const weeks = points.filter((p) => p.removed != null);
  const max = Math.max(target, ...weeks.map((p) => p.removed), now.removed ?? 0, 1);
  return (
    <span className="pace-bars" aria-hidden="true">
      {weeks.map((p) => (
        <span
          key={p.date}
          className={`pace-bar${p.removed >= target ? ' pace-bar--good' : ''}`}
          style={{ height: `${Math.max((p.removed / max) * 100, 4)}%` }}
          title={`Week to ${p.date}: ${p.removed} removed, ${p.added} added, ${p.total} left`}
        />
      ))}
      {now.removed != null && (
        <span
          className="pace-bar pace-bar--partial"
          style={{ height: `${Math.max((now.removed / max) * 100, 4)}%` }}
          title={`This week so far: ${now.removed} removed, ${now.added} added`}
        />
      )}
      <span className="pace-target" style={{ bottom: `${(target / max) * 100}%` }} />
    </span>
  );
};

/**
 * The pace header: files left on main, the four-week removal rate against the target, and the
 * date that rate reaches zero. Shown when MRT_PACE_REPO is set (README "Pace header").
 */
const PaceBar = ({ onOpenProgram }) => {
  const [pace, setPace] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (fresh = false) => {
    const res = await fetch(`/api/pace${fresh ? '?fresh=1' : ''}`);
    setPace(await res.json());
  };

  useEffect(() => {
    load().catch(() => setPace({ error: 'Could not load the pace.' }));
    const id = setInterval(() => load().catch(() => {}), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (!pace) return <section className="pace pace--loading">Counting files on main…</section>;
  if (pace.error) return <section className="pace pace--bad">Pace: {pace.error}</section>;
  if (!pace.enabled) return null;

  const { now, perWeek, target, status } = pace;
  return (
    <section className={`pace pace--${status}`} aria-label="Migration pace">
      <span className="pace-main">
        <strong>{now.total}</strong> {pace.label} left
        {pace.splitLabel && now.split > 0 && (
          <span className="pace-muted">
            {' '}
            ({now.split} {pace.splitLabel})
          </span>
        )}
      </span>
      <span
        className="pace-rate"
        title={`Files removed since Monday. By now the week should have removed ${pace.expectedByNow} (the target pro-rated over Monday to Friday).`}
      >
        this week <strong>{now.removed ?? '—'}</strong> / {target}
        {now.removed != null && now.removed < target && (
          <span className="pace-muted"> (expect {pace.expectedByNow} by now)</span>
        )}
      </span>
      <span className={`pace-status pace-status--${status}`}>{STATUS_TEXT[status]}</span>
      <Bars points={pace.points} now={now} target={target} />
      <span className="pace-muted" title={`Mean files removed per week over the last ${pace.windowWeeks} whole weeks`}>
        {perWeek ?? '—'}/wk {pace.windowWeeks}-wk avg
      </span>
      {pace.goalDate && pace.neededForGoal != null && (
        <span className="pace-muted" title={`Files left ÷ weeks to ${pace.goalDate}, without holidays`}>
          {pace.neededForGoal}/wk meets {shortDate(pace.goalDate)}
        </span>
      )}
      <span className="pace-muted" title="Files left ÷ the 4-week rate, without holidays">
        at this rate: {shortDate(pace.finishAtRate)}
      </span>
      <span className="pace-actions">
        {onOpenProgram && (
          <button type="button" className="btn btn--small" onClick={onOpenProgram}>
            Families
          </button>
        )}
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          title={`Fetch ${pace.ref} and count again (last count ${new Date(pace.computedAt).toLocaleTimeString()} at ${now.sha})`}
          onClick={async () => {
            track('pace:recount');
            setBusy(true);
            try {
              await load(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Counting…' : 'Recount'}
        </button>
      </span>
    </section>
  );
};

export default PaceBar;
