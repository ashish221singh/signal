import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { AccountsService } from '../../accounts/service.js';
import {
  buildAuthUrl,
  defaultGoogleExchange,
  type GoogleExchange,
  googleEnabled,
} from '../../auth/google.js';
import { issueSession } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import type { Env } from '../../env.js';

/**
 * Google OAuth routes (F3), mounted under `/v1/console/auth` (no session guard):
 *   GET /google           → start: redirect to Google consent with a CSRF `state`.
 *   GET /google/callback  → finish: verify state, exchange code → profile,
 *                            find-or-create the user, issue a session, redirect.
 *
 * The short-lived `signal_oauth` state cookie is `sameSite=lax` (NOT strict): the
 * callback is a top-level navigation arriving from accounts.google.com, and a strict
 * cookie would not be sent on that cross-site redirect. The session cookie issued on
 * success stays `sameSite=strict` (via `issueSession`).
 */

const OAUTH_COOKIE = 'signal_oauth';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;

/** Only same-origin absolute paths are safe redirect targets (no open redirect). */
function safePath(next: string | undefined, fallback = '/dashboard'): string {
  if (!next) return fallback;
  return next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

export function googleAuthRoutes(deps: {
  db: Db;
  env: Env;
  exchange?: GoogleExchange;
}): FastifyPluginAsync {
  const accounts = new AccountsService(deps.db);
  const exchange = deps.exchange ?? defaultGoogleExchange(deps.env);

  return async (app) => {
    app.get<{ Querystring: { next?: string } }>('/google', async (request, reply) => {
      if (!googleEnabled(deps.env)) {
        return reply.code(503).send({
          error: { code: 'google_not_configured', message: 'Google login is not enabled' },
        });
      }
      const state = randomBytes(24).toString('base64url');
      const next = safePath(request.query.next);
      // Store state + intended destination in a signed, lax, short-lived cookie.
      reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, next }), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        maxAge: OAUTH_COOKIE_MAX_AGE_S,
      });
      return reply.redirect(buildAuthUrl(deps.env, state));
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/google/callback',
      async (request, reply) => {
        if (!googleEnabled(deps.env)) {
          return reply.code(503).send({
            error: { code: 'google_not_configured', message: 'Google login is not enabled' },
          });
        }

        // Recover and clear the state cookie first — every exit path clears it.
        const raw = request.cookies[OAUTH_COOKIE];
        reply.clearCookie(OAUTH_COOKIE, { path: '/' });
        const unsigned = raw ? request.unsignCookie(raw) : { valid: false as const, value: null };
        let stored: { state?: string; next?: string } = {};
        if (unsigned.valid && unsigned.value) {
          try {
            stored = JSON.parse(unsigned.value);
          } catch {
            stored = {};
          }
        }
        const next = safePath(stored.next);

        // User denied consent, or Google returned an error.
        if (request.query.error) {
          return reply.redirect('/login?error=google');
        }
        // CSRF: the returned state must match what we stored.
        if (!request.query.state || !stored.state || request.query.state !== stored.state) {
          return reply.redirect('/login?error=google_state');
        }
        if (!request.query.code) {
          return reply.redirect('/login?error=google');
        }

        let profile: Awaited<ReturnType<GoogleExchange>>;
        try {
          profile = await exchange(request.query.code);
        } catch (err) {
          request.log.warn({ err }, 'google code exchange failed');
          return reply.redirect('/login?error=google');
        }
        // Only accept verified emails — we link accounts by email.
        if (!profile.emailVerified) {
          return reply.redirect('/login?error=google_unverified');
        }

        const { user } = await accounts.findOrCreateGoogleUser({
          googleSub: profile.sub,
          email: profile.email,
          name: profile.name,
        });
        issueSession(reply, user.id);
        return reply.redirect(next);
      },
    );
  };
}
