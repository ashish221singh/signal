import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appKeyAuth } from './appKeyAuth.js';

describe('appKeyAuth plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });

    // Auth is registered inside an encapsulated scope so it protects only the
    // routes registered within that scope, not sibling top-level routes.
    await app.register(async (scope: FastifyInstance) => {
      await scope.register(appKeyAuth(['key-1', 'key-2']));
      scope.get('/protected', async () => ({ ok: true }));
    });

    // Sibling route at the top level, outside the auth scope.
    app.get('/open', async () => ({ open: true }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a request with no app key (401, unauthorized code)', async () => {
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(typeof body.error.message).toBe('string');
  });

  it('rejects a request with a wrong app key (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-signal-app-key': 'nope' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('accepts a request with a valid app key (200)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-signal-app-key': 'key-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('accepts a request with a rotated valid app key (200)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-signal-app-key': 'key-2' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('does not leak auth to sibling top-level routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/open' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ open: true });
  });
});
