import { NavLink, useNavigate } from 'react-router-dom';
import { logout } from '../api';
import { useAuth } from '../auth';

/** Authenticated app frame: hairline top bar with wordmark, nav, and log out. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { setUser } = useAuth();
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
    <>
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className="brand">
            <span className="wordmark">
              signal
              <span className="cursor" aria-hidden="true" />
            </span>
          </span>
          <nav>
            <NavLink
              to="/dashboard"
              className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}
            >
              Settings
            </NavLink>
          </nav>
        </div>
        <button type="button" className="iconbtn" onClick={onLogout}>
          Log out
        </button>
      </header>
      {children}
    </>
  );
}
