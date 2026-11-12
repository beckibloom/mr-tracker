import { useContext, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { shortRef } from '../links.js';

import SkillButton, { skillIn } from './SkillButton.jsx';

const READY = 'request review';

// Short labels for whose move a card waits on (server/classify.mjs whoseTurn).
const TURN_TEXT = { agent: 'agent', reviewer: 'reviewer', ci: 'CI', blocked: 'blocked', author: 'author' };

const ageText = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

// A dated reminder from the program file: "in 11 days", "today", "3 days late".
const dueText = (n) =>
  n == null ? '' : n > 1 ? `in ${n} days` : n === 1 ? 'tomorrow' : n === 0 ? 'today' : `${-n} day${n === -1 ? '' : 's'} late`;

// While the top-bar search has a query, matching MR rows glow and every other row dims.
const searchClass = (searchSet, key) =>
  searchSet ? (key && searchSet.has(key) ? ' yourmove-row--search-hit' : ' yourmove-row--dim') : '';

/**
 * The MRs the strip lists, in display order: yours (‼ first, then the one waiting longest),
 * ‼ MRs waiting on someone else, then the ones parked with an agent.
 */
export const yourMoveGroups = (cards) => ({
  mine: cards
    .filter((c) => c.turn === 'you')
    .sort(
      (a, b) =>
        (b.important ? 1 : 0) - (a.important ? 1 : 0) || new Date(a.updatedAt) - new Date(b.updatedAt),
    ),
  watched: cards.filter((c) => c.important && c.turn && c.turn !== 'you' && !c.handoff),
  parked: cards.filter((c) => c.handoff),
});

export const yourMoveKeys = (cards) => {
  const { mine, watched, parked } = yourMoveGroups(cards);
  return [...mine, ...watched, ...parked].map((c) => c.key);
};

const ReminderRow = ({ reminder, next = false, searchSet = null }) => (
  <li
    className={`yourmove-row yourmove-row--reminder${next ? ' yourmove-row--next' : ''}${
      reminder.daysLeft != null && reminder.daysLeft <= 2 ? ' yourmove-row--due' : ''
    }${searchClass(searchSet, null)}`}
  >
    <span className="yourmove-ref yourmove-due" title={reminder.due ?? undefined}>
      {next ? 'Next' : reminder.due ? reminder.due.slice(5).replace('-', '/') : '•'}
    </span>
    {reminder.link ? (
      <a className="yourmove-title" href={reminder.link} target="_blank" rel="noreferrer" title={reminder.text}>
        {reminder.text}
      </a>
    ) : (
      <span className="yourmove-title" title={reminder.text}>
        {reminder.text}
      </span>
    )}
    <span className="yourmove-reason">
      {next && reminder.due ? `due ${reminder.due.slice(5).replace('-', '/')}, ` : ''}
      {dueText(reminder.daysLeft)}
    </span>
  </li>
);

// A green ref: nothing left but to merge it (server/classify.mjs mergeReady).
const refClass = (card) => `copy-ref yourmove-ref${card.mergeReady ? ' yourmove-ref--merge-ready' : ''}`;
const refTitle = (card, title) => (card.mergeReady ? `Ready to merge. ${title}` : title);

const Row = ({ card, onReveal, extra, reason, onLaunchSkill, searchSet = null }) => (
  <li
    data-card-key={card.key}
    className={`yourmove-row${card.important ? ' yourmove-row--important' : ''}${
      reason ? ' yourmove-row--watch' : ''
    }${searchClass(searchSet, card.key)}`}
  >
    {card.column === 'review' ? (
      <span className={refClass(card)} title={refTitle(card, 'In the Your review tray')}>
        {shortRef(card)}
      </span>
    ) : (
      <button
        type="button"
        className={refClass(card)}
        onClick={() => onReveal(card.key)}
        title={refTitle(card, 'Show on the board')}
      >
        {shortRef(card)}
      </button>
    )}
    <span className="yourmove-main">
      <a className="yourmove-title" href={card.webUrl} target="_blank" rel="noreferrer" title={card.title}>
        {card.important && '‼ '}
        {card.title.replace(/^Draft:\s*/, '')}
      </a>
      <span className="yourmove-reason" title={card.importantInfo?.reason ?? undefined}>
        {reason ?? card.turnReason}
      </span>
    </span>
    <SkillButton
      card={card}
      skill={skillIn(reason ?? card.turnReason, card.importantInfo?.reason)}
      onLaunchSkill={onLaunchSkill}
    />
    {extra}
  </li>
);

/**
 * What to do next, top to bottom: the plan's next dated step, reminders due within two days,
 * every MR waiting on you (‼ first, then the one waiting longest), ‼ MRs waiting on someone else
 * with their next action, Chromatic acceptance waits on your MRs, then later reminders.
 */
const HandoffButton = ({ card, onHandoff }) =>
  onHandoff ? (
    <button
      type="button"
      className="btn btn--small yourmove-handoff"
      onClick={() => onHandoff(card.key, true)}
      title="An agent is on it: park this until the MR changes (a push, pipeline, approval or column move), the move changes, or a day passes"
    >
      agent's on it
    </button>
  ) : null;

const YourMoveStrip = ({
  cards,
  onReveal,
  requestReviews,
  getMore,
  onHandoff,
  onLaunchSkill,
  reminders = [],
  section = false,
}) => {
  const [readyOpen, setReadyOpen] = useState(false);
  const [parkedOpen, setParkedOpen] = useState(false);
  const { searchSet } = useContext(BoardContext);
  const { mine, watched: watchedCards, parked } = yourMoveGroups(cards);
  const ready = mine.filter((c) => c.turnReason === READY);
  const collapseReady = ready.length > 1;
  // A search hit inside a collapsed group opens it, as the Your review tray does.
  const readyHit = ready.some((c) => searchSet?.has(c.key));
  const readyShown = readyOpen || readyHit;
  const parkedHit = parked.some((c) => searchSet?.has(c.key));
  const parkedShown = parkedOpen || parkedHit;
  const oldestReady = ready
    .map((c) => c.columnSince)
    .filter(Boolean)
    .sort()[0];

  const rows = [];
  for (const card of mine) {
    if (collapseReady && card.turnReason === READY) {
      if (card !== ready[0]) continue;
      rows.push(
        <li
          key="ready"
          className={`yourmove-row yourmove-row--ready${searchSet && !readyHit ? ' yourmove-row--dim' : ''}`}
        >
          <button
            type="button"
            className="yourmove-ready-toggle"
            aria-expanded={readyShown}
            onClick={() => setReadyOpen((o) => !o)}
          >
            {ready.length} ready to share with no reviewer{oldestReady && `, oldest ${ageText(oldestReady)}`}{' '}
            {readyShown ? '▾' : '▸'}
          </button>
          {requestReviews && <span className="yourmove-reason">→</span>}
          {requestReviews}
        </li>,
      );
      if (readyShown) {
        for (const r of ready) {
          rows.push(
            <Row
              key={r.key}
              card={r}
              onReveal={onReveal}
              onLaunchSkill={onLaunchSkill}
              searchSet={searchSet}
              extra={<HandoffButton card={r} onHandoff={onHandoff} />}
            />,
          );
        }
      }
      continue;
    }
    rows.push(
      <Row
        key={card.key}
        card={card}
        onReveal={onReveal}
        onLaunchSkill={onLaunchSkill}
        searchSet={searchSet}
        extra={
          <>
            {card.turnReason === READY && requestReviews}
            <HandoffButton card={card} onHandoff={onHandoff} />
          </>
        }
      />,
    );
  }

  // ‼ MRs whose move is someone else's still show, with the flag's next step and who holds it.
  const watched = watchedCards.map((c) => {
    const who = TURN_TEXT[c.turn] ?? c.turn;
    const what = c.importantInfo?.reason ?? c.waitReason;
    return (
      <Row
        key={c.key}
        card={c}
        onReveal={onReveal}
        onLaunchSkill={onLaunchSkill}
        searchSet={searchSet}
        reason={`${who}${what ? `: ${what}` : ''}`}
      />
    );
  });

  // Moves an agent holds, out of the way in one collapsed row; each comes back on its own.
  const parkedRows = [];
  if (parked.length > 0) {
    parkedRows.push(
      <li
        key="parked"
        className={`yourmove-row yourmove-row--parked${searchSet && !parkedHit ? ' yourmove-row--dim' : ''}`}
      >
        <button
          type="button"
          className="yourmove-ready-toggle"
          aria-expanded={parkedShown}
          onClick={() => setParkedOpen((o) => !o)}
        >
          {parked.length} with an agent {parkedShown ? '▾' : '▸'}
        </button>
      </li>,
    );
    if (parkedShown) {
      for (const c of parked) {
        const h = c.handoff;
        const since = h.session ? 'Claude session working' : `handed off ${ageText(h.at)} ago`;
        parkedRows.push(
          <Row
            key={`parked:${c.key}`}
            card={c}
            onReveal={onReveal}
            searchSet={searchSet}
            reason={`${since} · then ${h.then}`}
            extra={
              !h.session && onHandoff ? (
                <button
                  type="button"
                  className="btn btn--small yourmove-handoff"
                  onClick={() => onHandoff(c.key, false)}
                  title="Put it back in Your move now"
                >
                  take back
                </button>
              ) : null
            }
          />,
        );
      }
    }
  }

  const [nextStep, ...otherReminders] = reminders;
  const soon = otherReminders.filter((r) => r.daysLeft != null && r.daysLeft <= 2);
  const later = otherReminders.filter((r) => !soon.includes(r));
  const all = [
    ...(nextStep ? [<ReminderRow key="next" reminder={nextStep} next searchSet={searchSet} />] : []),
    ...soon.map((r) => <ReminderRow key={`reminder:${r.text}`} reminder={r} searchSet={searchSet} />),
    ...rows,
    ...watched,
    ...parkedRows,
    ...later.map((r) => <ReminderRow key={`reminder:${r.text}`} reminder={r} searchSet={searchSet} />),
  ];

  return (
    <section className={`yourmove${section ? ' yourmove--section' : ''}`} aria-label="Your move">
      <div className="yourmove-head">
        <span className="yourmove-label">
          Your move{mine.length > 0 && <span className="view-count">{mine.length}</span>}
        </span>
        {getMore}
      </div>
      {all.length === 0 ? (
        <p className="yourmove-empty">Nothing waiting on you</p>
      ) : (
        <ul className="yourmove-list">{all}</ul>
      )}
    </section>
  );
};

export default YourMoveStrip;
