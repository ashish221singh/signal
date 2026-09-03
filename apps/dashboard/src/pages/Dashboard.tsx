import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type EventRow, type EventsOverview, getEventsOverview, type PeriodDays } from '../api';
import { SetupTabs } from '../components/SetupTabs';
import { Shell } from '../components/Shell';

const PERIODS: PeriodDays[] = [7, 30, 90];

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Response-weighted aggregates for the stat trio, computed from the event rows. */
function aggregate(rows: EventRow[]) {
  let triggers = 0;
  let responses = 0;
  let posNum = 0;
  let posDen = 0;
  for (const r of rows) {
    triggers += r.triggers;
    responses += r.responses;
    if (r.positive_score !== null) {
      posNum += r.positive_score * r.responses;
      posDen += r.responses;
    }
  }
  return {
    responses,
    responseRate: triggers === 0 ? null : responses / triggers,
    positive: posDen === 0 ? null : posNum / posDen,
  };
}

export function Dashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [data, setData] = useState<EventsOverview | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError(false);
    getEventsOverview(period)
      .then((r) => alive && setData(r))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [period]);

  const rows = data?.events;
  const hasData = rows !== undefined && rows.length > 0;
  const agg = hasData ? aggregate(rows) : null;

  return (
    <Shell>
      <div className="page">
        <div className="toolbar">
          <h1 className="page-title">Feedback</h1>
          {hasData && (
            <div className="period" role="tablist" aria-label="Period">
              {PERIODS.map((d) => (
                <button
                  type="button"
                  key={d}
                  role="tab"
                  className={d === period ? 'on' : ''}
                  aria-selected={d === period}
                  onClick={() => setPeriod(d)}
                >
                  {d} days
                </button>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <EmptyLike title="Couldn't load feedback">
            Something went wrong fetching your data. Refresh to try again.
          </EmptyLike>
        ) : data === undefined ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-24)' }}>
            <div className="spinner" role="status" aria-label="Loading" />
          </div>
        ) : !hasData ? (
          <EmptyLike title="No feedback yet">
            Add feedback to your app in one command — pick how you work. Responses will appear here
            as they come in.
            <div style={{ marginTop: 'var(--space-6)' }}>
              <SetupTabs align="center" />
            </div>
          </EmptyLike>
        ) : (
          <>
            <div className="stats">
              <Stat k="Responses" v={agg?.responses.toLocaleString() ?? '0'} />
              <Stat k="Unique users" v={(data.unique_users ?? 0).toLocaleString()} />
              <Stat k="Positive" v={pct(agg?.positive ?? null)} pos />
              <Stat k="Response rate" v={pct(agg?.responseRate ?? null)} />
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Responses</th>
                  <th>Users</th>
                  <th>Positive</th>
                  <th>Response rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.event_name}
                    className="clickable"
                    onClick={() => navigate(`/events/${encodeURIComponent(r.event_name)}`)}
                  >
                    <td>{r.event_name}</td>
                    <td>{r.responses.toLocaleString()}</td>
                    <td>{r.unique_users.toLocaleString()}</td>
                    <td>
                      {r.positive_score === null ? (
                        <span className="muted-cell">—</span>
                      ) : (
                        <span className={`pill ${r.positive_score >= 0.6 ? 'good' : 'warn'}`}>
                          {pct(r.positive_score)}
                        </span>
                      )}
                    </td>
                    <td>
                      {r.response_rate === null ? (
                        <span className="muted-cell">—</span>
                      ) : (
                        pct(r.response_rate)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Shell>
  );
}

function Stat({ k, v, pos }: { k: string; v: string; pos?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v${pos ? ' pos' : ''}`}>{v}</div>
    </div>
  );
}

function EmptyLike({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 'var(--space-12)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-16) var(--space-6)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface)',
      }}
    >
      <h2 style={{ font: '600 20px/1.2 var(--font-display)', letterSpacing: '-0.01em' }}>
        {title}
      </h2>
      <div style={{ color: 'var(--ink-secondary)', maxWidth: '44ch' }}>{children}</div>
    </div>
  );
}
