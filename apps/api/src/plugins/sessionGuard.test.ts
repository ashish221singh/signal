import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionGuard } from './sessionGuard.js';

const SECRET = 'test-session-secret-16chars-min';
const USER_ID = 'console-user-123';

describe('sessionGuard plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });

    // The guard depends on `@fastify/cookie` being registered with a secret so
    // `request.unsignCookie` can verify the signed `signal_session` cookie.
    await app.register(cookie, { secret: SECRET });

    // Guard + protected route live in an encapsulated scope so the onRequest
    // hook protects only routes registered within, not sibling top-level ones.
    await app.register(async (scope: FastifyInstance) => {
      await scope.register(sessionGuard);
      scope.get('/protected', async (request) => ({ userId: request.consoleUserId }));
    });

    // Sibling route outside the guard scope.
    app.get('/open', async () => ({ open: true }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a request with no session cookie (401, unauthorized code)', async () => {
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(typeof body.error.message).toBe('string');
  });

  it('rejects a request with a tampered/invalid signature cookie (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${USER_ID}.not-a-valid-signature` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('accepts a valid signed cookie and sets consoleUserId (200)', async () => {
    // Produce a valid signed cookie value with the app's own signing helper.
    const signed = app.signCookie(USER_ID);
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: USER_ID });
  });

  it('does not leak the guard to sibling top-level routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/open' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ open: true });
  });
});
