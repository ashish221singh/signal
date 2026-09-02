import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { approveCliDevice } from '../api';
import { Shell } from '../components/Shell';

type State = 'idle' | 'working' | 'approved' | 'denied' | 'error';

/**
 * CLI device-approval page (F4). Reached from `signal connect`/`quickstart`'s
 * verification link. It's behind RequireAuth (Clerk), so the user signs in with the
 * SAME Google/Clerk identity as the dashboard — and approval binds the CLI token to
 * that account. On success they return to the terminal, where the CLI's poll picks
 * up the token.
 */
export function CliApprove() {
  const [params] = useSearchParams();
  const userCode = params.get('user_code') ?? '';
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  async function act(decision: 'approve' | 'deny') {
    setState('working');
    try {
      const { status } = await approveCliDevice(userCode, decision);
      if (status === 'approved') setState('approved');
      else if (status === 'denied') setState('denied');
      else {
        setState('error');
        setMessage('That code is invalid or expired — start the CLI again.');
      }
    } catch (e) {
      setState('error');
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 520 }}>
        <h1 className="page-title">Authorize the CLI</h1>

        {!userCode ? (
          <p className="hint">No device code in the link — start the CLI again.</p>
        ) : state === 'approved' ? (
          <div className="section">
            <h2>✓ CLI authorized</h2>
            <p style={{ font: 'var(--text-body)' }}>
              You can close this tab and return to your terminal — it’s connecting now.
            </p>
          </div>
        ) : state === 'denied' ? (
          <div className="section">
            <h2>Denied</h2>
            <p style={{ font: 'var(--text-body)' }}>The CLI was not authorized.</p>
          </div>
        ) : state === 'error' ? (
          <div className="section">
            <h2 style={{ color: 'var(--danger)' }}>Couldn’t authorize</h2>
            <p style={{ font: 'var(--text-body)' }}>{message}</p>
          </div>
        ) : (
          <div className="section">
            <p style={{ font: 'var(--text-body)', marginBottom: 'var(--space-2)' }}>
              A terminal is requesting access to your Signal account. Approve it only if you just
              started <code>signal connect</code> or <code>signal quickstart</code>.
            </p>
            <p className="hint" style={{ marginTop: 0 }}>
              Device code: <strong>{userCode}</strong>
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}>
              <button
                type="button"
                className="iconbtn"
                disabled={state === 'working'}
                onClick={() => act('approve')}
              >
                {state === 'working' ? 'Authorizing…' : 'Authorize'}
              </button>
              <button
                type="button"
                className="danger"
                disabled={state === 'working'}
                onClick={() => act('deny')}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
