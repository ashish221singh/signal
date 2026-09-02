import { useAuth } from '@clerk/clerk-react';
import { Navigate } from 'react-router-dom';

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
  if (!isLoaded) return <FullPageSpinner />;
  if (!isSignedIn) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
