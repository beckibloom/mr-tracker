import { useEffect, useState } from 'react';

import { shortRef } from '../links.js';
import StateDot from './StateDot.jsx';

const md = (iso) => (iso ? iso.slice(5).replace('-', '/') : '—');

const LANE_SHORT = { auto: 'auto', agent: 'agent', human: 'human' };

const MrRef = ({ card }) =>
  card ? (
    <a
      className={`program-mr program-mr--${card.lane?.lane ?? 'none'}`}
      href={card.webUrl}
      target="_blank"
      rel="noreferrer"
      title={`${card.title}${card.lane ? ` · ${card.lane.lane} lane${card.lane.risk ? `, risk ${card.lane.risk.score}` : ''}` : ''}`}
    >
      <StateDot card={card} />
      {shortRef(card)}
      {card.lane && <span className="program-mr-lane">{LANE_SHORT[card.lane.lane]}</span>}
    </a>
  ) : null;

const GapQueue = ({ gaps, idleDays, fromJira }) => (
  <section className="program-section">
    <h2>Gap queue</h2>
    <p className="program-help">
      {fromJira
        ? 'Open tickets that block a family in Jira, most files first. '
        : 'Gaps that gate families, most files first. '}
      A gap an agent can take meets all four hand-off conditions: open sprint, To Do, assigned to
      you, ai-ready plus a repo label.
    </p>
    <table className="program-table">
      <thead>
        <tr>
          <th>Ticket</th>
          <th className="num">Files</th>
          <th>Family</th>
          <th>Status</th>
          <th className="num">Idle</th>
          <th>Hand-off to an agent</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {[...gaps]
          .sort((a, b) => (b.files ?? 0) - (a.files ?? 0))
          .map((g) => {
            const j = g.jira;
            const idle = j?.idleDays ?? null;
            const done = j?.statusCategory === 'done';
            return (
              <tr key={g.key} className={done ? 'program-row--done' : ''}>
                <td>
                  <a href={g.url} target="_blank" rel="noreferrer" title={j?.summary ?? undefined}>
                    {g.key}
                  </a>
                </td>
                <td className="num">{g.files ?? '—'}</td>
                <td>{g.family ?? '—'}</td>
                <td>{j?.status ?? '—'}</td>
                <td className={`num${idle != null && idle > idleDays && !done ? ' program-late' : ''}`}>
                  {idle != null ? `${idle}d` : '—'}
                </td>
                <td>
                  {!j ? (
                    <span className="chip chip--muted">no Jira data</span>
                  ) : j.handoffMissing.length === 0 ? (
                    <span className="chip chip--good">ready for an agent</span>
                  ) : (
                    <span className="chip chip--muted" title={j.handoffMissing.join(', ')}>
                      missing: {j.handoffMissing.join(', ')}
                    </span>
                  )}
                </td>
                <td className="program-note">{g.note ?? ''}</td>
              </tr>
            );
          })}
      </tbody>
    </table>
  </section>
);

