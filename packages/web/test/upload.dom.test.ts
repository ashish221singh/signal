// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox.js';
import { createWebHost } from '../src/webHost.js';

const KEY = 'pk_test_123';
const API = 'https://api.test';

function ctx(fetchImpl: typeof fetch) {
  return {
    apiUrl: API,
    publishableKey: KEY,
    outbox: new Outbox({ apiUrl: API, publishableKey: KEY, fetchImpl }),
    userId: 'u1',
    eventName: 'evt',
    triggerId: 't-1',
    shownAt: new Date().toISOString(),
    fetchImpl,
  };
}

describe('presigned image upload via requestUpload (GR-3)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('presigns, PUTs the file, and returns the object URL', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).includes('/v1/sdk/uploads')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upload_url: `${API}/put/obj?sig=abc`,
            object_url: `${API}/public/obj.jpg`,
            key: 'acct/1/obj.jpg',
          }),
          text: async () => '',
        } as Response;
      }
      // The PUT to the presigned URL.
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const host = createWebHost(ctx(fetchImpl));
    const file = new File([new Uint8Array([1, 2, 3])], 'p.jpg', { type: 'image/jpeg' });
    const url = await host.requestUpload(file);
    expect(url).toBe(`${API}/public/obj.jpg`);
    expect(seen[0]).toBe(`POST ${API}/v1/sdk/uploads`);
    expect(seen[1]).toBe(`PUT ${API}/put/obj?sig=abc`);
  });

  it('throws when presign fails so the sheet can submit text-only', async () => {
    const fetchImpl = (async () => {
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const host = createWebHost(ctx(fetchImpl));
    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });
    await expect(host.requestUpload(file)).rejects.toThrow(/presign failed/);
  });

  it('throws when the PUT fails so the answer still submits text-only', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/uploads')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upload_url: `${API}/put/obj`,
            object_url: `${API}/public/obj.jpg`,
            key: 'k',
          }),
          text: async () => '',
        } as Response;
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const host = createWebHost(ctx(fetchImpl));
    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });
    await expect(host.requestUpload(file)).rejects.toThrow(/upload PUT failed/);
  });
});

describe('webHost submit + dismiss enqueue to the outbox', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('submit maps the Answer onto ResponseBody and enqueues it', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const host = createWebHost(ctx(fetchImpl));
    await host.submit({ trigger_id: 't-1', rating_value: 2, positive: false, other_text: 'meh' });
    await new Promise((r) => setTimeout(r, 10));
    expect(body?.trigger_id).toBe('t-1');
    expect(body?.rating_value).toBe(2);
    expect(body?.other_text).toBe('meh');
    expect(body?.device_os).toBe('web');
    expect(body?.shown_at).toBeTruthy();
  });

  it('dismiss enqueues a dismiss body with the trigger_id', async () => {
    let url = '';
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = String(u);
      body = init?.body ? JSON.parse(init.body as string) : undefined;
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const host = createWebHost(ctx(fetchImpl));
    host.dismiss('backdrop');
    await new Promise((r) => setTimeout(r, 10));
    expect(url).toContain('/v1/sdk/dismiss');
    expect(body?.trigger_id).toBe('t-1');
  });
});
