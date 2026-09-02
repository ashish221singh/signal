import { SignIn, useAuth } from '@clerk/clerk-react';
import { Navigate, useSearchParams } from 'react-router-dom';

/** Dashboard login (F3, Clerk). Clerk's <SignIn> handles email/social/OTP. */
export function Login() {
  const { isLoaded, isSignedIn } = useAuth();
  const [params] = useSearchParams();
  // `redirect` is a router-relative path (e.g. /cli/approve?user_code=…) set by
  // RequireAuth; Clerk needs the origin-absolute form, so prefix the /app basename.
  const target = params.get('redirect') ?? '/dashboard';

  if (isLoaded && isSignedIn) return <Navigate to={target} replace />;

  return (
    <div className="center">
      <SignIn
        routing="virtual"
        fallbackRedirectUrl={`/app${target}`}
        signUpForceRedirectUrl={`/app${target}`}
      />
    </div>
  );
}
