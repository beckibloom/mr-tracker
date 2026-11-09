import { useState } from 'react';

import { shortRef } from '../links.js';

const READY = 'request review';

// Short labels for whose move a card waits on (server/classify.mjs whoseTurn).
const TURN_TEXT = { agent: 'agent', reviewer: 'reviewer', ci: 'CI', blocked: 'blocked' };

const ageText = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

// A dated reminder from the program file: "in 11 days", "today", "3 days late".
const dueText = (n) =>
  n == null ? '' : n > 1 ? `in ${n} days` : n === 1 ? 'tomorrow' : n === 0 ? 'today' : `${-n} day${n === -1 ? '' : 's'} late`;

const ReminderRow = ({ reminder, next = false }) => (
  <li
    className={`yourmove-row yourmove-row--reminder${next ? ' yourmove-row--next' : ''}${
      reminder.daysLeft != null && reminder.daysLeft <= 2 ? ' yourmove-row--due' : ''
    }`}
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

const Row = ({ card, onReveal, extra, reason }) => (
  <li className={`yourmove-row${card.important ? ' yourmove-row--important' : ''}${reason ? ' yourmove-row--watch' : ''}`}>
    {card.column === 'review' ? (
      <span className="copy-ref yourmove-ref" title="In the Your review tray">
        {shortRef(card)}
      </span>
    ) : (
      <button
        type="button"
        className="copy-ref yourmove-ref"
        onClick={() => onReveal(card.key)}
        title="Show on the board"
      >
        {shortRef(card)}
      </button>
    )}
    <a className="yourmove-title" href={card.webUrl} target="_blank" rel="noreferrer" title={card.title}>
      {card.important && '‼ '}
      {card.title.replace(/^Draft:\s*/, '')}
    </a>
    <span className="yourmove-reason" title={card.importantInfo?.reason ?? undefined}>
      {reason ?? card.turnReason}
    </span>
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

const YourMoveStrip = ({ cards, onReveal, requestReviews, onHandoff, reminders = [], section = false }) => {
  const [readyOpen, setReadyOpen] = useState(false);
  const [parkedOpen, setParkedOpen] = useState(false);
  const mine = cards
    .filter((c) => c.turn === 'you')
    .sort(
      (a, b) =>
        (b.important ? 1 : 0) - (a.important ? 1 : 0) || new Date(a.updatedAt) - new Date(b.updatedAt),
    );
  const ready = mine.filter((c) => c.turnReason === READY);
  const collapseReady = ready.length > 1;
  const oldestReady = ready
    .map((c) => c.columnSince)
    .filter(Boolean)
    .sort()[0];

  const rows = [];
  for (const card of mine) {
    if (collapseReady && card.turnReason === READY) {
      if (card !== ready[0]) continue;
      rows.push(
        <li key="ready" className="yourmove-row yourmove-row--ready">
          <button
            type="button"
            className="yourmove-ready-toggle"
            aria-expanded={readyOpen}
            onClick={() => setReadyOpen((o) => !o)}
          >
            {ready.length} ready to share with no reviewer{oldestReady && `, oldest ${ageText(oldestReady)}`}{' '}
            {readyOpen ? '▾' : '▸'}
          </button>
          {requestReviews && <span className="yourmove-reason">→</span>}
          {requestReviews}
        </li>,
      );
      if (readyOpen) {
        for (const r of ready) {
          rows.push(<Row key={r.key} card={r} onReveal={onReveal} extra={<HandoffButton card={r} onHandoff={onHandoff} />} />);
        }
      }
      continue;
    }
    rows.push(
      <Row
        key={card.key}
        card={card}
        onReveal={onReveal}
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
  const watched = cards
    .filter((c) => c.important && c.turn && c.turn !== 'you' && !c.handoff)
    .map((c) => {
      const who = TURN_TEXT[c.turn] ?? c.turn;
      const what = c.importantInfo?.reason ?? c.waitReason;
      return <Row key={c.key} card={c} onReveal={onReveal} reason={`${who}${what ? `: ${what}` : ''}`} />;
    });

  // Snapshots on your own MRs waiting for acceptance; accept yours or chase the owner.
  const chromatic = cards
    .filter((c) => c.chromatic && c.state === 'opened' && !c.important && c.turn !== 'you' && !c.yourReview)
    .map((c) => (
      <Row key={`chromatic:${c.key}`} card={c} onReveal={onReveal} reason={`accept Chromatic snapshots · waiting ${ageText(c.chromatic.since)}`} />
    ));

  // Moves an agent holds, out of the way in one collapsed row; each comes back on its own.
  const parked = cards.filter((c) => c.handoff);
  const parkedRows = [];
  if (parked.length > 0) {
    parkedRows.push(
      <li key="parked" className="yourmove-row yourmove-row--parked">
        <button
          type="button"
          className="yourmove-ready-toggle"
          aria-expanded={parkedOpen}
          onClick={() => setParkedOpen((o) => !o)}
        >
          {parked.length} with an agent {parkedOpen ? '▾' : '▸'}
        </button>
      </li>,
    );
    if (parkedOpen) {
      for (const c of parked) {
        const h = c.handoff;
        const since = h.session ? 'Claude session working' : `handed off ${ageText(h.at)} ago`;
        parkedRows.push(
          <Row
            key={`parked:${c.key}`}
            card={c}
            onReveal={onReveal}
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
    ...(nextStep ? [<ReminderRow key="next" reminder={nextStep} next />] : []),
    ...soon.map((r) => <ReminderRow key={`reminder:${r.text}`} reminder={r} />),
    ...rows,
    ...watched,
    ...chromatic,
    ...parkedRows,
    ...later.map((r) => <ReminderRow key={`reminder:${r.text}`} reminder={r} />),
  ];

  return (
    <section className={`yourmove${section ? ' yourmove--section' : ''}`} aria-label="Your move">
      <span className="yourmove-label">
        Your move{mine.length > 0 && <span className="view-count">{mine.length}</span>}
      </span>
      {all.length === 0 ? (
        <p className="yourmove-empty">Nothing waiting on you</p>
      ) : (
        <ul className="yourmove-list">{all}</ul>
      )}
    </section>
  );
};

export default YourMoveStrip;
