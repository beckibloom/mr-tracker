import { useCallback, useEffect, useState } from 'react';

const round15 = (m) => Math.round(m / 15) * 15;

const fmtMin = (m) => {
  const h = Math.floor(m / 60);
  return [h ? `${h}h` : '', m % 60 ? `${m % 60}m` : ''].join(' ').trim() || '0m';
};

/** Scale included rows' weights to the stated total, 15-min rounding,
 * largest row absorbs the rounding remainder. */
const distribute = (rows, totalMin) => {
  const included = rows.filter((r) => r.include && r.key);
  const sumWeight = included.reduce((s, r) => s + r.weight, 0);
  if (!sumWeight || !totalMin) return rows;
  let out = rows.map((r) =>
    r.include && r.key ? { ...r, minutes: round15((totalMin * r.weight) / sumWeight) } : r,
  );
  const sum = out.filter((r) => r.include && r.key).reduce((s, r) => s + r.minutes, 0);
  const diff = totalMin - sum;
  if (diff) {
    const largest = out
      .filter((r) => r.include && r.key)
      .reduce((a, b) => (b.minutes > a.minutes ? b : a));
    out = out.map((r) => (r === largest ? { ...r, minutes: r.minutes + diff } : r));
  }
  return out;
};

const TimePanel = () => {
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [hours, setHours] = useState('');
  const [report, setReport] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [logging, setLogging] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async (d) => {
    setLoading(true);
    setResults(null);
    setConfirming(false);
    setError(null);
    try {
      const res = await fetch(`/api/time?date=${d}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReport(data);
      setRows(
        data.tickets.map((t, i) => ({
          id: i,
          key: t.key,
          label: t.label,
          summary: t.summary,
          weight: t.weight,
          derivation: t.derivation,
          minutes: 0,
          include: Boolean(t.key),
        })),
      );
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  const totalMin = round15((parseFloat(hours) || 0) * 60);
  const plannedMin = rows.filter((r) => r.include && r.key).reduce((s, r) => s + r.minutes, 0);

  const updateRow = (id, patch) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setConfirming(false);
  };

  const logIt = async () => {
    setLogging(true);
    setError(null);
    try {
      const entries = rows
        .filter((r) => r.include && r.key && r.minutes > 0)
        .map((r) => ({ key: r.key, minutes: r.minutes }));
      const res = await fetch('/api/time/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, entries }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results);
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setLogging(false);
      setConfirming(false);
    }
  };

  const loggable = rows.filter((r) => r.include && r.key && r.minutes > 0);

  return (
    <div className="time-panel">
      <div className="time-controls">
        <label>
          Date{' '}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Hours worked{' '}
          <input
            type="number"
            min="0"
            step="0.25"
            placeholder="e.g. 7"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <button
          className="btn"
          disabled={!totalMin || loading}
          onClick={() => {
            setRows((rs) => distribute(rs, totalMin));
            setConfirming(false);
          }}
        >
          Distribute {totalMin ? fmtMin(totalMin) : ''}
        </button>
        <button className="btn" disabled={loading} onClick={() => load(date)}>
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {error && <p className="time-error">⚠ {error}</p>}
      {loading && <p className="time-muted">Scanning git, Claude Code sessions, and GitLab…</p>}
      {!loading && rows.length === 0 && !error && (
        <p className="time-muted">No work signals found for {date}.</p>
      )}

      {rows.length > 0 && (
        <table className="time-table">
          <thead>
            <tr>
              <th />
              <th>Ticket</th>
              <th>What it's for</th>
              <th>Time</th>
              <th>How the time was derived</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.include && r.key ? '' : 'time-row--off'}>
                <td>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => updateRow(r.id, { include: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    className="time-key"
                    value={r.key ?? ''}
                    placeholder={r.label}
                    onChange={(e) =>
                      updateRow(r.id, { key: e.target.value.trim().toUpperCase() || null })
                    }
                  />
                </td>
                <td className="time-summary">{r.summary ?? '—'}</td>
                <td>
                  <input
                    className="time-minutes"
                    type="number"
                    min="0"
                    step="15"
                    value={r.minutes}
                    onChange={(e) => updateRow(r.id, { minutes: Number(e.target.value) || 0 })}
                  />{' '}
                  <span className="time-muted">{fmtMin(r.minutes)}</span>
                </td>
                <td className="time-derivation">
                  {r.derivation.map((d, i) => (
                    <div key={i}>{d}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 && (
        <div className="time-footer">
          <span>
            Planned: <strong>{fmtMin(plannedMin)}</strong>
            {totalMin > 0 && plannedMin !== totalMin && (
              <span className="time-error"> (target {fmtMin(totalMin)})</span>
            )}
            {' — nothing has been written to Jira yet'}
          </span>
          {!report?.hasJiraWrite && (
            <span className="time-muted">Export JIRA_EMAIL + JIRA_API_TOKEN to enable logging</span>
          )}
          {report?.hasJiraWrite && !confirming && (
            <button
              className="btn"
              disabled={loggable.length === 0 || logging}
              onClick={() => setConfirming(true)}
            >
              Log to Jira…
            </button>
          )}
          {report?.hasJiraWrite && confirming && (
            <span className="time-confirm">
              Write {loggable.map((r) => `${r.key} ${fmtMin(r.minutes)}`).join(', ')} for {date}?{' '}
              <button className="btn btn--danger" disabled={logging} onClick={logIt}>
                {logging ? 'Logging…' : 'Confirm'}
              </button>{' '}
              <button className="btn" disabled={logging} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>
      )}

      {results && (
        <ul className="time-results">
          {results.map((r) => (
            <li key={r.key} className={r.ok ? 'time-ok' : 'time-error'}>
              {r.ok ? `✓ ${r.key}: logged ${r.logged}` : `✗ ${r.key}: ${r.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TimePanel;
