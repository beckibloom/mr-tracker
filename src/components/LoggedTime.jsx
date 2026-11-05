import { useCallback, useEffect, useState } from 'react';

const fmtHours = (m) => (m ? String(+(m / 60).toFixed(2)) : '·');

const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    date: d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
  };
};

/** Hours already in Jira for the last 7 days, per ticket per day. */
const LoggedTime = ({ refreshKey }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/time/logged?days=7');
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const dates = data?.dates ?? [];
  const today = new Date().toLocaleDateString('en-CA');
  const dayTotals = dates.map((d) => (data?.rows ?? []).reduce((s, r) => s + r.minutes[d], 0));
  const grandTotal = dayTotals.reduce((s, m) => s + m, 0);

  return (
    <section className="logged">
      <div className="logged-head">
        <h2 className="logged-title">Logged in Jira, last 7 days</h2>
        <button className="btn" disabled={loading} onClick={load}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="time-error">⚠ {error}</p>}
      {!data && loading && <p className="time-muted">Reading worklogs from Jira…</p>}
      {data && data.rows.length === 0 && (
        <p className="time-muted">Nothing logged in the last 7 days.</p>
      )}

      {data && data.rows.length > 0 && (
        <table className="time-table logged-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Summary</th>
              {dates.map((d) => {
                const { weekday, date } = dayLabel(d);
                return (
                  <th key={d} className={`logged-num${d === today ? ' logged-today' : ''}`}>
                    {weekday}
                    <br />
                    <span className="logged-date">{date}</span>
                  </th>
                );
              })}
              <th className="logged-num">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const total = dates.reduce((s, d) => s + r.minutes[d], 0);
              return (
                <tr key={r.key}>
                  <td className="logged-key">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer">
                        {r.key}
                      </a>
                    ) : (
                      r.key
                    )}
                  </td>
                  <td className="time-summary">{r.summary ?? '—'}</td>
                  {dates.map((d) => (
                    <td
                      key={d}
                      className={`logged-num${r.minutes[d] ? '' : ' logged-zero'}${d === today ? ' logged-today' : ''}`}
                    >
                      {fmtHours(r.minutes[d])}
                    </td>
                  ))}
                  <td className="logged-num logged-total">{fmtHours(total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="logged-total">
                Total
              </td>
              {dayTotals.map((m, i) => (
                <td
                  key={dates[i]}
                  className={`logged-num logged-total${dates[i] === today ? ' logged-today' : ''}`}
                >
                  {fmtHours(m)}
                </td>
              ))}
              <td className="logged-num logged-total">{fmtHours(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
};

export default LoggedTime;
