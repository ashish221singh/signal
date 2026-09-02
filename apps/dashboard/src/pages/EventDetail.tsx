import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type EventReasons, getEventReasons, getEventResponses, type ResponseFeed } from '../api';
import { Shell } from '../components/Shell';

type Tab = 'reasons' | 'responses';

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const timeAgo = (iso: string): string => new Date(iso).toLocaleString();

export function EventDetail() {
  const { eventName = '' } = useParams();
  const name = decodeURIComponent(eventName);
  const [tab, setTab] = useState<Tab>('reasons');
  const [reasons, setReasons] = useState<EventReasons | undefined>();
  const [feed, setFeed] = useState<ResponseFeed | undefined>();

  useEffect(() => {
    let alive = true;
    if (tab === 'reasons' && !reasons) {
      getEventReasons(name)
        .then((r) => alive && setReasons(r))
        .catch(() => alive && setReasons({ total_chip_responses: 0, chips: [] }));
    }
    if (tab === 'responses' && !feed) {
      getEventResponses(name)
        .then((r) => alive && setFeed(r))
        .catch(() => alive && setFeed({ items: [], next_cursor: null }));
    }
    return () => {
      alive = false;
    };
  }, [tab, name, reasons, feed]);

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 760 }}>
        <Link to="/dashboard" className="backlink">
          ← Feedback
        </Link>
        <h1 className="page-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 24 }}>
          {name}
        </h1>

        <div className="tabs">
          <button
            type="button"
            className={tab === 'reasons' ? 'on' : ''}
            onClick={() => setTab('reasons')}
          >
            Reasons
          </button>
          <button
            type="button"
            className={tab === 'responses' ? 'on' : ''}
            onClick={() => setTab('responses')}
          >
            Responses
          </button>
        </div>

        <div style={{ marginTop: 'var(--space-6)' }}>
          {tab === 'reasons' ? (
            reasons === undefined ? (
              <Loading />
            ) : reasons.chips.length === 0 ? (
              <Empty>No reason chips yet.</Empty>
            ) : (
              reasons.chips.map((c) => (
                <div className="reason" key={c.chip}>
                  <span className="label">{c.chip}</span>
                  <span className="count">
                    {c.count} · {pct(c.share)}
                  </span>
                  <div className="bar">
                    <span style={{ width: pct(c.share) }} />
                  </div>
                </div>
              ))
            )
          ) : feed === undefined ? (
            <Loading />
          ) : feed.items.length === 0 ? (
            <Empty>No responses yet.</Empty>
          ) : (
            feed.items.map((r) => (
              <div className="resp" key={r.id}>
                <div className="top">
                  <span className="rating">★ {r.rating_value}</span>
                  {r.chip_selected && <span className="chip">{r.chip_selected}</span>}
                  <span className="meta">
                    {[r.device_os, r.app_version && `v${r.app_version}`]
                      .filter(Boolean)
                      .join(' · ')}
                    {' · '}
                    {timeAgo(r.responded_at)}
                  </span>
                </div>
                {r.other_text && <div className="text">“{r.other_text}”</div>}
              </div>
            ))
          )}
        </div>
      </div>
    </Shell>
  );
}

function Loading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-16)' }}>
      <div className="spinner" role="status" aria-label="Loading" />
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: 'var(--ink-secondary)', padding: 'var(--space-8) 0', textAlign: 'center' }}>
      {children}
    </p>
  );
}
