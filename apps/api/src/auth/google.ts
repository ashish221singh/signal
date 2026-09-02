import type { Env } from '../env.js';

/**
 * "Log in with Google" (F3) — a minimal OAuth 2.0 / OIDC authorization-code flow,
 * implemented directly (no @fastify/oauth2 dependency). The start route builds the
 * consent URL; the callback exchanges the `code` for the user's profile via
 * `exchangeCodeForProfile`. ALL network access lives in that one function, so tests
 * inject a stub (`AppDeps.googleExchange`) and never touch Google.
 */

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SCOPE = 'openid email profile';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/** Exchange an authorization `code` for the authenticated user's Google profile. */
export type GoogleExchange = (code: string) => Promise<GoogleProfile>;

/** Google login is active only when BOTH client id and secret are configured. */
export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Build the Google consent URL to redirect the user to (with our CSRF `state`). */
export function buildAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state,
    // Always let the user pick an account; online access is all we need (no refresh).
    prompt: 'select_account',
    access_type: 'online',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Real code→profile exchange: swap the authorization code for an access token at
 * Google's token endpoint, then read the OIDC userinfo. Thrown errors bubble to the
 * callback, which renders a friendly auth-failed redirect. Used in production; tests
 * substitute their own `GoogleExchange`.
 */
export function defaultGoogleExchange(env: Env): GoogleExchange {
  return async (code: string): Promise<GoogleProfile> => {
    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`google token exchange failed (${tokenRes.status})`);
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('google token response missing access_token');

    const infoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) {
      throw new Error(`google userinfo failed (${infoRes.status})`);
    }
    const info = (await infoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!info.sub || !info.email) throw new Error('google userinfo missing sub/email');

    return {
      sub: info.sub,
      email: info.email.toLowerCase(),
      emailVerified: info.email_verified === true,
      name: info.name ?? info.email,
    };
  };
}
