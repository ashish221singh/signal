import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getMe, type SessionUser } from './api';

/**
 * Auth state (F3): on mount we ask `/v1/console/auth/me`. `undefined` = still
 * checking, `null` = signed out, a user = signed in. `RequireAuth` gates the
 * dashboard/settings routes; `Login` bounces already-authed users to the app.
 */
interface AuthState {
  user: SessionUser | null | undefined;
  setUser: (u: SessionUser | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    getMe()
      .then((u) => alive && setUser(u))
      .catch(() => alive && setUser(null));
    return () => {
      alive = false;
    };
  }, []);

  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

function FullPageSpinner() {
  return (
    <div className="center">
      <div className="spinner" role="status" aria-label="Loading" />
    </div>
  );
}

/** Gate: show a spinner while checking, redirect to /login when signed out. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <FullPageSpinner />;
  if (user === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
