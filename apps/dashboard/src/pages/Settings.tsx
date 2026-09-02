import { useClerk, useUser } from '@clerk/clerk-react';
import { useState } from 'react';
import { createCliToken } from '../api';
import { SetupTabs } from '../components/SetupTabs';
import { Shell } from '../components/Shell';

const CLI = '@ashish221/signal-cli';

/** Settings (F3, Clerk): setup command, connect-the-CLI token, account, log out. */
export function Settings() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress;

  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      setToken(await createCliToken());
    } finally {
      setBusy(false);
    }
  }

  const loginCmd = token ? `npx ${CLI} login --token ${token}` : '';
  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(loginCmd);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function onLogout() {
    void signOut({ redirectUrl: '/app/login' });
  }

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 640 }}>
        <h1 className="page-title">Settings</h1>

        <div className="section">
          <h2>Add feedback to your app</h2>
          <SetupTabs align="start" />
        </div>

        <div className="section">
          <h2>Connect the CLI</h2>
          <p className="hint" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>
            Generate a token to sign the terminal into <em>this</em> account, then create feedback
            with <code>{`npx ${CLI} setup`}</code>.
          </p>
          {!token ? (
            <button type="button" className="iconbtn" onClick={generate} disabled={busy}>
              {busy ? 'Generating…' : 'Generate CLI token'}
            </button>
          ) : (
            <>
              <div className="codechip" style={{ maxWidth: '100%' }}>
                <code style={{ overflowX: 'auto', whiteSpace: 'nowrap' }}>
                  <span className="prompt" aria-hidden="true">
                    $
                  </span>
                  {loginCmd}
                </code>
                <button
                  type="button"
                  className={`copybtn${copied ? ' copied' : ''}`}
                  onClick={copyCmd}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="hint" style={{ color: 'var(--danger)' }}>
                Copy it now — this token is shown only once.
              </p>
            </>
          )}
        </div>

        <div className="section">
          <h2>Account</h2>
          <p style={{ font: 'var(--text-body)' }}>
            {email}
            <span style={{ color: 'var(--ink-tertiary)' }}> · Clerk</span>
          </p>
        </div>

        <div className="section">
          <h2>Session</h2>
          <button type="button" className="danger" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>
    </Shell>
  );
}
