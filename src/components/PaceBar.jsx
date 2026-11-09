import { useEffect, useState } from 'react';

import { track } from '../track.js';

const REFRESH_MS = 5 * 60 * 1000;

const shortDate = (iso) =>
  iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// Today against the daily target, pro-rated over working hours (server/pace.mjs).
const STATUS_TEXT = {
  good: 'daily target met',
  warn: 'on track today',
  bad: 'behind today',
  rest: 'no target today',
  unknown: 'no count yet',
};

const WEEK_TEXT = { good: 'met', warn: 'on track', bad: 'behind', unknown: '' };

const weekday = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });

/** Files removed each working day, oldest first; today is hollow. Dashed line: daily target. */
const Bars = ({ days, target }) => {
  const shown = days.filter((d) => d.removed != null);
  // Scale to three times the target so one big merge day doesn't flatten the rest; taller days
  // are clipped and marked.
  const max = Math.max(target * 3, 1);
  return (
    <span className="pace-bars" aria-hidden="true">
      {shown.map((d) => (
        <span
          key={d.date}
          className={`pace-bar${d.removed >= target ? ' pace-bar--good' : ''}${d.today ? ' pace-bar--partial' : ''}${
            d.removed > max ? ' pace-bar--over' : ''
          }`}
          style={{ height: `${Math.min(Math.max((d.removed / max) * 100, 4), 100)}%` }}
          title={`${d.today ? 'Today so far' : weekday(d.date)}: ${d.removed} removed, ${d.added} added`}
        />
      ))}
      <span className="pace-target" style={{ bottom: `${(target / max) * 100}%` }} />
    </span>
  );
};

/**
 * The velocity banner: today and this week against their targets (the colour follows today),
 * files left on main, the four-week rate, and the date that rate reaches zero. Shown when MRT_PACE_REPO is set (README "Pace header").
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

  const { now, perWeek, target, status, today, dailyTarget, expectedToday } = pace;
  const behind = today.removed != null && expectedToday != null && today.removed < expectedToday;
  return (
    <section className={`pace pace--${status}`} aria-label="Velocity">
      <div
        className="pace-tile pace-tile--lead"
        title={`Files removed since midnight, against the daily target (${dailyTarget}) pro-rated over working hours`}
      >
        <span className="pace-label">Today</span>
        <span className="pace-value">
          {today.removed ?? '—'}
          <span className="pace-of"> / {dailyTarget}</span>
        </span>
        <span className={`pace-status pace-status--${status}`}>{STATUS_TEXT[status]}</span>
        {expectedToday != null && today.removed != null && today.removed < dailyTarget && (
          <span className="pace-sub">
            {behind ? `${expectedToday - today.removed} behind: ` : ''}expect {expectedToday} by now
          </span>
        )}
      </div>
      <div
        className="pace-tile"
        title={`Files removed since Monday. By now the week should have removed ${pace.expectedByNow}.`}
      >
        <span className="pace-label">This week</span>
        <span className="pace-value">
          {now.removed ?? '—'}
          <span className="pace-of"> / {target}</span>
        </span>
        <span className={`pace-sub pace-sub--${pace.weekStatus}`}>{WEEK_TEXT[pace.weekStatus] ?? ''}</span>
      </div>
      <div className="pace-tile">
        <span className="pace-label">Left on main</span>
        <span className="pace-value">{now.total}</span>
        <span className="pace-sub">
          {pace.label}
          {pace.splitLabel && now.split > 0 ? ` · ${now.split} ${pace.splitLabel}` : ''}
        </span>
      </div>
      <div className="pace-tile" title={`Mean files removed per week over the last ${pace.windowWeeks} whole weeks`}>
        <span className="pace-label">{pace.windowWeeks}-week average</span>
        <span className={`pace-value${perWeek != null && perWeek < target ? ' pace-value--short' : ''}`}>
          {perWeek ?? '—'}
          <span className="pace-of">/wk</span>
        </span>
        <span className="pace-sub">needs {target} a week</span>
      </div>
      {pace.goalDate && pace.neededPerDay != null && (
        <div
          className="pace-tile"
          title={`Files left ÷ working days to ${pace.goalDate} (weekends and holidays skipped; what's left of today counts)`}
        >
          <span className="pace-label">To finish {shortDate(pace.goalDate)}</span>
          <span className={`pace-value${pace.perDay != null && pace.perDay < pace.neededPerDay ? ' pace-value--short' : ''}`}>
            {pace.neededPerDay}
            <span className="pace-of">/day</span>
          </span>
          <span className="pace-sub">{Math.floor(pace.workdaysToGoal)} working days left</span>
        </div>
      )}
      <div
        className="pace-tile"
        title={`Files left ÷ the ${pace.perDayWindow}-working-day average (today included), counting working days only`}
      >
        <span className="pace-label">At this rate</span>
        <span className="pace-value pace-value--date">{shortDate(pace.finishAtDailyRate)}</span>
        <span className="pace-sub">
          at {pace.perDay ?? '—'}/day ({pace.perDayWindow}-day avg)
        </span>
      </div>
      <div className="pace-tile pace-tile--bars">
        <span className="pace-label">Removed each day</span>
        <Bars days={pace.daily ?? []} target={dailyTarget} />
      </div>
      <div className="pace-actions">
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
      </div>
    </section>
  );
};

export default PaceBar;
