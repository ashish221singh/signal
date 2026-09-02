import { useClerk, useUser } from '@clerk/clerk-react';
import { CopyCommand } from '../components/CopyCommand';
import { Shell } from '../components/Shell';

/** Settings (F3, Clerk): setup command to reuse, account identity, log out. */
export function Settings() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress;

  function onLogout() {
    void signOut({ redirectUrl: '/app/login' });
  }

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 640 }}>
        <h1 className="page-title">Settings</h1>

        <div className="section">
          <h2>Your setup command</h2>
          <CopyCommand />
          <p className="hint">Run this in any project to connect it to Signal.</p>
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
