import { Navigate, useSearchParams } from 'react-router-dom';
import { googleLoginUrl } from '../api';
import { useAuth } from '../auth';

const ERRORS: Record<string, string> = {
  google: 'Google sign-in failed. Please try again.',
  google_state: 'Google sign-in expired. Please try again.',
  google_unverified: 'Your Google email is not verified.',
};

const GOOGLE_ICON = (
  <svg viewBox="0 0 18 18" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);

export function Login() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const errorMsg = ERRORS[params.get('error') ?? ''];
  // Already signed in → straight to the dashboard.
  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="center">
      <main className="card">
        <h1>Log in to Signal</h1>
        <p className="sub">View feedback across every part of your product.</p>
        {errorMsg && (
          <div
            style={{
              marginTop: 'var(--space-5)',
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
              color: 'var(--danger)',
              font: 'var(--text-small)',
              textAlign: 'center',
            }}
          >
            {errorMsg}
          </div>
        )}
        <a className="gbtn" href={googleLoginUrl('/app/dashboard')}>
          {GOOGLE_ICON}
          Continue with Google
        </a>
        <p className="muted">
          New here? Running <code>npx @ashish221/signal-cli init</code> signs you in and connects
          your app.
        </p>
      </main>
    </div>
  );
}
