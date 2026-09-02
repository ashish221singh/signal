import { SignIn, useAuth } from '@clerk/clerk-react';
import { Navigate } from 'react-router-dom';

/** Dashboard login (F3, Clerk). Clerk's <SignIn> handles email/social/OTP. */
export function Login() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Navigate to="/dashboard" replace />;

  return (
    <div className="center">
      <SignIn
        routing="virtual"
        fallbackRedirectUrl="/app/dashboard"
        signUpForceRedirectUrl="/app/dashboard"
      />
    </div>
  );
}
