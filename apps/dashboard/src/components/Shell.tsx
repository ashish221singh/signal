import { useClerk } from '@clerk/clerk-react';
import { NavLink } from 'react-router-dom';

/** Authenticated app frame: hairline top bar with wordmark, nav, and log out. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { signOut } = useClerk();

  function onLogout() {
    void signOut({ redirectUrl: '/app/login' });
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
