import { useAuth } from '@clerk/clerk-react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Auth guard (F3, Clerk). Clerk's <ClerkProvider> (in main.tsx) is the context; here
 * we just gate the dashboard/settings routes on its signed-in state.
 */
function FullPageSpinner() {
  return (
    <div className="center">
      <div className="spinner" role="status" aria-label="Loading" />
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <FullPageSpinner />;
  if (!isSignedIn) {
    // Preserve where they were headed (e.g. /cli/approve?user_code=…) so login
    // returns them there instead of always dumping to the dashboard.
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}
