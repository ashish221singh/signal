import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BeatRouteClient,
  type BeatRouteConfig,
  BeatRouteError,
  withRetry,
} from './beatrouteClient.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function cfg(): BeatRouteConfig {
  return {
    tokenUrl: `${baseUrl}/oauth/token`,
    clientsUrl: `${baseUrl}/api/clients`,
    clientId: 'the-id',
    clientSecret: 'the-secret',
    scope: 'clients:read',
  };
}

beforeEach(startServer);
afterEach(stopServer);

describe('BeatRouteClient.fetchToken', () => {
  it('POSTs client_credentials form and returns access_token', async () => {
    let seenBody = '';
    let seenContentType = '';
    handler = (req, res, body) => {
      seenBody = body;
      seenContentType = req.headers['content-type'] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok-123' }));
    };

    const token = await new BeatRouteClient(cfg()).fetchToken();

    expect(token).toBe('tok-123');
    expect(seenContentType).toContain('application/x-www-form-urlencoded');
    const params = new URLSearchParams(seenBody);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('the-id');
    expect(params.get('client_secret')).toBe('the-secret');
    expect(params.get('scope')).toBe('clients:read');
  });

  it('throws BeatRouteError step=token on 401', async () => {
    handler = (_req, res) => {
      res.writeHead(401);
      res.end('nope');
    };
    await expect(new BeatRouteClient(cfg()).fetchToken()).rejects.toMatchObject({
      step: 'token',
    });
    await expect(new BeatRouteClient(cfg()).fetchToken()).rejects.toBeInstanceOf(BeatRouteError);
  });

  it('throws BeatRouteError step=token when access_token missing', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token_type: 'Bearer' }));
    };
    await expect(new BeatRouteClient(cfg()).fetchToken()).rejects.toMatchObject({
      step: 'token',
    });
  });
});

describe('BeatRouteClient.fetchClients', () => {
  it('sends Bearer auth and maps client_id/id/status', async () => {
    let seenAuth = '';
    handler = (req, res) => {
      seenAuth = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { client_id: 'src-1', name: 'One', status: 'active' },
          { id: 'src-2', name: 'Two', status: 'inactive' },
          { client_id: 'src-3', name: 'Three', status: 'suspended' },
        ]),
      );
    };

    const clients = await new BeatRouteClient(cfg()).fetchClients('tok-xyz');

    expect(seenAuth).toBe('Bearer tok-xyz');
    expect(clients).toEqual([
      { id: 'src-1', name: 'One', status: 'active' },
      { id: 'src-2', name: 'Two', status: 'inactive' },
      { id: 'src-3', name: 'Three', status: 'active' },
    ]);
  });

  it('throws BeatRouteError step=clients on 500', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };
    await expect(new BeatRouteClient(cfg()).fetchClients('tok')).rejects.toMatchObject({
      step: 'clients',
    });
    await expect(new BeatRouteClient(cfg()).fetchClients('tok')).rejects.toBeInstanceOf(
      BeatRouteError,
    );
  });

  it('throws BeatRouteError step=clients when a row has neither id nor client_id', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ name: 'No id', status: 'active' }]));
    };
    await expect(new BeatRouteClient(cfg()).fetchClients('tok')).rejects.toMatchObject({
      step: 'clients',
    });
  });
});

describe('withRetry', () => {
  it('retries then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('transient');
        return 'ok';
      },
      3,
      1,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        3,
        1,
      ),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });
});
