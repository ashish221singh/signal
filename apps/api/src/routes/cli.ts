import { cliLoginRequestSchema, deviceTokenRequestSchema } from '@signal/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { verifyPassword } from '../auth/password.js';
import { readSession } from '../auth/session.js';
import type { DeviceService } from '../cli/deviceService.js';
import { approvePage, approveResultPage, loginPage, signupPage } from '../cli/pages.js';
import type { Db } from '../db/client.js';
import { consoleUsers } from '../db/schema.js';
import type { Env } from '../env.js';
import type { TokenService } from '../tokens/service.js';

/**
 * CLI / device-flow routes (B3-D3, D4, D3b) — all PUBLIC (not behind resolveAuth),
 * except `/cli/approve` which self-checks the console session. Mounted at the app
 * root so paths are absolute (`/v1/cli/*`, `/signup`, `/login`, `/cli/approve`).
 *
 * - `POST /v1/cli/device/code` starts the grant.
 * - `GET/POST /cli/approve` is the session-guarded approval page.
 * - `POST /v1/cli/device/token` is the CLI poll.
 * - `POST /v1/cli/login` is the prod-gated interim password login (B3-D4, GR-10).
 * - `GET /signup`, `GET /login` are the server-rendered auth pages (B3-D3b, GR-2).
 */
export function cliRoutes(deps: {
  db: Db;
  env: Env;
  devices: DeviceService;
  tokens: TokenService;
}): FastifyPluginAsync {
  const { db, env, devices, tokens } = deps;

  return async (app) => {
    // ── Server-rendered auth pages (B3-D3b, GR-2) ──
    app.get('/signup', async (_req, reply) => {
      return reply.type('text/html').send(signupPage());
    });
    app.get<{ Querystring: { next?: string } }>('/login', async (request, reply) => {
      return reply.type('text/html').send(loginPage(request.query.next ?? '/'));
    });

    // ── Device flow (B3-D3) ──
    // Start: mint a (device_code, user_code) pair + the verification URI.
    app.post('/v1/cli/device/code', async (_req, reply) => {
      const grant = await devices.requestCode();
      const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
      return reply.code(201).send({
        device_code: grant.deviceCode,
        user_code: grant.userCode,
        verification_uri: `${base}/cli/approve?user_code=${encodeURIComponent(grant.userCode)}`,
        interval: grant.intervalS,
        expires_in: grant.expiresInS,
      });
    });

    // Approval page (session-guarded via a manual check — this route lives outside
    // the resolveAuth scope so unauthenticated users are redirected to /login).
    app.get<{ Querystring: { user_code?: string } }>('/cli/approve', async (request, reply) => {
      const userId = readSession(request);
      const userCode = request.query.user_code ?? '';
      if (!userId) {
        const next = `/cli/approve?user_code=${encodeURIComponent(userCode)}`;
        return reply.redirect(`/login?next=${encodeURIComponent(next)}`);
      }
      if (!userCode) {
        return reply.type('text/html').code(400).send(approveResultPage('invalid'));
      }
      const found = await devices.findPendingByUserCode(userCode);
      if (found.status === 'not_found' || found.expired) {
        return reply.type('text/html').code(404).send(approveResultPage('invalid'));
      }
      return reply.type('text/html').send(approvePage(userCode));
    });

    app.post<{ Body: { user_code?: string; decision?: string } }>(
      '/cli/approve',
      async (request, reply) => {
        const userId = readSession(request);
        if (!userId) {
          return reply.redirect('/login');
        }
        const [user] = await db
          .select({ accountId: consoleUsers.accountId })
          .from(consoleUsers)
          .where(eq(consoleUsers.id, userId))
          .limit(1);
        if (!user) return reply.redirect('/login');

        const body = request.body ?? {};
        const userCode = typeof body.user_code === 'string' ? body.user_code : '';
        const decision = body.decision;
        if (!userCode) {
          return reply.type('text/html').code(400).send(approveResultPage('invalid'));
        }
        if (decision === 'deny') {
          await devices.deny(userCode);
          return reply.type('text/html').send(approveResultPage('denied'));
        }
        const ok = await devices.approve(userCode, user.accountId);
        return reply
          .type('text/html')
          .code(ok ? 200 : 404)
          .send(approveResultPage(ok ? 'approved' : 'invalid'));
      },
    );

    // CLI poll: pending → the token once.
    app.post('/v1/cli/device/token', async (request, reply) => {
      const parsed = deviceTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'device_code required' } });
      }
      const result = await devices.token(parsed.data.device_code);
      switch (result.status) {
        case 'approved':
          return reply.send({
            token: result.token,
            scopes: result.scopes,
            expires_at: result.expiresAt,
          });
        case 'pending':
          return reply
            .code(428)
            .send({ error: { code: 'authorization_pending', message: 'not yet approved' } });
        case 'denied':
          return reply
            .code(403)
            .send({ error: { code: 'access_denied', message: 'the request was denied' } });
        case 'expired':
          return reply
            .code(410)
            .send({ error: { code: 'expired_token', message: 'the device code expired' } });
        default:
          return reply
            .code(404)
            .send({ error: { code: 'invalid_grant', message: 'unknown or spent device code' } });
      }
    });

    // ── Interim password login (B3-D4, GR-10) — rate-limited, prod-gated. ──
    app.post(
      '/v1/cli/login',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        if (!env.ALLOW_PASSWORD_CLI_LOGIN) {
          return reply.code(403).send({
            error: {
              code: 'password_login_disabled',
              message: 'password CLI login is disabled; use the device flow',
            },
          });
        }
        const parsed = cliLoginRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(422)
            .send({ error: { code: 'invalid_body', message: 'invalid login' } });
        }
        const [user] = await db
          .select()
          .from(consoleUsers)
          .where(eq(consoleUsers.email, parsed.data.email))
          .limit(1);
        const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
        if (!user || !ok) {
          return reply
            .code(401)
            .send({ error: { code: 'invalid_credentials', message: 'invalid email or password' } });
        }
        const { token, meta } = await tokens.issue(user.accountId, 'cli-password-login');
        return reply.send({ token, scopes: meta.scopes, expires_at: meta.expires_at });
      },
    );
  };
}
