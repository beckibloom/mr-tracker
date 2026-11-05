import { useCallback, useEffect, useRef, useState } from 'react';

const fmtHours = (m) => (m ? String(+(m / 60).toFixed(2)) : '·');

const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    date: d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
  };
};

const STALE_MS = 5 * 60 * 1000;

/** Hours already in Jira per day for the last 7 days, with the week total. */
const LoggedTime = ({ refreshKey, active = true }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const loadedAt = useRef(0);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/time/logged?days=7${fresh ? '&fresh=1' : ''}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
      loadedAt.current = Date.now();
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (refreshKey) load(true);
  }, [load, refreshKey]);

  useEffect(() => {
    if (active && Date.now() - loadedAt.current > STALE_MS) load();
  }, [active, load]);

  const dates = data?.dates ?? [];
  const today = new Date().toLocaleDateString('en-CA');
  const dayTotals = dates.map((d) => (data?.rows ?? []).reduce((s, r) => s + r.minutes[d], 0));
  const grandTotal = dayTotals.reduce((s, m) => s + m, 0);

  return (
    <section className="logged">
      <div className="logged-head">
        <h2 className="logged-title">Logged in Jira, last 7 days</h2>
        <button className="btn" disabled={loading} onClick={() => load(true)}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="time-error">⚠ {error}</p>}
      {!data && loading && <p className="time-muted">Reading worklogs from Jira…</p>}
      {data && (
        <table className="time-table logged-table">
          <thead>
            <tr>
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
            <tr>
              {dayTotals.map((m, i) => (
                <td
                  key={dates[i]}
                  className={`logged-num${m ? '' : ' logged-zero'}${dates[i] === today ? ' logged-today' : ''}`}
                >
                  {fmtHours(m)}
                </td>
              ))}
              <td className="logged-num logged-total">{fmtHours(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
};

export default LoggedTime;