const Families = ({ families, cardByKey }) => (
  <section className="program-section">
    <h2>Families</h2>
    <p className="program-help">
      Files left on main per family, files removed in the last four weeks, and the MRs on the
      board for each. <strong>serial</strong> marks an ungated family with files left and at most
      one MR open: open its area MRs in parallel.
    </p>
    <table className="program-table">
      <thead>
        <tr>
          <th>Family</th>
          <th className="num">Left</th>
          <th className="num">−4 wks</th>
          <th>Open MRs</th>
          <th className="num">Merged 7d</th>
          <th>Who</th>
          <th>Forecast</th>
          <th>Gate</th>
        </tr>
      </thead>
      <tbody>
        {families.map((f) => (
          <tr key={f.id} className={f.filesLeft === 0 ? 'program-row--done' : ''}>
            <td>
              <span className="program-family" title={(f.packages ?? []).join(', ')}>
                {f.name}
              </span>
              {f.key && (
                <span className="program-jira">
                  {' '}
                  <a href={f.url} target="_blank" rel="noreferrer" title={f.summary ?? undefined}>
                    {f.key}
                  </a>
                  {f.status && <span className="program-status"> · {f.status}</span>}
                  {f.areas && (
                    <span className="program-status">
                      {' '}
                      · {f.areas.open} of {f.areas.total} areas open
                    </span>
                  )}
                </span>
              )}
              {f.serial && (
                <span className="chip chip--warn program-flag" title="Ungated, files left, at most one MR open">
                  serial
                </span>
              )}
              {f.note && <div className="program-note">{f.note}</div>}
            </td>
            <td className="num">
              {f.filesLeft ?? '—'}
              {f.splitLeft > 0 && <span className="program-split"> ({f.splitLeft})</span>}
            </td>
            <td className="num">{f.removed4w ?? '—'}</td>
            <td>
              <span className="program-mrs">
                {f.openMrs.map((k) => (
                  <MrRef key={k} card={cardByKey.get(k)} />
                ))}
                {f.openMrs.length === 0 && <span className="program-none">none</span>}
              </span>
            </td>
            <td className="num">{f.mergedMrs.length || ''}</td>
            <td>{f.owner ?? ''}</td>
            <td>
              <span
                className={f.forecastFrom === 'file' ? 'program-forecast--file' : undefined}
                title={f.forecastFrom === 'file' ? 'From the plan file: no due date in Jira' : undefined}
              >
                {md(f.forecast)}
              </span>
              {f.withLane && f.withLane !== f.forecast && (
                <span className="program-lane-date" title="With the faster review lane">
                  {' '}
                  → {md(f.withLane)}
                </span>
              )}
            </td>
            <td>
              {f.gate === 'gated' ? (
                <span className="chip chip--blocked" title={f.gateNote ?? undefined}>
                  gated
                </span>
              ) : f.gate ? (
                <span className="chip chip--good">ready</span>
              ) : null}
              {f.gate === 'gated' && f.blockers?.length > 0 ? (
                <div className="program-note">
                  by{' '}
                  {f.blockers.map((b, i) => (
                    <span key={b.key}>
                      {i > 0 && ', '}
                      <a href={b.url ?? undefined} target="_blank" rel="noreferrer" title={b.summary ?? undefined}>
                        {b.key}
                      </a>
                    </span>
                  ))}
                </div>
              ) : (
                f.gate === 'gated' && f.gateNote && <div className="program-note">{f.gateNote}</div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

/** The program tab: the gap queue and one row per family (README "Program tab"). */
const ProgramPanel = ({ cardByKey }) => {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch('/api/program')
        .then((r) => r.json())
        .then((d) => live && setData(d))
        .catch(() => live && setData({ error: 'Could not load the program.' }));
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!data) return <div className="program">Loading…</div>;
  if (data.error) return <div className="program chains-empty">{data.error}</div>;
  if (!data.enabled) {
    return (
      <div className="program chains-empty">
        No program file. Set MRT_PROGRAM_FILE to a JSON file with families, gaps and reminders
        (README "Program tab").
      </div>
    );
  }
  return (
    <div className="program">
      <header className="program-header">
        <h1>{data.title ?? 'Program'}</h1>
        <span className="program-meta">
          {data.source === 'jira' && data.jiraFamilies != null && `${data.jiraFamilies} families from Jira · `}
          plan file updated {data.updated ?? '?'} · <code>{data.file}</code>
        </span>
      </header>
      {data.jiraError && (
        <div className="program-note program-late">
          Jira unavailable ({data.jiraError}); showing the plan file's rows without gaps.
        </div>
      )}
      <GapQueue gaps={data.gaps} idleDays={data.gapIdleDays} fromJira={data.source === 'jira'} />
      <Families families={data.families} cardByKey={cardByKey} />
    </div>
  );
};

export default ProgramPanel;
