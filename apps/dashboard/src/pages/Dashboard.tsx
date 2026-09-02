import { CopyCommand } from '../components/CopyCommand';
import { Shell } from '../components/Shell';

/**
 * Dashboard (F3 Phase 3): the app frame + the single empty state. Phase 4 wires
 * the B4 reporting endpoints (stat trio + per-event table) and swaps this empty
 * view in only when the account has no data yet.
 */
export function Dashboard() {
  return (
    <Shell>
      <div className="page">
        <h1 className="page-title">Feedback</h1>
        <div
          style={{
            marginTop: 'var(--space-12)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 'var(--space-5)',
            padding: 'var(--space-16) var(--space-6)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--surface)',
          }}
        >
          <h2 style={{ font: '600 20px/1.2 var(--font-display)', letterSpacing: '-0.01em' }}>
            No feedback yet
          </h2>
          <p style={{ color: 'var(--ink-secondary)', maxWidth: '42ch' }}>
            Run this in your project to connect it. Responses will appear here as they come in.
          </p>
          <CopyCommand />
        </div>
      </div>
    </Shell>
  );
}
