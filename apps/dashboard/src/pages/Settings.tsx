import { useNavigate } from 'react-router-dom';
import { logout } from '../api';
import { useAuth } from '../auth';
import { CopyCommand } from '../components/CopyCommand';
import { Shell } from '../components/Shell';

/** Settings (F3 Phase 5 shell): setup command to reuse, account identity, log out. */
export function Settings() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    try {
      await logout();
    } finally {
      setUser(null);
      navigate('/login', { replace: true });
    }
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
            {user?.email}
            <span style={{ color: 'var(--ink-tertiary)' }}> · Google</span>
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
