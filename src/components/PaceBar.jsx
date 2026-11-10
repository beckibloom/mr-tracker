import { useEffect, useState } from 'react';

import { track } from '../track.js';

const REFRESH_MS = 5 * 60 * 1000;

const shortDate = (iso) =>
  iso
    ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

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
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  });

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
          style={{
            height: `${Math.min(Math.max((d.removed / max) * 100, 4), 100)}%`,
          }}
          title={`${d.today ? 'Today so far' : weekday(d.date)}: ${d.removed} removed, ${d.added} added`}
        />
      ))}
      <span className="pace-target" style={{ bottom: `${(target / max) * 100}%` }} />
    </span>
  );
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const branch = (ref) => String(ref ?? '').replace(/^origin\//, '');
const hour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

/**
 * A banner tile with a hover card that explains the number in plain words, for readers who
 * don't know how the count works. Keyboard users get the same card on focus.
 */
const Tile = ({ id, className = '', end = false, tip, children }) => (
  <div className={`pace-tile ${className}`} tabIndex={0} aria-describedby={`pace-tip-${id}`}>
    {children}
    <div id={`pace-tip-${id}`} role="tooltip" className={`pace-tip${end ? ' pace-tip--end' : ''}`}>
      {tip}
    </div>
  </div>
);

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
  const scope = <code>{pace.scope}</code>;
  const main = <code>{branch(pace.ref)}</code>;
  const fromGoal = pace.targetSource === 'goal' && pace.goalDate;
  const [startHour, endHour] = pace.workHours ?? [9, 17];
  const vsGoal =
    pace.goalDate && pace.finishAtDailyRate
      ? pace.finishAtDailyRate <= pace.goalDate
        ? `That is on or before the ${shortDate(pace.goalDate)} goal.`
        : `That is after the ${shortDate(pace.goalDate)} goal, so the pace needs to rise.`
      : null;
  return (
    <section className={`pace pace--${status}`} aria-label="Velocity">
      <Tile
        id="today"
        className="pace-tile--lead"
        tip={
          <>
            <p>
              <strong>Files that stopped importing {scope} since midnight.</strong> A file leaves the count when an MR
              that migrates or deletes it merges to {main}.
            </p>
            <p>
              {fromGoal ? (
                <>
                  The target, {dailyTarget}, is the {pace.leftAtDayStart} files left at midnight spread evenly over the{' '}
                  {plural(pace.workdaysFromToday, 'working day')} to {shortDate(pace.goalDate)}. It rises after a short
                  day and falls after a big one.
                </>
              ) : (
                <>The target is {dailyTarget} a working day.</>
              )}
            </p>
            <p>
              The banner&apos;s colour follows this tile: green once the target is met, orange while on pace for the
              hours worked so far ({hour(startHour)} to {hour(endHour)}), red when behind, grey on days off. Merges land
              in batches, so mornings often read red until they arrive.
            </p>
          </>
        }
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
      </Tile>
      <Tile
        id="week"
        tip={
          <>
            <p>
              <strong>Files removed since Monday midnight.</strong>
            </p>
            <p>
              {fromGoal ? (
                <>
                  The target, {target}, is today&apos;s daily target times this week&apos;s{' '}
                  {plural(pace.weekWorkdays, 'working day')}.
                </>
              ) : (
                <>The target is {target} a week.</>
              )}{' '}
              Spread evenly over the week, it should be at {pace.expectedByNow} by now.
            </p>
          </>
        }
      >
        <span className="pace-label">This week</span>
        <span className="pace-value">
          {now.removed ?? '—'}
          <span className="pace-of"> / {target}</span>
        </span>
        <span className={`pace-sub pace-sub--${pace.weekStatus}`}>{WEEK_TEXT[pace.weekStatus] ?? ''}</span>
      </Tile>
      <Tile
        id="left"
        tip={
          <>
            <p>
              <strong>
                Files on {main} that still import a {scope} package.
              </strong>{' '}
              A file counts once however many of those packages it imports. Zero means done.
            </p>
            {pace.about && <p>{pace.about}</p>}
            {pace.split && now.split > 0 && (
              <p>
                {now.split} of the {now.total} are in <code>{pace.split}</code>, shown on their own as &ldquo;
                {pace.splitLabel}&rdquo;.
              </p>
            )}
            {!pace.about && pace.exclude?.length > 0 && (
              <p>
                Not counted:{' '}
                {pace.exclude.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <code>{p}</code>
                  </span>
                ))}
                .
              </p>
            )}
          </>
        }
      >
        <span className="pace-label">Left on main</span>
        <span className="pace-value">{now.total}</span>
        <span className="pace-sub">
          {pace.label}
          {pace.splitLabel && now.split > 0 ? ` · ${now.split} ${pace.splitLabel}` : ''}
        </span>
      </Tile>
      <Tile
        id="average"
        tip={
          <>
            <p>
              <strong>Average files removed per week over the last {plural(pace.windowWeeks, 'whole week')}</strong>,
              Monday to Monday. It shows the steady pace, where a single day can swing a lot.
            </p>
            <p>
              The number turns orange when it falls short of the {target} a week the goal needs. New files that start
              importing {scope} don&apos;t cancel out removed ones.
            </p>
          </>
        }
      >
        <span className="pace-label">{pace.windowWeeks}-week average</span>
        <span className={`pace-value${perWeek != null && perWeek < target ? ' pace-value--short' : ''}`}>
          {perWeek ?? '—'}
          <span className="pace-of">/wk</span>
        </span>
        <span className="pace-sub">needs {target} a week</span>
      </Tile>
      {pace.goalDate && pace.neededPerDay != null && (
        <Tile
          id="goal"
          tip={
            <>
              <p>
                <strong>Files a working day needed to reach zero by {shortDate(pace.goalDate)}</strong>: {now.total}{' '}
                files left over {pace.workdaysToGoal} working days.
              </p>
              <p>
                Weekends and holidays are skipped, and what&apos;s left of today counts as part of a day. The number
                turns orange when the recent daily average ({pace.perDay ?? '—'}) is below it.
              </p>
            </>
          }
        >
          <span className="pace-label">To finish {shortDate(pace.goalDate)}</span>
          <span
            className={`pace-value${pace.perDay != null && pace.perDay < pace.neededPerDay ? ' pace-value--short' : ''}`}
          >
            {pace.neededPerDay}
            <span className="pace-of">/day</span>
          </span>
          <span className="pace-sub">{Math.floor(pace.workdaysToGoal)} working days left</span>
        </Tile>
      )}
      <Tile
        id="rate"
        end
        tip={
          <>
            <p>
              <strong>The day the count reaches zero if the recent pace holds.</strong>
            </p>
            <p>
              The pace is {pace.perDay ?? '—'} files a working day, the average of the last{' '}
              {plural(pace.perDayWindow, 'working day')} with today included. {vsGoal}
            </p>
          </>
        }
      >
        <span className="pace-label">At this rate</span>
        <span className="pace-value pace-value--date">{shortDate(pace.finishAtDailyRate)}</span>
        <span className="pace-sub">
          at {pace.perDay ?? '—'}/day ({pace.perDayWindow}-day avg)
        </span>
      </Tile>
      <Tile
        id="daily"
        className="pace-tile--bars"
        end
        tip={
          <>
            <p>
              <strong>Files removed on each of the last {plural(pace.perDayWindow, 'working day')}</strong>, oldest on
              the left. A day runs midnight to midnight; weekend merges count for Friday.
            </p>
            <p>
              The dashed line is the daily target ({dailyTarget}), and green bars reached it. The hollow bar is today so
              far. Bars over three times the target are cut off at the top.
            </p>
            <p>Hover a bar for that day&apos;s files removed and added.</p>
          </>
        }
      >
        <span className="pace-label">Removed each day</span>
        <Bars days={pace.daily ?? []} target={dailyTarget} />
      </Tile>
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
